/**
 * The server boot with `kookr ask` switched on (a Telegram token configured):
 * the lines in `index.ts` that connect the ask service to the dashboard push are
 * otherwise only run by the manual proof scripts. Hermetic: the fake Telegram
 * server stands in for the Bot API, and the ask is created through the real route.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { startFakeTelegram, type FakeTelegramServer } from '../integrations/telegram/fake-telegram-server.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

const ENV_KEYS = [
  'KOOKR_TELEGRAM_BOT_TOKEN', 'KOOKR_TELEGRAM_ALLOWED_USERS', 'KOOKR_REMOTE_CHAT_PROJECTS',
  'KOOKR_TELEGRAM_API_URL', 'KOOKR_REMOTE_CHAT_DISABLED',
] as const;

describe('server boot with kookr ask enabled', () => {
  let tempDir: string;
  let fake: FakeTelegramServer;
  let server: KookrServerInternal | null = null;
  let ws: WebSocket | null = null;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-it-asks-'));
    fake = await startFakeTelegram();
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    process.env.KOOKR_TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.KOOKR_TELEGRAM_ALLOWED_USERS = '4242';
    process.env.KOOKR_REMOTE_CHAT_PROJECTS = tempDir;
    process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
    delete process.env.KOOKR_REMOTE_CHAT_DISABLED;
  });

  afterEach(async () => {
    ws?.close();
    ws = null;
    await server?.close();
    server = null;
    await fake.stop();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('an owner socket is sent the question list on connect and the new question, announced, when a task asks', { timeout: 20_000 }, async () => {
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
    const port = (server.httpServer.address() as { port: number }).port;
    const task = server.taskStore.createTask('Fix login', tempDir);

    const received: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data) => {
      try { received.push(JSON.parse(String(data)) as Record<string, unknown>); } catch { /* not JSON */ }
    });
    await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject); });
    const asksMessages = () => received.filter((m) => m.type === 'operatorAsks');
    await expect.poll(() => asksMessages().length).toBe(1);
    expect(asksMessages()[0]).toMatchObject({ asks: [], serverNow: expect.any(Number) });

    const res = await fetch(`http://127.0.0.1:${port}/api/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, question: 'Ship it?', options: ['Yes', 'No'] }),
    });
    expect(res.status).toBe(201);
    const { ask } = (await res.json()) as { ask: { id: string } };

    await expect.poll(() => asksMessages().length).toBeGreaterThanOrEqual(2);
    const announced = asksMessages().find((m) => m.announce === ask.id);
    expect(announced).toMatchObject({
      announce: ask.id,
      serverNow: expect.any(Number),
      asks: [{ id: ask.id, taskName: 'Fix login', question: 'Ship it?', state: 'pending' }],
    });
  });
});
