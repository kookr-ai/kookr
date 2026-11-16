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

// Capture every entry appended to the durable outbox so a test can assert the
// session/generation identity the sweep binds onto its completion delivery
// (issue #3066). The real append/remove behavior is preserved by delegating to
// the actual module.
const { appendedEntries } = vi.hoisted(() => ({
  appendedEntries: [] as import('../core/signal-outbox.js').SignalOutboxEntry[],
}));
vi.mock('../core/signal-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/signal-outbox.js')>();
  return {
    ...actual,
    appendSignalOutbox: vi.fn(async (dir: string, entry, opts) => {
      appendedEntries.push(entry);
      return actual.appendSignalOutbox(dir, entry, opts);
    }),
  };
});

import { TaskStore } from '../core/tasks.js';
import type { Task } from '../core/task-read-model.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { signalOutboxPendingPath } from '../core/signal-outbox.js';
import {
  DEFAULT_FINISHED_MERGED_SETTLE_MS,
  DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  type MergedPrAttribution,
} from '../core/completion/index.js';
import {
  appendSignalOutbox,
  buildSignalOutboxEntry,
  readPendingSignals,
} from '../core/signal-outbox.js';
import {
  DELIVERED_AUTO_COMPLETE_ACTOR,
  DELIVERED_SWEEP_MIN_INTERVAL_MS,
  autoCompleteDeliveredTasks,
  createDeliveredCompletionTracker,
  createStoreDeliveredPrResolver,
  type AutoCompleteDeliveredDeps,
} from './delivered-task-completion-sweep.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { CHAIN_ENDED_WITHOUT_HANDOFF_BULLET } from '../core/completion/chain-handoff.js';
import { storeResolverWithMergedPr } from './__fixtures__/delivered-pr-resolver.js';
import type { GitHubPRState, GitHubReference } from '../core/github-types.js';
import { SignalOutboxService } from './signal-outbox-service.js';
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
  appendedEntries.length = 0;
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

  test('issue #3066: the raised completion delivery is bound to the task current session', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const tracker = createDeliveredCompletionTracker();
    const spoolDir = await makeSpoolDir();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);

    const deps = (now: Date) =>
      baseDeps(taskStore, () => MERGED, { tracker, now: () => now, signalOutboxSpoolDir: spoolDir });
    await autoCompleteDeliveredTasks(deps(T0));
    await autoCompleteDeliveredTasks(deps(past));

    // The durable entry the sweep spooled carries the task's live session id, so
    // a crash-surviving replay of THIS delivery can be fenced against a later
    // generation of the same task (the #3066 identity binding).
    const completionEntries = appendedEntries.filter((e) => e.kind === 'completion_ready');
    expect(completionEntries).toHaveLength(1);
    expect(completionEntries[0]!.boundSessionId).toBe(`kookr-${id}`);
  });

  test('issue #3066: a quarantined stale delivery is self-healing — the sweep re-raises for the live session and completes it', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'KB-Scout iteration 5', cwd: '/tmp', autoCloseOnSignal: true });
    // The current (live) generation's session.
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-gen-2',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: T0,
    });
    const spoolDir = await makeSpoolDir();

    // A stale completion delivery from a PRIOR generation survives in the spool.
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'stale-535',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'Delivered: PR #535 merged; post-merge cleanup exceeded the 10m budget',
      boundSessionId: 'kookr-gen-1',
    }));

    // Draining it must quarantine (not terminalize) and clear the spool.
    const svc = new SignalOutboxService({ taskStore, spoolDir, log: () => {} });
    const drain = await svc.tick();
    expect(drain.drained.permanentFailed).toBe(1);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);

    // The task is genuinely delivered in the CURRENT generation → the sweep
    // re-raises a fresh, correctly-bound completion and completes it. A
    // false-quarantine of a truly-done task is therefore self-healing, not a
    // permanent strand (the "not stranded" guarantee, exercised end-to-end).
    const tracker = createDeliveredCompletionTracker();
    const past = plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS);
    await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => T0, signalOutboxSpoolDir: spoolDir }),
    );
    const r = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED, { tracker, now: () => past, signalOutboxSpoolDir: spoolDir }),
    );
    expect(r.completedTaskIds).toEqual([task.id]);
    expect(taskStore.getTask(task.id)?.status).toBe('completed');

    // The re-raised delivery was bound to the live generation, not the stale one,
    // and the digest names the CURRENT delivery's PR — not the stale #535.
    const reRaised = appendedEntries.filter(
      (e) => e.kind === 'completion_ready' && e.signalId !== 'stale-535',
    );
    expect(reRaised).toHaveLength(1);
    expect(reRaised[0]!.boundSessionId).toBe('kookr-gen-2');
    const digest = taskStore.getTask(task.id)?.completionDigest;
    expect(digest?.bullets[0]).toContain(`PR #${MERGED.prNumber}`);
    expect(digest?.bullets[0]).not.toContain('#535');
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

