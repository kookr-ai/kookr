// @vitest-environment jsdom

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetAuthSessionForTests,
  bootstrapAuthSession,
  createCsrfFetch,
  getCsrfToken,
  isSameOriginApiUrl,
  parseFragmentToken,
} from './auth-session.js';

describe('parseFragmentToken', () => {
  test('extracts #token=… (with and without leading #, among other params)', () => {
    expect(parseFragmentToken('#token=abc123')).toBe('abc123');
    expect(parseFragmentToken('token=abc123')).toBe('abc123');
    expect(parseFragmentToken('#token=abc&foo=bar')).toBe('abc');
  });

  test('returns null when absent/empty', () => {
    expect(parseFragmentToken('')).toBeNull();
    expect(parseFragmentToken(undefined)).toBeNull();
    expect(parseFragmentToken('#foo=bar')).toBeNull();
    expect(parseFragmentToken('#token=')).toBeNull();
  });
});

describe('isSameOriginApiUrl', () => {
  const origin = 'https://lan.example';
  test('matches relative + absolute same-origin /api paths', () => {
    expect(isSameOriginApiUrl('/api/tasks', origin)).toBe(true);
    expect(isSameOriginApiUrl('https://lan.example/api/tasks', origin)).toBe(true);
  });
  test('rejects non-/api and cross-origin', () => {
    expect(isSameOriginApiUrl('/assets/x.js', origin)).toBe(false);
    expect(isSameOriginApiUrl('https://evil.example/api/tasks', origin)).toBe(false);
  });
});

describe('createCsrfFetch', () => {
  const origin = 'https://lan.example';

  test('adds X-Kookr-CSRF to mutating same-origin /api requests', async () => {
    const orig = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const wrapped = createCsrfFetch(orig, () => 'nonce-123', origin);
    await wrapped('/api/tasks', { method: 'POST' });
    const init = (orig as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('x-kookr-csrf')).toBe('nonce-123');
  });

  test('does not add the header on GET or cross-origin or when no nonce', async () => {
    const orig = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const m = orig as unknown as ReturnType<typeof vi.fn>;

    const withNonce = createCsrfFetch(orig, () => 'nonce', origin);
    await withNonce('/api/tasks', { method: 'GET' });
    expect(new Headers((m.mock.calls[0][1] as RequestInit)?.headers).get('x-kookr-csrf')).toBeNull();

    await withNonce('https://evil.example/api/tasks', { method: 'POST' });
    expect(new Headers((m.mock.calls[1][1] as RequestInit)?.headers).get('x-kookr-csrf')).toBeNull();

    const noNonce = createCsrfFetch(orig, () => null, origin);
    await noNonce('/api/tasks', { method: 'POST' });
    expect(new Headers((m.mock.calls[2][1] as RequestInit)?.headers).get('x-kookr-csrf')).toBeNull();
  });

  test('does not clobber an explicit X-Kookr-CSRF header', async () => {
    const orig = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    const wrapped = createCsrfFetch(orig, () => 'auto', origin);
    await wrapped('/api/tasks', { method: 'POST', headers: { 'x-kookr-csrf': 'explicit' } });
    const init = (orig as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('x-kookr-csrf')).toBe('explicit');
  });
});

describe('bootstrapAuthSession', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    __resetAuthSessionForTests();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('exchanges a fragment token, holds the nonce, and clears the fragment', async () => {
    window.history.replaceState(null, '', '/#token=raw-token-xyz');
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('/api/auth/session');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ token: 'raw-token-xyz' });
      return new Response(JSON.stringify({ ok: true, actor: 'owner', csrfToken: 'nonce-abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    window.fetch = fetchMock as unknown as typeof fetch;

    await bootstrapAuthSession();

    expect(getCsrfToken()).toBe('nonce-abc');
    expect(window.location.hash).toBe('');
    expect(window.sessionStorage.getItem('kookr.session.csrf')).toBe('nonce-abc');
  });

  test('no fragment ⇒ no exchange; rehydrates nonce from sessionStorage', async () => {
    window.sessionStorage.setItem('kookr.session.csrf', 'persisted-nonce');
    const fetchMock = vi.fn();
    window.fetch = fetchMock as unknown as typeof fetch;

    await bootstrapAuthSession();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCsrfToken()).toBe('persisted-nonce');
  });

  test('clears stale kookr localStorage on a session switch', async () => {
    window.sessionStorage.setItem('kookr.session.fingerprint', 'old-session');
    window.localStorage.setItem('kookr.someCache', 'stale');
    window.localStorage.setItem('unrelated', 'keep');
    window.history.replaceState(null, '', '/#token=new');
    window.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, actor: 'owner', csrfToken: 'new-session' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    await bootstrapAuthSession();

    expect(window.localStorage.getItem('kookr.someCache')).toBeNull();
    expect(window.localStorage.getItem('unrelated')).toBe('keep');
    expect(window.sessionStorage.getItem('kookr.session.fingerprint')).toBe('new-session');
  });

  test('clears the fragment and holds no nonce when the exchange fails', async () => {
    window.history.replaceState(null, '', '/#token=bad');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.fetch = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;

    await bootstrapAuthSession();

    expect(window.location.hash).toBe('');
    expect(getCsrfToken()).toBeNull();
    expect(window.sessionStorage.getItem('kookr.session.csrf')).toBeNull();
  });

  test('does not double-wrap window.fetch when bootstrapped twice', async () => {
    window.sessionStorage.setItem('kookr.session.csrf', 'n');
    const base = vi.fn(async () => new Response('ok')) as unknown as typeof fetch;
    window.fetch = base;

    await bootstrapAuthSession();
    const afterFirst = window.fetch;
    await bootstrapAuthSession();
    const afterSecond = window.fetch;

    // First bootstrap wraps once; the second is a no-op (same wrapper reference).
    expect(afterFirst).not.toBe(base);
    expect(afterSecond).toBe(afterFirst);
  });
});
