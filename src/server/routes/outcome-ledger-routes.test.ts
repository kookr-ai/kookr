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
