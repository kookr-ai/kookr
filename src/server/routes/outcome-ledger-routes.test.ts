import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import type { TokenUsage } from '../../core/usage-types.js';
import type { OutcomeLedgerRouteDeps } from './shared.js';
import { registerOutcomeLedgerRoutes } from './outcome-ledger-routes.js';

function mkApp(deps: Partial<OutcomeLedgerRouteDeps>): Hono {
  const app = new Hono();
  registerOutcomeLedgerRoutes(app, deps as unknown as OutcomeLedgerRouteDeps);
  return app;
}

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 20,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    costUsd: overrides.costUsd ?? 0.15,
  };
}

/** Create a completed task (with a session so the lifecycle transition is valid). */
function completedTask(taskStore: TaskStore, prompt: string, projectId?: string): string {
  const task = projectId
    ? taskStore.createTask({ prompt, cwd: '/repo', projectId })
    : taskStore.createTask(prompt, '/repo');
  taskStore.addSession(task.id, {
    tmuxSession: `session-${task.id}`,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(),
  });
  taskStore.completeTask(task.id);
  return task.id;
}

describe('GET /api/outcome-ledger', () => {
  test('returns a data-quality scoreboard without token tracker wiring', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ship a feature', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'session-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });
    taskStore.completeTask(task.id);

    const res = await mkApp({ taskStore }).request('/api/outcome-ledger');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaVersion).toBe('outcome-ledger.v1');
    expect(body.summary.taskCount).toBe(1);
    expect(body.quality.missingCostTasks).toBe(1);
    expect(body.tasks[0].flags).toContain('missing_cost');
  });

  test('prefers live token tracker usage over persisted task usage', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Costed task', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'session-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });
    taskStore.updateTokenUsage(task.id, usage({ costUsd: 0.10 }));
    taskStore.completeTask(task.id);

    const tokenTracker = {
      getUsage: (taskId: string) => taskId === task.id ? usage({ costUsd: 0.42, inputTokens: 250 }) : undefined,
    };
    const res = await mkApp({ taskStore, tokenTracker: tokenTracker as never }).request('/api/outcome-ledger');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks[0].knownCostUsd).toBe(0.42);
    expect(body.tasks[0].inputTokens).toBe(250);
    expect(body.summary.totalKnownCostUsd).toBe(0.42);
  });

  test('scopes the scoreboard to a single project before aggregation', async () => {
    const taskStore = new TaskStore();
    completedTask(taskStore, 'Alpha task', 'alpha');
    completedTask(taskStore, 'Beta task', 'beta');
    completedTask(taskStore, 'Orphan task');

    const res = await mkApp({ taskStore })
      .request('/api/outcome-ledger?window=all&projectScope=assigned&projectId=alpha');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'assigned', projectId: 'alpha' });
    expect(body.summary.taskCount).toBe(1);
    expect(body.tasks[0].projectId).toBe('alpha');
  });

  test('scopes to unassigned tasks only', async () => {
    const taskStore = new TaskStore();
    completedTask(taskStore, 'Alpha task', 'alpha');
    completedTask(taskStore, 'Orphan task');

    const res = await mkApp({ taskStore })
      .request('/api/outcome-ledger?window=all&projectScope=unassigned');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'unassigned' });
    expect(body.summary.taskCount).toBe(1);
    expect(body.tasks[0].projectId).toBeNull();
  });

  test('an unknown project ID returns a valid empty scoreboard', async () => {
    const taskStore = new TaskStore();
    completedTask(taskStore, 'Alpha task', 'alpha');

    const res = await mkApp({ taskStore })
      .request('/api/outcome-ledger?window=all&projectScope=assigned&projectId=ghost');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.taskCount).toBe(0);
    expect(body.tasks).toEqual([]);
  });

  test('round-trips a project ID containing URL-significant characters', async () => {
    const literal = 'org/repo?x=1&y=2';
    const taskStore = new TaskStore();
    completedTask(taskStore, 'Encoded project task', literal);
    completedTask(taskStore, 'Plain project task', 'org/repo');

    const url = `/api/outcome-ledger?window=all&projectScope=assigned&projectId=${encodeURIComponent(literal)}`;
    const res = await mkApp({ taskStore }).request(url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'assigned', projectId: literal });
    expect(body.summary.taskCount).toBe(1);
    expect(body.tasks[0].label).toContain('Encoded project task');
  });

  test('rejects conflicting and invalid scope parameters with a 400', async () => {
    const taskStore = new TaskStore();
    const app = mkApp({ taskStore });

    // assigned without a projectId
    const missing = await app.request('/api/outcome-ledger?projectScope=assigned');
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('missing-project-id');

    // unassigned WITH a projectId (conflict)
    const conflict = await app.request('/api/outcome-ledger?projectScope=unassigned&projectId=alpha');
    expect(conflict.status).toBe(400);
    expect((await conflict.json()).error).toBe('conflicting-project-scope');

    // projectId without projectScope=assigned (ambiguous)
    const ambiguous = await app.request('/api/outcome-ledger?projectId=alpha');
    expect(ambiguous.status).toBe(400);
    expect((await ambiguous.json()).error).toBe('conflicting-project-scope');

    // unknown scope value
    const invalid = await app.request('/api/outcome-ledger?projectScope=bogus');
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe('invalid-project-scope');
  });

  test('an absent scope stays backward-compatible with the all-project view', async () => {
    const taskStore = new TaskStore();
    completedTask(taskStore, 'Alpha task', 'alpha');
    completedTask(taskStore, 'Orphan task');

    const res = await mkApp({ taskStore }).request('/api/outcome-ledger?window=all');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toEqual({ kind: 'all' });
    expect(body.summary.taskCount).toBe(2);
  });

  test('wires non-default windows and current interaction log events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'outcome-ledger-route-'));
    try {
      const interactionPath = join(dir, 'interactions.jsonl');
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Intervened task', '/repo');
      taskStore.addSession(task.id, {
        tmuxSession: 'session-1',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });
      taskStore.updateTokenUsage(task.id, usage());
      taskStore.completeTask(task.id);
      await writeFile(interactionPath, JSON.stringify({
        type: 'user_input',
        agentId: 'session-1',
        content: 'please verify',
        timestamp: new Date().toISOString(),
      }) + '\n');

      const interactionLog = { getFilePath: () => interactionPath };
      const res = await mkApp({ taskStore, interactionLog: interactionLog as never }).request('/api/outcome-ledger?window=24h');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.window.value).toBe('24h');
      expect(body.tasks[0].interventionCount).toBe(1);
      expect(body.quality.interventionCoverage).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
