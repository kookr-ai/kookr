/**
 * `kookr keep-alive` — extend the deadline of a task a reclaim has warned
 * (issue #4241).
 *
 *   kookr keep-alive <taskId|id8> --for <dur> --reason <text> [--json]
 *
 * Endpoint: POST /api/tasks/:id/keep-alive  { forMs, reason, callerTaskId? }
 *
 * The caller's own `KOOKR_TASK_ID` is sent as `callerTaskId`, so the server
 * accepts the call from the warned task's parent and refuses it from the task
 * itself or an unrelated task. Without `KOOKR_TASK_ID` the call is the
 * operator's.
 */

import { parseDuration } from './kookr-ask.js';
import { resolveStopBaseUrl } from './kookr-stop.js';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;
/** The server refused: not the parent, the task itself, cap reached, or no warning. */
export const EXIT_REFUSED = 6;

const REQUEST_TIMEOUT_MS = 15_000;

export const KEEP_ALIVE_HELP_TEXT = `kookr keep-alive — keep a warned task from being closed.

Usage:
  kookr keep-alive <taskId|id8> --for <dur> --reason <text> [--json]

When Kookr is about to close a silent task, it types a line into the task's
parent with the deadline. If the silence is intended (the worker waits on a
review, a remote job or a slow eval), the parent runs this command to push the
deadline out.

Who may call it: the task's parent (detected from KOOKR_TASK_ID), or the
operator (no KOOKR_TASK_ID). A task cannot keep itself alive.

Limits: --for is at most 60m; at most 3 extensions per warning, dashboard
clicks included; never past 12 hours of silence (longRunningJobReclaimCapHours).

Options:
  --for DUR       How long to extend: 30s, 10m, 1h (at most 60m).
  --reason TEXT   Why the task is silent on purpose (recorded in the audit
                  row and the disposition, shown in the dashboard and peek).
  --json          Print one machine-readable JSON envelope to stdout.
  -h, --help      Show this help.

Environment:
  KOOKR_TASK_ID        The caller's task id (set inside every Kookr task).
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT           Specific port on 127.0.0.1 (overrides auto-detect).

Exit codes:
  0  Kept alive.     2  User error.       3  No server reachable.
  4  Server/HTTP error.                   5  Ambiguous port.
  6  Refused (not the parent, the task itself, no pending close, or a cap reached).
`;

export interface ParsedKeepAliveArgs {
  taskRef?: string;
  forMs?: number;
  reason?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseKeepAliveArgs(argv: string[]): ParsedKeepAliveArgs {
  const out: ParsedKeepAliveArgs = { json: false, help: false };
  const fail = (message: string): ParsedKeepAliveArgs => ({ ...out, error: message });
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    let flag = tok;
    let inline: string | undefined;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 0) {
      flag = tok.slice(0, eq);
      inline = tok.slice(eq + 1);
    }
    if (flag === '-h' || flag === '--help') {
      out.help = true;
    } else if (flag === '--json') {
      out.json = true;
    } else if (flag === '--for' || flag === '--reason') {
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        return fail(`option ${flag} requires a value`);
      }
      if (inline === undefined) i++;
      if (flag === '--for') {
        const seconds = parseDuration(value);
        if (seconds === undefined) return fail(`--for must be a duration like 30m or 1h (got: ${value})`);
        out.forMs = seconds * 1000;
      } else {
        out.reason = value;
      }
    } else if (tok.startsWith('-') && tok !== '-') {
      return fail(`unknown option: ${tok}`);
    } else {
      positional.push(tok);
    }
  }
  if (positional.length > 1) return fail('exactly one <taskId> is expected');
  if (positional.length === 1) out.taskRef = positional[0];
  return out;
}

export interface KeepAliveCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

export async function runKeepAliveCli(argv: string[], io: KeepAliveCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const args = parseKeepAliveArgs(argv);

  const report = (code: number, payload: { ok: boolean; code: string; message: string; details?: unknown }): number => {
    if (args.json) out.log(JSON.stringify(payload));
    else if (payload.ok) out.log(payload.message);
    else err.error(`kookr keep-alive: ${payload.message}`);
    return code;
  };

  if (args.help) {
    out.log(KEEP_ALIVE_HELP_TEXT);
    return EXIT_OK;
  }
  const userError = (message: string): number => {
    const code = report(EXIT_USER_ERROR, { ok: false, code: 'USER_ERROR', message });
    if (!args.json) err.error('Run `kookr keep-alive --help` for usage.');
    return code;
  };
  if (args.error) return userError(args.error);
  if (!args.taskRef) return userError('a <taskId> is required.');
  if (args.forMs === undefined) return userError('--for is required (e.g. --for 30m).');
  if (!args.reason?.trim()) return userError('--reason is required.');

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  if (base.kind === 'ambiguous') {
    return report(EXIT_AMBIGUOUS, {
      ok: false,
      code: 'AMBIGUOUS_PORT',
      message: `two Kookr instances are reachable on :${base.ports[0]} and :${base.ports[1]}. Set KOOKR_PORT to choose one.`,
    });
  }
  if (base.kind === 'none') {
    return report(EXIT_NO_SERVER, {
      ok: false,
      code: 'NO_SERVER',
      message: 'no Kookr server reachable. Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.',
    });
  }

  const callerTaskId = env.KOOKR_TASK_ID?.trim();
  const body = { forMs: args.forMs, reason: args.reason, ...(callerTaskId ? { callerTaskId } : {}) };
  let status: number;
  let parsed: Record<string, unknown> = {};
  try {
    const res = await fetchImpl(`${base.baseUrl}/api/tasks/${encodeURIComponent(args.taskRef)}/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(env) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      const json: unknown = text ? JSON.parse(text) : {};
      if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  } catch (e) {
    return report(EXIT_NO_SERVER, {
      ok: false,
      code: 'NO_SERVER',
      message: `request failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  if (status >= 200 && status < 300) {
    const deadline = typeof parsed.deadlineAt === 'string' ? parsed.deadlineAt : 'unknown';
    const left = typeof parsed.remainingKeepAlives === 'number' ? parsed.remainingKeepAlives : undefined;
    if (parsed.unchanged === true) {
      return report(EXIT_OK, {
        ok: true,
        code: 'UNCHANGED',
        message: `Task ${String(parsed.taskId ?? args.taskRef)} is already kept alive until ${deadline}; nothing changed.`,
        details: parsed,
      });
    }
    return report(EXIT_OK, {
      ok: true,
      code: 'OK',
      message: `Kept task ${String(parsed.taskId ?? args.taskRef)} alive until ${deadline}`
        + (left !== undefined ? ` (${left} keep-alive(s) left in this cycle).` : '.'),
      details: parsed,
    });
  }
  const message = typeof parsed.error === 'string' ? parsed.error : `server returned HTTP ${status}`;
  const refused = status === 403 || status === 404 || status === 409;
  return report(refused ? EXIT_REFUSED : EXIT_SERVER_ERROR, {
    ok: false,
    code: typeof parsed.code === 'string' ? parsed.code : refused ? 'REFUSED' : 'SERVER_ERROR',
    message,
    details: { status },
  });
}
