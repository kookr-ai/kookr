/**
 * Grace-period warning + user-veto state for the hung-task reaper
 * (RFC docs/rfc/rfc-reap-grace-warning.md).
 *
 * The hung-task reaper terminates an in-progress task after ≥3h of total
 * silence once the watchdog reports `stale_agent`. Historically the kill was
 * immediate and silent-until-after — an operator opening a stalled task to take
 * manual control could have it reaped mid-composition. This coordinator inserts
 * a warned → veto-able phase between eligibility and the kill: the task is
 * warned (with a countdown carried in the snapshot), can be extended by an
 * explicit user veto or auto-held while a live dashboard has it selected, and is
 * only reaped once the (possibly extended) deadline passes with the task still
 * eligible.
 *
 * This is the single source of truth for warning state and for every
 * transition's reason. It is a mutable, `Map`-backed, clock-injected core class
 * in the same mold as {@link ../core/watchdog.ts} and
 * {@link ../core/snooze-suppression.ts}: "core" here means deterministic given
 * an injected clock and free of I/O to another subsystem — not side-effect-free
 * in the FP sense. It knows nothing about sessions, sockets, or the selection
 * controller; the server passes in the `present` boolean it computed and reads
 * back the resulting view for the snapshot.
 *
 * INVARIANT: exactly ONE instance per server process, constructed at the
 * composition root (`server/index.ts`) and threaded to both the watchdog tick
 * (`lifecycle-timers.ts`) and the veto handler (`lifecycle-handler.ts`). Do NOT
 * export a module-level singleton — two instances would split the state the
 * tick loop and the veto command each see.
 */

/** Default initial countdown (seconds) between warning and reap. */
export const DEFAULT_REAP_GRACE_SECONDS = 120;
/** Minimum configurable grace (seconds) — a real reaction window, not a toast. */
export const MIN_REAP_GRACE_SECONDS = 10;
/** Maximum configurable grace (seconds). */
export const MAX_REAP_GRACE_SECONDS = 600;

/** How far one explicit user veto pushes the deadline out. Hardcoded (RFC). */
export const REAP_VETO_EXTENSION_MS = 10 * 60_000;
/**
 * Cap on explicit vetoes per warning cycle. Accumulates until a recovered/gone
 * clear or a reap resets it — so a user who keeps clicking without ever
 * interacting is still reclaimed after MAX_REAP_VETOES × REAP_VETO_EXTENSION_MS
 * (Goal 3: bounded, never indefinite).
 */
export const MAX_REAP_VETOES = 3;
/**
 * Absolute ceiling (from warn time) on the bounded presence auto-hold. While a
 * live connection has the task selected, the reap deadline is pushed forward,
 * but never past `warnedAt + MAX_PRESENCE_HOLD_MS` — a selected-but-abandoned
 * task still reaps (Goal 3).
 */
export const MAX_PRESENCE_HOLD_MS = 15 * 60_000;

/** Live warning record for one task. */
export interface ReapWarning {
  taskId: string;
  /** Session id of the agent the warning was raised for (for the terminal alert). */
  agentId: string;
  /** When the warning was first raised (ms since epoch). */
  warnedAt: number;
  /** now ≥ this ⇒ eligible for the actual reap (ms since epoch). */
  deadlineAt: number;
  /** Total-silence duration captured at warn time (for the UI copy). */
  silentForMs: number;
  /** Number of explicit user vetoes applied to this warning cycle. */
  keptAliveCount: number;
  /** True when the current deadline is being held by dashboard presence. */
  heldByPresence: boolean;
}

export type ReapAdvance =
  | { action: 'warn'; warning: ReapWarning }
  | { action: 'wait'; warning: ReapWarning }
  | { action: 'reap'; warning: ReapWarning };

/**
 * Reason a warning was cleared — surfaced in audit rows and counters. A reap is
 * NOT a "clear" reason: it is accounted separately inside {@link
 * ReapWarningCoordinator.advance} via `expiredToReapTotal`, so this union covers
 * only the non-reap removals {@link ReapWarningCoordinator.clear} handles.
 */
export type ReapWarningClearedReason = 'recovered' | 'gone' | 'stale' | 'disabled';

