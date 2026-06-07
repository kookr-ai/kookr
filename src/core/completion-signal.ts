import { createHash } from 'node:crypto';
import type { AgentEvent, TaskStatus } from './types.js';
import { deriveTurnStateDetails } from './turn-state.js';
import type { LatestCompletionSignal } from '../shared/contracts/completion-signal.js';

export interface CompletionSignalInput {
  taskId: string;
  agentId: string;
  taskStatus?: TaskStatus;
  events: AgentEvent[];
}

export function deriveLatestCompletionSignal(input: CompletionSignalInput): LatestCompletionSignal | undefined {
  if (input.taskStatus !== 'inProgress') return undefined;

  const details = deriveTurnStateDetails(input.events);
  if (details.turnState !== 'completed_turn') return undefined;
  const stop = details.effectiveEvent;
  if (stop?.type !== 'stop') return undefined;

  const normalizedMessage = normalizeFinalMessage(stop.lastMessage);
  if (!normalizedMessage) return undefined;

  const lastMessageHash = sha256Short(normalizedMessage);
  const turnBoundaryId = stop.turnId ?? findTurnBoundaryId(input.events, details.effectiveEventIndex);
  const stopEventId = `stop:${stop.eventSeq ?? details.effectiveEventIndex}`;
  const id = sha256Short([
    input.taskId,
    input.agentId,
    turnBoundaryId,
    stopEventId,
    lastMessageHash,
  ].join('\u001f'));

  return {
    id,
  };
}

function findTurnBoundaryId(events: AgentEvent[], stopIndex: number): string {
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'user_prompt' || event.type === 'input_received') {
      return `${event.type}:${event.eventSeq ?? index}`;
    }
    if (event.type === 'session_start') {
      return `session_start:${event.eventSeq ?? index}`;
    }
  }
  return 'initial-turn';
}

function normalizeFinalMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
