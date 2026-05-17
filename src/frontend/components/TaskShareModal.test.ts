// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RELAY_TRUSTED_ENV_NAME } from '../../remote/handshake.js';
import { TaskShareModal } from './TaskShareModal.js';

const TASK_ID = 'task-1';
const SHARE_ID = '123-456';
const PASSWORD = 'correct-horse-battery-staple';
const JOIN_URL = `http://localhost:4801/relay/join/${SHARE_ID}#password=${PASSWORD}`;

type ShareState = 'waiting' | 'viewerConnected' | 'revoked' | 'expired' | 'revokePending';

function renderModal(container: HTMLElement, props: Partial<React.ComponentProps<typeof TaskShareModal>> = {}): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(TaskShareModal, {
      taskId: 'task-1',
      taskLabel: 'Shared task',
      open: true,
      onClose: vi.fn(),
      ...props,
    }));
  });
  return root;
}

function rerenderModal(root: Root, props: Partial<React.ComponentProps<typeof TaskShareModal>> = {}) {
  act(() => {
    root.render(React.createElement(TaskShareModal, {
      taskId: 'task-1',
      taskLabel: 'Shared task',
      open: true,
      onClose: vi.fn(),
      ...props,
    }));
  });
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function shareSummary(state: ShareState = 'waiting') {
  return {
    invitationId: 'inv-copy',
    taskId: TASK_ID,
    createdAt: '2026-05-17T12:00:00.000Z',
    expiresAt: '2026-05-17T12:10:00.000Z',
    state,
    connectedViewerCount: 0,
    grants: ['view'],
    grantRequests: [],
  };
}

function createShareResponse() {
  return {
    share: shareSummary(),
    joinUrl: JOIN_URL,
    shareTicket: {
      shareId: SHARE_ID,
      password: PASSWORD,
      joinUrl: JOIN_URL,
      redactedShareLabel: SHARE_ID,
    },
  };
}

function stubCopyShareFetch(initialShares: unknown[] = []) {
  let shares = initialShares;
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (url === '/api/share/csrf-token') return jsonResponse({ csrfToken: 'csrf-share' });
    if (url === '/api/share/task' && init?.method === 'POST') {
      const response = createShareResponse();
      shares = [response.share];
      return jsonResponse(response);
    }
    if (url === '/api/share/task' && !init) return jsonResponse({ shares });
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  vi.stubGlobal('fetch', fetch);
  return {
    fetch,
    setShares(nextShares: unknown[]) {
      shares = nextShares;
    },
  };
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button;
}

function getButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  expect(button).toBeInstanceOf(HTMLButtonElement);
  return button;
}

function getInputForLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label'))
    .find((candidate) => candidate.textContent?.includes(labelText));
  const input = label?.querySelector('input');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

