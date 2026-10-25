/**
 * `kookr peek <taskId|name>` — print a task's live run-state AND the full,
 * untruncated last assistant message from the command line (issue: supervisor
 * false-idle diagnosis).
 *
 * WHY THIS EXISTS. A supervisor task was asked "is the agent doing anything?"
 * It answered by hand-rolling `curl .../transcript | node -e '... .slice(0, 2000)'`
 * and by reading the task's `updatedAt` heartbeat. The agent's last message was
 * a deliberate, well-communicated pause — its operative sentence ("I'm pausing
 * at this clean slice boundary … say the word if you want me to reprioritize")
 * sat at the END of a 2350-char message, past the 2000-char cut. The supervisor
 * never saw it, declared the agent had "stopped silently," and sent it a reply
 * scolding it. All false.
 *
 * Two durable lessons are baked into this command:
 *   1. READ THE AGENT'S OWN WORDS. It prints the last assistant text message in
 *      FULL by default. When `--max-chars` caps it, it keeps the TAIL (the
 *      operative conclusion), not the head — the opposite of the bug.
 *   2. HEARTBEAT ≠ LIVENESS. The run-state headline is derived only from
 *      first-class signals the server already computes — `turnState`,
 *      `anomaly`, and `sessionHealth.classification` on `/api/snapshot` — never
 *      from `updatedAt`. `completed_turn` / `waiting_for_input` / `healthy-idle`
 *      is reported as a legitimate AWAITING-OPERATOR pause, distinct from a hang.
 *
 * It is a thin, read-only HTTP client against the running instance, mirroring
 * `kookr reply` / `kookr stop` for instance discovery, auth, and the `--json`
 * envelope. It makes no writes and never messages the agent.
 *
 *   kookr peek <taskId|name> [--max-chars N] [--session ID] [--json]
 */

import { isTerminalStatus, type TaskStatus, type TurnState } from '../shared/contracts/task-status.js';
import type { TranscriptMessage, TranscriptResponse } from '../shared/contracts/transcript.js';
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

export const PEEK_HELP_TEXT = `kookr peek — show a task's run-state and its full last assistant message.

Usage:
  kookr peek <taskId|name> [OPTIONS]

Answers "what is this task actually doing, and what did it last say?" without
hand-rolling curl + truncation. Prints:
  - a RUN-STATE headline derived from first-class signals (turnState, anomaly,
    session-health classification) — NOT the updatedAt heartbeat; and
  - the agent's last assistant message IN FULL, plus any operator replies
    delivered after it.

Read it before concluding a task is idle or stalled: a deliberate pause
("awaiting-operator") looks identical to a hang from a heartbeat, but says so
in its own words at the end of its last message.

Options:
  --max-chars <N>   Cap the last message (and each reply after it) to N chars,
                    keeping the TAIL (the operative conclusion), not the head.
                    Applies to human and --json output. Default: no cap.
                    Also accepts --max-chars=<N>.
  --session <id>    Read a specific session's transcript (default: newest).
  --json            Print one machine-readable JSON envelope.
  -h, --help        Show this help.

Environment:
  KOOKR_API_BASE_URL      Base URL of a running Kookr server (overrides auto-detect).
  KOOKR_PORT              Specific port on 127.0.0.1 (overrides auto-detect).
  KOOKR_SUPERVISOR_TOKEN  Bearer token for a supervisor-gated instance.
  KOOKR_API_TOKEN         Bearer token for a non-loopback server (fallback).

Instance discovery mirrors \`kookr reply\` / \`kookr stop\`: KOOKR_API_BASE_URL
wins, else KOOKR_PORT, else the default ports ${PORTS_TO_TRY.join(' / ')} are probed.

Exit codes:
  0  Success.                                  2  User error (incl. no such task).
  3  No server reachable.                       4  Server/HTTP error.
  5  Ambiguous port, or more than one task matched the ref.`;

export interface ParsedPeekArgs {
  taskRef?: string;
  maxChars?: number;
  session?: string;
  json: boolean;
  help: boolean;
  error?: string;
}

