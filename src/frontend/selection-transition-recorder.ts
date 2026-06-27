import type { AgentState } from '../shared/protocol.js';
import { deriveProjectPriorityRanks } from '../shared/project-sidebar.js';
import { buildRoutableOrder } from './agent-priority-order.js';
import { getBugReportWireObservations } from './bug-report-recorder.js';
import type { KookrStore } from './store/store-types.js';
import { track } from './telemetry.js';

const MAX_TRANSITIONS = 100;
const MAX_TRANSITION_AGE_MS = 5 * 60 * 1000;
const FLICKER_WINDOW_MS = 10 * 1000;
const FLICKER_MIN_SWITCHES = 3;
const INCIDENT_RATE_LIMIT_MS = 60 * 1000;
const MAX_RECENT_INCIDENTS = 20;
const MAX_CANDIDATES = 5;
const MAX_RATE_LIMIT_PAIRS = 100;
const MAX_COUNT_MAP_ENTRIES = 10;
const MAX_COUNT_MAP_KEY_LENGTH = 80;
// Cap the per-transition list embedded in the persisted telemetry incident so
// the event stays a few KB even for a long flicker burst. The alternating
// `recent` window is already bounded by FLICKER_WINDOW_MS / MAX_TRANSITIONS;
// this is a second, telemetry-specific guard.
const MAX_TELEMETRY_TRANSITIONS = 50;

export interface SelectionTransitionMeta {
  source: string;
  reason?: string;
}

export interface SelectionTaskSummary {
  agentId: string;
  taskId: string | null;
  sessionId: string;
  status: string | null;
  anomalyType: string | null;
  anomalySeverity: string | null;
  priority: string | null;
  snoozed: boolean;
  suppressed: boolean;
  projectId: string | null;
  coordinatorChip: boolean;
}

export interface SelectionRoutingCandidateSummary {
  agentId: string;
  taskId: string | null;
  sessionId: string;
  status: string | null;
  anomalyType: string | null;
  anomalySeverity: string | null;
  priority: string | null;
  projectId: string | null;
  coordinatorChip: boolean;
  originalIndex: number;
}

export interface SelectionTransitionRecord {
  at: string;
  atMs: number;
  fromTaskId: string | null;
  toTaskId: string | null;
  fromSessionId: string | null;
  toSessionId: string | null;
  source: string;
  reason: string | null;
  selectedProject: string | null;
  autoAdvance: {
    enabled: boolean;
    selectedAgentSource: string;
    lastTickReason: string | null;
  };
  dashboardSelectionVersion: number;
  fromTask: SelectionTaskSummary | null;
  toTask: SelectionTaskSummary | null;
  routingCandidates: SelectionRoutingCandidateSummary[];
}

export interface SelectionFlickerIncidentSummary {
  incidentId: string;
  pairKey: string;
  taskIds: string[];
  sessionIds: string[];
  firstAt: string;
  lastAt: string;
  switchCount: number;
  switchesPerSecond: number;
  sourceCounts: Record<string, number>;
  firstTaskStates: {
    from: SelectionTaskSummary | null;
    to: SelectionTaskSummary | null;
  };
  lastTaskStates: {
    from: SelectionTaskSummary | null;
    to: SelectionTaskSummary | null;
  };
  websocketMessageCounts: Record<string, number>;
  droppedTransitionCount: number;
}

export interface SelectionTransitionDiagnostics {
  transitions: SelectionTransitionRecord[];
  flickerIncidents: SelectionFlickerIncidentSummary[];
}

let activeMeta: SelectionTransitionMeta | null = null;
let transitions: SelectionTransitionRecord[] = [];
let incidents: SelectionFlickerIncidentSummary[] = [];
const rateLimitByPair = new Map<string, { lastEmittedAtMs: number; suppressedCount: number }>();

export function withSelectionTransitionSource<T>(meta: SelectionTransitionMeta, fn: () => T): T {
  if (activeMeta) return fn();
  activeMeta = meta;
  try {
    return fn();
  } finally {
    activeMeta = null;
  }
}