describe('TaskShareModal', () => {
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
    vi.useRealTimers();
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
              grants: ['view', 'terminalView', 'terminalInput'],
              grantRequests: [{
                requestId: 'grant-req-1',
                invitationId: 'inv-1',
                requestedGrants: ['terminalView', 'terminalInput'],
                status: 'approved',
                requestedAt: '2026-05-16T12:01:00.000Z',
                resolvedAt: '2026-05-16T12:02:00.000Z',
                resolution: 'approved',
              }],
            },
            request: {
              requestId: 'grant-req-1',
              invitationId: 'inv-1',
              requestedGrants: ['terminalView', 'terminalInput'],
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

    expect(container.textContent).toContain('Send messages');
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
    expect(container.textContent).toContain('Send messages');
  });

  test.each([
    ['revoked', 'Revoked'],
    ['expired', 'Expired'],
  ] as const)('renders %s shares as terminal owner state', async (state, label) => {
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
              expiresAt: new Date(Date.now() - 60_000).toISOString(),
              state,
              connectedViewerCount: 0,
              grants: ['view', 'terminalInput'],
              grantRequests: [{
                requestId: 'grant-req-1',
                invitationId: 'inv-1',
                requestedGrants: ['terminalInput'],
                status: 'pending',
                requestedAt: '2026-05-16T12:01:00.000Z',
                comment: 'Alice requested terminal input',
              }],
              terminalSharing: {
                state: 'blocked',
                reason: 'policySyncPending',
                message: 'Terminal sharing approval is syncing.',
                checkedAt: '2026-05-16T12:01:00.000Z',
              },
            }],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain('Create a new share to invite another collaborator.');
    expect(container.textContent).not.toContain('Link expires in');
    expect(container.textContent).not.toContain('Display label');
    expect(container.textContent).not.toContain('Approved grants');
    expect(container.textContent).not.toContain('Send messages');
    expect(container.textContent).not.toContain('Terminal sharing');
    expect(container.textContent).not.toContain('Approval syncing');
    expect(container.textContent).not.toContain('Alice requested terminal input');

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => ({ text: button.textContent?.trim(), disabled: button.disabled }));
    expect(buttons).toContainEqual({ text: 'Create new share', disabled: false });
    expect(buttons.some((button) => button.text === 'Revoke')).toBe(false);

    const createNewShare = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create new share');
    await act(async () => {
      createNewShare!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false);
    expect(container.textContent).toContain('No active share');
    expect(container.textContent).toContain('Link expires in');
    expect(container.textContent).toContain('Display label');
    expect(container.textContent).toContain('Create share link');
    expect(container.textContent).not.toContain('Approved grants');
    expect(container.textContent).not.toContain('Send messages');
    expect(container.textContent).not.toContain('Terminal sharing');
  });

  test('keeps new-share mode stable with multiple terminal shares', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return {
          ok: true,
          json: async () => ({
            shares: [
              {
                invitationId: 'inv-1',
                taskId: 'task-1',
                createdAt: '2026-05-16T12:00:00.000Z',
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
                state: 'revoked',
                connectedViewerCount: 0,
                grants: ['view', 'terminalInput'],
                grantRequests: [],
              },
              {
                invitationId: 'inv-2',
                taskId: 'task-1',
                createdAt: '2026-05-16T11:00:00.000Z',
                expiresAt: new Date(Date.now() - 120_000).toISOString(),
                state: 'expired',
                connectedViewerCount: 0,
                grants: ['view', 'terminalInput'],
                grantRequests: [],
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    const createNewShare = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create new share');
    await act(async () => {
      createNewShare!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('No active share');
    expect(container.textContent).toContain('Create share link');

    const listFetchesBeforePoll = fetchMock.mock.calls
      .filter(([url, init]) => url === '/api/share/task' && !init).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_050);
    });
    await flush();
    const listFetchesAfterPoll = fetchMock.mock.calls
      .filter(([url, init]) => url === '/api/share/task' && !init).length;

    expect(listFetchesAfterPoll).toBeGreaterThan(listFetchesBeforePoll);
    expect(container.textContent).toContain('No active share');
    expect(container.textContent).toContain('Create share link');
    expect(container.textContent).not.toContain('Revoked');
    expect(container.textContent).not.toContain('Expired');
  });

  test('resets new-share mode when the selected task changes', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      if (url === '/api/share/csrf-token') {
        return { ok: true, json: async () => ({ csrfToken: 'csrf-share' }) } as Response;
      }
      if (url === '/api/share/task' && !init) {
        return {
          ok: true,
          json: async () => ({
            shares: [
              {
                invitationId: 'inv-1',
                taskId: 'task-1',
                createdAt: '2026-05-16T12:00:00.000Z',
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
                state: 'revoked',
                connectedViewerCount: 0,
                grants: ['view'],
                grantRequests: [],
              },
              {
                invitationId: 'inv-2',
                taskId: 'task-2',
                createdAt: '2026-05-16T12:00:00.000Z',
                expiresAt: new Date(Date.now() - 60_000).toISOString(),
                state: 'expired',
                connectedViewerCount: 0,
                grants: ['view'],
                grantRequests: [],
              },
            ],
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    root = renderModal(container);
    await flush();

    const createNewShare = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.trim() === 'Create new share');
    await act(async () => {
      createNewShare!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('No active share');

    rerenderModal(root, { taskId: 'task-2', taskLabel: 'Second task' });
    await flush();

    expect(container.textContent).toContain('Second task');
    expect(container.textContent).toContain('Expired');
    expect(container.textContent).toContain('Create new share');
    expect(container.textContent).not.toContain('No active share');
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
                message: 'Terminal sharing is disabled for this node.',
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
    const remediationCodes = [...container.querySelectorAll('.task-share-remediation code')].map((element) => element.textContent);
    expect(remediationCodes).toEqual([`${RELAY_TRUSTED_ENV_NAME}=true`, 'pnpm prod:restart']);
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

  test('renders copy-safe controls and copies each generated credential value', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    stubCopyShareFetch();
    root = renderModal(container);
    await flush();

    await act(async () => {
      getButtonByText(container, 'Create share link').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain('Create share link');
    expect(getButtonByText(container, 'Copy share link').disabled).toBe(false);
    expect(getInputForLabel(container, 'Share ID').value).toBe(SHARE_ID);
    const passwordInput = getInputForLabel(container, 'Password');
    expect(passwordInput.value).toBe(PASSWORD);
    expect(passwordInput.type).toBe('password');

    await act(async () => {
      getButton(container, 'Show password').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(passwordInput.type).toBe('text');

    const ariaLabels = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => button.getAttribute('aria-label') ?? '');
    expect(ariaLabels).toEqual(expect.arrayContaining([
      'Copy Share ID',
      'Copy password',
      'Copy share link',
      'Copy share link from field',
      'Hide password',
    ]));
    expect(ariaLabels.join('\n')).not.toContain(SHARE_ID);
    expect(ariaLabels.join('\n')).not.toContain(PASSWORD);

    await act(async () => {
      getButton(container, 'Copy Share ID').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      getButton(container, 'Copy password').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      getButton(container, 'Copy share link from field').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      getButton(container, 'Copy share link').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(writeText).toHaveBeenNthCalledWith(1, SHARE_ID);
    expect(writeText).toHaveBeenNthCalledWith(2, PASSWORD);
    expect(writeText).toHaveBeenNthCalledWith(3, JOIN_URL);
    expect(writeText).toHaveBeenNthCalledWith(4, JOIN_URL);
  });

  test('hides generated credentials after the same share becomes revoked while polling', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const shareFetch = stubCopyShareFetch();
    root = renderModal(container);
    await flush();

    await act(async () => {
      getButtonByText(container, 'Create share link').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(getInputForLabel(container, 'Password').value).toBe(PASSWORD);

    shareFetch.setShares([shareSummary('revoked')]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flush();

    expect(container.textContent).not.toContain('Copy share link');
    expect(container.querySelector('[aria-label="Copy password"]')).toBeNull();
    expect(getButtonByText(container, 'Create new share').disabled).toBe(false);
  });

  test('reports fallback clipboard failures instead of marking a credential copied', async () => {
    vi.stubGlobal('navigator', {});
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });
    stubCopyShareFetch();
    root = renderModal(container);
    await flush();

    await act(async () => {
      getButtonByText(container, 'Create share link').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      getButton(container, 'Copy Share ID').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('Copy did not complete.');
    expect(container.textContent).not.toContain('Share ID copied.');
  });
});
