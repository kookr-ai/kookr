import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureScopedSnapshot,
  restoreScopedSnapshot,
  discardSnapshot,
  snapshotToken,
} from './auto-update-snapshots.js';

describe('scoped snapshots', () => {
  let dataDir: string;
  let installRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kookr-snap-data-'));
    installRoot = mkdtempSync(join(tmpdir(), 'kookr-snap-install-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(installRoot, { recursive: true, force: true });
  });

  test('snapshotToken makes a filesystem-safe name', () => {
    expect(snapshotToken('stripe@anthropic-plugin-directory')).toBe('stripe_anthropic-plugin-directory');
  });

  test('capture then restore returns the pre-update contents (scoped to the install dir)', async () => {
    const pluginDir = join(installRoot, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'VERSION'), '1.0.0');

    const snapshotPath = await captureScopedSnapshot(dataDir, 'a@m', pluginDir, 111);
    expect(existsSync(snapshotPath)).toBe(true);

    // Simulate an update that changes the plugin dir.
    writeFileSync(join(pluginDir, 'VERSION'), '2.0.0');
    writeFileSync(join(pluginDir, 'NEW'), 'added-by-update');

    const res = await restoreScopedSnapshot(snapshotPath, pluginDir);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(pluginDir, 'VERSION'), 'utf8')).toBe('1.0.0');
    expect(existsSync(join(pluginDir, 'NEW'))).toBe(false);
    // The snapshot is RETAINED after a restore.
    expect(existsSync(snapshotPath)).toBe(true);
  });

  test('capture throws when the install dir is missing (non-snapshottable)', async () => {
    await expect(captureScopedSnapshot(dataDir, 'a@m', join(installRoot, 'nope'), 1)).rejects.toThrow();
  });

  test('restore fails gracefully when the snapshot is gone', async () => {
    const res = await restoreScopedSnapshot(join(dataDir, 'missing'), join(installRoot, 'x'));
    expect(res.ok).toBe(false);
    expect(res.snapshotPath).toBe(join(dataDir, 'missing'));
  });

  test('discardSnapshot removes the dir (best-effort)', async () => {
    const pluginDir = join(installRoot, 'p');
    mkdirSync(pluginDir, { recursive: true });
    const snap = await captureScopedSnapshot(dataDir, 'a@m', pluginDir, 2);
    await discardSnapshot(snap);
    expect(existsSync(snap)).toBe(false);
    await discardSnapshot(snap); // idempotent / no throw
  });
});
