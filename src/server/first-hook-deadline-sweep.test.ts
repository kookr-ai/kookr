import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { DEFAULT_FIRST_HOOK_DEADLINE_MS } from '../core/first-hook-deadline.js';
import {
  FirstHookMissMetrics,
  maybeReapFirstHookMiss,
  reapFirstHookMiss,
  buildFirstHookMissDisposition,
} from './first-hook-deadline-sweep.js';

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

const REG = Date.parse('2026-08-04T12:00:00.000Z');
const PAST_DEADLINE = new Date(REG + DEFAULT_FIRST_HOOK_DEADLINE_MS + 1_000);

describe('first-hook miss reaper (issue #2036)', () => {
  test('reaps a synthetic session with no hooks after the deadline + increments counter', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const agentId = task.sessions[0]!.tmuxSession;
    const metrics = new FirstHookMissMetrics();
    const reportsDir = await mkdtemp(join(tmpdir(), 'first-hook-miss-'));
    const auditLogPath = join(reportsDir, 'audit.jsonl');
    const broadcastToAll = vi.fn();

    const reaped = await maybeReapFirstHookMiss(
      agentId,
      'frozen pane\nno activity',
      {
        taskStore,
        lifecycleDeps: lifecycleDeps(taskStore),
        metrics,
        reportsDir,
        auditLogPath,
        broadcastToAll,
        now: () => PAST_DEADLINE,
      },
      { registeredAt: REG, firstHookAt: 0, mcpStartupAt: 0 },
    );

    expect(reaped).toBe(true);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(taskStore.getTask(task.id)?.disposition).toMatchObject({
      reason: 'first_hook_miss',
      source: 'first-hook-miss',
      outcome: 'terminated',
    });
    expect(metrics.getSnapshot()).toEqual({ firstHookMissTotal: 1 });
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'alert', severity: 'warning' }),
    );

    const reports = (await readdir(reportsDir)).filter((f) => f.startsWith('first-hook-miss-'));
    expect(reports.length).toBe(1);
    const body = await readFile(join(reportsDir, reports[0]!), 'utf-8');
    expect(body).toContain(task.id);
    expect(body).toContain('First-hook miss report');

    const audit = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({
      type: 'task.firstHookMiss',
      actor: 'system:first-hook-miss',
      taskId: task.id,
    });
  });

  test('leaves sessions with SessionStart / firstHookAt set untouched', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const agentId = task.sessions[0]!.tmuxSession;
    const metrics = new FirstHookMissMetrics();

    const reaped = await maybeReapFirstHookMiss(
      agentId,
      'working',
      {
        taskStore,
        lifecycleDeps: lifecycleDeps(taskStore),
        metrics,
        now: () => PAST_DEADLINE,
      },
      { registeredAt: REG, firstHookAt: REG + 5_000, mcpStartupAt: 0 },
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(metrics.getSnapshot()).toEqual({ firstHookMissTotal: 0 });
  });

  test('respects MCP startup grace when mcp_startup_starting was observed', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const agentId = task.sessions[0]!.tmuxSession;
    const metrics = new FirstHookMissMetrics();
    const mcpAt = REG + 10_000;
    // Past registration deadline, still inside 120s MCP grace.
    const now = new Date(mcpAt + 60_000);

    const reaped = await maybeReapFirstHookMiss(
      agentId,
      'mcp starting',
      {
        taskStore,
        lifecycleDeps: lifecycleDeps(taskStore),
        metrics,
        getFirstHookDeadlineMs: () => 30_000,
        getMcpStartupGracePeriodMs: () => 120_000,
        now: () => now,
      },
      { registeredAt: REG, firstHookAt: 0, mcpStartupAt: mcpAt },
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(metrics.getSnapshot()).toEqual({ firstHookMissTotal: 0 });
  });

  test('does not reap under the deadline', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const agentId = task.sessions[0]!.tmuxSession;

    const reaped = await maybeReapFirstHookMiss(
      agentId,
      '',
      {
        taskStore,
        lifecycleDeps: lifecycleDeps(taskStore),
        now: () => new Date(REG + 10_000),
      },
      { registeredAt: REG, firstHookAt: 0, mcpStartupAt: 0 },
    );

    expect(reaped).toBe(false);
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
  });

  test('reapFirstHookMiss writes disposition and increments metrics', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const metrics = new FirstHookMissMetrics();

    await reapFirstHookMiss(
      task,
      {
        waitedMs: DEFAULT_FIRST_HOOK_DEADLINE_MS + 1_000,
        deadlineMs: DEFAULT_FIRST_HOOK_DEADLINE_MS,
        registeredAt: REG,
        firstHookAt: 0,
        mcpStartupAt: 0,
        paneContent: 'stuck',
      },
      {
        taskStore,
        lifecycleDeps: lifecycleDeps(taskStore),
        metrics,
        now: () => PAST_DEADLINE,
      },
    );

    expect(metrics.getSnapshot().firstHookMissTotal).toBe(1);
    expect(buildFirstHookMissDisposition(PAST_DEADLINE.toISOString()).reason).toBe('first_hook_miss');
  });
});
