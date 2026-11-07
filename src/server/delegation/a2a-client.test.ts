import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RESULT_TEXT_CAP_BYTES, capText, createA2aClient } from './a2a-client.js';
import { FakeA2aServer } from './__fixtures__/fake-a2a-server.js';

const TOKEN = 'tok-secret-1234567890';
let server: FakeA2aServer;
const client = createA2aClient();
const ep = () => ({ url: server.url, token: TOKEN });
const opts = { timeoutMs: 2_000 };

beforeEach(async () => {
  server = new FakeA2aServer(TOKEN);
  await server.start();
});
afterEach(async () => {
  await server.stop();
});

const send = (text = 'job', contextId = 'ctx-1') => client.send(ep(), { contextId, messageId: 'm-1', text }, opts);

describe('a2a client: message/send mapping', () => {
  test('completed: text from the artifact, contextId echoed, only message/send used', async () => {
    server.plan = () => ({ kind: 'reply', text: 'the answer', delayMs: 10 });
    const o = await send('hello', 'kookr-i-abc');
    expect(o).toMatchObject({ kind: 'completed', text: 'the answer', truncated: false });
    expect(server.methodsSeen()).toEqual(['message/send']);
    const task = [...server.tasks.values()][0]!;
    expect(task.contextId).toBe('kookr-i-abc');
  });

  test('NEVER dispatches with message/stream', async () => {
    await send();
    await client.listByContext(ep(), 'ctx-1', opts);
    expect(server.methodsSeen().some((m) => /stream/i.test(m))).toBe(false);
  });

  test.each([
    ['failed', '[agent did not reply in time]', 'worker_failed'],
    ['failed', '[client disconnected]', 'worker_failed'],
    ['input_required', 'which branch?', 'needs_input'],
    ['rejected', 'Anti-loop protection', 'rejected'],
    ['canceled', '', 'cancelled'],
  ] as const)('worker state %s -> %s', async (state, text, kind) => {
    server.plan = () => ({ kind: 'reply', state, text });
    const o = await send();
    expect(o).toMatchObject({ kind, text });
  });

  test('401 with -32050 maps to auth, and the token never appears in the outcome', async () => {
    const o = await client.send({ url: server.url, token: 'wrong-token' }, { contextId: 'c', messageId: 'm', text: 't' }, opts);
    expect(o).toEqual({ kind: 'auth' });
    expect(JSON.stringify(o)).not.toContain('wrong-token');
  });

  test('a JSON-RPC -32050 inside an HTTP 200 also maps to auth', async () => {
    const stub = createA2aClient({
      fetch: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32050, message: 'unauthorized' } }), { status: 200 }),
    });
    expect(await stub.get(ep(), 't', opts)).toEqual({ kind: 'auth' });
  });

  test('unknown task id: HTTP 200 + -32001 -> not_found', async () => {
    expect(await client.get(ep(), 'task-missing', opts)).toEqual({ kind: 'not_found' });
  });

  test('connection refused -> unreachable', async () => {
    const dead = new FakeA2aServer(TOKEN);
    await dead.start();
    const url = dead.url;
    await dead.stop();
    const o = await client.send({ url, token: TOKEN }, { contextId: 'c', messageId: 'm', text: 't' }, opts);
    expect(o).toMatchObject({ kind: 'unreachable' });
  });

  test('a dropped connection mid-send -> unreachable (the task keeps running on the worker)', async () => {
    server.plan = () => ({ kind: 'drop', finishAfterMs: 30, text: 'late result' });
    const o = await send();
    expect(o).toMatchObject({ kind: 'unreachable' });
    await new Promise((r) => setTimeout(r, 80));
    expect([...server.tasks.values()][0]).toMatchObject({ state: 'completed', text: 'late result' });
  });

  test('a slow worker past the call timeout -> unreachable (timeout)', async () => {
    server.plan = () => ({ kind: 'hang' });
    const o = await client.send(ep(), { contextId: 'c', messageId: 'm', text: 't' }, { timeoutMs: 80 });
    expect(o).toEqual({ kind: 'unreachable', error: 'timeout' });
  });

  test('caller abort -> unreachable (aborted)', async () => {
    server.plan = () => ({ kind: 'hang' });
    const ctl = new AbortController();
    const p = client.send(ep(), { contextId: 'c', messageId: 'm', text: 't' }, { timeoutMs: 5_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    expect(await p).toEqual({ kind: 'unreachable', error: 'aborted' });
  });

  test('an answer for a different contextId is an error, not a result', async () => {
    const stub = createA2aClient({
      fetch: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 't', contextId: 'someone-else', status: { state: 'TASK_STATE_COMPLETED' } } }), { status: 200 }),
    });
    expect(await stub.send(ep(), { contextId: 'mine', messageId: 'm', text: 't' }, opts)).toMatchObject({ kind: 'error' });
  });

  test('also understands the v1.0 wrapped response ({task}) and lower-case v0.3 states', async () => {
    const wrapped = createA2aClient({
      fetch: async () =>
        new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { task: { id: 't1', contextId: 'c', status: { state: 'completed', message: { parts: [{ text: 'hi' }] } } } } }),
          { status: 200 },
        ),
    });
    expect(await wrapped.send(ep(), { contextId: 'c', messageId: 'm', text: 't' }, opts)).toMatchObject({ kind: 'completed', text: 'hi' });
    const inputReq = createA2aClient({
      fetch: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 't1', status: { state: 'input-required' } } }), { status: 200 }),
    });
    expect(await inputReq.get(ep(), 't1', opts)).toMatchObject({ kind: 'needs_input' });
  });

  test('malformed and unexpected answers are typed errors', async () => {
    const mk = (body: string, status = 200) => createA2aClient({ fetch: async () => new Response(body, { status }) });
    expect(await mk('not json').get(ep(), 't', opts)).toMatchObject({ kind: 'error' });
    expect(await mk('{}', 500).get(ep(), 't', opts)).toMatchObject({ kind: 'error', message: expect.stringContaining('500') });
    expect(await mk(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { id: 't', status: { state: 'TASK_STATE_WAT' } } })).get(ep(), 't', opts)).toMatchObject({ kind: 'error' });
    expect(await mk(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32051, message: 'slow down' } })).get(ep(), 't', opts)).toMatchObject({ kind: 'error' });
  });

  test('result text over 64 KB is cut on a character boundary and flagged', async () => {
    server.plan = () => ({ kind: 'reply', text: 'é'.repeat(RESULT_TEXT_CAP_BYTES) }); // 2 bytes per char
    const o = await send();
    expect(o.kind).toBe('completed');
    if (o.kind === 'completed') {
      expect(o.truncated).toBe(true);
      expect(Buffer.byteLength(o.text, 'utf8')).toBeLessThanOrEqual(RESULT_TEXT_CAP_BYTES);
      expect(o.text).not.toContain('�');
    }
    expect(capText('short')).toEqual({ text: 'short', truncated: false });
  });
});

