import type { Task } from './task-read-model.js';

export const DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type CompletionReadyManualActionReason =
  | 'auto_close_not_enabled'
  | 'delivery_authorization_required';

export type CompletionReadyClosePolicy =
  | { canAutoClose: true }
  | { canAutoClose: false; manualActionRequiredReason: CompletionReadyManualActionReason };

export interface StaleCompletionReadyTask {
  task: Task;
  signal: NonNullable<Task['pendingSignal']>;
  ageMs: number;
  canAutoClose: boolean;
  manualActionRequiredReason?: CompletionReadyManualActionReason;
}

export function classifyCompletionReadyClosePolicy(task: Pick<Task, 'autoCloseOnSignal' | 'deliveryAuthorization'>): CompletionReadyClosePolicy {
  if (task.autoCloseOnSignal === true) {
    return { canAutoClose: true };
  }
  if (task.deliveryAuthorization === 'ask-first') {
    return { canAutoClose: false, manualActionRequiredReason: 'delivery_authorization_required' };
  }
  return { canAutoClose: false, manualActionRequiredReason: 'auto_close_not_enabled' };
}

export function listStaleCompletionReadyTasks(
  tasks: Task[],
  opts: { now?: Date; thresholdMs?: number } = {},
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

    // Future timestamps can happen after clock skew or manual state edits. Keep
    // the row hidden until local time catches up.
    if (raisedAtMs > nowMs) continue;

    const ageMs = nowMs - raisedAtMs;
    if (ageMs < thresholdMs) continue;

    const policy = classifyCompletionReadyClosePolicy(task);
    entries.push({
      task,
      signal,
      ageMs,
      canAutoClose: policy.canAutoClose,
      ...(!policy.canAutoClose ? { manualActionRequiredReason: policy.manualActionRequiredReason } : {}),
    });
  }

  return entries.sort((a, b) => Date.parse(a.signal.raisedAt) - Date.parse(b.signal.raisedAt));
}
