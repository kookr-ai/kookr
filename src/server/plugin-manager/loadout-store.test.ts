import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoadoutStore,
  LOADOUT_STORE_FILENAME,
  replayRecordedLoadout,
  resolveOrReplayLoadout,
} from './loadout-store.js';
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

describe('replayRecordedLoadout', () => {
  test('returns the recorded resolved loadout verbatim', () => {
    const record: TaskLoadoutRecord = {
      resolved: { enabledOverrides: { 'kookr-toolkit@kookr': false }, deniedSkills: [] },
      winningLevel: 'project',
      mode: 'bypass',
      settingsHash: 'abc',
      settingsPath: '/tmp/s.json',
      recordedAt: new Date().toISOString(),
    };
    const task = { loadout: record } as unknown as Task;
    expect(replayRecordedLoadout(task)).toEqual({ resolvedLoadout: record.resolved });
  });

  test('returns no field when the task carries no loadout (byte-identical path)', () => {
    const task = {} as unknown as Task;
    expect(replayRecordedLoadout(task)).toEqual({});
  });
});

describe('resolveOrReplayLoadout', () => {
  let dir: string;
  let store: LoadoutStore;
  let setCalls: Array<{ id: string; loadout: unknown }>;
  const fakeTaskStore = {
    setLoadout: (id: string, loadout: unknown) => {
      setCalls.push({ id, loadout });
      return {} as never;
    },
  };
  const claudeTask = (over: Partial<Task> = {}): Task =>
    ({ id: 't1', agentType: 'claude-code', projectId: 'proj', playbookId: 'pb', ...over }) as unknown as Task;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-ror-'));
    store = new LoadoutStore(dir);
    setCalls = [];
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  test('FRESH: resolves from store, records intent, and stamps hash/path via onLoadoutApplied', async () => {
    await store.setLevelState('project', 'proj', { plugins: { 'kookr-toolkit@kookr': false } });
    const fields = await resolveOrReplayLoadout({ loadoutStore: store, taskStore: fakeTaskStore }, claudeTask());
    expect(fields.resolvedLoadout?.enabledOverrides).toEqual({ 'kookr-toolkit@kookr': false });
    // intent recorded on first resolve
    expect(setCalls).toHaveLength(1);
    const rec0 = setCalls[0].loadout as TaskLoadoutRecord;
    expect(rec0.winningLevel).toBe('project');
    expect(rec0.mode).toBe('bypass');
    expect(rec0.settingsHash).toBeNull();
    expect(rec0.recordedAt).toBeTruthy();
    // callback stamps hash + path
    fields.onLoadoutApplied!({ settingsHash: 'deadbeef', settingsPath: '/s.json' });
    expect(setCalls).toHaveLength(2);
    const rec1 = setCalls[1].loadout as TaskLoadoutRecord;
    expect(rec1.settingsHash).toBe('deadbeef');
    expect(rec1.settingsPath).toBe('/s.json');
  });

  test('REPLAY: a task that already carries a loadout is replayed verbatim; store NOT consulted', async () => {
    const resolveSpy = vi.spyOn(store, 'resolveForLaunch');
    const recorded: TaskLoadoutRecord = {
      resolved: { enabledOverrides: { 'a@m': false }, deniedSkills: [] },
      winningLevel: 'playbook', mode: 'bypass', settingsHash: 'h', settingsPath: '/p', recordedAt: 'now',
    };
    const fields = await resolveOrReplayLoadout(
      { loadoutStore: store, taskStore: fakeTaskStore },
      claudeTask({ loadout: recorded }),
    );
    expect(fields).toEqual({ resolvedLoadout: recorded.resolved });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0); // nothing re-recorded
  });

  test('NON-CLAUDE agent → no resolution, nothing recorded (RFC acceptance negative)', async () => {
    await store.setLevelState('task-type', 'codex-cli', { plugins: { 'a@m': false } });
    const fields = await resolveOrReplayLoadout(
      { loadoutStore: store, taskStore: fakeTaskStore },
      claudeTask({ agentType: 'codex-cli' as Task['agentType'] }),
    );
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
  });

  test('FLAG OFF → no resolution, nothing recorded', async () => {
    vi.stubEnv('KOOKR_PLUGIN_LOADOUTS', '0');
    await store.setLevelState('project', 'proj', { plugins: { 'a@m': false } });
    const fields = await resolveOrReplayLoadout({ loadoutStore: store, taskStore: fakeTaskStore }, claudeTask());
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
  });

  test('no store configured → {}', async () => {
    const fields = await resolveOrReplayLoadout({ loadoutStore: undefined, taskStore: fakeTaskStore }, claudeTask());
    expect(fields).toEqual({});
  });

  test('store resolves EMPTY → {} and nothing recorded', async () => {
    // no matching entry for this context
    const fields = await resolveOrReplayLoadout({ loadoutStore: store, taskStore: fakeTaskStore }, claudeTask());
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
  });

  test('resolveForLaunch throws → proceeds with no loadout (warns), nothing recorded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(store, 'resolveForLaunch').mockRejectedValueOnce(new Error('boom'));
    const fields = await resolveOrReplayLoadout({ loadoutStore: store, taskStore: fakeTaskStore }, claudeTask());
    expect(fields).toEqual({});
    expect(setCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
