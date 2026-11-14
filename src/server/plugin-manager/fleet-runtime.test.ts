import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFleetRuntime, tasksOnOtherVersion, type FleetTaskView } from './fleet-runtime.js';
import { LoadoutStore } from './loadout-store.js';
import { AutoUpdateStore } from './auto-update-store.js';
import { PluginMutationService } from './mutation-service.js';
import { observeExternalChanges } from './auto-update-service.js';
import type { FleetCheckService } from './fleet-check.js';
import type { InstalledPluginRecord } from './registry.js';
import type { TaskLoadoutRecord } from '../../shared/contracts/plugins.js';

const recordWith = (id: string, version: string): TaskLoadoutRecord => ({
  resolved: { enabledOverrides: { [id]: true }, enabledSet: [id], deniedSkills: [] },
  winningLevel: 'fleet', mode: 'bypass', settingsHash: null, settingsPath: null, recordedAt: 'then',
  plugins: [{ id, version, installPath: `/c/${version}` }], skipped: [],
});

describe('PluginFleetRuntime — external changes (R10), with KOOKR_PLUGIN_AUTO_UPDATE unset', () => {
  let dir: string;
  let loadoutStore: LoadoutStore;
  let autoUpdateStore: AutoUpdateStore;
  let mutation: PluginMutationService;
  let registry: Map<string, InstalledPluginRecord[]>;
  let bumps: number;
  let checks: string[];
  let tasks: FleetTaskView[];

  const setVersion = (id: string, version: string): void => {
    registry.set(id, [{ scope: 'user', version, installPath: `/c/${version}`, gitCommitSha: null }]);
  };
  const runtime = (): PluginFleetRuntime =>
    new PluginFleetRuntime({
      loadoutStore,
      check: { runInBackground: (t: string) => checks.push(t), lastResult: null, running: false } as unknown as FleetCheckService,
      epochStore: { bump: async () => ++bumps },
      autoUpdateStore,
      mutation,
      installedPlugins: { read: async () => registry },
      homeDir: dir,
      liveTasks: () => tasks,
      env: { KOOKR_PLUGIN_LOADOUTS: '1' }, // KOOKR_PLUGIN_AUTO_UPDATE deliberately unset
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-fleet-runtime-'));
    loadoutStore = new LoadoutStore(dir);
    autoUpdateStore = new AutoUpdateStore(dir);
    mutation = new PluginMutationService();
    registry = new Map();
    bumps = 0;
    checks = [];
    tasks = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test('a fleet plugin changed outside Kookr bumps the epoch, re-runs the check, lists tasks on the old version', async () => {
    await loadoutStore.writeFleet({ 'a@m': true });
    setVersion('a@m', '1.0.0');
    const rt = runtime();
    expect(await rt.observeNow()).toBe(0); // first sighting is the baseline
    tasks = [
      { id: 'old-task', loadout: recordWith('a@m', '1.0.0') },
      { id: 'no-record' },
    ];
    setVersion('a@m', '1.1.0');
    expect(await rt.observeNow()).toBe(1);
    expect(bumps).toBe(1);
    expect(checks).toEqual(['external-change']);
    const status = await rt.status();
    expect(status.externalChanges).toEqual([
      expect.objectContaining({ pluginId: 'a@m', fromVersion: '1.0.0', toVersion: '1.1.0', affectedTaskIds: ['old-task'] }),
    ]);
  });

  test('the fleet check (the only CLI call in the reaction) starts after the lock is released', async () => {
    await loadoutStore.writeFleet({ 'a@m': true });
    setVersion('a@m', '1.0.0');
    const lockedWhenCheckStarted: boolean[] = [];
    const rt = new PluginFleetRuntime({
      loadoutStore,
      check: {
        runInBackground: () => lockedWhenCheckStarted.push(mutation.isLocked),
        lastResult: null,
        running: false,
      } as unknown as FleetCheckService,
      epochStore: { bump: async () => ++bumps },
      autoUpdateStore,
      mutation,
      installedPlugins: { read: async () => registry },
      homeDir: dir,
      liveTasks: () => tasks,
      env: { KOOKR_PLUGIN_LOADOUTS: '1' },
    });
    await rt.observeNow();
    setVersion('a@m', '1.1.0');
    await rt.observeNow();
    expect(lockedWhenCheckStarted).toEqual([false]);
  });

  test('observe runs whenever loadouts are on, independent of KOOKR_PLUGIN_AUTO_UPDATE', () => {
    const make = (env: NodeJS.ProcessEnv) =>
      new PluginFleetRuntime({
        loadoutStore, check: {} as FleetCheckService, epochStore: { bump: async () => 0 },
        autoUpdateStore, mutation, homeDir: dir, liveTasks: () => [], env,
      });
    expect(make({ KOOKR_PLUGIN_LOADOUTS: '1' }).observeActive()).toBe(true);
    expect(make({}).observeActive()).toBe(false);
    expect(make({ KOOKR_PLUGIN_AUTO_UPDATE: '1' }).observeActive()).toBe(false);
  });

  test('a change to a plugin outside the fleet set is logged but triggers nothing', async () => {
    setVersion('other@m', '1.0.0');
    const rt = runtime();
    await rt.observeNow();
    setVersion('other@m', '2.0.0');
    expect(await rt.observeNow()).toBe(1);
    expect(bumps).toBe(0);
    expect(checks).toEqual([]);
  });

  test('a Kookr-initiated update recorded in the baseline is not reported as external', async () => {
    await loadoutStore.writeFleet({ 'a@m': true });
    setVersion('a@m', '1.0.0');
    const rt = runtime();
    await rt.observeNow();
    await mutation.withLock('plugin-update', async () => {
      setVersion('a@m', '1.1.0'); // the update itself
      await rt.recordKookrChange(['a@m']);
    });
    expect(await rt.observeNow()).toBe(0);
    expect(bumps).toBe(0);
  });

  test('the observe pass releases the lock and skips the tick when the lock is busy', async () => {
    const rt = runtime();
    let release!: () => void;
    const held = mutation.withLock('someone', () => new Promise<void>((r) => { release = r; }));
    expect(await rt.observeNow()).toBeNull();
    release();
    await held;
    expect(await rt.observeNow()).toBe(0);
    expect(mutation.isLocked).toBe(false);
  });

  test('status: named-but-not-installed, spawn-gate-degraded tasks, coverage note', async () => {
    await loadoutStore.writeFleet({ 'a@m': true, 'gone@m': true, 'off@m': false });
    setVersion('a@m', '1.0.0');
    tasks = [{ id: 't-degraded', loadout: { ...recordWith('a@m', '1.0.0'), spawnGateDegraded: true } }];
    const s = await runtime().status();
    expect(s.namedNotInstalled).toEqual(['gone@m']);
    expect(s.spawnGateDegradedTaskIds).toEqual(['t-degraded']);
    expect(s.activation.state).toBe('on');
    expect(s.coverageNote).toMatch(/Claude agents only/);
  });

  test('setFleet writes the file, bumps the epoch and starts a check', async () => {
    const s = await runtime().setFleet({ 'a@m': true });
    expect(s.plugins).toEqual({ 'a@m': true });
    expect(bumps).toBe(1);
    expect(checks).toEqual(['fleet-change']);
  });
});

describe('observeExternalChanges', () => {
  test('reads the installed versions while holding the lock (no window for a Kookr update)', async () => {
    const mutation = new PluginMutationService();
    let lockedDuringRead = false;
    const dir = mkdtempSync(join(tmpdir(), 'kookr-observe-'));
    try {
      await observeExternalChanges({
        store: new AutoUpdateStore(dir),
        mutation,
        readInstalledVersions: async () => {
          lockedDuringRead = mutation.isLocked;
          return new Map();
        },
      });
      expect(lockedDuringRead).toBe(true);
      expect(mutation.isLocked).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tasksOnOtherVersion', () => {
  test('only tasks whose record lists the plugin with a different version', () => {
    expect(
      tasksOnOtherVersion({ pluginId: 'a@m', toVersion: '2.0.0' }, [
        { id: 'x', loadout: recordWith('a@m', '1.0.0') },
        { id: 'y', loadout: recordWith('a@m', '2.0.0') },
        { id: 'z', loadout: recordWith('b@m', '1.0.0') },
      ]),
    ).toEqual(['x']);
  });
});
