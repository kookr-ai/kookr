// src/server/prod-smoke.ts — post-deploy smoke suite core (issues #1592, #1593).
//
// This module holds the *reusable* smoke-suite logic. It is consumed by two
// callers:
//
//   1. scripts/prod-smoke.ts — the post-deploy CLI gate invoked at the end of
//      scripts/prod-restart.sh (issue #1592). Runs once, exits non-zero on any
//      failure so the deploy command surfaces the problem.
//   2. src/server/prod-smoke-tick.ts — the hourly in-process liveness tick that
//      runs the same bounded checks against the live prod instance on a
//      schedule and files/updates an operational alert artifact (issue #1593),
//      so a wedge that develops *while the server runs* is caught within an
//      hour instead of sitting undetected (the #1543 /api/health hang ran ~21h
//      before a human found it).
//
// The suite validates the things the startup health gate cannot see:
//
//   1. /api/ready responds within a bound (no hang; degraded 503 is tolerated)
//   2. /api/health responds within a bound (the #1543 regression was a hung
//      /api/health)
//   3. /api/tasks?limit=1 responds under a latency-sanity bound
//   4. every adapter version the server logged at boot is semver-shaped or the
//      literal "unknown" — never `--help` usage text
//   5. the outgoing server did not go silent for an unexplained multi-hour
//      window before this deploy (deploy-gate only; the hourly tick skips this
//      because there is no pre-deploy anchor for a running instance)
//
// Every check is bounded by its own timeout so the suite can never hang its
// caller (a deploy, or a server tick).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Pure check logic (unit-tested in src/server/prod-smoke.test.ts).
// ---------------------------------------------------------------------------

/**
 * A version string reported by the running server is acceptable iff it is the
 * literal `unknown` or is semver-shaped (1–3 dot-separated numeric groups with
 * an optional pre-release suffix, e.g. `1.2.3`, `0.145.0-alpha.4`). Anything
 * else — most importantly `--help` usage text that leaked through the probe
 * fallback — fails. Mirrors the accepted output space of
 * `src/adapters/probe-agent-binary.ts`'s `extractVersion`.
 */
export function isValidAdapterVersion(version: string): boolean {
  const trimmed = version.trim();
  if (trimmed === 'unknown') return true;
  return /^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]+)?$/.test(trimmed);
}

export interface AdapterVersionEntry {
  agentType: string;
  version: string;
}

/**
 * Strip the preflight probe suffix that `agent-preflight.ts` appends after the
 * version (` probe=--version`, ` probe=--help`, …). Without this, a healthy
 * boot line like `version=2.1.220 probe=--version` fails isValidAdapterVersion
 * and the hourly version-probe stays red forever (issue #2030).
 *
 * Only a trailing ` probe=<non-whitespace>` segment is removed — keep the
 * strip narrow so `Usage: …` help-text leakage still fails validation.
 */
export function stripTrailingProbeSuffix(versionField: string): string {
  return versionField.replace(/ probe=\S+\s*$/, '').trim();
}

/**
 * Parse `[startup] adapter=<name> binary=<path> version=<v>` lines out of a
 * server log. The version is everything after `version=` (it may contain
 * spaces — that is precisely the `Usage: ...` failure we want to catch), with
 * a trailing ` probe=…` segment stripped so real preflight log lines validate.
 * When an adapter appears more than once (e.g. a systemd Restart=on-failure
 * loop appends to the same log), the LAST occurrence wins so we judge the
 * current boot.
 */
export function parseAdapterVersionsFromLog(logText: string): AdapterVersionEntry[] {
  const byAdapter = new Map<string, string>();
  const line = /\[startup\] adapter=(\S+) binary=(\S+) version=(.*)$/;
  for (const raw of logText.split('\n')) {
    const match = raw.match(line);
    if (!match) continue;
    byAdapter.set(match[1]!, stripTrailingProbeSuffix(match[3]!));
  }
  return [...byAdapter.entries()].map(([agentType, version]) => ({ agentType, version }));
}

export interface VersionSanityResult {
  ok: boolean;
  checked: number;
  invalid: AdapterVersionEntry[];
}

/** Validate every parsed adapter version; report the offenders. */
export function checkAdapterVersionSanity(entries: AdapterVersionEntry[]): VersionSanityResult {
  const invalid = entries.filter((entry) => !isValidAdapterVersion(entry.version));
  return { ok: invalid.length === 0, checked: entries.length, invalid };
}

export interface LogContinuityResult {
  ok: boolean;
  gapMs: number | null;
  reason?: string;
}

