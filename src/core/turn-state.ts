import type { AgentEvent, TurnState } from './types.js';

/**
 * Trailing events that are bookkeeping overlays, not turn-state transitions.
 * Kept in lockstep with the trim list in `evaluateAnomalies` (anomaly-detector)
 * so turn-state derivation and anomaly detection agree on which event is the
 * effective end of the turn:
 *  - `notification` is an async signal (idle_prompt, auth_success, …).
 *  - `subagent_stop` can arrive after the parent's own Stop as cleanup metadata.
 */
function isTrailingStateOverlay(event: AgentEvent): boolean {
  return event.type === 'notification' || event.type === 'subagent_stop';
}

/**
 * Derive the current turn state of an interactive agent from its event window.
 *
 * Turn state answers "what is the agent doing in its current turn", which is
 * independent of the persisted task lifecycle (`TaskStatus`). An interactive
 * Codex/Claude task stays `inProgress` while the terminal process is alive,
 * but its turn state cycles `running` → `completed_turn` → `running` … as the
 * user sends follow-ups. See issue #358.
 *
 * This is a pure function over the (already-windowed) event list; subagent and
 * watchdog overrides are applied by the caller — see `Monitor.getSnapshot`.
 */
export function deriveTurnState(events: AgentEvent[]): TurnState {
  if (events.length === 0) return 'unknown';

  // Trim trailing bookkeeping overlays so a SubagentStop or idle notification
  // arriving after the parent's Stop does not mask the completed turn.
  let window = events;
  while (window.length > 0 && isTrailingStateOverlay(window[window.length - 1])) {
    window = window.slice(0, -1);
  }
  if (window.length === 0) return 'unknown';

  const last = window[window.length - 1];
  switch (last.type) {
    case 'stop':
      // Normal end-of-turn: a final assistant message was emitted and the
      // agent is idle, waiting for an optional follow-up — NOT hung.
      return 'completed_turn';
    case 'stop_failure':
      // An API error killed the turn — the agent is hard-blocked.
      return 'blocked';
    case 'permission_request':
      // Claude Code fires a PermissionRequest(AskUserQuestion) — plus a trailing
      // Notification(permission_prompt) that we trim above — right after the
      // PreToolUse(AskUserQuestion) while the user is still at the choice menu.
      // That is the agent waiting on the user mid-turn, NOT a tool-permission
      // block; surface it as `waiting_for_input` so the dashboard reads "Waiting
      // for your input" rather than "Blocked"/"working".
      return last.toolName === 'AskUserQuestion' ? 'waiting_for_input' : 'blocked';
    case 'session_end':
      // The session is over; turn state is no longer meaningful.
      return 'unknown';
    case 'tool_use':
      // An unanswered AskUserQuestion is the agent explicitly waiting on the
      // user mid-turn — distinct from a normal completed turn.
      return last.toolName === 'AskUserQuestion' ? 'waiting_for_input' : 'running';
    default:
      // tool_result, tool_error, user_prompt, session_start, subagent_start,
      // error, input_received — the agent is actively working the turn.
      return 'running';
  }
}
