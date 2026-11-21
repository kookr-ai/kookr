// Type sidecar for bin/kookr-spawn.js. The runtime file is plain ESM
// JavaScript (same pattern as bin/kookr-status.js) — see that file for
// the behavior contract. This sidecar exists so TypeScript tests in
// src/cli/ can import the helpers without // @ts-expect-error.

export const CLI_VERSION: string;
export const EXIT_OK: 0;
export const EXIT_USER_ERROR: 2;
export const EXIT_NO_SERVER: 3;
export const EXIT_SERVER_ERROR: 4;
export const EXIT_DUPLICATE_BLOCKED: 5;
export const EXIT_WAIT_TIMEOUT: 6;
export const HELP_TEXT: string;

export class UsageError extends Error {}

export interface ParsedArgs {
  prompt: string | null;
  positional: string[];
  cwd: string | null;
  agent: 'claude-code' | 'codex-cli' | 'grok-build' | null;
  effort: string | null;
  model: string | null;
  modelTier: 'small' | null;
  profile: string | null;
  claudeAccount: string | null;
  criteria: string | null;
  dedupe: 'warn' | 'block' | 'skip';
  idempotencyKey: string | null;
  promptFile: string | null;
  parentTaskId: string | null;
  noParentTask: boolean;
  autoCloseOnSignal: boolean | null;
  unattended: boolean;
  playbook: string | null;
  playbookScope: 'project' | 'user' | 'plugin' | null;
  /** #3644: `--param key=value` pairs; null when none were given. */
  playbookParams: Record<string, string> | null;
  json: boolean;
  wait: boolean;
  waitTimeoutSeconds: number | null;
  /** #3928: `--restart-wait <seconds>`; null when not given. */
  restartWaitSeconds: number | null;
  help: boolean;
}

export interface ResolveParentTaskIdInputs {
  args: ParsedArgs;
  env: Record<string, string | undefined>;
}

export interface ResolvePromptInputs {
  args: ParsedArgs;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: Record<string, string | undefined>;
  /** Receives a one-line notice when a playbook launch gives up on silent stdin. */
  warn?: (message: string) => void;
  /** Playbook launches only: ms to wait for the first stdin byte (default 5000). */
  stdinFirstByteTimeoutMs?: number;
}

export type PortEnvParse =
  | { kind: 'unset' }
  | { kind: 'valid'; port: number }
  | { kind: 'invalid'; raw: string };

/**
 * #3928: present only when a planned-restart note was seen while no server
 * answered. `outcome` says how the wait ended.
 */
export interface RestartWaitSummary {
  outcome: 'recovered' | 'stale' | 'limit_reached' | 'cleared';
  waitedMs: number;
  state: 'none' | 'in-progress' | 'stale';
  ageMs: number;
  reason: string | null;
  startedAt: string | null;
}

export type BaseUrlResolution =
  | { kind: 'explicit'; baseUrl: string; restartWait?: RestartWaitSummary }
  | { kind: 'auto'; baseUrl: string; port: number; restartWait?: RestartWaitSummary }
  | { kind: 'ambiguous'; ports: number[] }
  | { kind: 'none'; ports: number[]; attempts: number; restartWait?: RestartWaitSummary }
  | { kind: 'invalid_port'; raw: string };

/** The planned-restart note as bin/kookr-restart-intent.js readRestartIntent returns it. */
export interface RestartIntentRecord {
  schemaVersion: string | null;
  reason: string;
  startedAt: string;
  startedAtMs: number;
  initiator: string | null;
  pid: number | null;
  staleAfterMs: number | null;
  host: string | null;
}

export type LookupRestartIntent = (input: {
  env: Record<string, string | undefined>;
  /** null: the auto-detect ports. */
  port: number | null;
  now: number;
}) => RestartIntentRecord | null;

