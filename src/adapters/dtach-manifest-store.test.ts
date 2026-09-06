import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DtachManifestStore } from './dtach-manifest-store.js';

describe('DtachManifestStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('serializes update operations through one manifest file', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-manifest-test-'));
    const store = new DtachManifestStore(join(tmpDir, 'manifest.json'), 'test-instance');

    await Promise.all([
      store.update((manifest) => {
        manifest.entries.push({
          sessionId: 'one',
          pid: 1,
          startedAt: '2026-05-19T00:00:00.000Z',
          status: 'active',
          sock: '/tmp/one.sock',
        });
      }),
      store.update((manifest) => {
        manifest.entries.push({
          sessionId: 'two',
          pid: 2,
          startedAt: '2026-05-19T00:00:00.000Z',
          status: 'recovered',
          sock: '/tmp/two.sock',
        });
      }),
    ]);

    expect(store.read().entries.map((entry) => entry.sessionId).sort()).toEqual(['one', 'two']);
    await expect(store.getEntry('two')).resolves.toMatchObject({ pid: 2, status: 'recovered' });
  });

  it('separates recovery parse failures from normal soft reads', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-manifest-test-'));
    const manifestPath = join(tmpDir, 'manifest.json');
    const store = new DtachManifestStore(manifestPath, 'test-instance');

    writeFileSync(manifestPath, '{not-json', { mode: 0o600 });

    expect(store.read()).toEqual({ version: 1, instanceId: 'test-instance', entries: [] });
    expect(store.readForRecovery()).toEqual({ kind: 'invalid' });

    store.renameCorrupt();

    expect(existsSync(manifestPath)).toBe(false);
    expect(readdirSync(tmpDir).some((name) => name.startsWith('manifest.json.corrupt-'))).toBe(true);
  });

  it('re-creates an instance directory that was swept away under a running server (#3042)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-manifest-test-'));
    const instanceDir = join(tmpDir, 'port-4800');
    const store = new DtachManifestStore(join(instanceDir, 'manifest.json'), 'test-instance');

    // Get the store into the steady state a live server is in: one session
    // already recorded, manifest and instance directory both on disk.
    await store.update((manifest) => {
      manifest.entries.push({
        sessionId: 'before-sweep',
        pid: 41,
        startedAt: '2026-09-06T21:24:00.000Z',
        status: 'active',
        sock: join(instanceDir, 'before-sweep.sock'),
      });
    });
    expect(existsSync(instanceDir)).toBe(true);

    // Now a /tmp sweeper (or `scripts/rollback-dtach.sh`) takes the whole
    // instance directory out from under the running server. Before #3042 the
    // next write threw ENOENT, and so did every launch after it until restart.
    rmSync(instanceDir, { recursive: true, force: true });

    await store.update((manifest) => {
      manifest.entries.push({
        sessionId: 'after-sweep',
        pid: 42,
        startedAt: '2026-09-06T21:26:00.000Z',
        status: 'pending',
        sock: join(instanceDir, 'after-sweep.sock'),
      });
    });

    expect(existsSync(join(instanceDir, 'manifest.json'))).toBe(true);
    // The pre-sweep entry went with the directory — read() falls back to an
    // empty manifest — so the recovered file holds exactly the new session.
    expect(store.read().entries.map((entry) => entry.sessionId)).toEqual(['after-sweep']);
  });
});
