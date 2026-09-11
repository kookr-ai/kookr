import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import {
  selectExpiredFinishedAwaitingAckTasks,
  taskHasLiveTurn,
} from '../core/finished-awaiting-ack-ttl.js';
import { paneHasHumanInteractiveMarkers } from './finished-awaiting-ack-ttl-sweep.js';
import {
  DEFAULT_FAA_ACK_REAP_DEADLINE_MS,
  DEFAULT_FAA_ACK_REAP_GRACE_SECONDS,
  isFinishedAwaitingAckCloseCandidate,
} from '../core/finished-awaiting-ack-reaper.js';
import type { ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';

/**
 * finishedAwaitingAck (FAA) ack-path reaper — server tick wiring (issue #2170).
 *
 * Bounds the `awaiting_poll` FAA dwell on the ack/close side: a finished task
 * whose `completion_ready` signal has sat unacknowledged past a short hard
 * deadline is force-completed to free its slot — but only after a
 * grace-period + operator-veto phase (parity with the hung-task reaper #2163),
 * so the close is observable and vetoable, never a silent surprise.
 *
 * This is deliberately the FAST front-runner to the strict finishedAwaitingAck
 * TTL reclaim (#1884, 15m): the same open-PR fail-safe and Lucy #2238-style
 * TOCTOU (re-GET + live-turn / interactive-pane veto) apply, so it never
 * strands a `merge_required` PR and never closes a task an operator just took
 * over. What it adds over the strict path is (a) a tighter deadline that
 * actually bounds the `awaiting_poll` population, and (b) the warn → veto rail
 * so an operator reviewing a just-finished task can hold or extend the close.
 *
 * Reuses `completeTask` — no new terminal transition. Grace/veto state lives in
 * a dedicated {@link ReapWarningCoordinator} instance (its own single-instance
 * per process), separate from the hung-task reaper's coordinator so the two
 * populations never share a warning.
 */

/**
 * Self-heal window: a warning still past its deadline this long after the
 * deadline (with no reap having consumed it — e.g. the task wedged in a state
 * that keeps failing the TOCTOU re-GET) is cleared so a countdown banner can
 * never freeze at 0:00. Mirrors the hung reaper's `REAP_WARNING_STUCK_CLEAR_MS`.
 */
export const FAA_REAP_WARNING_STUCK_CLEAR_MS = 60_000;

/**
 * Re-warn suppression window (issue #3156). When `completeTask` throws during a
 * force-complete, the coordinator has already consumed the grace warning
 * (`advance()` drops it on the `reap` verdict), so the still-FAA task re-enters
 * the warn state on the very next selection pass. A task that persistently
 * cannot be force-completed would therefore re-warn every grace cycle — a
 * warn-storm of `ReapWarned` audit rows that buries the real signal while its
 * slot is never freed.
 *
 * While a task's most recent force-complete failure is within this window its
 * re-warn is suppressed: no `ReapWarned` row, no `warnedTotal` bump. The
 * coordinator's countdown is left in place, so the bounded reap retry still
 * runs on schedule and `reapFailedTotal` keeps climbing to surface the stuck
 * slot to an operator. The window is scoped per task and refreshed on each
 * failure, so a genuinely newly-stuck (different) task is never masked, and a
 * task that later recovers can warn cleanly once the window lapses.
 */
export const FAA_REAP_FAILURE_REWARN_SUPPRESS_MS = 5 * 60_000;

/** In-memory counters surfaced via `GET /api/diagnostics/reap-warnings` (issue #2170). */
export interface FinishedAwaitingAckAckReaperMetricsSnapshot {
  /** Cumulative FAA tasks warned (grace countdown started) since process start. */
  warnedTotal: number;
  /** Cumulative FAA tasks force-completed by the ack-path reaper. */
  reapedTotal: number;
  /**
   * Cumulative force-complete attempts (the grace-warning coordinator returned
   * `reap` and `completeTask` was invoked). `attemptedTotal - reapedTotal ===
   * reapFailedTotal`, mirroring the strict-TTL sibling sweep's
   * reclaimAttempted-vs-succeeded signal. Recorded together with `reapedTotal`
   * and `reapFailedTotal` at the end of each pass, so the invariant never reads
   * a partial pass (issue #3156).
   */
  attemptedTotal: number;
  /**
   * Cumulative force-complete attempts that threw (`completeTask` rejected).
   * Some are a benign race — the task was acked / terminated concurrently, so
   * its slot frees itself — but a *sustained* climb, with the task still
   * finishedAwaitingAck and its re-warn suppressed, is the offline signal of a
   * permanently-stuck slot the ack path previously dropped silently (issue #3156).
   */
  reapFailedTotal: number;
  /** Cumulative reap attempts deferred by TOCTOU (live turn / interactive pane / PR hold landed mid-sweep). */
  deferredTotal: number;
  /** FAA candidates considered on the last selection pass (denominator). */
  lastCandidatesConsidered: number;
  /** FAA candidates past the deadline + clear of the open-PR fail-safe on the last pass. */
  lastExpiredSelected: number;
}

/** Process-lifetime counters for the FAA ack-path reaper (issue #2170). */
export class FinishedAwaitingAckAckReaperMetrics {
  private warnedTotal = 0;
  private reapedTotal = 0;
  private attemptedTotal = 0;
  private reapFailedTotal = 0;
  private deferredTotal = 0;
  private lastCandidatesConsidered = 0;
  private lastExpiredSelected = 0;
  /**
   * Per-task epoch-ms of the most recent force-complete failure, backing the
   * re-warn suppression window (issue #3156). {@link armRewarnSuppression}
   * sweeps entries older than the window every time it records a new failure,
   * and {@link isRewarnSuppressed} prunes a lapsed entry on read, so the map
   * stays bounded by the failures within one suppression window rather than
   * growing for the process lifetime.
   */
  private readonly reapFailedAtMs = new Map<string, number>();

  recordWarned(count = 1): void {
    if (count > 0) this.warnedTotal += count;
  }

  recordReaped(count = 1): void {
    if (count > 0) this.reapedTotal += count;
  }

  recordAttempted(count = 1): void {
    if (count > 0) this.attemptedTotal += count;
  }

  recordReapFailure(count = 1): void {
    if (count > 0) this.reapFailedTotal += count;
  }

  recordDeferred(count = 1): void {
    if (count > 0) this.deferredTotal += count;
  }

  /**
   * Arm `taskId`'s re-warn suppression window at `nowMs` (called when a
   * force-complete throws). Opportunistically evicts entries already older than
   * `windowMs` first, so a task that failed then left the FAA population — and
   * is thus never re-read by {@link isRewarnSuppressed} — cannot linger for the
   * process lifetime. This is pure suppression state, kept separate from the
   * `reapFailedTotal` counter so the counter can be recorded per-pass with the
   * other totals (issue #3156).
   */
  armRewarnSuppression(
    taskId: string,
    nowMs: number,
    windowMs: number = FAA_REAP_FAILURE_REWARN_SUPPRESS_MS,
  ): void {
    for (const [id, failedAt] of this.reapFailedAtMs) {
      if (nowMs - failedAt > windowMs) this.reapFailedAtMs.delete(id);
    }
    this.reapFailedAtMs.set(taskId, nowMs);
  }

  /**
   * True when `taskId`'s most recent force-complete failure is still within
   * `windowMs` of `nowMs` — its re-warn should be suppressed. Prunes the entry
   * once the window lapses so a task that later recovers can warn cleanly again.
   */
  isRewarnSuppressed(taskId: string, nowMs: number, windowMs: number): boolean {
    const failedAt = this.reapFailedAtMs.get(taskId);
    if (failedAt === undefined) return false;
    if (nowMs - failedAt <= windowMs) return true;
    this.reapFailedAtMs.delete(taskId);
    return false;
  }

  recordSelection(candidatesConsidered: number, expiredSelected: number): void {
    this.lastCandidatesConsidered = candidatesConsidered;
    this.lastExpiredSelected = expiredSelected;
  }

  getSnapshot(): FinishedAwaitingAckAckReaperMetricsSnapshot {
    return {
      warnedTotal: this.warnedTotal,
      reapedTotal: this.reapedTotal,
      attemptedTotal: this.attemptedTotal,
      reapFailedTotal: this.reapFailedTotal,
      deferredTotal: this.deferredTotal,
      lastCandidatesConsidered: this.lastCandidatesConsidered,
      lastExpiredSelected: this.lastExpiredSelected,
    };
  }
}

/**
 * The session identifier used for the warning's `agentId` (informational: it
 * associates the warning + audit rows with a session, and lets the diagnostics
 * route show which agent's slot is being reclaimed). Prefers a live session's
 * `tmuxSession`; falls back to the first session, then the task id.
 */
function faaWarningAgentId(task: Task): string {
  const live = task.sessions.find(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted',
  );
  return live?.tmuxSession ?? task.sessions[0]?.tmuxSession ?? task.id;
}

export interface ReapAwaitingPollFinishedAwaitingAckDeps {
  taskStore: TaskStore;
  /** Grace/veto state machine for the FAA close path (dedicated instance). */
  coordinator: ReapWarningCoordinator;
  /** Lifecycle context for the force-complete. Absent ⇒ no-op. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log. */
  auditLogPath?: string;
  /** Optional broadcast for the reap-summary alert. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1884 contract).
   * Only a definite `false` clears a task for reap; `true`/`undefined` exempt.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /** Live pane/tail reader for the TOCTOU interactive-pane veto (may be async). */
  getTaskPaneText?: (
    taskId: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /** Whether a live dashboard connection currently has this task selected. */
  isTaskSelectedByAnyConnection?: (taskId: string) => boolean;
  /** Kill switch: false reverts to the strict TTL reclaim backstop alone. */
  getEnabled?: () => boolean;
  /** Live hard deadline (ms) past which an unacknowledged FAA task is reaped. */
  getDeadlineMs?: () => number;
  /** Live grace window (ms) between the warning and the close. */
  getGraceMs?: () => number;
  metrics?: FinishedAwaitingAckAckReaperMetrics;
}

export interface ReapAwaitingPollFinishedAwaitingAckResult {
  /** Tasks force-completed by the ack-path reaper this sweep. */
  reapedTaskIds: string[];
  /** Tasks newly warned (grace countdown started) this sweep. */
  warnedTaskIds: string[];
  /** Reap-eligible tasks deferred by TOCTOU this sweep. */
  deferredTaskIds: string[];
}

/**
 * One ack-path reaper pass over the FAA population, gated by the grace + veto
 * coordinator. Runs on the liveness tick BEFORE the strict TTL reclaim so it
 * front-runs it for the `awaiting_poll` dwell. Pairs with
 * {@link runFinishedAwaitingAckReapMaintenance}, which clears warnings the
 * moment a task is acked / recovered.
 *
 * Per candidate (evaluation order, mirroring the strict sweep's fail-safes):
 *  - select only tasks past the deadline and clear of the open-PR fail-safe;
 *  - re-GET fresh: still an FAA candidate, no live turn, no interactive pane,
 *    and PR hold has not landed mid-sweep — otherwise defer (never consume the
 *    grace warning on a deferral);
 *  - advance the grace machine: `warn` starts/echoes the countdown, `wait`
 *    holds, `reap` (deadline elapsed) force-completes.
 */
export async function reapAwaitingPollFinishedAwaitingAckTasks(
  deps: ReapAwaitingPollFinishedAwaitingAckDeps,
  opts: { now?: Date } = {},
): Promise<ReapAwaitingPollFinishedAwaitingAckResult> {
  const empty: ReapAwaitingPollFinishedAwaitingAckResult = {
    reapedTaskIds: [],
    warnedTaskIds: [],
    deferredTaskIds: [],
  };
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return empty;
  if (!(deps.getEnabled?.() ?? true)) return empty;

  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const deadlineMs = deps.getDeadlineMs?.() ?? DEFAULT_FAA_ACK_REAP_DEADLINE_MS;
  const graceMs = deps.getGraceMs?.() ?? DEFAULT_FAA_ACK_REAP_GRACE_SECONDS * 1000;

  const selection = selectExpiredFinishedAwaitingAckTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: deadlineMs,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });
  deps.metrics?.recordSelection(selection.candidatesConsidered, selection.expired.length);

  const reapedTaskIds: string[] = [];
  const warnedTaskIds: string[] = [];
  const deferredTaskIds: string[] = [];
  const reapFailedTaskIds: string[] = [];

  for (const { task } of selection.expired) {
    // TOCTOU re-GET (Lucy #2238 pattern): refuse if the live record no longer
    // looks like a clean finishedAwaitingAck, the turn is live, the pane shows
    // human-interactive markers, or a PR hold landed mid-sweep. Deferring here
    // must NOT consume a grace warning — advance() is only reached for a
    // still-eligible task, so a recovered/held task re-warns cleanly later and
    // the maintenance pass clears any stale warning it already holds.
    const fresh = deps.taskStore.getTask(task.id);
    if (!fresh || !isFinishedAwaitingAckCloseCandidate(fresh)) continue;
    if (taskHasLiveTurn(fresh)) {
      deferredTaskIds.push(task.id);
      continue;
    }
    const paneText = deps.getTaskPaneText ? await deps.getTaskPaneText(task.id) : undefined;
    if (paneHasHumanInteractiveMarkers(paneText)) {
      deferredTaskIds.push(task.id);
      continue;
    }
    if (deps.isHoldingOpenPr?.(fresh) === true) {
      deferredTaskIds.push(task.id);
      continue;
    }

    // Grace + veto phase (parity with #2163). warn → countdown starts (rides
    // the snapshot); wait → countdown running; reap → deadline elapsed, close.
    const ageMs = nowMs - Date.parse(fresh.pendingSignal!.raisedAt);
    const present = deps.isTaskSelectedByAnyConnection?.(task.id) ?? false;
    const advance = deps.coordinator.advance({
      taskId: task.id,
      agentId: faaWarningAgentId(fresh),
      silentForMs: ageMs,
      now: nowMs,
      graceMs,
      present,
    });

    if (advance.action === 'warn') {
      // Re-warn suppression (issue #3156): a task whose force-complete keeps
      // failing has its warning consumed by advance() on every reap, so it
      // re-enters the warn state each grace cycle. Suppress the re-warn (no
      // audit row, no counter bump) while it is inside its post-failure window,
      // but leave the coordinator's freshly-created countdown in place so the
      // bounded reap retry still runs and reapFailedTotal keeps surfacing the
      // stuck slot. Scoped per task + refreshed on each failure, so a genuinely
      // newly-stuck task is never masked.
      if (deps.metrics?.isRewarnSuppressed(task.id, nowMs, FAA_REAP_FAILURE_REWARN_SUPPRESS_MS)) {
        continue;
      }
      warnedTaskIds.push(task.id);
      console.warn(
        `[faa-ack-reaper] warned task ${task.id} — close in ${Math.round(graceMs / 1000)}s `
        + `unless acked/kept (finishedAwaitingAck ${Math.round(ageMs / 60_000)}m, present=${present})`,
      );
      await appendAuditRow(deps.auditLogPath, {
        type: 'task.finishedAwaitingAckReapWarned',
        timestamp: nowISO(),
        actor: 'system:finished-awaiting-ack-ack-reaper',
        taskId: task.id,
        ageMs,
        graceMs,
        deadlineMs,
        present,
      });
      continue;
    }
    if (advance.action === 'wait') continue;

    // advance.action === 'reap' — grace elapsed; force-complete.
    try {
      await completeTask(task.id, lifecycleDeps, {
        interactionLogReason: 'finished_awaiting_ack_ack_reap',
      });
    } catch (err) {
      // Force-complete failed — either a benign race with a manual ack / other
      // terminal transition, or a task persistently wedged in a state that
      // keeps rejecting completeTask (issue #3156). Track it (counted as a
      // reapFailed with the other totals at the end of the pass) so a
      // permanently-stuck slot is no longer dropped silently, and arm the
      // per-task re-warn suppression window so the warning advance() just
      // consumed does not re-storm the audit trail every grace cycle.
      reapFailedTaskIds.push(task.id);
      deps.metrics?.armRewarnSuppression(task.id, nowMs);
      console.warn(
        `[faa-ack-reaper] could not reap task ${task.id} (force-complete failed; slot still held, will retry):`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    deps.taskStore.clearPendingSignal(task.id);
    reapedTaskIds.push(task.id);
    console.warn(
      `[faa-ack-reaper] reaped task ${task.id} — finishedAwaitingAck ${Math.round(ageMs / 60_000)}m `
      + `unacknowledged past ${Math.round(deadlineMs / 60_000)}m deadline `
      + `(kept alive ${advance.warning.keptAliveCount}×)`,
    );
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.finishedAwaitingAckReaped',
      timestamp: nowISO(),
      actor: 'system:finished-awaiting-ack-ack-reaper',
      taskId: task.id,
      reason: 'finished_awaiting_ack_ack_reap',
      ageMs,
      deadlineMs,
      warnedAt: advance.warning.warnedAt,
      keptAliveCount: advance.warning.keptAliveCount,
    });
  }

  // Record all pass counters together so the snapshot invariant
  // `attemptedTotal - reapedTotal === reapFailedTotal` never reflects a partial
  // pass — every force-complete verdict landed in exactly one of the reaped /
  // failed arrays above (issue #3156).
  deps.metrics?.recordWarned(warnedTaskIds.length);
  deps.metrics?.recordReaped(reapedTaskIds.length);
  deps.metrics?.recordReapFailure(reapFailedTaskIds.length);
  deps.metrics?.recordAttempted(reapedTaskIds.length + reapFailedTaskIds.length);
  deps.metrics?.recordDeferred(deferredTaskIds.length);

  if (reapedTaskIds.length > 0) {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Reaped ${reapedTaskIds.length} finishedAwaitingAck task(s) on the ack path`,
      details:
        'These tasks finished their work and signalled completion_ready, but sat unacknowledged past '
        + 'the ack-path reap deadline (#2170) and were force-completed after the grace window to free the '
        + 'active concurrency slot. Grace + operator-veto (Keep it alive) and the open-PR / live-turn '
        + 'fail-safes were honored. Review the completed task if manual follow-up is still needed.',
      severity: 'warning',
    });
  }

  return { reapedTaskIds, warnedTaskIds, deferredTaskIds };
}

export interface RunFinishedAwaitingAckReapMaintenanceDeps {
  coordinator: ReapWarningCoordinator;
  auditLogPath?: string;
  isTaskSelectedByAnyConnection?: (taskId: string) => boolean;
  getEnabled?: () => boolean;
  getGraceMs?: () => number;
}

/**
 * Maintenance pass for FAA ack-path reap warnings (issue #2170), run once per
 * liveness tick over the coordinator's OWN warned ids — independent of the
 * selection pass. Mirrors the hung-task reaper's `runReapWarningMaintenance`:
 *
 *  - a task that left the FAA capacity class (acked, completed, cancelled, or
 *    re-prompted so `pendingSignal` cleared) → clear `recovered`;
 *  - a task no longer present (`inProgress` gone) → clear `gone`;
 *  - still an FAA candidate → bounded presence auto-hold, then self-heal a
 *    warning stuck past its deadline (never closes here — closing stays in the
 *    selection-gated reaper).
 *  - kill switch flipped off at runtime → drop all warnings (`disabled`).
 *
 * Returns true when a clear happened (caller should broadcast a snapshot).
 */
export async function runFinishedAwaitingAckReapMaintenance(
  deps: RunFinishedAwaitingAckReapMaintenanceDeps,
  taskStore: TaskStore,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const coordinator = deps.coordinator;
  const warnedIds = coordinator.warnedTaskIds();
  if (warnedIds.length === 0) return false;

  if (!(deps.getEnabled?.() ?? true)) {
    const cleared = coordinator.clearAll();
    for (const id of cleared) {
      await appendFaaReapWarningClearedAudit(deps.auditLogPath, id, 'disabled');
    }
    if (cleared.length > 0) {
      console.warn(`[faa-ack-reaper] reaper disabled — cleared ${cleared.length} warning(s)`);
    }
    return cleared.length > 0;
  }

  const nowMs = now().getTime();
  const graceMs = deps.getGraceMs?.() ?? DEFAULT_FAA_ACK_REAP_GRACE_SECONDS * 1000;
  let changed = false;

  for (const taskId of warnedIds) {
    const task = taskStore.getTask(taskId);
    if (!task || task.status !== 'inProgress') {
      if (coordinator.clear(taskId, 'gone')) {
        changed = true;
        await appendFaaReapWarningClearedAudit(deps.auditLogPath, taskId, 'gone');
      }
      continue;
    }
    if (!isFinishedAwaitingAckCloseCandidate(task)) {
      // Signal was acked / dismissed / superseded — the slot is (or will be)
      // free without a reap; drop the countdown so no banner lingers.
      if (coordinator.clear(taskId, 'recovered')) {
        changed = true;
        console.log(`[faa-ack-reaper] cleared task ${taskId} — recovered (ack landed / no longer FAA)`);
        await appendFaaReapWarningClearedAudit(deps.auditLogPath, taskId, 'recovered');
      }
      continue;
    }

    const present = deps.isTaskSelectedByAnyConnection?.(taskId) ?? false;
    coordinator.applyPresence(taskId, present, nowMs, graceMs);
    const held = coordinator.getWarning(taskId);
    if (held && nowMs > held.deadlineAt + FAA_REAP_WARNING_STUCK_CLEAR_MS) {
      if (coordinator.clear(taskId, 'stale')) {
        changed = true;
        console.warn(`[faa-ack-reaper] cleared task ${taskId} — stuck past deadline with no reap (self-heal)`);
        await appendFaaReapWarningClearedAudit(deps.auditLogPath, taskId, 'stale');
      }
    }
  }

  return changed;
}

async function appendFaaReapWarningClearedAudit(
  auditLogPath: string | undefined,
  taskId: string,
  reason: 'recovered' | 'gone' | 'stale' | 'disabled',
): Promise<void> {
  await appendAuditRow(auditLogPath, {
    type: 'task.finishedAwaitingAckReapWarningCleared',
    timestamp: nowISO(),
    actor: 'system:finished-awaiting-ack-ack-reaper',
    taskId,
    reason,
  });
}
