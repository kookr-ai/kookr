import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureOpenCodeTaskTranscript,
  captureTaskTranscript,
  deleteTaskTranscripts,
  hasCompleteSnapshot,
  readSnapshotMeta,
  readStoredTranscript,
  selectExpiredTranscriptTaskDirs,
} from './transcript-store.js';

const SECRET = 'DATABASE_URL=postgres://u:p@h';

function vendorLines(extra = 0): string {
  const lines = [
    { type: 'user', message: { content: 'hello there' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: `config is ${SECRET}/db` },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'TOP_SECRET_FILE_LISTING' }] } },
  ];
  for (let i = 0; i < extra; i++) lines.push({ type: 'user', message: { content: `more ${i}` } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('transcript-store', () => {
  let root: string;
  let dir: string;
  let vendor: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcript-store-'));
    dir = join(root, 'transcripts');
    vendor = join(root, 'vendor.jsonl');
    await writeFile(vendor, vendorLines());
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cap = (now?: Date) =>
    captureTaskTranscript({ transcriptsDir: dir, taskId: 'task1', sessionId: 'sess1', vendorTranscriptPath: vendor, ...(now ? { now: () => now } : {}) });

  it('reports vendor_absent and no snapshot before capture', async () => {
    expect(await captureTaskTranscript({ transcriptsDir: dir, taskId: 'task1', sessionId: 's', vendorTranscriptPath: join(root, 'nope') })).toEqual({ outcome: 'vendor_absent' });
    expect(await hasCompleteSnapshot(dir, 'task1', 'sess1')).toBe(false);
    expect(await readStoredTranscript(dir, 'task1', 'sess1')).toBeUndefined();
  });

  it('captures, round-trips, omits tool results and redacts secrets', async () => {
    const r = await cap();
    expect(r.outcome).toBe('captured');
    expect(await hasCompleteSnapshot(dir, 'task1', 'sess1')).toBe(true);
    const msgs = await readStoredTranscript(dir, 'task1', 'sess1');
    expect(msgs).toEqual([
      { kind: 'text', role: 'user', text: 'hello there' },
      expect.objectContaining({ kind: 'text', role: 'assistant' }),
      { kind: 'tool_call', name: 'Bash', input: expect.any(String) },
      { kind: 'tool_result', name: 'Bash', text: '[tool result omitted]', truncated: true },
    ]);
    const raw = gunzipSync(await readFile(join(dir, 'task1', 'sess1.jsonl.gz'))).toString('utf8');
    expect(raw).not.toContain('TOP_SECRET_FILE_LISTING');
    expect(raw).not.toContain('postgres://u:p@h');
    const meta = await readSnapshotMeta(dir, 'task1', 'sess1');
    expect(meta).toMatchObject({ schemaVersion: 1, complete: true, messageCount: 4, source: 'vendor' });
    expect(meta?.consumedVendorOffsetBytes).toBe((await stat(vendor)).size);
    expect(meta?.vendor?.sizeBytes).toBe((await stat(vendor)).size);
  });

  it('retains provider timestamps in stored conversation messages', async () => {
    await writeFile(vendor, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-04T11:30:00Z', message: { content: [
        { type: 'text', text: 'dated answer' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      ] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-11-04T11:31:00Z', message: { content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
      ] } }),
    ].join('\n') + '\n');
    await cap();
    expect(await readStoredTranscript(dir, 'task1', 'sess1')).toEqual([
      { kind: 'text', role: 'assistant', text: 'dated answer', timestamp: '2026-11-04T11:30:00.000Z' },
      { kind: 'tool_call', name: 'Bash', input: '{"command":"pwd"}', timestamp: '2026-11-04T11:30:00.000Z' },
      { kind: 'tool_result', name: 'Bash', text: '[tool result omitted]', truncated: true, timestamp: '2026-11-04T11:31:00.000Z' },
    ]);
  });

  it('is idempotent when the vendor fingerprint is unchanged', async () => {
    await cap();
    const before = await readFile(join(dir, 'task1', 'sess1.jsonl.gz'));
    const metaBefore = await readFile(join(dir, 'task1', 'sess1.meta.json'), 'utf8');
    expect(await cap()).toEqual({ outcome: 'already_captured' });
    expect((await readFile(join(dir, 'task1', 'sess1.jsonl.gz'))).equals(before)).toBe(true);
    expect(await readFile(join(dir, 'task1', 'sess1.meta.json'), 'utf8')).toBe(metaBefore);
  });

  it('re-captures from scratch when the vendor file changes', async () => {
    await cap();
    await writeFile(vendor, vendorLines(5));
    const r = await cap();
    expect(r).toMatchObject({ outcome: 'captured', messageCount: 9 });
    const meta = await readSnapshotMeta(dir, 'task1', 'sess1');
    expect(meta?.complete).toBe(true);
    expect(meta?.vendor?.sizeBytes).toBe((await stat(vendor)).size);
    expect((await readStoredTranscript(dir, 'task1', 'sess1'))?.length).toBe(9);
  });

  it('tolerates corrupt data and rejects unsafe ids', async () => {
    await cap();
    await writeFile(join(dir, 'task1', 'sess1.jsonl.gz'), 'not gzip');
    expect(await readStoredTranscript(dir, 'task1', 'sess1')).toBeUndefined();
    expect(await captureTaskTranscript({ transcriptsDir: dir, taskId: '../x', sessionId: 's', vendorTranscriptPath: vendor })).toEqual({ outcome: 'invalid_id' });
  });

  it('deletes a task directory', async () => {
    await cap();
    await deleteTaskTranscripts(dir, 'task1');
    await expect(stat(join(dir, 'task1'))).rejects.toThrow();
    await expect(deleteTaskTranscripts(dir, 'task1')).resolves.toBeUndefined();
  });

  it('selects expired task dirs only', async () => {
    const now = new Date('2026-10-01T00:00:00Z');
    await captureTaskTranscript({ transcriptsDir: dir, taskId: 'old', sessionId: 's', vendorTranscriptPath: vendor, now: () => new Date('2026-01-01T00:00:00Z') });
    await captureTaskTranscript({ transcriptsDir: dir, taskId: 'fresh', sessionId: 's', vendorTranscriptPath: vendor, now: () => new Date('2026-09-25T00:00:00Z') });
    expect(await selectExpiredTranscriptTaskDirs(dir, 90, now)).toEqual(['old']);
    expect(await selectExpiredTranscriptTaskDirs(join(root, 'missing'), 90, now)).toEqual([]);
  });

  it('keeps the final assistant answer after >2MB of earlier tool-result-heavy content', async () => {
    const lines: unknown[] = [{ type: 'user', message: { content: 'start' } }];
    const big = 'q'.repeat(15_000);
    for (let i = 0; i < 300; i++) {
      lines.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { n: i } }] } });
      lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big }] } });
    }
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'FINAL ANSWER HERE' }] } });
    await writeFile(vendor, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect((await cap()).outcome).toBe('captured');
    const msgs = (await readStoredTranscript(dir, 'task1', 'sess1'))!;
    expect(msgs[msgs.length - 1]).toEqual({ kind: 'text', role: 'assistant', text: 'FINAL ANSWER HERE' });
    expect(msgs[0]).toEqual({ kind: 'text', role: 'user', text: 'start' });
  });
  it('drops earliest messages with a marker once stored bytes exceed the budget', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 400; i++) lines.push({ type: 'user', message: { content: `m${i} ` + 'word '.repeat(2_000).trim().split(' ').join('\n') } });
    lines.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'LAST' }] } });
    await writeFile(vendor, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await cap();
    const msgs = (await readStoredTranscript(dir, 'task1', 'sess1'))!;
    expect(msgs[0]).toMatchObject({ kind: 'truncation_marker' });
    expect(msgs[msgs.length - 1]).toMatchObject({ text: 'LAST' });
  });
});