export interface ResolveBaseUrlDeps {
  env: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Cap on the planned-restart wait; null follows the note's own deadline. */
  restartWaitLimitMs?: number | null;
  /** Default: no lookup, so no wait (kookr signal / kookr issue share this resolver). */
  lookupRestartIntent?: LookupRestartIntent;
}

export const RESTART_PROGRESS_LOG_INTERVAL_MS: number;
export function parseRestartWaitSeconds(raw: string, label: string): number;
export function writeLostLaunchAlert(input: {
  env: Record<string, string | undefined>;
  prompt: string | null;
  cwd: string;
  claimIssue: number | null;
  claimRepo: string | null;
  restartWait: RestartWaitSummary;
  now?: number;
}): { path: string; written: boolean } | { error: string };

export type ProbeWaitBudgetReason = 'default' | 'deploying' | 'recent_restart' | 'env_fallback';

export interface SelectProbeWaitBudgetInput {
  defaultBudgetMs: number;
  /** true/false when status is reachable; null when deploy/status is down. */
  deploying: boolean | null;
  lastRestartAt?: string | null;
  nowMs?: number;
  redeployWaitMsEnv?: string | undefined;
  redeployBudgetMs?: number;
  recentRestartWindowMs?: number;
}

export interface ProbeWaitBudget {
  budgetMs: number;
  reason: ProbeWaitBudgetReason;
}

export interface DeployStatusProbe {
  deploying: boolean;
  lastRestartAt: string | null;
}

export const DEFAULT_REDEPLOY_WAIT_MS: number;
export const DEPLOY_STATUS_TIMEOUT_MS: number;
export const RECENT_RESTART_WINDOW_MS: number;
export const PROBE_TIMEOUT_MS: number;
export const RETRY_DELAY_MS: number;

export interface PostTaskArgs {
  baseUrl: string;
  /** null: a playbook launch with no prompt (#3644); the body omits `prompt`. */
  prompt: string | null;
  cwd: string;
  agent: 'claude-code' | 'codex-cli' | 'grok-build' | null;
  effort?: string | null;
  model?: string | null;
  modelTier?: 'small' | null;
  profile?: string | null;
  claudeAccount?: string | null;
  criteria: string | null;
  disableDedup?: boolean;
  metadataIntent?: 'keep_as_duplicate' | null;
  parentTaskId?: string | null;
  autoCloseOnSignal?: boolean | null;
  idempotencyKey?: string | null;
  unattended?: boolean;
  playbook?: string | null;
  playbookScope?: 'project' | 'user' | 'plugin' | null;
  /** #3644: sent as `playbook.parameterValues`. */
  playbookParams?: Record<string, string> | null;
}
/** The JSON body `POST /api/tasks` receives; shared by the launch path and --dry-run. */
export function buildTaskPostBody(
  args: Partial<Omit<PostTaskArgs, 'baseUrl'>> & { prompt: string | null; cwd: string },
): Record<string, unknown>;

export interface TaskPayload {
  id?: string;
  agentType?: string;
  cwd?: string;
  queued?: boolean;
  /** True when this task was returned as an idempotency-key replay (#1526 Phase B). */
  idempotentReplay?: boolean;
  [k: string]: unknown;
}

/**
 * Parsed 429 backpressure body (#1526 Phase C / C3) — the REST projection of
 * PendingQueueFullError / SpawnBurstLimitError in src/server/launch-service.ts.
 */
export interface BackpressureBody {
  error?: string;
  code?: 'pending_queue_full' | 'spawn_burst_limit' | string;
  capacity?: {
    maxActiveTasks: number;
    active: number;
    free: number;
    byClass: { working: number; finishedAwaitingAck: number; hungSuspect: number; launching: number };
    pendingQueueDepth: number;
    oldestPendingAgeMs: number | null;
    oldestFinishedAwaitingAckAgeMs: number | null;
  };
  maxPendingTasks?: number;
  source?: string;
  limit?: number;
  windowMs?: number;
  retryAfterMs?: number;
  [k: string]: unknown;
}

