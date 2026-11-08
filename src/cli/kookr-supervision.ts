/**
 * `kookr supervision status [id] [--json]` — read-only view of attached task
 * supervisions (RFC attachable-task-supervisor, P2a). Reads
 * `GET /api/supervisions[/:id]` from the running server; the server owns the
 * state, the health derivation and the next-wake computation.
 * `kookr supervision end <id>` closes the mandate (`POST /api/supervisions/:id/end`);
 * it cancels no task.
 */

import {
  EXIT_AMBIGUOUS,
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  resolveStopBaseUrl,
} from './kookr-stop.js';

const REQUEST_TIMEOUT_MS = 10_000;

export const HELP_TEXT = `kookr supervision — inspect attached task supervisions.

Usage:
  kookr supervision status [id] [--json]
  kookr supervision end <id> [--json]

Shows each supervision's health (healthy, degraded:undeliverable, dead, ended),
supervisor task, targets, deadline and the next scheduled wake. With an id (or
a unique id prefix) shows that supervision in detail.

\`end\` marks the supervision ended by the operator: the server stops waking its
supervisor and never restarts it. It does NOT cancel the supervisor or any target
task; stop those yourself if you want them gone.

Options:
  --json       Print one machine-readable JSON envelope instead of human text.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for a supervisor-gated instance.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Exit codes:
  0  Success.                         2  User error (bad flags, unknown supervision id).
  3  No server reachable.             4  Server/HTTP error.
  5  Ambiguous port, or an id prefix matching more than one supervision.
`;

