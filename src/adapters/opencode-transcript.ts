/**
 * Provider-neutral transcript for an opencode task, read from the task's persistent per-task opencode
 * DB (`<dataRoot>/<taskId>/data/opencode/opencode.db`).
 *
 * opencode keeps the conversation only in that sqlite DB (no JSONL transcript file like Claude/Codex/Grok),
 * so `GET /api/tasks/:id/transcript` -- and through it `kookr peek` -- had nothing to show for an opencode
 * worker. Schema (verified against real DBs): `message(id, session_id, time_created, data)` where `data` is
 * JSON with `role`; `part(id, message_id, session_id, time_created, data)` where `data` is one of
 * - a text part `{"type":"text","text":...}`;
 * - a tool part `{"type":"tool","tool":"bash","state":{"status":...,"input":{...},"output":...,"error":...}}`,
 *   where `status` is `pending`/`running` (call only), `completed` (with `output`) or `error` (with `error`).
 * Other part types (step-start, step-finish, patch, ...) are skipped.
 *
 * Read-only and never throws: any open/schema/parse failure yields `undefined` so the caller falls back to
 * its existing behaviour.
 */
import { existsSync } from 'node:fs';
import type { TranscriptMessage } from '../shared/contracts/transcript.js';
import { TRANSCRIPT_MAX_MESSAGE_BYTES, capMessagesKeepingTail } from '../core/transcript-normalizer.js';
import { openCodeDbPathForDataHome } from './opencode-usage-scanner.js';
import { openCodeTaskDataHome, openCodeTaskDir } from './opencode-task-data.js';

/**
 * Row bound: at most the newest MAX_MESSAGE_ROWS user/assistant message rows are considered (picked in SQL, so
 * a large DB is never read whole; reading it all used to block the event loop for about a second).
 */
const MAX_MESSAGE_ROWS = 1000;

/**
 * Byte bound: messages are read newest first, one message's parts at a time, and reading stops once the
 * transcript built so far exceeds this many bytes (JSON size). The oldest messages are then dropped behind a
 * truncation marker. Kept above the transcript route's own 2 MB tail cap, so that cap stays the one that
 * decides what is shown; this one only stops a tool-heavy DB from being pulled into memory whole.
 */
export const OPENCODE_TRANSCRIPT_READ_MAX_BYTES = 2_500_000;

/**
 * Size guard for one tool call's input or one tool result's text. Far below the 20 KB text cap: a worker makes
 * many tool calls per turn, and full outputs would push the turn's own text out of the tail the route keeps.
 * A cut result is flagged `truncated`; a cut input is cut silently (as the stored snapshots do).
 */
export const OPENCODE_TOOL_TEXT_MAX_BYTES = 4_000;

interface MessageRow {
  mid: string;
  role: unknown;
  mtime: number;
}

interface PartRow {
  ptype: unknown;
  ptext: unknown;
  pignored: unknown;
  tool: unknown;
  status: unknown;
  tinput: unknown;
  toutput: unknown;
  terror: unknown;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes. SQL already cut it to `maxBytes + 1` characters. */
function clipToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), cut: true };
}

/**
 * The transcript messages of one opencode message, in part order. Consecutive text parts are joined into one
 * text message; a tool part ends the run and adds a `tool_call`, plus a `tool_result` once it has finished.
 */
