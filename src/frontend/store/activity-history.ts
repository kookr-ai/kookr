import type { AgentEvent, AgentState } from '../../shared/protocol.js';

function eventKey(event: AgentEvent): string {
  return JSON.stringify(event);
}

function eventSeq(event: AgentEvent): number | undefined {
  return typeof event.eventSeq === 'number' ? event.eventSeq : undefined;
}

function containsExistingEventSeqSubsequence(existing: AgentEvent[], incoming: AgentEvent[]): boolean {
  if (existing.length === 0) return incoming.length > 0;
  const existingSeqs = existing.map(eventSeq);
  const incomingSeqs = incoming.map(eventSeq);
  if (existingSeqs.some((seq) => seq === undefined) || incomingSeqs.some((seq) => seq === undefined)) {
    return false;
  }

  for (let start = 0; start <= incomingSeqs.length - existingSeqs.length; start++) {
    let matches = true;
    for (let i = 0; i < existingSeqs.length; i++) {
      if (incomingSeqs[start + i] !== existingSeqs[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function containsExistingJsonSubsequence(existing: AgentEvent[], incoming: AgentEvent[]): boolean {
  if (existing.length === 0) return incoming.length > 0;
  for (let start = 0; start <= incoming.length - existing.length; start++) {
    let matches = true;
    for (let i = 0; i < existing.length; i++) {
      if (eventKey(incoming[start + i]) !== eventKey(existing[i])) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function findOverlap(existing: AgentEvent[], incoming: AgentEvent[]): number {
  const max = Math.min(existing.length, incoming.length);
  for (let length = max; length > 0; length--) {
    let matches = true;
    for (let i = 0; i < length; i++) {
      if (eventKey(existing[existing.length - length + i]) !== eventKey(incoming[i])) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

export function mergeActivityEvents(previous: AgentState | undefined, incoming: AgentState): AgentEvent[] {
  if (!previous) return incoming.events;

  const existingEvents = previous.events;
  const incomingEvents = incoming.events;

  if (containsExistingEventSeqSubsequence(existingEvents, incomingEvents)) {
    return incomingEvents;
  }

  const hasCompleteSeqs = existingEvents.every((event) => eventSeq(event) !== undefined)
    && incomingEvents.every((event) => eventSeq(event) !== undefined);
  if (!hasCompleteSeqs && containsExistingJsonSubsequence(existingEvents, incomingEvents)) {
    return incomingEvents;
  }

  const overlap = findOverlap(existingEvents, incomingEvents);
  return [...existingEvents, ...incomingEvents.slice(overlap)];
}

export function mergeActivityAgent(previous: AgentState | undefined, incoming: AgentState): AgentState {
  return {
    ...incoming,
    events: mergeActivityEvents(previous, incoming),
    ...(incoming.activityMeta === undefined && previous?.activityMeta !== undefined
      ? { activityMeta: previous.activityMeta }
      : {}),
  };
}
