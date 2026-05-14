export type AgentStatus =
  | 'starting'
  | 'running'
  | 'stuck'
  | 'errored'
  | 'completed'
  | 'snoozed';

export type TaskStatus =
  | 'open'
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'terminated'
  | 'cancelled';

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
