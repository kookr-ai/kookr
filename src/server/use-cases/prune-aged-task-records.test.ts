import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskStore, type Task } from '../../core/tasks.js';
import { GitHubStateStore } from '../../core/github-state-store.js';
import {
  DEFAULT_TASK_RECORD_MAX_AGE_DAYS,
  pruneAgedTaskRecords,
  selectPrunableTasks,
} from './prune-aged-task-records.js';

const NOW = new Date('2026-07-25T12:00:00Z');
const RECENT = new Date('2026-07-24T12:00:00Z'); // 1 day old
const AGED = new Date('2026-07-10T12:00:00Z'); // 15 days old

function seedTask(
  store: TaskStore,
  opts: { session: string; finishedAt?: Date; terminal?: boolean; parentTaskId?: string },
): Task {
  const created = store.createTask({ prompt: `prompt ${opts.session}`, cwd: '/repo', parentTaskId: opts.parentTaskId });
  store.addSession(created.id, {
    tmuxSession: opts.session,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date((opts.finishedAt ?? RECENT).getTime() - 60_000),
  });
  if (opts.terminal !== false) {
    store.completeTask(created.id);
  }
  const task = store.getTaskForMutation(created.id);
  if (!task) throw new Error('missing task');
  if (opts.finishedAt) {
    task.updatedAt = opts.finishedAt;
    task.finishedAt = opts.finishedAt;
  }
  return task;
}

function monitorSpy() {
  return { unregisterAgent: vi.fn() };
}

describe('selectPrunableTasks', () => {
  it('selects aged terminal tasks and keeps recent / active ones', () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged', finishedAt: AGED });
    seedTask(store, { session: 'recent', finishedAt: RECENT });
    seedTask(store, { session: 'active', terminal: false });

    const cutoff = NOW.getTime() - DEFAULT_TASK_RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const prunable = selectPrunableTasks(store.listTasks(), cutoff);
    expect(prunable.map((t) => t.id)).toEqual([aged.id]);
  });

  it('issue #1588: protects a YOUNG pre-session disposed task, prunes an AGED one', () => {
    const store = new TaskStore();

    // A freshly disposed pre-session task (launch timeout): terminal, zero
    // sessions, disposition set — with a recent updatedAt (set by setDisposition
    // / terminateTask). The idempotency window (24h) lives well inside the 7-day
    // prune window, so this must NOT be pruned.
    const young = store.createTask({ prompt: 'young disposed', cwd: '/repo' });
    store.setDisposition(young.id, { reason: 'launch_timeout', at: NOW.toISOString(), source: 'launch-service' });
    store.terminateTask(young.id);
    // Pin recency to the fixed test clock (deterministic) and confirm this is
    // genuinely the pre-session case: terminal, disposed, zero sessions.
    const youngMut = store.getTaskForMutation(young.id)!;
    youngMut.updatedAt = NOW;
    youngMut.finishedAt = NOW;
    youngMut.terminatedAt = NOW;
    expect(youngMut.sessions).toHaveLength(0);
    expect(youngMut.disposition?.reason).toBe('launch_timeout');

    // An aged disposed task (>7 days) is genuinely old — safe to prune; its
    // disposition already served its purpose during the idempotency window.
    const aged = store.createTask({ prompt: 'aged disposed', cwd: '/repo' });
    store.setDisposition(aged.id, { reason: 'launch_error', at: AGED.toISOString(), source: 'launch-service' });
    store.terminateTask(aged.id);
    const agedMut = store.getTaskForMutation(aged.id)!;
    agedMut.updatedAt = AGED;
    agedMut.finishedAt = AGED;
    agedMut.terminatedAt = AGED;

    const cutoff = NOW.getTime() - DEFAULT_TASK_RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const prunable = selectPrunableTasks(store.listTasks(), cutoff);
    expect(prunable.map((t) => t.id)).toEqual([aged.id]);
  });

  it('protects an aged terminal parent whose child is not prunable (fixpoint over chains)', () => {
    const store = new TaskStore();
    const grandparent = seedTask(store, { session: 'grandparent', finishedAt: AGED });
    // Re-open linkage: build parent chain grandparent <- parent <- recent child.
    const storeParent = store.createTask({ prompt: 'parent', cwd: '/repo', parentTaskId: grandparent.id });
    store.addSession(storeParent.id, {
      tmuxSession: 'parent',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: AGED,
    });
    store.completeTask(storeParent.id);
    const parentTask = store.getTaskForMutation(storeParent.id)!;
    parentTask.updatedAt = AGED;
    parentTask.finishedAt = AGED;

    seedTask(store, { session: 'recent-child', finishedAt: RECENT, parentTaskId: storeParent.id });

    const cutoff = NOW.getTime() - DEFAULT_TASK_RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const prunable = selectPrunableTasks(store.listTasks(), cutoff);
    // The recent child protects its parent, which protects the grandparent.
    expect(prunable).toEqual([]);
  });

  it('prunes a whole aged subtree together', () => {
    const store = new TaskStore();
    const parent = seedTask(store, { session: 'parent', finishedAt: AGED });
    const child = store.createTask({ prompt: 'child', cwd: '/repo', parentTaskId: parent.id });
    store.addSession(child.id, { tmuxSession: 'child', agentType: 'claude-code', cwd: '/repo', createdAt: AGED });
    store.completeTask(child.id);
    const childTask = store.getTaskForMutation(child.id)!;
    childTask.updatedAt = AGED;
    childTask.finishedAt = AGED;
    // Linking the child bumped the parent's updatedAt — re-age it.
    const parentTask = store.getTaskForMutation(parent.id)!;
    parentTask.updatedAt = AGED;

    const cutoff = NOW.getTime() - DEFAULT_TASK_RECORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const prunable = selectPrunableTasks(store.listTasks(), cutoff);
    expect(prunable.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort());
  });
});

