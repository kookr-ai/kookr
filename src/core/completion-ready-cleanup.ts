import type { Task } from './task-read-model.js';

export const DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS = 60 * 60 * 1000;

/**
 * Default TTL (issue #1526 Phase A / FM5): how long an ask-first (or
 * otherwise not-explicitly-opted-in) `completion_ready` signal can sit
 * unacknowledged before Kookr escalates and closes the task anyway. This is
 * deliberately much longer than {@link DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS}
 * — it is a last-resort drain valve for tasks nobody is looking at, not the
 * normal review window.
 */
export const DEFAULT_COMPLETION_READY_TTL_MS = 120 * 60 * 1000;

export type CompletionReadyManualActionReason =
  | 'auto_close_not_enabled'
  | 'delivery_authorization_required';

/**
 * Why a task became auto-closable.
 *  - `auto_close_on_signal`: the task opted in (`autoCloseOnSignal === true`);
 *    unchanged, immediate behavior.
 *  - `ttl_escalation`: the task did NOT opt in, but its completion_ready
 *    signal has sat unacknowledged past the TTL — a system-driven override of
 *    the manual-review gate (issue #1526 FM5).
 */
export type CompletionReadyCloseReason = 'auto_close_on_signal' | 'ttl_escalation';

export type CompletionReadyClosePolicy =
  | { canAutoClose: true; closeReason: CompletionReadyCloseReason }
  | { canAutoClose: false; manualActionRequiredReason: CompletionReadyManualActionReason };

export interface StaleCompletionReadyTask {
  task: Task;
  signal: NonNullable<Task['pendingSignal']>;
  ageMs: number;
  canAutoClose: boolean;
  manualActionRequiredReason?: CompletionReadyManualActionReason;
  closeReason?: CompletionReadyCloseReason;
}

/**
 * Decide whether a completion_ready signal can be auto-closed.
 *
 * Three tiers:
 * 1. `autoCloseOnSignal === true` — closes immediately, as before.
 * 2. Not opted in, but `ageMs >= ttlMs` — TTL escalation (FM5): the task is
 *    closed anyway so it stops holding a concurrency slot forever, regardless
 *    of `deliveryAuthorization`. `ttlMs` is opt-in (undefined disables this
 *    tier), matching every existing caller until they thread a TTL through.
 * 3. Otherwise — the existing manual-review gate, unchanged.
 */
export function classifyCompletionReadyClosePolicy(
  task: Pick<Task, 'autoCloseOnSignal' | 'deliveryAuthorization'>,
  opts: { ageMs?: number; ttlMs?: number } = {},
): CompletionReadyClosePolicy {
  if (task.autoCloseOnSignal === true) {
    return { canAutoClose: true, closeReason: 'auto_close_on_signal' };
  }
  const ageMs = opts.ageMs ?? 0;
  if (opts.ttlMs !== undefined && ageMs >= opts.ttlMs) {
    return { canAutoClose: true, closeReason: 'ttl_escalation' };
  }
  if (task.deliveryAuthorization === 'ask-first') {
    return { canAutoClose: false, manualActionRequiredReason: 'delivery_authorization_required' };
  }
  return { canAutoClose: false, manualActionRequiredReason: 'auto_close_not_enabled' };
}

export function listStaleCompletionReadyTasks(
  tasks: Task[],
  opts: { now?: Date; thresholdMs?: number; ttlMs?: number } = {},
): StaleCompletionReadyTask[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS;
  const entries: StaleCompletionReadyTask[] = [];

  for (const task of tasks) {
    const signal = task.pendingSignal;
    if (task.status !== 'inProgress' || signal?.kind !== 'completion_ready') continue;

    const raisedAtMs = Date.parse(signal.raisedAt);
    // Persisted task stores can outlive older/invalid signal payloads; skip
    // malformed timestamps rather than surfacing a cleanup row with bogus age.
    if (!Number.isFinite(raisedAtMs)) continue;

    const liveSessionStarts = task.sessions
      .filter((session) => session.lastStatus !== 'completed' && session.lastStatus !== 'aborted')
      .map((session) => session.createdAt.getTime());
    const latestLiveSessionStartedAtMs = Math.max(...liveSessionStarts);
    // Signals recorded before a task has a live session are manual-review
    // breadcrumbs. Do not let a pre-start signal auto-close a later run.
    if (!Number.isFinite(latestLiveSessionStartedAtMs) || raisedAtMs < latestLiveSessionStartedAtMs) continue;

    // Future timestamps can happen after clock skew or manual state edits. Keep
    // the row hidden until local time catches up.
    if (raisedAtMs > nowMs) continue;

    const ageMs = nowMs - raisedAtMs;
    // issue #1526 Phase A: the two populations are gated INDEPENDENTLY.
    // Opted-in (autoCloseOnSignal === true) entries are gated by their own
    // thresholdMs (autoCloseCompletionReadyDelayMin) ONLY — a `ttlMs`
    // shorter than that setting must never sneak an early close past its
    // documented review window. Everyone else is gated by whichever of
    // thresholdMs/ttlMs is smaller, so a short TTL can still surface and
    // escalate an ask-first task before the normal reporting threshold.
    const applicableThresholdMs = task.autoCloseOnSignal === true
      ? thresholdMs
      : (opts.ttlMs !== undefined ? Math.min(thresholdMs, opts.ttlMs) : thresholdMs);
    if (ageMs < applicableThresholdMs) continue;

    const policy = classifyCompletionReadyClosePolicy(task, { ageMs, ttlMs: opts.ttlMs });
    entries.push({
      task,
      signal,
      ageMs,
      canAutoClose: policy.canAutoClose,
      ...(policy.canAutoClose
        ? { closeReason: policy.closeReason }
        : { manualActionRequiredReason: policy.manualActionRequiredReason }),
    });
  }

  return entries.sort((a, b) => Date.parse(a.signal.raisedAt) - Date.parse(b.signal.raisedAt));
}
