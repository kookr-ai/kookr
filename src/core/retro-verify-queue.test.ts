import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  boundRetroVerifyQueue,
  buildRetroVerifyEntry,
  DEFAULT_RETRO_VERIFY_MAX_AGE_MS,
  DEFAULT_RETRO_VERIFY_MAX_ENTRIES,
  drainRetroVerifyQueue,
  enqueueRetroVerify,
  normalizeSha,
  readPendingRetroVerify,
  removeRetroVerifyEntry,
  retroVerifyQueuePendingPath,
  type FileP1Fn,
  type RetroVerifyEntry,
  type VerifyFn,
} from './retro-verify-queue.js';

async function tempSpoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-retro-verify-'));
}

const NOW_MS = Date.now();
/** A recent ISO timestamp `secAgo` seconds before now — stays within age bounds. */
function recentIso(secAgo: number): string {
  return new Date(NOW_MS - secAgo * 1000).toISOString();
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('buildRetroVerifyEntry', () => {
  test('normalizes sha, trims fields, defaults prNumber', () => {
    const entry = buildRetroVerifyEntry({
      sha: `  ${SHA_A.toUpperCase()}  `,
      repo: '  kookr-ai/kookr  ',
      reason: '  ci-signal-absent  ',
    });
    expect(entry.sha).toBe(SHA_A);
    expect(entry.repo).toBe('kookr-ai/kookr');
    expect(entry.reason).toBe('ci-signal-absent');
    expect(entry.prNumber).toBe(0);
    expect(entry.schemaVersion).toBe('retro-verify-queue.v1');
  });

  test('honours explicit prNumber', () => {
    expect(buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'x', prNumber: 42 }).prNumber).toBe(42);
  });

  test('rejects empty sha', () => {
    expect(() => buildRetroVerifyEntry({ sha: '   ', repo: 'o/r', reason: 'x' })).toThrow(/sha is required/);
  });

  test('rejects a non-hex sha', () => {
    expect(() => buildRetroVerifyEntry({ sha: 'zzz123', repo: 'o/r', reason: 'x' })).toThrow(/invalid sha/);
  });

  test('rejects a too-short hex sha (< 7 chars)', () => {
    expect(() => buildRetroVerifyEntry({ sha: 'abc', repo: 'o/r', reason: 'x' })).toThrow(/invalid sha/);
  });

  test('accepts a short-but-valid abbreviated sha (>= 7 chars)', () => {
    expect(buildRetroVerifyEntry({ sha: 'abc1234', repo: 'o/r', reason: 'x' }).sha).toBe('abc1234');
  });

  test('rejects empty repo and reason', () => {
    expect(() => buildRetroVerifyEntry({ sha: SHA_A, repo: '  ', reason: 'x' })).toThrow(/repo is required/);
    expect(() => buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: '  ' })).toThrow(/reason is required/);
  });

  test('rejects a negative prNumber', () => {
    expect(() => buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'x', prNumber: -1 })).toThrow(/invalid prNumber/);
  });
});

describe('normalizeSha', () => {
  test('trims and lowercases', () => {
    expect(normalizeSha('  ABC123  ')).toBe('abc123');
  });
});

describe('enqueueRetroVerify + readPendingRetroVerify', () => {
  test('enqueues durably and survives re-read', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'ci-signal-absent', prNumber: 7 });
    const result = await enqueueRetroVerify(spoolDir, entry);
    expect(result.enqueued).toBe(true);
    expect(result.reason).toBe('enqueued');

    const pending = await readPendingRetroVerify(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sha).toBe(SHA_A);
    expect(pending[0]!.prNumber).toBe(7);
  });

  test('dedups by sha (idempotent enqueue)', async () => {
    const spoolDir = await tempSpoolDir();
    const first = await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const dup = await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A.toUpperCase(), repo: 'o/r', reason: 'b' }));
    expect(first.enqueued).toBe(true);
    expect(dup.enqueued).toBe(false);
    expect(dup.reason).toBe('duplicate');
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(1);
  });

  test('reads back an empty queue when spool file is absent', async () => {
    const spoolDir = await tempSpoolDir();
    expect(await readPendingRetroVerify(spoolDir)).toEqual([]);
  });

  test('tolerates corrupt lines and dedups on read', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const path = retroVerifyQueuePendingPath(spoolDir);
    const good = JSON.stringify(buildRetroVerifyEntry({ sha: SHA_B, repo: 'o/r', reason: 'b' }));
    await writeFile(path, `${await readFile(path, 'utf8')}not-json{{{\n${good}\n${good}\n`, 'utf8');
    const pending = await readPendingRetroVerify(spoolDir);
    expect(pending.map((e) => e.sha).sort()).toEqual([SHA_A, SHA_B]);
  });

  test('drops parseable-but-schema-invalid lines on read', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const path = retroVerifyQueuePendingPath(spoolDir);
    // Valid JSON, but not a valid entry (wrong schemaVersion / missing fields).
    const bad = `${JSON.stringify({ foo: 1 })}\n${JSON.stringify({ schemaVersion: 'wrong', sha: SHA_B })}\n`;
    await writeFile(path, `${await readFile(path, 'utf8')}${bad}`, 'utf8');
    const pending = await readPendingRetroVerify(spoolDir);
    expect(pending.map((e) => e.sha)).toEqual([SHA_A]);
  });

  test('entries are ordered oldest-first by createdAt', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_B, repo: 'o/r', reason: 'b', createdAt: recentIso(10) }));
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a', createdAt: recentIso(20) }));
    expect((await readPendingRetroVerify(spoolDir)).map((e) => e.sha)).toEqual([SHA_A, SHA_B]);
  });
});

