/**
 * `kookr ops` — thin remote-ops verbs over a running Kookr HTTP surface.
 *
 *   kookr ops digest [--json] [--offline]   issue #2347
 *   kookr ops timers [--json]               issue #2639
 *
 * `digest` fetches GET /api/ready + GET /api/health and prints ≤20 lines:
 * ready status plus the top unattended failure signals (with field paths).
 * Issue #2637 also warns on overdue/never-fired hourly timers, hook-ingestion
 * p95 > 10s, and any fail-closed paused schedule. If health has no
 * `timerHealth` object, digest does a 2s GET of /api/diagnostics/timer-health.
 * Exit: 0 when ready, 1 when ready fails. Does not mutate server state.
 *
 * Offline degrade (issue #2495): when the HTTP surface is dark the server can
 * no longer answer /api/health, but it mirrors each successful assembly to
 * `<kookrDir>/last-good-health.json`. `--offline` reads that file directly, and
 * the live path auto-degrades to it when the server is unreachable — either way
 * the digest reports how stale the mirror is instead of just "no server".
 *
 * `timers` fetches GET /api/diagnostics/timer-health (issue #1771) and lists
 * each *registered* lifecycle loop: last-fired or `never`, expected interval,
 * and overdue. It does not invent names the server did not register, and it
 * does not fall back to last-good-health (that snapshot has counts only —
 * issue #2636 — not the per-loop last-fired table).
 * The fetch uses a 5s timeout so a wedged HTTP path fails closed instead of
 * hanging a Discord paste.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLastGoodHealth, type LastGoodHealthRead } from '../server/last-good-health.js';

const PORTS_TO_TRY = [4800, 4801] as const;
/** Health payloads can be large on busy prod instances; keep headroom over status's 2s. */
const REQUEST_TIMEOUT_MS = 8_000;
/**
 * Timer-health is a tiny in-memory snapshot. Five seconds is long enough for a
 * slow box and short enough that a wedged HTTP path does not hang a remote
 * Discord paste (issue #2639).
 */
export const OPS_TIMERS_TIMEOUT_MS = 5_000;
const HEALTH_PATH = '/api/health';
const READY_PATH = '/api/ready';
const TIMER_HEALTH_PATH = '/api/diagnostics/timer-health';
const MAX_WARNINGS = 5;
const MAX_HUMAN_LINES = 20;
/**
 * Hook-ingestion p95 above this is a Lucy-visible stall (issue #2637).
 * Matches the issue's 10s bar — health's own lagWarningThresholdMs is 2s and
 * would flap on a healthy busy box.
 */
export const HOOK_INGESTION_P95_WARN_MS = 10_000;
/** Hourly safety-net loops (maintenance prune, prod smoke, deploy lag, …). */
const HOURLY_INTERVAL_MS = 3_600_000;
/**
 * When `/api/health` has no `timerHealth` object, digest may fetch the
 * diagnostics timer document. Two seconds is long enough for a tiny
 * in-memory snapshot and short enough that a wedged path cannot hang Lucy.
 */
export const OPS_DIGEST_TIMER_FALLBACK_TIMEOUT_MS = 2_000;

export const EXIT_OK = 0;
/** Ready probe failed (HTTP non-200 or body.ready === false). */
export const EXIT_READY_FAIL = 1;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
/**
 * `--offline` requested but no last-good snapshot exists on disk (issue #2495).
 * 6, not 5: exit 5 is reserved across the `kookr` CLI family for the
 * findings-threshold gate (`kookr status --fail-on`), so ops digest skips it.
 */
export const EXIT_NO_SNAPSHOT = 6;

export const OPS_DIGEST_HELP_TEXT = `kookr ops — remote diagnosis verbs (digest, timers).

Usage:
  kookr ops digest [--json] [--offline]
  kookr ops timers [--json]
  kookr ops --help

digest: GET /api/ready and GET /api/health, then print ready status plus the
top unattended failure signals (pressureWhileDisabled, phantomActive, hung
residual, helper-LLM pause, overdue/never-fired hourly timers, hook-ingestion
p95, fail-closed paused schedules, pipeline starvation, disk, safeMode) with
field paths. ≤20 lines.

When the server is unreachable, digest auto-degrades to the last-good
/api/health snapshot on disk (if one exists) and reports how stale it is.

timers: GET /api/diagnostics/timer-health and print each registered lifecycle
loop's last-fired (or never), expected interval, and overdue flag. Does not
invent loop names the server did not register. 5s fetch timeout. --offline
is digest-only.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  --offline    digest only: skip HTTP and read the last-good snapshot (issue #2495).
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT            Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN       Bearer token for non-loopback servers.
  KOOKR_DIR             Kookr state dir holding last-good-health.json (offline path).

Exit codes:
  0  Ready (digest) or timer-health printed (timers) — or offline snapshot printed.
  1  Ready failed (critical not-ready / HTTP 503). Digest only.
  2  User error (bad flags / unknown verb).
  3  No Kookr server reachable (or timers fetch timed out).
  4  Server rejected the request or returned an unexpected payload.
  6  --offline requested but no last-good snapshot exists on disk.
`;

/** Reads the freshest last-good snapshot across candidate state dirs, or null. */
export type OfflineSnapshotLoader = (
  env: NodeJS.ProcessEnv,
  nowMs: number,
) => LastGoodHealthRead | null;

