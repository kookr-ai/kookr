// Type sidecar for bin/kookr-status.js so TypeScript tests can import its
// helpers without a // @ts-expect-error suppression. The runtime file is plain
// ESM JavaScript (no build step, no deps) — see bin/kookr-status.js.

export type Severity = 'critical' | 'warning' | 'info';
export type FailOnSeverity = Severity | 'none';

export interface Finding {
  agentId: string;
  taskName: string;
  type: string;
  severity: string;
  explanation: string;
}

export interface Summary {
  statusCounts: Record<string, number>;
  severityCounts: Record<Severity, number>;
  findings: Finding[];
  totalCost: number;
}

export interface AgentLike {
  agentId: string;
  taskName?: string;
  taskStatus?: string;
  snoozedUntil?: number | null;
  suppressed?: boolean;
  tokenUsage?: { costUsd?: number };
  anomaly?: {
    type: string;
    severity: string;
    explanation: string;
  } | null;
}

export interface PipelineStarvationHealthRepoLike {
  repo?: string;
  consecutiveBlockedEmpty?: number;
  effectiveScoutCooldownMs?: number;
}

export interface StaleProcessClassHealthLike {
  count?: number;
  rssBytes?: number;
}

export interface HealthLike {
  status?: string;
  serverStartedAt?: string;
  build?: { version?: string };
  pipelineStarvation?: {
    schemaVersion?: string;
    repos?: Record<string, PipelineStarvationHealthRepoLike>;
  };
  staleProcesses?: {
    dtach?: StaleProcessClassHealthLike;
    relayServer?: StaleProcessClassHealthLike;
  };
  payloadDiet?: {
    trackedTasks?: number;
    terminalTasks?: number;
    lastSnapshotBytes?: number | null;
  };
}

export interface PipelineStarvationSummaryRow {
  repo: string;
  consecutiveBlockedEmpty: number;
  effectiveScoutCooldownMs: number;
}

export interface PipelineStarvationSummary {
  elevated: number;
  repos: PipelineStarvationSummaryRow[];
}

export interface StaleProcessClassSummary {
  count: number;
  rssBytes: number;
}

export interface StaleProcessesSummary {
  dtach?: StaleProcessClassSummary;
  relayServer?: StaleProcessClassSummary;
}

export interface PayloadDietSummary {
  trackedTasks: number;
  terminalTasks: number;
  lastSnapshotBytes: number | null;
}

export interface RenderReportArgs {
  port: number;
  health: HealthLike;
  agents: AgentLike[];
}

export type PortResolution =
  | { kind: 'explicit'; port: number }
  | { kind: 'auto'; port: number }
  | { kind: 'invalid'; raw: string | undefined }
  | { kind: 'none' };

export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  exit?: (code: number) => never | void;
}

export function formatUptime(ms: number): string;
export function formatCost(usd: number): string;
export function formatRss(bytes: number): string;
export function isActiveFinding(agent: AgentLike): boolean;
export function summarize(agents: AgentLike[]): Summary;
export function hasFindingsAtOrAbove(summary: Summary, failOn: FailOnSeverity): boolean;
export function highestKnownSeverity(summary: Summary): Severity | null;
export function summarizePipelineStarvation(
  health: HealthLike,
): PipelineStarvationSummary | null;
export function summarizeStaleProcesses(
  health: HealthLike,
): StaleProcessesSummary | null;
export function summarizePayloadDiet(
  health: HealthLike,
): PayloadDietSummary | null;
export function renderReport(args: RenderReportArgs): string;
export function parseStatusArgs(argv: string[]): {
  help: boolean;
  json: boolean;
  failOn: FailOnSeverity;
  error?: string;
};
export function parsePortEnv(
  raw: string | undefined,
): { kind: 'unset' } | { kind: 'valid'; port: number } | { kind: 'invalid'; raw: string };
export function resolvePort(env?: Record<string, string | undefined>): Promise<PortResolution>;
export function main(deps?: MainDeps): Promise<void>;
export function apiAuthHeaders(env?: Record<string, string | undefined>): Record<string, string>;
export const HELP_TEXT: string;