describe('pruneAgedTaskRecords', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('deletes aged terminal records, unregisters their sessions, and keeps the rest', async () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged-session', finishedAt: AGED });
    const recent = seedTask(store, { session: 'recent-session', finishedAt: RECENT });
    const active = seedTask(store, { session: 'active-session', terminal: false });
    const monitor = monitorSpy();

    const result = await pruneAgedTaskRecords({ taskStore: store, monitor, now: () => NOW.getTime() });

    expect(result.outcome).toBe('pruned');
    expect(result.prunedTaskIds).toEqual([aged.id]);
    expect(result.remainingTasks).toBe(2);
    expect(store.getTask(aged.id)).toBeUndefined();
    expect(store.getTask(recent.id)).toBeDefined();
    expect(store.getTask(active.id)).toBeDefined();
    expect(monitor.unregisterAgent).toHaveBeenCalledWith('aged-session');
    expect(monitor.unregisterAgent).toHaveBeenCalledTimes(1);
  });

  it('drops GitHub store rows for each pruned task', async () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged-session', finishedAt: AGED });
    const recent = seedTask(store, { session: 'recent-session', finishedAt: RECENT });
    const githubStateStore = new GitHubStateStore();
    for (const [taskId, number] of [[aged.id, 31], [recent.id, 32]] as const) {
      const ref = {
        type: 'pr' as const,
        owner: 'kookr-ai',
        repo: 'kookr',
        number,
        url: `https://github.com/kookr-ai/kookr/pull/${number}`,
        taskId,
        detectedAt: new Date(),
        detectedFrom: 'agent-1',
      };
      githubStateStore.addReference(ref);
    }

    await pruneAgedTaskRecords({
      taskStore: store,
      monitor: monitorSpy(),
      githubStateStore,
      now: () => NOW.getTime(),
    });

    expect(githubStateStore.getReferences(aged.id)).toHaveLength(0);
    expect(githubStateStore.getReferences(recent.id)).toHaveLength(1);
  });

  it('drops relations referencing a pruned task (persisted form shrinks)', async () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged-session', finishedAt: AGED });
    const recent = seedTask(store, { session: 'recent-session', finishedAt: RECENT });
    store.upsertRelation({
      sourceTaskId: aged.id,
      targetTaskId: recent.id,
      type: 'related_to',
      lifecycle: 'active',
      source: 'deterministic',
      confidence: 1,
    } as never);
    expect(store.listRelations()).toHaveLength(1);

    await pruneAgedTaskRecords({ taskStore: store, monitor: monitorSpy(), now: () => NOW.getTime() });
    expect(store.listRelations()).toHaveLength(0);
  });

  it('takes the predelete snapshot first and aborts when it fails', async () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged-session', finishedAt: AGED });

    const result = await pruneAgedTaskRecords({
      taskStore: store,
      monitor: monitorSpy(),
      takePredeleteSnapshot: async () => {
        throw new Error('disk full');
      },
      now: () => NOW.getTime(),
    });

    expect(result.outcome).toBe('snapshot_failed');
    expect(result.prunedTaskIds).toEqual([]);
    expect(store.getTask(aged.id)).toBeDefined();
  });

  it('is a no-op (and takes no snapshot) when nothing is eligible', async () => {
    const store = new TaskStore();
    seedTask(store, { session: 'recent-session', finishedAt: RECENT });
    const takePredeleteSnapshot = vi.fn();

    const result = await pruneAgedTaskRecords({
      taskStore: store,
      monitor: monitorSpy(),
      takePredeleteSnapshot,
      now: () => NOW.getTime(),
    });

    expect(result.outcome).toBe('pruned');
    expect(result.prunedTaskIds).toEqual([]);
    expect(result.remainingTasks).toBe(1);
    expect(takePredeleteSnapshot).not.toHaveBeenCalled();
  });

  it('appends a task.pruneAged audit row', async () => {
    const store = new TaskStore();
    const aged = seedTask(store, { session: 'aged-session', finishedAt: AGED });
    tempDir = await mkdtemp(join(tmpdir(), 'prune-audit-'));
    const auditLogPath = join(tempDir, 'audit.jsonl');

    await pruneAgedTaskRecords({
      taskStore: store,
      monitor: monitorSpy(),
      auditLogPath,
      now: () => NOW.getTime(),
    });

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.pruneAged',
      actor: { source: 'maintenance-prune' },
      count: 1,
      deletedTaskIds: [aged.id],
      maxAgeDays: DEFAULT_TASK_RECORD_MAX_AGE_DAYS,
    });
  });

  it('rejects a non-positive maxAgeDays', async () => {
    const store = new TaskStore();
    await expect(
      pruneAgedTaskRecords({ taskStore: store, monitor: monitorSpy() }, { maxAgeDays: 0 }),
    ).rejects.toThrow(/maxAgeDays/);
  });
});
