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

export interface DerivedTurnState {
  turnState: TurnState;
  effectiveEvent?: AgentEvent;
  effectiveEventIndex: number;
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
export function deriveTurnStateDetails(events: AgentEvent[]): DerivedTurnState {
  if (events.length === 0) return { turnState: 'unknown', effectiveEventIndex: -1 };

  // Trim trailing bookkeeping overlays so a SubagentStop or idle notification
  // arriving after the parent's Stop does not mask the completed turn.
  let effectiveEventIndex = events.length - 1;
  while (effectiveEventIndex >= 0 && isTrailingStateOverlay(events[effectiveEventIndex])) {
    effectiveEventIndex -= 1;
  }
  if (effectiveEventIndex < 0) return { turnState: 'unknown', effectiveEventIndex: -1 };

  const last = events[effectiveEventIndex];
  switch (last.type) {
    case 'stop':
      // A Stop fires whenever the agent's turn ends, INCLUDING when it ended
      // its turn to wait on still-running background work it launched itself —
      // a `run_in_background` shell or a session cron that will wake it when it
      // produces output. The Stop hook reports those as `background_tasks` /
      // `session_crons`; a non-zero count means the agent is not actually idle,
      // it is parked waiting to be re-invoked. Treat that as `running` so the
      // turn is not mistaken for a clean finish — both in the live badge and in
      // the persisted `lastTurnState` that reconciliation reads to auto-complete
      // dead-session tasks (`endedOnCleanTurn`, #693). This mirrors the
      // outstanding-subagent suppression in `Monitor.deriveTurnStateForSnapshot`;
      // the difference is that background-task/cron counts are intrinsic to the
      // Stop event, so they belong in this pure derivation rather than needing
      // cross-event tracking in the caller.
      if (
        (last.activeBackgroundTaskCount ?? 0) > 0
        || (last.activeSessionCronCount ?? 0) > 0
      ) {
        return { turnState: 'running', effectiveEvent: last, effectiveEventIndex };
      }
      // Normal end-of-turn: a final assistant message was emitted and the
      // agent is idle, waiting for an optional follow-up — NOT hung.
      return { turnState: 'completed_turn', effectiveEvent: last, effectiveEventIndex };
    case 'stop_failure':
      // An API error killed the turn — the agent is hard-blocked.
      return { turnState: 'blocked', effectiveEvent: last, effectiveEventIndex };
    case 'permission_request':
      // Claude Code fires a PermissionRequest(AskUserQuestion) — plus a trailing
      // Notification(permission_prompt) that we trim above — right after the
      // PreToolUse(AskUserQuestion) while the user is still at the choice menu.
      // That is the agent waiting on the user mid-turn, NOT a tool-permission
      // block; surface it as `waiting_for_input` so the dashboard reads "Waiting
      // for your input" rather than "Blocked"/"working".
      return {
        turnState: last.toolName === 'AskUserQuestion' ? 'waiting_for_input' : 'blocked',
        effectiveEvent: last,
        effectiveEventIndex,
      };
    case 'session_end':
      // The session is over; turn state is no longer meaningful.
      return { turnState: 'unknown', effectiveEvent: last, effectiveEventIndex };
    case 'tool_use':
      // An unanswered AskUserQuestion is the agent explicitly waiting on the
      // user mid-turn — distinct from a normal completed turn.
      return {
        turnState: last.toolName === 'AskUserQuestion' ? 'waiting_for_input' : 'running',
        effectiveEvent: last,
        effectiveEventIndex,
      };
    default:
      // tool_result, tool_error, user_prompt, session_start, subagent_start,
      // error, input_received — the agent is actively working the turn.
      return { turnState: 'running', effectiveEvent: last, effectiveEventIndex };
  }
}

export function deriveTurnState(events: AgentEvent[]): TurnState {
  return deriveTurnStateDetails(events).turnState;
}