describe('a2a client: tasks/list, get, subscribe, cancel', () => {
  test('tasks/list by contextId returns only that context, newest first, with totalSize', async () => {
    server.plan = ({ contextId }) => ({ kind: 'reply', text: `r-${contextId}` });
    await send('a', 'ctx-A');
    await send('b', 'ctx-B');
    await send('c', 'ctx-B');
    const l = await client.listByContext(ep(), 'ctx-B', opts);
    expect(l.kind).toBe('tasks');
    if (l.kind === 'tasks') {
      expect(l.tasks).toHaveLength(2);
      expect(l.totalSize).toBe(2);
      expect(l.tasks.every((t) => t.kind === 'completed')).toBe(true);
    }
    expect(server.requests.find((r) => r.method === 'tasks/list')?.params).toMatchObject({ contextId: 'ctx-B', pageSize: 20 });
  });

  test('follows nextPageToken across pages', async () => {
    for (let i = 0; i < 25; i++) await send(`t${i}`, 'ctx-big');
    const l = await client.listByContext(ep(), 'ctx-big', opts);
    expect(l).toMatchObject({ kind: 'tasks', totalSize: 25 });
    if (l.kind === 'tasks') expect(l.tasks).toHaveLength(25);
    expect(server.requests.filter((r) => r.method === 'tasks/list')).toHaveLength(2);
  });

  test('tasks/list of an unknown context is an empty list, not an error', async () => {
    expect(await client.listByContext(ep(), 'nope', opts)).toEqual({ kind: 'tasks', tasks: [], totalSize: 0 });
  });

  test('tasks/list maps auth, unreachable and unexpected statuses', async () => {
    expect(await client.listByContext({ url: server.url, token: 'bad' }, 'c', opts)).toEqual({ kind: 'auth' });
    server.listStatus500 = true;
    expect(await client.listByContext(ep(), 'c', opts)).toMatchObject({ kind: 'error' });
  });

  test('tasks/get reports a running task as accepted/working, then the terminal result', async () => {
    server.plan = () => ({ kind: 'drop', finishAfterMs: 60, text: 'done later' });
    await send('x', 'ctx-get');
    const id = [...server.tasks.keys()][0]!;
    expect(await client.get(ep(), id, opts)).toMatchObject({ kind: 'accepted', phase: 'working', taskId: id });
    await new Promise((r) => setTimeout(r, 120));
    expect(await client.get(ep(), id, opts)).toMatchObject({ kind: 'completed', text: 'done later' });
  });

  test('tasks/subscribe re-attaches to a running task and reads the final result', async () => {
    server.plan = () => ({ kind: 'drop', finishAfterMs: 80, text: '{"ok":true}' });
    await send('x', 'ctx-sub');
    const id = [...server.tasks.keys()][0]!;
    const o = await client.subscribe(ep(), id, { timeoutMs: 3_000 });
    expect(o).toMatchObject({ kind: 'completed', text: '{"ok":true}', taskId: id });
  });

  test('tasks/subscribe on an already-failed task returns the failure text', async () => {
    server.plan = () => ({ kind: 'reply', state: 'failed', text: '[agent did not reply in time]' });
    await send('x', 'ctx-sub2');
    const id = [...server.tasks.keys()][0]!;
    expect(await client.subscribe(ep(), id, opts)).toMatchObject({ kind: 'worker_failed', text: '[agent did not reply in time]' });
  });

  test('tasks/subscribe on an unknown task -> not_found; wrong token -> auth', async () => {
    expect(await client.subscribe(ep(), 'ghost', opts)).toEqual({ kind: 'not_found' });
    expect(await client.subscribe({ url: server.url, token: 'bad' }, 'ghost', opts)).toEqual({ kind: 'auth' });
  });

  test('worker restart (state loss): the task is gone -> not_found; list is empty', async () => {
    await send('x', 'ctx-restart');
    const id = [...server.tasks.keys()][0]!;
    server.restart();
    expect(await client.get(ep(), id, opts)).toEqual({ kind: 'not_found' });
    expect(await client.listByContext(ep(), 'ctx-restart', opts)).toMatchObject({ kind: 'tasks', tasks: [] });
  });

  test('tasks/cancel exists and reports the cancelled state', async () => {
    server.plan = () => ({ kind: 'drop', finishAfterMs: 5_000, text: 'never' });
    await send('x', 'ctx-cancel');
    const id = [...server.tasks.keys()][0]!;
    expect(await client.cancel(ep(), id, opts)).toMatchObject({ kind: 'cancelled' });
    expect(await client.cancel(ep(), 'ghost', opts)).toEqual({ kind: 'not_found' });
  });

  test('requests carry the bearer token and A2A version, and the token is not in recorded params', async () => {
    await send();
    expect(server.requests.every((r) => r.authorized)).toBe(true);
    expect(JSON.stringify(server.requests)).not.toContain(TOKEN);
  });
});