export function recordSelectionTransitionFromStore(
  before: KookrStore,
  after: KookrStore,
  changedKeys: string[],
  nowMs = Date.now(),
): void {
  const beforeSelection = selectedIdentity(before);
  const afterSelection = selectedIdentity(after);
  if (
    beforeSelection.taskId === afterSelection.taskId
    && beforeSelection.sessionId === afterSelection.sessionId
  ) {
    return;
  }

  const meta = activeMeta ?? inferTransitionMeta(changedKeys);
  const record: SelectionTransitionRecord = {
    at: new Date(nowMs).toISOString(),
    atMs: nowMs,
    fromTaskId: beforeSelection.taskId,
    toTaskId: afterSelection.taskId,
    fromSessionId: beforeSelection.sessionId,
    toSessionId: afterSelection.sessionId,
    source: meta.source,
    reason: meta.reason ?? null,
    selectedProject: after.selectedProject,
    autoAdvance: {
      enabled: after.autoAdvanceEnabled,
      selectedAgentSource: after.selectedAgentSource,
      lastTickReason: after.lastTickReason,
    },
    dashboardSelectionVersion: after.dashboardSelection.selectionVersion,
    fromTask: beforeSelection.agent ? summarizeTask(beforeSelection.agent, before) : null,
    toTask: afterSelection.agent ? summarizeTask(afterSelection.agent, after) : null,
    routingCandidates: summarizeRoutingCandidates(after),
  };

  transitions.push(record);
  pruneTransitions(nowMs);
  pruneRateLimitPairs(nowMs);
  maybeEmitFlickerIncident(record, nowMs);
}

export function getSelectionTransitionDiagnostics(): SelectionTransitionDiagnostics {
  pruneTransitions(Date.now());
  return {
    transitions: transitions.map(cloneTransition),
    flickerIncidents: incidents.map(cloneIncident),
  };
}

export function __resetSelectionTransitionRecorderForTests(): void {
  activeMeta = null;
  transitions = [];
  incidents = [];
  rateLimitByPair.clear();
}

function selectedIdentity(state: KookrStore): {
  agent: AgentState | null;
  taskId: string | null;
  sessionId: string | null;
} {
  const agent = state.selectedAgentId
    ? state.agents.find((candidate) => candidate.agentId === state.selectedAgentId) ?? null
    : null;
  return {
    agent,
    taskId: agent?.taskId ?? null,
    sessionId: state.selectedAgentId,
  };
}

function summarizeTask(agent: AgentState, state: Pick<KookrStore, 'coordinator'>): SelectionTaskSummary {
  return {
    agentId: agent.agentId,
    taskId: agent.taskId ?? null,
    sessionId: agent.agentId,
    status: agent.taskStatus ?? null,
    anomalyType: agent.anomaly?.type ?? null,
    anomalySeverity: agent.anomaly?.severity ?? null,
    priority: agent.priority ?? null,
    snoozed: Boolean(agent.snoozedUntil),
    suppressed: Boolean(agent.suppressed),
    projectId: agent.projectId ?? null,
    coordinatorChip: Boolean(agent.taskId && state.coordinator?.chips.some((chip) => chip.taskId === agent.taskId)),
  };
}

function summarizeRoutingCandidates(state: KookrStore): SelectionRoutingCandidateSummary[] {
  const chipTaskIds = new Set((state.coordinator?.chips ?? []).map((chip) => chip.taskId));
  const originalIndex = new Map(state.agents.map((agent, index) => [agent.agentId, index]));
  const ordered = buildRoutableOrder(state.agents, {
    chipTaskIds,
    originalIndex,
    projectPriorityRanks: deriveProjectPriorityRanks(state.projectSummaries, state.projectSidebarPrefs),
  });
  return ordered.slice(0, MAX_CANDIDATES).map((agent) => ({
    agentId: agent.agentId,
    taskId: agent.taskId ?? null,
    sessionId: agent.agentId,
    status: agent.taskStatus ?? null,
    anomalyType: agent.anomaly?.type ?? null,
    anomalySeverity: agent.anomaly?.severity ?? null,
    priority: agent.priority ?? null,
    projectId: agent.projectId ?? null,
    coordinatorChip: Boolean(agent.taskId && chipTaskIds.has(agent.taskId)),
    originalIndex: originalIndex.get(agent.agentId) ?? -1,
  }));
}

