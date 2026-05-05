import { computeContextFillFromTranscript } from './token-tracker.js';
import type { TaskStore } from './tasks.js';

/**
 * Per-session state machine for the proactive checkpoint cycle.
 *
 * The cycle is a three-step sequence Kookr drives via the existing
 * terminal-input infrastructure:
 *
 *   1. PROMPTING — Kookr has injected a user message asking the agent to
 *      update CHECKPOINT.md. Waiting for the agent to finish the turn.
 *   2. COMPACTING — agent finished the previous turn. Kookr has injected
 *      `/compact`. Waiting for compaction to complete.
 *   3. (back to IDLE)
 *
 * The state machine is intentionally minimal — Kookr does not parse the
 * agent's response to the checkpoint prompt; it just sequences the inputs
 * and uses Stop hook events as the "agent finished a turn" signal. This
 * matches the empirical findings in
 * `docs/poc/005-checkpoint-cycle-mechanics.md`.
 */
export type CyclePhase = 'idle' | 'prompting' | 'compacting';

export interface CycleState {
  phase: CyclePhase;
  /** Timestamp (ms) when the current phase started. Used for timeouts. */
  phaseStartedAt: number;
  /** Timestamp (ms) when this session last completed a cycle. Used for cooldown. */
  lastCycleEndedAt: number;
  /**
   * Consecutive no-progress cycles. A no-progress cycle is one where the
   * `/compact` injection timed out (compactTimeoutMs) without the context
   * ratio dropping below the ratio sampled when the cycle started — i.e.
   * the user cancelled `/compact` (Claude Code does not emit a Stop hook
   * on slash-command cancel, so the only signal is the post-timeout ratio).
   * Reset to 0 whenever a cycle completes successfully. Capped by
   * `maxCancelledAttempts`; hitting the cap flips `gaveUp` true for the
   * rest of the session. See issue #412.
   */
  cancelledAttempts: number;
  /**
   * Context fill ratio (0..1) sampled at the moment the cycle entered the
   * prompting phase. Used at `compactTimeoutMs` expiry to decide whether
   * the cycle made progress. 0 while idle.
   */
  cycleStartRatio: number;
  /**
   * Set to true once this session has reached `maxCancelledAttempts`
   * consecutive no-progress cycles. Prevents further `/compact` injections
   * for this session (session-scoped, not global — cleared when the
   * session is forgotten).
   */
  gaveUp: boolean;
}

export interface CheckpointCyclerConfig {
  /**
   * Trigger the cycle when the per-turn context fill reaches this fraction
   * of the model's context window. Default: 0.75 (75%). Override via the
   * env var `KOOKR_CHECKPOINT_TRIGGER_RATIO`.
   */
  triggerRatio: number;
  /**
   * Minimum time between cycles for a single session. Prevents a
   * runaway loop when /compact does not drop the ratio below the trigger.
   * Default: 5 minutes.
   */
  cooldownMs: number;
  /**
   * Maximum time to wait for the agent to finish the checkpoint-write turn
   * before timing out and resetting the cycle. Default: 5 minutes.
   */
  promptTimeoutMs: number;
  /**
   * Maximum time to wait for compaction to finish (a Stop event after the
   * /compact send). Default: 2 minutes.
   */
  compactTimeoutMs: number;
  /**
   * Minimum time the cycler must remain in the `prompting` phase before
   * a Stop event is interpreted as the agent's response. Stops arriving
   * earlier than this are leftover from prior turns (the agent had a
   * pending response when the cycler injected its prompt) and must not
   * be allowed to advance the state machine — that would send `/compact`
   * before the agent has actually written CHECKPOINT.md. Default: 1500 ms,
   * which is comfortably below the typical multi-second agent turn.
   */
  promptGraceMs: number;
  /**
   * After this many consecutive no-progress cycles (user kept cancelling
   * `/compact`), the cycler stops injecting `/compact` for the rest of
   * the session. Default: 3. Override via
   * `KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS`. See issue #412.
   */
  maxCancelledAttempts: number;
}

const DEFAULT_CONFIG: CheckpointCyclerConfig = {
  triggerRatio: 0.75,
  cooldownMs: 5 * 60 * 1000,
  promptTimeoutMs: 5 * 60 * 1000,
  compactTimeoutMs: 2 * 60 * 1000,
  promptGraceMs: 1500,
  maxCancelledAttempts: 3,
};

const PROMPT_MESSAGE = (ratioPercent: number): string =>
  `Context window is at ${ratioPercent}% of the model limit. Before I run /compact, please update $KOOKR_CHECKPOINT_DIR/CHECKPOINT.md with the current verdict, evidence, and next actions. After your reply I will run /compact for you, then a fresh turn will read CHECKPOINT.md back automatically.`;

const COMPACT_INPUT = '/compact';

/**
 * Action for the cycler to take after a tick. Returned by `tick()` so the
 * caller (the lifecycle timer) can perform the side effect — keeps this
 * module pure and testable.
 */
