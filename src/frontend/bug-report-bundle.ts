import type { AgentState, BuildInfo } from '../shared/protocol.js';
import type { BugReportRecordedAlert, BugReportWireObservation } from './bug-report-recorder.js';

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
}

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
  note?: string;
  now?: Date;
  location?: Pick<Location, 'hostname' | 'protocol' | 'pathname'>;
  navigatorInfo?: Pick<Navigator, 'userAgent' | 'platform' | 'language'>;
  viewport?: { width: number; height: number };
}

const HARD_SIZE_LIMIT_BYTES = 1_000_000;
const MAX_TEXT = 240;

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
    bundle.alerts = bundle.alerts.slice(-5);
    bundle.captureDiagnostics.truncationApplied = true;
    bundle.captureDiagnostics.warnings.push('Bundle exceeded hard size cap; wire observations and older alerts were truncated.');
  }
  serialized = serialize(bundle);
  bundle.captureDiagnostics.bundleSizeBytes = byteLength(serialized);
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
