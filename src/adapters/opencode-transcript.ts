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
import { openCodeDbPathForDataHome } from './opencode-usage-scanner.js';
import { openCodeTaskDataHome, openCodeTaskDir } from './opencode-task-data.js';

/** Only the tail of a long conversation is returned; peek only needs the last turn. */
const MAX_MESSAGES = 400;

interface Row {
  mid: string;
  mdata: string;
  mtime: number;
  pdata: string | null;
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
    const rows = db
      .prepare(
        `SELECT m.id AS mid, m.data AS mdata, ${mc.has('time_created') ? 'm.time_created' : '0'} AS mtime, p.data AS pdata
           FROM message m LEFT JOIN part p ON p.message_id = m.id
          ${filterSession ? 'WHERE m.session_id = @sid' : ''}
          ORDER BY ${mc.has('time_created') ? 'm.time_created,' : ''} m.id, ${pc.has('time_created') ? 'p.time_created,' : ''} p.id`,
      )
      .all(filterSession ? { sid: sessionId } : {}) as Row[];

    const byMessage = new Map<string, { role: 'user' | 'assistant'; time: number; texts: string[] }>();
    for (const r of rows) {
      let entry = byMessage.get(r.mid);
      if (!entry) {
        let role: unknown;
        try {
          role = (JSON.parse(r.mdata) as { role?: unknown }).role;
        } catch {
          continue;
        }
        if (role !== 'user' && role !== 'assistant') continue;
        entry = { role, time: r.mtime, texts: [] };
        byMessage.set(r.mid, entry);
      }
      if (!r.pdata) continue;
      try {
        const part = JSON.parse(r.pdata) as { type?: unknown; text?: unknown; synthetic?: unknown; ignored?: unknown };
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '' && !part.ignored) {
          entry.texts.push(part.text);
        }
      } catch {
        /* skip an unparseable part */
      }
    }
    const messages: TranscriptMessage[] = [];
    for (const e of byMessage.values()) {
      if (e.texts.length === 0) continue;
      messages.push({
        kind: 'text',
        role: e.role,
        text: e.texts.join('\n'),
        ...(e.time > 0 ? { timestamp: new Date(e.time).toISOString() } : {}),
      });
    }
    return messages.length > 0 ? messages.slice(-MAX_MESSAGES) : undefined;
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
