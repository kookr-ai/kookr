/**
 * `kookr queue` — show and edit the server's ready queue (issue #3933).
 *
 *   kookr queue list [--json]
 *   kookr queue remove <id> [--json]
 *
 * Entries are added with `kookr spawn --queue`. Endpoints: GET /api/ready-queue
 * and DELETE /api/ready-queue/:id. Thin HTTP client; no server state is read
 * from disk here.
 */

import { resolveStopBaseUrl } from './kookr-stop.js';

const REQUEST_TIMEOUT_MS = 10_000;

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;
export const EXIT_AMBIGUOUS = 5;

export const QUEUE_HELP_TEXT = `kookr queue — show and edit the ready queue.

Usage:
  kookr queue list [--json]
  kookr queue remove <id> [--json]

The ready queue holds launches added with \`kookr spawn --queue\`. Every 30
seconds Kookr starts the oldest one when a slot for ordinary launches is free
(the reserved slots stay reserved), no launch is waiting in the overflow queue,
host load is under KOOKR_READY_QUEUE_MAX_LOAD_PER_CPU, and the server is not
draining for a deploy. A launch that fails to start is retried, three attempts
in all, then marked failed and reported once as an alert.

\`list\` prints each entry's id, state (queued, launching, started, failed),
failed attempts, age and wait reason. Started and failed entries stay listed
for 24 hours. With --json it prints the full entries and the queue health.

\`remove\` deletes one entry. An entry being started right now cannot be
removed; try again a few seconds later.

Options:
  --json          Print one machine-readable JSON envelope to stdout.
  -h, --help      Show this help.

Environment:
  KOOKR_API_BASE_URL  Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT          Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN     Bearer token for a non-loopback server.

Exit codes:
  0  Success.   2  User error.   3  No server reachable.
  4  Server/HTTP error (includes "no such entry").
  5  Ambiguous port (two instances reachable; set KOOKR_PORT to choose).
`;

export interface ParsedQueueArgs {
  subcommand?: 'list' | 'remove';
  id?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseQueueArgs(argv: string[]): ParsedQueueArgs {
  const out: ParsedQueueArgs = { json: false, help: false };
  const positional: string[] = [];
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--json') out.json = true;
    else if (tok.startsWith('-')) return { ...out, error: `unknown option: ${tok}` };
    else positional.push(tok);
  }
  if (out.help) return out;
  const [sub, ...rest] = positional;
  if (sub === undefined) return { ...out, error: 'a subcommand is required: list or remove' };
  if (sub === 'list') {
    if (rest.length > 0) return { ...out, error: `list takes no arguments (got: ${rest.join(' ')})` };
    return { ...out, subcommand: 'list' };
  }
  if (sub === 'remove' || sub === 'rm') {
    if (rest.length !== 1) return { ...out, error: 'remove takes exactly one entry id' };
    return { ...out, subcommand: 'remove', id: rest[0] };
  }
  return { ...out, error: `unknown subcommand: ${sub} (expected list or remove)` };
}

export interface QueueCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface ListedEntry {
  id: string;
  state: string;
  attempts: number;
  enqueuedAt: string;
  waitReason?: string;
  taskId?: string;
  lastError?: string;
  request?: { prompt?: unknown; playbook?: { path?: unknown } };
}

const WAIT_TEXT: Record<string, string> = {
  no_free_slot: 'no free slot',
  host_load: 'host load',
  draining: 'server draining for a deploy',
  automation_paused: 'automation paused (SAFE MODE)',
  retry_after: 'server asked to retry later',
  launch_failed: 'last launch attempt failed; retrying',
};

