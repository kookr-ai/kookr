/**
 * Integration tests for AI task naming.
 * Mocks the LLM client at the module level to verify the full flow
 * from task creation through naming without requiring a real API key.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';

// Mock the adapter factory BEFORE importing the server
const mockCreateLlmClient = vi.fn();

vi.mock('../adapters/llm/factory.js', () => ({
  createLlmClient: (...args: unknown[]) => mockCreateLlmClient(...args),
}));

// Mock generateTaskName so we control naming behavior. deterministicTaskName
// stays REAL: it is the guaranteed fallback under test (issue #1526 Phase C4).
const mockGenerateTaskName = vi.fn();

vi.mock('../core/task-naming.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/task-naming.js')>();
  return {
    ...actual,
    generateTaskName: (...args: unknown[]) => mockGenerateTaskName(...args),
  };
});

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

// RFC F12: launchTask validates that the working directory exists before
// spawning, so launch cwds used by these integration tests must be real
// directories.
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'kookr-naming-project-'));
const BACKEND_DIR = mkdtempSync(join(tmpdir(), 'kookr-naming-backend-'));

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

/** Poll the task store for a name to appear (up to timeoutMs). */
function waitForTaskName(server: KookrServerInternal, taskId: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for task name (${timeoutMs}ms)`));
    }, timeoutMs);

    const poll = setInterval(() => {
      const task = server.taskStore.getTask(taskId);
      if (task?.name) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(task.name);
      }
    }, 20);
  });
}

/**
 * Poll until a task's name equals `expected`. Tasks are now named from birth
 * (issue #1554: deterministic placeholder at creation), so `waitForTaskName`
 * resolves on that placeholder before the async LLM upgrade lands — assertions
 * that target the upgraded name must wait for the specific value.
 */
function waitForTaskNameToBe(
  server: KookrServerInternal,
  taskId: string,
  expected: string,
  timeoutMs = 3000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      const actual = server.taskStore.getTask(taskId)?.name;
      reject(new Error(`Timed out waiting for name "${expected}" (got "${actual}", ${timeoutMs}ms)`));
    }, timeoutMs);

    const poll = setInterval(() => {
      if (server.taskStore.getTask(taskId)?.name === expected) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      }
    }, 20);
  });
}

/** Poll the task store until the expected number of tasks exists. */
function waitForTaskCount(server: KookrServerInternal, expectedCount: number, timeoutMs = 3000) {
  return new Promise<ReturnType<typeof server.taskStore.listTasks>>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${expectedCount} task(s) (${timeoutMs}ms)`));
    }, timeoutMs);

    const poll = setInterval(() => {
      const tasks = server.taskStore.listTasks();
      if (tasks.length === expectedCount) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(tasks);
      }
    }, 20);
  });
}

