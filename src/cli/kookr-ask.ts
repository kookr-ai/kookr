/**
 * `kookr ask` — ask the operator a multiple-choice question over Telegram and
 * (optionally) wait for the answer. Client for `POST/GET /api/asks`; design in
 * docs/rfc/rfc-kookr-ask.md.
 *
 *   kookr ask --question "Ship it?" --option "Yes" --option "No"        # prints the ask id
 *   kookr ask --question "Ship it?" --option Yes --option No --wait      # prints the chosen label
 *
 * The CLI never talks to Telegram and never sees the bot token: it only calls
 * the local Kookr server, which owns the Telegram client.
 */

import { createHash } from 'node:crypto';
import { resolveStopBaseUrl } from './kookr-stop.js';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_REJECTED = 4;
export const EXIT_EXPIRED = 5;
export const EXIT_CANCELLED = 6;
export const EXIT_NOT_CONFIGURED = 7;
export const EXIT_STILL_PENDING = 8;

const REQUEST_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;

export const ASK_HELP_TEXT = `kookr ask — ask the operator a multiple-choice question (delivered over Telegram).

Usage:
  kookr ask --question "<text>" --option "<label>" --option "<label>" [options]

Required:
  --question <text>     The question (at most 600 characters).
  --option <label>      An answer button; repeat 2 to 4 times (label at most 48 characters).

Options:
  --context <text>      Extra background shown under the question (at most 1500 characters).
  --timeout <dur>       How long the question stays open: 30s, 10m, 2h or plain seconds
                        (default 30m, minimum 30s, maximum 24h).
  --task-id <uuid>      Task asking (default: $KOOKR_TASK_ID, set in every Kookr task).
  --no-other            Do not accept a free-text reply as an answer.
  --wait[=<seconds>]    Block until answered or expired and print the answer. Without a
                        value, wait until the question's own expiry.
  --json                Print one machine-readable JSON envelope.
  -h, --help            Show this help.

Without --wait the command returns at once and prints the ask id. The operator's
answer is also typed into this task's session as "Operator answered ask <id>: <label>".
Check an ask later with: GET /api/asks/<id>.

Exit codes:
  0 answered, or created (no --wait)    5 expired with no answer
  2 usage error                         6 cancelled (including: the task is gone)
  3 no Kookr server reachable           7 Telegram is not configured on this server
  4 server rejected the request         8 --wait window elapsed, ask still pending

Only ask when you are blocked on a decision that is genuinely the operator's, with
2-4 concrete options. Do not ask in a loop.
`;

export interface ParsedAskArgs {
  question?: string;
  options: string[];
  context?: string;
  timeoutSec?: number;
  taskId?: string;
  allowText: boolean;
  /** undefined: do not wait; null: wait until the ask's own expiry; number: seconds. */
  waitSec?: number | null;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `30s`, `10m`, `2h`, `1d` or a bare number of seconds into seconds. */
export function parseDuration(raw: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/i.exec(raw.trim());
  if (!m) return undefined;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase() as '' | 's' | 'm' | 'h' | 'd'];
  const seconds = Math.round(Number(m[1]) * unit);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function parseAskArgs(argv: string[]): ParsedAskArgs {
  const out: ParsedAskArgs = { options: [], allowText: true, json: false, help: false };
  const fail = (msg: string): void => { if (out.error === undefined) out.error = msg; };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
    const name = eq >= 0 ? tok.slice(0, eq) : tok;
    const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
    const value = (): string | undefined => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) { fail(`${name} needs a value`); return undefined; }
      i++;
      return next;
    };

    switch (name) {
      case '-h': case '--help': out.help = true; break;
      case '--json': out.json = true; break;
      case '--no-other': out.allowText = false; break;
      case '--question': { const v = value(); if (v !== undefined) out.question = v; break; }
      case '--option': { const v = value(); if (v !== undefined) out.options.push(v); break; }
      case '--context': { const v = value(); if (v !== undefined) out.context = v; break; }
      case '--task-id': { const v = value(); if (v !== undefined) out.taskId = v; break; }
      case '--timeout': {
        const v = value();
        if (v === undefined) break;
        const seconds = parseDuration(v);
        if (seconds === undefined) fail(`--timeout must look like 30s, 10m, 2h or a number of seconds (got: ${v})`);
        else out.timeoutSec = seconds;
        break;
      }
      case '--wait': {
        if (inline === undefined) { out.waitSec = null; break; }
        const seconds = parseDuration(inline);
        if (seconds === undefined) fail(`--wait=<seconds> must be a positive duration (got: ${inline})`);
        else out.waitSec = seconds;
        break;
      }
      default:
        fail(tok.startsWith('-') ? `unknown option: ${tok}` : `unexpected argument: ${tok}`);
    }
  }
  return out;
}

