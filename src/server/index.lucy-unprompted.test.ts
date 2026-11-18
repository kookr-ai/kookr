/**
 * The server boot connects what Lucy says without being asked to her conversation (issue #4143): the
 * lines in `index.ts` that hand the record to the question clip route and to the line she writes when
 * a task goes quiet, and the route wiring that shows the record to each of her turns. Hermetic: the
 * fake Telegram server stands in for the Bot API and a script stands in for the model.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

// The operator conversation makes its own model from the configuration: here it is a script instead of OpenRouter.
const wired = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('../adapters/llm/openrouter-chat-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/llm/openrouter-chat-stream.js')>()),
  createOpenRouterChatStream: () => wired.model,
}));

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { scriptedModel } from '../core/lucy-operator/__fixtures__/scripted.js';
import { startFakeTelegram, type FakeTelegramServer } from '../integrations/telegram/fake-telegram-server.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';

const ENV_KEYS = [
  'KOOKR_TELEGRAM_BOT_TOKEN', 'KOOKR_TELEGRAM_ALLOWED_USERS', 'KOOKR_REMOTE_CHAT_PROJECTS',
  'KOOKR_TELEGRAM_API_URL', 'KOOKR_REMOTE_CHAT_DISABLED',
] as const;

describe('server boot: what Lucy said unprompted reaches her next turn', () => {
  let tempDir: string;
  let fake: FakeTelegramServer;
  let server: KookrServerInternal | null = null;
  let ws: WebSocket | null = null;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-it-unprompted-'));
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

  /** A real server whose operator conversation is a script. `livenessIntervalMs` is how often the liveness tick (which evaluates permission prompts) runs. */
  async function boot(livenessIntervalMs = 600_000, terminalBackend = new FakeTerminalBackend()): Promise<KookrServerInternal> {
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
      livenessIntervalMs,
      terminalBackend,
      claudeDir: join(tempDir, 'claude'),
      lucyOperatorConfig: { enabled: true, ok: true, warnings: [], launch: false, model: { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9', providers: [], reasoning: 'medium' } },
    });
  }

  test('a question she read out and a line she wrote are both in the instructions of the next typed turn', { timeout: 30_000 }, async () => {
    const model = scriptedModel([{ text: 'It asked whether to ship.' }]);
    wired.model = model.port;
    server = await boot();
    const port = (server.httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const asking = server.taskStore.createTask('Fix login', tempDir);
    const quiet = server.taskStore.createTask('Docs link audit', tempDir);
    server.taskStore.addSession(quiet.id, { tmuxSession: 'kookr-quiet', agentType: 'claude-code', cwd: tempDir, createdAt: new Date() });

    // A line is written only to a dashboard that is open: connect one, as the owner.
    const received: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data) => {
      try { received.push(JSON.parse(String(data)) as Record<string, unknown>); } catch { /* not JSON */ }
    });
    await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject); });
    await expect.poll(() => received.some((m) => m.type === 'operatorAsks')).toBe(true);

    // A task goes quiet: she writes one line about it.
    server.queue.enqueue('kookr-quiet', { agentId: 'kookr-quiet', type: 'stale_agent', severity: 'warning', explanation: 'no output for a while', detectedAt: new Date() });
    await expect.poll(() => received.filter((m) => m.type === 'lucy_says').map((m) => m.text)).toEqual(['Docs link audit has gone quiet.']);

    // A task asks a question; the dashboard asks for its clip. No speech service is configured, so the
    // route answers 503 and the dashboard writes the words instead: she has said it either way.
    const created = await fetch(`${base}/api/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: asking.id, question: 'Ship it?', options: ['Yes', 'No'] }),
    });
    expect(created.status).toBe(201);
    const { ask } = (await created.json()) as { ask: { id: string } };
    expect((await fetch(`${base}/api/asks/${ask.id}/speak`, { method: 'POST' })).status).toBe(503);

    const turn = await fetch(`${base}/api/lucy/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'what was that?', conversationId: 'typed-boot-test', input: 'typed' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();

    expect(model.requests).toHaveLength(1);
    const system = (model.requests[0]!.messages[0] as { content: string }).content;
    const note = system.slice(system.indexOf('What you told the operator without being asked'));
    expect(note.split('\n').slice(1).map((line) => line.replace(/^- (a moment|\d+ seconds) ago/, '- just now').replace(/\[[a-z0-9]+\] /g, ''))).toEqual([
      '- just now (NEW), about "Fix login": The task Fix login needs your input: Ship it? Two choices are on my card.',
      '- just now (NEW), about "Docs link audit": Docs link audit has gone quiet.',
    ]);
    expect(model.requests[0]!.messages.slice(1)).toEqual([{ role: 'user', content: 'what was that?' }]);
  });

  test('a permission notice she spoke is in the instructions of the next typed turn', { timeout: 60_000 }, async () => {
    const model = scriptedModel([{ text: 'Yes, it is waiting on Bash.' }]);
    wired.model = model.port;
    // The liveness tick evaluates permission prompts: run it often so the test polls instead of sleeping.
    // Its session is alive in the terminal backend, or the tick would fail the task as lost.
    const backend = new FakeTerminalBackend();
    await backend.createSession({ id: 'kookr-blocked', command: 'agent', args: [] });
    server = await boot(200, backend);
    const port = (server.httpServer.address() as { port: number }).port;
    const blocked = server.taskStore.createTask('Staging fixture refresh', tempDir);
    const session = 'kookr-blocked';
    server.taskStore.addSession(blocked.id, { tmuxSession: session, agentType: 'claude-code', cwd: tempDir, createdAt: new Date() });

    // The notice counts as said only when it reached an owner dashboard.
    const received: Array<Record<string, unknown>> = [];
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('message', (data) => {
      try { received.push(JSON.parse(String(data)) as Record<string, unknown>); } catch { /* not JSON */ }
    });
    await new Promise<void>((resolve, reject) => { ws!.once('open', () => resolve()); ws!.once('error', reject); });
    await expect.poll(() => received.some((m) => m.type === 'operatorAsks'), { timeout: 20_000 }).toBe(true);

    const sentence = 'The task "Staging fixture refresh" is waiting for your permission to use Bash. The command is on my card.';

    // A prompt that has waited two minutes, past the default of one: the card is built and she speaks.
    // Queued first, with the time it was first seen, so the monitor's own finding keeps that time.
    server.queue.enqueue(session, {
      agentId: session, type: 'permission_blocked', severity: 'warning',
      explanation: 'Agent is blocked on permission for tool: Bash', detectedAt: new Date(Date.now() - 120_000),
    });
    server.monitor.processEvents(session, [{ type: 'permission_request', sessionId: session, toolName: 'Bash', toolInput: { command: 'psql staging -f fixtures/seed.sql' } }]);

    await expect.poll(() => received.some((m) => m.type === 'lucyPermissionCards' && (m.announce as { text?: string } | undefined)?.text === sentence), { timeout: 30_000 }).toBe(true);

    const turn = await fetch(`http://127.0.0.1:${port}/api/lucy/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'can you make it proceed ?', conversationId: 'typed-boot-permission', input: 'typed' }),
    });
    expect(turn.status).toBe(200);
    await turn.text();

    expect(model.requests).toHaveLength(1);
    const system = (model.requests[0]!.messages[0] as { content: string }).content;
    const note = system.slice(system.indexOf('What you told the operator without being asked'));
    expect(note.split('\n').slice(1).map((line) => line.replace(/^- (a moment|\d+ seconds?) ago/, '- just now').replace(/\[[a-z0-9]+\] /g, ''))).toEqual([
      `- just now (NEW), about "Staging fixture refresh": ${sentence}`,
    ]);
  });
});
