/**
 * `kookr reopen` — reopen a terminal task from the terminal (issue #3671).
 *
 * A reaped or finished task could only be reopened from the dashboard's Reopen
 * button (the WebSocket `reopenTask` message). An operator in a shell, or a
 * supervising agent, had no way to resume a task in its original conversation;
 * `kookr spawn` with a handwritten brief throws that conversation away. This is
 * a thin client over the same lifecycle command:
 *
 *   kookr reopen <taskId> [--note "<text>"] [--json]
 *
 * Endpoint: POST /api/tasks/:id/reopen [{ note }] → { ok, task, resume }
 *
 * `resume` says what the relaunch does with the prior conversation: `resume`
 * (continues it), `fresh` (starts from the prompt by design, e.g. a Ralph loop),
 * or `not_resumable` (starts from the prompt because the conversation cannot be
 * continued, with the reason). The task is reopened in all three cases.
 *
 * `--note` (issue #4227) adds text the relaunch puts in front of the original
 * prompt, or of the first message of a resumed conversation, so an instruction
 * given after launch (e.g. "do not merge") survives a restart. Without it, a
 * `not_resumable` outcome prints a warning: the task replays its original
 * prompt unchanged.
 *
 * The route is supervisor-token gated like `/complete`: the CLI forwards
 * `KOOKR_SUPERVISOR_TOKEN` when set, else `KOOKR_API_TOKEN`, else nothing.
 */

import { SUPERVISOR_ACTOR_HEADER, type ReopenResumeReport } from '../shared/contracts/supervisor-actions.js';
import { resolveStopBaseUrl } from './kookr-stop.js';

// The server awaits the relaunch before answering, and a single launch may take
// up to the default launch timeout (180 s, src/server/launch-timeout.ts).
const REQUEST_TIMEOUT_MS = 240_000;

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;

export const REOPEN_HELP_TEXT = `kookr reopen — reopen a terminal task, resuming its conversation when possible.

Usage:
  kookr reopen <taskId> [--note "<text>"] [--json]

Reopens a completed, terminated, or cancelled task via POST /api/tasks/:id/reopen
(the dashboard's Reopen button). The task is re-queued and relaunched as soon as
a slot is free. The output says what the relaunch does with the prior
conversation:

  resume         continues the task's last provider conversation (for opencode,
                 a best effort: it starts fresh if the session data was pruned)
  fresh          starts from the original prompt by design (active Ralph loop)
  not_resumable  starts from the original prompt because the conversation
                 cannot be continued; the reason is printed, with a warning
                 when no note is set (see --note)

Options:
  --note <text>   Text the relaunch sees first: put in front of the original
                  prompt on a fresh start, or sent as the first message of the
                  resumed conversation. Use it for anything said to the task
                  after launch that the original prompt contradicts (e.g.
                  "Do not merge; stop at an open PR."). The note stays on the
                  task for later relaunches; a later --note replaces it.
  --json          Print one machine-readable JSON envelope to stdout
                  (with --help, the help text is in details.help).
  -h, --help      Show this help.

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for the supervisor-gated reopen route.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Exit codes:
  0  Reopened.
  2  User error (bad arguments, unknown task, task not terminal).
  3  No server reachable.
  4  Server/HTTP error (a relaunch that failed, cleanup still in progress,
     a missing or wrong supervisor token, a timeout).
  5  Ambiguous port (two instances reachable — set KOOKR_PORT to choose).
`;

