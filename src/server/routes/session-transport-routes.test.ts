import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { TaskStore } from '../../core/tasks.js';
import { FakeTerminalBackend } from '../../adapters/fake-terminal-backend.js';
import { registerSessionTransportRoutes, type SessionTransportRouteDeps } from './session-transport-routes.js';

const SESSION = 'session-1';

async function setup(): Promise<{
  app: Hono;
  taskStore: TaskStore;
  backend: FakeTerminalBackend;
  taskId: string;
}> {
  const taskStore = new TaskStore();
  const task = taskStore.createTask('Repair transport', '/repo');
  taskStore.addSession(task.id, {
    tmuxSession: SESSION,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(),
  });

  const backend = new FakeTerminalBackend();
  await backend.createSession({ id: SESSION, command: 'claude', args: [] });

  const app = new Hono();
  registerSessionTransportRoutes(app, { taskStore, terminalBackend: backend } satisfies SessionTransportRouteDeps);
  return { app, taskStore, backend, taskId: task.id };
}

function reconnectUrl(taskId: string, sessionId: string): string {
  return `/api/tasks/${taskId}/sessions/${sessionId}/reconnect-transport`;
}

describe('POST /api/tasks/:taskId/sessions/:sessionId/reconnect-transport', () => {
  test('reconnects and reports preserved master + agent pids on success', async () => {
    const { app, backend, taskId } = await setup();
    const res = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('success');
    expect(body.reason).toBe('reconnected');
    expect(body.identityVerified).toBe(true);
    expect(body.taskId).toBe(taskId);
    expect(body.sessionId).toBe(SESSION);
    // Master + agent pids reported, and a fresh attach generation.
    expect(body.masterPid).toBeGreaterThan(0);
    expect(body.agentPid).toBeGreaterThan(0);
    expect(body.newGeneration).toBe(body.previousGeneration + 1);
    // The repair never wrote terminal input.
    expect(backend.getWrittenBytes(SESSION)).toHaveLength(0);
  });

  test('reports inconclusive (200) when no fresh-liveness byte arrives', async () => {
    const { app, backend, taskId } = await setup();
    backend.setReconnectWedged(SESSION, true);
    backend.reconnectLivenessTimeoutMs = 10;

    const res = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('inconclusive');
    expect(body.reason).toBe('liveness-timeout');
  });

  test('rejects with 429 when a second request lands within the cooldown', async () => {
    const { app, backend, taskId } = await setup();
    backend.reconnectCooldownMs = 10_000;

    const first = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST' });
    expect(first.status).toBe(200);
    const second = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST' });
    expect(second.status).toBe(429);
    const body = await second.json();
    expect(body.outcome).toBe('failure');
    expect(body.reason).toBe('cooldown');
  });

  test('rejects with 409 when the session identity cannot be verified', async () => {
    const { app, backend, taskId } = await setup();
    // A dead session models a master/socket that no longer verifies.
    await backend.killSession(SESSION);

    const res = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.outcome).toBe('failure');
    expect(body.reason).toBe('identity-unverified');
  });

  test('404 for an unknown task', async () => {
    const { app } = await setup();
    const res = await app.request(reconnectUrl('nope', SESSION), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('404 for a session not owned by the task', async () => {
    const { app, taskId } = await setup();
    const res = await app.request(reconnectUrl(taskId, 'other-session'), { method: 'POST' });
    expect(res.status).toBe(404);
  });

  test('501 when the backend does not support reconnect', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('No backend', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: SESSION,
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });
    const app = new Hono();
    registerSessionTransportRoutes(app, { taskStore });
    const res = await app.request(reconnectUrl(task.id, SESSION), { method: 'POST' });
    expect(res.status).toBe(501);
  });

  test('400 on a malformed JSON body', async () => {
    const { app, taskId } = await setup();
    const res = await app.request(reconnectUrl(taskId, SESSION), { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-json');
  });

  test('forwards reason and clamps livenessTimeoutMs to the backend', async () => {
    const { app, backend, taskId } = await setup();
    const res = await app.request(reconnectUrl(taskId, SESSION), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'wedged tui', livenessTimeoutMs: 999_999 }),
    });
    expect(res.status).toBe(200);
    expect(backend.lastReconnectOptions?.actor).toBe('owner');
    expect(backend.lastReconnectOptions?.reason).toBe('wedged tui');
    // 999_999 is clamped to the 30_000ms ceiling.
    expect(backend.lastReconnectOptions?.livenessTimeoutMs).toBe(30_000);
  });

  test('collapses concurrent duplicate requests onto one reconnect attempt', async () => {
    const { app, backend, taskId } = await setup();
    backend.setReconnectWedged(SESSION, true);
    backend.reconnectLivenessTimeoutMs = 80;

    const [a, b] = await Promise.all([
      app.request(reconnectUrl(taskId, SESSION), { method: 'POST' }),
      app.request(reconnectUrl(taskId, SESSION), { method: 'POST' }),
    ]);
    const [bodyA, bodyB] = await Promise.all([a.json(), b.json()]);
    // Both collapsed onto one attempt → one generation bump, identical result.
    expect(bodyA.newGeneration).toBe(bodyA.previousGeneration + 1);
    expect(bodyB.newGeneration).toBe(bodyA.newGeneration);
  });
});
