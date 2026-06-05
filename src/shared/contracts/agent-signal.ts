/**
 * Agent → user signal surface (RFC: rfc-agent-signal-surface).
 *
 * A non-blocking, explicit signal an in-task agent raises to tell Kookr it
 * believes something — the motivating case being "this task is ready for
 * completion". Kookr owns the surfacing (e.g. highlighting the one-click
 * Complete button); the agent proposes, the user disposes. A pending signal is
 * overlay state on the task, never a lifecycle mutation.
 */

/**
 * Bounded set of signal kinds. One member today. Governance rule for adding a
 * kind (see RFC): it requires (a) a concrete user-facing use case, (b) a
 * defined accept action, and (c) a defined dismiss action. Absent all three,
 * use AskUserQuestion instead.
 */
export type AgentSignalKind = 'completion_ready';

export const AGENT_SIGNAL_KINDS: readonly AgentSignalKind[] = ['completion_ready'];

export function isAgentSignalKind(value: unknown): value is AgentSignalKind {
  return value === 'completion_ready';
}

/** Max length of the optional, best-effort-redacted note carried with a signal. */
export const MAX_AGENT_SIGNAL_NOTE_LENGTH = 280;

/**
 * The pending signal currently raised for a task. Stored on the task record
 * and joined onto the client-facing AgentState at projection time (it is never
 * set on the raw Monitor AgentState). Cleared on dismiss or terminal status;
 * while the agent keeps working the surfacing self-gates (the Complete pulse
 * shows only when turnState is `completed_turn`).
 */
export interface PendingAgentSignal {
  kind: AgentSignalKind;
  /**
   * Optional short note from the agent. Best-effort secret-scrubbed before
   * storage/broadcast — the scrubber matches a fixed set of token patterns and
   * does NOT catch bare passwords or unknown credential formats. Length-capped
   * to {@link MAX_AGENT_SIGNAL_NOTE_LENGTH}.
   */
  note?: string;
  /** ISO timestamp the signal was raised, stamped server-side. */
  raisedAt: string;
}
