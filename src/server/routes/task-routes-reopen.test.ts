import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { SUPERVISOR_TOKEN_ENV } from '../supervisor-auth.js';
import { registerTaskRoutes } from './task-routes.js';
import { SHARED_TASK_ID_PREFIX } from '../../shared/contracts/contact-share.js';
import type { TaskRouteDeps } from './shared.js';

// The route awaits promotion of the reopened task; stand in for it so a test can
// make the relaunch fail without a real adapter.
const promotePendingTasks = vi.fn(async (_opts: unknown) => undefined);
vi.mock('../agent-lifecycle.js', async (importActual) => ({
  ...(await importActual<typeof import('../agent-lifecycle.js')>()),
  promotePendingTasks: (opts: unknown) => promotePendingTasks(opts),
}));

const originalToken = process.env[SUPERVISOR_TOKEN_ENV];

afterEach(() => {
  promotePendingTasks.mockReset();
  promotePendingTasks.mockImplementation(async () => undefined);
  if (originalToken === undefined) delete process.env[SUPERVISOR_TOKEN_ENV];
  else process.env[SUPERVISOR_TOKEN_ENV] = originalToken;
});

function mkApp(taskStore: TaskStore, opts: { kookrDir?: string } = {}): { app: Hono; broadcastToAll: ReturnType<typeof vi.fn> } {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  const broadcastToAll = vi.fn();
  const deps = {
    taskStore,
    monitor,
    queue,
    adapter: { stop: vi.fn(async () => {}) } as never,
    hookWatcher: { stop: vi.fn(), isWatching: () => false, watch: vi.fn() } as never,
    watchdog: { unregisterAgent: vi.fn() } as never,
    broadcastToAll,
    serverCwd: '/server',
    launchServiceDeps: { taskStore, adapterRegistry: {}, lifecycleDeps: {} } as never,
    ...(opts.kookrDir ? { kookrDir: opts.kookrDir } : {}),
  } as unknown as TaskRouteDeps;
  const app = new Hono();
  registerTaskRoutes(app, deps);
  return { app, broadcastToAll };
}

/** A task that ran one session and then terminated (e.g. reaped as hung). */
function terminatedTask(
  taskStore: TaskStore,
  opts: { agentType?: 'claude-code' | 'codex-cli'; claudeSessionId?: string } = {},
): string {
  const task = taskStore.createTask({ prompt: 'Implement the thing', cwd: '/repo', agentType: opts.agentType });
  taskStore.addSession(task.id, {
    tmuxSession: 'kookr-prior',
    agentType: opts.agentType ?? 'claude-code',
    cwd: '/repo-wt',
    createdAt: new Date(),
  });
  if (opts.claudeSessionId) {
    taskStore.updateSession(task.id, 'kookr-prior', { claudeSessionId: opts.claudeSessionId });
  }
  taskStore.terminateTask(task.id);
  return task.id;
}

const reopen = (app: Hono, id: string, headers: Record<string, string> = {}) =>
  app.request(`/api/tasks/${id}/reopen`, { method: 'POST', headers });