export interface OpsDigestCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Override HTTP fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override last-good snapshot loading (tests). Defaults to on-disk read. */
  offlineLoader?: OfflineSnapshotLoader;
  /** Injectable clock (epoch ms) for staleness math. Defaults to `Date.now`. */
  nowMs?: () => number;
}

interface ResolvedIo {
  env: NodeJS.ProcessEnv;
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  fetchImpl: typeof fetch;
  offlineLoader: OfflineSnapshotLoader;
  nowMs: () => number;
}

export type OpsVerb = 'digest' | 'timers';

export interface ParsedOpsDigestArgs {
  verb: OpsVerb | null;
  json: boolean;
  offline: boolean;
  help: boolean;
  error?: string;
}

export interface OpsTimerLoop {
  name: string;
  lastFiredAt: string | null;
  expectedIntervalMs: number | null;
  overdue: boolean;
}

export interface OpsTimersSnapshot {
  schemaVersion: string | null;
  generatedAt: string | null;
  loops: OpsTimerLoop[];
  /** Names of loops the server marked overdue — never invented locally. */
  overdue: string[];
}

export interface OpsDigestWarning {
  /** Stable field path operators can curl/jq for. */
  path: string;
  /** Short human summary (no secrets). */
  summary: string;
  /** Optional structured value for --json. */
  value?: unknown;
}

export interface OpsDigestSnapshot {
  baseUrl: string;
  ready: boolean;
  readyHttpStatus: number;
  failingCritical: string[];
  warnings: OpsDigestWarning[];
  /** Slim projection of the signals we inspected (present-or-null). */
  signals: {
    pressureWhileDisabled: boolean | null;
    pressureWhileDisabledReason: string | null;
    phantomActive: number | null;
    hungSuspect: number | null;
    pipelineStarvationElevated: number | null;
    diskFreePercent: number | null;
    safeModeEngaged: boolean | null;
    hookIngestionP95LagMs: number | null;
    schedulesPausedByFailure: number | null;
    timerHealthOverdue: number | null;
  };
  serverStartedAt: string | null;
  sha: string | null;
}

export function parseOpsDigestArgs(argv: string[]): ParsedOpsDigestArgs {
  const out: ParsedOpsDigestArgs = { verb: null, json: false, offline: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--offline') {
      out.offline = true;
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'digest' && tok !== 'timers') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = tok;
    } else {
      return { ...out, error: `unexpected argument: ${tok}` };
    }
  }
  return out;
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

function apiAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function describeTarget(env: NodeJS.ProcessEnv): string {
  if (env.KOOKR_API_BASE_URL?.trim()) return env.KOOKR_API_BASE_URL.trim();
  if (env.KOOKR_PORT?.trim()) return `port ${env.KOOKR_PORT.trim()}`;
  return `ports ${PORTS_TO_TRY.join(', ')}`;
}

/**
 * Candidate Kookr state dirs holding `last-good-health.json`. Explicit config is
 * **authoritative** so `--offline` never quotes the wrong instance:
 *  - `KOOKR_DIR` set  → exactly that dir;
 *  - else `KOOKR_PORT` set → exactly the port-derived dir (mirrors start.ts:
 *    port 4800 → `~/.kookr`, any other port → `~/.kookr-<port>`);
 *  - else (auto) → both default-port dirs, and the caller picks the freshest
 *    (they belong to the same box, so newest-by-mtime is the right heuristic).
 */
export function resolveOpsKookrDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const portDir = (port: number): string =>
    port === 4800 ? join(home, '.kookr') : join(home, `.kookr-${port}`);

  const explicit = env.KOOKR_DIR?.trim();
  if (explicit) return [explicit];

  const portRaw = env.KOOKR_PORT?.trim();
  if (portRaw) {
    const port = Number(portRaw);
    // An invalid KOOKR_PORT yields no candidate — the digest's own port
    // validation already reports it on the live path.
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? [portDir(port)] : [];
  }
  return PORTS_TO_TRY.map(portDir);
}

/** Default loader: read the freshest last-good snapshot across candidate dirs. */
export function loadOfflineSnapshot(
  env: NodeJS.ProcessEnv,
  nowMs: number,
): LastGoodHealthRead | null {
  let best: LastGoodHealthRead | null = null;
  for (const dir of resolveOpsKookrDirs(env)) {
    const read = readLastGoodHealth(dir, { now: nowMs });
    if (read && (best === null || read.mtimeMs > best.mtimeMs)) best = read;
  }
  return best;
}

function formatStaleAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** JSON `details` for an offline / degraded envelope — the same signal set as live. */
function offlineDetails(read: LastGoodHealthRead, nowMs?: number): Record<string, unknown> {
  const collected = collectOpsDigestWarnings(read.snapshot.health ?? {}, { nowMs });
  return {
    path: read.path,
    mtimeMs: read.mtimeMs,
    ageMs: read.ageMs,
    capturedAt: read.snapshot.capturedAt,
    truncated: read.snapshot.truncated,
    warnings: collected.warnings,
    signals: collected.signals,
    serverStartedAt: collected.serverStartedAt,
    sha: collected.sha,
  };
}

/**
 * Human render of an offline last-good snapshot, hard-capped at
 * MAX_HUMAN_LINES. Reuses {@link collectOpsDigestWarnings} so the offline
 * digest surfaces the same signal set as the live one — just from a stale body.
 */
