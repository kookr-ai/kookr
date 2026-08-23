import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { crossProcessLockExists, tryAcquireCrossProcessLock } from './cross-process-lock.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('cross-process lock', () => {
  test('serializes competing writers in one process', () => {
    const dir = join(tmpdir(), `kookr-cross-lock-${process.pid}-${Date.now()}`);
    tempDirs.push(dir);
    const first = tryAcquireCrossProcessLock(join(dir, 'sweep.lock'));
    expect(first.kind).toBe('acquired');
    expect(crossProcessLockExists(join(dir, 'sweep.lock'))).toBe(true);
    const second = tryAcquireCrossProcessLock(join(dir, 'sweep.lock'));
    expect(second).toMatchObject({ kind: 'busy', holderPid: process.pid });
    if (first.kind === 'acquired') first.release();
    expect(crossProcessLockExists(join(dir, 'sweep.lock'))).toBe(false);
  });

  test('reclaims only a lock with a recorded dead holder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-cross-lock-'));
    tempDirs.push(dir);
    const lockPath = join(dir, 'sweep.lock');
    await mkdir(lockPath);
    await writeFile(join(lockPath, 'holder.json'), JSON.stringify({
      pid: 999_999,
      startedAt: '2026-08-23T00:00:00.000Z',
    }));
    const result = tryAcquireCrossProcessLock(lockPath, { isAlive: () => false });
    expect(result.kind).toBe('acquired');
    if (result.kind === 'acquired') result.release();
  });

  test('fails closed for a live foreign holder and malformed holder metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-cross-lock-'));
    tempDirs.push(dir);
    const livePath = join(dir, 'live.lock');
    await mkdir(livePath);
    await writeFile(join(livePath, 'holder.json'), JSON.stringify({
      pid: 1234,
      startedAt: '2026-08-23T00:00:00.000Z',
    }));
    expect(tryAcquireCrossProcessLock(livePath, { isAlive: () => true })).toMatchObject({ kind: 'busy', holderPid: 1234 });

    const malformedPath = join(dir, 'malformed.lock');
    await mkdir(malformedPath);
    await writeFile(join(malformedPath, 'holder.json'), '{not-json');
    expect(tryAcquireCrossProcessLock(malformedPath, { isAlive: () => false })).toMatchObject({ kind: 'busy' });
    expect(crossProcessLockExists(malformedPath)).toBe(true);
  });
});
