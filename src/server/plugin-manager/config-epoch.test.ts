import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigEpochStore,
  CONFIG_EPOCH_FILENAME,
  computeConfigDrift,
  stampSessionConfigEpoch,
  type SessionEpochView,
} from './config-epoch.js';
import type { Task } from '../../core/task-read-model.js';

describe('ConfigEpochStore', () => {
  let dir: string;
  let store: ConfigEpochStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-config-epoch-'));
    store = new ConfigEpochStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('missing file reads as epoch 0', async () => {
    expect(await store.current()).toBe(0);
  });

  test('malformed file reads as epoch 0 (never throws)', async () => {
    writeFileSync(join(dir, CONFIG_EPOCH_FILENAME), '{ not json');
    expect(await store.current()).toBe(0);
  });

  test('a non-integer/negative epoch coerces to 0', async () => {
    writeFileSync(join(dir, CONFIG_EPOCH_FILENAME), JSON.stringify({ epoch: -4 }));
    expect(await store.current()).toBe(0);
    writeFileSync(join(dir, CONFIG_EPOCH_FILENAME), JSON.stringify({ epoch: 'x' }));
    expect(await store.current()).toBe(0);
  });

  test('bump increments and persists, returning the new epoch', async () => {
    const t = new Date('2026-11-07T00:00:00.000Z');
    expect(await store.bump(() => t)).toBe(1);
    expect(await store.current()).toBe(1);
    expect(await store.bump(() => t)).toBe(2);
    expect(await store.current()).toBe(2);
    const persisted = JSON.parse(readFileSync(join(dir, CONFIG_EPOCH_FILENAME), 'utf8'));
    expect(persisted.epoch).toBe(2);
    expect(persisted.bumpedAt).toBe(t.toISOString());
  });
});

describe('computeConfigDrift', () => {
  const base: SessionEpochView = {
    taskId: 't',
    agentType: 'claude-code',
    isTerminal: false,
    configEpochAtStart: 0,
    startedAt: '2026-11-07T10:00:00.000Z',
  };

  test('a Kookr-managed claude session behind the current epoch is stale', () => {
    const drift = computeConfigDrift(2, [{ ...base, taskId: 't1', configEpochAtStart: 1 }]);
    expect(drift.currentEpoch).toBe(2);
    expect(drift.staleCount).toBe(1);
    expect(drift.staleSessions[0]).toMatchObject({ taskId: 't1', startedEpoch: 1 });
    expect(drift.externalCoverageNote).toMatch(/external terminals/i);
  });

  test('a session at the current epoch is NOT stale', () => {
    const drift = computeConfigDrift(2, [{ ...base, configEpochAtStart: 2 }]);
    expect(drift.staleCount).toBe(0);
  });

  test('terminal, non-claude, and unstamped sessions are excluded', () => {
    const drift = computeConfigDrift(5, [
      { ...base, taskId: 'terminal', isTerminal: true, configEpochAtStart: 0 },
      { ...base, taskId: 'codex', agentType: 'codex', configEpochAtStart: 0 },
      { ...base, taskId: 'legacy', configEpochAtStart: undefined },
      { ...base, taskId: 'live', configEpochAtStart: 1 },
    ]);
    expect(drift.staleSessions.map((s) => s.taskId)).toEqual(['live']);
  });

  test('stale sessions are newest-first', () => {
    const drift = computeConfigDrift(9, [
      { ...base, taskId: 'old', configEpochAtStart: 1, startedAt: '2026-11-07T08:00:00.000Z' },
      { ...base, taskId: 'new', configEpochAtStart: 1, startedAt: '2026-11-07T12:00:00.000Z' },
    ]);
    expect(drift.staleSessions.map((s) => s.taskId)).toEqual(['new', 'old']);
  });
});

describe('stampSessionConfigEpoch', () => {
  function taskStoreSpy() {
    const calls: Array<{ id: string; epoch: number }> = [];
    return {
      calls,
      setConfigEpochAtStart(id: string, epoch: number) {
        calls.push({ id, epoch });
        return {} as Task;
      },
    };
  }
  const claudeTask = { id: 't', agentType: 'claude-code' as const, configEpochAtStart: undefined };

  test('stamps a first-spawn claude session with the current epoch', async () => {
    const taskStore = taskStoreSpy();
    const epoch = { current: async () => 4 } as unknown as ConfigEpochStore;
    await stampSessionConfigEpoch({ configEpochStore: epoch, taskStore }, claudeTask);
    expect(taskStore.calls).toEqual([{ id: 't', epoch: 4 }]);
  });

  test('no-op when unwired, non-claude, or already stamped', async () => {
    const epoch = { current: async () => 4 } as unknown as ConfigEpochStore;
    const unwired = taskStoreSpy();
    await stampSessionConfigEpoch({ taskStore: unwired }, claudeTask);
    expect(unwired.calls).toHaveLength(0);

    const nonClaude = taskStoreSpy();
    await stampSessionConfigEpoch({ configEpochStore: epoch, taskStore: nonClaude }, { ...claudeTask, agentType: 'codex' });
    expect(nonClaude.calls).toHaveLength(0);

    const alreadyStamped = taskStoreSpy();
    await stampSessionConfigEpoch({ configEpochStore: epoch, taskStore: alreadyStamped }, { ...claudeTask, configEpochAtStart: 2 });
    expect(alreadyStamped.calls).toHaveLength(0);
  });
});
