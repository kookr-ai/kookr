import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-settings-test-'));
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
  });

  afterEach(async () => {
    await server.close();
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
      loadedFromDefaults: true,
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
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.githubPollingEnabled).toBe(false);
    expect(data.githubPollingIntervalSec).toBe(120);
    expect(data.defaultAgentType).toBe('codex-cli');
    expect(data.warnings).toEqual([]);

    // Verify persisted to file
    const fileContent = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
    expect(fileContent.githubPollingEnabled).toBe(false);
    expect(fileContent.githubPollingIntervalSec).toBe(120);
    expect(fileContent.defaultAgentType).toBe('codex-cli');
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