export function formatOpsDigestOffline(
  read: LastGoodHealthRead,
  opts?: { nowMs?: number },
): string {
  const { snapshot, ageMs, path } = read;
  const collected = collectOpsDigestWarnings(snapshot.health ?? {}, { nowMs: opts?.nowMs });
  const lines: string[] = [];
  lines.push('ready: UNKNOWN (offline — HTTP dark, showing last-good /api/health)');
  lines.push(`last-good: ${formatStaleAge(ageMs)} stale  captured=${snapshot.capturedAt}`);
  lines.push(`source: ${path}`);
  if (snapshot.truncated) lines.push('note: snapshot trimmed to gauges (size cap)');
  if (collected.serverStartedAt || collected.sha) {
    const parts: string[] = [];
    if (collected.sha) parts.push(`sha=${collected.sha.slice(0, 12)}`);
    if (collected.serverStartedAt) parts.push(`started=${collected.serverStartedAt}`);
    lines.push(`server: ${parts.join('  ')}`);
  }
  if (collected.warnings.length === 0) {
    lines.push('warnings: none');
  } else {
    lines.push(`warnings (${collected.warnings.length}/${MAX_WARNINGS}):`);
    for (const w of collected.warnings) {
      lines.push(`  - ${w.path}: ${w.summary}`);
    }
  }
  if (lines.length > MAX_HUMAN_LINES) {
    return lines.slice(0, MAX_HUMAN_LINES - 1).concat('  … (truncated)').join('\n');
  }
  return lines.join('\n');
}

/**
 * Resolve the running Kookr base URL: KOOKR_API_BASE_URL → KOOKR_PORT →
 * probe 4800/4801 health (same convention as kookr status / kookr github).
 */
export async function resolveOpsDigestBaseUrl(io: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<
  | { kind: 'ok'; baseUrl: string }
  | { kind: 'invalid_port'; raw: string }
  | { kind: 'none' }
> {
  const explicit = io.env.KOOKR_API_BASE_URL?.trim();
  if (explicit) {
    return { kind: 'ok', baseUrl: explicit.replace(/\/+$/, '') };
  }
  const portRaw = io.env.KOOKR_PORT?.trim();
  if (portRaw) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { kind: 'invalid_port', raw: portRaw };
    }
    return { kind: 'ok', baseUrl: `http://127.0.0.1:${port}` };
  }
  for (const port of PORTS_TO_TRY) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await io.fetchImpl(`${base}${HEALTH_PATH}`, {
        headers: apiAuthHeaders(io.env),
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return { kind: 'ok', baseUrl: base };
    } catch {
      // try next port
    }
  }
  return { kind: 'none' };
}

