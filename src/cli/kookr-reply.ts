/**
 * `kookr reply <taskId|name> "<text>"` — deliver a terminal reply to a task's
 * live agent from the command line (issue #3103).
 *
 * The headless loop could spawn (`kookr spawn`), inspect (`kookr status`,
 * `kookr logs`), and stop (`kookr stop`) a task, but had no verb to talk BACK
 * to a running agent waiting on input — an operator or script had to open the
 * web dashboard to type a reply. The server capability already exists
 * (`POST /api/agents/:id/message` → `sendDirectAgentInput`); this is the thin
 * CLI client it lacked, mirroring `kookr open`'s instance discovery and
 * `--json` envelope shape.
 *
 *   kookr reply <taskId|name> "<text>"
 *   echo "text" | kookr reply <taskId|name>
 *
 * Resolution: GET /api/snapshot lists live agents; this matches the one whose
 * `taskId` or `taskName` equals the given ref (exact match), excluding any
 * whose `taskStatus` is already terminal. Zero matches is a NO_AGENT user
 * error; more than one is AMBIGUOUS_AGENT (parallel to `kookr stop`'s
 * AMBIGUOUS_PORT) and requires the caller to disambiguate rather than guess.
 *
 * Delivery: POST /api/agents/:agentId/message  { input: string }
 *
 * Actor attribution mirrors `kookr stop`: the reply is sent with the
 * `SUPERVISOR_ACTOR_HEADER` set to `cli` so the interaction log records the
 * CLI (not `unattributed`) as the sender — no server change needed.
 */

import { SUPERVISOR_ACTOR_HEADER } from '../shared/contracts/supervisor-actions.js';
import { isTerminalStatus, type TaskStatus } from '../shared/contracts/task-status.js';
import {
  EXIT_AMBIGUOUS,
  EXIT_NO_SERVER,
  EXIT_OK,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  resolveStopBaseUrl,
} from './kookr-stop.js';

const PORTS_TO_TRY = [4800, 4801] as const;
const REQUEST_TIMEOUT_MS = 10_000;

export const HELP_TEXT = `kookr reply — deliver a terminal reply to a task's live agent.

Usage:
  kookr reply <taskId|name> "<text>" [--json]
  echo "<text>" | kookr reply <taskId|name> [--json]

Resolves the task's live agent from the running Kookr instance and posts the
reply as terminal input, attributed to the "cli" actor. The task is matched
by exact taskId or exact taskName among currently live agents.

Reply text is taken from the second positional argument; when omitted it is
read from stdin (piped input only — an interactive stdin with no positional
text is a usage error).

Options:
  --json       Print one machine-readable JSON envelope instead of human text.
  -h, --help   Show this help.

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for a supervisor-gated instance.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Instance discovery mirrors \`kookr stop\` / \`kookr open\`: KOOKR_API_BASE_URL
wins, else KOOKR_PORT, else the default ports ${PORTS_TO_TRY.join(' / ')} are probed.

Exit codes:
  0  Success (reply delivered).                2  User error (incl. no live agent).
  3  No server reachable.                       4  Server/HTTP error delivering the reply.
  5  Ambiguous port, or more than one live agent matched the task.
`;

