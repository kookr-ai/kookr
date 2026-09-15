import { describe, test, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// RFC F12: launchTask rejects a missing working directory with HTTP 400
// before naming runs. Keep these directories real so the live lane can reach
// the LLM when credentials are present.
const projectDirs: string[] = [];

function makeProjectDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `kookr-naming-e2e-${label}-`));
  projectDirs.push(dir);
  return dir;
}

const WEBAPP_DIR = makeProjectDir('webapp');
const BACKEND_DIR = makeProjectDir('backend');
const GATEWAY_DIR = makeProjectDir('gateway');
const MISSING_DIR = join(tmpdir(), `kookr-naming-e2e-absent-${process.pid}`);

afterAll(() => {
  for (const dir of projectDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

async function createNamingServer(): Promise<{
  tempDir: string;
  server: KookrServerInternal;
  baseUrl: string;
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'kookr-naming-e2e-'));
  const server = await createKookrServerInternal({
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
  const addr = server.httpServer.address();
  if (!addr || typeof addr !== 'object') {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Server not listening');
  }
  return { tempDir, server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

describe('task naming E2E cwd fixtures', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  beforeEach(async () => {
    ({ tempDir, server, baseUrl } = await createNamingServer());
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('POST /api/tasks accepts a real temporary working directory', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Add rate limiting to the API gateway',
        cwd: GATEWAY_DIR,
      }),
    });

    expect(res.status).toBe(201);
    const task = (await res.json()) as { id: string; prompt: string };
    expect(task.id).toBeDefined();
    expect(task.prompt).toBe('Add rate limiting to the API gateway');
  });

  test('POST /api/tasks rejects a missing working directory before naming', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix the authentication bug in the login flow',
        cwd: MISSING_DIR,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/working directory does not exist/i);
  });
});

describe.skipIf(!hasApiKey)('task naming E2E (real API)', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  beforeEach(async () => {
    ({ tempDir, server, baseUrl } = await createNamingServer());
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('POST /api/tasks auto-generates a short name via LLM', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix the authentication bug in the login flow where expired JWT tokens are not being properly invalidated, causing users to remain logged in after their session should have expired',
        cwd: WEBAPP_DIR,
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    // Named from birth with the deterministic placeholder (issue #1554); the
    // LLM name arrives asynchronously as an upgrade.
    expect(task.name).toBeTruthy();
    const placeholder: string = task.name;

    const name = await waitForTaskNameChange(server, task.id, placeholder);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(80);

    expect(name.length).toBeLessThan(task.prompt?.length ?? 100);

    const wordCount = name.split(/\s+/).length;
    expect(wordCount).toBeGreaterThanOrEqual(2);
    expect(wordCount).toBeLessThanOrEqual(12);
    console.log(`E2E auto-generated name: "${name}"`);

    const tasksRes = await fetch(`${baseUrl}/api/tasks`);
    const tasks = await tasksRes.json();
    const updatedTask = tasks.find((t: { id: string }) => t.id === task.id);
    expect(updatedTask.name).toBe(name);
  }, 15_000);

  test('manual rename is not overwritten by auto-naming', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Refactor the database connection pool to support read replicas with automatic failover and health checking',
        cwd: BACKEND_DIR,
      }),
    });

    const task = await res.json();

    server.taskStore.renameTask(task.id, 'My Custom Name');

    await new Promise((r) => setTimeout(r, 3000));

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
        cwd: GATEWAY_DIR,
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toBeDefined();
    expect(task.prompt).toBe('Add rate limiting to the API gateway');
  });
});
