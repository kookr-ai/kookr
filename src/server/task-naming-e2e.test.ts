import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

const hasApiKey = !!(
  process.env.GROQ_API_KEY ||
  process.env.GEMINI_API_KEY ||
  process.env.ANTHROPIC_API_KEY ||
  process.env.KOOKR_OPENROUTER_API_KEY ||
  process.env.OPENROUTER_API_KEY
);

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

/**
 * Wait for the LLM to upgrade the name away from the deterministic
 * creation-time placeholder (issue #1554: tasks are named from birth, so the
 * name is never empty — the real-API upgrade is observed as a change).
 */
function waitForTaskNameChange(
  server: KookrServerInternal,
  taskId: string,
  placeholder: string,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(pollInterval);
      reject(new Error(`Timed out waiting for name upgrade (${timeoutMs}ms)`));
    }, timeoutMs);

    const pollInterval = setInterval(() => {
      const name = server.taskStore.getTask(taskId)?.name;
      if (name && name !== placeholder) {
        clearTimeout(timer);
        clearInterval(pollInterval);
        resolve(name);
      }
    }, 100);
  });
}

describe.skipIf(!hasApiKey)('task naming E2E (real API)', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-naming-e2e-'));

    server = await createKookrServerInternal({
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
    });
    port = getActualPort(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('POST /api/tasks auto-generates a short name via LLM', async () => {
    // Create the task
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix the authentication bug in the login flow where expired JWT tokens are not being properly invalidated, causing users to remain logged in after their session should have expired',
        cwd: '/home/user/webapp',
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    // Named from birth with the deterministic placeholder (issue #1554); the
    // LLM name arrives asynchronously as an upgrade.
    expect(task.name).toBeTruthy();
    const placeholder: string = task.name;

    // Wait for the async AI name to replace the placeholder
    const name = await waitForTaskNameChange(server, task.id, placeholder);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(80);

    // Should be a short name, not the full prompt
    expect(name.length).toBeLessThan(task.prompt?.length ?? 100);

    const wordCount = name.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(2);
    expect(wordCount).toBeLessThanOrEqual(12);
    console.log(`E2E auto-generated name: "${name}"`);

    // Verify via API
    const tasksRes = await fetch(`${baseUrl}/api/tasks`);
    const tasks = await tasksRes.json();
    const updatedTask = tasks.find((t: any) => t.id === task.id);
    expect(updatedTask.name).toBe(name);
  }, 15_000);

  test('manual rename is not overwritten by auto-naming', async () => {
    // Create a task
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Refactor the database connection pool to support read replicas with automatic failover and health checking',
        cwd: '/home/user/backend',
      }),
    });

    const task = await res.json();

    // Immediately rename it before the AI name arrives
    server.taskStore.renameTask(task.id, 'My Custom Name');

    // Wait long enough for the AI naming to complete
    await new Promise((r) => setTimeout(r, 3000));

    // The manual name should be preserved
    const updated = server.taskStore.getTask(task.id);
    expect(updated?.name).toBe('My Custom Name');
  }, 10_000);

  test('task without API key works normally (no name)', async () => {
    // This test verifies graceful degradation — createLlmClient
    // already returned null or a client based on env. If the client exists,
    // naming works. If not, the task just has no name. Either way, the task
    // is created successfully.
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Add rate limiting to the API gateway',
        cwd: '/home/user/gateway',
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.prompt).toBe('Add rate limiting to the API gateway');
  });
});
