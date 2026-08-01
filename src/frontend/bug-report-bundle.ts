import type { AgentState, BuildInfo, SessionHealthSnapshot } from '../shared/protocol.js';
import type { BugReportRecordedAlert, BugReportWireObservation } from './bug-report-recorder.js';
import type { DebugTimelineEntry } from './debug-timeline.js';
import type {
  SelectionFlickerIncidentSummary,
  SelectionRoutingCandidateSummary,
  SelectionTaskSummary,
  SelectionTransitionDiagnostics,
  SelectionTransitionRecord,
} from './selection-transition-recorder.js';

export interface BugReportBundle {
  schemaVersion: 'kookr-bug-report.v1';
  generatedAt: string;
  note?: string;
  triage: BugReportTriage;
  source: BugReportSource;
  redaction: { policy: 'strict-v1'; applied: string[] };
  selection: {
    selectedAgentId: string | null;
    selectedTaskId?: string;
    selectedProjectPresent: boolean;
  };
  selectedAgent: BugReportAgentSnapshot | null;
  fleetSummary: BugReportFleetSummary;
  alerts: BugReportAlert[];
  wireObservations: BugReportWireObservation[];
  selectionDiagnostics: SelectionTransitionDiagnostics;
  debugTimeline: DebugTimelineEntry[];
  captureDiagnostics: BugReportCaptureDiagnostics;
}

export interface BugReportTriage {
  trigger: 'manual' | 'alert';
  primaryAlertId?: string;
  primaryErrorCode?: string;
  suspectedArea: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  summary: string;
}

export interface BugReportSource {
  appVersion: string | null;
  commit: string | null;
  branch: '[redacted branch]' | null;
  buildTimestamp: string | null;
  versionUnavailableReason?: string;
  serverStartedAt: string | null;
  location: { originKind: 'localhost' | 'lan' | 'remote' | 'unknown'; protocol: string; route: string };
  browser: { family: string; platform: string; language: string; viewportBucket: string };
}

export interface BugReportAgentSnapshot {
  agentId: string;
  taskId?: string;
  taskStatus?: string;
  turnState?: string;
  agentType?: string;
  anomaly?: { type: string; subType?: string; severity: string; summary: string };
  cwd: { present: boolean; kind: 'home' | 'temp' | 'workspace' | 'other' | 'unknown' };
  git: { branchPresent: boolean; commitPresent: boolean };
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; totalCostUsd?: number };
  health?: BugReportSessionHealthSnapshot;
}

export type BugReportSessionHealthSnapshot = Omit<SessionHealthSnapshot, 'evidence' | 'coordinatedStall'> & {
  evidence: string[];
  coordinatedStall?: Omit<NonNullable<SessionHealthSnapshot['coordinatedStall']>, 'evidence'> & {
    evidence: string[];
  };
};

export interface BugReportFleetSummary {
  totalAgents: number;
  byTaskStatus: Record<string, number>;
  byAnomalySeverity: Record<string, number>;
}

export interface BugReportAlert {
  id: string;
  recordedAt: string;
  agentId: string;
  severity: string;
  summaryCategory: string;
  hasDetails: boolean;
}

export interface BugReportCaptureDiagnostics {
  warnings: string[];
  omittedSections: string[];
  failures: Array<{ section: string; message: string }>;
  bundleSizeBytes: number;
  sizeLimitBytes: number;
  truncationApplied: boolean;
}

export interface BuildBugReportInput {
  agents: AgentState[];
  selectedAgentId: string | null;
  selectedProject: string | null;
  buildInfo: BuildInfo | null;
  serverStartedAt: string | null;
  alerts: BugReportRecordedAlert[];
  wireObservations: BugReportWireObservation[];
  selectionDiagnostics?: SelectionTransitionDiagnostics;
  debugTimeline?: DebugTimelineEntry[];
  note?: string;
  now?: Date;
  location?: Pick<Location, 'hostname' | 'protocol' | 'pathname'>;
  navigatorInfo?: Pick<Navigator, 'userAgent' | 'platform' | 'language'>;
  viewport?: { width: number; height: number };
}

const HARD_SIZE_LIMIT_BYTES = 1_000_000;
const MAX_TEXT = 240;
const MAX_SELECTION_ID_LENGTH = 120;
const MAX_SELECTION_IDS = 8;
const MAX_SELECTION_COUNT_ENTRIES = 10;
const MAX_SELECTION_COUNT_KEY_LENGTH = 80;

