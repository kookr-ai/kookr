/**
 * Integration of the warned phase before the hungSuspect TTL reclaim with
 * `POST /api/tasks/:id/keep-alive` (issue #4241):
 *
 *   warning → line typed into the parent → keep-alive → no reclaim;
 *   warning → no keep-alive → reclaim at the deadline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import { ReapWarningCoordinator, MAX_REAP_VETOES } from '../core/reap-warning-coordinator.js';
import { formatClockTime, formatReclaimWarningLine } from '../core/long-running-jobs.js';
import type { HungTaskLivenessEvidence } from '../core/hung-task-reaper.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import {
  hasFailedHungSuspectTtlReap,
  reclaimAgedHungSuspectTasks,
  HungSuspectTtlReclaimMetrics,
  type ReclaimHungSuspectTasksDeps,
} from './hung-suspect-ttl-sweep.js';
import { registerKeepAliveRoutes } from './routes/keep-alive-routes.js';

vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const START = new Date('2026-08-03T12:00:00.000Z').getTime();
const TTL_MS = 25 * 60_000;
const GRACE_MS = 5 * 60_000;
const WORKER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

function makeStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    viewTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    terminateTask: vi.fn((id: string) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = 'terminated';
    }),
    updateSession: vi.fn(),
    updateSessionWorktreeHealth: vi.fn(),
    setCriteriaVerdict: vi.fn(),
    setDisposition: vi.fn(),
    clearPendingSignal: vi.fn(),
  } as any;
}

function lifecycleDeps(taskStore: any, stop: () => Promise<void> = async () => undefined): LifecycleDeps {
  return {
    adapter: { stop: vi.fn(stop) },
    monitor: { unregisterAgent: vi.fn() },
    taskStore,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
    queue: { purgeTask: vi.fn() },
    issueClaimRegistry: { safeReleaseAllFor: vi.fn().mockReturnValue([]) },
    onTaskOutcome: vi.fn(),
  };
}

/** Silent since START - 26 min (just past the TTL when the clock reads START). */
const SILENT_SINCE = START - TTL_MS - 60_000;
const liveness = (): HungTaskLivenessEvidence => ({
  lastHookEventAt: SILENT_SINCE,
  lastPaneChangeAt: SILENT_SINCE,
  lastTokenActivityAt: SILENT_SINCE,
});

