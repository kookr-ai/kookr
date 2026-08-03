/**
 * `kookr github` — thin terminal read-side for GitHub scanner liveness
 * (issue #1947). Companion to `kookr status` / `kookr logs`: operators and
 * spawned agents can see whether GitHub scanning is live, remaining rate-limit
 * backoff, and how many PR/issue refs are tracked — without opening the
 * dashboard.
 *
 *   kookr github status [--json]
 *
 * Endpoint: GET /api/github/status
 */

const PORTS_TO_TRY = [4800, 4801] as const;
const REQUEST_TIMEOUT_MS = 4_000;
const API_PATH = '/api/github/status';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;

export const GITHUB_HELP_TEXT = `kookr github — GitHub scanner status.

Usage:
  kookr github status [--json]

status  Print scanner liveness, remaining rate-limit backoff, and tracked-ref count.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT            Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN       Bearer token for non-loopback servers.

Exit codes:
  0  Success.
  2  User error (bad flags / unknown verb).
  3  No Kookr server reachable.
  4  Server rejected the request.
`;

export interface GithubCliIo {
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

export interface GithubStatusSnapshot {
  active: boolean;
  stateFetchBackoffMs: number;
  repoHealthBackoffMs: number;
  trackedRefCount: number;
}

export interface ParsedGithubArgs {
  verb: 'status' | null;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseGithubArgs(argv: string[]): ParsedGithubArgs {
  const out: ParsedGithubArgs = { verb: null, json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'status') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = 'status';
    } else {
      return { ...out, error: `unexpected argument: ${tok}` };
    }
  }
  return out;
}

export function formatGithubStatusLine(snap: GithubStatusSnapshot): string {
  const state = snap.active ? 'active' : 'inactive';
  return (
    `github scanner: ${state}` +
    `  state-fetch-backoff=${snap.stateFetchBackoffMs}ms` +
    `  repo-health-backoff=${snap.repoHealthBackoffMs}ms` +
    `  tracked-refs=${snap.trackedRefCount}`
  );
}

export function parseGithubStatusBody(body: unknown): GithubStatusSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (typeof o.active !== 'boolean') return null;
  if (typeof o.stateFetchBackoffMs !== 'number' || !Number.isFinite(o.stateFetchBackoffMs)) return null;
  if (typeof o.repoHealthBackoffMs !== 'number' || !Number.isFinite(o.repoHealthBackoffMs)) return null;
  if (typeof o.trackedRefCount !== 'number' || !Number.isFinite(o.trackedRefCount)) return null;
  return {
    active: o.active,
    stateFetchBackoffMs: Math.max(0, Math.floor(o.stateFetchBackoffMs)),
    repoHealthBackoffMs: Math.max(0, Math.floor(o.repoHealthBackoffMs)),
    trackedRefCount: Math.max(0, Math.floor(o.trackedRefCount)),
  };
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
 * probe 4800/4801 health (same convention as kookr status / kookr schedule).
 */
export async function resolveGithubBaseUrl(io: {
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
      const res = await io.fetchImpl(`${base}/api/health`, {
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

async function fetchStatus(
  io: ResolvedIo,
  baseUrl: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const res = await io.fetchImpl(`${baseUrl}${API_PATH}`, {
    method: 'GET',
    headers: {
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-github/node-${process.versions.node}`,
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

export async function runGithubCli(argv: string[], io: GithubCliIo = {}): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    fetchImpl: io.fetchImpl ?? fetch,
  };

  const args = parseGithubArgs(argv);
  if (args.help) {
    resolved.out.log(GITHUB_HELP_TEXT);
    return EXIT_OK;
  }
  if (args.error) {
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message: args.error,
        details: { subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${args.error}`);
      resolved.err.error('Run `kookr github --help` for usage.');
    }
    return EXIT_USER_ERROR;
  }
  if (args.verb === null) {
    const message = 'a verb is required (e.g. `kookr github status`).';
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
      resolved.err.error(GITHUB_HELP_TEXT);
    }
    return EXIT_USER_ERROR;
  }

  const resolvedBase = await resolveGithubBaseUrl(resolved);
  if (resolvedBase.kind === 'invalid_port') {
    const message = `KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'USER_ERROR',
        message,
        details: { subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
    }
    return EXIT_USER_ERROR;
  }
  if (resolvedBase.kind === 'none') {
    const message = `no Kookr server reachable (checked ${describeTarget(resolved.env)}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'NO_SERVER',
        message,
        details: { subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  let response: { status: number; body: unknown; text: string };
  try {
    response = await fetchStatus(resolved, resolvedBase.baseUrl);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `no Kookr server reachable: ${detail}`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'NO_SERVER',
        message,
        details: { subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  if (response.status !== 200) {
    const detail =
      response.body && typeof response.body === 'object' && 'error' in response.body
        ? String((response.body as { error: unknown }).error)
        : response.text || 'unknown error';
    const message = `server rejected the request (HTTP ${response.status}): ${detail}`;
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { status: response.status, subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  const snap = parseGithubStatusBody(response.body);
  if (!snap) {
    const message = 'server returned an unexpected /api/github/status payload';
    if (args.json) {
      emitJson(resolved.out, {
        ok: false,
        code: 'SERVER_ERROR',
        message,
        details: { body: response.body, subcommand: 'github' },
      });
    } else {
      resolved.err.error(`kookr github: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (args.json) {
    emitJson(resolved.out, {
      ok: true,
      code: 'OK',
      message: 'GitHub scanner status',
      details: snap,
    });
  } else {
    resolved.out.log(formatGithubStatusLine(snap));
  }
  return EXIT_OK;
}