/**
 * Issue #3746: the sweep wired to the PRODUCTION attribution
 * (`createStoreDeliveredPrResolver` over a real `GitHubStateStore`), not a
 * canned resolver — prod task 07eeed57 was completed over PR #855, merged five
 * months before the task existed, because the agent merely saw its number.
 */
describe('autoCompleteDeliveredTasks over the GitHubStateStore attribution (issue #3746)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Record a merged PR seen in the task's own agent activity (not the prompt).
   * `openedAt` is the PR's GitHub `createdAt`; it defaults to the merge time,
   * and `null` records none.
   */
  function storeWithMergedPr(
    taskId: string,
    prNumber: number,
    mergedAt: Date | undefined,
    openedAt: Date | null | undefined = mergedAt,
  ): GitHubStateStore {
    const store = new GitHubStateStore();
    const ref: GitHubReference = {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: prNumber,
      url: `https://github.com/kookr-ai/kookr/pull/${prNumber}`,
      detectedAt: new Date(),
      detectedFrom: `kookr-${taskId}`,
      taskId,
    };
    store.addReference(ref);
    const prState: GitHubPRState = {
      ref,
      title: 'feat/ux-dogfooding-rfc-and-fixes',
      status: 'merged',
      mergeable: 'UNKNOWN',
      author: 'someone',
      branch: 'feat/ux-dogfooding-rfc-and-fixes',
      baseBranch: 'main',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      ...(openedAt ? { createdAt: openedAt } : {}),
      ...(mergedAt ? { mergedAt } : {}),
      lastFetchedAt: new Date(),
    };
    store.updatePRState(prState);
    return store;
  }

  /** Two sweep ticks: first sighting, then well past the budget. */
  async function sweepPastBudget(taskStore: TaskStore, store: GitHubStateStore): Promise<string[]> {
    const tracker = createDeliveredCompletionTracker();
    const resolveMergedPr = createStoreDeliveredPrResolver(store, () => undefined);
    const start = new Date();
    await autoCompleteDeliveredTasks(baseDeps(taskStore, resolveMergedPr, { tracker, now: () => start }));
    const later = plus(start, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS * 2);
    const r = await autoCompleteDeliveredTasks(baseDeps(taskStore, resolveMergedPr, { tracker, now: () => later }));
    return r.completedTaskIds;
  }

  test('AC: a live task whose activity mentions a long-merged PR is never auto-completed', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    const store = storeWithMergedPr(id, 855, new Date(createdAt.getTime() - 157 * DAY_MS));

    expect(await sweepPastBudget(taskStore, store)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('a PR merged after the task was created still auto-completes once the budget elapses', async () => {
    // Positive control: same wiring, so the negative case above cannot pass vacuously.
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    const store = storeWithMergedPr(id, 3800, new Date(createdAt.getTime() + 60_000));

    expect(await sweepPastBudget(taskStore, store)).toEqual([id]);
    expect(taskStore.getTask(id)?.status).toBe('completed');
  });

  test('a merged PR with no recorded merge time is not treated as delivery', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    // Opened after the task was created, so only the unknown merge time can reject it.
    const store = storeWithMergedPr(id, 855, undefined, new Date(createdAt.getTime() + 60_000));

    expect(await sweepPastBudget(taskStore, store)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('issue #3678: a chain successor is not completed over its predecessor\'s PR merging after it started', async () => {
    // The predecessor opened the PR and enabled auto-merge, then spawned this
    // task; the successor mentioned the PR, and the merge landed after it started.
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    const store = storeWithMergedPr(
      id,
      3603,
      new Date(createdAt.getTime() + 60_000),
      new Date(createdAt.getTime() - 30 * 60_000),
    );

    expect(await sweepPastBudget(taskStore, store)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('a merged PR with no recorded opening time is not treated as delivery', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    const store = storeWithMergedPr(id, 3800, new Date(createdAt.getTime() + 60_000), null);
    expect(store.getTaskState(id).prs[0]?.createdAt).toBeUndefined();

    expect(await sweepPastBudget(taskStore, store)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });
});

/**
 * Issue #3930: a task that said "finished" after its own PR merged is completed
 * after the short settle time (default 2 minutes) instead of the 10-minute
 * cleanup budget, behind the same live-work veto as the completion-ready sweep.
 */
describe('autoCompleteDeliveredTasks — settle path after a post-merge "finished" (issue #3930)', () => {
  const MERGED_AT = T0;
  const SIGNAL_AT = plus(T0, 60_000);
  const MERGED_WITH_TIME: MergedPrAttribution = { ...MERGED, mergedAt: MERGED_AT };
  const HUMAN_PANE = 'some agent output\n❯\n';

  /**
   * The real production state: the agent raised `completion_ready` from a Bash
   * call and that call's own PostToolUse event cleared the pending signal.
   */
  function saidFinished(taskStore: TaskStore, id: string, at: Date = SIGNAL_AT): void {
    taskStore.setPendingSignal(id, { kind: 'completion_ready', raisedAt: at.toISOString() });
    taskStore.clearPendingSignal(id);
  }

  async function sweepAt(
    taskStore: TaskStore,
    now: Date,
    overrides: Partial<AutoCompleteDeliveredDeps> = {},
    opts: Parameters<typeof autoCompleteDeliveredTasks>[1] = {},
  ) {
    return autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => MERGED_WITH_TIME, { now: () => now, ...overrides }),
      opts,
    );
  }

  const AFTER_SETTLE = plus(SIGNAL_AT, DEFAULT_FINISHED_MERGED_SETTLE_MS);

  test('AC: a PR merged into staging plus a "finished" signal completes within the settle time plus one sweep', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const createdAt = taskStore.getTask(id)!.createdAt;
    const mergedAt = plus(createdAt, 60_000);
    const signalAt = plus(createdAt, 120_000);

    // Production attribution over a GitHubStateStore whose PR base is `staging`,
    // not the default branch.
    const store = new GitHubStateStore();
    const ref: GitHubReference = {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 3941,
      url: 'https://github.com/kookr-ai/kookr/pull/3941',
      detectedAt: createdAt,
      detectedFrom: `kookr-${id}`,
      taskId: id,
    };
    store.addReference(ref);
    store.updatePRState({
      ref,
      title: 'fix: something',
      status: 'merged',
      mergeable: 'UNKNOWN',
      author: 'someone',
      branch: 'feat-issue-3930',
      baseBranch: 'staging',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      createdAt: plus(createdAt, 30_000),
      mergedAt,
      lastFetchedAt: mergedAt,
    });
    saidFinished(taskStore, id, signalAt);

    const dir = await mkdtemp(join(tmpdir(), 'kookr-delivered-settle-'));
    tmpDirs.push(dir);
    const auditLogPath = join(dir, 'audit.jsonl');
    const tracker = createDeliveredCompletionTracker();
    const resolveMergedPr = createStoreDeliveredPrResolver(store, () => undefined);

    // Liveness ticks every 5s, sweep throttled to one batch per 60s.
    let completedAt: Date | undefined;
    for (let t = signalAt.getTime(); t <= signalAt.getTime() + 10 * 60_000; t += 5_000) {
      const now = new Date(t);
      const r = await autoCompleteDeliveredTasks(
        baseDeps(taskStore, resolveMergedPr, { tracker, now: () => now, auditLogPath }),
        { throttle: true },
      );
      if (r.completedTaskIds.includes(id)) {
        completedAt = now;
        break;
      }
    }
    expect(completedAt).toBeDefined();
    const waited = completedAt!.getTime() - signalAt.getTime();
    expect(waited).toBeGreaterThanOrEqual(DEFAULT_FINISHED_MERGED_SETTLE_MS);
    expect(waited).toBeLessThanOrEqual(DEFAULT_FINISHED_MERGED_SETTLE_MS + DELIVERED_SWEEP_MIN_INTERVAL_MS);
    expect(taskStore.getTask(id)?.status).toBe('completed');

    const rows = (await readFile(auditLogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([
      expect.objectContaining({
        type: 'task.deliveredAutoComplete',
        taskId: id,
        reason: 'finished_after_merge',
        prNumber: 3941,
        prUrl: 'https://github.com/kookr-ai/kookr/pull/3941',
        settleMs: DEFAULT_FINISHED_MERGED_SETTLE_MS,
      }),
    ]);
    expect(taskStore.getTask(id)?.completionDigest?.bullets[0]).toContain('settle time');
  });

  test('does not complete inside the settle time', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    const r = await sweepAt(taskStore, plus(AFTER_SETTLE, -1_000));
    expect(r.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('AC negative: a "finished" signal with no merged PR is left alone', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    taskStore.setPendingSignal(id, { kind: 'completion_ready', raisedAt: SIGNAL_AT.toISOString() });
    const r = await autoCompleteDeliveredTasks(
      baseDeps(taskStore, () => null, { now: () => plus(SIGNAL_AT, 60 * 60_000) }),
    );
    expect(r.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
    // The pending signal is still there for the existing "finished" paths.
    expect(taskStore.getTask(id)?.pendingSignal?.kind).toBe('completion_ready');
  });

  test('protection: a turn in progress blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    taskStore.updateSession(id, `kookr-${id}`, { lastTurnState: 'running' });
    expect((await sweepAt(taskStore, AFTER_SETTLE)).completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    // Positive control: once the turn ends, the same sweep completes it.
    taskStore.updateSession(id, `kookr-${id}`, { lastTurnState: 'completed_turn' });
    expect((await sweepAt(taskStore, AFTER_SETTLE)).completedTaskIds).toEqual([id]);
  });

  test('protection: a person typing in the terminal (interactive pane) blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    let pane = HUMAN_PANE;
    const getTaskPaneText = vi.fn(async () => pane);
    expect((await sweepAt(taskStore, AFTER_SETTLE, { getTaskPaneText })).completedTaskIds).toEqual([]);
    expect(getTaskPaneText).toHaveBeenCalledWith(id);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');

    pane = 'just some agent output';
    expect((await sweepAt(taskStore, AFTER_SETTLE, { getTaskPaneText })).completedTaskIds).toEqual([id]);
  });

  test('protection: a viewer with the task attached blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    const r = await sweepAt(taskStore, AFTER_SETTLE, { isTaskSelectedByAnyConnection: () => true });
    expect(r.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('protection: a confirmed-open PR blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    const r = await sweepAt(taskStore, AFTER_SETTLE, { isHoldingOpenPr: () => true });
    expect(r.completedTaskIds).toEqual([]);
  });

  test('protection: an active Ralph loop blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    taskStore.getTaskForMutation(id)!.ralphLoop = { status: 'running' } as Task['ralphLoop'];
    expect((await sweepAt(taskStore, AFTER_SETTLE)).completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('protection: a paused provider blocks the completion', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    const r = await sweepAt(taskStore, AFTER_SETTLE, { isProviderPaused: () => true });
    expect(r.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('protection: at most two completions per minute, and a vetoed task does not use a slot', async () => {
    const taskStore = new TaskStore();
    const ids = [0, 1, 2, 3].map((i) => makeRunningTask(taskStore, `task ${i}`));
    for (const id of ids) saidFinished(taskStore, id);
    // The first task listed is attended; it must not use one of the two slots.
    const attended = ids[0]!;
    const isTaskSelectedByAnyConnection = (taskId: string) => taskId === attended;
    const tracker = createDeliveredCompletionTracker();

    const first = await sweepAt(taskStore, AFTER_SETTLE, { tracker, isTaskSelectedByAnyConnection }, { throttle: true });
    expect(first.completedTaskIds).toEqual([ids[1], ids[2]]);

    // Within the same minute: throttled, nothing more.
    const throttled = await sweepAt(
      taskStore, plus(AFTER_SETTLE, 30_000), { tracker, isTaskSelectedByAnyConnection }, { throttle: true },
    );
    expect(throttled.completedTaskIds).toEqual([]);

    const next = await sweepAt(
      taskStore, plus(AFTER_SETTLE, DELIVERED_SWEEP_MIN_INTERVAL_MS), { tracker, isTaskSelectedByAnyConnection }, { throttle: true },
    );
    expect(next.completedTaskIds).toEqual([ids[3]]);
    expect(taskStore.getTask(attended)?.status).toBe('inProgress');
  });

  test('a new user prompt after the "finished" signal returns the task to the cleanup budget', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    saidFinished(taskStore, id);
    taskStore.clearFinishedSignal(id);
    expect((await sweepAt(taskStore, AFTER_SETTLE)).completedTaskIds).toEqual([]);
  });
});

describe('autoCompleteDeliveredTasks — base branch and authorship (issues #3983, #3678)', () => {
  async function sweepPastBudget(taskStore: TaskStore, resolveMergedPr: AutoCompleteDeliveredDeps['resolveMergedPr']): Promise<string[]> {
    const tracker = createDeliveredCompletionTracker();
    const start = new Date();
    await autoCompleteDeliveredTasks(baseDeps(taskStore, resolveMergedPr, { tracker, now: () => start }));
    const later = plus(start, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS * 2);
    const r = await autoCompleteDeliveredTasks(baseDeps(taskStore, resolveMergedPr, { tracker, now: () => later }));
    return r.completedTaskIds;
  }

  const BRANCHES = { defaultBranch: 'main', integrationBranch: 'staging' };

  test.each([
    ['the default branch', 'main'],
    ['the integration branch', 'staging'],
  ])('a PR merged into %s completes the task', async (_label, baseBranch) => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const { resolveMergedPr } = storeResolverWithMergedPr({ task: taskStore.getTask(id)!, prNumber: 10, baseBranch, branches: BRANCHES });
    expect(await sweepPastBudget(taskStore, resolveMergedPr)).toEqual([id]);
  });

  test('a PR merged into a feature branch does not complete the task', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const { resolveMergedPr } = storeResolverWithMergedPr({ task: taskStore.getTask(id)!, prNumber: 10, baseBranch: 'feat/parent', branches: BRANCHES });
    expect(await sweepPastBudget(taskStore, resolveMergedPr)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('an unknown default branch leaves the base branch unchecked (fail open)', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const { resolveMergedPr } = storeResolverWithMergedPr({
      task: taskStore.getTask(id)!, prNumber: 10, baseBranch: 'feat/parent',
      branches: { defaultBranch: null, integrationBranch: 'staging' },
    });
    expect(await sweepPastBudget(taskStore, resolveMergedPr)).toEqual([id]);
  });

  test('a PR another task pushed does not complete a task that only mentioned it', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const { resolveMergedPr } = storeResolverWithMergedPr({ task: taskStore.getTask(id)!, prNumber: 10, pushedBy: ['author-task'] });
    expect(await sweepPastBudget(taskStore, resolveMergedPr)).toEqual([]);
    expect(taskStore.getTask(id)?.status).toBe('inProgress');
  });

  test('a PR this task pushed completes it, even when another task pushed the same branch', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    const { resolveMergedPr } = storeResolverWithMergedPr({ task: taskStore.getTask(id)!, prNumber: 10, pushedBy: ['author-task', id] });
    expect(await sweepPastBudget(taskStore, resolveMergedPr)).toEqual([id]);
  });
});

describe('autoCompleteDeliveredTasks — chain-break marker (issue #3678)', () => {
  const CHAIN_PROMPT = 'Implement the next issue.\n- self-continuation: true\n';

  async function completeOverBudget(taskStore: TaskStore, id: string): Promise<{ audit: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-chain-break-'));
    tmpDirs.push(dir);
    const auditLogPath = join(dir, 'audit.jsonl');
    const tracker = createDeliveredCompletionTracker();
    const deps = (now: Date) => ({
      ...baseDeps(taskStore, () => MERGED, { tracker, now: () => now }),
      lifecycleDeps: { ...lifecycleDeps(taskStore), auditLogPath },
    });
    await autoCompleteDeliveredTasks(deps(T0));
    const r = await autoCompleteDeliveredTasks(deps(plus(T0, DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS * 2)));
    expect(r.completedTaskIds).toEqual([id]);
    return { audit: existsSync(auditLogPath) ? await readFile(auditLogPath, 'utf8') : '' };
  }

  test('a chain task completed with no child and no stop reason is marked, in the digest and the audit log', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore, CHAIN_PROMPT);
    const { audit } = await completeOverBudget(taskStore, id);

    const task = taskStore.getTask(id)!;
    expect(task.chainEndedWithoutHandoff).toBe(true);
    // The sweep's own digest (written after completion) keeps the bullet first.
    expect(task.completionDigest?.bullets[0]).toBe(CHAIN_ENDED_WITHOUT_HANDOFF_BULLET);
    expect(task.completionDigest?.bullets[1]).toContain('Auto-completed on delivery');
    const rows = audit.trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toContainEqual(expect.objectContaining({
      type: 'task.chainEndedWithoutHandoff',
      taskId: id,
      actor: DELIVERED_AUTO_COMPLETE_ACTOR,
    }));
  });

  test('a chain task that spawned a successor is not marked', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore, CHAIN_PROMPT);
    taskStore.createTask({ prompt: 'next unit', cwd: '/tmp', parentTaskId: id });
    const { audit } = await completeOverBudget(taskStore, id);
    expect(taskStore.getTask(id)?.chainEndedWithoutHandoff).toBeUndefined();
    expect(audit).not.toContain('chainEndedWithoutHandoff');
  });

  test('a task that is not a chain link is not marked', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore);
    await completeOverBudget(taskStore, id);
    expect(taskStore.getTask(id)?.chainEndedWithoutHandoff).toBeUndefined();
  });

  test('a chain task that recorded its own stop reason is not marked', async () => {
    const taskStore = new TaskStore();
    const id = makeRunningTask(taskStore, CHAIN_PROMPT);
    // "chain end: <reason>" raised and then cleared by the next tool event; the
    // record survives as finishedSignalAt. No mergedAt on MERGED, so the budget
    // path still applies.
    taskStore.setPendingSignal(id, { kind: 'completion_ready', raisedAt: T0.toISOString(), note: 'chain end: no eligible issue' });
    taskStore.clearPendingSignal(id);
    await completeOverBudget(taskStore, id);
    expect(taskStore.getTask(id)?.chainEndedWithoutHandoff).toBeUndefined();
  });
});