describe('hungSuspect TTL reclaim: warn the parent, let it keep the worker alive (issue #4241)', () => {
  let dir: string;
  let auditLogPath: string;
  let lead: Task;
  let worker: Task;
  let unrelated: Task;
  let taskStore: any;
  let coordinator: ReapWarningCoordinator;
  let sendLineToSession: ReturnType<typeof vi.fn>;
  let app: Hono;
  let clock: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ttl-keep-alive-'));
    auditLogPath = join(dir, 'audit.jsonl');
    lead = aTask({ id: 'lead-1', name: 'the lead', status: 'inProgress', sessions: [aSession({ tmuxSession: 'kookr-lead', lastStatus: 'inProgress' })] });
    worker = aTask({ id: WORKER_ID, name: 'eval worker', parentTaskId: 'lead-1', status: 'inProgress', sessions: [aSession({ tmuxSession: 'kookr-worker', lastStatus: 'inProgress' })] });
    unrelated = aTask({ id: 'other-1', status: 'inProgress', sessions: [aSession({ tmuxSession: 'kookr-other', lastStatus: 'inProgress' })] });
    taskStore = makeStore([lead, worker, unrelated]);
    coordinator = new ReapWarningCoordinator();
    sendLineToSession = vi.fn().mockResolvedValue(undefined);
    clock = START;
    app = new Hono();
    registerKeepAliveRoutes(app, {
      taskStore,
      auditLogPath,
      hungSuspectTtlReapWarningCoordinator: coordinator,
      now: () => clock,
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sweep = (at: number, over: Partial<ReclaimHungSuspectTasksDeps> = {}) => {
    const deps: ReclaimHungSuspectTasksDeps = {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      isHungSuspect: (task) => task.id === WORKER_ID,
      getLiveness: liveness,
      isHoldingOpenPr: () => false,
      snapshotSessionJobs: async () => new Map([[WORKER_ID, [{ pid: 77, command: 'python eval.py', ageMs: 40 * 60_000, holdsGpu: false }]]]),
      // The job is old enough to hold off the reclaim (#4237) — use a cap
      // already passed so the hold does not apply and the warned phase runs.
      sendLineToSession,
      reapWarningCoordinator: coordinator,
      getGraceMs: () => GRACE_MS,
      ...over,
    };
    return reclaimAgedHungSuspectTasks(deps, { now: new Date(at), ttlMs: TTL_MS, longRunningJobCapMs: 1 });
  };

  const keepAlive = (body: Record<string, unknown>, ref = WORKER_ID.slice(0, 8)) =>
    app.request(`/api/tasks/${ref}/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const auditTypes = async () =>
    (await readFile(auditLogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

  it('warns, types one line into the parent, and closes nothing yet', async () => {
    const result = await sweep(START);
    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.warnedTaskIds).toEqual([WORKER_ID]);
    expect(sendLineToSession).toHaveBeenCalledTimes(1);
    const [session, line] = sendLineToSession.mock.calls[0];
    expect(session).toBe('kookr-lead');
    expect(line).toBe(
      `[kookr] worker eval worker (a1b2c3d4) has been silent 26 min and will be closed at ${formatClockTime(START + GRACE_MS)}. ` +
        'If it is waiting on purpose: kookr keep-alive a1b2c3d4 --for 30m --reason "<why>". It started: python eval.py (pid 77, 40m).',
    );
    // A second pass inside the grace neither re-warns nor re-notifies.
    await sweep(START + 60_000);
    expect(sendLineToSession).toHaveBeenCalledTimes(1);
    const rows = await auditTypes();
    expect(rows.map((r) => r.type)).toEqual(['task.hungSuspectTtlReapWarned']);
    expect(rows[0]).toMatchObject({ parentTaskId: 'lead-1', parentNotified: true });
  });

  it('warning → parent line → keep-alive → no reclaim at the old deadline', async () => {
    await sweep(START);
    clock = START + 60_000;
    const res = await keepAlive({ forMs: 30 * 60_000, reason: 'waiting on the eval', callerTaskId: 'lead-1' });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      taskId: WORKER_ID,
      reaper: 'hung_suspect_ttl',
      keptAliveBy: 'the lead',
      deadlineAt: new Date(clock + 30 * 60_000).toISOString(),
      keptAliveCount: 1,
      remainingKeepAlives: MAX_REAP_VETOES - 1,
    });

    const atOldDeadline = await sweep(START + GRACE_MS + 1_000);
    expect(atOldDeadline.reclaimedTaskIds).toEqual([]);
    expect(worker.status).toBe('inProgress');

    // Past the kept-alive deadline the reclaim proceeds and records the keep-alive.
    const later = await sweep(clock + 30 * 60_000);
    expect(later.reclaimedTaskIds).toEqual([WORKER_ID]);
    const disposition = taskStore.setDisposition.mock.calls[0][1];
    expect(disposition.detail).toContain('Kept alive by the lead until');
    expect(disposition.detail).toContain('waiting on the eval');
    const reclaimed = (await auditTypes()).find((r) => r.type === 'task.hungSuspectTtlReclaimed');
    expect(reclaimed).toMatchObject({ keptAliveCount: 1, keptAliveBy: { actor: 'task:lead-1', reason: 'waiting on the eval' } });
    expect((await auditTypes()).some((r) => r.type === 'task.hungSuspectTtlReapKeptAlive' && r.actor === 'task:lead-1')).toBe(true);
  });

  it('writes the keep-alive into the disposition-ledger entry', async () => {
    const dispositionLedgerPath = join(dir, 'disposition.jsonl');
    await sweep(START, { dispositionLedgerPath });
    clock = START + 60_000;
    expect((await keepAlive({ forMs: 10 * 60_000, reason: 'waiting on review', callerTaskId: 'lead-1' })).status).toBe(200);
    await sweep(clock + 10 * 60_000, { dispositionLedgerPath });
    const entry = JSON.parse((await readFile(dispositionLedgerPath, 'utf8')).trim().split('\n').at(-1)!);
    expect(entry).toMatchObject({ taskId: WORKER_ID, disposition: 'needs-human' });
    expect(entry.detail).toContain('Kept alive by the lead until');
    expect(entry.detail).toContain('waiting on review');
  });

  it('after a failed close, the re-warn types no parent line and writes no warned row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = lifecycleDeps(taskStore, async () => { throw new Error('tmux gone'); });
      await sweep(START, { lifecycleDeps: failing });
      const failed = await sweep(START + GRACE_MS, { lifecycleDeps: failing });
      expect(failed.reclaimedTaskIds).toEqual([]);
      expect(sendLineToSession).toHaveBeenCalledTimes(1);
      // The hung:residual count reads this to keep counting the task (#4291).
      expect(hasFailedHungSuspectTtlReap(coordinator, WORKER_ID)).toBe(true);

      const rewarn = await sweep(START + GRACE_MS + 60_000, { lifecycleDeps: failing });
      expect(rewarn.warnedTaskIds).toEqual([]);
      expect(sendLineToSession).toHaveBeenCalledTimes(1);
      expect((await auditTypes()).filter((r) => r.type === 'task.hungSuspectTtlReapWarned')).toHaveLength(1);
      // The countdown still runs, so the close is retried after the grace.
      expect(coordinator.getWarning(WORKER_ID)).toBeDefined();
      const retried = await sweep(START + 2 * GRACE_MS + 60_000);
      expect(retried.reclaimedTaskIds).toEqual([WORKER_ID]);
      expect(hasFailedHungSuspectTtlReap(coordinator, WORKER_ID)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('tells no parent that is not running, but still warns', async () => {
    lead.status = 'completed';
    const result = await sweep(START);
    expect(result.warnedTaskIds).toEqual([WORKER_ID]);
    expect(sendLineToSession).not.toHaveBeenCalled();
    expect((await auditTypes())[0]).toMatchObject({ parentTaskId: 'lead-1', parentNotified: false });
  });

  it('counts only real close attempts, not warned or waiting tasks', async () => {
    const metrics = new HungSuspectTtlReclaimMetrics();
    await sweep(START, { metrics });
    await sweep(START + 60_000, { metrics });
    expect(metrics.getSnapshot().reclaimAttempted).toBe(0);
    await sweep(START + GRACE_MS, { metrics });
    expect(metrics.getSnapshot().reclaimAttempted).toBe(1);
  });

  it('a keep-alive shorter than the time already left changes nothing and says so', async () => {
    await sweep(START);
    expect((await keepAlive({ forMs: 60 * 60_000, reason: 'long eval', callerTaskId: 'lead-1' })).status).toBe(200);
    clock = START + 10 * 60_000;
    const res = await keepAlive({ forMs: 30 * 60_000, reason: 'still waiting', callerTaskId: 'lead-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      unchanged: true,
      deadlineAt: new Date(START + 60 * 60_000).toISOString(),
      keptAliveCount: 1,
    });
    expect(coordinator.getWarning(WORKER_ID)?.keptAliveBy?.reason).toBe('long eval');
  });

  it('answers 409 for a finished task and for an ambiguous prefix', async () => {
    await sweep(START);
    worker.status = 'completed';
    expect(await (await keepAlive({ forMs: 60_000, reason: 'x', callerTaskId: 'lead-1' })).json())
      .toMatchObject({ code: 'task_not_active' });
    tasksForAmbiguity();
    const res = await keepAlive({ forMs: 60_000, reason: 'x' }, 'a1b2c3d4');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ambiguous' });
  });

  function tasksForAmbiguity(): void {
    const twin = aTask({ id: 'a1b2c3d4-ffff-4000-8000-000000000002', status: 'inProgress' });
    taskStore.viewTasks.mockReturnValue([lead, worker, unrelated, twin]);
  }

  it('pushes a snapshot after an accepted keep-alive', async () => {
    const broadcastSnapshot = vi.fn();
    const withBroadcast = new Hono();
    registerKeepAliveRoutes(withBroadcast, {
      taskStore, hungSuspectTtlReapWarningCoordinator: coordinator, broadcastSnapshot, now: () => START,
    });
    await sweep(START);
    const res = await withBroadcast.request(`/api/tasks/${WORKER_ID}/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forMs: 30 * 60_000, reason: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(broadcastSnapshot).toHaveBeenCalledTimes(1);
  });

  it('warning → no keep-alive → reclaim once the grace passes', async () => {
    await sweep(START);
    const atDeadline = await sweep(START + GRACE_MS);
    expect(atDeadline.reclaimedTaskIds).toEqual([WORKER_ID]);
    expect(worker.status).toBe('terminated');
  });

  it('refuses an unrelated task (403) and the task itself (403)', async () => {
    await sweep(START);
    const fromOther = await keepAlive({ forMs: 60_000, reason: 'x', callerTaskId: 'other-1' });
    expect(fromOther.status).toBe(403);
    expect(await fromOther.json()).toMatchObject({ code: 'not_parent' });
    const fromSelf = await keepAlive({ forMs: 60_000, reason: 'x', callerTaskId: WORKER_ID });
    expect(fromSelf.status).toBe(403);
    expect(await fromSelf.json()).toMatchObject({ code: 'self_keep_alive' });
    expect(coordinator.getWarning(WORKER_ID)?.keptAliveCount).toBe(0);
  });

  it('accepts the operator, and refuses past the per-cycle cap with a clear message', async () => {
    await sweep(START);
    for (let i = 0; i < MAX_REAP_VETOES; i++) {
      clock = START + (i + 1) * 1_000;
      expect((await keepAlive({ forMs: 10 * 60_000 + i, reason: 'operator says wait' })).status).toBe(200);
    }
    const capped = await keepAlive({ forMs: 60_000, reason: 'again', callerTaskId: 'lead-1' });
    expect(capped.status).toBe(409);
    const body = await capped.json() as { code: string; error: string };
    expect(body.code).toBe('cap_reached');
    expect(body.error).toContain(`already been kept alive ${MAX_REAP_VETOES} times`);
  });

  it('refuses past the 12-hour silence cap', async () => {
    const capped = new Hono();
    registerKeepAliveRoutes(capped, {
      taskStore,
      hungSuspectTtlReapWarningCoordinator: coordinator,
      // Silence began 26 min before START; a 26-min cap is already spent.
      getLongRunningJobReclaimCapMs: () => TTL_MS + 60_000,
      now: () => START,
    });
    await sweep(START);
    const res = await capped.request(`/api/tasks/${WORKER_ID}/keep-alive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forMs: 30 * 60_000, reason: 'x', callerTaskId: 'lead-1' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ceiling_reached' });
  });

  it('answers 409 when nothing is pending and 404 for an unknown task', async () => {
    expect((await keepAlive({ forMs: 60_000, reason: 'x', callerTaskId: 'lead-1' })).status).toBe(409);
    expect((await keepAlive({ forMs: 60_000, reason: 'x' }, 'zzzzzzzz')).status).toBe(404);
  });

  it('drops the warning when the task speaks again', async () => {
    await sweep(START);
    expect(coordinator.getWarning(WORKER_ID)).toBeDefined();
    const deps: ReclaimHungSuspectTasksDeps = {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      isHungSuspect: () => false,
      getLiveness: liveness,
      isHoldingOpenPr: () => false,
      reapWarningCoordinator: coordinator,
      getGraceMs: () => GRACE_MS,
    };
    const result = await reclaimAgedHungSuspectTasks(deps, { now: new Date(START + 60_000), ttlMs: TTL_MS });
    expect(result.clearedWarningTaskIds).toEqual([WORKER_ID]);
    expect(coordinator.getWarning(WORKER_ID)).toBeUndefined();
    expect((await auditTypes()).at(-1)).toMatchObject({ type: 'task.hungSuspectTtlReapWarningCleared', reason: 'recovered' });
  });

  it('a grace of 0 keeps the old immediate reclaim', async () => {
    const deps: ReclaimHungSuspectTasksDeps = {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      isHungSuspect: (task) => task.id === WORKER_ID,
      getLiveness: liveness,
      isHoldingOpenPr: () => false,
      sendLineToSession,
      reapWarningCoordinator: coordinator,
      getGraceMs: () => 0,
    };
    const result = await reclaimAgedHungSuspectTasks(deps, { now: new Date(START), ttlMs: TTL_MS });
    expect(result.reclaimedTaskIds).toEqual([WORKER_ID]);
    expect(sendLineToSession).not.toHaveBeenCalled();
  });
});

describe('formatReclaimWarningLine', () => {
  it('says when no long-running process is running, and keeps the command when truncated', () => {
    const line = formatReclaimWarningLine({ workerName: 'w', taskId: 'abcdef1234', silentForMs: 30 * 60_000, deadlineAtMs: START, jobs: [] });
    expect(line).toContain('(abcdef12) has been silent 30 min');
    expect(line).toContain('kookr keep-alive abcdef12 --for 30m');
    expect(line.endsWith('It started no long-running process.')).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => ({ pid: i, command: `job-${'x'.repeat(60)}-${i}`, ageMs: 60_000, holdsGpu: false }));
    const long = formatReclaimWarningLine({ workerName: 'w', taskId: 'abcdef1234', silentForMs: 30 * 60_000, deadlineAtMs: START, jobs: many });
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long).toContain('kookr keep-alive abcdef12');
  });
});
