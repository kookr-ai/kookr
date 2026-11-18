/**
 * `kookr interrupted` — tasks a crash or reboot interrupted (issue #4215).
 *
 * After an unclean restart Kookr parks the tasks it would have relaunched and
 * asks the operator once (Telegram, dashboard, Lucy) whether to resume them,
 * resuming anyway when nobody answers in time. This command shows those
 * batches, decides a pending one from the terminal, and builds a batch from
 * already-stopped tasks (for example ones the watchdog reaped after a failed
 * relaunch), so they get the same question and the same resume.
 */
import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';
import { resolveStopBaseUrl } from './kookr-stop.js';

// A decision relaunches each task in turn, awaiting each launch.
const REQUEST_TIMEOUT_MS = 600_000;

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;

export const INTERRUPTED_HELP_TEXT = `kookr interrupted — tasks a crash or reboot interrupted.

After an unclean restart Kookr leaves the tasks it would have relaunched
stopped and asks you once (Telegram, dashboard card, Lucy) whether to resume
them. With no answer before the deadline (default 10 minutes), the tasks that
have a conversation resume it. Tasks without one restart from their original
prompt only when you choose resume_all.

Usage:
  kookr interrupted status [--json]
      Show the pending batch and recently decided ones.
  kookr interrupted ask <taskId>... [--json]
      Put already-stopped tasks in a batch and ask the operator about them.
  kookr interrupted decide <resume|resume_all|leave> [--batch <id>] [--json]
      Decide the pending batch (or the given one) now.

Environment:
  KOOKR_INTERRUPTED_TASKS              ask (default) or auto (relaunch at once, no question)
  KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN  minutes before an unanswered batch resumes (default 10)
  KOOKR_SUPERVISOR_TOKEN               bearer token for the supervisor-gated ask/decide routes

Exit codes:
  0 done · 2 user error · 3 no server · 4 server error · 5 two servers reachable`;

interface Batch {
  id: string;
  source: string;
  state: 'pending' | 'decided';
  deadlineAt: number;
  tasks: Array<{ taskId: string; name: string; mode: 'resume' | 'fresh'; reason?: string }>;
  askId?: string;
  decision?: { choice: string; by: string; at: number; outcomes: Array<{ taskId: string; outcome: string; detail?: string }> };
}

export interface InterruptedCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type Parsed =
  | { kind: 'help'; json: boolean }
  | { kind: 'status'; json: boolean }
  | { kind: 'ask'; json: boolean; taskIds: string[] }
  | { kind: 'decide'; json: boolean; choice: string; batchId?: string }
  | { kind: 'error'; json: boolean; message: string };

export function parseInterruptedArgs(argv: string[]): Parsed {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) return { kind: 'help', json };
  const [verb, ...rest] = args;
  if (verb === 'status') {
    return rest.length === 0 ? { kind: 'status', json } : { kind: 'error', json, message: `unexpected argument: ${rest[0]}` };
  }
  if (verb === 'ask') {
    const unknownFlag = rest.find((a) => a.startsWith('-'));
    if (unknownFlag) return { kind: 'error', json, message: `unknown flag: ${unknownFlag}` };
    if (rest.length === 0) return { kind: 'error', json, message: 'give at least one <taskId>.' };
    return { kind: 'ask', json, taskIds: rest };
  }
  if (verb === 'decide') {
    let batchId: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--batch') {
        batchId = rest[++i];
        if (!batchId) return { kind: 'error', json, message: '--batch needs a batch id.' };
      } else if (rest[i]!.startsWith('-')) {
        return { kind: 'error', json, message: `unknown flag: ${rest[i]}` };
      } else {
        positional.push(rest[i]!);
      }
    }
    const choice = positional[0];
    if (positional.length !== 1 || !['resume', 'resume_all', 'leave'].includes(choice!)) {
      return { kind: 'error', json, message: 'decide takes exactly one of: resume, resume_all, leave.' };
    }
    return { kind: 'decide', json, choice: choice!, ...(batchId ? { batchId } : {}) };
  }
  return { kind: 'error', json, message: `unknown subcommand: ${verb}` };
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

/** Human-readable lines for one batch. */
export function formatBatch(batch: Batch, nowMs: number): string {
  const lines: string[] = [];
  if (batch.state === 'pending') {
    const minutes = Math.max(0, Math.round((batch.deadlineAt - nowMs) / 60_000));
    const atDeadline = batch.tasks.some((t) => t.mode === 'resume')
      ? `the tasks with a conversation resume in ${minutes} min without one`
      : `nothing restarts without one (deadline in ${minutes} min)`;
    lines.push(`Batch ${batch.id} (${batch.source}): waiting for your answer; ${atDeadline}.`);
  } else {
    const d = batch.decision!;
    lines.push(`Batch ${batch.id} (${batch.source}): decided "${d.choice}" by ${d.by} at ${new Date(d.at).toISOString()}.`);
  }
  for (const t of batch.tasks) {
    const outcome = batch.decision?.outcomes.find((o) => o.taskId === t.taskId);
    const what = outcome
      ? `${outcome.outcome.replace('_', ' ')}${outcome.detail ? ` (${outcome.detail})` : ''}`
      : t.mode === 'resume' ? 'would continue its conversation' : `no conversation to resume (${t.reason ?? 'unknown'})`;
    lines.push(`  ${t.taskId}  ${t.name}: ${what}`);
  }
  return lines.join('\n');
}

