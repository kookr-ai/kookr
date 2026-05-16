// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
});