export type PostTaskResult =
  | { kind: 'created'; task: TaskPayload; queued: boolean }
  | { kind: 'duplicate'; task: TaskPayload }
  | { kind: 'server_error'; status: number; message: string; body?: BackpressureBody | null };

export type WaitResult =
  | { kind: 'completion_ready'; status: string | null; agent: Record<string, unknown> }
  | { kind: 'terminal'; status: string; agent: Record<string, unknown> }
  | { kind: 'timeout' }
  | { kind: 'server_error'; message: string };

export type WaitState =
  | { kind: 'completion_ready'; status: string | null }
  | { kind: 'terminal'; status: string }
  | { kind: 'pending'; status: string | null };

export interface WaitForTaskReadyArgs {
  baseUrl: string;
  taskId: string;
  timeoutMs?: number | null;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface FormatSuccessArgs {
  task: TaskPayload;
  baseUrl: string;
  queued: boolean;
}

export interface FormatDedupArgs {
  task: TaskPayload;
  baseUrl: string;
}

export interface MainDeps {
  /** #3928 test seam: defaults to reading the restart note from local disk. */
  lookupRestartIntent?: LookupRestartIntent;
  /** #3861 test seam: ms a playbook launch waits for the first stdin byte (default 5000). */
  stdinFirstByteTimeoutMs?: number;
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd?: string;
  out?: { log: (msg: string) => void; error: (msg: string) => void };
  err?: { log: (msg: string) => void; error: (msg: string) => void };
  exit?: (code: number) => never | void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function apiAuthHeaders(env?: Record<string, string | undefined>): Record<string, string>;
export function parseArgs(argv: string[]): ParsedArgs;
export function parseMaxBytes(raw: string | undefined): number;
export function parsePortEnv(raw: string | undefined): PortEnvParse;
export function parseRetries(raw: string | undefined): number;
export function parseWaitTimeoutSeconds(raw: string): number;
export function defaultProbeBudgetMs(retries: number, retryDelayMs?: number): number;
export function parseRedeployWaitMs(raw: string | undefined | null): number | null;
export function selectProbeWaitBudget(input: SelectProbeWaitBudgetInput): ProbeWaitBudget;
/**
 * Resolves to null only with --playbook and no prompt source, an empty stdin,
 * or a stdin that sent no byte within `stdinFirstByteTimeoutMs`.
 */
export function resolvePrompt(inputs: ResolvePromptInputs): Promise<string | null>;
export function resolvePromptSource(
  args: ParsedArgs,
  stdin: (NodeJS.ReadableStream & { isTTY?: boolean }) | null | undefined,
): 'prompt-file' | 'argv' | 'stdin' | null;
export function resolveCwd(explicit: string | null, pwd: string): string;
export function probeHealth(baseUrl: string, timeoutMs: number): Promise<boolean>;
export function probeDeployStatus(
  baseUrl: string,
  timeoutMs: number,
): Promise<DeployStatusProbe | null>;
export function probeDeployStatusAny(
  ports?: number[],
  timeoutMs?: number,
): Promise<DeployStatusProbe | null>;
export function resolveBaseUrl(deps: ResolveBaseUrlDeps): Promise<BaseUrlResolution>;
export function resolveParentTaskId(inputs: ResolveParentTaskIdInputs): string | null;
export function postTask(args: PostTaskArgs): Promise<PostTaskResult>;
export function classifyWaitState(agent: Record<string, unknown> | undefined | null): WaitState;
export function waitForTaskReady(args: WaitForTaskReadyArgs): Promise<WaitResult>;
export function formatWaitOutcome(result: WaitResult): string;
export function formatSuccess(args: FormatSuccessArgs): string;
export function formatDedup(args: FormatDedupArgs): string;
/** Renders a 429 backpressure body as a multi-line breakdown, or null when the body is not backpressure-shaped. */
export function formatBackpressure429(body: BackpressureBody | null | undefined): string | null;
export function main(deps?: MainDeps): Promise<void>;