export async function runInterruptedCli(argv: string[], io: InterruptedCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = io.now ?? Date.now;
  const args = parseInterruptedArgs(argv);

  if (args.kind === 'help') {
    out.log(args.json
      ? JSON.stringify({ ok: true, code: 'OK', message: 'Help', details: { subcommand: 'interrupted', help: INTERRUPTED_HELP_TEXT } })
      : INTERRUPTED_HELP_TEXT);
    return EXIT_OK;
  }
  const fail = (exitCode: number, code: string, message: string, details?: Record<string, unknown>): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: 'interrupted', ...details } }));
    else {
      err.error(`kookr interrupted: ${message}`);
      if (code === 'USER_ERROR') err.error('Run `kookr interrupted --help` for usage.');
    }
    return exitCode;
  };
  if (args.kind === 'error') return fail(EXIT_USER_ERROR, 'USER_ERROR', args.message);

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') return fail(EXIT_USER_ERROR, 'USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  if (base.kind === 'ambiguous') {
    const [a, b] = base.ports;
    return fail(EXIT_AMBIGUOUS, 'AMBIGUOUS_PORT', `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`, { ports: base.ports });
  }
  if (base.kind === 'none') return fail(EXIT_NO_SERVER, 'NO_SERVER', 'no Kookr server reachable (checked ports 4800, 4801). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.');

  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> } | number> => {
    try {
      const res = await fetchImpl(`${base.baseUrl}${path}`, {
        method,
        headers: {
          [SUPERVISOR_ACTOR_HEADER]: 'cli',
          'User-Agent': `kookr-interrupted/node-${process.versions.node}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...authHeaders(env),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = text ? JSON.parse(text) as Record<string, unknown> : {};
      } catch { /* non-JSON error page: keep the status */ }
      return { status: res.status, body: parsed };
    } catch (e) {
      return fail(EXIT_NO_SERVER, 'NO_SERVER', `request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const serverError = (r: { status: number; body: Record<string, unknown> }): number => {
    const message = typeof r.body.error === 'string' ? r.body.error : `server returned HTTP ${r.status}`;
    if (r.status === 404 && r.body.error === undefined) {
      return fail(EXIT_SERVER_ERROR, 'UNSUPPORTED', 'this Kookr server has no /api/interrupted-tasks (it predates issue #4215).', { status: r.status });
    }
    const code = r.status === 400 || r.status === 404 || r.status === 409 ? 'USER_ERROR' : 'SERVER_ERROR';
    return fail(code === 'USER_ERROR' ? EXIT_USER_ERROR : EXIT_SERVER_ERROR, code, message, { status: r.status, ...(r.body.refused ? { refused: r.body.refused } : {}) });
  };

  if (args.kind === 'status') {
    const r = await call('GET', '/api/interrupted-tasks');
    if (typeof r === 'number') return r;
    if (r.status !== 200 || !Array.isArray(r.body.batches)) return serverError(r);
    const batches = r.body.batches as Batch[];
    if (args.json) out.log(JSON.stringify({ ok: true, code: 'OK', message: `${batches.length} batch(es)`, details: { batches } }));
    else out.log(batches.length === 0 ? 'No interrupted-task batches.' : [...batches].reverse().map((b) => formatBatch(b, now())).join('\n\n'));
    return EXIT_OK;
  }

  if (args.kind === 'ask') {
    const r = await call('POST', '/api/interrupted-tasks/ask', { taskIds: args.taskIds });
    if (typeof r === 'number') return r;
    if (r.status !== 200 || !r.body.batch) return serverError(r);
    const batch = r.body.batch as Batch;
    const refused = (r.body.refused ?? []) as Array<{ taskId: string; reason: string }>;
    if (args.json) out.log(JSON.stringify({ ok: true, code: 'OK', message: `Asked about batch ${batch.id}`, details: { batch, refused } }));
    else {
      out.log(formatBatch(batch, now()));
      for (const x of refused) out.log(`  not added: ${x.taskId} (${x.reason})`);
      out.log(batch.askId ? 'The question is on Telegram and the dashboard.' : 'No question could be sent (Telegram not configured?): decide with `kookr interrupted decide`.');
    }
    return EXIT_OK;
  }

  let batchId = args.batchId;
  if (!batchId) {
    const r = await call('GET', '/api/interrupted-tasks');
    if (typeof r === 'number') return r;
    if (r.status !== 200 || !Array.isArray(r.body.batches)) return serverError(r);
    batchId = (r.body.batches as Batch[]).find((b) => b.state === 'pending')?.id;
    if (!batchId) return fail(EXIT_USER_ERROR, 'NO_PENDING', 'no batch is waiting for a decision.');
  }
  const r = await call('POST', `/api/interrupted-tasks/${encodeURIComponent(batchId)}/decide`, { choice: args.choice });
  if (typeof r === 'number') return r;
  if (r.status !== 200 || !r.body.batch) return serverError(r);
  const batch = r.body.batch as Batch;
  if (args.json) out.log(JSON.stringify({ ok: true, code: 'OK', message: `Decided batch ${batch.id}`, details: { batch } }));
  else out.log(formatBatch(batch, now()));
  return EXIT_OK;
}
