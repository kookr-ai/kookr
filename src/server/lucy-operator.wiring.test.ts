/**
 * End-to-end wiring of Lucy's operator conversation (issue #3660) through the real
 * server: real routes, real task store, real interaction log and real HTTP streaming.
 * Only the model provider is faked, by a local server that speaks OpenRouter's
 * streaming format and records what it was sent.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { taskHandles } from '../core/lucy-operator/board.js';
import type { LucyTurnEvent } from '../shared/contracts/lucy-turn.js';
import { createKookrServerInternal } from './index.js';
import type { LucyOperatorConfigResult } from './lucy-operator/config.js';
import type { KookrServerInternal } from './server-test-helpers.js';

function portOf(server: { address(): unknown }): number {
  const addr = server.address();
  if (addr && typeof addr === 'object' && 'port' in addr) return (addr as { port: number }).port;
  throw new Error('Server not listening');
}

const sse = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;

describe('Lucy operator wiring (real server, fake model provider)', () => {
  let tempDir: string;
  let provider: Server;
  let server: KookrServerInternal | undefined;
  /** Request bodies the fake provider received, in order. */
  let received: Array<{ auth: string | undefined; body: any }>;
  /** What the fake provider answers to each request, in order. */
  let replies: string[][];

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-lucy-operator-'));
    received = [];
    replies = [];
    provider = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of replies.shift() ?? []) res.write(part);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function start(lucyOperatorConfig?: LucyOperatorConfigResult): Promise<string> {
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
      ...(lucyOperatorConfig ? { lucyOperatorConfig } : {}),
    });
    return `http://127.0.0.1:${portOf(server.httpServer)}`;
  }

  const enabled = (): LucyOperatorConfigResult => ({
    enabled: true,
    ok: true,
    warnings: [],
    model: {
      apiKey: 'sk-or-wiring',
      model: 'deepseek/deepseek-v4.1-flash-1017',
      baseUrl: `http://127.0.0.1:${portOf(provider)}/api/v1`,
      providers: ['cohere/fp8', 'deepinfra/fp8'],
      reasoning: 'medium',
    },
  });

  const turn = (baseUrl: string, text: string): Promise<Response> =>
    fetch(`${baseUrl}/api/lucy/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, conversationId: 'wiring' }) });

  test('off by default: the route answers 404 and the provider is never contacted', async () => {
    const baseUrl = await start({ enabled: false });
    const res = await turn(baseUrl, 'What is running?');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'lucy_operator_disabled' });
    expect(received).toHaveLength(0);
  });

  test('switched on without a key: 503 with the reason, and the provider is never contacted', async () => {
    const baseUrl = await start({ enabled: true, ok: false, reason: 'Lucy\'s conversation needs an OpenRouter key.', warnings: [] });
    const res = await turn(baseUrl, 'What is running?');
    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  test('a look-up then an answer, over real HTTP: the board comes from the task store and the turn is logged', async () => {
    const baseUrl = await start(enabled());
    const task = server!.taskStore.createTask('Fix login flow', '/project/alpha');
    const code = taskHandles(server!.taskStore.viewTasks()).get(task.id)!;
    replies.push(
      [sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'show_task', arguments: JSON.stringify({ task: code }) } }] }, finish_reason: 'tool_calls' }] }),
        sse({ provider: 'Cohere', choices: [], usage: { prompt_tokens: 800, completion_tokens: 20, cost: 0.00012 } })],
      [sse({ choices: [{ delta: { content: 'Fix login flow ' } }] }), sse({ choices: [{ delta: { content: 'is on your screen.' } }] }),
        sse({ provider: 'Cohere', choices: [], usage: { prompt_tokens: 900, completion_tokens: 9, cost: 0.00011 } })],
    );

    const res = await turn(baseUrl, 'Show me the login task.');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as LucyTurnEvent);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'screen', 'tool_result', 'text', 'text', 'done']);
    expect(events[1]).toEqual({ type: 'screen', command: 'show_task', taskId: task.id });
    expect(events.at(-1)).toMatchObject({ type: 'done', end: 'answered', steps: 2, inputTokens: 1700, outputTokens: 29, provider: 'Cohere' });
    expect((events.at(-1) as { costUsd: number }).costUsd).toBeCloseTo(0.00023, 8);

    // What the provider was sent: the key in a header, the pinned providers, the reasoning level,
    // the five look tools, and a board built from the real task store.
    expect(received).toHaveLength(2);
    expect(received[0]!.auth).toBe('Bearer sk-or-wiring');
    expect(received[0]!.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      stream: true,
      provider: { order: ['cohere/fp8', 'deepinfra/fp8'], only: ['cohere', 'deepinfra'] },
      reasoning: { effort: 'medium' },
    });
    expect(received[0]!.body.tools.map((t: any) => t.function.name)).toEqual(['read_board', 'read_task', 'read_task_output', 'show_task', 'list_projects']);
    expect(received[0]!.body.messages[0].content).toContain(`[${code}] "Fix login flow"`);
    // The second call carries the look-up's answer back.
    expect(received[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });

    // One operator_turn line in the interaction log, with tool names but not their results.
    // The log is written off the request path, so wait for the line to land.
    const logPath = join(tempDir, 'lucy-interactions.jsonl');
    const deadline = Date.now() + 5000;
    while (!existsSync(logPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const logLines = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatchObject({
      kind: 'operator_turn',
      conversationId: 'wiring',
      end: 'answered',
      asked: 'Show me the login task.',
      answer: 'Fix login flow is on your screen.',
      tools: ['show_task'],
      model: 'deepseek/deepseek-v4.1-flash-1017',
      provider: 'Cohere',
      steps: 2,
    });
  });
});
