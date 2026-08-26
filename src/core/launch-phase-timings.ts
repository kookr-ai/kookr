/**
 * Per-phase launch instrumentation (issue #1589).
 *
 * A task launch moves through a fixed sequence of phases. Historically a failed
 * launch recorded only the terminal error ("Agent launch timed out after 180s")
 * — nothing said WHICH phase consumed the time, so the 180s `launch_error`
 * class (and the grok-build `POST /api/tasks` >90s hang) could not be diagnosed
 * from ledger data alone.
 *
 * {@link LaunchPhaseTracker} records the wall-clock spent in each phase and,
 * crucially, which phase was still in-flight when a launch was abandoned
 * (timeout or throw). The resulting {@link LaunchPhaseTimings} is persisted on
 * the task ({@link Task.launchPhaseTimings}, visible via the tasks API) and
 * attached to `dispatch_failed` schedule-ledger rows, so a failed fire is
 * diagnosable without server logs.
 *
 * The canonical phases the issue names are `reserve → session-create →
 * agent-boot → ack`. `preflight` is recorded additionally because the reported
 * symptom (`POST /api/tasks` held >90s) covers the launch-service work that runs
 * BEFORE the reservation (cwd validation, advisory dependency preflight,
 * worktree guardrails, dedup, backpressure, task creation) — omitting it would
 * hide a whole class of hangs.
 *
 * launch-service owns the `preflight`/`reserve` transitions; the adapter reports
 * `session-create`/`agent-boot`/`ack` through the {@link AdapterLaunchOptions.onPhase}
 * callback, since those boundaries live inside `adapter.launch()`.
 */

/** The launch phases, in canonical order. */
export const LAUNCH_PHASES = [
  /** launch-service work before the reservation: cwd check, advisory preflight, guardrails, dedup, backpressure, createTask. */
  'preflight',
  /** The synchronous token-owned launch reservation (issue #700 CAS). */
  'reserve',
  /** Adapter: launch-context build, settings/home composition, and terminal `createSession`. */
  'session-create',
  /** Adapter: post-createSession readiness wait and initial-prompt delivery. */
  'agent-boot',
  /** Adapter: initial-prompt submit acknowledged; session registered. */
  'ack',
] as const;

export type LaunchPhase = (typeof LAUNCH_PHASES)[number];

/** Wall-clock spent in a single launch phase. */
export interface LaunchPhaseTiming {
  phase: LaunchPhase;
  /** Milliseconds spent in this phase (rounded to the nearest ms). */
  durationMs: number;
  /**
   * True when the phase handed off to the next phase (or the launch succeeded)
   * normally; false when the launch was abandoned WHILE in this phase — i.e.
   * this is the phase that consumed the time / hung.
   */
  completed: boolean;
}

/** Ordered phase timings for one launch attempt. */
export interface LaunchPhaseTimings {
  phases: LaunchPhaseTiming[];
  /** Total wall-clock from tracker start to finalization (rounded ms). */
  totalMs: number;
  /**
   * The phase that was still in-flight when the launch was abandoned, if any.
   * Present only on a launch that timed out or threw before finishing — this is
   * the field that answers "which phase consumed the 180s?". Absent on a launch
   * that completed the `ack` phase normally.
   */
  incompletePhase?: LaunchPhase;
}

/**
 * Records phase transitions for one launch attempt. Never throws from
 * {@link enter} — the phase-reporting callback runs inside adapter launch code
 * and instrumentation must never be able to fail a launch.
 */
export class LaunchPhaseTracker {
  private readonly now: () => number;
  private readonly startedAtMs: number;
  private readonly finalized: LaunchPhaseTiming[] = [];
  private open?: { phase: LaunchPhase; startMs: number };
  private incompletePhase?: LaunchPhase;
  private done = false;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAtMs = now();
  }

  /**
   * Close the currently-open phase (as completed) and open `phase`. Idempotent
   * against a repeated same-phase enter (a second `enter('session-create')`
   * closes and reopens it, which is harmless). No-op once finalized.
   */
  enter(phase: LaunchPhase): void {
    if (this.done) return;
    const t = this.now();
    this.closeOpen(t, true);
    this.open = { phase, startMs: t };
  }

  /** Finalize after a successful launch: the open phase completed normally. */
  complete(): void {
    if (this.done) return;
    this.closeOpen(this.now(), true);
    this.done = true;
  }

  /**
   * Finalize after an abandoned launch (timeout or throw): the open phase did
   * NOT complete, so it is flagged as {@link LaunchPhaseTimings.incompletePhase}
   * — the phase that consumed the time.
   */
  abort(): void {
    if (this.done) return;
    const open = this.open?.phase;
    this.closeOpen(this.now(), false);
    this.incompletePhase = open;
    this.done = true;
  }

  /** Snapshot the recorded timings. Safe to call before or after finalization. */
  snapshot(): LaunchPhaseTimings {
    const phases = [...this.finalized];
    // If snapshot() is called on a still-open, non-finalized tracker, reflect
    // the open phase as in-flight rather than dropping it.
    let incompletePhase = this.incompletePhase;
    if (!this.done && this.open) {
      const t = this.now();
      phases.push({ phase: this.open.phase, durationMs: round(t - this.open.startMs), completed: false });
      incompletePhase = this.open.phase;
    }
    return {
      phases,
      totalMs: round(this.now() - this.startedAtMs),
      ...(incompletePhase ? { incompletePhase } : {}),
    };
  }

  private closeOpen(atMs: number, completed: boolean): void {
    if (!this.open) return;
    this.finalized.push({
      phase: this.open.phase,
      durationMs: round(atMs - this.open.startMs),
      completed,
    });
    this.open = undefined;
  }
}

function round(ms: number): number {
  return Math.max(0, Math.round(ms));
}
