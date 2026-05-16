import { useEffect, useRef } from 'react';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import { useKookrStore } from '../store/useStore.js';
import { maybePlayChime } from '../audio/sound.js';
import type { AgentState } from '../../shared/protocol.js';
import type { AudioAlertContext } from '../audio/audio-alert-log.js';

export interface FocusedStatus {
  agentId: string;
  status: TaskStatus | undefined;
}

interface CompletionChimeResult {
  /** Next ref state. null = "no focus / focus mismatch / agent unknown" — caller stores this. */
  next: FocusedStatus | null;
  /** True when a non-terminal → terminal transition was observed *while focused*. */
  shouldChime: boolean;
  reason: CompletionChimeReason;
  context?: AudioAlertContext;
}

export type CompletionChimeReason =
  | 'no_selection'
  | 'unknown_agent'
  | 'focus_changed_prime'
  | 'status_unchanged'
  | 'previous_terminal'
  | 'next_not_terminal'
  | 'terminal_transition';

/**
 * Pure decision function for the task-completion chime.
 *
 * Given the previous focus-ref state, the currently selected agentId, and
 * the focused agent's `AgentState` (or null if not in the agents list),
 * returns the next ref state and whether to chime.
 *
 * Semantics:
 *   - No selection or unknown agent → reset ref, no chime.
 *   - Focus changed (or first observation) → prime ref with current status,
 *     no chime. This is what enforces "while-focused" — a transition that
 *     happened off-screen is treated as a fresh first observation when the
 *     user returns and so does not chime.
 *   - Same focus, status unchanged → no chime.
 *   - Same focus, status changed, prev was terminal → no chime (e.g. ack
 *     flow `terminated → completed`, or reopen `completed → open`).
 *   - Same focus, status changed, next is undefined or non-terminal → no
 *     chime.
 *   - Otherwise (same focus, non-terminal → terminal) → chime.
 *
 * Exported for unit testing — the React hook below is a thin wrapper.
 */
export function evaluateCompletionChime(
  prev: FocusedStatus | null,
  selectedAgentId: string | null,
  agent: AgentState | undefined,
): CompletionChimeResult {
  if (!selectedAgentId) {
    return { next: null, shouldChime: false, reason: 'no_selection' };
  }
  if (!agent) {
    return { next: null, shouldChime: false, reason: 'unknown_agent' };
  }

  const next = agent.taskStatus;

  // Focus changed (or first observation): prime, never chime.
  if (prev?.agentId !== selectedAgentId) {
    return {
      next: { agentId: selectedAgentId, status: next },
      shouldChime: false,
      reason: 'focus_changed_prime',
    };
  }

  const prevStatus = prev.status;
  // Always advance the ref BEFORE deciding. If the chime path ever throws
  // synchronously, the next observation must see prev=next so it does not
  // re-chime the same transition.
  const nextRef: FocusedStatus = { agentId: selectedAgentId, status: next };

  if (prevStatus === next) return { next: nextRef, shouldChime: false, reason: 'status_unchanged' };
  if (next === undefined) return { next: nextRef, shouldChime: false, reason: 'next_not_terminal' };
  if (prevStatus !== undefined && isTerminalStatus(prevStatus)) {
    return { next: nextRef, shouldChime: false, reason: 'previous_terminal' };
  }
  if (!isTerminalStatus(next)) return { next: nextRef, shouldChime: false, reason: 'next_not_terminal' };

  return {
    next: nextRef,
    shouldChime: true,
    reason: 'terminal_transition',
    context: {
      source: 'task_completion',
      reason: `task ${next}`,
      agentId: agent.agentId,
      taskId: agent.taskId,
      taskName: agent.taskName,
      previousStatus: prevStatus,
      nextStatus: next,
      selectedAgentId,
      focused: true,
      primaryCause: 'task_completion',
    },
  };
}

/**
 * Plays an audible chime when the focused task transitions into a terminal
 * status (`completed`, `terminated`, `cancelled`) while the user has it
 * focused. Respects the existing mute toggle and DND state via
 * `maybePlayChime`.
 *
 * Asymmetric with `useAudibleAlert`: the finding chime fires regardless of
 * focus (anomalies are attention-routing — the user must be told to
 * switch). Completion only chimes for the watched task because non-focused
 * completions are already surfaced visually in the completed list, and
 * audio for them would re-introduce the "storm" this RFC removes. See
 * docs/rfc/rfc-task-chime-browser.md §6.
 */
export function useTaskCompletionChime(): void {
  const selectedAgentId = useKookrStore((s) => s.selectedAgentId);
  const agents = useKookrStore((s) => s.agents);

  // Tracks the focused agent's last-observed status. Reset whenever focus
  // changes, so a transition that happens while the agent is *not* focused
  // is not retroactively chimed when the user focuses back.
  //
  // StrictMode-safe under either ref-persistence interpretation: if useRef
  // persists across the dev mount→cleanup→mount cycle, the second effect
  // run sees prev=next and short-circuits; if the ref resets to null, the
  // focus-change branch primes it without chiming.
  const focusRef = useRef<FocusedStatus | null>(null);

  useEffect(() => {
    const agent = selectedAgentId
      ? agents.find((a) => a.agentId === selectedAgentId)
      : undefined;
    const result = evaluateCompletionChime(focusRef.current, selectedAgentId, agent);
    focusRef.current = result.next;
    if (result.shouldChime && result.context) {
      maybePlayChime(result.context);
    }
  }, [selectedAgentId, agents]);
}
