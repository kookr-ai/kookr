import { afterEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { createApiAuthMiddleware } from '../auth.js';
import { createJsonRequestBodyLimitMiddleware } from './shared.js';
import { TaskStore } from '../../core/tasks.js';
import { registerDictationCorpusRoutes } from './dictation-corpus-routes.js';

const recordId = '87d3e32a-e48e-4c7b-8518-d9b4294b57dc';
const submissionId = '5b7ee799-01a1-4e23-8e92-f049cbdd3b5d';
const capabilities = { schemaVersion: 1, supported: true, enabled: true };
function app(sttUrl: string | undefined = 'ws://127.0.0.1:4000/stt', taskStore = new TaskStore()) {
  const result = new Hono();
  registerDictationCorpusRoutes(result, { sttUrl, taskStore });
  return result;
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('dictation corpus bridge', () => {
  test('disabled and invalid endpoints do not make network requests', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const disabled = await app('').request('/api/stt/corpus/capabilities');
    expect(await disabled.json()).toMatchObject({ supported: false, enabled: false, reason: 'disabled' });
    const invalid = await app('http://169.254.169.254/').request('/api/stt/corpus/capabilities');
    expect(await invalid.json()).toMatchObject({ supported: false, reason: 'invalid-stt-url' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('refuses to send private text when an external service has no corpus capability', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const response = await app().request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'review', correction: 'private text' }),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ reason: 'unsupported' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  test('uses the configured origin, strips browser headers and bounds pagination', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(capabilities));
    vi.stubGlobal('fetch', fetch);
    const response = await app('wss://speech.example.test/private?secret=1').request('/api/stt/corpus/records?offset=10&limit=5', {
      headers: { Origin: 'http://kookr.test', Authorization: 'Bearer secret' },
    });
    expect(response.status).toBe(200);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://speech.example.test/corpus/capabilities',
      'https://speech.example.test/corpus/records?offset=10&limit=5',
    ]);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'error', headers: { 'x-kookr-corpus': '1' } });
    expect(fetch.mock.calls[1]?.[1].headers).not.toHaveProperty('Origin');
    expect((await app().request('/api/stt/corpus/records?limit=201')).status).toBe(400);
  });

  test('archive pending status survives the bridge and mutation responses are never cached', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(Response.json({ error: 'corpus_pending' }, { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    const response = await app().request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'submission', submittedText: 'candidate only' }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'corpus_pending' });
  });

  test('rejects overlarge bodies, arbitrary routes, invalid identifiers and arbitrary task associations', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(capabilities));
    vi.stubGlobal('fetch', fetch);
    const server = app();
    expect((await server.request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', body: 'x'.repeat(128 * 1024 + 1),
    })).status).toBe(413);
    expect((await server.request('/api/stt/corpus/anything')).status).toBe(404);
    expect((await server.request('/api/stt/corpus/records/not-a-uuid')).status).toBe(400);
    expect((await server.request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', body: JSON.stringify({ kind: 'task', submissionId, taskId: 'some-other-task' }),
    })).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('retrieves only explicit task receipts after store reload and allows that association', async () => {
    const original = new TaskStore();
    const task = original.createTask('same prompt is not evidence', '/tmp');
    original.recordDictationSubmission(task.id, submissionId);
    const store = new TaskStore();
    store.loadTasks(original.getAllTasks());
    const fetch = vi.fn().mockImplementation(async () => Response.json(capabilities));
    vi.stubGlobal('fetch', fetch);
    const server = app(undefined, store);
    const lookup = await server.request(`/api/stt/corpus/submissions/${submissionId}/task`);
    expect(await lookup.json()).toEqual({ taskId: task.id });
    expect(fetch).not.toHaveBeenCalled();
    const annotation = await server.request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', body: JSON.stringify({ kind: 'task', submissionId, taskId: task.id }),
    });
    expect(annotation.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('does not redirect or disclose upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('http://private-host/token=secret')));
    const result = await app().request('/api/stt/corpus/capabilities');
    expect(await result.text()).not.toContain('private-host');
    expect(result.status).toBe(503);
  });
});


describe('corpus transport security and bounds', () => {
  test('the dashboard auth gate rejects unauthenticated readers, viewers, and cross-origin writes', async () => {
    const server = new Hono();
    server.use('*', createApiAuthMiddleware({
      required: true, token: 'owner-token',
      resolveViewer: () => ({ kind: 'valid', grantId: 'viewer', scope: { kind: 'all' } }),
    }));
    registerDictationCorpusRoutes(server, { taskStore: new TaskStore() });
    expect((await server.request('/api/stt/corpus/records')).status).toBe(401);
    expect((await server.request('/api/stt/corpus/records', { headers: { Authorization: 'Bearer viewer-token' } })).status).toBe(403);
    const local = new Hono();
    local.use('*', createApiAuthMiddleware({ required: false }));
    registerDictationCorpusRoutes(local, { taskStore: new TaskStore() });
    expect((await local.request(`/api/stt/corpus/records/${recordId}`, {
      method: 'DELETE', headers: { Origin: 'http://evil.example', Host: 'localhost' },
    })).status).toBe(403);
  });

  test('the standard body-limit middleware still permits bounded annotations', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json(capabilities));
    vi.stubGlobal('fetch', fetch);
    const server = new Hono();
    server.use('/api/*', createJsonRequestBodyLimitMiddleware(1024 * 1024));
    registerDictationCorpusRoutes(server, { sttUrl: 'ws://localhost:4000', taskStore: new TaskStore() });
    const response = await server.request(`/api/stt/corpus/records/${recordId}/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'review' }),
    });
    expect(response.status).toBe(200);
    expect(fetch.mock.calls[1]?.[1].body).toBe(JSON.stringify({ kind: 'review' }));
  });

  test('deadline aborts a hanging upstream without exposing its error', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private upstream details')));
    }));
    vi.stubGlobal('fetch', fetch);
    const pending = app().request('/api/stt/corpus/capabilities');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(10_001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'corpus_unavailable' });
  });

  test('upstream response sizes are enforced independently of Content-Length', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(new Response(new Uint8Array(16 * 1024 * 1024 + 1), { headers: { 'Content-Length': '1' } }));
    vi.stubGlobal('fetch', fetch);
    const response = await app().request('/api/stt/corpus/export');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'corpus_response_too_large' });
  });
});


describe('corpus playback formats', () => {
  test.each(['audio/flac', 'audio/aac'])('preserves %s archive bytes and type for playback', async (contentType) => {
    const bytes = Uint8Array.from([0x66, 0x4c, 0x61, 0x43, 0xff, 0x00, 0x80]);
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(new Response(bytes, { headers: { 'Content-Type': contentType } }));
    vi.stubGlobal('fetch', fetch);
    const response = await app().request(`/api/stt/corpus/records/${recordId}/audio`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(contentType);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test('continues rejecting active content returned by an upstream audio endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json(capabilities))
      .mockResolvedValueOnce(new Response('<script>private()</script>', { headers: { 'Content-Type': 'text/html' } })));
    const response = await app().request(`/api/stt/corpus/records/${recordId}/audio`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'corpus_invalid_response' });
  });
});
