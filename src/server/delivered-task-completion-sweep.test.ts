import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./dirty-worktree-completion-finding.js', () => ({
  surfaceDirtyWorktreeOnHeadlessCompletion: vi.fn(async () => false),
}));
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
const mockSurfaceDirty = vi.mocked(surfaceDirtyWorktreeOnHeadlessCompletion);
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { signalOutboxPendingPath } from '../core/signal-outbox.js';
import { DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS, type MergedPrAttribution } from '../core/completion/index.js';
import {
  autoCompleteDeliveredTasks,
  createDeliveredCompletionTracker,
  type AutoCompleteDeliveredDeps,
} from './delivered-task-completion-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';

const MERGED: MergedPrAttribution = {
  prNumber: 1542,
  prUrl: 'https://github.com/kookr-ai/kookr/pull/1542',
  owner: 'kookr-ai',
  repo: 'kookr',
};
const T0 = new Date('2026-07-26T00:00:00.000Z');
const plus = (base: Date, ms: number) => new Date(base.getTime() + ms);

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeSpoolDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-delivered-outbox-'));
  tmpDirs.push(dir);
  return dir;
}

/** Minimal LifecycleDeps sufficient for `completeTask`, mirroring the auto-close sweep tests. */
function lifecycleDeps(taskStore: TaskStore): LifecycleDeps {
  return {
    adapter: { stop: vi.fn(async () => undefined) },
    monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
    taskStore,
    queue: new AttentionQueue(),
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
  } as unknown as LifecycleDeps;
}

/** Create an inProgress task with one live session. */
function makeRunningTask(taskStore: TaskStore, prompt = 'implement issue'): string {
  const task = taskStore.createTask({ prompt, cwd: '/tmp', autoCloseOnSignal: true });
  taskStore.addSession(task.id, {
    tmuxSession: `kookr-${task.id}`,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: T0,
  });
  return task.id;
}

function baseDeps(
  taskStore: TaskStore,
  resolveMergedPr: AutoCompleteDeliveredDeps['resolveMergedPr'],
  overrides: Partial<AutoCompleteDeliveredDeps> = {},
): AutoCompleteDeliveredDeps {
  return {
    taskStore,
    lifecycleDeps: lifecycleDeps(taskStore),
    resolveMergedPr,
    tracker: createDeliveredCompletionTracker(),
    ...overrides,
  };
}