async function fetchJson(
  io: ResolvedIo,
  url: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await io.fetchImpl(url, {
    method: 'GET',
    headers: {
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-ops/node-${process.versions.node}`,
      ...apiAuthHeaders(io.env),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** True when `/api/health` already carries a `timerHealth` object (issue #2637). */
export function healthHasTimerHealthSummary(health: unknown): boolean {
  return asRecord(asRecord(health)?.timerHealth) !== null;
}

/**
 * Fold a diagnostics timer-health snapshot onto a health body so
 * {@link collectOpsDigestWarnings} can read the same `timerHealth` shape
 * whether the server published the summary or we fetched the fallback.
 */
export function mergeTimerHealthFallback(
  health: unknown,
  snap: OpsTimersSnapshot,
): Record<string, unknown> {
  const rec = asRecord(health) ?? {};
  return {
    ...rec,
    timerHealth: {
      overdue: snap.overdue.length,
      oldestOverdueName: snap.overdue[0] ?? null,
      generatedAt: snap.generatedAt,
      loops: snap.loops,
    },
  };
}

function parseReadyBody(body: unknown): {
  ready: boolean;
  failingCritical: string[];
} {
  const o = asRecord(body);
  if (!o) return { ready: false, failingCritical: [] };
  const ready = o.ready === true;
  const checks = asRecord(o.checks);
  const failingCritical: string[] = [];
  if (checks) {
    for (const [name, raw] of Object.entries(checks)) {
      const check = asRecord(raw);
      if (!check) continue;
      if (check.critical === true && check.ready === false) {
        const status = typeof check.status === 'string' ? check.status : 'not-ready';
        failingCritical.push(`${name}:${status}`);
      }
    }
  }
  return { ready, failingCritical };
}

/**
 * Collect the unattended-ops warning set from a health body. Order is
 * severity-ish (safeMode → pressure → phantom → hung → helper-LLM pause →
 * overdue/never-fired hourly timers → hook-ingestion p95 → fail-closed
 * paused schedules → starvation → disk); callers slice to MAX_WARNINGS.
 *
 * `opts.nowMs` is only used when `timerHealth.generatedAt` is missing, to
 * decide whether a never-fired hourly loop is older than its interval.
 */
export function collectOpsDigestWarnings(
  health: unknown,
  opts?: { nowMs?: number },
): {
  warnings: OpsDigestWarning[];
  signals: OpsDigestSnapshot['signals'];
  serverStartedAt: string | null;
  sha: string | null;
} {
  const h = asRecord(health) ?? {};
  const rw = asRecord(h.resourceWatchdog);
  const cap = asRecord(h.capacity);
  const byClass = asRecord(cap?.byClass);
  const safeMode = asRecord(h.safeMode);
  const pipeline = asRecord(h.pipelineStarvation);
  const pipelineRepos = asRecord(pipeline?.repos);
  const serverStartedAt =
    typeof h.serverStartedAt === 'string' ? h.serverStartedAt : null;
  const sha =
    typeof h.sha === 'string'
      ? h.sha
      : typeof h.gitSha === 'string'
        ? h.gitSha
        : null;

  const pressureWhileDisabled =
    typeof rw?.pressureWhileDisabled === 'boolean' ? rw.pressureWhileDisabled : null;
  const pressureWhileDisabledReason =
    typeof rw?.pressureWhileDisabledReason === 'string' ? rw.pressureWhileDisabledReason : null;
  const phantomActive = finiteNumber(cap?.phantomActive);
  const hungSuspect = finiteNumber(byClass?.hungSuspect);
  const safeModeEngaged = typeof safeMode?.engaged === 'boolean' ? safeMode.engaged : null;

  // Disk: health does not always publish free space. Prefer nested sampler /
  // ops-status-shaped keys when present; stay quiet when absent.
  let diskFreePercent: number | null = null;
  const diskCandidates: unknown[] = [
    h.dataDirectoryFreePercent,
    asRecord(h.dataDirectory)?.diskFreePercent,
    asRecord(asRecord(h.host)?.dataDirectory)?.diskFreePercent,
    asRecord(rw?.lastSample)?.diskFreePercent,
  ];
  for (const c of diskCandidates) {
    const n = finiteNumber(c);
    if (n !== null) {
      diskFreePercent = n;
      break;
    }
  }

  let pipelineStarvationElevated: number | null = null;
  const starvationRows: Array<{ repo: string; consecutiveBlockedEmpty: number }> = [];
  if (pipelineRepos) {
    for (const key of Object.keys(pipelineRepos).sort()) {
      const row = asRecord(pipelineRepos[key]);
      if (!row) continue;
      const consecutive = finiteNumber(row.consecutiveBlockedEmpty);
      if (consecutive === null || consecutive <= 0) continue;
      const repo = typeof row.repo === 'string' && row.repo.length > 0 ? row.repo : key;
      starvationRows.push({ repo, consecutiveBlockedEmpty: Math.floor(consecutive) });
    }
    if (starvationRows.length > 0) pipelineStarvationElevated = starvationRows.length;
  }

  const warnings: OpsDigestWarning[] = [];

  if (safeModeEngaged === true) {
    const since = typeof safeMode?.since === 'string' ? safeMode.since : null;
    warnings.push({
      path: 'safeMode.engaged',
      summary: since
        ? `safeMode.engaged=true since=${since}`
        : 'safeMode.engaged=true',
      value: { engaged: true, since },
    });
  }

  if (pressureWhileDisabled === true) {
    const reason = pressureWhileDisabledReason ?? 'host pressure while resourceWatchdog disabled';
    warnings.push({
      path: 'resourceWatchdog.pressureWhileDisabled',
      summary: `resourceWatchdog.pressureWhileDisabled=true — ${reason}`,
      value: {
        pressureWhileDisabled: true,
        pressureWhileDisabledReason: pressureWhileDisabledReason,
      },
    });
  }

  if (phantomActive !== null && phantomActive > 0) {
    warnings.push({
      path: 'capacity.phantomActive',
      summary: `capacity.phantomActive=${Math.floor(phantomActive)}`,
      value: Math.floor(phantomActive),
    });
  }

  if (hungSuspect !== null && hungSuspect > 0) {
    warnings.push({
      path: 'capacity.byClass.hungSuspect',
      summary: `capacity.byClass.hungSuspect=${Math.floor(hungSuspect)} (hung residual)`,
      value: Math.floor(hungSuspect),
    });
  }

  // Helper-LLM provider pause / storm (issue #2641). Secret-free: provider,
  // category, ISO pausedUntil, and the storm-suppression count only.
  const helperLlm = asRecord(h.helperLlm);
  const helperPausedRaw = Array.isArray(helperLlm?.paused) ? helperLlm.paused : [];
  const helperPaused: Array<{ provider: string; model: string; category: string; pausedUntil: string }> = [];
  for (const row of helperPausedRaw) {
    const rec = asRecord(row);
    if (!rec) continue;
    const provider = typeof rec.provider === 'string' ? rec.provider : '';
    if (!provider) continue;
    helperPaused.push({
      provider,
      model: typeof rec.model === 'string' ? rec.model : '',
      // Live pauses are auth-only today; missing category is treated as auth
      // so a stale last-good snapshot still names the outage.
      category: typeof rec.category === 'string' ? rec.category : 'auth',
      pausedUntil: typeof rec.pausedUntil === 'string' ? rec.pausedUntil : '',
    });
  }
  const stormsSuppressed = finiteNumber(helperLlm?.stormsSuppressed);
  if (helperPaused.length > 0 || (stormsSuppressed !== null && stormsSuppressed > 0)) {
    const pauseBits = helperPaused.map((row) => {
      const until = row.pausedUntil ? ` until=${row.pausedUntil}` : '';
      return `${row.provider} category=${row.category}${until}`;
    });
    const stormBit =
      stormsSuppressed !== null && stormsSuppressed > 0
        ? `stormsSuppressed=${Math.floor(stormsSuppressed)}`
        : '';
    const summaryParts = [
      pauseBits.length > 0 ? `helperLlm.paused ${pauseBits.join('; ')}` : '',
      stormBit,
    ].filter((part) => part.length > 0);
    warnings.push({
      path: helperPaused.length > 0 ? 'helperLlm.paused' : 'helperLlm.stormsSuppressed',
      summary: summaryParts.join(' '),
      value: {
        paused: helperPaused,
        stormsSuppressed: stormsSuppressed !== null ? Math.floor(stormsSuppressed) : 0,
      },
    });
  }

  // Timer health (issue #2637): prefer the `/api/health.timerHealth` summary.
  // `overdue >= 1` is the AC. Hourly loops that have never fired and whose
  // server uptime already exceeds their interval are the other Lucy-visible
  // stall (prod hourly safety-nets stay `overdue=false` for two hours).
  const timerHealth = asRecord(h.timerHealth);
  let timerHealthOverdue: number | null = null;
  let oldestOverdueName: string | null = null;
  const neverFiredHourly: string[] = [];
  if (timerHealth) {
    const overdueRaw = finiteNumber(timerHealth.overdue);
    if (overdueRaw !== null && overdueRaw >= 0) {
      timerHealthOverdue = Math.floor(overdueRaw);
    }
    oldestOverdueName =
      typeof timerHealth.oldestOverdueName === 'string' && timerHealth.oldestOverdueName
        ? timerHealth.oldestOverdueName
        : typeof timerHealth.oldestName === 'string' && timerHealth.oldestName
          ? timerHealth.oldestName
          : null;

    const generatedAtMs = parseIsoMs(
      typeof timerHealth.generatedAt === 'string' ? timerHealth.generatedAt : null,
    );
    const startedAtMs = parseIsoMs(serverStartedAt);
    const nowMs = generatedAtMs ?? opts?.nowMs ?? null;
    const uptimeMs =
      startedAtMs !== null && nowMs !== null ? nowMs - startedAtMs : null;

    const overdueFromLoops: string[] = [];
    const loopsRaw = Array.isArray(timerHealth.loops) ? timerHealth.loops : [];
    for (const raw of loopsRaw) {
      const row = asRecord(raw);
      if (!row) continue;
      const name = typeof row.name === 'string' ? row.name : '';
      if (!name) continue;
      if (row.overdue === true) overdueFromLoops.push(name);
      const interval = finiteNumber(row.expectedIntervalMs);
      if (
        row.lastFiredAt == null &&
        interval !== null &&
        interval >= HOURLY_INTERVAL_MS &&
        uptimeMs !== null &&
        uptimeMs >= interval
      ) {
        neverFiredHourly.push(name);
      }
    }
    if (timerHealthOverdue === null && overdueFromLoops.length > 0) {
      timerHealthOverdue = overdueFromLoops.length;
    }
    if (!oldestOverdueName && overdueFromLoops[0]) {
      oldestOverdueName = overdueFromLoops[0];
    }
  }

  if (timerHealthOverdue !== null && timerHealthOverdue >= 1) {
    warnings.push({
      path: 'timerHealth.overdue',
      summary: oldestOverdueName
        ? `timerHealth.overdue=${timerHealthOverdue} oldest=${oldestOverdueName}`
        : `timerHealth.overdue=${timerHealthOverdue}`,
      value: {
        overdue: timerHealthOverdue,
        oldestOverdueName,
        neverFiredHourly,
      },
    });
  } else if (neverFiredHourly.length > 0) {
    const shown = neverFiredHourly.slice(0, 3);
    const extra = neverFiredHourly.length - shown.length;
    warnings.push({
      path: 'timerHealth.overdue',
      summary:
        `hourly timer never fired after its interval: ${shown.join(', ')}` +
        (extra > 0 ? ` (+${extra} more)` : ''),
      value: { overdue: 0, neverFiredHourly },
    });
  }

  // Hook-ingestion p95 (issue #2637). Field path matches GET /api/health.
  const hookIngestion = asRecord(h.hookIngestion);
  const hookIngestionP95LagMs = finiteNumber(hookIngestion?.p95LagMs);
  if (hookIngestionP95LagMs !== null && hookIngestionP95LagMs > HOOK_INGESTION_P95_WARN_MS) {
    warnings.push({
      path: 'hookIngestion.p95LagMs',
      summary: `hookIngestion.p95LagMs=${Math.round(hookIngestionP95LagMs)}ms (>10s)`,
      value: Math.round(hookIngestionP95LagMs),
    });
  }

  // Fail-closed paused schedules (issue #2637): any count ≥ 1, not only ≥ 3.
  const schedules = asRecord(h.schedules);
  const pausedRaw = schedules?.schedulesPausedByFailure;
  const pausedSchedules: Array<{ id: string; name: string; consecutiveFailures: number }> = [];
  if (Array.isArray(pausedRaw)) {
    for (const raw of pausedRaw) {
      const rec = asRecord(raw);
      if (!rec) continue;
      const id = typeof rec.id === 'string' ? rec.id : '';
      if (!id) continue;
      pausedSchedules.push({
        id,
        name: typeof rec.name === 'string' && rec.name.length > 0 ? rec.name : id,
        consecutiveFailures: Math.floor(finiteNumber(rec.consecutiveFailures) ?? 0),
      });
    }
  }
  if (pausedSchedules.length > 0) {
    const top = pausedSchedules[0]!;
    const extra =
      pausedSchedules.length > 1 ? ` (+${pausedSchedules.length - 1} more)` : '';
    warnings.push({
      path: 'schedules.schedulesPausedByFailure',
      summary:
        `schedules.schedulesPausedByFailure=${pausedSchedules.length} ` +
        `(${top.name} consecutiveFailures=${top.consecutiveFailures})` +
        extra,
      value: {
        count: pausedSchedules.length,
        names: pausedSchedules.map((row) => row.name),
      },
    });
  }

  if (starvationRows.length > 0) {
    const top = starvationRows[0]!;
    const extra =
      starvationRows.length > 1 ? ` (+${starvationRows.length - 1} more repo(s))` : '';
    warnings.push({
      path: `pipelineStarvation.repos.${top.repo}.consecutiveBlockedEmpty`,
      summary:
        `pipelineStarvation ${top.repo} consecutiveBlockedEmpty=${top.consecutiveBlockedEmpty}` +
        extra,
      value: {
        elevated: starvationRows.length,
        top,
      },
    });
  }

  // Disk: warn when free percent is known and low (≤15%, matching "critical
  // headroom" operator intuition). Absent disk metrics → no warning.
  if (diskFreePercent !== null && diskFreePercent <= 15) {
    warnings.push({
      path: 'dataDirectory.diskFreePercent',
      summary: `dataDirectory.diskFreePercent=${Math.round(diskFreePercent * 10) / 10}% (low)`,
      value: diskFreePercent,
    });
  }

  return {
    warnings: warnings.slice(0, MAX_WARNINGS),
    signals: {
      pressureWhileDisabled,
      pressureWhileDisabledReason,
      phantomActive: phantomActive !== null ? Math.floor(phantomActive) : null,
      hungSuspect: hungSuspect !== null ? Math.floor(hungSuspect) : null,
      pipelineStarvationElevated,
      diskFreePercent,
      safeModeEngaged,
      hookIngestionP95LagMs:
        hookIngestionP95LagMs !== null ? Math.round(hookIngestionP95LagMs) : null,
      schedulesPausedByFailure: pausedSchedules.length > 0 ? pausedSchedules.length : (
        Array.isArray(pausedRaw) ? 0 : null
      ),
      timerHealthOverdue,
    },
    serverStartedAt,
    sha,
  };
}

/** Human render, hard-capped at MAX_HUMAN_LINES. */
export function formatOpsDigestHuman(snap: OpsDigestSnapshot): string {
  const lines: string[] = [];
  const readyLabel = snap.ready ? 'yes' : 'NO';
  lines.push(
    `ready: ${readyLabel}  http=${snap.readyHttpStatus}  base=${snap.baseUrl}`,
  );
  if (!snap.ready && snap.failingCritical.length > 0) {
    lines.push(`failing critical: ${snap.failingCritical.join(', ')}`);
  }
  if (snap.serverStartedAt || snap.sha) {
    const parts: string[] = [];
    if (snap.sha) parts.push(`sha=${snap.sha.slice(0, 12)}`);
    if (snap.serverStartedAt) parts.push(`started=${snap.serverStartedAt}`);
    lines.push(`server: ${parts.join('  ')}`);
  }

  // When the AC-required fields are present but not elevated, print a quiet
  // zero-line so pasteable digests still show the field path. Elevated values
  // already appear in the warnings list below with the same paths.
  const s = snap.signals;
  if (s.pressureWhileDisabled === false) {
    lines.push('resourceWatchdog.pressureWhileDisabled=false');
  }
  if (s.phantomActive === 0) {
    lines.push('capacity.phantomActive=0');
  }

  if (snap.warnings.length === 0) {
    lines.push('warnings: none');
  } else {
    lines.push(`warnings (${snap.warnings.length}/${MAX_WARNINGS}):`);
    for (const w of snap.warnings) {
      lines.push(`  - ${w.path}: ${w.summary}`);
    }
  }

  // Cap total human output.
  if (lines.length > MAX_HUMAN_LINES) {
    return lines.slice(0, MAX_HUMAN_LINES - 1).concat('  … (truncated)').join('\n');
  }
  return lines.join('\n');
}

/**
 * Accept only loops the server registered. A missing `name` is dropped rather
 * than invented; `overdue` is trusted from the snapshot (the CLI does not
 * recompute it — never-fired loops use registration time, which is not on the
 * wire).
 */
export function parseTimerHealthBody(body: unknown): OpsTimersSnapshot | null {
  const o = asRecord(body);
  if (!o || !Array.isArray(o.loops)) return null;
  const loops: OpsTimerLoop[] = [];
  for (const raw of o.loops) {
    const row = asRecord(raw);
    if (!row) continue;
    if (typeof row.name !== 'string' || row.name.length === 0) continue;
    const lastFiredAt =
      row.lastFiredAt === null
        ? null
        : typeof row.lastFiredAt === 'string'
          ? row.lastFiredAt
          : null;
    loops.push({
      name: row.name,
      lastFiredAt,
      expectedIntervalMs: finiteNumber(row.expectedIntervalMs),
      overdue: row.overdue === true,
    });
  }
  return {
    schemaVersion: typeof o.schemaVersion === 'string' ? o.schemaVersion : null,
    generatedAt: typeof o.generatedAt === 'string' ? o.generatedAt : null,
    loops,
    overdue: loops.filter((loop) => loop.overdue).map((loop) => loop.name),
  };
}

/** One line per registered loop: name, last-fired or `never`, interval, overdue. */
export function formatOpsTimersHuman(snap: OpsTimersSnapshot): string {
  const parts = [`timers  loops=${snap.loops.length}  overdue=${snap.overdue.length}`];
  if (snap.generatedAt) parts[0] += `  generated=${snap.generatedAt}`;
  const lines = [parts[0]!];
  if (snap.loops.length === 0) {
    lines.push('(none registered)');
    return lines.join('\n');
  }
  for (const loop of snap.loops) {
    const last = loop.lastFiredAt ?? 'never';
    const interval =
      loop.expectedIntervalMs === null ? 'unknown' : `${loop.expectedIntervalMs}ms`;
    lines.push(
      `${loop.name}  last=${last}  interval=${interval}  overdue=${loop.overdue}`,
    );
  }
  return lines.join('\n');
}

/** Explicit `--offline`: read the last-good snapshot from disk and print it. */
function runOfflineDigest(resolved: ResolvedIo, json: boolean): number {
  const read = resolved.offlineLoader(resolved.env, resolved.nowMs());
  if (!read) {
    const dirs = resolveOpsKookrDirs(resolved.env);
    const message = `no last-good health snapshot found (looked in ${dirs.join(', ')}).`;
    if (json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'NO_SNAPSHOT',
        message,
        details: { dirs, subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_NO_SNAPSHOT;
  }
  if (json) {
    emitJson(resolved.out, {
      ok: true,
      code: 'OFFLINE_SNAPSHOT',
      message: 'ops digest (offline last-good snapshot)',
      details: { offline: offlineDetails(read, resolved.nowMs()), subcommand: 'ops' },
    });
  } else {
    resolved.out.log(formatOpsDigestOffline(read, { nowMs: resolved.nowMs() }));
  }
  return EXIT_OK;
}

/**
 * Emit a server-unreachable failure envelope, auto-degrading to the last-good
 * snapshot when one exists. Keeps the failing exit code (the server IS down) but
 * still hands the operator a recent, redacted body to reason about.
 */
function degradeToOffline(
  resolved: ResolvedIo,
  json: boolean,
  failExit: number,
  envelope: { code: string; message: string; details: Record<string, unknown> },
): number {
  const read = resolved.offlineLoader(resolved.env, resolved.nowMs());
  if (json) {
    emitJson(resolved.out, {
      ok: false,
      code: envelope.code,
      message: envelope.message,
      details: {
        ...envelope.details,
        ...(read ? { offline: offlineDetails(read, resolved.nowMs()) } : {}),
      },
    });
  } else {
    resolved.err.error(`kookr ops: ${envelope.message}`);
    if (read) resolved.out.log(formatOpsDigestOffline(read, { nowMs: resolved.nowMs() }));
  }
  return failExit;
}

function emitTimersNoServer(
  resolved: ResolvedIo,
  json: boolean,
  message: string,
): number {
  if (json) {
    emitJson(resolved.out, {
      ok: false,
      code: 'NO_SERVER',
      message,
      details: { subcommand: 'ops', verb: 'timers' },
    });
  } else {
    resolved.err.error(`kookr ops: ${message}`);
  }
  return EXIT_NO_SERVER;
}

async function runOpsTimers(
  resolved: ResolvedIo,
  opts: { json: boolean; baseUrl: string },
): Promise<number> {
  let response: { status: number; body: unknown; text: string };
  try {
    response = await fetchJson(
      resolved,
      `${opts.baseUrl}${TIMER_HEALTH_PATH}`,
      OPS_TIMERS_TIMEOUT_MS,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return emitTimersNoServer(resolved, opts.json, `no Kookr server reachable: ${detail}`);
  }

  if (response.status !== 200 || response.body === null) {
    const detail =
      response.body &&
      typeof response.body === 'object' &&
      'error' in response.body
        ? String((response.body as { error: unknown }).error)
        : response.text || 'unknown error';
    const message = `server rejected /api/diagnostics/timer-health (HTTP ${response.status}): ${detail}`;
    if (opts.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { status: response.status, subcommand: 'ops', verb: 'timers' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  const snap = parseTimerHealthBody(response.body);
  if (!snap) {
    const message = 'server returned an unexpected timer-health payload.';
    if (opts.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { subcommand: 'ops', verb: 'timers' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (opts.json) {
    // Existing timer-health document plus a computed overdue list (issue #2639).
    emitJson(resolved.out, {
      ok: true,
      code: 'OK',
      message: 'ops timers',
      details: {
        schemaVersion: snap.schemaVersion,
        generatedAt: snap.generatedAt,
        loops: snap.loops,
        overdue: snap.overdue,
        baseUrl: opts.baseUrl,
      },
    });
  } else {
    resolved.out.log(formatOpsTimersHuman(snap));
  }
  return EXIT_OK;
}

export async function runOpsDigestCli(
  argv: string[],
  io: OpsDigestCliIo = {},
): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    fetchImpl: io.fetchImpl ?? fetch,
    offlineLoader: io.offlineLoader ?? loadOfflineSnapshot,
    nowMs: io.nowMs ?? Date.now,
  };

  let args = parseOpsDigestArgs(argv);
  if (args.help) {
    resolved.out.log(OPS_DIGEST_HELP_TEXT);
    return EXIT_OK;
  }
  if (args.error === undefined && args.offline && args.verb === 'digest') {
    // Offline digest (issue #2495): skip HTTP entirely and read the last-good
    // snapshot from disk. Explicitly requested; degrades gracefully to NO_SNAPSHOT.
    return runOfflineDigest(resolved, args.json);
  }
  if (args.error === undefined && args.offline && args.verb === 'timers') {
    args = { ...args, error: '--offline is not supported for timers' };
  }
  if (args.error) {
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message: args.error,
        details: { subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${args.error}`);
      resolved.err.error('Run `kookr ops --help` for usage.');
    }
    return EXIT_USER_ERROR;
  }
  if (args.verb === null) {
    const message = 'a verb is required (e.g. `kookr ops digest` or `kookr ops timers`).';
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
      resolved.err.error(OPS_DIGEST_HELP_TEXT);
    }
    return EXIT_USER_ERROR;
  }

  const resolvedBase = await resolveOpsDigestBaseUrl(resolved);
  if (resolvedBase.kind === 'invalid_port') {
    const message = `KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_USER_ERROR;
  }
  if (resolvedBase.kind === 'none') {
    const message =
      `no Kookr server reachable (checked ${describeTarget(resolved.env)}). ` +
      'Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.';
    // Last-good health has timerHealth counts (issue #2636), not the
    // per-loop last-fired table `ops timers` prints — do not invent one.
    if (args.verb === 'timers') {
      return emitTimersNoServer(resolved, args.json, message);
    }
    return degradeToOffline(resolved, args.json, EXIT_NO_SERVER, {
      code: 'NO_SERVER',
      message,
      details: { subcommand: 'ops' },
    });
  }

  const baseUrl = resolvedBase.baseUrl;

  if (args.verb === 'timers') {
    return runOpsTimers(resolved, { json: args.json, baseUrl });
  }

  let readyResponse: { status: number; body: unknown; text: string };
  let healthResponse: { status: number; body: unknown; text: string };
  try {
    // Parallel fetch — both are cheap GETs.
    [readyResponse, healthResponse] = await Promise.all([
      fetchJson(resolved, `${baseUrl}${READY_PATH}`),
      fetchJson(resolved, `${baseUrl}${HEALTH_PATH}`),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `no Kookr server reachable: ${detail}`;
    return degradeToOffline(resolved, args.json, EXIT_NO_SERVER, {
      code: 'NO_SERVER',
      message,
      details: { subcommand: 'ops' },
    });
  }

  // Health is the warning source; require 200. Ready may be 503 when not ready.
  if (healthResponse.status !== 200 || healthResponse.body === null) {
    const detail =
      healthResponse.body &&
      typeof healthResponse.body === 'object' &&
      'error' in healthResponse.body
        ? String((healthResponse.body as { error: unknown }).error)
        : healthResponse.text || 'unknown error';
    const message = `server rejected /api/health (HTTP ${healthResponse.status}): ${detail}`;
    return degradeToOffline(resolved, args.json, EXIT_SERVER_ERROR, {
      code: 'SERVER_ERROR',
      message,
      details: { status: healthResponse.status, subcommand: 'ops' },
    });
  }

  // Ready contract: 200 + ready:true → ok; anything else (503, body ready:false,
  // or unexpected status) → not ready for supervisors. Still print health warnings.
  const readyParsed = parseReadyBody(readyResponse.body);
  const readyHttpStatus = readyResponse.status;
  const ready = readyHttpStatus === 200 && readyParsed.ready === true;

  let healthBody: unknown = healthResponse.body;
  if (!healthHasTimerHealthSummary(healthBody)) {
    // Issue #2637: health summary is preferred; a missing block (or an old
    // server that still publishes `timerHealth: null`) falls back to the
    // diagnostics document. Tight timeout so a wedged path cannot hang Lucy.
    try {
      const timerResponse = await fetchJson(
        resolved,
        `${baseUrl}${TIMER_HEALTH_PATH}`,
        OPS_DIGEST_TIMER_FALLBACK_TIMEOUT_MS,
      );
      if (timerResponse.status === 200) {
        const timerSnap = parseTimerHealthBody(timerResponse.body);
        if (timerSnap) healthBody = mergeTimerHealthFallback(healthBody, timerSnap);
      }
    } catch {
      // Keep the digest; timer warnings stay absent.
    }
  }

  const collected = collectOpsDigestWarnings(healthBody, { nowMs: resolved.nowMs() });
  const snap: OpsDigestSnapshot = {
    baseUrl,
    ready,
    readyHttpStatus,
    failingCritical: readyParsed.failingCritical,
    warnings: collected.warnings,
    signals: collected.signals,
    serverStartedAt: collected.serverStartedAt,
    sha: collected.sha,
  };

  if (args.json) {
    emitJson(resolved.out, {
      ok: ready,
      code: ready ? 'OK' : 'READY_FAIL',
      message: ready
        ? 'ops digest (ready)'
        : 'ops digest (ready failed)',
      details: snap,
    });
  } else {
    resolved.out.log(formatOpsDigestHuman(snap));
  }

  return ready ? EXIT_OK : EXIT_READY_FAIL;
}
