/**
 * `kookr stop` (alias `kookr abort`) — terminate running task(s) from the
 * terminal (issue #3069).
 *
 * The headless loop could create tasks (`kookr spawn`) and read their state
 * (`kookr status`, `kookr logs`) but had no verb to STOP one — an operator or
 * script had to open the web dashboard to kill a runaway or stuck agent. The
 * server capability already exists (`POST /api/tasks/abort` → `batchAbortTasks`,
 * issue #1325); this is the thin CLI client it lacked. No server change.
 *
 *   kookr stop <taskId> [<taskId>...] [--reason TEXT] [--json]
 *   kookr abort <taskId> [<taskId>...] [--reason TEXT] [--json]
 *
 * Endpoint: POST /api/tasks/abort  { taskIds: string[], reason?: string }
 *
 * The abort route is supervisor-token gated: when `KOOKR_SUPERVISOR_TOKEN` is
 * set on the server, callers must present `Authorization: Bearer <token>`. This
 * CLI forwards that token (from the same-named env var) only when it is set, so
 * the loopback-open default keeps working unchanged.
 */

import { MAX_BATCH_ABORT_TASKS } from '../shared/contracts/messages.js';
import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';

const PORTS_TO_TRY = [4800, 4801] as const;
const PROBE_TIMEOUT_MS = 500;
// The server aborts tasks sequentially and each abort tears down a live session,
// so a large batch (up to MAX_BATCH_ABORT_TASKS) can take well past a few seconds.
// Scale the request deadline with the task count — capped so the CLI still never
// hangs unboundedly — instead of a fixed budget that a big `kookr stop` would trip
// even while the server is reachable and completing the aborts.
const BASE_REQUEST_TIMEOUT_MS = 15_000;
const PER_TASK_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

function requestTimeoutMs(taskCount: number): number {
  return Math.min(
    MAX_REQUEST_TIMEOUT_MS,
    BASE_REQUEST_TIMEOUT_MS + Math.max(0, taskCount) * PER_TASK_TIMEOUT_MS,
  );
}

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;

export const STOP_HELP_TEXT = `kookr stop — abort (terminate) running task(s) from the terminal.

Usage:
  kookr stop  <taskId> [<taskId>...] [--reason TEXT] [--json]
  kookr abort <taskId> [<taskId>...] [--reason TEXT] [--json]

Aborts every still-active task via POST /api/tasks/abort and reports a per-task
result. The call is idempotent: a task that is already terminal (or unknown)
reports already_terminal / not_found without a second transition.

Options:
  --reason TEXT   Operator reason recorded on the abort (audit attribution).
  --json          Print one machine-readable JSON envelope to stdout.
  -h, --help      Show this help.

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for the supervisor-gated abort route.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Exit codes:
  0  Success.        2  User error.       3  No server reachable.
  4  Server/HTTP error (includes a per-task 'failed' outcome).
  5  Ambiguous port (two instances reachable — set KOOKR_PORT to choose).
`;

export interface ParsedStopArgs {
  taskIds: string[];
  reason?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `kookr stop` argv. Positional tokens are task IDs; flags are order-free. */
export function parseStopArgs(argv: string[]): ParsedStopArgs {
  const out: ParsedStopArgs = { taskIds: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--reason') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ...out, error: `option ${tok} requires a value` };
      }
      i++;
      out.reason = value;
    } else if (tok.startsWith('--reason=')) {
      out.reason = tok.slice('--reason='.length);
    } else if (tok === '--') {
      // Everything after `--` is a positional task id, even if it looks like a flag.
      for (let j = i + 1; j < argv.length; j++) out.taskIds.push(argv[j]);
      break;
    } else if (tok.startsWith('-') && tok !== '-') {
      return { ...out, error: `unknown option: ${tok}` };
    } else {
      out.taskIds.push(tok);
    }
  }
  return out;
}