const SECRET_KEY_RE = /^(token|secret|password|authorization|cookie|apikey|api_key|credential|privatekey|accessToken|refreshToken)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+/]{80,}={0,2}\b/g,
];
const HOME_PATH_RE = /\/(?:home|Users)\/[^\s"',)]+/g;
const NON_HOME_ABSOLUTE_PATH_RE = /(?:^|[\s"'(])\/(?:tmp|var|opt|workspace|workspaces|srv|mnt|Volumes)\/[^\s"',)]+/g;
const DEBUG_MESSAGE_TYPES = new Set([
  'snapshot',
  'update',
  'alert',
  'githubUpdate',
  'playbooks',
  'suggestion',
  'projectSummaries',
  'coordinator.snapshot',
  'dashboardSelection',
  'emptyEnterDecision',
  'contributionWarning',
  'achievement:unlocked',
  'achievement:reset:ack',
  'quotaStatus',
  'resourceStatus',
  'circuitBreakerStatus',
  'diagnosticReport',
  'schedules',
  'scheduleFired',
  'workspaceView',
  'workspaceCleanupDetail',
  'workspaceSweepProgress',
  'workspaceSweepComplete',
  'workspaceSweepBusy',
  'ossAttempts',
  'respond',
  'respondAll',
  'directReply',
  'navigate',
  'getNext',
  'selectionChanged',
  'skip',
  'skipAll',
  'snooze',
  'cancelSnooze',
  'launch',
  'completeTask',
  'setTaskFeedback',
  'requestTaskReflect',
  'relaunch',
  'cancelTask',
  'reopenTask',
  'deleteTask',
  'renameTask',
  'setTaskPriority',
  'stop',
  'reflect',
  'listPlaybooks',
  'telemetry',
  'setProjectConfig',
  'clearCompleted',
  'ackTerminatedTask',
  'achievement:reset',
  'achievement:setEnabled',
  'permissionChoice',
  'rearmCircuitBreaker',
  'findingFeedback',
  'missedFinding',
]);

export function buildBugReportBundle(input: BuildBugReportInput): { bundle: BugReportBundle; serialized: string } {
  const warnings: string[] = [];
  const failures: Array<{ section: string; message: string }> = [];
  const omittedSections: string[] = [];
  const now = input.now ?? new Date();
  const selectedAgent = input.agents.find((agent) => agent.agentId === input.selectedAgentId) ?? null;
  const latestAlert = input.alerts.at(-1);

  const bundle: BugReportBundle = {
    schemaVersion: 'kookr-bug-report.v1',
    generatedAt: now.toISOString(),
    ...(input.note?.trim() ? { note: redactText(input.note) } : {}),
    triage: buildTriage(latestAlert),
    source: buildSource(input, warnings),
    redaction: {
      policy: 'strict-v1',
      applied: [
        'free_text_redaction',
        'prompt_and_task_label_redaction',
        'path_redaction',
        'secret_redaction',
        'wire_payload_summarization',
        'debug_trace_redaction',
        'selection_diagnostics_redaction',
        'session_health_redaction',
      ],
    },
    selection: {
      selectedAgentId: input.selectedAgentId,
      ...(selectedAgent?.taskId ? { selectedTaskId: selectedAgent.taskId } : {}),
      selectedProjectPresent: Boolean(input.selectedProject),
    },
    selectedAgent: safeSection('selectedAgent', failures, omittedSections, () => (
      selectedAgent ? toBugReportAgentSnapshot(selectedAgent) : null
    )),
    fleetSummary: safeSection('fleetSummary', failures, omittedSections, () => buildFleetSummary(input.agents)) ?? {
      totalAgents: 0,
      byTaskStatus: {},
      byAnomalySeverity: {},
    },
    alerts: safeSection('alerts', failures, omittedSections, () => input.alerts.slice(-20).map(toBugReportAlert)) ?? [],
    wireObservations: safeSection('wireObservations', failures, omittedSections, () => (
      input.wireObservations.slice(-10).map((event) => ({
        ...event,
        fieldNames: [...event.fieldNames],
        ...(event.shortPreview ? { shortPreview: summarizePreview(event.shortPreview) } : {}),
      }))
    )) ?? [],
    selectionDiagnostics: safeSection('selectionDiagnostics', failures, omittedSections, () => ({
      transitions: (input.selectionDiagnostics?.transitions ?? []).slice(-100).map(toBugReportSelectionTransition),
      flickerIncidents: (input.selectionDiagnostics?.flickerIncidents ?? []).slice(-20).map(toBugReportSelectionIncident),
    })) ?? { transitions: [], flickerIncidents: [] },
    debugTimeline: safeSection('debugTimeline', failures, omittedSections, () => (
      (input.debugTimeline ?? []).slice(-50).map(toBugReportDebugTimelineEntry)
    )) ?? [],
    captureDiagnostics: {
      warnings,
      omittedSections,
      failures,
      bundleSizeBytes: 0,
      sizeLimitBytes: HARD_SIZE_LIMIT_BYTES,
      truncationApplied: false,
    },
  };

  let serialized = serialize(bundle);
  const size = byteLength(serialized);
  bundle.captureDiagnostics.bundleSizeBytes = size;
  if (size > HARD_SIZE_LIMIT_BYTES) {
    bundle.wireObservations = [];
    bundle.debugTimeline = [];
    bundle.selectionDiagnostics = {
      transitions: [],
      flickerIncidents: bundle.selectionDiagnostics.flickerIncidents.slice(-5),
    };
    bundle.alerts = bundle.alerts.slice(-5);
    bundle.captureDiagnostics.truncationApplied = true;
    bundle.captureDiagnostics.warnings.push('Bundle exceeded hard size cap; wire observations, debug timeline, selection transitions, and older alerts were truncated.');
  }
  serialized = serialize(bundle);
  bundle.captureDiagnostics.bundleSizeBytes = byteLength(serialized);
  while (
    bundle.captureDiagnostics.bundleSizeBytes > HARD_SIZE_LIMIT_BYTES
    && bundle.selectionDiagnostics.flickerIncidents.length > 0
  ) {
    bundle.selectionDiagnostics.flickerIncidents.shift();
    bundle.captureDiagnostics.warnings.push('Bundle still exceeded hard size cap; older selection flicker incidents were dropped.');
    serialized = serialize(bundle);
    bundle.captureDiagnostics.bundleSizeBytes = byteLength(serialized);
  }
  if (bundle.captureDiagnostics.bundleSizeBytes > HARD_SIZE_LIMIT_BYTES) {
    bundle.selectionDiagnostics.flickerIncidents = [];
    bundle.captureDiagnostics.warnings.push('Bundle still exceeded hard size cap; selection flicker incidents were dropped.');
    serialized = serialize(bundle);
    bundle.captureDiagnostics.bundleSizeBytes = byteLength(serialized);
  }
  serialized = serialize(bundle);
  return { bundle, serialized };
}

export function toBugReportAgentSnapshot(agent: AgentState): BugReportAgentSnapshot {
  return {
    agentId: agent.agentId,
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    ...(agent.taskStatus ? { taskStatus: agent.taskStatus } : {}),
    ...(agent.turnState ? { turnState: agent.turnState } : {}),
    ...(agent.agentType ? { agentType: agent.agentType } : {}),
    ...(agent.anomaly ? {
      anomaly: {
        type: agent.anomaly.type,
        ...(agent.anomaly.subType ? { subType: agent.anomaly.subType } : {}),
        severity: agent.anomaly.severity,
        summary: redactText(agent.anomaly.explanation),
      },
    } : {}),
    cwd: { present: Boolean(agent.cwd), kind: classifyPath(agent.cwd) },
    git: { branchPresent: Boolean(agent.gitBranch), commitPresent: Boolean(agent.gitCommit) },
    ...(agent.tokenUsage ? {
      tokenUsage: {
        inputTokens: agent.tokenUsage.inputTokens,
        outputTokens: agent.tokenUsage.outputTokens,
        totalTokens: agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens + agent.tokenUsage.cacheReadTokens + agent.tokenUsage.cacheWriteTokens,
        totalCostUsd: agent.tokenUsage.costUsd,
      },
    } : {}),
    ...(agent.sessionHealth ? { health: toBugReportSessionHealth(agent.sessionHealth) } : {}),
  };
}

function toBugReportSessionHealth(health: SessionHealthSnapshot): BugReportSessionHealthSnapshot {
  return {
    schemaVersion: health.schemaVersion,
    sessionId: health.sessionId,
    generatedAt: health.generatedAt,
    restartEpoch: health.restartEpoch,
    classification: health.classification,
    task: { status: health.task.status, turnState: health.task.turnState },
    signals: {
      pty: {
        state: health.signals.pty.state,
        lastProgressAt: health.signals.pty.lastProgressAt,
        ageMs: health.signals.pty.ageMs,
        ringHead: health.signals.pty.ringHead,
      },
      hooks: {
        state: health.signals.hooks.state,
        lastProgressAt: health.signals.hooks.lastProgressAt,
        ageMs: health.signals.hooks.ageMs,
      },
      transcript: {
        state: health.signals.transcript.state,
        lastProgressAt: health.signals.transcript.lastProgressAt,
        ageMs: health.signals.transcript.ageMs,
        present: health.signals.transcript.present,
      },
    },
    backend: {
      transportState: health.backend.transportState,
      attachState: health.backend.attachState,
      recoveryInProgress: health.backend.recoveryInProgress,
      attachGeneration: health.backend.attachGeneration,
      reattachCount: health.backend.reattachCount,
      lastAttachAt: health.backend.lastAttachAt,
    },
    browser: {
      bridgeOpen: health.browser.bridgeOpen,
      lastOpenAt: health.browser.lastOpenAt,
      lastReplayAt: health.browser.lastReplayAt,
      lastLiveByteAt: health.browser.lastLiveByteAt,
      freshBytesAfterReplay: health.browser.freshBytesAfterReplay,
      replayedOnly: health.browser.replayedOnly,
    },
    progress: {
      lastProgressAt: health.progress.lastProgressAt,
      stallAgeMs: health.progress.stallAgeMs,
    },
    evidence: health.evidence.map(redactText),
    ...(health.coordinatedStall ? {
      coordinatedStall: {
        id: health.coordinatedStall.id,
        rootCause: health.coordinatedStall.rootCause,
        detectedAt: health.coordinatedStall.detectedAt,
        sessionIds: [...health.coordinatedStall.sessionIds],
        windowMs: health.coordinatedStall.windowMs,
        restartEpoch: health.coordinatedStall.restartEpoch,
        postRestart: health.coordinatedStall.postRestart,
        evidence: health.coordinatedStall.evidence.map(redactText),
      },
    } : {}),
  };
}

function redactText(value: string): string {
  let text = value;
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrl(url));
  for (const pattern of SECRET_VALUE_PATTERNS) {
    text = text.replace(pattern, '[redacted secret]');
  }
  text = text.replace(HOME_PATH_RE, '[redacted path]');
  text = text.replace(NON_HOME_ABSOLUTE_PATH_RE, (match) => {
    const prefix = /^[\s"'(]/.test(match[0]) ? match[0] : '';
    return `${prefix}[redacted path]`;
  });
  if (text.length > MAX_TEXT) return `${text.slice(0, MAX_TEXT)}... [truncated]`;
  return text;
}

function redactSensitiveValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key)) return '[redacted secret]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(key, entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveValue(entryKey, entryValue),
      ]),
    );
  }
  return value;
}

