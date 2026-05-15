import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { RemoteLaunchCommand } from '../remote/launch-broker.js';
import {
  asActorId,
  asClientId,
  asCommandId,
  asGrantId,
  asIdempotencyKey,
  asNodeEpoch,
  asNodeId,
  asSessionEpoch,
  asSessionId,
} from '../remote/ids.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

const ENV_KEYS = [
  'KOOKR_RELAY_URL',
  'KOOKR_RELAY_FEATURES',
  'KOOKR_RELAY_LAUNCH_ALLOWLIST',
  'KOOKR_REMOTE_CHAT_DISABLED',
] as const;

function launchCommand(overrides: Partial<RemoteLaunchCommand> = {}): RemoteLaunchCommand {
  return {
    actorId: asActorId('owner-1'),
    clientId: asClientId('client-1'),
    commandId: asCommandId('command-1'),
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('epoch-1'),
    sessionId: asSessionId('launch'),
    sessionEpoch: asSessionEpoch('launch'),
    action: 'launch',
    grantsChecked: ['launch'],
    grantId: asGrantId('grant-1'),
    baseRevision: 1,
    idempotencyKey: asIdempotencyKey('idem-1'),
    payload: {
      type: 'launch',
      projectId: 'github.com/kookr-ai/kookr',
      prompt: 'Remote launch',
      agentType: 'claude-code',
    },
    ...overrides,
  };
}

describe('remote launch broker server wiring', () => {
  const originalEnv = new Map<string, string | undefined>();
  let server: KookrServerInternal | null = null;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  function setEnv(env: Partial<Record<typeof ENV_KEYS[number], string>>): void {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      if (env[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = env[key];
      }
    }
    process.env.KOOKR_REMOTE_CHAT_DISABLED = '1';
  }

  async function startServer(projectDir: string): Promise<KookrServerInternal> {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-remote-launch-'));
    return await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: projectDir,
      frontendDir: join(tempDir, 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: new FakeTerminalBackend(),
      claudeDir: join(tempDir, 'claude'),
    });
  }

  test('enables allowlisted remote launch only when the launch feature is active', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'kookr-remote-project-'));
    setEnv({
      KOOKR_RELAY_URL: 'wss://relay.example.test',
      KOOKR_RELAY_FEATURES: 'terminal,launch',
      KOOKR_RELAY_LAUNCH_ALLOWLIST: JSON.stringify({
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: projectDir,
          agents: ['claude-code'],
          maxConcurrent: 1,
        }],
      }),
    });

    try {
      server = await startServer(projectDir);
      expect(server.remoteLaunchBroker).toBeDefined();

      const result = await server.remoteLaunchBroker!.handle(launchCommand());
      expect(result).toMatchObject({ ok: true, value: { queued: false } });

      const task = server.taskStore.listTasks()[0];
      expect(task).toEqual(expect.objectContaining({
        cwd: projectDir,
        projectId: 'github.com/kookr-ai/kookr',
        agentType: 'claude-code',
        status: 'inProgress',
      }));

      const second = await server.remoteLaunchBroker!.handle(launchCommand({
        commandId: asCommandId('command-2'),
        idempotencyKey: asIdempotencyKey('idem-2'),
      }));
      expect(second).toMatchObject({ ok: false, error: 'error.concurrencyLimit' });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('leaves phase 4a/local surfaces running when launch feature is disabled', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'kookr-remote-project-'));
    setEnv({
      KOOKR_RELAY_URL: 'wss://relay.example.test',
      KOOKR_RELAY_FEATURES: 'terminal,permission-approve',
      KOOKR_RELAY_LAUNCH_ALLOWLIST: JSON.stringify({
        version: 1,
        ownerId: 'owner-1',
        projects: [{
          projectId: 'github.com/kookr-ai/kookr',
          cwd: projectDir,
          agents: ['claude-code'],
          maxConcurrent: 1,
        }],
      }),
    });

    try {
      server = await startServer(projectDir);
      expect(server.remoteLaunchBroker).toBeUndefined();
      expect(server.taskStore.listTasks()).toHaveLength(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
