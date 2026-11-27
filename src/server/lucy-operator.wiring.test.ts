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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { taskHandles } from '../core/lucy-operator/board.js';
import type { LucyTurnEvent } from '../shared/contracts/lucy-turn.js';
import { startFakeTelegram, type FakeTelegramServer } from '../integrations/telegram/fake-telegram-server.js';
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
  /** HTTP statuses the fake provider answers before it starts answering normally, in order (a failing provider). */
  let failures: number[];
  let backend: FakeTerminalBackend;
  let fakeTelegram: FakeTelegramServer | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-lucy-operator-'));
    received = [];
    replies = [];
    failures = [];
    provider = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        const failure = failures.shift();
        if (failure !== undefined) {
          res.writeHead(failure, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Provider returned error', code: failure, metadata: { provider_name: 'Sail Research', provider_error_code: 'ttft_deadline_guard' } } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of replies.shift() ?? []) res.write(part);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await server?.close();
    server = undefined;
    await fakeTelegram?.stop();
    fakeTelegram = undefined;
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function start(lucyOperatorConfig?: LucyOperatorConfigResult): Promise<string> {
    backend = new FakeTerminalBackend();
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
      terminalBackend: backend,
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
      providers: [],
      reasoning: 'medium',
    },
  });

  const turn = (baseUrl: string, text: string): Promise<Response> =>
    fetch(`${baseUrl}/api/lucy/turn`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, conversationId: 'wiring' }) });

  test('unset with no OpenRouter key: the route answers 404 and nothing is contacted', async () => {
    vi.stubEnv('KOOKR_LUCY_OPERATOR', '');
    vi.stubEnv('KOOKR_OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const baseUrl = await start();
    const res = await turn(baseUrl, 'What is running?');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'lucy_operator_disabled' });
    expect(received).toHaveLength(0);
  });

  test('KOOKR_LUCY_OPERATOR=true in the environment switches it on; without a key it answers 503', async () => {
    vi.stubEnv('KOOKR_LUCY_OPERATOR', 'true');
    vi.stubEnv('KOOKR_OPENROUTER_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const baseUrl = await start();
    const res = await turn(baseUrl, 'What is running?');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'lucy_operator_unavailable', message: expect.stringContaining('OpenRouter key') });
    expect(received).toHaveLength(0);
  });

  test('switched off explicitly: the route answers 404 and the provider is never contacted', async () => {
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

  test('a provider that answers 429 twice: each turn ends answered from the board, then the breaker opens and /api/health says so', async () => {
    const baseUrl = await start(enabled());
    server!.taskStore.createTask('Fix login flow', '/project/alpha');
    failures = [429, 429];
    const lastEvent = async (text: string): Promise<{ done: Extract<LucyTurnEvent, { type: 'done' }>; said: string }> => {
      const events = (await (await turn(baseUrl, text)).text()).trim().split('\n').map((line) => JSON.parse(line) as LucyTurnEvent);
      return { done: events.at(-1) as Extract<LucyTurnEvent, { type: 'done' }>, said: events.map((e) => (e.type === 'text' ? e.delta : '')).join('') };
    };

    for (const text of ['What is running?', 'And now?']) {
      const { done, said } = await lucyTurn(text);
      expect(done).toMatchObject({ end: 'answered', source: 'board', reason: "My language model is not answering: OpenRouter's provider Sail Research is rate-limited (429)." });
      expect(said).toContain('From the board:');
    }
    expect(received).toHaveLength(2);

    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { lucyOperator: Record<string, unknown> };
    expect(health.lucyOperator).toMatchObject({ configured: true, model: 'deepseek/deepseek-v4.1-flash-1017', breakerOpen: true, lastSuccessAt: null });
    expect(health.lucyOperator.lastFailure).toContain('Sail Research');

    // The breaker is open: the third turn is answered from the board without reaching the provider.
    const third = await lucyTurn('Anything else?');
    expect(third.done).toMatchObject({ end: 'answered', source: 'board' });
    expect(received).toHaveLength(2);

    async function lucyTurn(text: string) { return lastEvent(text); }
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

    // What the provider was sent: the key in a header, no pinned provider (the OpenRouter
    // account's routing rule decides), the reasoning level,
    // the five look tools, and a board built from the real task store.
    expect(received).toHaveLength(2);
    expect(received[0]!.auth).toBe('Bearer sk-or-wiring');
    expect(received[0]!.body).toMatchObject({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      stream: true,
      reasoning: { effort: 'medium' },
    });
    expect(received[0]!.body).not.toHaveProperty('provider');
    expect(received[0]!.body.tools.map((t: any) => t.function.name)).toEqual(['read_board', 'read_task', 'read_task_output', 'read_questions', 'show_task', 'list_projects']);
    expect(received[0]!.body.messages[0].content).toContain(`[${code}] "Fix login flow"`);
    // The second call carries the look-up's answer back.
    expect(received[1]!.body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });

    // One operator_turn line in the interaction log, with tool names but not their results.
    // The log is written off the request path, so wait for the line to land.
    const logPath = join(tempDir, 'lucy-interactions.jsonl');
    const deadline = Date.now() + 5000;
    // The file exists before its first line is complete, so wait for the closing newline.
    const complete = (): boolean => existsSync(logPath) && readFileSync(logPath, 'utf8').endsWith('\n');
    while (!complete() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
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

  // --- Lucy acting on existing tasks, through the production wiring (routes.ts and the lucyActionPorts block of index.ts) ---

  const launching = (): LucyOperatorConfigResult => {
    const config = enabled();
    return config.enabled && config.ok ? { ...config, launch: true } : config;
  };
  const toolCalls = (name: string, args: Record<string, unknown>): string[] => [
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }),
  ];
  const words = (text: string): string[] => [sse({ choices: [{ delta: { content: text } }] })];

  async function proposalOf(baseUrl: string, text: string): Promise<{ id: string; kind: string; taskId: string }> {
    const res = await turn(baseUrl, text);
    expect(res.status).toBe(200);
    const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line) as LucyTurnEvent);
    const card = events.find((e) => e.type === 'action_proposal') as { proposal: { id: string; kind: string; taskId: string } } | undefined;
    expect(card, `no action card in: ${events.map((e) => e.type).join(', ')}`).toBeDefined();
    return card!.proposal;
  }
  const confirm = (baseUrl: string, proposalId: string): Promise<Response> =>
    fetch(`${baseUrl}/api/lucy/action/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'wiring', proposalId }) });
  const auditRows = async (type: string): Promise<Array<Record<string, unknown>>> => {
    const path = join(tempDir, 'audit.jsonl');
    // Only whole lines count: a row still being written has no newline yet.
    const read = (): Array<Record<string, unknown>> => (existsSync(path)
      ? readFileSync(path, 'utf8').split('\n').slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>).filter((row) => row.type === type)
      : []);
    // The audit log is written off the request path.
    await expect.poll(() => read().length, { timeout: 5000 }).toBeGreaterThan(0);
    return read();
  };

  test('close: a finished task is closed by the confirm route through the real lifecycle commands, audited under lucy-operator', async () => {
    const baseUrl = await start(launching());
    const task = server!.taskStore.createTask('Bake-off report', '/project/alpha');
    server!.taskStore.startTask(task.id);
    server!.taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: new Date().toISOString() });
    const code = taskHandles(server!.taskStore.viewTasks()).get(task.id)!;
    replies.push(toolCalls('propose_close', { task: code }), words('Say go to close it.'));

    const card = await proposalOf(baseUrl, 'Close the bake-off report, it is done.');
    expect(card).toMatchObject({ kind: 'close', taskId: task.id });
    expect(server!.taskStore.getTask(task.id)!.status).toBe('inProgress');

    const res = await confirm(baseUrl, card.id);
    expect(await res.json()).toEqual({ outcome: 'done', proposalId: card.id, kind: 'close', taskId: task.id });
    expect(server!.taskStore.getTask(task.id)!.status).toBe('completed');

    expect(await auditRows('task.complete')).toEqual([expect.objectContaining({ actor: { source: 'api', actorId: 'lucy-operator' }, taskId: task.id, outcome: 'completed' })]);
    // The route confirms by click whatever the card was made from.
    expect(await auditRows('lucy.action')).toEqual([expect.objectContaining({ actor: 'lucy-operator', action: 'close', via: 'click', outcome: 'done', taskId: task.id })]);
  });

  test('answer: a question is answered with the chosen option through the real ask service, audited under lucy-operator', async () => {
    fakeTelegram = await startFakeTelegram();
    vi.stubEnv('KOOKR_TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('KOOKR_TELEGRAM_ALLOWED_USERS', '4242');
    vi.stubEnv('KOOKR_REMOTE_CHAT_PROJECTS', tempDir);
    vi.stubEnv('KOOKR_TELEGRAM_API_URL', fakeTelegram.baseUrl);
    vi.stubEnv('KOOKR_REMOTE_CHAT_DISABLED', '');
    const baseUrl = await start(launching());
    const task = server!.taskStore.createTask('Billing migration', tempDir);
    server!.taskStore.startTask(task.id);
    const created = await fetch(`${baseUrl}/api/asks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: task.id, question: 'Run it on production now?', options: ['Run it now', 'Run it tonight', 'Do not run it'] }),
    });
    expect(created.status).toBe(201);
    const { ask } = (await created.json()) as { ask: { id: string } };
    replies.push(toolCalls('propose_answer', { question: ask.id, option: 2 }), words('Say go to send it.'));

    const card = await proposalOf(baseUrl, 'Tell it to run tonight.');
    expect(card).toMatchObject({ kind: 'answer', taskId: task.id });

    const res = await confirm(baseUrl, card.id);
    expect(await res.json()).toMatchObject({ outcome: 'done', kind: 'answer' });

    const listed = (await (await fetch(`${baseUrl}/api/asks`)).json()) as { asks: Array<{ id: string; state: string; answer?: unknown }> };
    expect(listed.asks.find((a) => a.id === ask.id)).toMatchObject({ state: 'answered' });
    expect(JSON.stringify(listed.asks.find((a) => a.id === ask.id))).toContain('Run it tonight');

    expect(await auditRows('ask.dashboardAnswer')).toEqual([expect.objectContaining({ actor: 'lucy-operator', askId: ask.id, choice: 'option:1', outcome: 'recorded' })]);
    expect(await auditRows('lucy.action')).toEqual([expect.objectContaining({ actor: 'lucy-operator', action: 'answer', via: 'click', outcome: 'done' })]);
  });

  test('reply: a running task is sent the text through tracked delivery under the lucy_operator source', async () => {
    const baseUrl = await start(launching());
    const task = server!.taskStore.createTask('Bake-off report', '/project/alpha');
    server!.taskStore.startTask(task.id);
    const sessionId = `kookr-${task.id}`;
    await backend.createSession(sessionId, 'claude');
    server!.taskStore.addSession(task.id, { tmuxSession: sessionId, agentType: 'claude-code', cwd: '/project/alpha', createdAt: new Date() });
    const code = taskHandles(server!.taskStore.viewTasks()).get(task.id)!;
    const appended: Array<Record<string, unknown>> = [];
    const original = server!.interactionLog.append.bind(server!.interactionLog);
    vi.spyOn(server!.interactionLog, 'append').mockImplementation(async (event) => { appended.push(event as unknown as Record<string, unknown>); return original(event); });
    // The reply is written by a second model call that sees only the operator's words and answers in JSON.
    replies.push(toolCalls('propose_reply', { task: code }), [sse({ choices: [{ delta: { content: '{"text":"Rebase on main first."}' } }] })], words('Say go to send it.'));

    const card = await proposalOf(baseUrl, 'Tell the report task to rebase on main first.');
    expect(card).toMatchObject({ kind: 'reply', taskId: task.id });
    expect(appended.filter((e) => e.type === 'user_input')).toEqual([]);

    const res = await confirm(baseUrl, card.id);
    expect(await res.json()).toMatchObject({ outcome: 'done', kind: 'reply', taskId: task.id });

    // Only the delivery service records the source: the direct-input fallback records none.
    expect(appended.filter((e) => e.type === 'user_input')).toEqual([
      expect.objectContaining({ agentId: sessionId, content: 'Rebase on main first.', source: 'lucy_operator' }),
    ]);
    expect(await auditRows('lucy.action')).toEqual([expect.objectContaining({ actor: 'lucy-operator', action: 'reply', via: 'click', outcome: 'done' })]);
  });
});
