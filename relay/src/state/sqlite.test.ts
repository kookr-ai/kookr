import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RelaySqliteStateStore } from './sqlite.js';

const cleanupDirs: string[] = [];

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-relay-sqlite-mode-'));
  cleanupDirs.push(dir);
  return join(dir, 'relay-state.sqlite');
}

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// chmod is a POSIX concept; the owner-only guarantee (issue #2779) only holds
// on platforms where mode bits are meaningful.
const describeOwnerOnly = process.platform === 'win32' ? describe.skip : describe;

describeOwnerOnly('RelaySqliteStateStore owner-only state (#2779)', () => {
  // process.umask is process-global; this test sets/restores it in try/finally.
  // Safe under Vitest's default `forks` pool (one process per file); a switch to
  // `pool: 'threads'` would share one OS umask across files.
  it('tightens the live database and WAL sidecars to 0o600 even under a permissive umask', async () => {
    const dbPath = await tempDbPath();
    const previousUmask = process.umask(0o000);
    let store: RelaySqliteStateStore | null = null;
    try {
      store = new RelaySqliteStateStore(dbPath);
      // A write forces the WAL/SHM sidecars into existence with the same mode.
      store.saveTerminalViewingDisabledTenant({
        tenantId: 'tenant-1',
        reason: 'test',
        disabledAt: new Date().toISOString(),
      });

      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(statSync(path).mode & 0o777, `${path} should be owner-only`).toBe(0o600);
      }
    } finally {
      store?.close();
      process.umask(previousUmask);
    }
  });

  it('constructs an in-memory database (the mode-repair path is skipped)', () => {
    const store = new RelaySqliteStateStore(':memory:');
    try {
      expect(store.probe()).toBe(true);
    } finally {
      store.close();
    }
  });
});
