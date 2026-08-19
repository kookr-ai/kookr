/**
 * `kookr orchestration` — pause / resume / status for the autonomous fleet
 * (issue #2672).
 *
 * A first-class, named surface over SAFE MODE so a human can say "pause" /
 * "resume" without hand-editing the whole settings document, and the
 * orchestrator can flip a soft-quota pause on itself. The underlying write
 * still goes through the server's settings-update path; this CLI is a thin
 * client of the `/api/orchestration/*` routes.
 *
 *   kookr orchestration pause    [--reason TEXT] [--by NAME] [--source human|soft-quota] [--json]
 *   kookr orchestration resume   [--by NAME] [--auto] [--json]
 *   kookr orchestration status   [--json]
 *
 * Endpoints: POST /api/orchestration/pause | /resume, GET /api/orchestration/status
 */

const PORTS_TO_TRY = [4800, 4801] as const;
const REQUEST_TIMEOUT_MS = 6_000;

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;

export const ORCHESTRATION_HELP_TEXT = `kookr orchestration — pause/resume the autonomous fleet (SAFE MODE wrapper).

Usage:
  kookr orchestration pause   [--reason TEXT] [--by NAME] [--source human|soft-quota] [--json]
  kookr orchestration resume  [--by NAME] [--auto] [--json]
  kookr orchestration status  [--json]

pause   Engage SAFE MODE and record the pause (who/why/since/source). Running
        implementers keep working; no new autonomous launches.
resume  Disengage SAFE MODE and clear the pause record. A soft-quota --auto
        resume will NOT lift a human pause.
status  Show engaged / since / reason / source and any default-agent quota sample.

Options:
  --reason TEXT   Why the pause is engaged (pause only).
  --by NAME       Who is pausing/resuming (default: operator).
  --source S      'human' (default) or 'soft-quota' (pause only).
  --auto          Soft-quota auto-resume; declines to lift a human pause (resume only).
  --json          Print one machine-readable JSON envelope to stdout.
  -h, --help      Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT           Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN      Bearer token for non-loopback servers.

Exit codes:
  0  Success.   2  User error.   3  No server reachable.   4  Server error.
`;

export type OrchestrationVerb = 'pause' | 'resume' | 'status';

export interface ParsedOrchestrationArgs {
  verb: OrchestrationVerb | null;
  json: boolean;
  help: boolean;
  reason?: string;
  by?: string;
  source?: 'human' | 'soft-quota';
  auto: boolean;
  error?: string;
}

export function parseOrchestrationArgs(argv: string[]): ParsedOrchestrationArgs {
  const out: ParsedOrchestrationArgs = { verb: null, json: false, help: false, auto: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--auto') {
      out.auto = true;
    } else if (tok === '--reason' || tok === '--by' || tok === '--source') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...out, error: `option ${tok} requires a value` };
      }
      i++;
      if (tok === '--reason') out.reason = value;
      else if (tok === '--by') out.by = value;
      else {
        if (value !== 'human' && value !== 'soft-quota') {
          return { ...out, error: `--source must be 'human' or 'soft-quota' (got: ${value})` };
        }
        out.source = value;
      }
    } else if (tok.startsWith('--reason=') || tok.startsWith('--by=') || tok.startsWith('--source=')) {
      const [flag, ...rest] = tok.split('=');
      const value = rest.join('=');
      if (flag === '--reason') out.reason = value;
      else if (flag === '--by') out.by = value;
      else {
        if (value !== 'human' && value !== 'soft-quota') {
          return { ...out, error: `--source must be 'human' or 'soft-quota' (got: ${value})` };
        }
        out.source = value;
      }
    } else if (tok.startsWith('-')) {
      return { ...out, error: `unknown option: ${tok}` };
    } else if (out.verb === null) {
      if (tok !== 'pause' && tok !== 'resume' && tok !== 'status') {
        return { ...out, error: `unknown verb: ${tok}` };
      }
      out.verb = tok;
    } else {
      return { ...out, error: `unexpected argument: ${tok}` };
    }
  }
  return out;
}

export interface OrchestrationCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
}