export interface AskCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  /** Test seam: resolves after `ms` milliseconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: current time in ms. */
  now?: () => number;
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

interface AskView {
  id: string;
  taskId: string;
  state: 'pending' | 'answered' | 'expired' | 'cancelled';
  expiresAt: number;
  answer?: { kind: 'option'; index: number; label: string } | { kind: 'text'; text: string };
  resolution?: string;
  taskDelivery?: string;
}

function isAskView(value: unknown): value is AskView {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.state === 'string' && typeof o.expiresAt === 'number';
}

/**
 * Default idempotency key: the same question + options from the same task maps
 * to one pending ask, so an agent that re-runs the command after a tool timeout
 * does not post a second Telegram message.
 */
export function defaultIdempotencyKey(taskId: string, question: string, options: string[], context?: string): string {
  return createHash('sha256').update(JSON.stringify([taskId, question, options, context ?? ''])).digest('hex').slice(0, 32);
}

export async function runAskCli(argv: string[], io: AskCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;

  const args = parseAskArgs(argv);
  if (args.help) {
    out.log(ASK_HELP_TEXT);
    return EXIT_OK;
  }

  const fail = (code: string, message: string, exit: number, details?: Record<string, unknown>): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: 'ask', ...details } }));
    else err.error(`kookr ask: ${message}`);
    return exit;
  };
  const usage = (message: string): number => {
    const code = fail('USER_ERROR', message, EXIT_USER_ERROR);
    if (!args.json) err.error('Run `kookr ask --help` for usage.');
    return code;
  };

  if (args.error) return usage(args.error);
  if (args.question === undefined || args.question.trim() === '') return usage('--question is required.');
  if (args.options.length < 2 || args.options.length > 4) return usage('provide 2 to 4 --option labels.');
  if (args.options.some((o) => o.trim() === '')) return usage('an --option label is empty.');
  const taskId = args.taskId ?? env.KOOKR_TASK_ID?.trim();
  if (!taskId) return usage('no task id: run inside a Kookr task (KOOKR_TASK_ID) or pass --task-id.');

  const resolved = await resolveStopBaseUrl({ env, fetchImpl });
  if (resolved.kind === 'invalid_port') return usage(`KOOKR_PORT must be an integer in 1..65535 (got: ${resolved.raw})`);
  if (resolved.kind === 'ambiguous') {
    return fail('AMBIGUOUS_PORT', `two Kookr instances are reachable on :${resolved.ports[0]} and :${resolved.ports[1]}. Set KOOKR_PORT or KOOKR_API_BASE_URL to choose one.`, EXIT_USER_ERROR);
  }
  if (resolved.kind === 'none') {
    return fail('NO_SERVER', 'no Kookr server reachable. Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.', EXIT_NO_SERVER);
  }
  const baseUrl = resolved.baseUrl;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': `kookr-ask/node-${process.versions.node}`, ...authHeaders(env) };

  const payload = JSON.stringify({
    taskId,
    question: args.question,
    options: args.options,
    ...(args.context !== undefined ? { context: args.context } : {}),
    ...(args.timeoutSec !== undefined ? { timeoutSec: args.timeoutSec } : {}),
    allowText: args.allowText,
    idempotencyKey: defaultIdempotencyKey(taskId, args.question, args.options, args.context),
  });

  // One retry on a network failure is safe: the idempotency key makes a repeat a no-op.
  let res: Response | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2 && !res; attempt++) {
    try {
      res = await fetchImpl(`${baseUrl}/api/asks`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) {
      lastErr = e;
      if (attempt === 0) await sleep(500);
    }
  }
  if (!res) {
    return fail('NO_SERVER', `no Kookr server reachable at ${baseUrl}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`, EXIT_NO_SERVER);
  }

  let body: Record<string, unknown> = {};
  try { body = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const message = typeof body.error === 'string' ? body.error : `server returned HTTP ${res.status}`;
    const code = typeof body.code === 'string' ? body.code : 'SERVER_ERROR';
    if (res.status === 503 && code === 'not_configured') {
      return fail('NOT_CONFIGURED', 'Telegram is not configured on this Kookr server, so the operator cannot be asked. Continue without asking, or choose the safest option yourself.', EXIT_NOT_CONFIGURED);
    }
    return fail(code.toUpperCase(), message, EXIT_REJECTED, { status: res.status });
  }
  if (!isAskView(body.ask)) return fail('SERVER_ERROR', 'unexpected /api/asks response.', EXIT_REJECTED, { status: res.status });

  let ask = body.ask;
  const redacted = Array.isArray(body.redacted) ? (body.redacted as string[]) : [];
  if (redacted.length > 0 && !args.json) {
    err.error(`kookr ask: warning: your ${redacted.join(' and ')} looked like it contained a credential and was replaced with a placeholder. Rephrase without secrets and ask again.`);
  }

  if (args.waitSec === undefined) {
    if (args.json) {
      out.log(JSON.stringify({ ok: true, code: 'OK', message: `Asked the operator (ask ${ask.id}).`, details: { askId: ask.id, state: ask.state, expiresAt: ask.expiresAt, deduped: body.deduped === true, redacted } }));
    } else {
      out.log(ask.id);
    }
    return EXIT_OK;
  }

  // --wait: poll until the ask is terminal. Connection errors (e.g. a server
  // restart mid-wait) are retried until the deadline instead of aborting.
  const deadline = args.waitSec === null ? ask.expiresAt + 60_000 : now() + args.waitSec * 1000;
  while (ask.state === 'pending') {
    if (now() >= deadline) {
      return fail('STILL_PENDING', `ask ${ask.id} is still pending (wait window elapsed). Check it later: GET /api/asks/${ask.id}.`, EXIT_STILL_PENDING, { askId: ask.id });
    }
    await sleep(POLL_INTERVAL_MS);
    try {
      const poll = await fetchImpl(`${baseUrl}/api/asks/${encodeURIComponent(ask.id)}`, { headers: authHeaders(env), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (poll.status === 404) return fail('NOT_FOUND', `ask ${ask.id} no longer exists on the server.`, EXIT_REJECTED, { askId: ask.id });
      if (!poll.ok) continue;
      const next = ((await poll.json()) as { ask?: unknown }).ask;
      if (isAskView(next)) ask = next;
    } catch {
      // transient: keep polling until the deadline
    }
  }

  switch (ask.state) {
    case 'answered': {
      const answer = ask.answer;
      const text = answer?.kind === 'text' ? answer.text : answer?.label ?? '';
      if (args.json) {
        out.log(JSON.stringify({ ok: true, code: 'OK', message: `Operator answered ask ${ask.id}.`, details: { askId: ask.id, state: ask.state, answer, taskDelivery: ask.taskDelivery } }));
      } else {
        out.log(text);
      }
      return EXIT_OK;
    }
    case 'expired':
      return fail('EXPIRED', `ask ${ask.id} expired with no answer.`, EXIT_EXPIRED, { askId: ask.id });
    default:
      return fail('CANCELLED', `ask ${ask.id} was cancelled${ask.resolution ? ` (${ask.resolution})` : ''}.`, EXIT_CANCELLED, { askId: ask.id, resolution: ask.resolution });
  }
}