export function parsePeekArgs(argv: string[]): ParsedPeekArgs {
  const args: ParsedPeekArgs = { json: false, help: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    // Accept both `--flag value` and `--flag=value` for value-taking flags,
    // mirroring `kookr stop --reason=`. An `=` splits the token into the flag
    // name and an inline value; a space-separated value is read from argv[++i].
    let arg = argv[i];
    let inlineValue: string | undefined;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq !== -1) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const takeValue = (): string | undefined => (inlineValue !== undefined ? inlineValue : argv[++i]);
    switch (arg) {
      case '-h':
      case '--help':
        return { ...args, help: true };
      case '--json':
        if (inlineValue !== undefined) return { ...args, error: `Unknown option: ${argv[i]}` };
        args.json = true;
        break;
      case '--max-chars': {
        const value = takeValue();
        const n = Number(value);
        if (value === undefined || value === '' || !Number.isInteger(n) || n < 1) {
          return { ...args, error: `--max-chars expects a positive integer (got: ${JSON.stringify(value)}).` };
        }
        args.maxChars = n;
        break;
      }
      case '--session': {
        const value = takeValue();
        if (value === undefined || value === '' || value.startsWith('-')) {
          return { ...args, error: '--session expects a session id value.' };
        }
        args.session = value;
        break;
      }
      default:
        if (arg.startsWith('-')) return { ...args, error: `Unknown option: ${argv[i]}` };
        positionals.push(arg);
    }
  }
  if (positionals.length === 0) {
    return { ...args, error: 'Expected a <taskId|name> argument. See `kookr peek --help`.' };
  }
  if (positionals.length > 1) {
    return { ...args, error: `Expected exactly one <taskId|name> argument (got ${positionals.length}). See \`kookr peek --help\`.` };
  }
  args.taskRef = positionals[0];
  return args;
}

/** Minimal shape of a `/api/snapshot` agent this command reads. */
export interface PeekSnapshotAgent {
  agentId: string;
  taskId?: string;
  taskName?: string;
  taskStatus?: TaskStatus;
  turnState?: TurnState;
  anomaly?: { type?: string; subType?: string; explanation?: string } | null;
  sessionHealth?: { classification?: string } | null;
}

function isPeekSnapshotAgent(value: unknown): value is PeekSnapshotAgent {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string, unknown>).agentId === 'string';
}

function isPeekSnapshotAgentArray(body: unknown): body is PeekSnapshotAgent[] {
  return Array.isArray(body) && body.every(isPeekSnapshotAgent);
}

export type RunState =
  | 'working'
  | 'awaiting-operator'
  | 'blocked'
  | 'possibly-hung'
  | 'terminal'
  | 'unknown';

export interface RunStateVerdict {
  state: RunState;
  /** One-line, operator-facing headline. */
  headline: string;
  /** The raw signals the verdict was derived from (never a heartbeat). */
  signals: {
    taskStatus?: TaskStatus;
    turnState?: TurnState;
    anomalyType?: string;
    anomalySubType?: string;
    classification?: string;
  };
}

const STALLED_CLASSIFICATIONS = new Set([
  'provider-or-agent-stalled',
  'terminal-attach-stalled',
  'session-lost',
  'browser-bridge-stalled',
  'recovery-in-progress',
]);

/**
 * Derive a single run-state headline from the server's own first-class signals.
 *
 * Deliberately does NOT consider `updatedAt` or any wall-clock heartbeat: a
 * heartbeat advances for bookkeeping and subagent churn and cannot tell a
 * deliberate pause from a hang. The precedence below resolves a legitimate
 * idle (`completed_turn` / `waiting_for_input` / `healthy-idle`) to
 * `awaiting-operator`, never to a stall.
 */
export function deriveRunState(input: {
  taskStatus?: TaskStatus;
  turnState?: TurnState;
  anomalyType?: string;
  anomalySubType?: string;
  classification?: string;
}): RunStateVerdict {
  const { taskStatus, turnState, anomalyType, anomalySubType, classification } = input;
  const signals = { taskStatus, turnState, anomalyType, anomalySubType, classification };

  if (taskStatus && isTerminalStatus(taskStatus)) {
    return { state: 'terminal', headline: `TERMINAL — task is ${taskStatus}`, signals };
  }

  // Hard blocks need operator action and take precedence over an idle turn
  // state the block may have left behind.
  if (anomalyType === 'permission_blocked' || turnState === 'blocked') {
    return {
      state: 'blocked',
      headline: 'BLOCKED — needs operator action (permission request or a blocked turn)',
      signals,
    };
  }

  // A deliberate, legitimate pause. This is the case the false-idle bug
  // misread: the agent finished its turn cleanly and is awaiting a follow-up.
  if (
    anomalyType === 'needs_input' ||
    turnState === 'completed_turn' ||
    turnState === 'waiting_for_input' ||
    classification === 'healthy-idle'
  ) {
    const asked = anomalySubType === 'ask_user_question' || turnState === 'waiting_for_input';
    return {
      state: 'awaiting-operator',
      headline: asked
        ? 'AWAITING OPERATOR — the agent asked a question. Read its last message below.'
        : 'AWAITING OPERATOR — the agent paused at a turn boundary. Read its last message below before assuming it stalled.',
      signals,
    };
  }

  if (classification && STALLED_CLASSIFICATIONS.has(classification)) {
    return { state: 'possibly-hung', headline: `POSSIBLY HUNG — session health is ${classification}`, signals };
  }

  if (turnState === 'running' || classification === 'healthy-working') {
    return { state: 'working', headline: 'WORKING — actively executing its current turn', signals };
  }

  return {
    state: 'unknown',
    headline: 'UNKNOWN — insufficient signals to classify; read the last message below',
    signals,
  };
}

