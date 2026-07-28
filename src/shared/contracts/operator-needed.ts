/**
 * Interactive-tool denial for unattended (autonomous) tasks — issue #1562.
 *
 * Autonomous tasks run with nobody watching, so an interactive tool call (an
 * `AskUserQuestion`-class prompt) becomes an open-ended wait that hangs the
 * agent until it is reaped (prod evidence: task faf7902b stuck at "Waiting for
 * response…" for hours). Instead of relying on the probabilistic §0 HARD-RULES
 * wording in the launch brief, Kookr injects a deterministic permission `deny`
 * rule for these tools into the spawned agent's `--settings`, and raises an
 * explicit operator-needed flag on the task when the denied call is observed.
 */

/**
 * Tool names that are interactive/blocking for a Claude Code agent — a call
 * parks the turn waiting for a human answer. Denied for unattended spawns.
 *
 * Kept as a single-source list so the adapter (which builds the `deny` rules),
 * the server processor (which recognizes the observed call), and tests all agree.
 * Extend here if additional blocking tools are identified per adapter.
 */
export const INTERACTIVE_TOOL_NAMES = ['AskUserQuestion'] as const;

/** True when `name` is a known interactive/blocking tool. */
export function isInteractiveToolName(name: string): boolean {
  return (INTERACTIVE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Claude Code `permissions.deny` rule strings for the interactive tools. A bare
 * tool name denies every use of that tool. Injected into the per-session
 * settings file only for unattended spawns (attended tasks are unaffected).
 */
export const INTERACTIVE_TOOL_DENY_RULES: readonly string[] = INTERACTIVE_TOOL_NAMES;

export type OperatorNeededReason = 'interactive_tool_denied';

/**
 * Operator-needed marker set on a task when an unattended agent's interactive
 * tool call was denied. Surfaced via the tasks API and the dashboard task
 * detail so an operator can step in, rather than the agent hanging on an
 * unanswerable prompt.
 *
 * Set-once (first-write-wins, see `TaskStore.setOperatorNeeded`): the marker
 * records the FIRST denied interactive call and is not cleared or overwritten
 * for the task's lifetime. It is a durable "this autonomous run needed a human"
 * signal, not a live toggle — there is deliberately no reset path.
 */
export interface OperatorNeeded {
  reason: OperatorNeededReason;
  /** The interactive tool the autonomous agent tried to invoke. */
  toolName: string;
  /** First time the denied interactive call was observed. */
  detectedAt: Date;
  /** Human-facing explanation for the operator. */
  message: string;
}

/** Build the operator-facing message for a denied interactive tool call. */
export function operatorNeededMessage(toolName: string): string {
  return (
    `Autonomous task tried to use the interactive tool "${toolName}", which is denied for `
    + `unattended spawns. The agent was blocked instead of left hanging; an operator must step in.`
  );
}