describe('autoCompleteDeliveredTasks (issue #1560)', () => {
  test('AC: a post-merge hang self-completes within 15 min at the default 10m budget', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const resolveMergedPr = () => MERGED;

    // Tick 1 at merge time: within budget, records the first-observed clock.
    const r1 = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, resolveMergedPr, { tracker, now: () => T0 }),
    );
    expect(r1.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    // Tick just before the budget: must NOT complete early.
    const early = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, resolveMergedPr, { tracker, now: () => plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS - 1_000) }),
    );
    expect(early.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    // Next tick landing at budget + one 5s liveness-poll of slack: self-completes.
    const POLL_SLACK_MS = 5_000;
    const at = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + POLL_SLACK_MS);
    const r2 = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, resolveMergedPr, { tracker, now: () => at }),
    );
    expect(r2.completedTaskIds).toEqual([id]);
    expect(taskStore.getTask(id)?.status).toBe('completed');
    // The completion tick (budget + polling slack) is within the 15-minute bound.
    expect(at.getTime() - T0.getTime()).toBeLessThanOrEqual(15 * 60_000);
  });

  test('surfaces a dirty-worktree finding before completing a delivered task (issue #1580)', async () => {
    mockSurfaceDirty.mockClear();
    mockSurfaceDirty.mockResolvedValue(true);
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 5_000);
    const broadcastToAll = vi.fn();

    // Prime the clock, then complete past the budget.
    await autoCompleteDeliveredTasks(baseDeps(taskStore, () => MERGED, { tracker, now: () => T0, broadcastToAll }));
    const r = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => past, broadcastToAll }),
    );

    expect(r.completedTaskIds).toEqual([id]);
    expect(taskStore.getTask(id)?.status).toBe('completed');
    // The finding is surfaced for the delivered task before completion.
    expect(mockSurfaceDirty).toHaveBeenCalledTimes(1);
    expect(mockSurfaceDirty.mock.calls[0]![0].id).toBe(id);
    expect(mockSurfaceDirty.mock.calls[0]![1]).toMatchObject({ taskStore, broadcastToAll });
  });

  test('AC: the completion digest names the merged PR number', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 5_000);

    // Prime the clock (first observation), then complete.
    await autoCompleteDeliveredTasks(baseDeps(taskStore, () => MERGED, { tracker, now: () => T0 }));
    await autoCompleteDeliveredTasks(baseDeps(taskStore, () => MERGED, { tracker, now: () => past }));

    const digest = taskStore.getTask(id)?.completionDigest;
    expect(digest).toBeDefined();
    expect(digest!.bullets[0]).toContain('PR #1542');
    expect(digest!.prUrls).toEqual([MERGED.prUrl]);
  });

  test('AC: the signal flows through the #1541 outbox / autoCloseOnSignal path', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const spoolDir = await makeSpoolDir();
    const onTaskOutcome = vi.fn();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    const deps = (now: Date) =>
      baseDeps(taskStore, () => MERGED, {
        tracker,
        now: () => now,
        signalOutboxSpoolDir: spoolDir,
        onTaskOutcome,
      });

    await autoCompleteDeliveredTasks(deps(T0));
    await autoCompleteDeliveredTasks(deps(past));

    // completion_ready outcome fired (the outbox/autoCloseOnSignal hook), naming the PR.
    expect(onTaskOutcome).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ kind: 'completion_ready', note: expect.stringContaining('PR #1542') }),
    );
    // The completion was stamped as the outbox-drained completion_ready path —
    // proof it went through the signal surface, not a parallel mechanism.
    expect(taskStore.getTask(id)?.completionPath).toBe('outbox_drained');
    // The durable outbox spool was written (append) then drained (remove).
    expect(existsSync(signalOutboxPendingPath(spoolDir))).toBe(true);
    const pending = await readFile(signalOutboxPendingPath(spoolDir), 'utf8');
    expect(pending.trim()).toBe('');
    expect(taskStore.getTask(id)?.status).toBe('completed');
  });

  test('AC negative: a task whose PR is NOT merged is never auto-completed', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();

    // Way past any budget, but no merged PR.
    for (const offset of [0, 60 * 60_000, 24 * 60 * 60_000]) {
      const r = await autoCompleteDeliveredTasks(
        baseDeps(taskStore, () => null, { tracker, now: () => plus(T0, offset) }),
      );
      expect(r.completedTaskIds).toEqual([]);
    }
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
    expect(taskStore.getPendingSignal(id)).toBeUndefined();
  });

  test('AC: the budget is configurable', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const budgetMs = 2 * 60_000; // 2-minute budget

    await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => T0 }),
      { budgetMs },
    );
    // Still inside the default budget would be too early; at 2m it completes.
    const early = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => plus(T0, 90_000) }),
      { budgetMs },
    );
    expect(early.completedTaskIds).toEqual([]);
    const due = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => plus(T0, budgetMs) }),
      { budgetMs },
    );
    expect(due.completedTaskIds).toEqual([id]);
  });

  // INVARIANT 5 — single completion under genuine contention. A shared
  // signalOutboxSpoolDir makes `raiseCompletionReadyViaOutbox` `await
  // appendSignalOutbox` BEFORE it sets the pending signal, so both sweeps pass
  // the classify check and both drive `completeTask`; the second's terminal
  // transition throws InvalidTransition and the catch-block backstop no-ops it.
  // Exactly-once must still hold. (Without the spool dir the pending signal is
  // set in the first sweep's synchronous prefix, so the race is never joined.)
  test('INV5: concurrent sweeps complete a delivered task exactly once', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const spoolDir = await makeSpoolDir();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    const raceDeps = () =>
      baseDeps(taskStore, () => MERGED, { tracker, now: () => past, signalOutboxSpoolDir: spoolDir });

    // Prime the observation clock (also with a spool dir, harmlessly).
    await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => T0, signalOutboxSpoolDir: spoolDir }),
    );

    const [a, b] = await Promise.all([
      autoCompleteDeliveredTasks(raceDeps()),
      autoCompleteDeliveredTasks(raceDeps()),
    ]);

    const completions = [...a.completedTaskIds, ...b.completedTaskIds].filter((x) => x === id);
    expect(completions).toHaveLength(1);
    expect(taskStore.getTask(id)?.status).toBe('completed');
    // The losing sweep's backstop cleared the pending signal — no leftover overlay.
    expect(taskStore.getPendingSignal(id)).toBeUndefined();
  });

  test('does not auto-complete a delivered task that did not opt into autoCloseOnSignal', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'ask-first delivery', cwd: '/tmp' }); // no autoCloseOnSignal
    taskStore.addSession(task.id, {
      tmuxSession: `kookr-${task.id}`,
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: T0,
    });
    const tracker = createDeliveredCompletionTracker();

    for (const offset of [0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS, 2 * 60 * 60_000]) {
      const r = await autoCompleteDeliveredTasks(
        baseDeps(taskStore, () => MERGED, { tracker, now: () => plus(T0, offset) }),
      );
      expect(r.completedTaskIds).toEqual([]);
    }
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('throttle: no more than one batch per interval (≥60s spacing)', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    // First throttled tick observes the merge and records lastSweepAt.
    await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => T0 }),
      { throttle: true },
    );
    // A due tick only 30s later is throttled — no completion despite budget met.
    const throttled = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => plus(T0, 30_000) }),
      { throttle: true },
    );
    expect(throttled.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    // Past the 60s batch spacing (and the budget), the next batch completes it.
    const due = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => past }),
      { throttle: true },
    );
    expect(due.completedTaskIds).toEqual([id]);
  });

  test('writes a delivered-auto-complete audit row and broadcasts an alert', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const dir = await mkdtemp(join(tmpdir(), 'kookr-delivered-audit-'));
    tmpDirs.push(dir);
    const auditLogPath = join(dir, 'audit.jsonl');
    const broadcastToAll = vi.fn();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    const deps = (now: Date) =>
      baseDeps(taskStore, () => MERGED, { tracker, now: () => now, auditLogPath, broadcastToAll });
    await autoCompleteDeliveredTasks(deps(T0));
    await autoCompleteDeliveredTasks(deps(past));

    const audit = await readFile(auditLogPath, 'utf8');
    expect(audit).toContain('task.deliveredAutoComplete');
    expect(audit).toContain('system:delivered-auto-complete');
    expect(audit).toContain('1542');
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'alert', severity: 'info' }),
    );
    void id;
  });

  test('caps completions per tick and drains the rest on the next tick', async () => {
    const taskStore = new TaskStore();
    const tracker = createDeliveredCompletionTracker();
    const ids = [0, 1, 2].map((i) => makeRunningTask(taskStore, `task ${i}`));
    const resolveMergedPr = (task: { id: string }) => ({
      prNumber: 100 + ids.indexOf(task.id),
      prUrl: `https://github.com/kookr-ai/kookr/pull/${100 + ids.indexOf(task.id)}`,
    });
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    // Prime clocks for all three.
    await autoCompleteDeliveredTasks(baseDeps(taskStore, resolveMergedPr, { tracker, now: () => T0 }));

    const first = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, resolveMergedPr, { tracker, now: () => past }),
      { maxPerTick: 2 },
    );
    expect(first.completedTaskIds).toHaveLength(2);

    const second = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, resolveMergedPr, { tracker, now: () => plus(past, 1_000) }),
      { maxPerTick: 2 },
    );
    expect(second.completedTaskIds).toHaveLength(1);
    expect(taskStore.listTasks().every((t) => t.status === 'completed')).toBe(true);
  });

  test('issue #1667: provider-paused child is never auto-completed as delivered; resumes after pause clears', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS + 5_000);
    let paused = true;
    const isProviderPaused = () => paused;

    // Prime the budget clock.
    await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => T0, isProviderPaused }),
    );

    // Stall: past budget but provider-paused → must stay inProgress.
    const stalled = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => past, isProviderPaused }),
    );
    expect(stalled.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    // Resume: pause clears → delivered auto-complete may fire.
    paused = false;
    const resumed = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => plus(past, 1_000), isProviderPaused }),
    );
    expect(resumed.completedTaskIds).toEqual([id]);
    expect(taskStore.getTask(id)?.status).toBe('completed');
  });
});
