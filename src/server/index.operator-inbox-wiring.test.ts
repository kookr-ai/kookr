/**
 * Boot wiring guard for the operator inbox (issue #3994): the server must hand
 * the inbox its real ask service and integration train monitor on both
 * surfaces, `GET /api/operator/inbox` (`routes.ts`) and Telegram `/brief`
 * (`index.ts`). Both pass them as optional spreads, so dropping one only hides
 * the pending questions or the halted train; the inbox's own tests and the
 * Telegram tests inject their own deps and stay green.
 *
 * Hermetic: the fake Telegram server stands in for the Bot API and the question
 * is created through the real `POST /api/asks`. Only the train monitor's
 * readers are replaced (module-wide), so this lives apart from index.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { IntegrationTrainMonitor } from './integration-train-monitor.js';

/** The monitor the server built at boot, so the test can run its check. */
const trainMonitors: IntegrationTrainMonitor[] = [];

vi.mock('./integration-train-monitor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration-train-monitor.js')>();
  return {
    ...actual,
    // A real monitor (the lifecycle timers drive it too) whose readers see a
    // halted train instead of the host's git checkout and train files.
    createIntegrationTrainMonitorFromEnv: (deps: { kookrDir: string; repoPath: string }) => {
      const monitor = new actual.IntegrationTrainMonitor({
        kookrDir: deps.kookrDir,
        repoPath: deps.repoPath,
        statePath: join(deps.kookrDir, 'integration-train-monitor.json'),
        readConfiguredBranch: async () => 'staging',
        readRemoteRefs: async () => ({ main: 'aaa', integration: 'aaa' }),
        readStatus: () => ({
          stateDir: join(deps.kookrDir, 'train'),
          running: true,
          pid: 1234,
          halted: { reason: 'base-red', at: '2026-11-16T10:00:00.000Z' },
          lastCycle: null,
          restartPending: null,
        }),
        writeSignal: async () => undefined,
        logger: { log: () => undefined, warn: () => undefined },
      });
      trainMonitors.push(monitor);
      return monitor;
    },
  };
});

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { startFakeTelegram, type FakeTelegramServer } from '../integrations/telegram/fake-telegram-server.js';
import type { OperatorInbox } from '../shared/contracts/operator-inbox.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

const OPERATOR_ID = 4242;
const ENV_KEYS = [
  'KOOKR_TELEGRAM_BOT_TOKEN', 'KOOKR_TELEGRAM_ALLOWED_USERS', 'KOOKR_REMOTE_CHAT_PROJECTS',
  'KOOKR_TELEGRAM_API_URL', 'KOOKR_REMOTE_CHAT_DISABLED',
] as const;

describe('server boot wires the ask service and train monitor into the operator inbox (issue #3994)', () => {
  let tempDir: string;
  let fake: FakeTelegramServer;
  let server: KookrServerInternal | null = null;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-inbox-wiring-'));
    trainMonitors.length = 0;
    fake = await startFakeTelegram();
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.KOOKR_TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KOOKR_TELEGRAM_ALLOWED_USERS = String(OPERATOR_ID);
    process.env.KOOKR_REMOTE_CHAT_PROJECTS = tempDir;
    process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
    delete process.env.KOOKR_REMOTE_CHAT_DISABLED;
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await fake.stop();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('GET /api/operator/inbox and /brief both list the pending question and the halted train', { timeout: 20_000 }, async () => {
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
    const base = `http://127.0.0.1:${(server.httpServer.address() as { port: number }).port}`;

    // The train: the monitor reports nothing until its first check has run.
    expect(trainMonitors).toHaveLength(1);
    await trainMonitors[0].maybeRun();
    expect(trainMonitors[0].getHealthSnapshot()?.halted?.reason).toBe('base-red');

    // The question, through the real ask route and service.
    const task = server.taskStore.createTask('Fix login', tempDir);
    const res = await fetch(`${base}/api/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, question: 'Ship it?', options: ['Yes', 'No'] }),
    });
    expect(res.status).toBe(201);
    const { ask } = (await res.json()) as { ask: { id: string } };

    // GET /api/operator/inbox (routes.ts wiring).
    const inboxRes = await fetch(`${base}/api/operator/inbox`);
    expect(inboxRes.status).toBe(200);
    const inbox = (await inboxRes.json()) as OperatorInbox;
    expect(inbox.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'question', askId: ask.id, taskId: task.id, question: 'Ship it?' }),
      expect.objectContaining({ kind: 'train', trainState: 'base-red' }),
    ]));

    // Telegram /brief (index.ts wiring), answered by the real Telegram integration.
    fake.queueUpdates([{
      update_id: 1,
      message: { message_id: 1, from: { id: OPERATOR_ID }, chat: { id: OPERATOR_ID, type: 'private' }, text: '/brief' },
    } as never]);
    const briefReply = () => fake.outbound.sendMessage.find((m) => m.text.includes('waiting'));
    await expect.poll(briefReply, { timeout: 10_000 }).toBeDefined();
    const firstLine = briefReply()!.text.split('\n')[0];
    expect(firstLine).toContain('1 question');
    expect(firstLine).toContain('train halted');
  });
});