function buildTriage(alert: BugReportRecordedAlert | undefined): BugReportTriage {
  if (!alert) {
    return {
      trigger: 'manual',
      suspectedArea: 'unknown',
      firstSeenAt: null,
      lastSeenAt: null,
      summary: 'Manual bug report without a captured alert.',
    };
  }
  return {
    trigger: 'alert',
    primaryAlertId: alert.id,
    primaryErrorCode: classifyError(alert.summary, alert.details),
    suspectedArea: classifyArea(alert.summary, alert.details),
    firstSeenAt: alert.recordedAt,
    lastSeenAt: alert.recordedAt,
    summary: alert.summaryCategory,
  };
}

function buildSource(input: BuildBugReportInput, warnings: string[]): BugReportSource {
  const location = input.location ?? (typeof window !== 'undefined' ? window.location : undefined);
  const navigatorInfo = input.navigatorInfo ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const viewport = input.viewport ?? (typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : undefined);
  if (!input.buildInfo?.commitHash) warnings.push('Build commit metadata is unavailable.');
  return {
    appVersion: input.buildInfo?.version ?? null,
    commit: input.buildInfo?.commitHash ?? null,
    branch: input.buildInfo?.branch ? '[redacted branch]' : null,
    buildTimestamp: input.buildInfo?.buildTimestamp ?? null,
    ...(!input.buildInfo?.commitHash ? { versionUnavailableReason: 'build_commit_missing' } : {}),
    serverStartedAt: input.serverStartedAt,
    location: {
      originKind: classifyOrigin(location?.hostname),
      protocol: location?.protocol ?? 'unknown:',
      route: location?.pathname ? redactRoute(location.pathname) : '/',
    },
    browser: {
      family: browserFamily(navigatorInfo?.userAgent ?? ''),
      platform: navigatorInfo?.platform ? redactText(navigatorInfo.platform) : 'unknown',
      language: navigatorInfo?.language ?? 'unknown',
      viewportBucket: viewportBucket(viewport),
    },
  };
}