export interface ParsedReplyArgs {
  taskRef?: string;
  text?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

/** Parse `kookr reply` argv. The first positional is the task ref, the second the reply text. */
export function parseReplyArgs(argv: string[]): ParsedReplyArgs {
  const out: ParsedReplyArgs = { json: false, help: false };
  for (const tok of argv) {
    if (tok === '-h' || tok === '--help') {
      out.help = true;
    } else if (tok === '--json') {
      out.json = true;
    } else if (tok.startsWith('-') && tok !== '-') {
      if (out.error === undefined) out.error = `unknown option: ${tok}`;
    } else if (out.taskRef === undefined) {
      out.taskRef = tok;
    } else if (out.text === undefined) {
      out.text = tok;
    } else {
      if (out.error === undefined) out.error = `unexpected extra argument: ${tok}`;
    }
  }
  return out;
}

export type ReadStdin = () => Promise<string | undefined>;

export interface ReplyCliIo {
  env?: NodeJS.ProcessEnv;
  out?: { log: (...args: unknown[]) => void };
  err?: { error: (...args: unknown[]) => void };
  fetchImpl?: typeof fetch;
  /** Test seam: resolves piped stdin content, or `undefined` when stdin is a TTY (nothing piped). */
  readStdin?: ReadStdin;
}

interface SnapshotAgent {
  agentId: string;
  taskId?: string;
  taskName?: string;
  taskStatus?: TaskStatus;
}

function isSnapshotAgent(value: unknown): value is SnapshotAgent {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.agentId === 'string';
}

function isSnapshotAgentArray(body: unknown): body is SnapshotAgent[] {
  return Array.isArray(body) && body.every(isSnapshotAgent);
}

interface MessageDeliveryResult {
  ok: true;
  agentId: string;
  delivered: boolean;
}

function isMessageDeliveryResult(body: unknown): body is MessageDeliveryResult {
  if (!body || typeof body !== 'object') return false;
  const o = body as Record<string, unknown>;
  return o.ok === true && typeof o.agentId === 'string' && typeof o.delivered === 'boolean';
}

/**
 * Authorization mirroring `kookr stop` / `kookr open`: forward the supervisor
 * token when set, else the API token, else nothing (loopback-open default).
 */
function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const supervisor = env.KOOKR_SUPERVISOR_TOKEN?.trim();
  if (supervisor) return { Authorization: `Bearer ${supervisor}` };
  const apiToken = env.KOOKR_API_TOKEN?.trim();
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  return {};
}

/** Minimal shape of stdin we read: an async byte/text source that may be a TTY. */
type StdinLike = AsyncIterable<Uint8Array | string> & { isTTY?: boolean };