export interface StopCliIo {
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

/**
 * Authorization for the supervisor-gated abort route. The route checks the
 * `Authorization: Bearer` header against `KOOKR_SUPERVISOR_TOKEN`; the general
 * non-loopback gate uses `KOOKR_API_TOKEN` on the same header. Forward the
 * supervisor token when set, else fall back to the API token, else nothing
 * (loopback-open default).
 */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

export type ResolvedBase =
  | { kind: 'ok'; baseUrl: string }
  | { kind: 'invalid_port'; raw: string }
  | { kind: 'ambiguous'; ports: number[] }
  | { kind: 'none' };

/**
 * Resolve the running Kookr instance. `KOOKR_API_BASE_URL` and `KOOKR_PORT`
 * are explicit overrides; otherwise both default ports are probed and — like
 * `kookr spawn` — two live instances are reported as ambiguous rather than one
 * being picked silently.
 */
export async function resolveStopBaseUrl(io: {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<ResolvedBase> {
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
  const probes = await Promise.all(
    PORTS_TO_TRY.map(async (port) => {
      try {
        const res = await io.fetchImpl(`http://127.0.0.1:${port}/api/health`, {
          headers: authHeaders(io.env),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    }),
  );
  const up = PORTS_TO_TRY.filter((_, i) => probes[i]);
  if (up.length > 1) return { kind: 'ambiguous', ports: [...up] };
  if (up.length === 1) return { kind: 'ok', baseUrl: `http://127.0.0.1:${up[0]}` };
  return { kind: 'none' };
}

export type BatchAbortOutcome = 'aborted' | 'already_terminal' | 'not_found' | 'failed';

export interface BatchAbortTaskResult {
  taskId: string;
  outcome: BatchAbortOutcome;
  status?: string;
  error?: string;
}

export interface BatchAbortResult {
  results: BatchAbortTaskResult[];
  summary: {
    total: number;
    aborted: number;
    already_terminal: number;
    not_found: number;
    failed: number;
  };
}

/** Render the per-task results as a human-readable table. */
export function formatStopResults(result: BatchAbortResult): string {
  const { results, summary } = result;
  const lines: string[] = [];
  lines.push(`Aborted ${summary.aborted} of ${summary.total} task(s).`);
  const idWidth = Math.max(0, ...results.map((r) => r.taskId.length));
  const outcomeWidth = Math.max(0, ...results.map((r) => r.outcome.length));
  for (const r of results) {
    const detail = r.status
      ? ` (${r.status})`
      : r.error
        ? ` — ${r.error}`
        : '';
    lines.push(`  ${r.taskId.padEnd(idWidth)}  ${r.outcome.padEnd(outcomeWidth)}${detail}`);
  }
  lines.push(
    `Summary: aborted=${summary.aborted}  already_terminal=${summary.already_terminal}` +
      `  not_found=${summary.not_found}  failed=${summary.failed}`,
  );
  return lines.join('\n');
}

const SUMMARY_KEYS = ['total', 'aborted', 'already_terminal', 'not_found', 'failed'] as const;

function isBatchAbortResult(body: unknown): body is BatchAbortResult {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  if (!Array.isArray(o.results)) return false;
  if (!o.summary || typeof o.summary !== 'object' || Array.isArray(o.summary)) return false;
  // Validate the numeric summary fields too: `anyFailed = summary.failed > 0`
  // would silently read `undefined > 0` as false on a malformed 2xx body that
  // omitted them, so a truncated response must fall to the "unexpected response"
  // path, not be reported as a clean success.
  const summary = o.summary as Record<string, unknown>;
  return SUMMARY_KEYS.every((k) => typeof summary[k] === 'number');
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runStopCli(argv: string[], io: StopCliIo = {}): Promise<number> {
  const resolved: ResolvedIo = {
    env: io.env ?? process.env,
    out: io.out ?? console,
    err: io.err ?? console,
    fetchImpl: io.fetchImpl ?? fetch,
  };

  const args = parseStopArgs(argv);
  if (args.help) {
    resolved.out.log(STOP_HELP_TEXT);
    return EXIT_OK;
  }

  const userError = (message: string): number => {
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'stop' } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
      resolved.err.error('Run `kookr stop --help` for usage.');
    }
    return EXIT_USER_ERROR;
  };

  if (args.error) return userError(args.error);
  if (args.taskIds.length === 0) {
    return userError('at least one <taskId> is required.');
  }
  if (args.taskIds.length > MAX_BATCH_ABORT_TASKS) {
    return userError(`cannot abort more than ${MAX_BATCH_ABORT_TASKS} tasks in one request.`);
  }

  const resolvedBase = await resolveStopBaseUrl(resolved);
  if (resolvedBase.kind === 'invalid_port') {
    return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`);
  }
  if (resolvedBase.kind === 'ambiguous') {
    const [a, b] = resolvedBase.ports;
    const message = `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'AMBIGUOUS_PORT', message, details: { ports: resolvedBase.ports } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
    }
    return EXIT_AMBIGUOUS;
  }
  if (resolvedBase.kind === 'none') {
    // 'none' is only returned when neither KOOKR_API_BASE_URL nor KOOKR_PORT is
    // set (either short-circuits to 'ok'/'invalid_port'), so the probe swept the
    // default ports — name them directly rather than re-deriving the target.
    const message = `no Kookr server reachable (checked ports ${PORTS_TO_TRY.join(', ')}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'stop' } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  const body: { taskIds: string[]; reason?: string } = { taskIds: args.taskIds };
  if (args.reason !== undefined) body.reason = args.reason;

  const timeoutMs = requestTimeoutMs(args.taskIds.length);
  let response: { status: number; body: unknown };
  try {
    const res = await resolved.fetchImpl(`${resolvedBase.baseUrl}/api/tasks/abort`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SUPERVISOR_ACTOR_HEADER]: 'cli',
        'User-Agent': `kookr-stop/node-${process.versions.node}`,
        ...authHeaders(resolved.env),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    response = { status: res.status, body: parsed };
  } catch (err) {
    // A deadline hit (AbortSignal.timeout → a 'TimeoutError') means the server was
    // reachable but did not answer in time — not "no server". The abort may still
    // be completing server-side, so classify it as a server-side condition and
    // tell the operator to re-check state rather than assume nothing happened.
    if (err instanceof Error && err.name === 'TimeoutError') {
      const message = `request timed out after ${timeoutMs} ms; the server was reachable and may still be completing the abort — re-run \`kookr stop ${args.taskIds.join(' ')} --json\` to confirm each task's state.`;
      if (args.json) {
        emitJson(resolved.out, {
          ok: false,
          code: 'TIMEOUT',
          message,
          details: { subcommand: 'stop', timeoutMs, taskIds: args.taskIds },
        });
      } else {
        resolved.err.error(`kookr stop: ${message}`);
      }
      return EXIT_SERVER_ERROR;
    }
    const detail = err instanceof Error ? err.message : String(err);
    const message = `request failed: ${detail}`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'stop' } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  if (response.status < 200 || response.status >= 300) {
    const bodyObj = (response.body && typeof response.body === 'object'
      ? response.body
      : {}) as Record<string, unknown>;
    const message =
      typeof bodyObj.error === 'string' ? bodyObj.error : `server returned HTTP ${response.status}`;
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'SERVER_ERROR', message, details: { status: response.status } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (!isBatchAbortResult(response.body)) {
    const message = 'unexpected /api/tasks/abort response (expected { results, summary }).';
    if (args.json) {
      emitJson(resolved.out, { ok: false, code: 'SERVER_ERROR', message, details: { status: response.status } });
    } else {
      resolved.err.error(`kookr stop: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  const result = response.body;
  // A `failed` per-task outcome is a real abort failure (not the idempotent
  // already_terminal / not_found outcomes), so surface it as a non-zero exit.
  const anyFailed = result.summary.failed > 0;

  if (args.json) {
    resolved.out.log(
      JSON.stringify({
        ok: !anyFailed,
        code: anyFailed ? 'ABORT_PARTIAL_FAILURE' : 'OK',
        message: anyFailed
          ? `${result.summary.failed} task(s) failed to abort.`
          : `Aborted ${result.summary.aborted} of ${result.summary.total} task(s).`,
        details: result,
      }),
    );
    return anyFailed ? EXIT_SERVER_ERROR : EXIT_OK;
  }

  resolved.out.log(formatStopResults(result));
  return anyFailed ? EXIT_SERVER_ERROR : EXIT_OK;
}