export interface ParsedSupervisionArgs {
  subcommand?: string;
  id?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseSupervisionArgs(argv: string[]): ParsedSupervisionArgs {
  const out: ParsedSupervisionArgs = { json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--json') out.json = true;
    else if (tok.startsWith('-') && tok !== '-') out.error ??= `unknown option: ${tok}`;
    else if (out.subcommand === undefined) out.subcommand = tok;
    else if (out.id === undefined) out.id = tok;
    else out.error ??= `unexpected extra argument: ${tok}`;
  }
  return out;
}

export interface SupervisionCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface StatusRow {
  supervisionId: string;
  health: string;
  nextWake?: { kind: string; at: string };
  wakesEnabled?: boolean;
  supervisor?: { taskId: string | null };
  targets?: Array<{ taskId: string; name: string; status: string }>;
  state: {
    deadlineAt: string;
    restartCount?: number;
    endedReason?: string;
    lastDeliveredAt?: string;
  };
}

function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_SUPERVISOR_TOKEN?.trim() || env.KOOKR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function relative(iso: string, now: Date): string {
  const delta = Date.parse(iso) - now.getTime();
  if (Number.isNaN(delta)) return iso;
  const mins = Math.round(Math.abs(delta) / 60_000);
  const span = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
  return delta >= 0 ? `in ${span}` : `${span} ago`;
}

export function formatSupervision(row: StatusRow, now: Date): string[] {
  const lines = [
    `${row.supervisionId}  ${row.health}${row.state.endedReason ? ` (${row.state.endedReason})` : ''}`,
    `  supervisor: ${row.supervisor?.taskId ?? 'none'}${row.state.restartCount ? `  fresh episodes: ${row.state.restartCount}` : ''}`,
    `  deadline:   ${row.state.deadlineAt} (${relative(row.state.deadlineAt, now)})`,
  ];
  if (row.nextWake) lines.push(`  next wake:  ${row.nextWake.kind} ${row.nextWake.at} (${relative(row.nextWake.at, now)})`);
  if (row.state.lastDeliveredAt) lines.push(`  last wake:  ${row.state.lastDeliveredAt} (${relative(row.state.lastDeliveredAt, now)})`);
  if (row.wakesEnabled === false) lines.push('  wakes DISABLED by KOOKR_SUPERVISION_WAKE_DISABLED');
  for (const t of row.targets ?? []) lines.push(`  target ${t.taskId}  ${t.status}  ${t.name || 'unnamed'}`);
  return lines;
}

export async function runSupervisionCli(argv: string[], io: SupervisionCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const now = (io.now ?? (() => new Date()))();
  const args = parseSupervisionArgs(argv);
  if (args.help) {
    out.log(HELP_TEXT);
    return EXIT_OK;
  }
  const fail = (code: string, message: string, exitCode: number): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: `supervision ${args.subcommand ?? ''}`.trim() } }));
    else err.error(`kookr supervision: ${message}`);
    return exitCode;
  };
  if (args.error) return fail('USER_ERROR', args.error, EXIT_USER_ERROR);
  if (args.subcommand !== 'status' && args.subcommand !== 'end') {
    return fail('USER_ERROR', args.subcommand === undefined ? 'a subcommand is required (status or end).' : `unknown subcommand: ${args.subcommand}`, EXIT_USER_ERROR);
  }
  if (args.subcommand === 'end' && args.id === undefined) {
    return fail('USER_ERROR', 'end needs a supervision id.', EXIT_USER_ERROR);
  }

  const base = await resolveStopBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') return fail('USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`, EXIT_USER_ERROR);
  if (base.kind === 'ambiguous') {
    return fail('AMBIGUOUS_PORT', `two Kookr instances are reachable on :${base.ports[0]} and :${base.ports[1]}. Set KOOKR_PORT to choose one.`, EXIT_AMBIGUOUS);
  }
  if (base.kind === 'none') return fail('NO_SERVER', 'no Kookr server reachable. Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.', EXIT_NO_SERVER);

  const get = async (path: string): Promise<{ status: number; body: unknown } | undefined> => {
    try {
      const res = await fetchImpl(`${base.baseUrl}${path}`, {
        headers: authHeaders(env),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      return undefined;
    }
  };

  const listRes = await get('/api/supervisions');
  if (!listRes) return fail('NO_SERVER', `no Kookr server reachable at ${base.baseUrl}.`, EXIT_NO_SERVER);
  const rows = (listRes.body && typeof listRes.body === 'object' ? (listRes.body as { supervisions?: unknown }).supervisions : undefined);
  if (listRes.status !== 200 || !Array.isArray(rows)) {
    return fail('SERVER_ERROR', `GET /api/supervisions returned HTTP ${listRes.status}.`, EXIT_SERVER_ERROR);
  }
  let selected = rows as StatusRow[];
  if (args.id !== undefined) {
    const id = args.id;
    selected = selected.filter((r) => r.supervisionId === id);
    if (selected.length === 0) selected = (rows as StatusRow[]).filter((r) => r.supervisionId.startsWith(id));
    if (selected.length === 0) return fail('NOT_FOUND', `no supervision matches '${id}'.`, EXIT_USER_ERROR);
    if (selected.length > 1) {
      return fail('AMBIGUOUS_SUPERVISION', `'${id}' matches ${selected.length} supervisions: ${selected.map((r) => r.supervisionId).join(', ')}.`, EXIT_AMBIGUOUS);
    }
  }

  if (args.subcommand === 'end') {
    const target = selected[0];
    let res: Response;
    try {
      res = await fetchImpl(`${base.baseUrl}/api/supervisions/${encodeURIComponent(target.supervisionId)}/end`, {
        method: 'POST',
        headers: authHeaders(env),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return fail('NO_SERVER', `no Kookr server reachable at ${base.baseUrl}.`, EXIT_NO_SERVER);
    }
    if (!res.ok) return fail('SERVER_ERROR', `POST /api/supervisions/${target.supervisionId}/end returned HTTP ${res.status}.`, EXIT_SERVER_ERROR);
    const message = `Supervision ${target.supervisionId} ended by the operator. No task was cancelled.`;
    if (args.json) out.log(JSON.stringify({ ok: true, code: 'OK', message, details: { supervisionId: target.supervisionId } }));
    else out.log(message);
    return EXIT_OK;
  }

  if (args.json) {
    out.log(JSON.stringify({
      ok: true,
      code: 'OK',
      message: `${selected.length} supervision(s).`,
      details: args.id !== undefined ? { supervision: selected[0] } : { supervisions: selected },
    }));
    return EXIT_OK;
  }
  if (selected.length === 0) {
    out.log('No supervisions. Attach one with `kookr supervise <taskRef...>`.');
    return EXIT_OK;
  }
  for (const row of selected) for (const line of formatSupervision(row, now)) out.log(line);
  return EXIT_OK;
}
