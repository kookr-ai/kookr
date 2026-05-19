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
});
