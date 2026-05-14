// Agent status is metadata on persisted sessions, not a live state machine.
export type AgentStatus =
  | 'starting'
  | 'running'
  | 'stuck'
  | 'errored'
  | 'completed'
  | 'snoozed';

// Task lifecycle (from features.md F4.4)
// 'terminated' means the session died without user acknowledgement.
export type TaskStatus =
  | 'open'
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'terminated'
  | 'cancelled';

/**
 * Exhaustive classifier: a status is "terminal" when the task has reached an end state.
 * The switch body forces a compile error when a new TaskStatus is added, so every caller
 * that uses this helper is re-routed through a deliberate classification decision.
 */
export function isTerminalStatus(s: TaskStatus): boolean {
  switch (s) {
    case 'completed':
    case 'terminated':
    case 'cancelled':
      return true;
    case 'open':
    case 'pending':
    case 'inProgress':
      return false;
  }
}

export function isActiveStatus(s: TaskStatus): boolean {
  return !isTerminalStatus(s);
}
