/**
 * Provider-neutral transcript for an opencode task, read from the task's persistent per-task opencode
 * DB (`<dataRoot>/<taskId>/data/opencode/opencode.db`).
 *
 * opencode keeps the conversation only in that sqlite DB (no JSONL transcript file like Claude/Codex/Grok),
 * so `GET /api/tasks/:id/transcript` -- and through it `kookr peek` -- had nothing to show for an opencode
 * worker. Schema (verified against a real DB): `message(id, session_id, time_created, data)` where `data` is
 * JSON with `role`; `part(id, message_id, session_id, time_created, data)` where a text part's `data` is
 * `{"type":"text","text":...}`.
 *
 * Read-only and never throws: any open/schema/parse failure yields `undefined` so the caller falls back to
 * its existing behaviour.
 */
import { existsSync } from 'node:fs';
import type { TranscriptMessage } from '../shared/contracts/transcript.js';
import { TRANSCRIPT_MAX_MESSAGE_BYTES } from '../core/transcript-normalizer.js';
import { openCodeDbPathForDataHome } from './opencode-usage-scanner.js';
import { openCodeTaskDataHome, openCodeTaskDir } from './opencode-task-data.js';

/**
 * Row bound: only the newest MAX_MESSAGE_ROWS user/assistant message rows are read (picked in SQL, so a large DB
 * is never read whole; reading it all used to block the event loop for about a second), and only their text parts are joined.
 * Tool-only messages count toward the bound, so a long tool-only tail can leave fewer text messages; peek only
 * needs the last turn, and the transcript route caps the response bytes afterwards.
 */
const MAX_MESSAGE_ROWS = 1000;

interface Row {
  mid: string;
  role: unknown;
  mtime: number;
  ptext: unknown;
  pignored: unknown;
}

/**
 * Size guard: the same per-message cap as the other providers' transcripts. SQL cuts each text part one character
 * past the cap, so a huge part never reaches JS in full; the joined text is then cut to the cap in bytes.
 */
function clipToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), cut: true };
}

/** Text messages (user + assistant, oldest first) of the opencode DB at `dbPath`; undefined when none/unreadable. */
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
    // The inner query walks opencode's (session_id, time_created, id) index newest-first and stops at the limit.
    const rows = db
      .prepare(
        `WITH recent AS (
           SELECT m.id AS mid, json_extract(m.data, '$.role') AS role, ${mTime ? 'm.time_created' : '0'} AS mtime
             FROM message m
            WHERE CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END IN ('user', 'assistant')
              ${filterSession ? 'AND m.session_id = @sid' : ''}
            ORDER BY ${mTime ? 'm.time_created DESC,' : ''} m.id DESC
            LIMIT @limit
         )
         SELECT r.mid AS mid, r.role AS role, r.mtime AS mtime,
                substr(json_extract(p.data, '$.text'), 1, @maxChars) AS ptext, json_extract(p.data, '$.ignored') AS pignored
           FROM recent r JOIN part p ON p.message_id = r.mid
          WHERE CASE WHEN json_valid(p.data)
                     THEN json_extract(p.data, '$.type') = 'text' AND json_type(p.data, '$.text') = 'text' END
          ORDER BY r.mtime, r.mid, ${pc.has('time_created') ? 'p.time_created,' : ''} p.id`,
      )
      .all({
        limit: MAX_MESSAGE_ROWS,
        maxChars: TRANSCRIPT_MAX_MESSAGE_BYTES + 1,
        ...(filterSession ? { sid: sessionId } : {}),
      }) as Row[];

    const byMessage = new Map<string, { role: 'user' | 'assistant'; time: number; texts: string[] }>();
    for (const r of rows) {
      if (r.role !== 'user' && r.role !== 'assistant') continue;
      if (typeof r.ptext !== 'string' || r.ptext.trim() === '' || r.pignored) continue;
      let entry = byMessage.get(r.mid);
      if (!entry) {
        entry = { role: r.role, time: r.mtime, texts: [] };
        byMessage.set(r.mid, entry);
      }
      entry.texts.push(r.ptext);
    }
    const messages: TranscriptMessage[] = [];
    for (const e of byMessage.values()) {
      const { text, cut } = clipToBytes(e.texts.join('\n'), TRANSCRIPT_MAX_MESSAGE_BYTES);
      messages.push({
        kind: 'text',
        role: e.role,
        text,
        ...(e.time > 0 ? { timestamp: new Date(e.time).toISOString() } : {}),
      });
      if (cut) {
        messages.push({ kind: 'truncation_marker', note: `A message exceeded ${TRANSCRIPT_MAX_MESSAGE_BYTES} bytes and was truncated.` });
      }
    }
    return messages.length > 0 ? messages : undefined;
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