describe('POST /api/tasks/:id/reopen (issue #3671)', () => {
  test('reopens a terminated task and reports that it resumes its conversation', async () => {
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore, { claudeSessionId: 'sess-prior' });
    const { app, broadcastToAll } = mkApp(taskStore);

    const res = await reopen(app, id);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; task: { id: string; status: string }; resume: unknown };
    expect(body.ok).toBe(true);
    expect(body.task).toMatchObject({ id, status: 'pending' });
    expect(body.resume).toEqual({ mode: 'resume', conversationId: 'sess-prior' });
    expect(taskStore.wantsResumeOnNextLaunch(id)).toBe(true);
    expect(promotePendingTasks).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalled();
  });

  test('a task whose SessionStart was never captured is reopened but reported not resumable, with the reason', async () => {
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore);
    const { app } = mkApp(taskStore);

    const res = await reopen(app, id);

    expect(res.status).toBe(200);
    const body = await res.json() as { resume: { mode: string; reason?: string } };
    expect(body.resume.mode).toBe('not_resumable');
    expect(body.resume.reason).toMatch(/SessionStart/);
    expect(taskStore.getTask(id)?.status).toBe('pending');
  });

  test('an agent that cannot resume is reported not resumable even with a provider id', async () => {
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore, { agentType: 'codex-cli', claudeSessionId: 'sess-prior' });
    const { app } = mkApp(taskStore);

    const body = await (await reopen(app, id)).json() as { resume: unknown };

    expect(body.resume).toEqual({ mode: 'not_resumable', reason: 'agent type codex-cli does not support resume' });
  });

  test('refuses a running task with 409 task_not_terminal and launches nothing', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Still running', '/repo');
    taskStore.addSession(task.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    const { app } = mkApp(taskStore);

    const res = await reopen(app, task.id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'task_not_terminal' });
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(promotePendingTasks).not.toHaveBeenCalled();
  });

  test('a relaunch that fails reports 409 reopen_launch_failed with the launch error', async () => {
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore, { claudeSessionId: 'sess-prior' });
    promotePendingTasks.mockImplementation(async () => {
      taskStore.cancelTask(id, { source: 'provider_admission', reason: 'launch_failure', detail: 'adapter exploded' });
    });
    const { app, broadcastToAll } = mkApp(taskStore);

    const res = await reopen(app, id);

    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('reopen_launch_failed');
    expect(body.error).toContain('adapter exploded');
    expect(broadcastToAll).toHaveBeenCalled();
  });

  test('a task still under dependency-probe cleanup is refused with 409 task_cleanup_in_progress', async () => {
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore, { claudeSessionId: 'sess-prior' });
    taskStore.getTaskForMutation(id)!.launchAdmission = { status: 'probing' } as never;
    const { app } = mkApp(taskStore);

    const res = await reopen(app, id);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'task_cleanup_in_progress' });
    expect(taskStore.getTask(id)?.status).toBe('terminated');
  });

  test('refuses a remote-owned shared: id with 403 and touches nothing', async () => {
    const taskStore = new TaskStore();
    const { app, broadcastToAll } = mkApp(taskStore);

    const res = await reopen(app, encodeURIComponent(`${SHARED_TASK_ID_PREFIX}peer-task`));

    expect(res.status).toBe(403);
    expect(promotePendingTasks).not.toHaveBeenCalled();
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  test('404s for an unknown task id', async () => {
    const { app } = mkApp(new TaskStore());
    expect((await reopen(app, 'does-not-exist')).status).toBe(404);
  });

  test('audits each call as a task.reopen row attributed to X-Kookr-Actor (#3914)', async () => {
    const kookrDir = mkdtempSync(join(tmpdir(), 'kookr-reopen-audit-'));
    try {
      const taskStore = new TaskStore();
      const id = terminatedTask(taskStore, { claudeSessionId: 'sess-prior' });
      const { app } = mkApp(taskStore, { kookrDir });

      expect((await reopen(app, id, { 'x-kookr-actor': 'cli' })).status).toBe(200);
      // A second reopen of the now-pending task is refused, and audited too.
      expect((await reopen(app, id, { 'x-kookr-actor': 'cli' })).status).toBe(409);

      const rows = readFileSync(join(kookrDir, 'audit.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toEqual([
        expect.objectContaining({
          type: 'task.reopen',
          actor: { source: 'api', actorId: 'cli' },
          taskId: id,
          outcome: 'reopened',
          status: 'pending',
          resumeMode: 'resume',
        }),
        expect.objectContaining({
          type: 'task.reopen',
          actor: { source: 'api', actorId: 'cli' },
          taskId: id,
          outcome: 'invalid',
          code: 'task_not_terminal',
        }),
      ]);
    } finally {
      rmSync(kookrDir, { recursive: true, force: true });
    }
  });

  describe('note body (issue #4227)', () => {
    const reopenWithBody = (app: Hono, id: string, body: string) =>
      app.request(`/api/tasks/${id}/reopen`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

    test('stores the trimmed note as reopenNote and returns it on the task', async () => {
      const taskStore = new TaskStore();
      const id = terminatedTask(taskStore);
      const { app } = mkApp(taskStore);

      const res = await reopenWithBody(app, id, JSON.stringify({ note: '  Do not merge.  ' }));

      expect(res.status).toBe(200);
      const body = await res.json() as { task: { reopenNote?: string }; resume: { mode: string } };
      expect(body.resume.mode).toBe('not_resumable');
      expect(body.task.reopenNote).toBe('Do not merge.');
      expect(taskStore.getTask(id)?.reopenNote).toBe('Do not merge.');
      // Stored before promotion runs, so the relaunch it triggers sees it.
      expect(promotePendingTasks).toHaveBeenCalledTimes(1);
    });

    test('a later note replaces the earlier one; a reopen without a note keeps it', async () => {
      const taskStore = new TaskStore();
      const id = terminatedTask(taskStore);
      const { app } = mkApp(taskStore);

      expect((await reopenWithBody(app, id, JSON.stringify({ note: 'first' }))).status).toBe(200);
      taskStore.cancelTask(id); // pending -> cancelled, reopenable again
      expect((await reopen(app, id)).status).toBe(200);
      expect(taskStore.getTask(id)?.reopenNote).toBe('first');
      taskStore.cancelTask(id);
      expect((await reopenWithBody(app, id, JSON.stringify({ note: 'second' }))).status).toBe(200);
      expect(taskStore.getTask(id)?.reopenNote).toBe('second');
    });

    test('accepts a note of exactly 8000 characters', async () => {
      const taskStore = new TaskStore();
      const id = terminatedTask(taskStore);
      const { app } = mkApp(taskStore);

      expect((await reopenWithBody(app, id, JSON.stringify({ note: 'x'.repeat(8000) }))).status).toBe(200);
      expect(taskStore.getTask(id)?.reopenNote).toHaveLength(8000);
    });

    test('marks the note for the resumed conversation only when the reopen resumes it', async () => {
      const taskStore = new TaskStore();
      const resumable = terminatedTask(taskStore, { claudeSessionId: 'sess-prior' });
      const fresh = terminatedTask(taskStore);
      const bare = terminatedTask(taskStore, { claudeSessionId: 'sess-other' });
      const { app } = mkApp(taskStore);

      expect((await reopenWithBody(app, resumable, JSON.stringify({ note: 'n' }))).status).toBe(200);
      expect((await reopenWithBody(app, fresh, JSON.stringify({ note: 'n' }))).status).toBe(200);
      expect((await reopen(app, bare)).status).toBe(200);

      expect(taskStore.takeReopenNoteOnNextResume(resumable)).toBe(true);
      expect(taskStore.takeReopenNoteOnNextResume(fresh)).toBe(false);
      expect(taskStore.takeReopenNoteOnNextResume(bare)).toBe(false);
    });

    test('an empty body or one without note means no note', async () => {
      const taskStore = new TaskStore();
      const a = terminatedTask(taskStore);
      const b = terminatedTask(taskStore);
      const { app } = mkApp(taskStore);

      expect((await reopenWithBody(app, a, '')).status).toBe(200);
      expect((await reopenWithBody(app, b, '{}')).status).toBe(200);
      expect(taskStore.getTask(a)?.reopenNote).toBeUndefined();
      expect(taskStore.getTask(b)?.reopenNote).toBeUndefined();
    });

    test.each([
      ['malformed JSON', '{note:'],
      ['a non-object body', '"Do not merge"'],
      ['a non-string note', JSON.stringify({ note: 42 })],
      ['a blank note', JSON.stringify({ note: '   ' })],
      ['an over-long note', JSON.stringify({ note: 'x'.repeat(8001) })],
    ])('refuses %s with 400 invalid_reopen_note and leaves the task terminal', async (_label, raw) => {
      const taskStore = new TaskStore();
      const id = terminatedTask(taskStore);
      const { app } = mkApp(taskStore);

      const res = await reopenWithBody(app, id, raw);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_reopen_note' });
      expect(taskStore.getTask(id)?.status).toBe('terminated');
      expect(promotePendingTasks).not.toHaveBeenCalled();
    });

    test('a refused reopen leaves the existing note unchanged', async () => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Still running', '/repo');
      taskStore.addSession(task.id, { tmuxSession: 'kookr-live', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
      taskStore.setReopenNote(task.id, 'earlier note');
      const { app } = mkApp(taskStore);

      const res = await reopenWithBody(app, task.id, JSON.stringify({ note: 'new note' }));

      expect(res.status).toBe(409);
      expect(taskStore.getTask(task.id)?.reopenNote).toBe('earlier note');
    });
  });

  test('is supervisor-gated like /complete when KOOKR_SUPERVISOR_TOKEN is set', async () => {
    process.env[SUPERVISOR_TOKEN_ENV] = 'sup3r-secret';
    const taskStore = new TaskStore();
    const id = terminatedTask(taskStore);
    const { app } = mkApp(taskStore);

    expect((await reopen(app, id)).status).toBe(401);
    expect(taskStore.getTask(id)?.status).toBe('terminated');
    expect((await reopen(app, id, { authorization: 'Bearer sup3r-secret' })).status).toBe(200);
  });
});
