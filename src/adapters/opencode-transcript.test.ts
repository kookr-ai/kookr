import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENCODE_TOOL_TEXT_MAX_BYTES,
  OPENCODE_TRANSCRIPT_READ_MAX_BYTES,
  readOpenCodeDbTranscript,
  readOpenCodeTaskTranscript,
} from './opencode-transcript.js';
import { TRANSCRIPT_MAX_MESSAGE_BYTES } from '../core/transcript-normalizer.js';
import type { TranscriptMessage } from '../shared/contracts/transcript.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-transcript-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Real opencode column names: message(id, session_id, time_created, time_updated, data), part(+ message_id). */
function makeDb(path: string) {
  const db = new Database(path);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
           CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);
           CREATE INDEX part_message_id_id_idx ON part (message_id, id);`);
  const msg = (id: string, ses: string, t: number, role: string) =>
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, ses, t, t, JSON.stringify({ role, time: { created: t } }));
  const part = (id: string, mid: string, ses: string, t: number, data: unknown) =>
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run(id, mid, ses, t, t, typeof data === 'string' ? data : JSON.stringify(data));
  return { db, msg, part };
}

describe('readOpenCodeDbTranscript', () => {
  it('returns user and assistant text in order, skipping step/ignored/non-string parts and empty messages', async () => {
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
    part('p7', 'm3', 'ses_a', 3002, { type: 'text', text: 'hidden', ignored: true });
    part('p8', 'm3', 'ses_a', 3003, { type: 'text', text: 123 }); // not a string: skipped
    msg('m4', 'ses_a', 4000, 'assistant'); // in-flight, no text yet
    db.close();
    const out = await readOpenCodeDbTranscript(p);
    expect(out?.map((m) => (m.kind === 'text' ? `${m.role}:${m.text}` : m.kind === 'tool_call' ? `call:${m.name}` : m.kind))).toEqual([
      'user:fix the bug',
      'assistant:looking',
      'call:bash', // a tool part with no state yet: the call alone
      'assistant:Done.\n\nChanged x.',
    ]);
    expect(out?.[3]).toMatchObject({ timestamp: new Date(3000).toISOString() });
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

  it('reads only the newest 1000 message rows, still returned oldest first', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    db.transaction(() => {
      for (let i = 1; i <= 1005; i++) {
        const id = `m${String(i).padStart(4, '0')}`;
        msg(id, 'ses_a', i, 'assistant');
        part(`p${id}`, id, 'ses_a', i, { type: 'text', text: `t${i}` });
      }
    })();
    db.close();
    for (const sid of ['ses_a', undefined]) {
      const out = await readOpenCodeDbTranscript(p, sid);
      expect(out).toHaveLength(1001);
      expect(out?.[0]).toMatchObject({ kind: 'truncation_marker' }); // older rows were left out
      expect(out?.[1]).toMatchObject({ kind: 'text', text: 't6' });
      expect(out?.[1000]).toMatchObject({ kind: 'text', text: 't1005' });
    }
  });

  it('cuts an oversized message to the per-message byte cap and flags it with a truncation marker', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1, 'assistant');
    part('p1', 'm1', 'ses_a', 1, { type: 'text', text: 'é'.repeat(TRANSCRIPT_MAX_MESSAGE_BYTES) }); // 2 bytes per char
    msg('m2', 'ses_a', 2, 'assistant');
    part('p2', 'm2', 'ses_a', 2, { type: 'text', text: 'a'.repeat(TRANSCRIPT_MAX_MESSAGE_BYTES) }); // exactly at the cap
    db.close();
    const out = await readOpenCodeDbTranscript(p);
    expect(out?.map((m) => m.kind)).toEqual(['text', 'truncation_marker', 'text']);
    const first = out?.[0];
    expect(first?.kind === 'text' && first.text).toBe('é'.repeat(TRANSCRIPT_MAX_MESSAGE_BYTES / 2));
    const last = out?.[2];
    expect(last?.kind === 'text' && last.text.length).toBe(TRANSCRIPT_MAX_MESSAGE_BYTES);
  });

  it('interleaves tool calls and their results with the text, in part order, per tool state', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1000, 'assistant');
    part('p1', 'm1', 'ses_a', 1000, { type: 'text', text: 'first' });
    part('p2', 'm1', 'ses_a', 1001, { type: 'text', text: 'second' }); // same run: joined
    part('p3', 'm1', 'ses_a', 1002, {
      type: 'tool', tool: 'bash', callID: 'c1',
      state: { status: 'completed', input: { command: 'ls' }, output: 'a\nb', metadata: { exit: 0 }, title: 'ls', time: { start: 1, end: 2 } },
    });
    part('p4', 'm1', 'ses_a', 1003, {
      type: 'tool', tool: 'read', callID: 'c2',
      state: { status: 'error', input: { filePath: '/x' }, error: 'File not found: /x', time: { start: 1, end: 2 } },
    });
    // A running tool with an output string still gets no result: only completed/error carry one.
    part('p5', 'm1', 'ses_a', 1004, { type: 'tool', tool: 'edit', callID: 'c3', state: { status: 'running', input: { filePath: '/y' }, output: 'partial', time: { start: 1 } } });
    part('p6', 'm1', 'ses_a', 1005, { type: 'tool', tool: 'grep', state: { status: 'pending', input: {}, raw: '' } });
    part('p7', 'm1', 'ses_a', 1006, { type: 'tool', tool: 'bash', state: { status: 'completed', input: 'not-an-object', output: 42 } }); // odd shapes
    part('p8', 'm1', 'ses_a', 1007, { type: 'tool', tool: ['x'], state: 'garbage' }); // malformed state: call only, unknown name
    part('p9', 'm1', 'ses_a', 1008, { type: 'text', text: 'after the tools' });
    db.close();
    const ts = new Date(1000).toISOString();
    expect(await readOpenCodeDbTranscript(p)).toEqual([
      { kind: 'text', role: 'assistant', text: 'first\nsecond', timestamp: ts },
      { kind: 'tool_call', name: 'bash', input: '{"command":"ls"}', timestamp: ts },
      { kind: 'tool_result', name: 'bash', text: 'a\nb', timestamp: ts },
      { kind: 'tool_call', name: 'read', input: '{"filePath":"/x"}', timestamp: ts },
      { kind: 'tool_result', name: 'read', text: 'File not found: /x', timestamp: ts },
      { kind: 'tool_call', name: 'edit', input: '{"filePath":"/y"}', timestamp: ts }, // still running: no result yet
      { kind: 'tool_call', name: 'grep', input: '{}', timestamp: ts },
      { kind: 'tool_call', name: 'bash', input: 'not-an-object', timestamp: ts }, // output not a string: no result
      { kind: 'tool_call', name: 'unknown', timestamp: ts },
      { kind: 'text', role: 'assistant', text: 'after the tools', timestamp: ts },
    ]);
  });

  it('cuts a long tool input silently and a long tool output with truncated: true', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    msg('m1', 'ses_a', 1, 'assistant');
    part('p1', 'm1', 'ses_a', 1, {
      type: 'tool', tool: 'write',
      // Prefix `{"cc":"` is 7 bytes (odd), so byte 4000 falls inside a 2-byte é: the cut must back off to 3999.
      state: { status: 'completed', input: { cc: 'é'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES) }, output: 'o'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES * 3) },
    });
    part('p2', 'm1', 'ses_a', 2, { type: 'tool', tool: 'bash', state: { status: 'completed', input: {}, output: 'k'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES) } });
    db.close();
    const out = await readOpenCodeDbTranscript(p);
    expect(out?.map((m) => m.kind)).toEqual(['tool_call', 'tool_result', 'tool_call', 'tool_result']);
    const call = out?.[0];
    expect(call?.kind === 'tool_call' && call.input).toBe(`{"cc":"${'é'.repeat((OPENCODE_TOOL_TEXT_MAX_BYTES - 8) / 2)}`);
    expect(call?.kind === 'tool_call' && Buffer.byteLength(call.input ?? '', 'utf8')).toBe(OPENCODE_TOOL_TEXT_MAX_BYTES - 1);
    expect(out?.[1]).toEqual({ kind: 'tool_result', name: 'write', text: 'o'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES), truncated: true, timestamp: new Date(1).toISOString() });
    expect(out?.[3]).toEqual({ kind: 'tool_result', name: 'bash', text: 'k'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES), timestamp: new Date(1).toISOString() }); // at the cap: not cut
  });

  it('stops reading at the byte budget, keeping the newest messages behind a truncation marker', async () => {
    const p = join(dir, 'oc.db');
    const { db, msg, part } = makeDb(p);
    // Each message carries ~2 x 4 KB of tool text, so 900 messages (~7 MB) are far past the read budget but
    // under the 1000-row bound: only the byte budget can stop this read.
    const n = 900;
    db.transaction(() => {
      for (let i = 1; i <= n; i++) {
        const id = `m${String(i).padStart(4, '0')}`;
        msg(id, 'ses_a', i, 'assistant');
        part(`p${id}a`, id, 'ses_a', i, { type: 'text', text: `t${i}` });
        part(`p${id}b`, id, 'ses_a', i, {
          type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'x'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES) }, output: 'y'.repeat(OPENCODE_TOOL_TEXT_MAX_BYTES) },
        });
      }
    })();
    db.close();
    // Count the per-message part reads, to prove the read stops rather than reading all and trimming afterwards.
    let partReads = 0;
    const realPrepare = Database.prototype.prepare;
    const spy = vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
      const stmt = realPrepare.call(this, sql);
      if (!sql.includes('p.message_id = @mid')) return stmt;
      const all = stmt.all.bind(stmt);
      return Object.assign(Object.create(stmt), { all: (...args: unknown[]) => { partReads++; return all(...(args as [])); } });
    });
    let out: TranscriptMessage[];
    try {
      out = (await readOpenCodeDbTranscript(p))!;
    } finally {
      spy.mockRestore();
    }
    expect(partReads).toBeGreaterThan(100);
    expect(partReads).toBeLessThan(400); // ~2.5 MB / ~8 KB per message, far from all 900
    expect(out[0]).toMatchObject({ kind: 'truncation_marker' });
    expect(out.filter((m) => m.kind === 'truncation_marker')).toHaveLength(1);
    expect(out.reduce((s, m) => s + JSON.stringify(m).length, 0)).toBeLessThanOrEqual(OPENCODE_TRANSCRIPT_READ_MAX_BYTES + 200);
    const texts = out.flatMap((m) => (m.kind === 'text' ? [m.text] : []));
    expect(texts.at(-1)).toBe(`t${n}`); // the newest message survives
    expect(texts.length).toBeGreaterThan(100);
    expect(texts.length).toBeLessThan(n);
    // What is kept is a contiguous newest tail, still oldest first.
    const first = Number(texts[0].slice(1));
    expect(texts).toEqual(Array.from({ length: n - first + 1 }, (_, k) => `t${first + k}`));
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
