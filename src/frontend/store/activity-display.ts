import type { ActivityItem, AgentEvent, AgentState } from '../../shared/protocol.js';
import { summarizeActivity } from '../../shared/protocol.js';

export type ActivityDisplayItem =
  | { kind: 'agent_event'; event: AgentEvent }
  | {
      kind: 'launch_placeholder';
      agentId: string;
      prompt: string;
      cwd?: string;
    };

export type ActivityDisplayAgent = Pick<AgentState, 'agentId' | 'events' | 'description' | 'cwd'>;

export function normalizeLaunchPrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, '\n').trim();
}

function eventSeq(event: AgentEvent): number | undefined {
  return typeof event.eventSeq === 'number' ? event.eventSeq : undefined;
}

function allEventsHaveEventSeq(events: AgentEvent[]): boolean {
  return events.every((event) => eventSeq(event) !== undefined);
}

function minEventSeq(events: AgentEvent[]): number | undefined {
  if (events.length === 0 || !allEventsHaveEventSeq(events)) return undefined;
  return Math.min(...events.map((event) => eventSeq(event) as number));
}

function hasCompleteVisiblePrefix(events: AgentEvent[]): boolean {
  if (events.length === 0) return false;

  const minSeq = minEventSeq(events);
  if (minSeq !== undefined) return minSeq === 1;

  return events[0]?.type === 'session_start';
}

function canonicalizeCompletePrefix(events: AgentEvent[]): AgentEvent[] {
  // Complete-prefix evidence lets display dedupe trust the provider launch prompt.
  // Sequenced streams can arrive out of order, so sort only when the visible
  // window includes eventSeq 1; legacy streams require a leading session_start.
  if (!hasCompleteVisiblePrefix(events)) return events;
  if (!allEventsHaveEventSeq(events)) return events;
  return [...events].sort((a, b) => (eventSeq(a) ?? 0) - (eventSeq(b) ?? 0));
}

function isLaunchPrefixNoise(event: AgentEvent): boolean {
  if (event.type === 'session_start') return true;
  return event.type === 'notification' && event.notificationType.startsWith('mcp_startup_');
}

export function hasProviderLaunchPrompt(events: AgentEvent[], prompt: string): boolean {
  const normalizedPrompt = normalizeLaunchPrompt(prompt);
  if (!normalizedPrompt) return false;

  const ordered = canonicalizeCompletePrefix(events);
  if (!hasCompleteVisiblePrefix(ordered)) return false;

  for (const event of ordered) {
    if (isLaunchPrefixNoise(event)) continue;
    if (event.type !== 'user_prompt') return false;
    return normalizeLaunchPrompt(event.prompt) === normalizedPrompt;
  }
  return false;
}

export function buildActivityDisplayItems(agent: ActivityDisplayAgent): ActivityDisplayItem[] {
  const orderedEvents = canonicalizeCompletePrefix(agent.events);
  const raw = orderedEvents.map((event) => ({ kind: 'agent_event', event }) as const);
  const prompt = normalizeLaunchPrompt(agent.description ?? '');
  if (!prompt) return raw;
  if (hasProviderLaunchPrompt(orderedEvents, prompt)) return raw;

  const placeholder: ActivityDisplayItem = {
    kind: 'launch_placeholder',
    agentId: agent.agentId,
    prompt,
    ...(agent.cwd ? { cwd: agent.cwd } : {}),
  };

  if (orderedEvents[0]?.type === 'session_start') {
    return [raw[0], placeholder, ...raw.slice(1)];
  }
  return [placeholder, ...raw];
}

function activityDisplayItemToSummaryEvent(item: ActivityDisplayItem): AgentEvent {
  if (item.kind === 'agent_event') return item.event;
  return {
    type: 'user_prompt',
    sessionId: item.agentId,
    prompt: item.prompt,
    ...(item.cwd ? { cwd: item.cwd } : {}),
  };
}

export function activityDisplayItemsToEvents(displayItems: ActivityDisplayItem[]): AgentEvent[] {
  return displayItems.map(activityDisplayItemToSummaryEvent);
}

export function summarizeActivityDisplayItems(displayItems: ActivityDisplayItem[]): ActivityItem[] {
  return summarizeActivity(activityDisplayItemsToEvents(displayItems));
}
