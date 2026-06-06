import type { AgentState } from '../shared/protocol.js';

export type DebugTimelineKind = 'websocket' | 'store' | 'finding-lifecycle';
export type DebugTimelineDirection = 'inbound' | 'outbound';

export interface DebugTimelineEntry {
  sequence: number;
  t: string;
  kind: DebugTimelineKind;
  summary: string;
  tags: string[];
  payload?: unknown;
}

export interface DebugTimelineRingBuffer<T> {
  push(value: T): void;
  entries(): T[];
  clear(): void;
}

export const DEBUG_TIMELINE_CAPACITY = 200;

type Listener = () => void;

let nextSequence = 1;
let enabledOverride: boolean | null = null;
const timelineBuffer = createDebugTimelineRingBuffer<DebugTimelineEntry>(DEBUG_TIMELINE_CAPACITY);
const listeners = new Set<Listener>();

export function createDebugTimelineRingBuffer<T>(capacity: number): DebugTimelineRingBuffer<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error('Debug timeline ring buffer capacity must be a positive integer');
  }
  let values: T[] = [];
  return {
    push(value) {
      values = [...values, value].slice(-capacity);
    },
    entries() {
      return [...values];
    },
    clear() {
      values = [];
    },
  };
}

export function isDebugTimelineEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  const isDevBuild = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!isDevBuild) return false;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('debug') === '1' || window.localStorage?.getItem('kookr-debug-timeline') === '1';
  } catch {
    return false;
  }
}

export function setDebugTimelineEnabledForTests(enabled: boolean | null): void {
  enabledOverride = enabled;
}