export async function defaultReadStdin(
  stdin: StdinLike = process.stdin as unknown as StdinLike,
): Promise<string | undefined> {
  // Node sets `isTTY` to `true` on a real terminal and leaves it `undefined`
  // on a pipe/redirect (never `false`). Only bail out for an interactive TTY;
  // guarding on `!== false` would also bail on the piped case and never read.
  if (stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array | string));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runReplyCli(argv: string[], io: ReplyCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;
  const readStdin = io.readStdin ?? defaultReadStdin;

  const args = parseReplyArgs(argv);
  if (args.help) {
    out.log(HELP_TEXT);
    return EXIT_OK;
  }

  const userError = (message: string, details?: Record<string, unknown>): number => {
    if (args.json) {
      emitJson(out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'reply', ...details } });
    } else {
      err.error(`kookr reply: ${message}`);
      err.error('Run `kookr reply --help` for usage.');
    }
    return EXIT_USER_ERROR;
  };

  if (args.error) return userError(args.error);
  if (args.taskRef === undefined) return userError('a <taskId|name> is required.');

  let text = args.text;
  if (text === undefined) {
    const piped = await readStdin();
    if (piped === undefined) {
      return userError('no reply text provided. Pass it as a positional argument, or pipe it via stdin.');
    }
    text = piped.replace(/\s+$/, '');
  }
  if (text.length === 0) {
    return userError('reply text is empty.');
  }

  const resolvedBase = await resolveStopBaseUrl({ env, fetchImpl });
  if (resolvedBase.kind === 'invalid_port') {
    return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`);
  }
  if (resolvedBase.kind === 'ambiguous') {
    const [a, b] = resolvedBase.ports;
    const message = `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'AMBIGUOUS_PORT', message, details: { ports: resolvedBase.ports } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_AMBIGUOUS;
  }
  if (resolvedBase.kind === 'none') {
    const message = `no Kookr server reachable (checked ports ${PORTS_TO_TRY.join(', ')}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'reply' } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  const baseUrl = resolvedBase.baseUrl;

  let snapshotBody: unknown;
  try {
    const res = await fetchImpl(`${baseUrl}/api/snapshot`, {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const message = `failed to read the task snapshot (server returned HTTP ${res.status}).`;
      if (args.json) {
        emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { status: res.status } });
      } else {
        err.error(`kookr reply: ${message}`);
      }
      return EXIT_SERVER_ERROR;
    }
    snapshotBody = await res.json();
  } catch (fetchErr) {
    const detail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const message = `no Kookr server reachable at ${baseUrl}: ${detail}`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'reply', baseUrl } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_NO_SERVER;
  }

  if (!isSnapshotAgentArray(snapshotBody)) {
    const message = 'unexpected /api/snapshot response (expected an array of agent states).';
    if (args.json) {
      emitJson(out, { ok: false, code: 'SERVER_ERROR', message });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  const taskRef = args.taskRef;
  const candidates = snapshotBody.filter(
    (agent) =>
      (agent.taskId === taskRef || agent.taskName === taskRef) &&
      (agent.taskStatus === undefined || !isTerminalStatus(agent.taskStatus)),
  );

  if (candidates.length === 0) {
    const message = `no live agent found for task '${taskRef}'.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'NO_AGENT', message, details: { subcommand: 'reply', taskRef } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_USER_ERROR;
  }

  if (candidates.length > 1) {
    const candidateList = candidates.map((c) => ({
      agentId: c.agentId,
      taskName: c.taskName,
      taskStatus: c.taskStatus,
    }));
    const message = `${candidates.length} live agents matched task '${taskRef}'. Address one by its agentId to disambiguate.`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'AMBIGUOUS_AGENT', message, details: { taskRef, candidates: candidateList } });
    } else {
      err.error(`kookr reply: ${message}`);
      for (const c of candidateList) {
        err.error(`  ${c.agentId}  ${c.taskName ?? ''}  ${c.taskStatus ?? ''}`);
      }
    }
    return EXIT_AMBIGUOUS;
  }

  const agent = candidates[0];

  let response: { status: number; body: unknown };
  try {
    const res = await fetchImpl(`${baseUrl}/api/agents/${encodeURIComponent(agent.agentId)}/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SUPERVISOR_ACTOR_HEADER]: 'cli',
        'User-Agent': `kookr-reply/node-${process.versions.node}`,
        ...authHeaders(env),
      },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseText = await res.text();
    let parsed: unknown = null;
    try {
      parsed = responseText ? JSON.parse(responseText) : null;
    } catch {
      parsed = null;
    }
    response = { status: res.status, body: parsed };
  } catch (postErr) {
    const detail = postErr instanceof Error ? postErr.message : String(postErr);
    const message = `failed to deliver the reply: ${detail}`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { subcommand: 'reply', agentId: agent.agentId } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (response.status < 200 || response.status >= 300) {
    const bodyObj = (response.body && typeof response.body === 'object' ? response.body : {}) as Record<
      string,
      unknown
    >;
    const message =
      typeof bodyObj.error === 'string' ? bodyObj.error : `server returned HTTP ${response.status}`;
    if (args.json) {
      emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { status: response.status } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  if (!isMessageDeliveryResult(response.body)) {
    const message = 'unexpected /api/agents/:id/message response (expected { ok, agentId, delivered }).';
    if (args.json) {
      emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { status: response.status } });
    } else {
      err.error(`kookr reply: ${message}`);
    }
    return EXIT_SERVER_ERROR;
  }

  const resolvedTaskId = agent.taskId ?? taskRef;
  if (args.json) {
    emitJson(out, {
      ok: true,
      code: 'OK',
      message: `Delivered reply to agent ${agent.agentId} (task ${resolvedTaskId}).`,
      details: { taskId: resolvedTaskId, agentId: agent.agentId, delivered: true },
    });
  } else {
    out.log(`Delivered reply to agent ${agent.agentId} (task ${resolvedTaskId}).`);
  }
  return EXIT_OK;
}
