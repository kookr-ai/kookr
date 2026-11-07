import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnSessionAssist, OwnSessionMutationError } from './own-session.js';
import { ClaudePluginCli, type PluginCliRunner } from './cli.js';
import { PluginMutationService, PluginMutationBusyError } from './mutation-service.js';
import { ConfigEpochStore } from './config-epoch.js';
import { ClaudeSettingsStore, defaultScopeFiles } from '../../core/claude-settings/settings-store.js';

/** A fake `claude plugin` runner that records calls and can be scripted to throw or block. */
function fakeRunner() {
  const calls: string[][] = [];
  let behavior: (args: string[]) => Promise<{ stdout: string; stderr: string }> = async () => ({
    stdout: '',
    stderr: '',
  });
  return {
    calls,
    set(fn: (args: string[]) => Promise<{ stdout: string; stderr: string }>) {
      behavior = fn;
    },
    runner: {
      async run(args: string[]) {
        calls.push(args);
        return behavior(args);
      },
    } satisfies PluginCliRunner,
  };
}

describe('OwnSessionAssist', () => {
  let home: string;
  let userSettingsPath: string;
  let fake: ReturnType<typeof fakeRunner>;
  let assist: OwnSessionAssist;
  let epoch: ConfigEpochStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kookr-own-session-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    userSettingsPath = join(home, '.claude', 'settings.json');
    fake = fakeRunner();
    epoch = new ConfigEpochStore(home);
    assist = new OwnSessionAssist({
      cli: new ClaudePluginCli(fake.runner),
      settings: new ClaudeSettingsStore(defaultScopeFiles(home, home)),
      mutation: new PluginMutationService(),
      epoch,
      pluginsDir: join(home, '.claude', 'plugins'),
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function readUserSettings(): Record<string, unknown> {
    return JSON.parse(readFileSync(userSettingsPath, 'utf8'));
  }

  test('setEnablement writes an inverse single-key edit and bumps the epoch', async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ model: 'opus', enabledPlugins: { 'other@m': true } }, null, 2));
    const res = await assist.setEnablement('x@m', false, 'user');
    expect(res.previousValue).toBeUndefined(); // key was absent
    expect(res.epoch).toBe(1);
    const settings = readUserSettings();
    expect(settings.enabledPlugins).toEqual({ 'other@m': true, 'x@m': false });
    expect(settings.model).toBe('opus'); // unrelated key preserved
  });

  test('undoEnablement restores the exact prior key, leaving unrelated keys intact', async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ model: 'opus', enabledPlugins: { 'x@m': true } }, null, 2));
    const disabled = await assist.setEnablement('x@m', false, 'user');
    expect(disabled.previousValue).toBe(true);
    expect(readUserSettings().enabledPlugins).toEqual({ 'x@m': false });

    const undo = await assist.undoEnablement('x@m', disabled.previousValue, 'user');
    expect(undo.epoch).toBe(2); // each mutation bumps
    const settings = readUserSettings();
    expect(settings.enabledPlugins).toEqual({ 'x@m': true });
    expect(settings.model).toBe('opus');
  });

  test('reset (undefined) removes the key, restoring native default', async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ enabledPlugins: { 'x@m': false } }, null, 2));
    await assist.setEnablement('x@m', undefined, 'user');
    expect(readUserSettings().enabledPlugins).toBeUndefined();
  });

  test('addMarketplace runs the CLI under the lock and bumps the epoch', async () => {
    const res = await assist.addMarketplace('owner/repo');
    expect(fake.calls).toContainEqual(['plugin', 'marketplace', 'add', 'owner/repo']);
    expect(res.epoch).toBe(1);
  });

  test('a failed marketplace add throws and does NOT bump the epoch', async () => {
    fake.set(async () => {
      throw new Error('boom');
    });
    await expect(assist.addMarketplace('owner/repo')).rejects.toBeInstanceOf(OwnSessionMutationError);
    expect(await epoch.current()).toBe(0); // not advanced on failure
  });

  test('installPlugin mutates plugins then settings (R8 order) and bumps the epoch', async () => {
    const res = await assist.installPlugin('foo@bar', {
      marketplaceSource: 'owner/repo',
      enableAfterInstall: true,
      scope: 'user',
    });
    // plugins-dir mutations happen before the settings write.
    expect(fake.calls).toEqual([
      ['plugin', 'marketplace', 'add', 'owner/repo'],
      ['plugin', 'install', 'foo@bar'],
    ]);
    expect(readUserSettings().enabledPlugins).toEqual({ 'foo@bar': true });
    expect(res).toEqual({ epoch: 1, enabled: true });
  });

  test('a failed install does NOT write settings or bump the epoch', async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    fake.set(async (args) => {
      if (args[1] === 'install') throw new Error('install failed');
      return { stdout: '', stderr: '' };
    });
    await expect(
      assist.installPlugin('foo@bar', { enableAfterInstall: true, scope: 'user' }),
    ).rejects.toBeInstanceOf(OwnSessionMutationError);
    expect(readUserSettings()).toEqual({ model: 'opus' }); // settings untouched
    expect(await epoch.current()).toBe(0);
  });

  test('a failed post-install verify undoes IN REVERSE: settings key reverted AND plugins dir restored', async () => {
    writeFileSync(userSettingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    const pluginsDir = join(home, '.claude', 'plugins');
    const marker = join(pluginsDir, 'installed-marker');
    // The install mutates the plugins dir (writes a marker) so its ROLLBACK is
    // observable: the dir did not exist before, so restore() removes it entirely.
    fake.set(async (args) => {
      if (args[1] === 'install') {
        mkdirSync(pluginsDir, { recursive: true });
        writeFileSync(marker, 'x');
      }
      return { stdout: '', stderr: '' };
    });
    const assistWithVerify = new OwnSessionAssist({
      cli: new ClaudePluginCli(fake.runner),
      settings: new ClaudeSettingsStore(defaultScopeFiles(home, home)),
      mutation: new PluginMutationService(),
      epoch,
      pluginsDir,
      verifyInstalled: async () => false, // CLI "lied": exit 0 but not installed
    });
    await expect(
      assistWithVerify.installPlugin('foo@bar', { enableAfterInstall: true, scope: 'user' }),
    ).rejects.toBeInstanceOf(OwnSessionMutationError);
    // The settings enable was reverted by its inverse edit (model preserved)...
    expect(readUserSettings()).toEqual({ model: 'opus' });
    // ...and the plugins-dir mutation was rolled back (marker removed).
    expect(existsSync(marker)).toBe(false);
    // Epoch not advanced on a rolled-back op.
    expect(await epoch.current()).toBe(0);
  });

  test('the shared mutation lock serializes own-session mutations (409)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    fake.set(async () => {
      await held; // hold the lock while the first op is in flight
      return { stdout: '', stderr: '' };
    });
    const first = assist.addMarketplace('owner/repo');
    // A concurrent mutation must be refused while the lock is held.
    await expect(assist.setEnablement('x@m', false, 'user')).rejects.toBeInstanceOf(PluginMutationBusyError);
    release();
    await first;
  });
});
