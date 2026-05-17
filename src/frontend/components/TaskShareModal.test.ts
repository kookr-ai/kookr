// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RELAY_TRUSTED_ENV_NAME } from '../../remote/handshake.js';
import { TaskShareModal } from './TaskShareModal.js';

function renderModal(container: HTMLElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(TaskShareModal, {
      taskId: 'task-1',
      taskLabel: 'Shared task',
      open: true,
      onClose: vi.fn(),
    }));
  });
  return root;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('TaskShareModal hosted relay errors', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test.each([
    ['hosted-relay-maintenance', 'Hosted relay is in maintenance mode. Local Kookr remains available.'],
    ['hosted-relay-emergency-disabled', 'Hosted relay sharing is temporarily disabled. Local Kookr remains available.'],
  ])('surfaces %s as a local-safe share creation error', async (errorCode, message) => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return { ok: true, json: async () => ({ shares: [] }) } as Response;
      }
      if (url === '/api/share/task' && init?.method === 'POST') {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: errorCode }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    root = renderModal(container);
    await flush();

    const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create share link');
    expect(create?.disabled).toBe(false);
    await act(async () => {
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain(message);
  });

  test('shows pending collaborator grant requests and sends owner approval', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return {
          ok: true,
          json: async () => ({
            shares: [{
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              state: 'viewerConnected',
              connectedViewerCount: 1,
              grants: ['view'],
              grantRequests: [{
                requestId: 'grant-req-1',
                invitationId: 'inv-1',
                requestedGrants: ['terminalInput'],
                status: 'pending',
                requestedAt: '2026-05-16T12:01:00.000Z',
                comment: 'Alice requested terminal input',
              }],
            }],
          }),
        } as Response;
      }
      if (url === '/api/share/task/inv-1/grant-requests/grant-req-1/approve' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            share: {
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              state: 'viewerConnected',
              connectedViewerCount: 1,
              grants: ['view', 'terminalInput'],
              grantRequests: [{
                requestId: 'grant-req-1',
                invitationId: 'inv-1',
                requestedGrants: ['terminalInput'],
                status: 'approved',
                requestedAt: '2026-05-16T12:01:00.000Z',
                resolvedAt: '2026-05-16T12:02:00.000Z',
                resolution: 'approved',
              }],
            },
            request: {
              requestId: 'grant-req-1',
              invitationId: 'inv-1',
              requestedGrants: ['terminalInput'],
              status: 'approved',
              requestedAt: '2026-05-16T12:01:00.000Z',
              resolvedAt: '2026-05-16T12:02:00.000Z',
              resolution: 'approved',
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    expect(container.textContent).toContain('Terminal input');
    expect(container.textContent).toContain('Alice requested terminal input');
    const approve = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Approve');
    await act(async () => {
      approve!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/share/task/inv-1/grant-requests/grant-req-1/approve',
      expect.objectContaining({
        method: 'POST',
        headers: { 'x-kookr-csrf': 'csrf-share' },
      }),
    );
    expect(container.textContent).toContain('Approved grants');
    expect(container.textContent).toContain('Terminal input');
  });

  test('surfaces terminal sharing trust remediation for owners', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return {
          ok: true,
          json: async () => ({
            shares: [{
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              state: 'viewerConnected',
              connectedViewerCount: 1,
              grants: ['view', 'terminalInput'],
              grantRequests: [],
              terminalSharing: {
                state: 'blocked',
                reason: 'nodeUntrusted',
                message: `Terminal sharing is disabled for this node. Set ${RELAY_TRUSTED_ENV_NAME}=true in /home/jean/git/kookr/.env and restart with pnpm prod:restart.`,
                checkedAt: '2026-05-16T12:01:00.000Z',
                remediation: {
                  kind: 'setEnvAndRestart',
                  envName: RELAY_TRUSTED_ENV_NAME,
                  expectedValue: 'true',
                  processValue: null,
                  diagnosedAt: '2026-05-16T12:01:00.000Z',
                  requiresRestart: false,
                  command: 'pnpm prod:restart',
                },
              },
            }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    root = renderModal(container);
    await flush();

    expect(container.textContent).toContain('Terminal sharing');
    expect(container.textContent).toContain('Disabled for this node');
    expect(container.textContent).toContain(`${RELAY_TRUSTED_ENV_NAME}=true`);
    expect(container.textContent).toContain('pnpm prod:restart');
  });

  test('offers preset link durations and defaults to 10 minutes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return { ok: true, json: async () => ({ shares: [] }) } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    root = renderModal(container);
    await flush();

    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    expect(Array.from(select!.options).map((option) => option.textContent)).toEqual([
      '10 minutes', '1 hour', '8 hours', '24 hours',
    ]);
    // Default stays the short-lived 10 minutes.
    expect(select!.value).toBe(String(10 * 60 * 1000));
  });

  test('creates a share with the chosen link duration', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return { ok: true, json: async () => ({ shares: [] }) } as Response;
      }
      if (url === '/api/share/task' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            share: {
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
              state: 'waiting',
              connectedViewerCount: 0,
              grants: ['view'],
              grantRequests: [],
            },
            joinUrl: 'http://relay.example/relay/join#inviteToken=tok',
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = String(8 * 60 * 60 * 1000);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create share link');
    await act(async () => {
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/share/task' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      taskId: 'task-1',
      ttlMs: 8 * 60 * 60 * 1000,
    });
  });

  test('shows long relay-advertised durations and sends an operator display label', async () => {
    const maxTtl = 31 * 24 * 60 * 60 * 1000;
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share', shareMaxTtlMs: maxTtl }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return { ok: true, json: async () => ({ shares: [], shareMaxTtlMs: maxTtl }) } as Response;
      }
      if (url === '/api/share/task' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            share: {
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + maxTtl).toISOString(),
              state: 'waiting',
              connectedViewerCount: 0,
              grants: ['view'],
              grantRequests: [],
            },
            joinUrl: 'http://relay.example/relay/join#inviteToken=tok',
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    const select = container.querySelector('select')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toContain('31 days');
    await act(async () => {
      select.value = String(maxTtl);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const labelInput = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
      .find((input) => input.placeholder === 'Shared task');
    await act(async () => {
      labelInput!.value = 'Review-safe label';
      labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('This share can expose the display label');

    const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create share link');
    await act(async () => {
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/share/task' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      taskId: 'task-1',
      ttlMs: maxTtl,
      displayLabel: 'Review-safe label',
    });
  });

  test('creates a share with the default 10-minute duration when the picker is untouched', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return { ok: true, json: async () => ({ shares: [] }) } as Response;
      }
      if (url === '/api/share/task' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            share: {
              invitationId: 'inv-1',
              taskId: 'task-1',
              createdAt: '2026-05-16T12:00:00.000Z',
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
              state: 'waiting',
              connectedViewerCount: 0,
              grants: ['view'],
              grantRequests: [],
            },
            joinUrl: 'http://relay.example/relay/join#inviteToken=tok',
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    // No interaction with the duration <select> — Create must still send the
    // 10-minute default, not a stale or hardcoded value.
    const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create share link');
    await act(async () => {
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/share/task' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      taskId: 'task-1',
      ttlMs: 10 * 60 * 1000,
    });
  });
});
