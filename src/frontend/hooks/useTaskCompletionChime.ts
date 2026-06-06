import { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { maybePlayChime } from '../audio/sound.js';
import type { AgentState } from '../../shared/protocol.js';
import type { AudioAlertContext } from '../audio/audio-alert-log.js';

const SEEN_SIGNAL_LIMIT = 500;
const CHIME_DEBOUNCE_MS = 1500;

const seenSignalIds: string[] = [];
const seenSignalIdSet = new Set<string>();
let hydrated = false;
let lastAudibleChimeAt = 0;

export interface CompletionSignalChimeDecision {
  contexts: AudioAlertContext[];
  audibleContext?: AudioAlertContext;
}

function rememberSignalId(id: string): void {
  if (seenSignalIdSet.has(id)) return;
  seenSignalIdSet.add(id);
  seenSignalIds.push(id);
  while (seenSignalIds.length > SEEN_SIGNAL_LIMIT) {
    const removed = seenSignalIds.shift();
    if (removed) seenSignalIdSet.delete(removed);
  }
}

export function evaluateCompletionSignalChime(
  agents: AgentState[],
  now = Date.now(),
): CompletionSignalChimeDecision {
  const unseen = agents
    .map((agent) => ({ agent, signal: agent.latestCompletionSignal }))
    .filter((item): item is { agent: AgentState; signal: NonNullable<AgentState['latestCompletionSignal']> } => (
      item.signal !== undefined && !seenSignalIdSet.has(item.signal.id)
    ));

  for (const item of unseen) rememberSignalId(item.signal.id);

  if (!hydrated) {
    hydrated = true;
    return { contexts: [] };
  }
  if (unseen.length === 0) return { contexts: [] };

  const contexts = unseen.map(({ agent, signal }, index): AudioAlertContext => ({
      source: 'completion_signal',
      reason: 'agent signaled task complete',
      agentId: agent.agentId,
      taskId: agent.taskId,
      taskName: agent.taskName,
      completionSignalId: signal.id,
      candidateCount: index === 0 ? unseen.length : 1,
      primaryCause: 'completion_signal',
  }));

  if (now - lastAudibleChimeAt < CHIME_DEBOUNCE_MS) return { contexts };

  lastAudibleChimeAt = now;
  return { contexts, audibleContext: contexts[0] };
}

/**
 * Plays a soft cue when any task receives a fresh completion signal. This is
 * intentionally not focus-gated: the signal means an agent has said its work is
 * ready for review, which is useful precisely when the user is looking
 * elsewhere. Manual lifecycle completion does not create this signal.
 */
export function useTaskCompletionChime(): void {
  const agents = useKookrStore((s) => s.agents);
  const agentsHydrated = useKookrStore((s) => s.agentsHydrated);

  useEffect(() => {
    if (!agentsHydrated) return;
    const result = evaluateCompletionSignalChime(agents);
    for (const context of result.contexts) {
      maybePlayChime(context, { audible: context === result.audibleContext });
    }
  }, [agents, agentsHydrated]);
}

export function __resetTaskCompletionChimeForTests(): void {
  seenSignalIds.length = 0;
  seenSignalIdSet.clear();
  hydrated = false;
  lastAudibleChimeAt = 0;
}
