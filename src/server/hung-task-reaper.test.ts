import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { selectDeliveredMergedPr } from '../core/delivered-task-completion.js';
import type { Task } from '../core/tasks.js';
import type { GitHubPRState, GitHubReference } from '../core/github-types.js';
import type { MergedPrAttribution } from '../core/delivered-task-completion.js';
import { reapHungTask, type HungTaskReapEvidence } from './hung-task-reaper.js';

/**
 * Record a merged PR on a `GitHubStateStore` for `taskId`, detected from the
 * agent's own activity (`detectedFrom` ≠ 'prompt'), and return a resolver wired
 * exactly like production (`index.ts`): `getTaskState(id).prs` →
 * `selectDeliveredMergedPr`. This replays the real #1560 delivery attribution
 * the reaper reuses — no canned `MergedPrAttribution`.
 */
function mergedPrResolver(taskId: string, prNumber: number, prUrl: string): (task: Task) => MergedPrAttribution | null {
  const store = new GitHubStateStore();
  const ref: GitHubReference = {
    type: 'pr',
    owner: 'kookr-ai',
    repo: 'kookr',
    number: prNumber,
    url: prUrl,
    detectedAt: new Date('2026-07-25T18:09:14.000Z'),
    detectedFrom: `kookr-${taskId}`, // agent activity, not 'prompt'
    taskId,
  };
  store.addReference(ref);
  const prState: GitHubPRState = {
    ref,
    title: 'feat: durable agent-side signal outbox',
    status: 'merged',
    mergeable: 'MERGEABLE',
    author: 'kookr-bot',
    branch: `feat/task-${taskId}`,
    baseBranch: 'main',
    reviewDecision: 'approved',
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-07-25T18:10:00.000Z'),
  };
  store.updatePRState(prState);
  return (task: Task) =>
    selectDeliveredMergedPr(
      store.getTaskState(task.id).prs.map((pr) => ({
        status: pr.status,
        number: pr.ref.number,
        url: pr.ref.url,
        owner: pr.ref.owner,
        repo: pr.ref.repo,
        detectedFrom: pr.ref.detectedFrom,
      })),
    );
}

function makeTask(taskStore: TaskStore) {
  const task = taskStore.createTask({ prompt: 'Do something', cwd: '/tmp' });
  taskStore.addSession(task.id, {
    tmuxSession: `kookr-${task.id}`,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: new Date('2026-06-19T00:00:00.000Z'),
  });
  return taskStore.getTask(task.id)!;
}

function lifecycleDeps(taskStore: TaskStore) {
  return {
    adapter: { stop: vi.fn(async () => undefined) },
    monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
    taskStore,
    queue: new AttentionQueue(),
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
  };
}

function evidence(overrides: Partial<HungTaskReapEvidence> = {}): HungTaskReapEvidence {
  return {
    silentForMs: 3 * 60 * 60 * 1000,
    thresholdMs: 3 * 60 * 60 * 1000,
    lastHookEventAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastPaneChangeAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastTokenActivityAt: Date.parse('2026-06-20T21:00:00.000Z'),
    paneContent: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'),
    ...overrides,
  };
}