function inferTransitionMeta(changedKeys: string[]): SelectionTransitionMeta {
  if (changedKeys.includes('dashboardSelection')) {
    return { source: 'dashboardSelection', reason: 'server_dashboard_selection' };
  }
  if (changedKeys.includes('agents')) {
    return { source: 'serverStateReconcile', reason: 'agents_changed_selected_task' };
  }
  if (changedKeys.includes('selectedProject')) {
    return { source: 'selectProject', reason: 'project_selection_changed_task' };
  }
  return { source: 'storeSelection', reason: changedKeys.sort().join(',') || 'unknown' };
}

function maybeEmitFlickerIncident(record: SelectionTransitionRecord, nowMs: number): void {
  if (!record.fromSessionId || !record.toSessionId || record.fromSessionId === record.toSessionId) return;

  const pairKey = pairIdentity(record);
  const recent = transitions.filter((entry) => (
    entry.fromSessionId
    && entry.toSessionId
    && entry.fromSessionId !== entry.toSessionId
    && pairIdentity(entry) === pairKey
    && nowMs - entry.atMs <= FLICKER_WINDOW_MS
  ));
  if (recent.length < FLICKER_MIN_SWITCHES || !isAlternating(recent)) return;

  const limiter = rateLimitByPair.get(pairKey) ?? { lastEmittedAtMs: 0, suppressedCount: 0 };
  if (limiter.lastEmittedAtMs > 0 && nowMs - limiter.lastEmittedAtMs < INCIDENT_RATE_LIMIT_MS) {
    limiter.suppressedCount += 1;
    rateLimitByPair.set(pairKey, limiter);
    return;
  }

  const first = recent[0];
  const last = recent[recent.length - 1];
  const elapsedMs = Math.max(1, last.atMs - first.atMs);
  const incident: SelectionFlickerIncidentSummary = {
    incidentId: `selection-flicker-${nowMs}-${incidents.length + 1}`,
    pairKey,
    taskIds: uniqueCompact(recent.flatMap((entry) => [entry.fromTaskId, entry.toTaskId])),
    sessionIds: uniqueCompact(recent.flatMap((entry) => [entry.fromSessionId, entry.toSessionId])),
    firstAt: first.at,
    lastAt: last.at,
    switchCount: recent.length,
    switchesPerSecond: Number((recent.length / (elapsedMs / 1000)).toFixed(2)),
    sourceCounts: countBy(recent.map((entry) => entry.source)),
    firstTaskStates: { from: cloneTaskSummary(first.fromTask), to: cloneTaskSummary(first.toTask) },
    lastTaskStates: { from: cloneTaskSummary(last.fromTask), to: cloneTaskSummary(last.toTask) },
    websocketMessageCounts: recentWebSocketCounts(nowMs),
    droppedTransitionCount: limiter.suppressedCount,
  };

  incidents = [...incidents, incident].slice(-MAX_RECENT_INCIDENTS);
  rateLimitByPair.set(pairKey, { lastEmittedAtMs: nowMs, suppressedCount: 0 });
  track(toTelemetryIncident(incident, recent));
}

function isAlternating(entries: SelectionTransitionRecord[]): boolean {
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (current.fromSessionId !== previous.toSessionId || current.toSessionId !== previous.fromSessionId) {
      return false;
    }
  }
  return true;
}

function pairIdentity(record: Pick<SelectionTransitionRecord, 'fromSessionId' | 'toSessionId'>): string {
  return [record.fromSessionId, record.toSessionId].filter(Boolean).sort().join('|');
}

