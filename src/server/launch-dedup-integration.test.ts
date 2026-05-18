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

describe('launch dedup integration', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-launch-dedup-'));
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
      claudeDir: join(tempDir, 'claude'),
    });
    baseUrl = `http://127.0.0.1:${getActualPort(server)}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('POST /api/tasks bypasses a stale inProgress duplicate using production launch deps', async () => {
    const stale = server.taskStore.createTask({ prompt: 'hello', cwd: '/tmp' });
    server.taskStore.addSession(stale.id, {
      tmuxSession: 'kookr-stale',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', cwd: '/tmp' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; duplicate?: boolean };
    expect(body.duplicate).toBeUndefined();
    expect(body.id).not.toBe(stale.id);
    expect(server.taskStore.getTask(stale.id)!.status).toBe('terminated');
    expect(server.taskStore.getTask(stale.id)!.sessions[0].lastStatus).toBe('completed');
  });
});
