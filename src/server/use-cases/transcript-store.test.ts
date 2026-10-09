import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
});