export type ReapVetoResult =
  | { accepted: true; warning: ReapWarning }
  | { accepted: false; reason: 'no_warning' | 'cap_reached' };

/** Client-facing projection of a warning, carried on `AgentState.reapWarning`. */
export interface ReapWarningView {
  remainingMs: number;
  silentForMs: number;
  keptAliveCount: number;
  vetoCapReached: boolean;
  heldByPresence: boolean;
}

/** Operator-facing introspection row (diagnostics route). */
export interface ReapWarningStateRow {
  taskId: string;
  agentId: string;
  remainingMs: number;
  deadlineAt: number;
  warnedAt: number;
  keptAliveCount: number;
  heldByPresence: boolean;
}

/** Cumulative counters for observability (diagnostics/metrics surface). */
export interface ReapWarningMetrics {
  warningsRaisedTotal: number;
  vetoedTotal: number;
  vetoRejectedTotal: number;
  expiredToReapTotal: number;
  clearedRecoveredTotal: number;
  clearedGoneTotal: number;
  clearedStaleTotal: number;
  clearedDisabledTotal: number;
}

export class ReapWarningCoordinator {
  private readonly warnings = new Map<string, ReapWarning>();
  private readonly metrics: ReapWarningMetrics = {
    warningsRaisedTotal: 0,
    vetoedTotal: 0,
    vetoRejectedTotal: 0,
    expiredToReapTotal: 0,
    clearedRecoveredTotal: 0,
    clearedGoneTotal: 0,
    clearedStaleTotal: 0,
    clearedDisabledTotal: 0,
  };

  /**
   * Advance a task the caller has already confirmed reap-eligible AND
   * `stale_agent` (and past the provider-pause hold). Creates a warning on first
   * sight; while the (possibly presence-/veto-extended) deadline is in the
   * future returns `wait`; once it passes returns `reap` and drops the warning.
   * Never blocks — the grace delay is realized by returning `wait` across
   * successive ticks, never by sleeping.
   */
  advance(input: {
    taskId: string;
    agentId: string;
    silentForMs: number;
    now: number;
    graceMs: number;
    /** Whether a live dashboard connection currently has this task selected. */
    present: boolean;
  }): ReapAdvance {
    const existing = this.warnings.get(input.taskId);
    if (!existing) {
      const warning: ReapWarning = {
        taskId: input.taskId,
        agentId: input.agentId,
        warnedAt: input.now,
        deadlineAt: input.now + input.graceMs,
        silentForMs: input.silentForMs,
        keptAliveCount: 0,
        heldByPresence: false,
      };
      this.applyPresenceTo(warning, input.present, input.now, input.graceMs);
      this.warnings.set(input.taskId, warning);
      this.metrics.warningsRaisedTotal += 1;
      return { action: 'warn', warning };
    }

    // Keep display fields fresh; warnedAt / deadlineAt / count stay stable.
    existing.silentForMs = input.silentForMs;
    existing.agentId = input.agentId;
    this.applyPresenceTo(existing, input.present, input.now, input.graceMs);

    if (input.now >= existing.deadlineAt) {
      this.warnings.delete(input.taskId);
      this.metrics.expiredToReapTotal += 1;
      return { action: 'reap', warning: existing };
    }
    return { action: 'wait', warning: existing };
  }

  /**
   * Bounded presence auto-hold: while `present` and `now < warnedAt +
   * maxHoldMs`, keep the deadline at least `min(now + graceMs, ceiling)`. Only
   * ever pushes the deadline forward; never shrinks a longer veto deadline and
   * never reaps. No-op when no warning exists for the task.
   */
  applyPresence(
    taskId: string,
    present: boolean,
    now: number,
    graceMs: number,
    maxHoldMs: number = MAX_PRESENCE_HOLD_MS,
  ): void {
    const w = this.warnings.get(taskId);
    if (!w) return;
    this.applyPresenceTo(w, present, now, graceMs, maxHoldMs);
  }