function messagesOfParts(role: 'user' | 'assistant', time: number, parts: PartRow[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  const timestamp = time > 0 ? { timestamp: new Date(time).toISOString() } : {};
  let texts: string[] = [];
  const flushText = () => {
    if (texts.length === 0) return;
    const { text, cut } = clipToBytes(texts.join('\n'), TRANSCRIPT_MAX_MESSAGE_BYTES);
    texts = [];
    out.push({ kind: 'text', role, text, ...timestamp });
    if (cut) {
      out.push({ kind: 'truncation_marker', note: `A message exceeded ${TRANSCRIPT_MAX_MESSAGE_BYTES} bytes and was truncated.` });
    }
  };
  for (const p of parts) {
    if (p.ptype === 'text') {
      if (typeof p.ptext === 'string' && p.ptext.trim() !== '' && !p.pignored) texts.push(p.ptext);
      continue;
    }
    if (p.ptype !== 'tool') continue;
    flushText();
    const name = typeof p.tool === 'string' && p.tool.trim() !== '' ? p.tool : 'unknown';
    const input = typeof p.tinput === 'string' ? clipToBytes(p.tinput, OPENCODE_TOOL_TEXT_MAX_BYTES).text : undefined;
    out.push({ kind: 'tool_call', name, ...(input !== undefined ? { input } : {}), ...timestamp });
    const resultText = p.status === 'completed' ? p.toutput : p.status === 'error' ? p.terror : undefined;
    if (typeof resultText === 'string') {
      const { text, cut } = clipToBytes(resultText, OPENCODE_TOOL_TEXT_MAX_BYTES);
      out.push({ kind: 'tool_result', name, text, ...(cut ? { truncated: true } : {}), ...timestamp });
    }
  }
  flushText();
  return out;
}

/**
 * Text and tool messages (user + assistant, oldest first) of the opencode DB at `dbPath`; undefined when
 * none/unreadable.
 */
export async function readOpenCodeDbTranscript(dbPath: string, sessionId?: string): Promise<TranscriptMessage[] | undefined> {
  if (!existsSync(dbPath)) return undefined;
  let db: import('better-sqlite3').Database | undefined;
  try {
    const { default: Database } = await import('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 500 });
    const cols = (t: string) =>
      new Set((db!.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as Array<{ name: string }>).map((c) => c.name));
    const mc = cols('message');
    const pc = cols('part');
    if (!mc.has('data') || !mc.has('id') || !pc.has('data') || !pc.has('message_id')) return undefined;
    const filterSession = Boolean(sessionId && /^ses_[A-Za-z0-9]+$/.test(sessionId) && mc.has('session_id'));
    const mTime = mc.has('time_created');
    // Walks opencode's (session_id, time_created, id) index newest-first and stops at the limit. No part data is
    // read here.
    const messageRows = db
      .prepare(
        `SELECT m.id AS mid, json_extract(m.data, '$.role') AS role, ${mTime ? 'm.time_created' : '0'} AS mtime
           FROM message m
          WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END IN ('user', 'assistant')
            ${filterSession ? 'AND m.session_id = @sid' : ''}
          ORDER BY ${mTime ? 'm.time_created DESC,' : ''} m.id DESC
          LIMIT @limit`,
      )
      .all({ limit: MAX_MESSAGE_ROWS, ...(filterSession ? { sid: sessionId } : {}) }) as MessageRow[];
    // One message's text and tool parts, through opencode's (message_id, id) index. Every JSON call sits behind
    // json_valid (the WHERE CASE), so a corrupt part is skipped instead of failing the read; each string is cut
    // in SQL one character past its byte cap, so a huge part never reaches JS whole.
    const partsOf = db.prepare(
      `SELECT json_extract(p.data, '$.type') AS ptype,
              CASE WHEN json_type(p.data, '$.text') = 'text' THEN substr(json_extract(p.data, '$.text'), 1, @textChars) END AS ptext,
              json_extract(p.data, '$.ignored') AS pignored,
              CASE WHEN json_type(p.data, '$.tool') = 'text' THEN substr(json_extract(p.data, '$.tool'), 1, 200) END AS tool,
              json_extract(p.data, '$.state.status') AS status,
              CASE WHEN json_type(p.data, '$.state.input') IN ('object', 'array', 'text')
                   THEN substr(json_extract(p.data, '$.state.input'), 1, @toolChars) END AS tinput,
              CASE WHEN json_type(p.data, '$.state.output') = 'text' THEN substr(json_extract(p.data, '$.state.output'), 1, @toolChars) END AS toutput,
              CASE WHEN json_type(p.data, '$.state.error') = 'text' THEN substr(json_extract(p.data, '$.state.error'), 1, @toolChars) END AS terror
         FROM part p
        WHERE p.message_id = @mid
          AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') IN ('text', 'tool') END
        ORDER BY ${pc.has('time_created') ? 'p.time_created,' : ''} p.id`,
    );

    const newestFirst: TranscriptMessage[][] = [];
    let total = 0;
    let overBudget = false;
    for (const m of messageRows) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const parts = partsOf.all({
        mid: m.mid,
        textChars: TRANSCRIPT_MAX_MESSAGE_BYTES + 1,
        toolChars: OPENCODE_TOOL_TEXT_MAX_BYTES + 1,
      }) as PartRow[];
      const msgs = messagesOfParts(m.role, m.mtime, parts);
      if (msgs.length === 0) continue;
      newestFirst.push(msgs);
      for (const x of msgs) total += JSON.stringify(x).length;
      if (total > OPENCODE_TRANSCRIPT_READ_MAX_BYTES) {
        overBudget = true;
        break;
      }
    }
    const messages = newestFirst.reverse().flat();
    if (messages.length === 0) return undefined;
    // Past the budget: keep the newest messages that fit and mark the cut (the newest one always survives).
    return overBudget ? capMessagesKeepingTail(messages, OPENCODE_TRANSCRIPT_READ_MAX_BYTES) : messages;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Convenience for the route: resolve the task's DB under `dataRoot`. Never throws. */
export async function readOpenCodeTaskTranscript(
  dataRoot: string,
  taskId: string,
  sessionId?: string,
): Promise<TranscriptMessage[] | undefined> {
  try {
    const dbPath = openCodeDbPathForDataHome(openCodeTaskDataHome(openCodeTaskDir(dataRoot, taskId)));
    return await readOpenCodeDbTranscript(dbPath, sessionId);
  } catch {
    return undefined;
  }
}
