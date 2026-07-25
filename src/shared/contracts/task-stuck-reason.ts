/**
 * Per-task "why is this occupying a capacity slot without doing work" surface
 * (issue #1526 Phase B). Companion to the capacity ledger in `GET /api/health`
 * (`core/capacity-ledger.ts`): where the ledger reports aggregate counts, this
 * is the same underlying signal projected onto each `inProgress` task so a
 * task-list/status surface can render a per-row reason instead of a flat
 * "running" label.
 */
export type TaskStuckReason =
  | 'awaiting_completion_ack'
  | 'hung_suspect'
  | 'waiting_on_input'
  | 'permission_blocked';

export const TASK_STUCK_REASONS: readonly TaskStuckReason[] = [
  'awaiting_completion_ack',
  'hung_suspect',
  'waiting_on_input',
  'permission_blocked',
];

export function isTaskStuckReason(value: unknown): value is TaskStuckReason {
  return typeof value === 'string' && (TASK_STUCK_REASONS as readonly string[]).includes(value);
}
