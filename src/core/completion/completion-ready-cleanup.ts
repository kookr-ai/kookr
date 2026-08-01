import type { Task } from '../task-read-model.js';

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
  opts: {
    now?: Date;
    thresholdMs?: number;
    ttlMs?: number;
    /**
     * Issue #1667: when true for a task, hold the completion-ready signal
     * without auto-closing — a billing/quota pause is not delivery. The signal
     * stays visible so the operator can ack or the agent can resume after the
     * pause clears.
     */
    isProviderPaused?: (task: Task) => boolean;
  } = {},
): StaleCompletionReadyTask[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const thresholdMs = opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS;
  const entries: StaleCompletionReadyTask[] = [];

  for (const task of tasks) {
    const signal = task.pendingSignal;
    if (task.status !== 'inProgress' || signal?.kind !== 'completion_ready') continue;
    if (opts.isProviderPaused?.(task) === true) continue;

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

/**
 * True when a task has an active Ralph loop (running or paused) that owns its
 * lifecycle. The background auto-close sweep never closes such a task — the
 * Ralph controller is responsible for completing it.
 */
export function isActiveRalphLoop(task: Pick<Task, 'ralphLoop'>): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

export interface SelectAutoClosableOptions {
  now?: Date;
  thresholdMs?: number;
  ttlMs?: number;
  isProviderPaused?: (task: Task) => boolean;
  /**
   * Include stale entries that still require manual action, not only the
   * policy-auto-closable ones — the supervisor "ack all" force drain (issue
   * #1526 Phase B / FM12).
   */
  force?: boolean;
  /**
   * Skip tasks with an active Ralph loop. The background sweep sets this (the
   * Ralph controller owns those tasks); the operator force-drain leaves it off.
   */
  excludeActiveRalph?: boolean;
  /**
   * Oldest-first cap on the returned batch — the sweep's per-tick teardown
   * throttle. Entries are already sorted oldest-first by
   * {@link listStaleCompletionReadyTasks}.
   */
  limit?: number;
}

/**
 * Single owner of "which completion-ready tasks are eligible to auto-close right
 * now" (issue #1827). Both the background sweep (`autoCloseStaleCompletionReadyTasks`
 * in lifecycle-timers) and the supervisor bulk-ack use-case
 * (`ackAllStaleCompletionReadyTasks`) funnel through here instead of each
 * re-deriving the eligibility filter over {@link listStaleCompletionReadyTasks}.
 */
export function selectAutoClosableCompletionReadyTasks(
  tasks: Task[],
  opts: SelectAutoClosableOptions = {},
): StaleCompletionReadyTask[] {
  const entries = listStaleCompletionReadyTasks(tasks, {
    now: opts.now,
    thresholdMs: opts.thresholdMs,
    ttlMs: opts.ttlMs,
    ...(opts.isProviderPaused ? { isProviderPaused: opts.isProviderPaused } : {}),
  }).filter(
    (entry) =>
      (opts.force === true || entry.canAutoClose)
      && (opts.excludeActiveRalph !== true || !isActiveRalphLoop(entry.task)),
  );
  return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
}