/** The last `assistant` text message, and any `user` text messages after it. */
export interface LastMessageView {
  /** The agent's final assistant turn — all its text blocks, in order, joined. */
  lastAssistant?: string;
  /** Operator/user replies delivered after that final assistant turn. */
  repliesAfter: string[];
}

export function extractLastMessageView(messages: TranscriptMessage[]): LastMessageView {
  // Anchor on the LAST assistant text block, then walk back to recover the rest
  // of the same turn: a provider splits one assistant turn into several text
  // blocks around its tool calls (text → tool_use → concluding text), and only
  // a user message delimits a new turn. Concatenating the turn's blocks — rather
  // than printing the final block alone — is what makes "the full last message"
  // literally true for a multi-block final turn. Tool calls/results and
  // truncation markers between blocks are skipped, not treated as boundaries.
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'assistant') {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return { repliesAfter: [] };

  const parts: string[] = [];
  for (let i = lastIdx; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'user') break; // previous turn boundary
    if (m.kind === 'text' && m.role === 'assistant') parts.unshift(m.text);
  }
  const lastAssistant = parts.join('\n\n');

  const repliesAfter: string[] = [];
  for (let i = lastIdx + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.kind === 'text' && m.role === 'user' && m.text.trim().length > 0) {
      repliesAfter.push(m.text);
    }
  }
  return { lastAssistant, repliesAfter };
}

/**
 * Cap a message for display while PRESERVING THE TAIL — the operative
 * conclusion agents place at the end. The direct inverse of the `.slice(0, N)`
 * head-truncation that caused the false-idle bug. Returns the full text
 * unchanged when it is within `maxChars` or no cap is given.
 */
