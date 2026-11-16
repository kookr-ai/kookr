/**
 * `kookr brief` (issue #3931): what is waiting on the operator, across every
 * project, oldest first. Prints `GET /api/operator/inbox`: the totals line,
 * then one entry per item with its age, task, project, what it is, how to
 * answer it and a dashboard link. For a permission prompt the command is
 * shown too (secrets hidden); Telegram's `/brief` leaves it out.
 */

import {
  formatInboxAge,
  type OperatorInbox,
  type OperatorInboxItem,
} from '../shared/contracts/operator-inbox.js';
import { resolveGithubBaseUrl as resolveServerBaseUrl } from './kookr-github.js';

const REQUEST_TIMEOUT_MS = 4_000;
const API_PATH = '/api/operator/inbox';

export const EXIT_OK = 0;
export const EXIT_USER_ERROR = 2;
export const EXIT_NO_SERVER = 3;
export const EXIT_SERVER_ERROR = 4;

export const BRIEF_HELP_TEXT = `kookr brief — what is waiting on you, across all projects.

Usage:
  kookr brief [--json]

Lists, oldest first, every task on a permission prompt, pending kookr ask
question, task flagged as needing you, task that says it is finished and wants
your review, and a halted or stalled integration train. The first line gives
the totals. Reads GET /api/operator/inbox.

Options:
  --json       Print one machine-readable JSON envelope to stdout.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL   Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT            Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_API_TOKEN       Bearer token for non-loopback servers.

Exit codes:
  0  Success (including: nothing is waiting).
  2  User error (bad flags).
  3  No Kookr server reachable.
  4  Server rejected the request.
`;

export interface BriefCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  /** Override HTTP fetch (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Clock for ages (tests). */
  now?: () => number;
}

export interface ParsedBriefArgs {
  json: boolean;
  help: boolean;
  error?: string;
}

export function parseBriefArgs(argv: string[]): ParsedBriefArgs {
  const out: ParsedBriefArgs = { json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') out.help = true;
    else if (tok === '--json') out.json = true;
    else if (tok.startsWith('-')) return { ...out, error: `unknown option: ${tok}` };
    else return { ...out, error: `unexpected argument: ${tok}` };
  }
  return out;
}

const KIND_LABEL: Record<OperatorInboxItem['kind'], string> = {
  permission: 'permission',
  question: 'question',
  flagged: 'flagged',
  review: 'review',
  train: 'train',
};

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The human output: totals line, then one block per item. */
export function formatBrief(inbox: OperatorInbox, baseUrl: string, nowMs: number): string {
  if (inbox.items.length === 0) return inbox.summary;
  const lines = [inbox.summary, ''];
  for (const item of inbox.items) {
    const age = formatInboxAge(nowMs - Date.parse(item.since)).padEnd(10);
    const label = KIND_LABEL[item.kind].padEnd(10);
    if (item.kind === 'train') {
      lines.push(`  ${age} ${label} ${item.summary}`);
    } else {
      const who = item.taskName ? `"${oneLine(item.taskName, 80)}"` : `task ${item.taskId ?? '?'}`;
      const project = item.project ? ` (${item.project})` : '';
      lines.push(`  ${age} ${label} ${who}${project} ${item.summary}`);
    }
    const indent = ' '.repeat(24);
    if (item.command) lines.push(`${indent}${item.toolName ?? 'Command'}: ${item.command}`);
    if (item.question) {
      lines.push(`${indent}"${oneLine(item.question, 300)}"`);
      if (item.options && item.options.length > 0) lines.push(`${indent}Options: ${item.options.join(' | ')}`);
    }
    lines.push(`${indent}To answer: ${item.howToAnswer}`);
    if (item.link) lines.push(`${indent}${baseUrl}${item.link}`);
  }
  return lines.join('\n');
}

function isInbox(body: unknown): body is OperatorInbox {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  return typeof o.summary === 'string' && Array.isArray(o.items);
}

function apiAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.KOOKR_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function runBriefCli(argv: string[], io: BriefCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const args = parseBriefArgs(argv);

  const fail = (code: 'USER_ERROR' | 'NO_SERVER' | 'SERVER_ERROR', message: string, exit: number, details: Record<string, unknown> = {}): number => {
    if (args.json) out.log(JSON.stringify({ ok: false, code, message, details: { subcommand: 'brief', ...details } }));
    else err.error(`kookr brief: ${message}`);
    return exit;
  };

  if (args.help) {
    out.log(BRIEF_HELP_TEXT);
    return EXIT_OK;
  }
  if (args.error) {
    if (!args.json) err.error('Run `kookr brief --help` for usage.');
    return fail('USER_ERROR', args.error, EXIT_USER_ERROR);
  }

  const base = await resolveServerBaseUrl({ env, fetchImpl });
  if (base.kind === 'invalid_port') {
    return fail('USER_ERROR', `KOOKR_PORT must be an integer in 1..65535 (got: ${base.raw})`, EXIT_USER_ERROR);
  }
  if (base.kind === 'none') {
    return fail('NO_SERVER', 'no Kookr server reachable. Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.', EXIT_NO_SERVER);
  }

  let status: number;
  let body: unknown = null;
  try {
    const res = await fetchImpl(`${base.baseUrl}${API_PATH}`, {
      method: 'GET',
      headers: { 'X-Kookr-Launch-Source': 'cli', ...apiAuthHeaders(env) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  } catch (e) {
    return fail('NO_SERVER', `no Kookr server reachable: ${e instanceof Error ? e.message : String(e)}`, EXIT_NO_SERVER);
  }

  if (status === 404) {
    return fail('SERVER_ERROR', `the server has no ${API_PATH} route; it is older than kookr brief, so update it`, EXIT_SERVER_ERROR, { status });
  }
  if (status !== 200) {
    const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'unknown error';
    return fail('SERVER_ERROR', `server rejected the request (HTTP ${status}): ${detail}`, EXIT_SERVER_ERROR, { status });
  }
  if (!isInbox(body)) {
    return fail('SERVER_ERROR', `server returned an unexpected ${API_PATH} payload (is it older than kookr brief?)`, EXIT_SERVER_ERROR);
  }

  if (args.json) {
    out.log(JSON.stringify({ ok: true, code: 'OK', message: body.summary, details: body }));
  } else {
    out.log(formatBrief(body, base.baseUrl, io.now?.() ?? Date.now()));
  }
  return EXIT_OK;
}