describe('captureOpenCodeTaskTranscript (issue #3537)', () => {
  let root: string;
  let dir: string;
  let dbPath: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'transcript-store-oc-'));
    dir = join(root, 'transcripts');
    await mkdir(join(root, 'oc'), { recursive: true });
    dbPath = join(root, 'oc', 'opencode.db');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A minimal opencode DB (real schema columns) with one assistant turn: text, then a bash tool call + result. */
  function writeDb(text = `config is ${SECRET}/db`): void {
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
             CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m0', 'ses_abc', 1, 1, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p0', 'm0', 'ses_abc', 1, 1, JSON.stringify({ type: 'text', text: 'please list' }));
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m1', 'ses_abc', 5, 5, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p1', 'm1', 'ses_abc', 5, 5, JSON.stringify({ type: 'text', text }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p2', 'm1', 'ses_abc', 6, 6, JSON.stringify({
      type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'TOP_SECRET_FILE_LISTING' },
    }));
    // Another session's message in the same DB must not leak into this session's snapshot.
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run('m2', 'ses_other', 7, 7, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p3', 'm2', 'ses_other', 7, 7, JSON.stringify({ type: 'text', text: 'OTHER SESSION' }));
    db.close();
  }

  const params = () => ({ transcriptsDir: dir, taskId: 'task1', sessionId: 'sess1', dbPath, opencodeSessionId: 'ses_abc' });

  it('stores the DB conversation redacted, tool results omitted, with an opencode-db sidecar', async () => {
    writeDb();
    const res = await captureOpenCodeTaskTranscript(params());
    expect(res).toMatchObject({ outcome: 'captured', messageCount: 4 });
    const msgs = (await readStoredTranscript(dir, 'task1', 'sess1'))!;
    expect(msgs).toMatchObject([
      { kind: 'text', role: 'user', text: 'please list' },
      { kind: 'text', role: 'assistant' },
      { kind: 'tool_call', name: 'bash', input: '{"command":"ls"}' },
      { kind: 'tool_result', name: 'bash', text: '[tool result omitted]', truncated: true },
    ]);
    const raw = JSON.stringify(msgs);
    expect(raw).not.toContain('postgres://u:p@h');
    expect(raw).not.toContain('TOP_SECRET_FILE_LISTING');
    expect(raw).not.toContain('OTHER SESSION');
    const meta = (await readSnapshotMeta(dir, 'task1', 'sess1'))!;
    const st = await stat(dbPath);
    expect(meta).toMatchObject({
      complete: true, source: 'opencode-db', messageCount: 4, wal: null,
      vendor: { sizeBytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino },
    });
  });

  it('is idempotent on an unchanged DB and re-captures when the DB or its -wal changes', async () => {
    writeDb();
    const readDb = vi.fn((await import('../../adapters/opencode-transcript.js')).readOpenCodeDbTranscript);
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('captured');
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('already_captured');
    expect(readDb).toHaveBeenCalledTimes(1);

    // An empty -wal (what a checkpoint leaves) is the same as none.
    await writeFile(`${dbPath}-wal`, '');
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('already_captured');

    // A non-empty -wal is new data the main file does not show yet.
    await writeFile(`${dbPath}-wal`, 'x'.repeat(64));
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('captured');
    expect((await readSnapshotMeta(dir, 'task1', 'sess1'))!.wal).toMatchObject({ sizeBytes: 64 });
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('already_captured');

    const later = new Date(Date.now() + 60_000);
    await utimes(`${dbPath}-wal`, later, later);
    expect((await captureOpenCodeTaskTranscript({ ...params(), readDb })).outcome).toBe('captured');
    expect(readDb).toHaveBeenCalledTimes(3);
  });

  it('writes nothing when the DB is absent or holds no messages', async () => {
    expect((await captureOpenCodeTaskTranscript(params())).outcome).toBe('vendor_absent');
    writeDb();
    expect((await captureOpenCodeTaskTranscript({ ...params(), opencodeSessionId: 'ses_none' })).outcome).toBe('vendor_absent');
    expect(await readSnapshotMeta(dir, 'task1', 'sess1')).toBeUndefined();
    expect(await readStoredTranscript(dir, 'task1', 'sess1')).toBeUndefined();
  });

  it('rejects unsafe ids', async () => {
    writeDb();
    expect((await captureOpenCodeTaskTranscript({ ...params(), taskId: '../x' })).outcome).toBe('invalid_id');
  });
});