export interface ParsedReopenArgs {
  taskId?: string;
  note?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `kookr reopen` argv: exactly one positional task id; flags are order-free. */
export function parseReopenArgs(argv: string[]): ParsedReopenArgs {
  const out: ParsedReopenArgs = { json: false, help: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok === '--note' || tok.startsWith('--note=')) {
      const value = tok === '--note' ? argv[++i] : tok.slice('--note='.length);
      // `--note --json` is a missing value, not a note; a note that starts
      // with "--" can still be passed as --note=<text>.
      if (value === undefined || (tok === '--note' && value.startsWith('--'))) {
        return { ...out, error: '--note requires a value' };
      }
      if (value.trim() === '') return { ...out, error: '--note must not be empty' };
      out.note = value.trim();
    } else if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    } else if (tok.startsWith('-') && tok !== '-') {
      return { ...out, error: `unknown option: ${tok}` };
    } else {
      positionals.push(tok);
    }
  }
  if (positionals.length > 1) {
    return { ...out, error: `expected one <taskId>, got ${positionals.length}` };
  }
  if (positionals.length === 1) out.taskId = positionals[0];
  return out;
}

export interface ReopenResponse {
  ok: true;
  /** `reopenNote` is the note the relaunch will carry (issue #4227). */
  task: { id: string; status: string; name?: string; reopenNote?: string };
  resume: ReopenResumeReport;
}

function isReopenResponse(body: unknown): body is ReopenResponse {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  const task = o.task as Record<string, unknown> | undefined;
  const resume = o.resume as Record<string, unknown> | undefined;
  if (o.ok !== true || !task || typeof task.id !== 'string' || typeof task.status !== 'string') return false;
  if (!resume) return false;
  if (resume.mode === 'resume') return typeof resume.conversationId === 'string';
  return (resume.mode === 'fresh' || resume.mode === 'not_resumable') && typeof resume.reason === 'string';
}

/** One line on what the relaunch does with the prior conversation. */
export function formatResumeLine(resume: ReopenResumeReport): string {
  switch (resume.mode) {
    case 'resume':
      return resume.caveat
        ? `Conversation: tries to resume ${resume.conversationId} (${resume.caveat})`
        : `Conversation: resumes ${resume.conversationId}`;
    case 'fresh':
      return `Conversation: starts fresh (${resume.reason})`;
    case 'not_resumable':
      return `Conversation: not resumable — ${resume.reason}. Relaunching from the original prompt.`;
  }
}

/** Printed when a `not_resumable` relaunch carries no note (issue #4227). */
export function notResumableNoNoteWarning(taskId: string): string {
  return 'the task restarts from its original prompt unchanged: nothing said to it after launch ' +
    '(for example "do not merge") reaches it. If that prompt is no longer right, send the correction ' +
    `now with \`kookr reply ${taskId} "<text>"\`, and pass --note "<text>" when reopening.`;
}

/**
 * Warnings for a reopen that succeeded (issue #4227): a `not_resumable` relaunch
 * with no note replays the original prompt unchanged, and a server that did not
 * store a note it was sent is too old to support `--note`.
 */
export function reopenWarnings(body: ReopenResponse, sentNote: string | undefined): string[] {
  const warnings: string[] = [];
  const stored = typeof body.task.reopenNote === 'string' && body.task.reopenNote !== '';
  if (sentNote !== undefined && body.task.reopenNote !== sentNote) {
    warnings.push('the server did not store the --note (it may predate --note support); the relaunch does not carry it.');
  }
  if (body.resume.mode === 'not_resumable' && !stored) warnings.push(notResumableNoNoteWarning(body.task.id));
  return warnings;
}

export function formatReopenResult(body: ReopenResponse, warnings: string[] = []): string {
  const state = body.task.status === 'pending'
    ? 'queued as pending; it launches when a slot is free'
    : `now ${body.task.status}`;
  const lines = [`Reopened task ${body.task.id} (${state}).`, formatResumeLine(body.resume)];
  if (body.task.reopenNote) lines.push(`Note: the relaunch carries the reopen note (${body.task.reopenNote.length} chars).`);
  for (const warning of warnings) lines.push(`Warning: ${warning}`);
  return lines.join('\n');
}

export interface ReopenCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

