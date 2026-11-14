import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoadoutStore,
  LOADOUT_STORE_FILENAME,
  PLUGIN_FLEET_FILENAME,
  partitionByInstalled,
  prepareSpawnLoadout,
  replayRecordedLoadout,
  type SpawnLoadoutDeps,
} from './loadout-store.js';
import { resolveLoadout } from '../../core/claude-settings/loadout.js';
import { PluginMutationService } from './mutation-service.js';
import type { InstalledPluginRecord } from './registry.js';
import type { Task } from '../../core/task-read-model.js';
import type { TaskLoadoutRecord } from '../../shared/contracts/plugins.js';

describe('LoadoutStore', () => {
  let dir: string;
  let store: LoadoutStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-loadout-store-'));
    store = new LoadoutStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('missing file reads as an empty, versioned store', async () => {
    const data = await store.read();
    expect(data.version).toBe(1);
    expect(data.levels).toEqual({ 'task-type': {}, playbook: {}, project: {} });
  });

  test('malformed file reads as empty (never throws)', async () => {
    writeFileSync(join(dir, LOADOUT_STORE_FILENAME), '{ not json');
    const data = await store.read();
    expect(data.levels.project).toEqual({});
  });

  test('setLevelState persists and round-trips; empty plugins removes the entry', async () => {
    await store.setLevelState('project', 'github.com/o/r', { plugins: { 'stripe@mkt': false } });
    expect(existsSync(join(dir, LOADOUT_STORE_FILENAME))).toBe(true);
    let data = await store.read();
    expect(data.levels.project['github.com/o/r']).toEqual({ plugins: { 'stripe@mkt': false } });

    data = await store.setLevelState('project', 'github.com/o/r', { plugins: {} });
    expect(data.levels.project['github.com/o/r']).toBeUndefined();
  });

  test('setLevelState drops non-boolean values', async () => {
    const data = await store.setLevelState('playbook', 'pb', {
      plugins: { 'a@m': true, 'b@m': 'nope' as unknown as boolean },
    });
    expect(data.levels.playbook['pb']).toEqual({ plugins: { 'a@m': true } });
  });

  test('resolveForLaunch combines matching level entries with precedence', async () => {
    await store.setLevelState('project', 'proj', { plugins: { 'kookr-toolkit@kookr': true, 'stripe@mkt': true } });
    await store.setLevelState('playbook', 'pb', { plugins: { 'stripe@mkt': false } });
    const { loadout, provenance } = await store.resolveForLaunch(
      { projectId: 'proj', playbookId: 'pb', taskType: 'claude-code' },
      { mode: 'bypass' },
    );
    expect(loadout.enabledOverrides).toEqual({ 'kookr-toolkit@kookr': true, 'stripe@mkt': false });
    expect(loadout.enabledSet).toEqual(['kookr-toolkit@kookr']); // only enabled, sorted
    expect(provenance.winningLevel).toBe('playbook');
  });

  test('resolveForLaunch with no matching context resolves to empty', async () => {
    await store.setLevelState('project', 'other', { plugins: { 'a@m': false } });
    const { loadout, provenance } = await store.resolveForLaunch(
      { projectId: 'nomatch' },
      { mode: 'bypass' },
    );
    expect(loadout.enabledOverrides).toEqual({});
    expect(provenance.winningLevel).toBe('none');
  });

  test('written file is valid JSON with the version field', async () => {
    await store.setLevelState('task-type', 'claude-code', { plugins: { 'a@m': true } });
    const parsed = JSON.parse(readFileSync(join(dir, LOADOUT_STORE_FILENAME), 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.levels['task-type']['claude-code']).toEqual({ plugins: { 'a@m': true } });
  });
});

describe('LoadoutStore — fleet file (plugin-fleet.json)', () => {
  let dir: string;
  let store: LoadoutStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-fleet-file-'));
    store = new LoadoutStore(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test('absent file reads as an empty set with status missing', async () => {
    expect(await store.readFleet()).toEqual({ plugins: {}, status: 'missing' });
  });

  test('empty set file reads as empty with status ok', async () => {
    writeFileSync(join(dir, PLUGIN_FLEET_FILENAME), JSON.stringify({ version: 1, plugins: {} }));
    expect(await store.readFleet()).toEqual({ plugins: {}, status: 'ok' });
  });

  test.each([
    ['not JSON', '{ nope'],
    ['no plugins key', JSON.stringify({ version: 1 })],
    ['plugins is an array', JSON.stringify({ version: 1, plugins: ['a@m'] })],
  ])('malformed file (%s) reads as empty with status malformed, never throws', async (_label, body) => {
    writeFileSync(join(dir, PLUGIN_FLEET_FILENAME), body);
    expect(await store.readFleet()).toEqual({ plugins: {}, status: 'malformed' });
  });

  test('writeFleet round-trips, drops non-booleans, and returns before/after', async () => {
    await store.writeFleet({ 'a@m': true });
    const res = await store.writeFleet({ 'b@m': true, 'c@m': 'x' as unknown as boolean });
    expect(res).toEqual({ before: { 'a@m': true }, after: { 'b@m': true } });
    const parsed = JSON.parse(readFileSync(join(dir, PLUGIN_FLEET_FILENAME), 'utf8'));
    expect(parsed).toEqual({ version: 1, plugins: { 'b@m': true } });
  });

  test('the fleet set is a separate file: writing it never touches plugin-loadouts.json', async () => {
    await store.setLevelState('project', 'p', { plugins: { 'x@m': true } });
    const before = readFileSync(join(dir, LOADOUT_STORE_FILENAME), 'utf8');
    await store.writeFleet({ 'a@m': true });
    expect(readFileSync(join(dir, LOADOUT_STORE_FILENAME), 'utf8')).toBe(before);
  });

  test('resolveForLaunch: fleet is the least specific level; project overrides it per plugin', async () => {
    await store.writeFleet({ 'a@m': true, 'b@m': true });
    await store.setLevelState('project', 'proj', { plugins: { 'b@m': false } });
    const r = await store.resolveForLaunch({ projectId: 'proj' }, { mode: 'bypass' });
    expect(r.loadout.enabledOverrides).toEqual({ 'a@m': true, 'b@m': false });
    expect(r.pluginLevels).toEqual({ 'a@m': 'fleet', 'b@m': 'project' });
    expect(r.provenance.winningLevel).toBe('project');
    const other = await store.resolveForLaunch({ projectId: 'other' }, { mode: 'bypass' });
    expect(other.provenance.winningLevel).toBe('fleet');
    expect(other.loadout.enabledSet).toEqual(['a@m', 'b@m']);
  });
});

const rec = (over: Partial<InstalledPluginRecord> = {}): InstalledPluginRecord => ({
  scope: 'user', installPath: '/cache/x/1.0.0', version: '1.0.0', gitCommitSha: null, ...over,
});

describe('partitionByInstalled', () => {
  const resolveFleet = (plugins: Record<string, boolean>, project?: Record<string, boolean>) =>
    resolveLoadout({ fleet: { plugins }, ...(project ? { project: { plugins: project } } : {}) }, { mode: 'bypass' });

  test('all installed → all kept, listed with version and install path', () => {
    const installed = new Map([['a@m', [rec({ installPath: '/c/a/1.2.0', version: '1.2.0' })]]]);
    const p = partitionByInstalled(resolveFleet({ 'a@m': true }), installed);
    expect(p.loadout.enabledOverrides).toEqual({ 'a@m': true });
    expect(p.loadout.enabledSet).toEqual(['a@m']);
    expect(p.plugins).toEqual([{ id: 'a@m', version: '1.2.0', installPath: '/c/a/1.2.0' }]);
    expect(p.skipped).toEqual([]);
    expect(p.provenance.winningLevel).toBe('fleet');
  });

  test('some skipped → missing ones are skipped as not_installed and left out of the allowlist', () => {
    const installed = new Map([['a@m', [rec()]]]);
    const p = partitionByInstalled(resolveFleet({ 'a@m': true, 'gone@m': true }), installed);
    expect(p.loadout.enabledOverrides).toEqual({ 'a@m': true });
    expect(p.loadout.enabledSet).toEqual(['a@m']);
    expect(p.skipped).toEqual([{ id: 'gone@m', reason: 'not_installed' }]);
  });

  test('all skipped → empty loadout, winning level recomputed to none', () => {
    const p = partitionByInstalled(resolveFleet({ 'gone@m': true }), new Map());
    expect(p.loadout.enabledOverrides).toEqual({});
    expect(p.provenance.winningLevel).toBe('none');
    expect(p.skipped).toEqual([{ id: 'gone@m', reason: 'not_installed' }]);
  });

  test('provenance never names a level whose only entries were skipped', () => {
    const installed = new Map([['a@m', [rec()]]]);
    const p = partitionByInstalled(resolveFleet({ 'a@m': true }, { 'gone@m': true }), installed);
    expect(p.provenance.winningLevel).toBe('fleet');
  });

  test('a dir-loaded plugin (bundled toolkit) passes through untouched, not listed as given', () => {
    const p = partitionByInstalled(resolveFleet({}, { 'kookr-toolkit@kookr': false }), new Map(), ['kookr-toolkit']);
    expect(p.loadout.enabledOverrides).toEqual({ 'kookr-toolkit@kookr': false });
    expect(p.plugins).toEqual([]);
    expect(p.skipped).toEqual([]);
    expect(p.provenance.winningLevel).toBe('project');
  });

  test('a false entry passes through even when not installed (disabling needs no install)', () => {
    const p = partitionByInstalled(resolveFleet({ 'x@m': false }), new Map());
    expect(p.loadout.enabledOverrides).toEqual({ 'x@m': false });
    expect(p.skipped).toEqual([]);
  });

  test('install record selection: user scope wins, else the highest version', () => {
    const multi = new Map([
      ['a@m', [rec({ scope: 'project', version: '9.0.0', installPath: '/p' }), rec({ scope: 'user', version: '1.0.0', installPath: '/u' })]],
      ['b@m', [rec({ scope: 'project', version: '1.0.0', installPath: '/p1' }), rec({ scope: 'local', version: '2.0.0', installPath: '/p2' })]],
    ]);
    const p = partitionByInstalled(resolveFleet({ 'a@m': true, 'b@m': true }), multi);
    expect(p.plugins).toEqual([
      { id: 'a@m', version: '1.0.0', installPath: '/u' },
      { id: 'b@m', version: '2.0.0', installPath: '/p2' },
    ]);
  });
});

describe('prepareSpawnLoadout and replayRecordedLoadout', () => {
  let dir: string;
  let store: LoadoutStore;
  let mutation: PluginMutationService;
  let lockSpy: ReturnType<typeof vi.spyOn>;
  let setCalls: Array<{ id: string; loadout: TaskLoadoutRecord }>;
  let installed: Map<string, InstalledPluginRecord[]>;
  let registryReads: number;
  let warn: ReturnType<typeof vi.spyOn>;

  const fakeTaskStore = {
    setLoadout: (id: string, loadout: unknown) => {
      setCalls.push({ id, loadout: loadout as TaskLoadoutRecord });
      return {} as never;
    },
  };
  const claudeTask = (over: Partial<Task> = {}): Task =>
    ({ id: 't1', agentType: 'claude-code', projectId: 'proj', playbookId: 'pb', sessions: [], ...over }) as unknown as Task;
  const deps = (env: NodeJS.ProcessEnv, over: Partial<SpawnLoadoutDeps> = {}): SpawnLoadoutDeps => ({
    loadoutStore: store,
    taskStore: fakeTaskStore,
    mutation,
    installedPlugins: { read: async () => { registryReads++; return installed; } },
    dirLoadedPluginNames: async () => ['kookr-toolkit'],
    env,
    ...over,
  });
  const ON = { KOOKR_PLUGIN_LOADOUTS: '1' };
  const recorded = (over: Partial<TaskLoadoutRecord> = {}): TaskLoadoutRecord => ({
    resolved: { enabledOverrides: { 'a@m': true }, enabledSet: ['a@m'], deniedSkills: [] },
    winningLevel: 'fleet', mode: 'bypass', settingsHash: 'h', settingsPath: '/p', recordedAt: 'then',
    plugins: [{ id: 'a@m', version: '1.0.0', installPath: '/c' }], skipped: [],
    ...over,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-spawn-loadout-'));
    store = new LoadoutStore(dir);
    mutation = new PluginMutationService();
    lockSpy = vi.spyOn(mutation, 'withLock');
    setCalls = [];
    installed = new Map([['a@m', [rec()]]]);
    registryReads = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test('nothing configured, flag on → no field, nothing recorded, no lock, no registry read (R2)', async () => {
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask());
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
    expect(lockSpy).not.toHaveBeenCalled();
    expect(registryReads).toBe(0);
  });

  test('fleet set configured, flag on → takes the lock, records plugins with version, stamps hash', async () => {
    await store.writeFleet({ 'a@m': true });
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask());
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(fields.resolvedLoadout?.enabledSet).toEqual(['a@m']);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].loadout).toMatchObject({
      winningLevel: 'fleet',
      plugins: [{ id: 'a@m', version: '1.0.0', installPath: '/cache/x/1.0.0' }],
      skipped: [],
      settingsHash: null,
    });
    fields.onLoadoutApplied!({ settingsHash: 'deadbeef', settingsPath: '/s.json' });
    expect(setCalls[1].loadout).toMatchObject({ settingsHash: 'deadbeef', settingsPath: '/s.json', plugins: [{ id: 'a@m' }] });
  });

  test('every named plugin skipped → still records (skipped + winningLevel none) and warns', async () => {
    await store.writeFleet({ 'gone@m': true });
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask());
    expect(fields.resolvedLoadout?.enabledOverrides).toEqual({});
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].loadout).toMatchObject({
      winningLevel: 'none', plugins: [], skipped: [{ id: 'gone@m', reason: 'not_installed' }],
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('gone@m'))).toBe(true);
  });

  test('registry unreadable → fails closed: every named plugin skipped as not_installed', async () => {
    await store.writeFleet({ 'a@m': true });
    const fields = await prepareSpawnLoadout(
      deps(ON, { installedPlugins: { read: async () => { throw new Error('EACCES'); } } }),
      claudeTask(),
    );
    expect(fields.resolvedLoadout?.enabledOverrides).toEqual({});
    expect(setCalls[0].loadout.skipped).toEqual([{ id: 'a@m', reason: 'not_installed' }]);
  });

  test('a lock busy past the deadline → proceeds and marks spawnGateDegraded on the record', async () => {
    await store.writeFleet({ 'a@m': true });
    let release!: () => void;
    const held = mutation.withLock('test-holder', () => new Promise<void>((r) => { release = r; }));
    try {
      await prepareSpawnLoadout(deps(ON, { spawnGateTimeoutMs: 0 }), claudeTask());
    } finally {
      release();
      await held;
    }
    expect(setCalls[0].loadout.spawnGateDegraded).toBe(true);
  });

  test('project override to false beats the fleet set; record says which level won', async () => {
    await store.writeFleet({ 'a@m': true });
    await store.setLevelState('project', 'proj', { plugins: { 'a@m': false } });
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask());
    expect(fields.resolvedLoadout?.enabledOverrides).toEqual({ 'a@m': false });
    expect(setCalls[0].loadout.winningLevel).toBe('project');
    expect(setCalls[0].loadout.plugins).toEqual([]);
  });

  test('non-Claude agent → nothing resolved or recorded', async () => {
    await store.writeFleet({ 'a@m': true });
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask({ agentType: 'codex-cli' as Task['agentType'] }));
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
  });

  test('a task that has run before but has no record is not resolved fresh (R4, reopen/promotion)', async () => {
    await store.writeFleet({ 'a@m': true });
    const fields = await prepareSpawnLoadout(
      deps(ON),
      claudeTask({ sessions: [{ tmuxSession: 'old' }] as unknown as Task['sessions'] }),
    );
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
  });

  test('resolution throws → proceeds with no loadout, warns, records nothing', async () => {
    vi.spyOn(store, 'resolveForLaunch').mockRejectedValueOnce(new Error('boom'));
    expect(await prepareSpawnLoadout(deps(ON), claudeTask())).toEqual({});
    expect(setCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  test('no store wired → {}', async () => {
    expect(await prepareSpawnLoadout(deps(ON, { loadoutStore: undefined }), claudeTask())).toEqual({});
  });

  test('auto-update apply arm unchanged: with nothing configured it still takes the lock', async () => {
    const fields = await prepareSpawnLoadout(deps({ KOOKR_PLUGIN_AUTO_UPDATE: '1' }), claudeTask());
    expect(fields).toEqual({});
    expect(lockSpy).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(0);
  });

  // The activation table (RFC section 1), slices 1 and 2. Each row: flag value
  // → does a first spawn resolve, does a resume replay.
  describe.each([
    ['0', false, false],
    ['false', false, false],
    ['off', false, false],
    ['NO', false, false],
    ['1', true, true],
    ['true', true, true],
    [undefined, false, false],
    ['', false, false],
    ['yes', false, false], // not a recognised "on": stays off, never widens on
  ])('KOOKR_PLUGIN_LOADOUTS=%s', (flag, resolves, replays) => {
    const env = (): NodeJS.ProcessEnv => (flag === undefined ? {} : { KOOKR_PLUGIN_LOADOUTS: flag });

    test(`first spawn ${resolves ? 'resolves' : 'does not resolve'}`, async () => {
      await store.writeFleet({ 'a@m': true });
      const fields = await prepareSpawnLoadout(deps(env()), claudeTask());
      expect(Boolean(fields.resolvedLoadout)).toBe(resolves);
      expect(setCalls.length > 0).toBe(resolves);
      if (!resolves) expect(lockSpy).not.toHaveBeenCalled();
    });

    test(`resume ${replays ? 'replays' : 'does not replay'} the record (also via the first-spawn path)`, async () => {
      const task = claudeTask({ loadout: recorded() });
      const viaReplay = await replayRecordedLoadout(deps(env()), task);
      const viaFirstSpawn = await prepareSpawnLoadout(deps(env()), task);
      for (const fields of [viaReplay, viaFirstSpawn]) {
        expect(fields).toEqual(replays ? { resolvedLoadout: recorded().resolved } : {});
      }
    });
  });

  test('replay hands over the recorded ids even after the fleet set is emptied (R4)', async () => {
    await store.writeFleet({});
    const fields = await replayRecordedLoadout(deps(ON), claudeTask({ loadout: recorded() }));
    expect(fields).toEqual({ resolvedLoadout: recorded().resolved });
  });

  test('replay with an uninstalled plugin: ids still replayed, replaySkipped recorded, no re-resolution', async () => {
    installed = new Map();
    const resolveSpy = vi.spyOn(store, 'resolveForLaunch');
    const fields = await prepareSpawnLoadout(deps(ON), claudeTask({ loadout: recorded() }));
    expect(fields).toEqual({ resolvedLoadout: recorded().resolved });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].loadout.replaySkipped).toEqual([{ id: 'a@m', reason: 'not_installed' }]);
    expect(setCalls[0].loadout.plugins).toEqual(recorded().plugins); // original record kept
  });

  test('replay with every plugin still installed records an empty replaySkipped', async () => {
    await replayRecordedLoadout(deps(ON), claudeTask({ loadout: recorded() }));
    expect(setCalls[0].loadout.replaySkipped).toEqual([]);
  });

  test('replay of a task with no record returns no field (byte-identical path)', async () => {
    expect(await replayRecordedLoadout(deps(ON), claudeTask())).toEqual({});
    expect(setCalls).toHaveLength(0);
  });
});