interface ResolvedIo {
  env: NodeJS.ProcessEnv;
  out: { log: (...args: unknown[]) => void };
  err: { error: (...args: unknown[]) => void };
  fetchImpl: typeof fetch;
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

export async function resolveOrchestrationBaseUrl(io: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<
  | { kind: 'ok'; baseUrl: string }
  | { kind: 'invalid_port'; raw: string }
  | { kind: 'none' }
> {
  const explicit = io.env.KOOKR_API_BASE_URL?.trim();
  if (explicit) return { kind: 'ok', baseUrl: explicit.replace(/\/+$/, '') };
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

interface OrchestrationRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
}

function requestFor(args: ParsedOrchestrationArgs): OrchestrationRequest {
  if (args.verb === 'status') {
    return { method: 'GET', path: '/api/orchestration/status' };
  }
  if (args.verb === 'pause') {
    const body: Record<string, unknown> = {};
    if (args.reason) body.reason = args.reason;
    if (args.by) body.by = args.by;
    if (args.source) body.source = args.source;
    return { method: 'POST', path: '/api/orchestration/pause', body };
  }
  const body: Record<string, unknown> = {};
  if (args.by) body.by = args.by;
  if (args.auto) body.auto = true;
  return { method: 'POST', path: '/api/orchestration/resume', body };
}

async function sendRequest(
  io: ResolvedIo,
  baseUrl: string,
  req: OrchestrationRequest,
): Promise<{ status: number; body: unknown }> {
  const res = await io.fetchImpl(`${baseUrl}${req.path}`, {
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'X-Kookr-Launch-Source': 'cli',
      'User-Agent': `kookr-orchestration/node-${process.versions.node}`,
      ...apiAuthHeaders(io.env),
    },
    ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** One-line human summary of an orchestration status body. */
export function formatOrchestrationStatusLine(body: unknown): string {
  if (!body || typeof body !== 'object') return 'orchestration: (unparseable status)';
  const o = body as Record<string, unknown>;
  const paused = o.paused === true;
  const pause = (o.pause && typeof o.pause === 'object' ? o.pause : null) as Record<string, unknown> | null;
  const parts: string[] = [`orchestration: ${paused ? 'PAUSED' : 'running'}`];
  if (paused && pause) {
    if (typeof pause.source === 'string') parts.push(`source=${pause.source}`);
    if (typeof pause.pausedAt === 'string') parts.push(`since=${pause.pausedAt}`);
    if (typeof pause.pausedBy === 'string') parts.push(`by=${pause.pausedBy}`);
    if (typeof pause.reason === 'string') parts.push(`reason="${pause.reason}"`);
  }
  const quota = (o.quota && typeof o.quota === 'object' ? o.quota : null) as Record<string, unknown> | null;
  if (quota) {
    if (quota.supported === true && typeof quota.utilization === 'number') {
      parts.push(`quota[${String(quota.agentType)}]=${quota.utilization}%`);
    } else if (quota.supported === false) {
      parts.push(`quota[${String(quota.agentType)}]=unsupported`);
    }
  }
  const rec = (o.recommendation && typeof o.recommendation === 'object'
    ? o.recommendation
    : null) as Record<string, unknown> | null;
  if (rec && typeof rec.action === 'string' && rec.action !== 'none') {
    parts.push(`recommend=${rec.action}`);
  }
  return parts.join('  ');
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runOrchestrationCli(
  argv: string[],
  io: OrchestrationCliIo = {},
): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    fetchImpl: io.fetchImpl ?? fetch,
  };

  const args = parseOrchestrationArgs(argv);
  if (args.help) {
    resolved.out.log(ORCHESTRATION_HELP_TEXT);
    return EXIT_OK;
  }
  const userError = (message: string): number => {
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'orchestration' } });
    } else {
      resolved.err.error(`kookr orchestration: ${message}`);
      resolved.err.error('Run `kookr orchestration --help` for usage.');
    }
    return EXIT_USER_ERROR;
  };
  if (args.error) return userError(args.error);
  if (args.verb === null) return userError('a verb is required (pause | resume | status).');
  if (args.source && args.verb !== 'pause') return userError('--source is only valid with `pause`.');
  if (args.reason && args.verb !== 'pause') return userError('--reason is only valid with `pause`.');
  if (args.auto && args.verb !== 'resume') return userError('--auto is only valid with `resume`.');

  const resolvedBase = await resolveOrchestrationBaseUrl(resolved);
  if (resolvedBase.kind === 'invalid_port') {
    return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`);
  }
  if (resolvedBase.kind === 'none') {
    const message = `no Kookr server reachable (checked ${describeTarget(resolved.env)}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'orchestration' } });
    } else {
      resolved.err.error(`kookr orchestration: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  let response: { status: number; body: unknown };
  try {
    response = await sendRequest(resolved, resolvedBase.baseUrl, requestFor(args));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `request failed: ${detail}`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'orchestration' } });
    } else {
      resolved.err.error(`kookr orchestration: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  if (response.status < 200 || response.status >= 300) {
    const bodyObj = (response.body && typeof response.body === 'object'
      ? response.body
      : {}) as Record<string, unknown>;
    const message =
      typeof bodyObj.error === 'string'
        ? bodyObj.error
        : `server returned HTTP ${response.status}`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'SERVER_ERROR', message, details: { status: response.status } });
    } else {
      resolved.err.error(`kookr orchestration: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (args.json) {
    resolved.out.log(JSON.stringify(response.body));
    return EXIT_OK;
  }

  if (args.verb === 'pause') {
    resolved.out.log('Orchestration paused (SAFE MODE engaged).');
    resolved.out.log(formatOrchestrationStatusLine(response.body));
  } else if (args.verb === 'resume') {
    const bodyObj = (response.body && typeof response.body === 'object'
      ? response.body
      : {}) as Record<string, unknown>;
    if (bodyObj.resumed === false) {
      const why = typeof bodyObj.resumeDeclinedReason === 'string' ? bodyObj.resumeDeclinedReason : 'not resumed';
      resolved.out.log(`Resume declined: ${why}`);
    } else {
      resolved.out.log('Orchestration resumed (SAFE MODE disengaged).');
    }
    resolved.out.log(formatOrchestrationStatusLine(response.body));
  } else {
    resolved.out.log(formatOrchestrationStatusLine(response.body));
  }
  return EXIT_OK;
}
