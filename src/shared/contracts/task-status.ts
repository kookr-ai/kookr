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

/**
 * Current turn state of a live interactive agent, derived from its event
 * window. This is deliberately separate from {@link TaskStatus}: a task can
 * stay `inProgress` (the terminal process is alive and accepts follow-ups)
 * while its agent's current turn is `completed_turn` — idle after a normal
 * `Stop`, not actively running and not hung. See issue #358.
 */
export type TurnState =
  | 'running' // actively executing the current turn (tool calls / reasoning)
  | 'waiting_for_input' // explicitly asked the user a question mid-turn
  | 'completed_turn' // emitted a normal Stop with a final answer; awaiting follow-up
  | 'blocked' // hard-blocked (permission request or API error killed the turn)
  | 'unknown'; // no events yet or indeterminate