export function capKeepingTail(text: string, maxChars?: number): string {
  if (maxChars === undefined || text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `…[${omitted} earlier char(s) omitted — showing the tail]\n${text.slice(text.length - maxChars)}`;
}

export interface PeekCliIo {
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

function emitJson(
  out: { log: (...args: unknown[]) => void },
  payload: { ok: boolean; code: string; message: string; details?: unknown },
): void {
  out.log(JSON.stringify(payload));
}

export async function runPeekCli(argv: string[], io: PeekCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const out = io.out ?? console;
  const err = io.err ?? console;
  const fetchImpl = io.fetchImpl ?? fetch;

  const args = parsePeekArgs(argv);
  if (args.help) {
    out.log(PEEK_HELP_TEXT);
    return EXIT_OK;
  }

  const userError = (message: string, details?: Record<string, unknown>): number => {
    if (args.json) {
      emitJson(out, { ok: false, code: 'USER_ERROR', message, details: { subcommand: 'peek', ...details } });
    } else {
      err.error(`kookr peek: ${message}`);
      err.error('Run `kookr peek --help` for usage.');
    }
    return EXIT_USER_ERROR;
  };

  if (args.error) return userError(args.error);
  // Type-narrowing only: parsePeekArgs already returns an `error` (handled just
  // above) when no positional was given, so this branch never fires at runtime.
  const taskRef = args.taskRef;
  if (taskRef === undefined) return userError('a <taskId|name> is required.');

  const resolvedBase = await resolveStopBaseUrl({ env, fetchImpl });
  if (resolvedBase.kind === 'invalid_port') {
    return userError(`KOOKR_PORT must be an integer in 1..65535 (got: ${resolvedBase.raw})`);
  }
  if (resolvedBase.kind === 'ambiguous') {
    const [a, b] = resolvedBase.ports;
    const message = `two Kookr instances are reachable on :${a} and :${b}. Set KOOKR_PORT to choose one.`;
    if (args.json) emitJson(out, { ok: false, code: 'AMBIGUOUS_PORT', message, details: { ports: resolvedBase.ports } });
    else err.error(`kookr peek: ${message}`);
    return EXIT_AMBIGUOUS;
  }
  if (resolvedBase.kind === 'none') {
    const message = `no Kookr server reachable (checked ports ${PORTS_TO_TRY.join(', ')}). Start the server or set KOOKR_PORT / KOOKR_API_BASE_URL.`;
    if (args.json) emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'peek' } });
    else err.error(`kookr peek: ${message}`);
    return EXIT_NO_SERVER;
  }
  const baseUrl = resolvedBase.baseUrl;

  // --- 1. Snapshot: resolve the ref to a canonical task and its run-state. ---
  let agent: PeekSnapshotAgent | undefined;
  try {
    const res = await fetchImpl(`${baseUrl}/api/snapshot`, {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const message = `failed to read the task snapshot (server returned HTTP ${res.status}).`;
      if (args.json) emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { status: res.status } });
      else err.error(`kookr peek: ${message}`);
      return EXIT_SERVER_ERROR;
    }
    const body = await res.json();
    if (!isPeekSnapshotAgentArray(body)) {
      const message = 'unexpected /api/snapshot response (expected an array of agent states).';
      if (args.json) emitJson(out, { ok: false, code: 'SERVER_ERROR', message });
      else err.error(`kookr peek: ${message}`);
      return EXIT_SERVER_ERROR;
    }
    const matches = body.filter((a) => a.taskId === taskRef || a.taskName === taskRef);
    // Prefer a live (non-terminal) match; a name may be shared with history.
    const live = matches.filter((a) => a.taskStatus === undefined || !isTerminalStatus(a.taskStatus));
    const pool = live.length > 0 ? live : matches;
    if (pool.length > 1) {
      const candidates = pool.map((c) => ({ agentId: c.agentId, taskId: c.taskId, taskName: c.taskName, taskStatus: c.taskStatus }));
      const message = `${pool.length} tasks matched ref '${taskRef}'. Address one by its taskId to disambiguate.`;
      if (args.json) emitJson(out, { ok: false, code: 'AMBIGUOUS_TASK', message, details: { taskRef, candidates } });
      else {
        err.error(`kookr peek: ${message}`);
        for (const c of candidates) err.error(`  ${c.taskId ?? '?'}  ${c.taskName ?? ''}  ${c.taskStatus ?? ''}`);
      }
      return EXIT_AMBIGUOUS;
    }
    agent = pool[0];
  } catch (fetchErr) {
    const detail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const message = `no Kookr server reachable at ${baseUrl}: ${detail}`;
    if (args.json) emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'peek', baseUrl } });
    else err.error(`kookr peek: ${message}`);
    return EXIT_NO_SERVER;
  }

  // The transcript endpoint is keyed by task id. Use the resolved agent's id
  // when the ref was a name; otherwise fall back to the ref (it is an id, or a
  // terminal/aged task absent from the live snapshot).
  const taskId = agent?.taskId ?? taskRef;

  // --- 2. Transcript: the full last assistant message (authoritative). ---
  let transcript: TranscriptResponse;
  try {
    const url = new URL(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/transcript`);
    if (args.session) url.searchParams.set('sessionId', args.session);
    const res = await fetchImpl(url.toString(), {
      headers: authHeaders(env),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The server 404s both for an unknown task and for a `--session` that does
      // not exist on an otherwise-valid task; name the session so the operator
      // is not told "no task found" when the task is fine and the session is not.
      const message = args.session
        ? `no task or session found for ref '${taskRef}' (session '${args.session}').`
        : `no task found for ref '${taskRef}'.`;
      if (args.json) {
        emitJson(out, { ok: false, code: 'NO_TASK', message, details: { subcommand: 'peek', taskRef, session: args.session } });
      } else {
        err.error(`kookr peek: ${message}`);
        err.error('Run `kookr peek --help` for usage.');
      }
      return EXIT_USER_ERROR;
    }
    if (!res.ok) {
      const message = `failed to read the transcript (server returned HTTP ${res.status}).`;
      if (args.json) emitJson(out, { ok: false, code: 'SERVER_ERROR', message, details: { status: res.status } });
      else err.error(`kookr peek: ${message}`);
      return EXIT_SERVER_ERROR;
    }
    transcript = (await res.json()) as TranscriptResponse;
  } catch (fetchErr) {
    const detail = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const message = `no Kookr server reachable at ${baseUrl}: ${detail}`;
    if (args.json) emitJson(out, { ok: false, code: 'NO_SERVER', message, details: { subcommand: 'peek', baseUrl } });
    else err.error(`kookr peek: ${message}`);
    return EXIT_NO_SERVER;
  }

  // The transcript body is otherwise an unvalidated cast; the `in` checks below
  // would throw a TypeError on a non-object 200 body (null / string / number).
  // Guard it the way the snapshot path guards its own body, so a malformed
  // response is a clean SERVER_ERROR rather than an uncaught crash.
  if (typeof transcript !== 'object' || transcript === null) {
    const message = 'unexpected transcript response (expected a JSON object).';
    if (args.json) emitJson(out, { ok: false, code: 'SERVER_ERROR', message });
    else err.error(`kookr peek: ${message}`);
    return EXIT_SERVER_ERROR;
  }

  const verdict = deriveRunState({
    taskStatus: agent?.taskStatus,
    turnState: agent?.turnState,
    anomalyType: agent?.anomaly?.type,
    anomalySubType: agent?.anomaly?.subType,
    classification: agent?.sessionHealth?.classification,
  });

  const unavailableReason = 'unavailable' in transcript ? transcript.unavailable.reason : undefined;
  const messages = 'messages' in transcript ? transcript.messages : [];
  const view = extractLastMessageView(messages);

  if (args.json) {
    out.log(
      JSON.stringify({
        ok: true,
        code: 'OK',
        message: verdict.headline,
        details: {
          taskId,
          taskName: agent?.taskName,
          agentId: agent?.agentId,
          runState: verdict.state,
          headline: verdict.headline,
          signals: verdict.signals,
          anomalyExplanation: agent?.anomaly?.explanation,
          transcriptSource: 'source' in transcript ? transcript.source : undefined,
          transcriptUnavailable: unavailableReason,
          // Apply --max-chars (tail-kept) in JSON too, so the flag behaves the
          // same way it does in the human output. Without a cap this is a no-op.
          lastAssistantMessage: view.lastAssistant === undefined
            ? undefined
            : capKeepingTail(view.lastAssistant, args.maxChars),
          repliesAfter: view.repliesAfter.map((r) => capKeepingTail(r, args.maxChars)),
        },
      }),
    );
    return EXIT_OK;
  }

  out.log(`Task ${taskId}${agent?.taskName ? ` — ${agent.taskName}` : ''}`);
  out.log('');
  out.log(`Run-state: ${verdict.headline}`);
  const s = verdict.signals;
  const signalBits = [
    s.turnState ? `turnState=${s.turnState}` : undefined,
    s.classification ? `sessionHealth=${s.classification}` : undefined,
    s.anomalyType ? `anomaly=${s.anomalyType}${s.anomalySubType ? `/${s.anomalySubType}` : ''}` : undefined,
    s.taskStatus ? `taskStatus=${s.taskStatus}` : undefined,
  ].filter(Boolean);
  out.log(`  signals: ${signalBits.length > 0 ? signalBits.join('  ') : '(task not in live snapshot)'}  ·  (not a heartbeat)`);
  if (agent?.anomaly?.explanation) out.log(`  note: ${agent.anomaly.explanation}`);
  out.log('');

  if (view.lastAssistant === undefined) {
    const why = unavailableReason ? ` (transcript unavailable: ${unavailableReason})` : '';
    out.log(`No assistant message found in the transcript${why}.`);
    return EXIT_OK;
  }

  out.log('Last assistant message (full):');
  out.log('────────────────────────────────────────────────────────');
  out.log(capKeepingTail(view.lastAssistant, args.maxChars));
  out.log('────────────────────────────────────────────────────────');

  if (view.repliesAfter.length > 0) {
    out.log('');
    out.log(`Operator/user message(s) delivered AFTER that (${view.repliesAfter.length}):`);
    for (const reply of view.repliesAfter) {
      out.log('  ┄┄┄');
      out.log(capKeepingTail(reply, args.maxChars).split('\n').map((l) => `  ${l}`).join('\n'));
    }
  }
  return EXIT_OK;
}
