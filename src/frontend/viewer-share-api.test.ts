// @vitest-environment jsdom

import { describe, test, expect, vi, afterEach } from 'vitest';

import { createViewerLink, listViewerLinks, revokeViewerLink } from './viewer-share-api.js';

function mockFetch(impl: (url: string, init?: RequestInit) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => impl(String(input), init)),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewer-share-api', () => {
  test('createViewerLink POSTs label + all-scope and returns the created link', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    mockFetch((url, init) => {
      captured = { url, init };
      return jsonResponse(
        { grant: { id: 'g1', label: 'Alice', scope: { kind: 'all' }, createdAt: 'now' }, token: 'tok', handoffUrl: 'https://h/#token=tok' },
        201,
      );
    });

    const created = await createViewerLink({ label: 'Alice' });
    expect(created.token).toBe('tok');
    expect(created.handoffUrl).toContain('#token=tok');
    expect(captured!.url).toBe('/api/share/viewers');
    expect(captured!.init?.method).toBe('POST');
    expect(JSON.parse(String(captured!.init?.body))).toEqual({ label: 'Alice', scope: { kind: 'all' } });
  });

  test('createViewerLink POSTs a projects scope + expiry when provided (#811)', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    mockFetch((url, init) => {
      captured = { url, init };
      return jsonResponse(
        {
          grant: { id: 'g2', label: 'Bob', scope: { kind: 'projects', projectIds: ['p1'] }, createdAt: 'now', expiresAt: '2030-01-01T00:00:00.000Z' },
          token: 'tok2',
          handoffUrl: 'https://h/#token=tok2',
        },
        201,
      );
    });

    await createViewerLink({
      label: 'Bob',
      scope: { kind: 'projects', projectIds: ['p1'] },
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(String(captured!.init?.body))).toEqual({
      label: 'Bob',
      scope: { kind: 'projects', projectIds: ['p1'] },
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  test('listViewerLinks GETs the roster + grants', async () => {
    mockFetch(() => jsonResponse({ grants: [{ id: 'g1' }], roster: [] }));
    const data = await listViewerLinks();
    expect(data.grants).toHaveLength(1);
    expect(data.roster).toEqual([]);
  });

  test('revokeViewerLink POSTs to the revoke route with the encoded id', async () => {
    let capturedUrl = '';
    mockFetch((url) => {
      capturedUrl = url;
      return jsonResponse({ ok: true });
    });
    await revokeViewerLink('a b/c');
    expect(capturedUrl).toBe('/api/share/viewers/a%20b%2Fc/revoke');
  });

  test('surfaces the server error message on a non-2xx response (create)', async () => {
    mockFetch(() => jsonResponse({ error: 'empty-scope', message: 'needs a project' }, 400));
    await expect(createViewerLink({ label: 'x' })).rejects.toThrow('needs a project');
  });

  test('listViewerLinks throws the server error on a non-2xx response', async () => {
    mockFetch(() => jsonResponse({ error: 'forbidden' }, 403));
    await expect(listViewerLinks()).rejects.toThrow('forbidden');
  });

  test('revokeViewerLink throws the server error on a non-2xx response', async () => {
    mockFetch(() => jsonResponse({ error: 'grant-not-found' }, 404));
    await expect(revokeViewerLink('g1')).rejects.toThrow('grant-not-found');
  });

  test('falls back to a status-based message when the body has no error field', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));
    await expect(listViewerLinks()).rejects.toThrow('Request failed (500)');
  });
});
