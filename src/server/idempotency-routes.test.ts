// HTTP-level contract tests for the POST /api/tasks idempotencyKey surface
// (issue #1526 Phase B / FM2, FM3). Complements the lower-level unit tests in
// core/idempotency-ledger.test.ts (ledger mechanics) and
// server/launch-service.test.ts (launchTask wrapper) by exercising the real
// route: body validation, response shape, concurrent HTTP requests, and
// ledger durability across a server restart.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

async function startServer(tempDir: string): Promise<KookrServerInternal> {
  return createKookrServerInternal({
    port: 0,
    host: '127.0.0.1',
    kookrDir: tempDir,
    tasksFile: join(tempDir, 'tasks.json'),
    hooksDir: join(tempDir, 'hooks'),
    settingsDir: join(tempDir, 'settings'),
    serverCwd: '/test/cwd',
    frontendDir: join(tempDir, 'frontend'),
    saveIntervalMs: 600_000,
    livenessIntervalMs: 600_000,
    terminalBackend: new FakeTerminalBackend(),
    claudeDir: join(tempDir, 'claude'),
  });
}

describe('POST /api/tasks idempotencyKey (issue #1526 Phase B)', () => {
  let tempDir: string;
  let cwd: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-idempotency-'));
    cwd = mkdtempSync(join(tmpdir(), 'kookr-idempotency-cwd-'));
    server = await startServer(tempDir);
    baseUrl = `http://127.0.0.1:${getActualPort(server)}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test('rejects a non-string idempotencyKey', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: 42 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('idempotencyKey must be a non-empty string');
  });

  test('rejects an empty idempotencyKey', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('idempotencyKey must be a non-empty string');
  });

  test('rejects an idempotencyKey over the bounded length', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: 'x'.repeat(201) }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('idempotencyKey must be at most');
  });

  test('accepts a key at exactly the bounded length', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: 'x'.repeat(200) }),
    });
    expect(res.status).toBe(201);
  });

  test('first request with a key creates the task; the same key later replays it at 200', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: 'issue-1526#42@batch-1' }),
    });
    expect(first.status).toBe(201);
    const firstTask = await first.json();
    expect(firstTask.idempotentReplay).toBeUndefined();

    const second = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', cwd, idempotencyKey: 'issue-1526#42@batch-1' }),
    });
    expect(second.status).toBe(200);
    const secondTask = await second.json();
    expect(secondTask.idempotentReplay).toBe(true);
    expect(secondTask.id).toBe(firstTask.id);

    // Exactly one task exists — the retry did not spawn a duplicate.
    const listRes = await fetch(`${baseUrl}/api/tasks`);
    const tasks = await listRes.json();
    expect(tasks).toHaveLength(1);
  });

  test('a different idempotencyKey creates a second, distinct task', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'first', cwd, idempotencyKey: 'key-a' }),
    });
    const firstTask = await first.json();

    const second = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'second', cwd, idempotencyKey: 'key-b' }),
    });
    expect(second.status).toBe(201);
    const secondTask = await second.json();
    expect(secondTask.id).not.toBe(firstTask.id);
  });

  test('requests without a key behave exactly as before (prompt dedup, no idempotentReplay field)', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'no key', cwd }),
    });
    const firstTask = await first.json();

    const second = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'no key', cwd }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.idempotentReplay).toBeUndefined();
    expect(secondBody.task.id).toBe(firstTask.id);
  });

  test('two concurrent identical POSTs with the same key create exactly one task', async () => {
    const post = () => fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'race', cwd, idempotencyKey: 'race-key' }),
    });

    const [resA, resB] = await Promise.all([post(), post()]);
    const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

    expect(bodyA.id).toBe(bodyB.id);
    // Exactly one of the two responses is a fresh 201 create; the other replays it.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 201]);
    const replayFlags = [bodyA.idempotentReplay, bodyB.idempotentReplay].filter((v) => v === true);
    expect(replayFlags).toHaveLength(1);

    const listRes = await fetch(`${baseUrl}/api/tasks`);
    const tasks = await listRes.json();
    expect(tasks).toHaveLength(1);
  });

  test('ledger survives a server restart: reloaded ledger still detects a replay', async () => {
    const first = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'restart me', cwd, idempotencyKey: 'restart-key' }),
    });
    expect(first.status).toBe(201);
    const firstTask = await first.json();

    // Simulate a server restart against the same on-disk kookrDir.
    await server.close();
    server = await startServer(tempDir);
    baseUrl = `http://127.0.0.1:${getActualPort(server)}`;

    const second = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'restart me', cwd, idempotencyKey: 'restart-key' }),
    });
    expect(second.status).toBe(200);
    const secondTask = await second.json();
    expect(secondTask.idempotentReplay).toBe(true);
    expect(secondTask.id).toBe(firstTask.id);
  });
});
