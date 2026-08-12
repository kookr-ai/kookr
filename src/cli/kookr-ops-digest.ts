/**
 * `kookr ops digest` — pasteable one-pager for remote unattended diagnosis
 * (issue #2347). Fetches GET /api/ready + GET /api/health and prints ≤20 lines:
 * ready status plus the top unattended failure signals (with field paths).
 *
 *   kookr ops digest [--json]
 *
 * Exit: 0 when ready, 1 when ready fails. Does not mutate server state.
 */

const PORTS_TO_TRY = [4800, 4801] as const;
/** Health payloads can be large on busy prod instances; keep headroom over status's 2s. */
const REQUEST_TIMEOUT_MS = 8_000;
const HEALTH_PATH = '/api/health';
const READY_PATH = '/api/ready';
const MAX_WARNINGS = 5;
const MAX_HUMAN_LINES = 20;

export const EXIT_OK = 0;
/** Ready probe failed (HTTP non-200 or body.ready === false). */
export const EXIT_READY_FAIL = 1;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;

export const OPS_DIGEST_HELP_TEXT = `kookr ops digest — one-pager for remote unattended diagnosis.

Usage:
  kookr ops digest [--json]
  kookr ops --help

Fetches GET /api/ready and GET /api/health, then prints ready status plus the
top unattended failure signals (pressureWhileDisabled, phantomActive, hung
residual, pipeline starvation, disk, safeMode) with field paths. ≤20 lines.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT            Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN       Bearer token for non-loopback servers.

Exit codes:
  0  Ready (healthy enough to supervise).
  1  Ready failed (critical not-ready / HTTP 503).
  2  User error (bad flags / unknown verb).
  3  No Kookr server reachable.
  4  Server rejected the health request or returned an unexpected payload.
`;

export interface OpsDigestCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Override HTTP fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface ResolvedIo {
  env: NodeJS.ProcessEnv;
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  fetchImpl: typeof fetch;
}

export interface ParsedOpsDigestArgs {
  verb: 'digest' | null;
  json: boolean;
  help: boolean;
  error?: string;
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
  };
  serverStartedAt: string | null;
  sha: string | null;
}

export function parseOpsDigestArgs(argv: string[]): ParsedOpsDigestArgs {
  const out: ParsedOpsDigestArgs = { verb: null, json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'digest') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = 'digest';
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
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await io.fetchImpl(url, {
    method: 'GET',
    headers: {
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-ops-digest/node-${process.versions.node}`,
      ...apiAuthHeaders(io.env),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
 * severity-ish (safeMode → pressure → phantom → hung → starvation → disk);
 * callers slice to MAX_WARNINGS.
 */
export function collectOpsDigestWarnings(health: unknown): {
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

  const serverStartedAt =
    typeof h.serverStartedAt === 'string' ? h.serverStartedAt : null;
  const sha =
    typeof h.sha === 'string'
      ? h.sha
      : typeof h.gitSha === 'string'
        ? h.gitSha
        : null;

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

export async function runOpsDigestCli(
  argv: string[],
  io: OpsDigestCliIo = {},
): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    fetchImpl: io.fetchImpl ?? fetch,
  };

  const args = parseOpsDigestArgs(argv);
  if (args.help) {
    resolved.out.log(OPS_DIGEST_HELP_TEXT);
    return EXIT_OK;
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
    const message = 'a verb is required (e.g. `kookr ops digest`).';
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
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'NO_SERVER',
        message,
        details: { subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  const baseUrl = resolvedBase.baseUrl;

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
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'NO_SERVER',
        message,
        details: { subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_NO_SERVER;
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
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { status: healthResponse.status, subcommand: 'ops' },
      });
    } else {
      resolved.err.error(`kookr ops: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  // Ready contract: 200 + ready:true → ok; anything else (503, body ready:false,
  // or unexpected status) → not ready for supervisors. Still print health warnings.
  const readyParsed = parseReadyBody(readyResponse.body);
  const readyHttpStatus = readyResponse.status;
  const ready = readyHttpStatus === 200 && readyParsed.ready === true;

  const collected = collectOpsDigestWarnings(healthResponse.body);
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