export async function runReopenCli(argv: string[], io: ReopenCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;

  const args = parseReopenArgs(argv);
  if (args.help) {
    // Under --json even help is one envelope, like `kookr status --json --help`.
    out.log(args.json
      ? JSON.stringify({ ok: true, code: 'OK', message: 'Help', details: { subcommand: 'reopen', help: REOPEN_HELP_TEXT } })
      : REOPEN_HELP_TEXT);
    return EXIT_OK;
  }

  const fail = (exitCode: number, code: string, message: string, details?: unknown): number => {
    if (args.json) {
      out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: 'reopen', ...(details as object) } }));
    } else {
      err.error(`kookr reopen: ${message}`);
      if (code === 'USER_ERROR') err.error('Run `kookr reopen --help` for usage.');
    }
    return exitCode;
  };

  if (args.error) return fail(EXIT_USER_ERROR, 'USER_ERROR', args.error);
  if (!args.taskId) return fail(EXIT_USER_ERROR, 'USER_ERROR', 'a <taskId> is required.');
  const taskId = args.taskId;

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') {
    return fail(EXIT_USER_ERROR, 'USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  }
  if (base.kind === 'ambiguous') {
    const [a, b] = base.ports;
    return fail(EXIT_AMBIGUOUS, 'AMBIGUOUS_PORT', `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`, { ports: base.ports });
  }
  if (base.kind === 'none') {
    return fail(EXIT_NO_SERVER, 'NO_SERVER', 'no Kookr server reachable (checked ports 4800, 4801). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.');
  }

  let status: number;
  let body: unknown = null;
  try {
    const res = await fetchImpl(`${base.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/reopen`, {
      method: 'POST',
      headers: {
        [SUPERVISOR_ACTOR_HEADER]: 'cli',
        'User-Agent': `kookr-reopen/node-${process.versions.node}`,
        ...(args.note !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders(env),
      },
      ...(args.note !== undefined ? { body: JSON.stringify({ note: args.note }) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') {
      return fail(
        EXIT_SERVER_ERROR,
        'TIMEOUT',
        `request timed out after ${REQUEST_TIMEOUT_MS} ms; the server was reachable and may still be relaunching the task — check it with \`kookr peek ${taskId}\` before retrying (a retry on an already-reopened task is refused, not duplicated).`,
        { taskId, timeoutMs: REQUEST_TIMEOUT_MS },
      );
    }
    return fail(EXIT_NO_SERVER, 'NO_SERVER', `request failed: ${e instanceof Error ? e.message : String(e)}`, { taskId });
  }

  if (status < 200 || status >= 300) {
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const message = typeof o.error === 'string' ? o.error : `server returned HTTP ${status}`;
    const serverCode = typeof o.code === 'string' ? o.code : undefined;
    if (status === 404) return fail(EXIT_USER_ERROR, 'NOT_FOUND', `task not found: ${taskId}`, { taskId, status });
    if (serverCode === 'task_not_terminal') {
      return fail(EXIT_USER_ERROR, 'TASK_NOT_TERMINAL', message, { taskId, status, serverCode });
    }
    return fail(EXIT_SERVER_ERROR, 'SERVER_ERROR', message, { taskId, status, ...(serverCode ? { serverCode } : {}) });
  }

  if (!isReopenResponse(body)) {
    return fail(EXIT_SERVER_ERROR, 'SERVER_ERROR', 'unexpected /api/tasks/:id/reopen response (expected { ok, task, resume }).', { taskId, status });
  }

  const warnings = reopenWarnings(body, args.note);
  if (args.json) {
    out.log(JSON.stringify({
      ok: true,
      code: 'OK',
      message: `Reopened task ${body.task.id}. ${formatResumeLine(body.resume)}`,
      details: {
        taskId: body.task.id,
        status: body.task.status,
        resume: body.resume,
        ...(body.task.reopenNote ? { note: body.task.reopenNote } : {}),
        warnings,
      },
    }));
  } else {
    out.log(formatReopenResult(body, warnings));
  }
  return EXIT_OK;
}
