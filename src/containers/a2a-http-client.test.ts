import { describe, expect, test } from 'vitest';
import { A2aHttpClient, mapA2aState } from './a2a-http-client.js';

function fake(routes: Record<string, unknown | ((init: any) => unknown)>) {
  const seen: Array<{ url: string; init: any }> = [];
  const f = async (url: string, init: any) => {
    seen.push({ url, init });
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    if (!(key in routes)) return { ok: false, status: 404, json: async () => ({}) };
    const r = routes[key];
    return { ok: true, status: 200, json: async () => (typeof r === 'function' ? r(init) : r) };
  };
  return { client: new A2aHttpClient(f as never), seen };
}

describe('A2aHttpClient', () => {
  test('maps wire states, unknown -> UNKNOWN', () => {
    expect(mapA2aState('TASK_STATE_WORKING')).toBe('WORKING');
    expect(mapA2aState('TASK_STATE_CANCELED')).toBe('CANCELED');
    expect(mapA2aState('weird')).toBe('UNKNOWN');
    expect(mapA2aState(undefined)).toBe('UNKNOWN');
  });

  test('sendMessage posts returnImmediately with bearer and optional contextId', async () => {
    const { client, seen } = fake({ 'POST /message:send': { task: { id: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } } } });
    const r = await client.sendMessage('http://127.0.0.1:9', 'tok', { text: 'hi', contextId: 'c0' }, 1000);
    expect(r).toEqual({ taskId: 't1', contextId: 'c1', state: 'WORKING' });
    const body = JSON.parse(seen[0]!.init.body);
    expect(body.configuration.returnImmediately).toBe(true);
    expect(body.message.contextId).toBe('c0');
    expect(body.message.parts).toEqual([{ text: 'hi' }]);
    expect(seen[0]!.init.headers.authorization).toBe('Bearer tok');
  });

  test('cancelTask re-reads the task after cancelling (F5): CANCELED then FAILED reads FAILED', async () => {
    let reads = 0;
    const { client } = fake({
      'POST /tasks/t1:cancel': { id: 't1', status: { state: 'TASK_STATE_CANCELED' } },
      'GET /tasks/t1': () => (++reads, { id: 't1', status: { state: 'TASK_STATE_FAILED' } }),
    });
    expect(await client.cancelTask('http://127.0.0.1:9', 'tok', 't1', 1000)).toBe('FAILED');
    expect(reads).toBe(1);
  });

  test('cancelTask rejects a task id that is not a plain id (path injection)', async () => {
    const { client, seen } = fake({});
    await expect(client.cancelTask('http://127.0.0.1:9', 'tok', '../x', 1000)).rejects.toThrow('invalid a2a task id');
    expect(seen).toHaveLength(0);
  });

  test('currentTask prefers the working task; none -> undefined', async () => {
    const { client } = fake({ 'GET /tasks': { tasks: [{ id: 'a', status: { state: 'TASK_STATE_COMPLETED' } }, { id: 'b', status: { state: 'TASK_STATE_WORKING' } }, { id: 'c', status: { state: 'TASK_STATE_CANCELED' } }] } });
    expect(await client.currentTask('http://x', 't', 100)).toEqual({ taskId: 'b', state: 'WORKING' });
    const empty = fake({ 'GET /tasks': { tasks: [] } });
    expect(await empty.client.currentTask('http://x', 't', 100)).toBeUndefined();
    expect(await empty.client.taskState('http://x', 't', 100)).toBe('UNKNOWN');
  });

  test('non-2xx rejects (probe counts it as a miss)', async () => {
    const { client } = fake({});
    await expect(client.taskState('http://127.0.0.1:9', 't', 100)).rejects.toThrow('HTTP 404');
  });
});