  private applyPresenceTo(
    w: ReapWarning,
    present: boolean,
    now: number,
    graceMs: number,
    maxHoldMs: number = MAX_PRESENCE_HOLD_MS,
  ): void {
    const ceiling = w.warnedAt + maxHoldMs;
    if (present && now < ceiling) {
      const target = Math.min(now + graceMs, ceiling);
      if (target > w.deadlineAt) w.deadlineAt = target;
      w.heldByPresence = true;
    } else {
      w.heldByPresence = false;
    }
  }

  /**
   * Apply an explicit user veto. Extends the deadline by `extensionMs`, capped
   * at {@link MAX_REAP_VETOES} extensions per cycle. Returns `no_warning` when
   * there is nothing to veto (validation) or `cap_reached` when the cap is hit
   * (the warning is left in place to reap at its current deadline).
   */
  veto(taskId: string, now: number, extensionMs: number = REAP_VETO_EXTENSION_MS): ReapVetoResult {
    const w = this.warnings.get(taskId);
    if (!w) {
      this.metrics.vetoRejectedTotal += 1;
      return { accepted: false, reason: 'no_warning' };
    }
    if (w.keptAliveCount >= MAX_REAP_VETOES) {
      this.metrics.vetoRejectedTotal += 1;
      return { accepted: false, reason: 'cap_reached' };
    }
    w.keptAliveCount += 1;
    w.deadlineAt = now + extensionMs;
    w.heldByPresence = false;
    this.metrics.vetoedTotal += 1;
    return { accepted: true, warning: w };
  }

  /**
   * Drop a warning, tagging the reason for the counters. Returns the removed
   * warning (or undefined if none). Reaps are accounted inside {@link advance}
   * (`expiredToReapTotal`), so {@link ReapWarningClearedReason} deliberately
   * excludes them and this only handles the non-reap removals.
   */
  clear(taskId: string, reason?: ReapWarningClearedReason): ReapWarning | undefined {
    const w = this.warnings.get(taskId);
    if (!w) return undefined;
    this.warnings.delete(taskId);
    switch (reason) {
      case 'recovered': this.metrics.clearedRecoveredTotal += 1; break;
      case 'gone': this.metrics.clearedGoneTotal += 1; break;
      case 'stale': this.metrics.clearedStaleTotal += 1; break;
      case 'disabled': this.metrics.clearedDisabledTotal += 1; break;
      default: break;
    }
    return w;
  }

  /** Drop every warning (used when the warned phase is disabled at runtime). */
  clearAll(): string[] {
    const ids = [...this.warnings.keys()];
    this.metrics.clearedDisabledTotal += ids.length;
    this.warnings.clear();
    return ids;
  }

  /** Cumulative counters for the diagnostics/metrics surface. */
  getMetrics(): ReapWarningMetrics {
    return { ...this.metrics };
  }

  getWarning(taskId: string): ReapWarning | undefined {
    return this.warnings.get(taskId);
  }

  warnedTaskIds(): string[] {
    return [...this.warnings.keys()];
  }

  activeWarningCount(): number {
    return this.warnings.size;
  }

  /** Client projection for the snapshot; `undefined` when no warning exists. */
  view(taskId: string, now: number): ReapWarningView | undefined {
    const w = this.warnings.get(taskId);
    if (!w) return undefined;
    return {
      remainingMs: Math.max(0, w.deadlineAt - now),
      silentForMs: w.silentForMs,
      keptAliveCount: w.keptAliveCount,
      vetoCapReached: w.keptAliveCount >= MAX_REAP_VETOES,
      heldByPresence: w.heldByPresence,
    };
  }

  /** Operator-facing introspection of all live warnings. */
  snapshotState(now: number): ReapWarningStateRow[] {
    return [...this.warnings.values()].map((w) => ({
      taskId: w.taskId,
      agentId: w.agentId,
      remainingMs: Math.max(0, w.deadlineAt - now),
      deadlineAt: w.deadlineAt,
      warnedAt: w.warnedAt,
      keptAliveCount: w.keptAliveCount,
      heldByPresence: w.heldByPresence,
    }));
  }
}

/** Clamp a raw grace-seconds setting into the accepted range. */
export function clampReapGraceSeconds(raw: number): number {
  return Math.max(MIN_REAP_GRACE_SECONDS, Math.min(MAX_REAP_GRACE_SECONDS, Math.round(raw)));
}