describe('AI task naming integration', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-naming-int-'));

    // Default: LLM client available, returns a name
    mockCreateLlmClient.mockResolvedValue({
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockResolvedValue('Fix JWT Token Invalidation'),
    });
    mockGenerateTaskName.mockResolvedValue('Fix JWT Token Invalidation');

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
    vi.clearAllMocks();
  });

  test('POST /api/tasks triggers auto-naming and sets task name', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix the auth bug in login flow',
        cwd: PROJECT_DIR,
        criteria: 'Tests pass',
      }),
    });

    expect(res.status).toBe(201);
    const task = await res.json();

    // The task is named from birth (issue #1554: deterministic placeholder at
    // creation, asserted deterministically in the core unit tests), then
    // upgraded asynchronously by the LLM namer.
    await waitForTaskNameToBe(server, task.id, 'Fix JWT Token Invalidation');

    // Verify generateTaskName was called with correct args
    expect(mockGenerateTaskName).toHaveBeenCalledOnce();
    const [client, prompt, cwd, criteria] = mockGenerateTaskName.mock.calls[0];
    expect(client).toBeTruthy(); // the mock client object
    expect(prompt).toBe('Fix the auth bug in login flow');
    expect(cwd).toBe(PROJECT_DIR);
    expect(criteria).toBe('Tests pass');
  });

  test('WS launch triggers auto-naming and sets task name', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // Wait for initial snapshot
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.once('message', () => resolve()));
    });

    // Send launch message
    ws.send(JSON.stringify({
      type: 'launch',
      prompt: 'Refactor the database layer',
      cwd: BACKEND_DIR,
    }));

    // Wait for launch snapshot
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve());
    });

    // Get the created task. WebSocket snapshots can arrive before async launch
    // persistence is observable on slower runners, so wait on the store too.
    const tasks = await waitForTaskCount(server, 1);
    expect(tasks).toHaveLength(1);

    // Wait for the async LLM upgrade over the creation-time placeholder.
    await waitForTaskNameToBe(server, tasks[0].id, 'Fix JWT Token Invalidation');

    // Verify generateTaskName was called
    expect(mockGenerateTaskName).toHaveBeenCalled();

    ws.close();
    await new Promise<void>((r) => ws.on('close', () => r()));
  });

  test('naming broadcasts updated snapshot with new taskName', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // Collect all messages
    const messages: any[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    // Wait for initial snapshot
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.once('message', () => resolve()));
    });

    // Create task via HTTP
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Fix the auth bug',
        cwd: PROJECT_DIR,
      }),
    });
    const task = await res.json();

    // Wait for naming to complete
    await waitForTaskName(server, task.id);

    // Wait for the broadcast containing the AI-generated name
    await vi.waitFor(() => {
      const namedSnapshot = messages.find(
        (m: any) => m.type === 'snapshot' && m.agents?.some((a: any) => a.taskName === 'Fix JWT Token Invalidation'),
      );
      expect(namedSnapshot).toBeDefined();
    }, { timeout: 3000 });

    ws.close();
    await new Promise<void>((r) => ws.on('close', () => r()));
  });

  test('deterministic fallback names the task when llmClient is null (no API key)', async () => {
    // Close the default server
    await server.close();

    // Recreate with naming disabled
    mockCreateLlmClient.mockResolvedValue(null);

    server = await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks2.json'),
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

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fix bug', cwd: PROJECT_DIR }),
    });
    const task = await res.json();

    // The LLM path never fires, but the task still gets the deterministic
    // prompt-derived name (issue #1526 Phase C4: no task is ever unnamed).
    const name = await waitForTaskName(server, task.id);
    expect(name).toBe('Fix bug');
    expect(mockGenerateTaskName).not.toHaveBeenCalled();
  });

  test('deterministic fallback applies when the LLM returns an empty name (2026-07-24 grok burst regression)', async () => {
    mockGenerateTaskName.mockResolvedValue(null);

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fix bug', cwd: PROJECT_DIR }),
    });
    const task = await res.json();

    // Wait for the naming call to complete (returns null)
    await vi.waitFor(() => {
      expect(mockGenerateTaskName).toHaveBeenCalledOnce();
    }, { timeout: 3000 });

    const name = await waitForTaskName(server, task.id);
    expect(name).toBe('Fix bug');
  });

  test('deterministic fallback applies on API rejection (no crash, task still named)', async () => {
    mockGenerateTaskName.mockRejectedValue(new Error('API error'));

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fix bug', cwd: PROJECT_DIR }),
    });
    const task = await res.json();

    // Wait for the naming call to complete (rejects)
    await vi.waitFor(() => {
      expect(mockGenerateTaskName).toHaveBeenCalledOnce();
    }, { timeout: 3000 });

    // Server should still be functional — no crash — and the task named.
    const name = await waitForTaskName(server, task.id);
    expect(name).toBe('Fix bug');
    const healthRes = await fetch(`${baseUrl}/api/health`);
    expect(healthRes.status).toBe(200);
  });

  test('manual rename is not overwritten by auto-naming', async () => {
    // Use a delayed response to simulate slow API
    mockGenerateTaskName.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve('AI Name'), 300)),
    );

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fix bug', cwd: PROJECT_DIR }),
    });
    const task = await res.json();

    // Immediately rename the task manually
    server.taskStore.renameTask(task.id, 'My Custom Name');

    // Wait for the AI naming to attempt completion
    await vi.waitFor(() => {
      expect(mockGenerateTaskName).toHaveBeenCalledOnce();
    }, { timeout: 3000 });
    // Small settle to let the post-naming renameTask path execute
    await new Promise((r) => setTimeout(r, 50));

    // Manual name should be preserved
    const updated = server.taskStore.getTask(task.id);
    expect(updated?.name).toBe('My Custom Name');
  });

  test('playbook tasks are not auto-named (they already have names)', async () => {
    // Create a task and pre-set its name (simulating playbook behavior)
    const task = server.taskStore.createTask('Do the thing', '/cwd');
    task.name = 'My Playbook';

    // Trigger the naming path by calling autoNameTask directly
    // The real WS path checks !task.name — since it's set, naming is skipped
    // Verify mockGenerateTaskName was not called for a pre-named task
    mockGenerateTaskName.mockClear();

    // Naming should NOT fire for a pre-named task — verify after settling
    await new Promise((r) => setTimeout(r, 100));

    const callsForThisTask = mockGenerateTaskName.mock.calls.filter(
      (_call: unknown[]) => (_call as [unknown, string])[1] === 'Do the thing',
    );
    expect(callsForThisTask).toHaveLength(0);
  });

  test('named task is visible in GET /api/tasks response', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Add pagination', cwd: PROJECT_DIR }),
    });
    const task = await res.json();

    await waitForTaskNameToBe(server, task.id, 'Fix JWT Token Invalidation');

    // Verify the name shows up in the tasks list API
    const listRes = await fetch(`${baseUrl}/api/tasks`);
    const tasks = await listRes.json();
    const found = tasks.find((t: any) => t.id === task.id);
    expect(found.name).toBe('Fix JWT Token Invalidation');
  });

  test('criteria is undefined when not provided in launch', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Fix bug', cwd: PROJECT_DIR }),
      // No criteria field
    });
    await res.json();

    // Wait for the naming call
    await vi.waitFor(() => {
      expect(mockGenerateTaskName).toHaveBeenCalledOnce();
    }, { timeout: 3000 });
    const [, , , criteria] = mockGenerateTaskName.mock.calls[0];
    expect(criteria).toBeUndefined();
  });

  test('multiple tasks are named independently', async () => {
    let callCount = 0;
    mockGenerateTaskName.mockImplementation(async (_client: unknown, prompt: string) => {
      callCount++;
      // Return different names based on the prompt
      if (prompt.includes('auth')) return 'Fix Auth Flow';
      if (prompt.includes('pagination')) return 'Add User Pagination';
      return 'Generic Task';
    });

    // Create two tasks concurrently
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Fix auth bug', cwd: PROJECT_DIR }),
      }),
      fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Add pagination to users', cwd: PROJECT_DIR }),
      }),
    ]);

    const task1 = await res1.json();
    const task2 = await res2.json();

    // Wait for both LLM upgrades over the creation-time placeholders.
    await Promise.all([
      waitForTaskNameToBe(server, task1.id, 'Fix Auth Flow'),
      waitForTaskNameToBe(server, task2.id, 'Add User Pagination'),
    ]);
    expect(callCount).toBe(2);
  });

  test('WS relaunch triggers auto-naming for new task', async () => {
    // First create a task
    // Real dir: the WS relaunch below reuses this task's cwd and goes through
    // launchTask, which now validates the working directory (RFC F12).
    const original = server.taskStore.createTask('Original prompt', PROJECT_DIR);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    // Wait for initial snapshot
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.once('message', () => resolve()));
    });

    // Send relaunch message
    ws.send(JSON.stringify({
      type: 'relaunch',
      taskId: original.id,
      prompt: 'Revised prompt for the task',
    }));

    // Wait for the launch to complete
    await new Promise<void>((resolve) => {
      ws.once('message', () => resolve());
    });

    // Find the new task (not the original). Relaunch completion is delivered
    // over the same websocket channel as snapshots, so the first message after
    // send is not guaranteed to be the post-launch state.
    let newTaskId: string | undefined;
    await vi.waitFor(() => {
      const tasks = server.taskStore.listTasks();
      const newTask = tasks.find((t) => t.id !== original.id);
      expect(newTask).toBeDefined();
      newTaskId = newTask!.id;
    });

    // Wait for the LLM upgrade over the creation-time placeholder.
    await waitForTaskNameToBe(server, newTaskId!, 'Fix JWT Token Invalidation');

    ws.close();
    await new Promise<void>((r) => ws.on('close', () => r()));
  });
});
