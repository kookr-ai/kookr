import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError, apiFetch, fetchJson, fetchResult, getJson } from './client.js';

function mockFetch(impl: (path: string, init?: RequestInit) => Partial<Response> & { json?: () => Promise<unknown> }) {
  const spy = vi.fn((path: string, init?: RequestInit) => Promise.resolve(impl(path, init) as Response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  test('forwards a bare GET as a single argument', async () => {
    const spy = mockFetch(() => jsonResponse({}));
    await apiFetch('/api/thing');
    expect(spy).toHaveBeenCalledWith('/api/thing');
  });

  test('forwards init when provided', async () => {
    const spy = mockFetch(() => jsonResponse({}));
    const init = { method: 'POST' };
    await apiFetch('/api/thing', init);
    expect(spy).toHaveBeenCalledWith('/api/thing', init);
  });
});

describe('getJson', () => {
  test('returns the parsed body on 2xx', async () => {
    mockFetch(() => jsonResponse({ hello: 'world' }));
    await expect(getJson<{ hello: string }>('/api/x')).resolves.toEqual({ hello: 'world' });
  });

  test('throws ApiError carrying status and parsed error body on non-2xx', async () => {
    mockFetch(() => jsonResponse({ error: 'nope' }, { ok: false, status: 503 }));
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).message).toBe('HTTP 503');
    expect((err as ApiError).body).toEqual({ error: 'nope' });
  });

  test('propagates an aborted fetch rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))));
    const err = await getJson('/api/x').catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
  });
});

describe('fetchResult', () => {
  test('returns status + parsed body without throwing on non-2xx', async () => {
    mockFetch(() => jsonResponse({ error: 'bad' }, { ok: false, status: 409 }));
    const result = await fetchResult<{ error?: string }>('/api/x');
    expect(result).toEqual({ ok: false, status: 409, body: { error: 'bad' } });
  });

  test('yields a null body when the response is not JSON', async () => {
    mockFetch(() => ({ ok: true, status: 200, json: () => Promise.reject(new Error('not json')) }));
    const result = await fetchResult('/api/x');
    expect(result).toEqual({ ok: true, status: 200, body: null });
  });
});

describe('fetchJson', () => {
  test('returns the status + parsed body envelope on 2xx', async () => {
    mockFetch(() => jsonResponse({ id: 7 }, { ok: true, status: 201 }));
    await expect(fetchJson<{ id: number }>('/api/x')).resolves.toEqual({
      ok: true,
      status: 201,
      body: { id: 7 },
    });
  });

  test('rejects when the body is not JSON (strict parse)', async () => {
    mockFetch(() => ({ ok: false, status: 500, json: () => Promise.reject(new Error('boom')) }));
    await expect(fetchJson('/api/x')).rejects.toThrow('boom');
  });
});