function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h${String(minutes % 60).padStart(2, '0')}m` : `${Math.floor(hours / 24)}d`;
}

function describe(entry: ListedEntry): string {
  const playbook = entry.request?.playbook?.path;
  if (typeof playbook === 'string') return `playbook ${playbook}`;
  const prompt = typeof entry.request?.prompt === 'string'
    ? entry.request.prompt.replace(/\s+/g, ' ').trim()
    : '';
  return prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt;
}

/** Human table for `kookr queue list`. */
export function formatQueueList(entries: ListedEntry[], nowMs: number): string {
  if (entries.length === 0) return 'Ready queue is empty. Add a launch with `kookr spawn --queue ...`.';
  const queued = entries.filter((entry) => entry.state === 'queued').length;
  const lines = [`Ready queue: ${queued} queued, ${entries.length} listed.`];
  for (const entry of entries) {
    const status = entry.state === 'started'
      ? `task ${entry.taskId ?? '?'}`
      : entry.state === 'failed'
        ? `failed: ${entry.lastError ?? 'unknown error'}`
        : entry.waitReason
          ? `waiting: ${WAIT_TEXT[entry.waitReason] ?? entry.waitReason}`
          : '';
    lines.push(
      `  ${entry.id.padEnd(8)}  ${entry.state.padEnd(9)}  attempts=${entry.attempts}`
      + `  age=${formatAge(nowMs - Date.parse(entry.enqueuedAt)).padEnd(6)}  ${describe(entry)}`
      + (status ? `  [${status}]` : ''),
    );
  }
  return lines.join('\n');
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function runQueueCli(argv: string[], io: QueueCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = io.now ?? Date.now;

  const args = parseQueueArgs(argv);
  if (args.help) {
    out.log(QUEUE_HELP_TEXT);
    return EXIT_OK;
  }
  const fail = (exitCode: number, code: string, message: string, details?: unknown): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code, message, details }));
    else err.error(`kookr queue: ${message}`);
    return exitCode;
  };
  if (args.error || !args.subcommand) {
    if (!args.json) err.error('Run `kookr queue --help` for usage.');
    return fail(EXIT_USER_ERROR, 'USER_ERROR', args.error ?? 'a subcommand is required', { subcommand: 'queue' });
  }

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') {
    return fail(EXIT_USER_ERROR, 'USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`);
  }
  if (base.kind === 'ambiguous') {
    return fail(EXIT_AMBIGUOUS, 'AMBIGUOUS_PORT', `two Kookr instances are reachable on :${base.ports.join(' and :')}. Set KOOKR_PORT to choose one.`, { ports: base.ports });
  }
  if (base.kind === 'none') {
    return fail(EXIT_NO_SERVER, 'NO_SERVER', 'no Kookr server reachable (checked ports 4800, 4801). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.');
  }

  const url = args.subcommand === 'list'
    ? `${base.baseUrl}/api/ready-queue`
    : `${base.baseUrl}/api/ready-queue/${encodeURIComponent(args.id!)}`;
  let status: number;
  let body: Record<string, unknown> = {};
  try {
    const res = await fetchImpl(url, {
      method: args.subcommand === 'list' ? 'GET' : 'DELETE',
      headers: { 'User-Agent': `kookr-queue/node-${process.versions.node}`, ...authHeaders(env) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try {
      const parsed = text ? JSON.parse(text) as unknown : {};
      if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
    } catch {
      body = {};
    }
  } catch (e) {
    return fail(EXIT_NO_SERVER, 'NO_SERVER', `request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (status === 404 && body.code === undefined && args.subcommand === 'list') {
    return fail(EXIT_SERVER_ERROR, 'SERVER_ERROR', 'this Kookr server has no ready queue; update Kookr');
  }
  if (status < 200 || status >= 300) {
    const message = typeof body.error === 'string' ? body.error : `server returned HTTP ${status}`;
    return fail(EXIT_SERVER_ERROR, typeof body.code === 'string' ? body.code.toUpperCase() : 'SERVER_ERROR', message, { status });
  }

  if (args.subcommand === 'remove') {
    const message = `Removed ${args.id} from the ready queue.`;
    if (args.json) out.log(JSON.stringify({ ok: true, code: 'OK', message, details: { id: args.id } }));
    else out.log(message);
    return EXIT_OK;
  }

  const entries = Array.isArray(body.entries) ? body.entries as ListedEntry[] : [];
  if (args.json) {
    out.log(JSON.stringify({
      ok: true,
      code: 'OK',
      message: `${entries.filter((entry) => entry.state === 'queued').length} queued`,
      details: { entries, health: body.health ?? null },
    }));
  } else {
    out.log(formatQueueList(entries, now()));
  }
  return EXIT_OK;
}
