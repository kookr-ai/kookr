// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TaskShareSummary } from '../../shared/contracts/remote-share.js';
import type { AgentState } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Shared task',
    events: [],
    anomaly: null,
    agentType: 'codex-cli',
    cwd: '/tmp/kookr',
    startedAt: '2026-05-17T12:00:00.000Z',
    taskStatus: 'inProgress',
  };
}

function share(overrides: Partial<TaskShareSummary> = {}): TaskShareSummary {
  return {
    invitationId: 'inv-1',
    taskId: 'task-1',
    createdAt: '2026-05-17T12:00:00.000Z',
    expiresAt: '2026-05-17T12:10:00.000Z',
    state: 'waiting',
    connectedViewerCount: 0,
    grants: ['view'],
    grantRequests: [],
    ...overrides,
  };
}

function renderDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
      }),
    );
  });
  return root;
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('DetailPanel share header status', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test.each([
    {
      shares: [share()],
      badge: 'Shared',
      title: 'Share status: active share link',
    },
    {
      shares: [share({ state: 'viewerConnected', connectedViewerCount: 1 })],
      badge: 'Viewer connected',
      title: 'Share status: viewer connected',
    },
    {
      shares: [share({
        state: 'viewerConnected',
        connectedViewerCount: 1,
        grantRequests: [{
          requestId: 'grant-req-1',
          invitationId: 'inv-1',
          requestedGrants: ['terminalInput'],
          status: 'pending',
          requestedAt: '2026-05-17T12:01:00.000Z',
          comment: 'Alice requested terminal input',
        }],
      })],
      badge: 'Approval requested',
      title: 'Share status: collaborator approval requested',
    },
  ])('renders $badge from fetched owner-safe share summaries', async ({ shares, badge, title }) => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url === '/api/share/task') return jsonResponse({ shares });
      throw new Error(`unexpected fetch ${String(url)}`);
    }));

    root = renderDetailPanel(container, makeAgent());
    await flush();

    const button = container.querySelector<HTMLButtonElement>('[data-testid="task-share-button"]');
    expect(button?.textContent).toContain('Share');
    expect(button?.textContent).toContain(badge);
    expect(button?.getAttribute('title')).toBe(title);
    expect(button?.getAttribute('aria-label')).toBe(title);
    expect(button?.textContent).not.toContain('Alice');
    expect(button?.textContent).not.toContain('grant-req-1');
  });

  test('keeps the plain share button when share status is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 409 })));

    root = renderDetailPanel(container, makeAgent());
    await flush();

    const button = container.querySelector<HTMLButtonElement>('[data-testid="task-share-button"]');
    expect(button?.textContent?.trim()).toBe('Share');
    expect(button?.getAttribute('title')).toBe('Share this task');
  });
});
