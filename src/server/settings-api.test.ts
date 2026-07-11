import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('Settings API', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  async function startServer() {
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
    baseUrl = `http://127.0.0.1:${getActualPort(server)}`;
  }

  async function stopServer() {
    await server.close();
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-settings-test-'));
    await startServer();
  });

  afterEach(async () => {
    await stopServer();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /api/settings returns defaults with loadedFromDefaults flag', async () => {
    const res = await fetch(`${baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      githubPollingEnabled: true,
      githubPollingIntervalSec: 60,
      autoWatchOssSources: true,
      watchdogStaleThresholdSec: 30,
      repeatedErrorThreshold: 3,
      maxActiveTasks: 10,
      defaultAgentType: 'claude-code',
      roundRobinIndex: 0,
      shortcutBindings: {},
      speakVerbosity: 'medium',
      agentEffort: { 'codex-cli': 'max' },
      quietHours: [],
      replySnippets: [],
      loadedFromDefaults: true,
      warnings: [],
    });
  });

  test('PUT /api/settings persists valid settings with warnings array', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: false,
        githubPollingIntervalSec: 120,
        defaultAgentType: 'codex-cli',
        shortcutBindings: {
          mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubPollingEnabled).toBe(false);
    expect(data.githubPollingIntervalSec).toBe(120);
    expect(data.defaultAgentType).toBe('codex-cli');
    expect(data.shortcutBindings).toEqual({
      mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
    });
    expect(data.warnings).toEqual([]);

    // Verify persisted to file
    const fileContent = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
    expect(fileContent.githubPollingEnabled).toBe(false);
    expect(fileContent.githubPollingIntervalSec).toBe(120);
    expect(fileContent.defaultAgentType).toBe('codex-cli');
    expect(fileContent.shortcutBindings).toEqual({
      mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
    });
  });

  test('PUT /api/settings clamps out-of-range interval', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: true,
        githubPollingIntervalSec: 5, // below min of 15
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubPollingIntervalSec).toBe(15);
  });

  test('PUT /api/settings validates body is an object', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  test('GET /api/settings reflects previous PUT', async () => {
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: false,
        githubPollingIntervalSec: 300,
      }),
    });

    const res = await fetch(`${baseUrl}/api/settings`);
    const data = await res.json();
    expect(data.githubPollingEnabled).toBe(false);
    expect(data.githubPollingIntervalSec).toBe(300);
    expect(data.loadedFromDefaults).toBe(false); // After PUT, no longer defaults
  });

  test('PUT /api/settings with unknown keys still validates known keys', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: false,
        unknownSetting: 'value',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubPollingEnabled).toBe(false);
    // Unknown keys are stripped
    expect(data.unknownSetting).toBeUndefined();
  });

  test('PUT /api/settings validates shortcut bindings with warnings', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shortcutBindings: {
          mac: {
            next_bottleneck: 'Cmd+Ctrl+Space',
            quick_launch: 'Cmd+Ctrl+Space',
            previous_task: 'Ctrl+N+K',
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.shortcutBindings).toEqual({
      mac: { next_bottleneck: 'Cmd+Ctrl+Space' },
    });
    expect(data.warnings).toEqual([
      'Shortcut "quick_launch" in mac bindings conflicts with "next_bottleneck" on Cmd+Ctrl+Space; ignored',
      'Shortcut "previous_task" in mac bindings has invalid binding "Ctrl+N+K"; ignored',
    ]);
  });

  test('GET /api/settings surfaces shortcut validation warnings from hand-edited settings file', async () => {
    writeFileSync(join(tempDir, 'settings.json'), JSON.stringify({
      shortcutBindings: {
        darwin: { next_bottleneck: 'Cmd+Ctrl+Space' },
        mac: { quick_launch: 'N' },
      },
    }));

    await stopServer();
    await startServer();

    const res = await fetch(`${baseUrl}/api/settings`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.shortcutBindings).toEqual({ mac: {} });
    expect(data.warnings).toEqual([
      'Unknown shortcut platform "darwin" was ignored',
      'Shortcut "quick_launch" in mac bindings has invalid binding "N"; ignored',
    ]);
  });

  test('PUT /api/settings rejects invalid defaultAgentType to the safe default', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultAgentType: 'gemini-cli',
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.defaultAgentType).toBe('claude-code');
  });

  test('PUT /api/settings accepts the round-robin defaultAgentType', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultAgentType: 'round-robin' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.defaultAgentType).toBe('round-robin');

    const fileContent = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
    expect(fileContent.defaultAgentType).toBe('round-robin');
  });

  test('PUT /api/settings does not let the client roll back the server-managed round-robin cursor', async () => {
    // roundRobinIndex is server-managed; a PUT carrying a stale/forged value
    // must not overwrite the live cursor. No launches have run on this test
    // server, so the cursor stays at its default of 0.
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundRobinIndex: 999 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.roundRobinIndex).toBe(0);

    const getRes = await fetch(`${baseUrl}/api/settings`);
    expect((await getRes.json()).roundRobinIndex).toBe(0);

    const fileContent = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
    expect(fileContent.roundRobinIndex).toBe(0);
  });

  test('disabling polling stops the GitHub scanner', async () => {
    // Initially active (or may not be if gh is unavailable in test env)
    const initialStatus = await (await fetch(`${baseUrl}/api/github/status`)).json();

    // Disable polling
    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        githubPollingEnabled: false,
        githubPollingIntervalSec: 60,
      }),
    });

    const statusAfter = await (await fetch(`${baseUrl}/api/github/status`)).json();
    expect(statusAfter.active).toBe(false);
  });
});
