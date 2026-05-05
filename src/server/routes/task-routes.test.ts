import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { RouteDeps } from './shared.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

vi.mock('../launch-service.js', async (importActual) => {
  const actual = await importActual<typeof import('../launch-service.js')>();
  return {
    ...actual,
    launchTask: vi.fn(),
  };
});

vi.mock('../use-cases/delete-task.js', async (importActual) => {
  const actual = await importActual<typeof import('../use-cases/delete-task.js')>();
  return {
    ...actual,
    deleteTask: vi.fn(),
  };
});

import { launchTask } from '../launch-service.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { registerTaskRoutes } from './task-routes.js';

function mkApp(deps: Partial<RouteDeps>): Hono {
  const app = new Hono();
  registerTaskRoutes(app, deps as unknown as RouteDeps);
  return app;
}

function broadcastNoop(_msg: ServerMessage): void {
  /* no-op */
}

describe('GET /api/playbooks', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'playbooks-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns [] when the cwd has no .kookr/playbooks directory', async () => {
    const res = await mkApp({ serverCwd: tempDir }).request('/api/playbooks');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test('returns parsed playbooks from the provided cwd', async () => {
    const dir = join(tempDir, '.kookr', 'playbooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'review.md'), `---
name: Daily review
parameters: []
---
Review the queue.
`);

    const res = await mkApp({ serverCwd: tempDir }).request('/api/playbooks');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Daily review');
  });

  test('accepts an explicit ?cwd= query parameter', async () => {
    const dir = join(tempDir, 'other-project');
    mkdirSync(join(dir, '.kookr', 'playbooks'), { recursive: true });
    writeFileSync(join(dir, '.kookr', 'playbooks', 'alt.md'), `---
name: Alt playbook
parameters: []
---
Do something else.
`);

    const res = await mkApp({ serverCwd: '/does-not-matter' })
      .request(`/api/playbooks?cwd=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Alt playbook');
  });
});

describe('POST /api/tasks error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 500 when launchTask throws', async () => {
    vi.mocked(launchTask).mockRejectedValueOnce(new Error('adapter blew up'));

    const taskStore = new TaskStore();
    const monitor = new Monitor(taskStore, new AttentionQueue());
    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
      launchServiceDeps: {} as never,
    }).request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'fail me', cwd: '/cwd' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('adapter blew up');
  });
});

describe('DELETE /api/tasks/:id error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 500 when the delete use-case throws', async () => {
    vi.mocked(deleteTask).mockRejectedValueOnce(new Error('session kill failed'));

    const taskStore = new TaskStore();
    const task = taskStore.createTask('Doomed', '/cwd');
    const monitor = new Monitor(taskStore, new AttentionQueue());

    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
    }).request(`/api/tasks/${task.id}`, { method: 'DELETE' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('session kill failed');
  });

  test('still 404s when the task is unknown even with mocks wired', async () => {
    const taskStore = new TaskStore();
    const monitor = new Monitor(taskStore, new AttentionQueue());
    const res = await mkApp({
      taskStore,
      monitor,
      broadcastToAll: broadcastNoop,
      serverCwd: '/cwd',
    }).request('/api/tasks/does-not-exist', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(vi.mocked(deleteTask)).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:sessionId/effective-hook-settings', () => {
  function mkAdapterReturning(effective: unknown) {
    return {
      agentType: 'claude-code' as const,
      launch: vi.fn(),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
      getEffectiveHookSettings: vi.fn(() => effective as ReturnType<typeof vi.fn>['_type']),
    };
  }

  test('returns 200 with adapter payload for a known session id', async () => {
    const payload = {
      content: { hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }] } },
      agentType: 'claude-code',
      settingsPath: '/home/u/.kookr/settings/kookr-abc.json',
    };
    const adapter = mkAdapterReturning(payload);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-abc/effective-hook-settings',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(adapter.getEffectiveHookSettings).toHaveBeenCalledWith('kookr-abc');
  });

  test('returns 404 for an unknown session id', async () => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      '/api/sessions/kookr-nope/effective-hook-settings',
    );
    expect(res.status).toBe(404);
  });

  test.each([
    { label: 'space (decoded)', id: 'has%20space' },
    { label: 'encoded traversal', id: '..%2F..%2Fetc%2Fpasswd' },
    { label: 'null byte', id: 'good%00' },
    { label: 'tilde', id: '~root' },
  ])('rejects invalid session id without calling the adapter: $label', async ({ id }) => {
    const adapter = mkAdapterReturning(undefined);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${id}/effective-hook-settings`,
    );
    // 400 when the regex rejects the decoded id; 404 when the URL router
    // normalizes/strips the path before the handler matches. Either is a
    // safe outcome — the adapter must never be consulted.
    expect([400, 404]).toContain(res.status);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });

  test('returns 400 for session ids that exceed the length cap', async () => {
    const adapter = mkAdapterReturning(undefined);
    const long = 'a'.repeat(129);
    const res = await mkApp({ adapter: adapter as never }).request(
      `/api/sessions/${long}/effective-hook-settings`,
    );
    expect(res.status).toBe(400);
    expect(adapter.getEffectiveHookSettings).not.toHaveBeenCalled();
  });
});