async function readAuditRows(auditLogPath: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(auditLogPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

describe('reapHungTask', () => {
  test('terminates the task, kills the session, and frees the slot', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const adapterStop = vi.fn(async () => undefined);

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: { ...lifecycleDeps(taskStore), adapter: { stop: adapterStop } },
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(adapterStop).toHaveBeenCalledWith(task.sessions[0].tmuxSession);
    // 'terminated' is not counted by getActiveCount — slot is freed.
    expect(taskStore.getActiveCount()).toBe(0);
  });

  test('purges the attention-queue entry for the session', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const queue = new AttentionQueue();
    const purgeSpy = vi.spyOn(queue, 'purgeTask');
    const deps = { ...lifecycleDeps(taskStore), queue };

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: deps,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(purgeSpy).toHaveBeenCalledWith(task.id);
  });

  test('writes a markdown report with task id, timeline, and a bounded pane tail', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const reportsDir = await mkdtemp(join(tmpdir(), 'kookr-reports-'));

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(result.reportPath).toBeDefined();
    const files = await readdir(reportsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(task.id);

    const content = await readFile(result.reportPath!, 'utf-8');
    expect(content).toContain(task.id);
    expect(content).toContain('Liveness timeline');
    // Pane tail is capped at 50 lines out of the 80 fed in.
    expect(content).not.toContain('line 29');
    expect(content).toContain('line 30');
    expect(content).toContain('line 79');
  });

  test('writes an audit row with actor system:hung-task-reaper', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    const rows = await readAuditRows(auditLogPath);
    const expectedEvidence = evidence();
    expect(rows).toEqual([{
      type: 'task.hungTaskReap',
      timestamp: expect.any(String),
      actor: 'system:hung-task-reaper',
      taskId: task.id,
      silentForMs: expectedEvidence.silentForMs,
      thresholdMs: expectedEvidence.thresholdMs,
      // No resolveMergedPr wired → plain terminated, no deliveredPr key.
      outcome: 'terminated',
      evidence: {
        lastHookEventAt: expectedEvidence.lastHookEventAt,
        lastPaneChangeAt: expectedEvidence.lastPaneChangeAt,
        lastTokenActivityAt: expectedEvidence.lastTokenActivityAt,
      },
      // No reportsDir passed to this test — no reportPath key at all.
    }]);
  });

  test('broadcasts a warning alert', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const broadcastToAll = vi.fn();

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      broadcastToAll,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', severity: 'warning' }));
  });

  test('terminating still succeeds when reportsDir/auditLogPath are absent', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(result.reportPath).toBeUndefined();
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
  });
});