function recentWebSocketCounts(nowMs: number): Record<string, number> {
  const minTime = nowMs - FLICKER_WINDOW_MS;
  const counts: Record<string, number> = {};
  for (const observation of getBugReportWireObservations()) {
    if (new Date(observation.receivedAt).getTime() < minTime) continue;
    const key = observation.type ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function toTelemetryIncident(
  incident: SelectionFlickerIncidentSummary,
  recent: SelectionTransitionRecord[],
): Record<string, unknown> {
  return {
    type: 'selection_flicker_incident',
    pairKey: fingerprint(incident.pairKey),
    firstAt: incident.firstAt,
    lastAt: incident.lastAt,
    switchCount: incident.switchCount,
    switchesPerSecond: incident.switchesPerSecond,
    taskIdCount: incident.taskIds.length,
    sessionIdCount: incident.sessionIds.length,
    sourceCounts: boundedCountMap(incident.sourceCounts),
    websocketMessageCounts: boundedCountMap(incident.websocketMessageCounts),
    droppedTransitionCount: incident.droppedTransitionCount,
    // Identity + per-task context so a recurrence (or a regression after a fix)
    // can be pinned to the exact two tasks without needing a manually-filed
    // bug-report bundle. Self-hosted telemetry, so real ids are intentional.
    taskIds: incident.taskIds,
    sessionIds: incident.sessionIds,
    firstTaskStates: incident.firstTaskStates,
    lastTaskStates: incident.lastTaskStates,
    transitions: recent.slice(-MAX_TELEMETRY_TRANSITIONS).map(toTelemetryTransition),
  };
}

// Compact a transition record for the persisted telemetry incident. Field
// order mirrors SelectionTransitionRecord (task ids before session ids), and
// autoAdvance is spread so the emitted event never aliases a live record (track
// buffers events before serializing — see cloneTransition for the same guard).
function toTelemetryTransition(record: SelectionTransitionRecord): Record<string, unknown> {
  return {
    at: record.at,
    fromTaskId: record.fromTaskId,
    toTaskId: record.toTaskId,
    fromSessionId: record.fromSessionId,
    toSessionId: record.toSessionId,
    source: record.source,
    reason: record.reason,
    selectedProject: record.selectedProject,
    dashboardSelectionVersion: record.dashboardSelectionVersion,
    autoAdvance: { ...record.autoAdvance },
  };
}

function boundedCountMap(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_COUNT_MAP_ENTRIES)
      .map(([key, count]) => [key.slice(0, MAX_COUNT_MAP_KEY_LENGTH), count]),
  );
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `pair-${(hash >>> 0).toString(36)}`;
}

function pruneTransitions(nowMs: number): void {
  const minTime = nowMs - MAX_TRANSITION_AGE_MS;
  transitions = transitions
    .filter((entry) => entry.atMs >= minTime)
    .slice(-MAX_TRANSITIONS);
}

function pruneRateLimitPairs(nowMs: number): void {
  const recentPairs = new Set(transitions.map(pairIdentity).filter(Boolean));
  for (const [pairKey, limiter] of rateLimitByPair.entries()) {
    if (
      !recentPairs.has(pairKey)
      || nowMs - limiter.lastEmittedAtMs > INCIDENT_RATE_LIMIT_MS
    ) {
      rateLimitByPair.delete(pairKey);
    }
  }

  if (rateLimitByPair.size <= MAX_RATE_LIMIT_PAIRS) return;

  const keep = new Set(
    [...rateLimitByPair.entries()]
      .sort((left, right) => right[1].lastEmittedAtMs - left[1].lastEmittedAtMs)
      .slice(0, MAX_RATE_LIMIT_PAIRS)
      .map(([pairKey]) => pairKey),
  );
  for (const pairKey of rateLimitByPair.keys()) {
    if (!keep.has(pairKey)) rateLimitByPair.delete(pairKey);
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function uniqueCompact(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function cloneTransition(record: SelectionTransitionRecord): SelectionTransitionRecord {
  return {
    ...record,
    autoAdvance: { ...record.autoAdvance },
    fromTask: cloneTaskSummary(record.fromTask),
    toTask: cloneTaskSummary(record.toTask),
    routingCandidates: record.routingCandidates.map((candidate) => ({ ...candidate })),
  };
}

function cloneIncident(incident: SelectionFlickerIncidentSummary): SelectionFlickerIncidentSummary {
  return {
    ...incident,
    taskIds: [...incident.taskIds],
    sessionIds: [...incident.sessionIds],
    sourceCounts: { ...incident.sourceCounts },
    firstTaskStates: {
      from: cloneTaskSummary(incident.firstTaskStates.from),
      to: cloneTaskSummary(incident.firstTaskStates.to),
    },
    lastTaskStates: {
      from: cloneTaskSummary(incident.lastTaskStates.from),
      to: cloneTaskSummary(incident.lastTaskStates.to),
    },
    websocketMessageCounts: { ...incident.websocketMessageCounts },
  };
}

function cloneTaskSummary(summary: SelectionTaskSummary | null): SelectionTaskSummary | null {
  return summary ? { ...summary } : null;
}
