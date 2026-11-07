import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PluginMutationService,
  PluginMutationBusyError,
} from './mutation-service.js';

describe('PluginMutationService lock', () => {
  it('runs fn while free and releases the lock afterwards', async () => {
    const svc = new PluginMutationService();
    expect(svc.isLocked).toBe(false);
    const result = await svc.withLock('op-a', async () => {
      expect(svc.isLocked).toBe(true);
      expect(svc.currentHolder?.operation).toBe('op-a');
      return 42;
    });
    expect(result).toBe(42);
    expect(svc.isLocked).toBe(false);
    expect(svc.currentHolder).toBeNull();
  });

  it('rejects a concurrent mutation with a busy error naming the holder', async () => {
    const svc = new PluginMutationService();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = svc.withLock('plugin-install', async () => {
      await held;
      return 'done';
    });
    // Second attempt while the first still holds the lock.
    await expect(svc.withLock('plugin-update', async () => 'never')).rejects.toBeInstanceOf(
      PluginMutationBusyError,
    );
    try {
      await svc.withLock('plugin-update', async () => 'never');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginMutationBusyError);
      const busy = err as PluginMutationBusyError;
      expect(busy.holder.operation).toBe('plugin-install');
      expect(typeof busy.holder.startedAt).toBe('string');
      expect(Number.isNaN(Date.parse(busy.holder.startedAt))).toBe(false);
    }
    release?.();
    expect(await first).toBe('done');
    // Lock is free again after the first settles.
    expect(svc.isLocked).toBe(false);
  });

  it('releases the lock even when fn throws', async () => {
    const svc = new PluginMutationService();
    await expect(
      svc.withLock('op', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(svc.isLocked).toBe(false);
    // A subsequent mutation can acquire the lock.
    await expect(svc.withLock('op2', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('PluginMutationService backup', () => {
  let dir: string;
  let pluginsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kookr-mutation-'));
    pluginsDir = join(dir, 'plugins');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records existedBefore=false and restore removes a freshly-created dir', async () => {
    const svc = new PluginMutationService();
    const backup = await svc.backupPluginsDir(pluginsDir);
    expect(backup.existedBefore).toBe(false);
    expect(backup.backupPath).toBeNull();

    // Simulate a failed mutation that created the dir.
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'partial.txt'), 'x');

    const result = await backup.restore();
    expect(result.ok).toBe(true);
    await expect(access(pluginsDir)).rejects.toBeTruthy();
  });

  it('restores the original dir contents when the dir existed before', async () => {
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'original.json'), '{"keep":true}');

    const svc = new PluginMutationService();
    const backup = await svc.backupPluginsDir(pluginsDir);
    expect(backup.existedBefore).toBe(true);
    expect(backup.backupPath).not.toBeNull();

    // Simulate a mutation that corrupts/replaces the dir.
    await rm(pluginsDir, { recursive: true, force: true });
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'corrupt.json'), 'garbage');

    const result = await backup.restore();
    expect(result.ok).toBe(true);
    const restored = await readFile(join(pluginsDir, 'original.json'), 'utf8');
    expect(restored).toBe('{"keep":true}');
    await expect(access(join(pluginsDir, 'corrupt.json'))).rejects.toBeTruthy();
    // Backup copy is gone (consumed by the restore rename).
    await expect(access(backup.backupPath as string)).rejects.toBeTruthy();
  });

  it('restore returns {ok:false, backupPath} when it cannot put the backup back', async () => {
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'original.json'), '{"keep":true}');

    const svc = new PluginMutationService();
    const backup = await svc.backupPluginsDir(pluginsDir);
    expect(backup.backupPath).not.toBeNull();

    // Make the restore's `rename(backupPath → pluginsDir)` fail by deleting the
    // backup copy out from under it. The route surfaces backupPath in its 500.
    await rm(backup.backupPath as string, { recursive: true, force: true });

    const result = await backup.restore();
    expect(result.ok).toBe(false);
    expect(result.backupPath).toBe(backup.backupPath);
  });

  it('discard removes the backup after a successful mutation', async () => {
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(join(pluginsDir, 'original.json'), '{"keep":true}');

    const svc = new PluginMutationService();
    const backup = await svc.backupPluginsDir(pluginsDir);
    expect(backup.backupPath).not.toBeNull();
    await access(backup.backupPath as string); // exists

    await backup.discard();
    await expect(access(backup.backupPath as string)).rejects.toBeTruthy();
    // Live dir is untouched by discard.
    const live = await readFile(join(pluginsDir, 'original.json'), 'utf8');
    expect(live).toBe('{"keep":true}');
  });
});