/**
 * A wedged server stops logging. If the outgoing server's log was last written
 * more than `maxGapMs` before this boot, that silence is anomalous — flag it.
 * When the pre-deploy mtime is unavailable (first deploy, systemd path without
 * a rotated generation, or the hourly tick which has no deploy anchor) the
 * check passes: absence of evidence is not evidence.
 */
export function evaluateLogContinuity(input: {
  previousLogMtimeMs: number | null;
  bootTimeMs: number;
  maxGapMs: number;
}): LogContinuityResult {
  const { previousLogMtimeMs, bootTimeMs, maxGapMs } = input;
  if (previousLogMtimeMs === null || !Number.isFinite(previousLogMtimeMs)) {
    return { ok: true, gapMs: null };
  }
  const gapMs = bootTimeMs - previousLogMtimeMs;
  if (gapMs <= maxGapMs) return { ok: true, gapMs };
  return {
    ok: false,
    gapMs,
    reason:
      `outgoing server log went silent for ${formatDuration(gapMs)} before this boot ` +
      `(threshold ${formatDuration(maxGapMs)}) — a wedged server stops logging`,
  };
}

/** True iff `durationMs` is within the inclusive latency bound. */
export function isWithinLatencyBound(durationMs: number, boundMs: number): boolean {
  return durationMs <= boundMs;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${minutes}m${rem.toString().padStart(2, '0')}s`;
}

// ---------------------------------------------------------------------------
// Check-result model + alert artifact.
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs?: number;
}

export const ALERT_SCHEMA_VERSION = 'prod-smoke-alert.v1';

export interface AlertArtifact {
  schemaVersion: typeof ALERT_SCHEMA_VERSION;
  status: 'ok' | 'alert';
  generatedAt: string;
  failingChecks: string[];
  checks: CheckResult[];
  /**
   * ISO timestamp when the current *consecutive* failing streak began (issue
   * #1593). Only present while `status === 'alert'`. Preserved across
   * successive failing ticks by {@link mergeAlertArtifact} so an operator can
   * see how long the wedge has persisted, and so repeated failures update one
   * artifact instead of resetting it every tick. Absent on the deploy-gate
   * writer (single-shot), populated by the hourly tick.
   */
  firstFailedAt?: string;
  /**
   * Number of consecutive failing runs ending with this one (issue #1593).
   * `0` (or absent) when healthy; `1` on the first failure of a streak,
   * incremented by {@link mergeAlertArtifact} on each subsequent failing tick.
   */
  consecutiveFailures?: number;
}

export function buildAlertArtifact(checks: CheckResult[], generatedAt: string): AlertArtifact {
  const failing = checks.filter((c) => !c.ok);
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    status: failing.length === 0 ? 'ok' : 'alert',
    generatedAt,
    failingChecks: failing.map((c) => c.name),
    checks,
  };
}

/**
 * Fold a freshly-built artifact into the previously-persisted one so a run of
 * consecutive failures updates ONE artifact rather than spamming a fresh alert
 * every tick (issue #1593, AC4).
 *
 * - Failing after a failure: carry `firstFailedAt` forward from the prior
 *   streak and increment `consecutiveFailures`.
 * - Failing after health (or with no prior artifact): start a new streak —
 *   `firstFailedAt = next.generatedAt`, `consecutiveFailures = 1`.
 * - Healthy: clear the streak (`consecutiveFailures = 0`, no `firstFailedAt`).
 *
 * Pure; `prev` is whatever {@link readAlertArtifact} returned (null on a
 * missing/unreadable/invalid file).
 */
export function mergeAlertArtifact(prev: AlertArtifact | null, next: AlertArtifact): AlertArtifact {
  if (next.status === 'ok') {
    return { ...next, consecutiveFailures: 0 };
  }
  const prevWasAlert = prev?.status === 'alert';
  const firstFailedAt = prevWasAlert ? prev.firstFailedAt ?? prev.generatedAt : next.generatedAt;
  const priorCount = prevWasAlert ? prev.consecutiveFailures ?? 1 : 0;
  return {
    ...next,
    firstFailedAt,
    consecutiveFailures: priorCount + 1,
  };
}

/**
 * Read and validate a previously-persisted alert artifact. Returns null on any
 * problem (missing file, unreadable, malformed JSON, wrong shape) — the caller
 * treats "no readable prior artifact" as "no prior streak" and starts fresh.
 * Never throws.
 */
export function readAlertArtifact(path: string): AlertArtifact | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<AlertArtifact>;
    if (candidate.schemaVersion !== ALERT_SCHEMA_VERSION) return null;
    if (candidate.status !== 'ok' && candidate.status !== 'alert') return null;
    if (!Array.isArray(candidate.checks) || !Array.isArray(candidate.failingChecks)) return null;
    return candidate as AlertArtifact;
  } catch {
    return null;
  }
}

/** Write the alert artifact, creating its parent directory. Never throws. */
export function writeAlertArtifact(path: string, artifact: AlertArtifact): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  } catch (err) {
    console.error(`[prod-smoke] failed to write alert artifact ${path}: ${describeErr(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime configuration (env-driven, standalone-runnable defaults).
// ---------------------------------------------------------------------------

export interface SmokeConfig {
  healthUrl: string;
  readyUrl: string;
  tasksUrl: string;
  logFile: string;
  alertPath: string;
  authToken: string | undefined;
  healthMaxTimeMs: number;
  readyMaxTimeMs: number;
  tasksLatencyBoundMs: number;
  maxLogGapMs: number;
  overallTimeoutMs: number;
  previousLogMtimeMs: number | null;
  bootTimeMs: number;
}

function envInt(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function defaultKookrDir(port: string): string {
  return port === '4800' ? join(homedir(), '.kookr') : join(homedir(), `.kookr-${port}`);
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): SmokeConfig {
  const port = env.KOOKR_PORT ?? '4800';
  const base = `http://127.0.0.1:${port}`;
  const kookrDir = env.KOOKR_SMOKE_KOOKR_DIR ?? defaultKookrDir(port);
  const rawPrevMtime = env.KOOKR_SMOKE_PREDEPLOY_LOG_MTIME_MS;
  const previousLogMtimeMs =
    rawPrevMtime !== undefined && rawPrevMtime.trim() !== '' && Number.isFinite(Number(rawPrevMtime))
      ? Number(rawPrevMtime)
      : null;
  // The smoke suite runs seconds after boot, so "now" is a faithful boot anchor
  // for the log-continuity gap measurement — no separate deploy-start timestamp
  // needs threading in from the shell.
  const bootTimeMs = Date.now();

  return {
    healthUrl: env.KOOKR_SMOKE_HEALTH_URL ?? env.KOOKR_HEALTH_URL ?? `${base}/api/health`,
    readyUrl: env.KOOKR_SMOKE_READY_URL ?? env.KOOKR_READY_URL ?? `${base}/api/ready`,
    tasksUrl: env.KOOKR_SMOKE_TASKS_URL ?? `${base}/api/tasks?limit=1`,
    logFile: env.KOOKR_SMOKE_LOG_FILE ?? join(kookrDir, 'server.log'),
    alertPath: env.KOOKR_SMOKE_ALERT_PATH ?? join(kookrDir, 'prod-smoke-alert.json'),
    authToken: env.KOOKR_API_TOKEN,
    healthMaxTimeMs: envInt('KOOKR_SMOKE_HEALTH_MAX_TIME_SECONDS', 10, env) * 1000,
    readyMaxTimeMs: envInt('KOOKR_SMOKE_READY_MAX_TIME_SECONDS', 5, env) * 1000,
    tasksLatencyBoundMs: envInt('KOOKR_SMOKE_TASKS_LATENCY_BOUND_MS', 3000, env),
    maxLogGapMs: envInt('KOOKR_SMOKE_MAX_LOG_GAP_SECONDS', 7200, env) * 1000,
    overallTimeoutMs: envInt('KOOKR_SMOKE_OVERALL_TIMEOUT_SECONDS', 45, env) * 1000,
    previousLogMtimeMs,
    bootTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Individual checks (I/O — exercised via integration tests against stubs).
// ---------------------------------------------------------------------------

function authHeaders(config: SmokeConfig): Record<string, string> {
  return config.authToken ? { authorization: `Bearer ${config.authToken}` } : {};
}

/** Bounded GET that resolves to a status + elapsed time, or throws on timeout. */
async function timedGet(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<{ status: number; durationMs: number }> {
  const startedMs = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers });
  return { status: res.status, durationMs: Date.now() - startedMs };
}

async function checkReady(config: SmokeConfig): Promise<CheckResult> {
  try {
    const { status, durationMs } = await timedGet(config.readyUrl, config.readyMaxTimeMs, authHeaders(config));
    // 503 is a known degraded-but-responsive state (issue #660); the existing
    // post-restart nag only warns on it, so we do not fail — we only fail if
    // the endpoint does not respond within the bound.
    return {
      name: 'ready',
      ok: true,
      detail: `${config.readyUrl} responded ${status} in ${formatDuration(durationMs)}`,
      durationMs,
    };
  } catch (err) {
    return {
      name: 'ready',
      ok: false,
      detail: `${config.readyUrl} did not respond within ${formatDuration(config.readyMaxTimeMs)}: ${describeErr(err)}`,
    };
  }
}

async function checkHealth(config: SmokeConfig): Promise<CheckResult> {
  try {
    const { status, durationMs } = await timedGet(config.healthUrl, config.healthMaxTimeMs, authHeaders(config));
    if (status >= 500) {
      return { name: 'health', ok: false, detail: `${config.healthUrl} returned ${status}`, durationMs };
    }
    return {
      name: 'health',
      ok: true,
      detail: `${config.healthUrl} responded ${status} in ${formatDuration(durationMs)}`,
      durationMs,
    };
  } catch (err) {
    return {
      name: 'health',
      ok: false,
      detail: `${config.healthUrl} did not respond within ${formatDuration(config.healthMaxTimeMs)}: ${describeErr(err)}`,
    };
  }
}

/** Headroom above the latency bound before the request itself is aborted, so a
 * slow-but-responsive endpoint (fails the bound with a measured time) is
 * distinguished from a hung one (aborts) in the operator alert. */
const TASKS_LATENCY_HEADROOM_MS = 5000;

async function checkTasksLatency(config: SmokeConfig): Promise<CheckResult> {
  const fetchTimeoutMs = config.tasksLatencyBoundMs + TASKS_LATENCY_HEADROOM_MS;
  try {
    const { status, durationMs } = await timedGet(config.tasksUrl, fetchTimeoutMs, authHeaders(config));
    if (status !== 200) {
      return { name: 'tasks-latency', ok: false, detail: `${config.tasksUrl} returned ${status}`, durationMs };
    }
    if (!isWithinLatencyBound(durationMs, config.tasksLatencyBoundMs)) {
      return {
        name: 'tasks-latency',
        ok: false,
        detail: `${config.tasksUrl} responded 200 in ${formatDuration(durationMs)}, exceeding the latency bound of ${formatDuration(config.tasksLatencyBoundMs)}`,
        durationMs,
      };
    }
    return {
      name: 'tasks-latency',
      ok: true,
      detail: `${config.tasksUrl} responded 200 in ${formatDuration(durationMs)} (bound ${formatDuration(config.tasksLatencyBoundMs)})`,
      durationMs,
    };
  } catch (err) {
    return {
      name: 'tasks-latency',
      ok: false,
      detail: `${config.tasksUrl} did not respond within ${formatDuration(fetchTimeoutMs)}: ${describeErr(err)}`,
    };
  }
}

function checkAdapterVersions(config: SmokeConfig): CheckResult {
  let logText: string;
  try {
    logText = readFileSync(config.logFile, 'utf8');
  } catch (err) {
    // No readable log ⇒ nothing to verify. Do not block on a log that has not
    // been written yet (rotation race); report it as passing.
    return {
      name: 'version-probe',
      ok: true,
      detail: `no readable server log at ${config.logFile} (${describeErr(err)}); skipped`,
    };
  }
  const entries = parseAdapterVersionsFromLog(logText);
  const result = checkAdapterVersionSanity(entries);
  if (result.checked === 0) {
    return { name: 'version-probe', ok: true, detail: `no [startup] adapter lines in ${config.logFile}; skipped` };
  }
  if (result.ok) {
    return { name: 'version-probe', ok: true, detail: `${result.checked} adapter version(s) sane` };
  }
  const offenders = result.invalid.map((e) => `${e.agentType}="${e.version}"`).join(', ');
  return { name: 'version-probe', ok: false, detail: `invalid adapter version(s): ${offenders}` };
}

function checkLogContinuity(config: SmokeConfig): CheckResult {
  const result = evaluateLogContinuity({
    previousLogMtimeMs: config.previousLogMtimeMs,
    bootTimeMs: config.bootTimeMs,
    maxGapMs: config.maxLogGapMs,
  });
  if (config.previousLogMtimeMs === null) {
    return { name: 'log-continuity', ok: true, detail: 'no pre-deploy log mtime provided; skipped' };
  }
  if (result.ok) {
    return {
      name: 'log-continuity',
      ok: true,
      detail: `outgoing log silent for ${formatDuration(result.gapMs ?? 0)} (threshold ${formatDuration(config.maxLogGapMs)})`,
    };
  }
  return { name: 'log-continuity', ok: false, detail: result.reason ?? 'log continuity gap exceeded threshold' };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

export async function runSmokeChecks(config: SmokeConfig): Promise<CheckResult[]> {
  const [ready, health, tasks] = await Promise.all([
    checkReady(config),
    checkHealth(config),
    checkTasksLatency(config),
  ]);
  return [ready, health, tasks, checkAdapterVersions(config), checkLogContinuity(config)];
}

function describeErr(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout surfaces as a TimeoutError / AbortError; normalize.
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timed out';
    return err.message;
  }
  return String(err);
}
