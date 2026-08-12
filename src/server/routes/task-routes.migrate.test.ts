import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { gitExecEnv } from '../../core/git-helpers.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { TaskRouteDeps } from './shared.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

vi.mock('../launch-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../launch-service.js')>();
  return { ...actual, launchTask: vi.fn() };
});

import { launchTask } from '../launch-service.js';
import { registerTaskRoutes } from './task-routes.js';

// gitExecEnv() strips inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/…
// (NESTED_GIT_ENV_VARS) that a git HOOK exports — otherwise `git commit` in a
// temp dir gets redirected onto the REAL worktree during the pre-push hook's
// test run. Identity via ENV only; global/system config nulled. Cannot touch
// or leak into the real repo.
const GIT_ENV = {
  ...gitExecEnv(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function tempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kookr-migrate-'));
  const opts = { cwd: dir, env: GIT_ENV, stdio: 'ignore' as const };
  execFileSync('git', ['init', '-q'], opts);
  writeFileSync(join(dir, 'f.txt'), 'hi');
  execFileSync('git', ['add', '.'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'init'], opts);
  return dir;
}

function mkDeps(taskStore: TaskStore): TaskRouteDeps {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  return {
    taskStore,
    monitor,
    queue,
    broadcastToAll: (_m: ServerMessage) => {},
    serverCwd: '/server',
    launchServiceDeps: {
      taskStore,
      adapterRegistry: { getTypes: () => ['claude-code', 'codex-cli', 'grok-build'] },
      lifecycleDeps: {},
    } as never,
    adapter: {} as never,
  } as unknown as TaskRouteDeps;
}

function mkApp(taskStore: TaskStore): Hono {
  const app = new Hono();
  registerTaskRoutes(app, mkDeps(taskStore));
  return app;
}

/** Make the mocked launchTask create a real task in the store, like production. */
function mockLaunch(taskStore: TaskStore) {
  vi.mocked(launchTask).mockImplementation(async (_deps, opts) => {
    const task = taskStore.createTask({
      prompt: opts.prompt,
      cwd: opts.cwd,
      criteria: opts.criteria,
      agentType: opts.agentType as never,
      name: opts.name,
      migratedFromTaskId: opts.migratedFromTaskId,
    });
    return { task, queued: false } as never;
  });
}

describe('POST /api/tasks/migrate', () => {
  beforeEach(() => vi.clearAllMocks());

  test('400 on missing/invalid targetAgent', async () => {
    const app = mkApp(new TaskStore());
    const res = await app.request('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: { kind: 'ids', taskIds: ['x'] } }),
    });
    expect(res.status).toBe(400);
  });

  test('400 on bad scope', async () => {
    const app = mkApp(new TaskStore());
    const res = await app.request('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAgent: 'claude-code', scope: { kind: 'nope' } }),
    });
    expect(res.status).toBe(400);
  });

  test('migrates a terminated grok task to claude and links lineage', async () => {
    const store = new TaskStore();
    const repo = tempGitRepo();
    const source = store.createTask({ prompt: 'do X', cwd: repo, agentType: 'grok-build' });
    // Drive it to a terminated (interrupted) state — open → terminated is valid.
    store.terminateTask(source.id);
    mockLaunch(store);

    const app = mkApp(store);
    const res = await app.request('/api/tasks/migrate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetAgent: 'claude-code',
        scope: { kind: 'ids', taskIds: [source.id] },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ taskId: string; outcome: string; newTaskId?: string }>;
    };
    expect(body.results).toHaveLength(1);
    expect(body.results[0].outcome).toBe('migrated');
    const newId = body.results[0].newTaskId!;
    // lineage: source → successor, successor → source, source keeps grok
    expect(store.getTask(source.id)!.migratedToTaskId).toBe(newId);
    expect(store.getTask(source.id)!.agentType).toBe('grok-build');
    expect(store.getTask(newId)!.agentType).toBe('claude-code');
    expect(store.getTask(newId)!.migratedFromTaskId).toBe(source.id);
    // substitution hop passed to launch
    const opts = vi.mocked(launchTask).mock.calls[0][1];
    expect(opts.priorAgentSubstitutions).toEqual([
      { reason: 'task_migrate', from: 'grok-build', to: 'claude-code' },
    ]);
  });
});

describe('GET /api/tasks/migratable', () => {
  test('lists a terminated grok task as eligible for claude', async () => {
    const store = new TaskStore();
    const repo = tempGitRepo();
    const source = store.createTask({ prompt: 'do Y', cwd: repo, agentType: 'grok-build' });
    store.terminateTask(source.id);
    const app = mkApp(store);
    const res = await app.request('/api/tasks/migratable?targetAgent=claude-code&fromAgent=grok-build');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ taskId: string; eligible: boolean }> };
    const hit = body.candidates.find((c) => c.taskId === source.id);
    expect(hit?.eligible).toBe(true);
  });
});