describe('reapHungTask — delivered_then_hung outcome (issue #1559)', () => {
  // Replays the prod incident (umbrella #1545): tasks faf7902b / 3a7039c5
  // created ~17:43Z, merged PR #1542/#1543 at ~18:09Z, then hung in post-merge
  // cleanup and were reaped ~3h later at ~21:13Z. The reap must NOT mask the
  // delivery as a plain `terminated`.
  const REAP_NOW = new Date('2026-07-25T21:13:18.000Z');
  const SILENT_MS = 10_800_000; // ≈ the incident's silentForMs

  function incidentEvidence(): HungTaskReapEvidence {
    const lastActivity = Date.parse('2026-07-25T18:13:18.000Z');
    return evidence({
      silentForMs: SILENT_MS,
      lastHookEventAt: lastActivity,
      lastPaneChangeAt: lastActivity,
      lastTokenActivityAt: lastActivity,
    });
  }

  test('records delivered_then_hung (not terminated) when the reaped task delivered a merged PR', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);

    const result = await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      resolveMergedPr: mergedPrResolver(task.id, 1542, 'https://github.com/kookr-ai/kookr/pull/1542'),
      now: () => REAP_NOW,
    });

    expect(result.outcome).toBe('delivered_then_hung');
    // The task is still terminated at the lifecycle level — the outcome lives
    // on the disposition, distinct from the status.
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
  });

  test('writes a #1588/#1540-schema disposition entry naming the delivered PR', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);

    await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      resolveMergedPr: mergedPrResolver(task.id, 1542, 'https://github.com/kookr-ai/kookr/pull/1542'),
      now: () => REAP_NOW,
    });

    const disposition = taskStore.getTask(task.id)?.disposition;
    expect(disposition).toEqual({
      reason: 'hung_reap',
      at: REAP_NOW.toISOString(),
      source: 'hung-task-reaper',
      outcome: 'delivered_then_hung',
      detail: 'Delivered PR #1542 before hanging; reaped after prolonged silence.',
      deliveredPr: { number: 1542, url: 'https://github.com/kookr-ai/kookr/pull/1542' },
    });
  });

  test('audit row and alert carry the delivered_then_hung outcome', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');
    const broadcastToAll = vi.fn();

    await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      broadcastToAll,
      resolveMergedPr: mergedPrResolver(task.id, 1542, 'https://github.com/kookr-ai/kookr/pull/1542'),
      now: () => REAP_NOW,
    });

    const rows = await readAuditRows(auditLogPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.hungTaskReap',
      outcome: 'delivered_then_hung',
      deliveredPr: { number: 1542, url: 'https://github.com/kookr-ai/kookr/pull/1542' },
    });
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'alert',
        summary: expect.stringContaining('PR #1542'),
      }),
    );
  });

  test('no false positive: a reaped task with no attributable merged PR stays terminated', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');

    const result = await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      // Resolver returns null for this task — no merged PR attributable.
      resolveMergedPr: () => null,
      now: () => REAP_NOW,
    });

    expect(result.outcome).toBe('terminated');
    const disposition = taskStore.getTask(task.id)?.disposition;
    expect(disposition).toEqual({
      reason: 'hung_reap',
      at: REAP_NOW.toISOString(),
      source: 'hung-task-reaper',
      outcome: 'terminated',
    });
    expect(disposition?.deliveredPr).toBeUndefined();

    const rows = await readAuditRows(auditLogPath);
    expect(rows[0]).toMatchObject({ outcome: 'terminated' });
    expect(rows[0].deliveredPr).toBeUndefined();
  });

  test('a prompt-referenced merged PR is NOT counted as delivery (excluded attribution)', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);

    // Wire a resolver whose only merged PR was detected from the prompt — the
    // #1560 selector excludes it, so the reaper must record plain terminated.
    const store = new GitHubStateStore();
    const ref: GitHubReference = {
      type: 'pr', owner: 'kookr-ai', repo: 'kookr', number: 1500,
      url: 'https://github.com/kookr-ai/kookr/pull/1500',
      detectedAt: new Date('2026-07-25T17:43:00.000Z'),
      detectedFrom: 'prompt', taskId: task.id,
    };
    store.addReference(ref);
    store.updatePRState({
      ref, title: 'port the fix', status: 'merged', mergeable: 'MERGEABLE',
      author: 'someone', branch: 'x', baseBranch: 'main', reviewDecision: 'approved',
      reviewers: [], unresolvedThreads: [], totalComments: 0, checks: [],
      lastFetchedAt: new Date('2026-07-25T18:10:00.000Z'),
    });

    const result = await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      resolveMergedPr: (t: Task) =>
        selectDeliveredMergedPr(
          store.getTaskState(t.id).prs.map((pr) => ({
            status: pr.status, number: pr.ref.number, url: pr.ref.url,
            owner: pr.ref.owner, repo: pr.ref.repo, detectedFrom: pr.ref.detectedFrom,
          })),
        ),
    });

    expect(result.outcome).toBe('terminated');
  });

  // Invariant / contention: the disposition ledger is first-write-wins. A task
  // that already carries a disposition (e.g. a pre-session prune from #1588) is
  // never silently overwritten by a later reap — the durable record is stable.
  test('first-write-wins: reap does not overwrite a disposition already on the task', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const preExisting = {
      reason: 'launch_timeout' as const,
      at: '2026-07-25T17:43:00.000Z',
      source: 'launch-service',
    };
    taskStore.setDisposition(task.id, preExisting);

    await reapHungTask(task, incidentEvidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      resolveMergedPr: mergedPrResolver(task.id, 1542, 'https://github.com/kookr-ai/kookr/pull/1542'),
      now: () => REAP_NOW,
    });

    // The original disposition survives; the reaper's write is dropped.
    expect(taskStore.getTask(task.id)?.disposition).toEqual(preExisting);
  });
});