export type CycleAction =
  | { kind: 'noop' }
  | { kind: 'send_user_message'; tmuxName: string; text: string }
  | { kind: 'send_input'; tmuxName: string; text: string };

export interface SessionContext {
  /** Tmux session name (used as the per-session key). */
  tmuxName: string;
  /** Path to the Claude Code transcript JSONL for this session. */
  transcriptPath: string;
}

/**
 * The cycler is a pure state machine: callers feed it ticks (with the current
 * session list) and Stop events, and it returns actions to perform. No I/O
 * happens inside this class — testing is straightforward.
 */
export class CheckpointCycler {
  private states = new Map<string, CycleState>();
  private config: CheckpointCyclerConfig;

  constructor(config: Partial<CheckpointCyclerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Process one tick. For each session, check if we should advance the cycle
   * and return any user-facing input to send.
   */
  async tick(
    sessions: SessionContext[],
    now: number = Date.now(),
  ): Promise<CycleAction[]> {
    const actions: CycleAction[] = [];

    // Passive cleanup: forget per-session state for sessions that are no
    // longer in the active list. This handles session lifecycle without
    // the cycler having to be threaded through every cleanup callsite —
    // a sibling defense-in-depth to the explicit `forget()` call from
    // `cleanupSessionResources`.
    const activeSet = new Set(sessions.map((s) => s.tmuxName));
    for (const tmuxName of this.states.keys()) {
      if (!activeSet.has(tmuxName)) {
        this.states.delete(tmuxName);
      }
    }

    for (const session of sessions) {
      const state = this.getOrInit(session.tmuxName);

      if (state.phase === 'prompting' && now - state.phaseStartedAt > this.config.promptTimeoutMs) {
        // Agent never finished the checkpoint-write turn — abort, reset cooldown.
        // Not counted as a no-progress /compact cycle because /compact never even ran.
        this.reset(session.tmuxName, now);
        continue;
      }
      if (state.phase === 'compacting' && now - state.phaseStartedAt > this.config.compactTimeoutMs) {
        // Compaction timed out. The most common cause (issue #412) is that
        // the user cancelled /compact — Claude Code does not emit a Stop
        // hook for slash-command cancellation, so this timeout is the only
        // signal we have. Sample the current ratio and compare to the ratio
        // we sampled when the cycle started: a strict drop means /compact
        // actually ran; otherwise it's a no-progress cycle.
        //
        // The read yields to the event loop, so a real `/compact` completion
        // could fire its Stop event (and `onStop` → reset) while we're
        // awaiting. Capture `cycleStartRatio` before the await and re-check
        // `phase === 'compacting'` afterwards — if `onStop` already concluded
        // the cycle as successful, skip the no-progress accounting entirely.
        const cycleStartRatio = state.cycleStartRatio;
        const after = await computeContextFillFromTranscript(session.transcriptPath);
        if (state.phase !== 'compacting') {
          // onStop (or forget / passive cleanup) moved the state machine
          // while we were reading — its accounting wins.
          continue;
        }
        const madeProgress = !!after && after.ratio < cycleStartRatio;
        if (madeProgress) {
          state.cancelledAttempts = 0;
          this.reset(session.tmuxName, now);
        } else {
          state.cancelledAttempts += 1;
          if (state.cancelledAttempts >= this.config.maxCancelledAttempts) {
            state.gaveUp = true;
            console.warn(
              `[checkpoint-cycler] session ${session.tmuxName} gave up /compact `
              + `after ${state.cancelledAttempts} consecutive no-progress cycles — `
              + `will not inject /compact again for this session.`,
            );
            this.reset(session.tmuxName, Number.MAX_SAFE_INTEGER);
          } else {
            this.reset(session.tmuxName, now);
          }
        }
        continue;
      }

      if (state.phase !== 'idle') continue;

      // Session gave up after too many cancelled /compact attempts — never refire.
      if (state.gaveUp) continue;

      // Cooldown gate — only applies if at least one cycle has already run.
      // (lastCycleEndedAt === 0 means "never cycled", and the difference would
      // be artificially blocked by `now - 0 < cooldownMs`.)
      if (state.lastCycleEndedAt > 0 && now - state.lastCycleEndedAt < this.config.cooldownMs) {
        continue;
      }

      // Read context fill — fail-safe (under threshold) if read fails
      const sample = await computeContextFillFromTranscript(session.transcriptPath);
      if (!sample) continue;
      if (sample.ratio < this.config.triggerRatio) continue;

      // Fire phase 1 — prompt the agent to update CHECKPOINT.md.
      // Remember the starting ratio so the compact-timeout branch can tell
      // a successful cycle (ratio dropped) from a no-progress one.
      state.phase = 'prompting';
      state.phaseStartedAt = now;
      state.cycleStartRatio = sample.ratio;
      const ratioPercent = Math.round(sample.ratio * 100);
      actions.push({
        kind: 'send_user_message',
        tmuxName: session.tmuxName,
        text: PROMPT_MESSAGE(ratioPercent),
      });
    }

    return actions;
  }

  /**
   * Notify the cycler that an agent has finished a turn (Stop hook fired).
   * Returns an action if the cycler wants to advance the cycle in response.
   *
   * Stops arriving within `promptGraceMs` of entering the prompting phase
   * are treated as leftover from a prior turn (the agent had a response in
   * flight when the cycler injected its prompt) and ignored. Without this
   * guard the cycler would send `/compact` before the agent has actually
   * written CHECKPOINT.md.
   */
  onStop(tmuxName: string, now: number = Date.now()): CycleAction {
    const state = this.states.get(tmuxName);
    if (!state) return { kind: 'noop' };

    if (state.phase === 'prompting') {
      if (now - state.phaseStartedAt < this.config.promptGraceMs) {
        // Stale Stop from a prior turn — ignore. The next Stop (the actual
        // checkpoint-write response) will fall through the grace window.
        return { kind: 'noop' };
      }
      // Agent finished the checkpoint-write turn. Send /compact next.
      state.phase = 'compacting';
      state.phaseStartedAt = now;
      return { kind: 'send_input', tmuxName, text: COMPACT_INPUT };
    }

    if (state.phase === 'compacting') {
      // Stop during compacting means /compact actually completed — Claude
      // Code does NOT emit a Stop hook when the user cancels a slash
      // command (see issue #412). Treat this as a successful cycle and
      // reset the consecutive-no-progress counter.
      state.cancelledAttempts = 0;
      this.reset(tmuxName, now);
      return { kind: 'noop' };
    }

    return { kind: 'noop' };
  }

  /** Forget per-session state (e.g., on session deletion or task delete). */
  forget(tmuxName: string): void {
    this.states.delete(tmuxName);
  }

  /** Test-only: inspect a session's current state. */
  getState(tmuxName: string): CycleState | undefined {
    return this.states.get(tmuxName);
  }

  private getOrInit(tmuxName: string): CycleState {
    let state = this.states.get(tmuxName);
    if (!state) {
      state = {
        phase: 'idle',
        phaseStartedAt: 0,
        lastCycleEndedAt: 0,
        cancelledAttempts: 0,
        cycleStartRatio: 0,
        gaveUp: false,
      };
      this.states.set(tmuxName, state);
    }
    return state;
  }

  /**
   * Return the state machine to idle. Preserves `cancelledAttempts` and
   * `gaveUp` across resets — those are cycle-spanning signals that must
   * not be cleared just because the phase cycles back to idle.
   */
  private reset(tmuxName: string, now: number): void {
    const state = this.getOrInit(tmuxName);
    state.phase = 'idle';
    state.phaseStartedAt = 0;
    state.lastCycleEndedAt = now;
    state.cycleStartRatio = 0;
  }
}

/**
 * Read the trigger ratio from environment with safe fallback to the default.
 * Exposed so the wiring layer (lifecycle-timers.ts) can construct the cycler
 * with the right config.
 */
export function readTriggerRatioFromEnv(): number {
  const raw = process.env.KOOKR_CHECKPOINT_TRIGGER_RATIO;
  if (!raw) return DEFAULT_CONFIG.triggerRatio;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return DEFAULT_CONFIG.triggerRatio;
  }
  return parsed;
}

