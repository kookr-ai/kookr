import type { AgentEvent, AgentState } from '../../shared/protocol.js';

function eventKey(event: AgentEvent): string {
  return JSON.stringify(event);
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

function hasLaunchPrompt(events: AgentEvent[], prompt: string): boolean {
  return events.some((event) => event.type === 'user_prompt' && event.prompt === prompt);
}

function withLaunchPrompt(agent: AgentState, events: AgentEvent[]): AgentEvent[] {
  const prompt = agent.description?.trim();
  if (!prompt || hasLaunchPrompt(events, prompt)) return events;

  const launchPrompt: AgentEvent = {
    type: 'user_prompt',
    sessionId: agent.agentId,
    prompt,
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
  };

  if (events[0]?.type === 'session_start') {
    return [events[0], launchPrompt, ...events.slice(1)];
  }
  return [launchPrompt, ...events];
}

export function mergeActivityEvents(previous: AgentState | undefined, incoming: AgentState): AgentEvent[] {
  if (!previous) return withLaunchPrompt(incoming, incoming.events);

  const existingEvents = withLaunchPrompt(
    { ...incoming, events: previous.events },
    previous.events,
  );
  const incomingEvents = incoming.events;

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