function buildFleetSummary(agents: AgentState[]): BugReportFleetSummary {
  const byTaskStatus: Record<string, number> = {};
  const byAnomalySeverity: Record<string, number> = {};
  for (const agent of agents) {
    const status = agent.taskStatus ?? 'unknown';
    byTaskStatus[status] = (byTaskStatus[status] ?? 0) + 1;
    const severity = agent.anomaly?.severity ?? 'none';
    byAnomalySeverity[severity] = (byAnomalySeverity[severity] ?? 0) + 1;
  }
  return { totalAgents: agents.length, byTaskStatus, byAnomalySeverity };
}

function toBugReportAlert(alert: BugReportRecordedAlert): BugReportAlert {
  return {
    id: alert.id,
    recordedAt: alert.recordedAt,
    agentId: alert.agentId,
    severity: alert.severity,
    summaryCategory: alert.summaryCategory,
    hasDetails: Boolean(alert.details),
  };
}

function toBugReportSelectionTransition(transition: SelectionTransitionRecord): SelectionTransitionRecord {
  return {
    ...transition,
    fromTaskId: redactNullableSelectionIdentifier(transition.fromTaskId),
    toTaskId: redactNullableSelectionIdentifier(transition.toTaskId),
    fromSessionId: redactNullableSelectionIdentifier(transition.fromSessionId),
    toSessionId: redactNullableSelectionIdentifier(transition.toSessionId),
    selectedProject: redactProjectId(transition.selectedProject),
    autoAdvance: { ...transition.autoAdvance },
    fromTask: toBugReportSelectionTaskSummary(transition.fromTask),
    toTask: toBugReportSelectionTaskSummary(transition.toTask),
    routingCandidates: transition.routingCandidates.slice(0, 5).map(toBugReportSelectionCandidate),
  };
}