/**
 * Read the max consecutive no-progress cycles from the environment with
 * a safe fallback to the default. Invalid values (non-numeric, <= 0) fall
 * back. Exposed so the wiring layer can construct the cycler with the
 * right config. See issue #412.
 */
export function readMaxCancelledAttemptsFromEnv(): number {
  const raw = process.env.KOOKR_CHECKPOINT_MAX_CANCELLED_ATTEMPTS;
  if (!raw) return DEFAULT_CONFIG.maxCancelledAttempts;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CONFIG.maxCancelledAttempts;
  }
  return parsed;
}

/**
 * Cycling can be globally disabled with KOOKR_CHECKPOINT_CYCLE_DISABLED=1.
 * Storage is unaffected; only the proactive cycle is gated.
 */
export function isCycleDisabled(): boolean {
  const v = process.env.KOOKR_CHECKPOINT_CYCLE_DISABLED;
  return v === '1' || v === 'true';
}

/**
 * Pull every active session's transcript path off the task store. Used by
 * the lifecycle timer to pass the right snapshot to `tick()` each round.
 */
export function getCyclableSessions(taskStore: TaskStore): SessionContext[] {
  const out: SessionContext[] = [];
  for (const task of taskStore.getAllTasks()) {
    for (const session of task.sessions) {
      if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
      if (!session.transcriptPath) continue;
      out.push({ tmuxName: session.tmuxSession, transcriptPath: session.transcriptPath });
    }
  }
  return out;
}
