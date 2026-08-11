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

export interface CapacityByClassHealthLike {
  working?: number;
  finishedAwaitingAck?: number;
  hungSuspect?: number;
  launching?: number;
}

export interface CapacityHealthLike {
  maxActiveTasks?: number;
  active?: number;
  free?: number;
  byClass?: CapacityByClassHealthLike;
  effectiveWorking?: number;
  phantomActive?: number;
  utilizationPct?: number;
  effectiveUtilizationPct?: number;
  freeForGeneralSources?: number;
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
  /** Process-lifetime first-hook miss reaps (issue #2036 / #2235). */
  firstHookMissTotal?: number;
  capacity?: CapacityHealthLike;
  providerPausedOccupancy?: {
    count?: number;
    oldestPauseAgeMs?: number | null;
    reclaimAttempted?: number;
    reclaimedTotal?: number;
  };
  /** Non-critical timer pause gate (issue #1785 / #2230). */
  nonCriticalTimerPause?: {
    paused?: boolean;
    thresholdMs?: number;
    lastEventLoopDelayP95Ms?: number | null;
    pausedTicksTotal?: number;
  };
  /** Process-lifetime hungSuspect TTL reclaim gauges (issue #1989 / #2229). */
  hungSuspectTtlReclaim?: {
    reclaimedTotal?: number;
    reclaimAttempted?: number;
    reclaimSucceeded?: number;
    skippedNoLiveness?: number;
    skippedOpenPrFailsafe?: number;
    /** Split of open-PR failsafe (issue #2228): confirmed hold. */
    skippedOpenPrConfirmed?: number;
    /** Split of open-PR failsafe (issue #2228): unknown/unwired hold. */
    skippedOpenPrUnknown?: number;
    skippedUnderTtl?: number;
    skippedExemptAnomaly?: number;
    skippedProviderPaused?: number;
    lastCandidatesConsidered?: number;
    lastOutcomes?: ReadonlyArray<{ taskId?: string; outcome?: string }>;
    lastAttemptedTaskIds?: ReadonlyArray<string>;
  };
}

export interface FirstHookMissSummary {
  firstHookMissTotal: number;
}

export interface CapacityByClassSummary {
  working: number;
  finishedAwaitingAck: number;
  hungSuspect: number;
  launching: number;
}

export interface CapacitySummary {
  maxActiveTasks: number;
  active: number;
  free: number;
  effectiveWorking: number;
  phantomActive: number;
  utilizationPct: number;
  effectiveUtilizationPct: number;
  byClass: CapacityByClassSummary;
  freeForGeneralSources?: number;
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

export interface ProviderPausedOccupancySummary {
  count: number;
  oldestPauseAgeMs: number | null;
  reclaimAttempted: number;
  reclaimedTotal: number;
}

export interface NonCriticalTimerPauseSummary {
  paused: boolean;
  thresholdMs: number;
  lastEventLoopDelayP95Ms: number | null;
  pausedTicksTotal: number;
}

/** Slim hungSuspect TTL reclaim residual (issue #2229). Elevated only. */
export interface HungSuspectTtlReclaimSummary {
  reclaimedTotal: number;
  reclaimAttempted: number;
  skippedNoLiveness: number;
  skippedOpenPrFailsafe: number;
  skippedOpenPrConfirmed: number;
  skippedOpenPrUnknown: number;
  skippedUnderTtl: number;
  skippedExemptAnomaly: number;
  skippedProviderPaused: number;
  lastCandidatesConsidered: number;
  /** capacity.byClass.hungSuspect when present on the same health payload. */
  hungSuspect?: number;
  /**
   * Last-pass residual class counts derived from lastOutcomes (outcome → n).
   * Omitted when lastOutcomes is empty/absent so --json stays quiet.
   */
  residualClasses?: Record<string, number>;
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
export function summarizeFirstHookMiss(
  health: HealthLike,
): FirstHookMissSummary | null;
export function summarizeCapacity(
  health: HealthLike,
): CapacitySummary | null;
export function formatUtilPct(pct: number): string;
export function summarizeProviderPausedOccupancy(
  health: HealthLike,
): ProviderPausedOccupancySummary | null;
export function summarizeNonCriticalTimerPause(
  health: HealthLike,
): NonCriticalTimerPauseSummary | null;
export function summarizeHungSuspectTtlReclaim(
  health: HealthLike,
): HungSuspectTtlReclaimSummary | null;
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