function toBugReportSelectionIncident(incident: SelectionFlickerIncidentSummary): SelectionFlickerIncidentSummary {
  return {
    ...incident,
    incidentId: truncateSelectionString(incident.incidentId),
    pairKey: redactPairKey(incident.pairKey),
    taskIds: incident.taskIds.slice(0, MAX_SELECTION_IDS).map(redactSelectionIdentifier),
    sessionIds: incident.sessionIds.slice(0, MAX_SELECTION_IDS).map(redactSelectionIdentifier),
    sourceCounts: boundedSelectionCountMap(incident.sourceCounts),
    firstTaskStates: {
      from: toBugReportSelectionTaskSummary(incident.firstTaskStates.from),
      to: toBugReportSelectionTaskSummary(incident.firstTaskStates.to),
    },
    lastTaskStates: {
      from: toBugReportSelectionTaskSummary(incident.lastTaskStates.from),
      to: toBugReportSelectionTaskSummary(incident.lastTaskStates.to),
    },
    websocketMessageCounts: boundedSelectionCountMap(incident.websocketMessageCounts),
  };
}

function toBugReportSelectionTaskSummary(summary: SelectionTaskSummary | null): SelectionTaskSummary | null {
  return summary ? {
    ...summary,
    agentId: redactSelectionIdentifier(summary.agentId),
    taskId: redactNullableSelectionIdentifier(summary.taskId),
    sessionId: redactSelectionIdentifier(summary.sessionId),
    projectId: redactProjectId(summary.projectId),
  } : null;
}

function toBugReportSelectionCandidate(candidate: SelectionRoutingCandidateSummary): SelectionRoutingCandidateSummary {
  return {
    ...candidate,
    agentId: redactSelectionIdentifier(candidate.agentId),
    taskId: redactNullableSelectionIdentifier(candidate.taskId),
    sessionId: redactSelectionIdentifier(candidate.sessionId),
    projectId: redactProjectId(candidate.projectId),
  };
}

function redactProjectId(value: string | null): string | null {
  return value ? '[redacted project]' : null;
}

function redactPairKey(value: string): string {
  return value ? '[redacted pair]' : '';
}

