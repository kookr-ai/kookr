import type { AgentState } from '../shared/protocol.js';

export type DebugTimelineKind = 'websocket' | 'store' | 'finding-lifecycle' | 'longtask';
export type DebugTimelineDirection = 'inbound' | 'outbound';
export type LongTaskSource = 'snapshot-apply' | 'xterm-write' | 'browser-longtask';

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
/** Matches the Long Task API threshold; samples below this are discarded. */
export const LONG_TASK_THRESHOLD_MS = 50;

type Listener = () => void;

let nextSequence = 1;
let enabledOverride: boolean | null = null;
let longTaskObserverOverride: boolean | null = null;
let longTaskObserver: PerformanceObserver | null = null;
let longTaskObserverStarted = false;
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

/**
 * Long-task sampling is always on for measured spans (threshold-gated).
 * PerformanceObserver is optional: enabled with the debug timeline, or via
 * `?longtask=1` / localStorage `kookr-longtask-telemetry=1`.
 */
export function isLongTaskObserverEnabled(): boolean {
  if (longTaskObserverOverride !== null) return longTaskObserverOverride;
  if (isDebugTimelineEnabled()) return true;
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('longtask') === '1' || window.localStorage?.getItem('kookr-longtask-telemetry') === '1';
  } catch {
    return false;
  }
}

export function setLongTaskObserverEnabledForTests(enabled: boolean | null): void {
  longTaskObserverOverride = enabled;
}

export function subscribeDebugTimeline(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDebugTimelineEntries(): DebugTimelineEntry[] {
  return timelineBuffer.entries().map(cloneEntry);
}

export function getLongTaskTimelineEntries(): DebugTimelineEntry[] {
  return getDebugTimelineEntries().filter((entry) => entry.kind === 'longtask');
}

export function clearDebugTimeline(): void {
  timelineBuffer.clear();
  nextSequence = 1;
  emit();
}

/**
 * Record a main-thread jank sample when duration meets the Long Task threshold.
 * Always sampled (not gated by the full debug timeline flag) so bug reports
 * capture UI freezes without secret env flags.
 */
export function recordMeasuredDuration(
  source: LongTaskSource,
  durationMs: number,
  extra?: { byteLength?: number; agentCount?: number; name?: string },
): void {
  if (!Number.isFinite(durationMs) || durationMs < LONG_TASK_THRESHOLD_MS) return;
  const rounded = Math.round(durationMs * 100) / 100;
  recordDebugTimelineEntry({
    kind: 'longtask',
    summary: `longtask ${source}: ${Math.round(rounded)}ms`,
    tags: ['longtask', source],
    payload: {
      source,
      durationMs: rounded,
      ...(typeof extra?.byteLength === 'number' ? { byteLength: extra.byteLength } : {}),
      ...(typeof extra?.agentCount === 'number' ? { agentCount: extra.agentCount } : {}),
      ...(typeof extra?.name === 'string' ? { name: extra.name } : {}),
    },
  });
}

/** Time a synchronous critical path and sample if it exceeds the long-task threshold. */
export function measureSync<T>(
  source: Exclude<LongTaskSource, 'browser-longtask'>,
  fn: () => T,
  extra?: { byteLength?: number; agentCount?: number },
): T {
  const now = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();
  const start = now();
  try {
    return fn();
  } finally {
    recordMeasuredDuration(source, now() - start, extra);
  }
}

/** Best-effort PerformanceObserver('longtask'); no-op when unsupported or disabled. */
export function ensureLongTaskObserverStarted(): void {
  if (longTaskObserverStarted) return;
  longTaskObserverStarted = true;
  if (!isLongTaskObserverEnabled()) return;
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
    if (Array.isArray(supported) && !supported.includes('longtask')) return;
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordMeasuredDuration('browser-longtask', entry.duration, {
          name: entry.name || undefined,
        });
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
  } catch {
    longTaskObserver = null;
  }
}

export function stopLongTaskObserverForTests(): void {
  longTaskObserver?.disconnect();
  longTaskObserver = null;
  longTaskObserverStarted = false;
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
