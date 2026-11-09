import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenCodeDbTranscript, readOpenCodeTaskTranscript } from './opencode-transcript.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-transcript-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Real opencode column names: message(id, session_id, time_created, time_updated, data), part(+ message_id). */
function makeDb(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  const msg = (id: string, ses: string, t: number, role: string) =>
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, ses, t, t, JSON.stringify({ role, time: { created: t } }));
  const part = (id: string, mid: string, ses: string, t: number, data: unknown) =>
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, mid, ses, t, t, typeof data === 'string' ? data : JSON.stringify(data));
  return { db, msg, part };
}

describe('readOpenCodeDbTranscript', () => {
  it('returns user and assistant text in order, skipping tool/step parts and empty messages', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1000, 'user');
    part('p1', 'm1', 'ses_a', 1000, { type: 'text', text: 'fix the bug' });
    msg('m2', 'ses_a', 2000, 'assistant');
    part('p2', 'm2', 'ses_a', 2000, { type: 'step-start' });
    part('p3', 'm2', 'ses_a', 2001, { type: 'text', text: 'looking' });
    part('p4', 'm2', 'ses_a', 2002, { type: 'tool', tool: 'bash' });
    msg('m3', 'ses_a', 3000, 'assistant');
    part('p5', 'm3', 'ses_a', 3000, { type: 'text', text: 'Done.\n\nChanged x.' });
    part('p6', 'm3', 'ses_a', 3001, { type: 'step-finish', reason: 'stop' });
    msg('m4', 'ses_a', 4000, 'assistant'); // in-flight, no text yet
    db.close();
    const out = await readOpenCodeDbTranscript(p);
    expect(out?.map((m) => (m.kind === 'text' ? `${m.role}:${m.text}` : m.kind))).toEqual([
      'user:fix the bug',
      'assistant:looking',
      'assistant:Done.\n\nChanged x.',
    ]);
    expect(out?.[2]).toMatchObject({ timestamp: new Date(3000).toISOString() });
  });

  it('filters by session id when given', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1, 'assistant'); part('p1', 'm1', 'ses_a', 1, { type: 'text', text: 'A' });
    msg('m2', 'ses_b', 2, 'assistant'); part('p2', 'm2', 'ses_b', 2, { type: 'text', text: 'B' });
    db.close();
    expect(await readOpenCodeDbTranscript(p, 'ses_a')).toEqual([{ kind: 'text', role: 'assistant', text: 'A', timestamp: new Date(1).toISOString() }]);
    expect((await readOpenCodeDbTranscript(p))?.length).toBe(2);
  });

  it('never throws: missing file, wrong schema, corrupt file, bad JSON all give undefined/skip', async () => {
    expect(await readOpenCodeDbTranscript(join(dir, 'nope.db'))).toBeUndefined();
    const wrong = join(dir, 'wrong.db');
    const w = new Database(wrong); w.exec('CREATE TABLE message (x INTEGER)'); w.close();
    expect(await readOpenCodeDbTranscript(wrong)).toBeUndefined();
    const corrupt = join(dir, 'corrupt.db');
    writeFileSync(corrupt, 'not a sqlite file at all');
    expect(await readOpenCodeDbTranscript(corrupt)).toBeUndefined();
    const p = join(dir, 'bad.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1, 'assistant'); part('p1', 'm1', 'ses_a', 1, '{broken'); part('p2', 'm1', 'ses_a', 2, { type: 'text', text: 'ok' });
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m0', 'ses_a', 0, 0, '{not json');
    db.close();
    expect((await readOpenCodeDbTranscript(p))?.map((m) => m.kind === 'text' && m.text)).toEqual(['ok']);
  });

  it('readOpenCodeTaskTranscript resolves the per-task DB path and rejects unsafe task ids quietly', async () => {
    const dbDir = join(dir, 'task-1', 'data', 'opencode');
    mkdirSync(dbDir, { recursive: true });
    const { db, msg, part } = makeDb(join(dbDir, 'opencode.db'));
    msg('m1', 'ses_a', 1, 'assistant'); part('p1', 'm1', 'ses_a', 1, { type: 'text', text: 'hello' });
    db.close();
    expect((await readOpenCodeTaskTranscript(dir, 'task-1', 'ses_a'))?.length).toBe(1);
    expect(await readOpenCodeTaskTranscript(dir, '../evil')).toBeUndefined();
    expect(await readOpenCodeTaskTranscript(dir, 'task-2')).toBeUndefined();
  });
});