function redactSelectionIdentifier(value: string): string {
  return value ? '[redacted id]' : '';
}

function redactNullableSelectionIdentifier(value: string | null): string | null {
  return value ? '[redacted id]' : null;
}

function truncateSelectionString(value: string): string {
  return value.slice(0, MAX_SELECTION_ID_LENGTH);
}

function boundedSelectionCountMap(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, MAX_SELECTION_COUNT_ENTRIES)
      .map(([key, count]) => [key.slice(0, MAX_SELECTION_COUNT_KEY_LENGTH), count]),
  );
}

function toBugReportDebugTimelineEntry(event: DebugTimelineEntry): DebugTimelineEntry {
  const payload = safeDebugTimelinePayload(event.kind, event.payload);
  return {
    sequence: event.sequence,
    t: event.t,
    kind: event.kind,
    summary: safeDebugTimelineSummary(event.kind, payload),
    tags: safeDebugTimelineTags(event.kind, payload),
    ...(payload !== undefined ? { payload } : {}),
  };
}

function safeDebugTimelinePayload(kind: DebugTimelineEntry['kind'], payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  switch (kind) {
    case 'websocket':
      return {
        ...(record.direction === 'inbound' || record.direction === 'outbound' ? { direction: record.direction } : {}),
        type: safeDebugMessageType(record.type),
        ...(typeof record.byteLength === 'number' ? { byteLength: record.byteLength } : {}),
        ...(typeof record.parseOk === 'boolean' ? { parseOk: record.parseOk } : {}),
        ...(Array.isArray(record.fieldNames) ? { fieldCount: record.fieldNames.length } : {}),
        identifiers: safeDebugIdentifiers(record.identifiers),
      };
    case 'store':
      return {
        ...(Array.isArray(record.changedKeys) ? { changedKeyCount: record.changedKeys.length } : {}),
        ...(typeof record.agentCountBefore === 'number' ? { agentCountBefore: record.agentCountBefore } : {}),
        ...(typeof record.agentCountAfter === 'number' ? { agentCountAfter: record.agentCountAfter } : {}),
        ...(typeof record.selectedAgentId === 'string' || record.selectedAgentId === null ? { selectedAgentId: record.selectedAgentId } : {}),
      };
    case 'finding-lifecycle':
      return {
        ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
        ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
        ...(typeof record.transition === 'string' ? { transition: record.transition } : {}),
        before: safeFindingDebugSnapshot(record.before),
        after: safeFindingDebugSnapshot(record.after),
      };
    case 'longtask':
      return {
        ...(typeof record.source === 'string' ? { source: record.source } : {}),
        ...(typeof record.durationMs === 'number' ? { durationMs: record.durationMs } : {}),
        ...(typeof record.byteLength === 'number' ? { byteLength: record.byteLength } : {}),
        ...(typeof record.agentCount === 'number' ? { agentCount: record.agentCount } : {}),
        ...(typeof record.name === 'string' ? { name: record.name.slice(0, 80) } : {}),
      };
  }
}

function safeDebugTimelineSummary(kind: DebugTimelineEntry['kind'], payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return kind;
  const record = payload as Record<string, unknown>;
  switch (kind) {
    case 'websocket': {
      const direction = record.direction === 'inbound' || record.direction === 'outbound' ? record.direction : 'unknown';
      const type = typeof record.type === 'string' ? record.type : 'unknown';
      const byteLength = typeof record.byteLength === 'number' ? ` (${record.byteLength} bytes)` : '';
      return `websocket ${direction} ${type}${byteLength}`;
    }
    case 'store': {
      const count = typeof record.changedKeyCount === 'number' ? record.changedKeyCount : 0;
      return `store mutation (${count} keys)`;
    }
    case 'finding-lifecycle': {
      const transition = typeof record.transition === 'string' ? record.transition : 'transition';
      const after = safeFindingDebugSnapshot(record.after);
      const anomalyType = typeof after?.anomalyType === 'string' ? ` ${after.anomalyType}` : '';
      return `finding ${transition}${anomalyType}`;
    }
    case 'longtask': {
      const source = typeof record.source === 'string' ? record.source : 'unknown';
      const durationMs = typeof record.durationMs === 'number' ? Math.round(record.durationMs) : 0;
      return `longtask ${source}: ${durationMs}ms`;
    }
  }
}