export function subscribeDebugTimeline(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDebugTimelineEntries(): DebugTimelineEntry[] {
  return timelineBuffer.entries().map(cloneEntry);
}

export function clearDebugTimeline(): void {
  timelineBuffer.clear();
  nextSequence = 1;
  emit();
}

export function recordWebSocketDebugEvent(
  direction: DebugTimelineDirection,
  rawOrMessage: string | Record<string, unknown>,
  parsed?: unknown | null,
): void {
  if (!isDebugTimelineEnabled()) return;
  const payload = typeof rawOrMessage === 'string' ? parsed : rawOrMessage;
  const type = messageType(payload);
  const encodedByteLength = byteLength(typeof rawOrMessage === 'string' ? rawOrMessage : safeStringify(rawOrMessage));
  recordDebugTimelineEntry({
    kind: 'websocket',
    summary: `${direction} ${type ?? 'unknown'} (${encodedByteLength} bytes)`,
    tags: ['websocket', direction, ...(type ? [type] : [])],
    payload: {
      direction,
      type,
      byteLength: encodedByteLength,
      fieldNames: fieldNames(payload),
      parseOk: parsed !== null,
      identifiers: messageIdentifiers(payload),
    },
  });
}

export function recordStoreMutationDebugEvent(
  beforeAgents: AgentState[],
  afterAgents: AgentState[],
  changedKeys: string[],
  partial: Record<string, unknown>,
): void {
  if (!isDebugTimelineEnabled()) return;
  if (changedKeys.length === 0) return;
  recordDebugTimelineEntry({
    kind: 'store',
    summary: `store mutation: ${changedKeys.slice(0, 4).join(', ')}${changedKeys.length > 4 ? ` +${changedKeys.length - 4}` : ''}`,
    tags: ['store', ...changedKeys],
    payload: {
      changedKeys,
      agentCountBefore: beforeAgents.length,
      agentCountAfter: afterAgents.length,
      selectedAgentId: typeof partial.selectedAgentId === 'string' || partial.selectedAgentId === null
        ? partial.selectedAgentId
        : undefined,
    },
  });
  for (const transition of findingTransitions(beforeAgents, afterAgents)) {
    recordDebugTimelineEntry(transition);
  }
}

function recordDebugTimelineEntry(input: Omit<DebugTimelineEntry, 'sequence' | 't'>): void {
  timelineBuffer.push({ ...input, sequence: nextSequence++, t: new Date().toISOString() });
  emit();
}

function findingTransitions(beforeAgents: AgentState[], afterAgents: AgentState[]): Array<Omit<DebugTimelineEntry, 'sequence' | 't'>> {
  const beforeById = new Map(beforeAgents.map((agent) => [agent.agentId, agent]));
  const afterById = new Map(afterAgents.map((agent) => [agent.agentId, agent]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  const transitions: Array<Omit<DebugTimelineEntry, 'sequence' | 't'>> = [];

  for (const agentId of ids) {
    const before = beforeById.get(agentId);
    const after = afterById.get(agentId);
    if (!after) continue;

    const beforeAnomaly = before?.anomaly ?? null;
    const afterAnomaly = after.anomaly ?? null;
    if (!beforeAnomaly && afterAnomaly) {
      transitions.push(findingTransition(agentId, 'created', after));
    } else if (beforeAnomaly && !afterAnomaly) {
      transitions.push(findingTransition(agentId, 'cleared', after, before));
    } else if (
      beforeAnomaly
      && afterAnomaly
      && (beforeAnomaly.type !== afterAnomaly.type || beforeAnomaly.severity !== afterAnomaly.severity)
    ) {
      transitions.push(findingTransition(agentId, 'changed', after, before));
    }

    if (!before?.snoozedUntil && after.snoozedUntil) {
      transitions.push(findingTransition(agentId, 'snoozed', after, before));
    } else if (before?.snoozedUntil && !after.snoozedUntil) {
      transitions.push(findingTransition(agentId, 'restored', after, before));
    }

    if (!before?.suppressed && after.suppressed) {
      transitions.push(findingTransition(agentId, 'suppressed', after, before));
    } else if (before?.suppressed && !after.suppressed) {
      transitions.push(findingTransition(agentId, 'unsuppressed', after, before));
    }
  }

  return transitions;
}

function findingTransition(
  agentId: string,
  transition: string,
  after: AgentState,
  before?: AgentState,
): Omit<DebugTimelineEntry, 'sequence' | 't'> {
  const anomaly = after.anomaly ?? before?.anomaly ?? null;
  return {
    kind: 'finding-lifecycle',
    summary: `finding ${agentId}: ${transition}${anomaly ? ` ${anomaly.type} (${anomaly.severity})` : ''}`,
    tags: ['finding', agentId, transition, ...(anomaly ? [anomaly.type, anomaly.severity] : [])],
    payload: {
      agentId,
      taskId: after.taskId ?? before?.taskId,
      transition,
      before: findingSnapshot(before),
      after: findingSnapshot(after),
    },
  };
}

function findingSnapshot(agent: AgentState | undefined): Record<string, unknown> | null {
  if (!agent) return null;
  return {
    agentId: agent.agentId,
    taskId: agent.taskId,
    anomalyType: agent.anomaly?.type ?? null,
    anomalySeverity: agent.anomaly?.severity ?? null,
    snoozed: Boolean(agent.snoozedUntil),
    suppressed: Boolean(agent.suppressed),
    taskStatus: agent.taskStatus,
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function cloneEntry(entry: DebugTimelineEntry): DebugTimelineEntry {
  return {
    ...entry,
    tags: [...entry.tags],
    payload: cloneJsonLike(entry.payload),
  };
}

function cloneJsonLike(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return '[unserializable]';
  }
}

function messageType(value: unknown): string | null {
  if (value && typeof value === 'object' && 'type' in value && typeof (value as { type?: unknown }).type === 'string') {
    return (value as { type: string }).type;
  }
  return null;
}

function fieldNames(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function messageIdentifiers(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.selectedTaskId === 'string' || record.selectedTaskId === null ? { selectedTaskId: record.selectedTaskId } : {}),
    ...(typeof record.selectedSessionId === 'string' || record.selectedSessionId === null ? { selectedSessionId: record.selectedSessionId } : {}),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