describe('removeRetroVerifyEntry', () => {
  test('removes by sha and is a no-op when absent', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    expect(await removeRetroVerifyEntry(spoolDir, SHA_A.toUpperCase())).toBe(true);
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(0);
    expect(await removeRetroVerifyEntry(spoolDir, SHA_A)).toBe(false);
  });
});

describe('boundRetroVerifyQueue', () => {
  function entryAt(sha: string, createdAt: string): RetroVerifyEntry {
    return buildRetroVerifyEntry({ sha, repo: 'o/r', reason: 'x', createdAt });
  }

  test('drops entries older than maxAgeMs', () => {
    const now = new Date('2026-02-01T00:00:00.000Z');
    const old = entryAt(SHA_A, '2026-01-01T00:00:00.000Z');
    const fresh = entryAt(SHA_B, '2026-01-31T00:00:00.000Z');
    const { kept, pruned } = boundRetroVerifyQueue([old, fresh], { now, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(kept.map((e) => e.sha)).toEqual([SHA_B]);
    expect(pruned).toBe(1);
  });

  test('drops oldest first when over maxEntries', () => {
    const now = new Date('2026-01-04T00:00:00.000Z');
    const entries = [
      entryAt(SHA_A, '2026-01-01T00:00:00.000Z'),
      entryAt(SHA_B, '2026-01-02T00:00:00.000Z'),
      entryAt(SHA_C, '2026-01-03T00:00:00.000Z'),
    ];
    const { kept, pruned } = boundRetroVerifyQueue(entries, { now, maxEntries: 2 });
    expect(kept.map((e) => e.sha)).toEqual([SHA_B, SHA_C]);
    expect(pruned).toBe(1);
  });

  test('defaults match the documented values', () => {
    expect(DEFAULT_RETRO_VERIFY_MAX_ENTRIES).toBe(500);
    expect(DEFAULT_RETRO_VERIFY_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  test('enqueue force-keeps a new entry even at cap', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a', createdAt: recentIso(20) }), { maxEntries: 1 });
    const res = await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_B, repo: 'o/r', reason: 'b', createdAt: recentIso(10) }), { maxEntries: 1 });
    expect(res.enqueued).toBe(true);
    const pending = await readPendingRetroVerify(spoolDir);
    expect(pending.map((e) => e.sha)).toEqual([SHA_B]);
  });
});

describe('drainRetroVerifyQueue', () => {
  test('empty queue drains to zeros', async () => {
    const spoolDir = await tempSpoolDir();
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'pass' }) });
    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(0);
  });

  test('prunes an aged entry before verifying (verify never called on it)', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'old', createdAt: '2020-01-01T00:00:00.000Z' }));
    const verified: string[] = [];
    const result = await drainRetroVerifyQueue({
      spoolDir,
      verify: async (entry) => { verified.push(entry.sha); return { outcome: 'pass' }; },
      // Default 30-day maxAge; the 2020 entry is far past it.
    });
    expect(verified).toEqual([]); // pruned before verify ran
    expect(result.attempted).toBe(0);
    expect(result.remaining).toBe(0);
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(0);
  });

  test('accumulates attemptCount across repeated unavailable drains', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const verify: VerifyFn = async () => ({ outcome: 'unavailable' });
    await drainRetroVerifyQueue({ spoolDir, verify });
    await drainRetroVerifyQueue({ spoolDir, verify });
    expect((await readPendingRetroVerify(spoolDir))[0]!.attemptCount).toBe(2);
  });

  test('passing verification dequeues the entry', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'pass' }) });
    expect(result.passed).toBe(1);
    expect(result.remaining).toBe(0);
    expect(result.passedShas).toEqual([SHA_A]);
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(0);
  });

  test('unavailable keeps the entry for a later drain and bumps attemptCount', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'unavailable', error: 'ci still down' }) });
    expect(result.unavailable).toBe(1);
    expect(result.remaining).toBe(1);
    const pending = await readPendingRetroVerify(spoolDir);
    expect(pending[0]!.attemptCount).toBe(1);
    expect(pending[0]!.lastError).toBe('ci still down');
  });

  test('failing verification files a P1 and dequeues', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a', prNumber: 9 }));
    const filed: RetroVerifyEntry[] = [];
    const fileP1: FileP1Fn = async (entry) => { filed.push(entry); return { filed: true, issueRef: '#123' }; };
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'fail', error: 'test X broke' }), fileP1 });
    expect(result.failed).toBe(1);
    expect(result.p1Filed).toBe(1);
    expect(result.p1FiledShas).toEqual([SHA_A]);
    expect(result.remaining).toBe(0);
    expect(filed[0]!.sha).toBe(SHA_A);
    expect(filed[0]!.prNumber).toBe(9);
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(0);
  });

  test('failing verification without a fileP1 callback still dequeues', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'fail' }) });
    expect(result.failed).toBe(1);
    expect(result.p1Filed).toBe(0);
    expect(result.remaining).toBe(0);
  });

  test('P1 filing failure keeps entry as verifyFailed and retries only P1 on re-drain', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    let verifyCalls = 0;
    const verify: VerifyFn = async () => { verifyCalls += 1; return { outcome: 'fail', error: 'boom' }; };

    // First drain: verification fails, P1 filing throws → entry kept as verifyFailed.
    const throwingFileP1: FileP1Fn = async () => { throw new Error('github down'); };
    const first = await drainRetroVerifyQueue({ spoolDir, verify, fileP1: throwingFileP1 });
    expect(first.failed).toBe(1);
    expect(first.p1Filed).toBe(0);
    expect(first.remaining).toBe(1);
    const afterFirst = await readPendingRetroVerify(spoolDir);
    expect(afterFirst[0]!.verifyFailed).toBe(true);
    // The verify cause is preserved distinctly from the P1 transport error.
    expect(afterFirst[0]!.verifyError).toBe('boom');
    expect(afterFirst[0]!.lastError).toBe('github down');

    // Second drain: verify must NOT run again; the filer must receive the real
    // verify cause ('boom'), not the transport error ('github down').
    const filerErrors: (string | undefined)[] = [];
    const okFileP1: FileP1Fn = async (_entry, error) => { filerErrors.push(error); return { filed: true }; };
    const second = await drainRetroVerifyQueue({ spoolDir, verify, fileP1: okFileP1 });
    expect(verifyCalls).toBe(1); // verify ran only once, ever
    expect(filerErrors).toEqual(['boom']);
    expect(second.p1Filed).toBe(1);
    expect(second.remaining).toBe(0);
    expect(await readPendingRetroVerify(spoolDir)).toHaveLength(0);
  });

  test('P1 filing returning filed:false keeps entry for retry', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const fileP1: FileP1Fn = async () => ({ filed: false });
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => ({ outcome: 'fail', error: 'nope' }), fileP1 });
    expect(result.p1Filed).toBe(0);
    expect(result.remaining).toBe(1);
    expect((await readPendingRetroVerify(spoolDir))[0]!.verifyFailed).toBe(true);
  });

  test('a thrown verify is treated as unavailable (kept for retry)', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a' }));
    const result = await drainRetroVerifyQueue({ spoolDir, verify: async () => { throw new Error('crash'); } });
    expect(result.unavailable).toBe(1);
    expect(result.remaining).toBe(1);
    expect((await readPendingRetroVerify(spoolDir))[0]!.lastError).toBe('crash');
  });

  test('mixed batch: pass dequeues, fail files P1, unavailable stays', async () => {
    const spoolDir = await tempSpoolDir();
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_A, repo: 'o/r', reason: 'a', createdAt: recentIso(30) }));
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_B, repo: 'o/r', reason: 'b', createdAt: recentIso(20) }));
    await enqueueRetroVerify(spoolDir, buildRetroVerifyEntry({ sha: SHA_C, repo: 'o/r', reason: 'c', createdAt: recentIso(10) }));
    const verify: VerifyFn = async (entry) => {
      if (entry.sha === SHA_A) return { outcome: 'pass' };
      if (entry.sha === SHA_B) return { outcome: 'fail', error: 'B broke' };
      return { outcome: 'unavailable' };
    };
    const result = await drainRetroVerifyQueue({ spoolDir, verify, fileP1: async () => ({ filed: true }) });
    expect(result.attempted).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.unavailable).toBe(1);
    expect(result.p1Filed).toBe(1);
    expect(result.remaining).toBe(1);
    expect((await readPendingRetroVerify(spoolDir)).map((e) => e.sha)).toEqual([SHA_C]);
  });
});