function safeDebugTimelineTags(kind: DebugTimelineEntry['kind'], payload: unknown): string[] {
  const tags = ['debug', kind];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return tags;
  const record = payload as Record<string, unknown>;
  if (kind === 'websocket' && typeof record.type === 'string') tags.push(record.type);
  if (kind === 'finding-lifecycle' && typeof record.transition === 'string') tags.push(record.transition);
  if (kind === 'longtask' && typeof record.source === 'string') tags.push(record.source);
  return tags;
}

function safeDebugMessageType(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  return DEBUG_MESSAGE_TYPES.has(value) ? value : 'unknown';
}

function safeDebugIdentifiers(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.selectedTaskId === 'string' || record.selectedTaskId === null ? { selectedTaskId: record.selectedTaskId } : {}),
    ...(typeof record.selectedSessionId === 'string' || record.selectedSessionId === null ? { selectedSessionId: record.selectedSessionId } : {}),
  };
}

function safeFindingDebugSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.anomalyType === 'string' || record.anomalyType === null ? { anomalyType: record.anomalyType } : {}),
    ...(typeof record.anomalySeverity === 'string' || record.anomalySeverity === null ? { anomalySeverity: record.anomalySeverity } : {}),
    ...(typeof record.snoozed === 'boolean' ? { snoozed: record.snoozed } : {}),
    ...(typeof record.suppressed === 'boolean' ? { suppressed: record.suppressed } : {}),
    ...(typeof record.taskStatus === 'string' ? { taskStatus: record.taskStatus } : {}),
  };
}

function safeSection<T>(
  section: string,
  failures: Array<{ section: string; message: string }>,
  omittedSections: string[],
  fn: () => T,
): T | null {
  try {
    return fn();
  } catch (err) {
    failures.push({ section, message: err instanceof Error ? err.message : String(err) });
    omittedSections.push(section);
    return null;
  }
}

function classifyPath(value: string | undefined): BugReportAgentSnapshot['cwd']['kind'] {
  if (!value) return 'unknown';
  if (/^\/(?:home|Users)\//.test(value)) return 'home';
  if (/^\/tmp\//.test(value)) return 'temp';
  if (/^\/(?:workspace|workspaces|mnt|Volumes)\//.test(value)) return 'workspace';
  if (value.startsWith('/')) return 'other';
  return 'unknown';
}

function redactUrl(value: string): string {
  try {
    new URL(value);
    return '[redacted url]';
  } catch {
    return '[redacted url]';
  }
}

function summarizePreview(value: string): string {
  return `[redacted preview: ${new TextEncoder().encode(value).byteLength} bytes]`;
}

function redactRoute(value: string): string {
  const path = value.split(/[?#]/, 1)[0] || '/';
  return path === '/' ? '/' : '[redacted route]';
}

function classifyOrigin(hostname: string | undefined): BugReportSource['location']['originKind'] {
  if (!hostname) return 'unknown';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return 'localhost';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return 'lan';
  return 'remote';
}

function browserFamily(userAgent: string): string {
  if (/Firefox/i.test(userAgent)) return 'Firefox';
  if (/Edg\//i.test(userAgent)) return 'Edge';
  if (/Chrome/i.test(userAgent)) return 'Chrome';
  if (/Safari/i.test(userAgent)) return 'Safari';
  return 'unknown';
}

function viewportBucket(viewport: { width: number; height: number } | undefined): string {
  if (!viewport) return 'unknown';
  const width = viewport.width < 768 ? 'mobile' : viewport.width < 1200 ? 'tablet' : 'desktop';
  const height = viewport.height < 700 ? 'short' : 'tall';
  return `${width}-${height}`;
}

function classifyArea(summary: string, details?: string): string {
  const text = `${summary} ${details ?? ''}`.toLowerCase();
  if (text.includes('websocket') || text.includes('ws')) return 'websocket';
  if (text.includes('github')) return 'github';
  if (text.includes('terminal')) return 'terminal';
  if (text.includes('settings')) return 'settings';
  return 'unknown';
}

function classifyError(summary: string, details?: string): string {
  const text = `${summary} ${details ?? ''}`.toLowerCase();
  if (text.includes('malformed websocket')) return 'malformed_websocket_message';
  if (text.includes('schema validation')) return 'schema_validation_failed';
  if (text.includes('parse')) return 'parse_failed';
  return 'unknown';
}

function serialize(bundle: BugReportBundle): string {
  return JSON.stringify(redactSensitiveValue('bundle', bundle), null, 2);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
