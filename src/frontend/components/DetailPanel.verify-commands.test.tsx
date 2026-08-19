// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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

/** Let the pane-open fetch resolve and React re-render. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function completedAgent(): AgentState {
  return {
    agentId: 'kookr-done',
    taskId: 'task-1',
    taskName: 'Verify task',
    events: [],
    anomaly: null,
    taskStatus: 'completed',
    cwd: '/repo',
    startedAt: '2026-06-11T12:00:00.000Z',
    // The terminal snapshot deliberately sheds verificationCommands; the pane
    // hydrates them from GET /api/tasks/:id, so the snapshot digest omits them.
    completionDigest: {
      bullets: ['Changed 1 file'],
      filesChanged: ['src/app.ts'],
    },
  };
}

/** Mock GET /api/tasks/:id to return a full digest with the given commands. */
function stubDetailFetch(verificationCommands: string[] | undefined) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      taskId: 'task-1',
      completionDigest: {
        bullets: ['Changed 1 file'],
        filesChanged: ['src/app.ts'],
        ...(verificationCommands ? { verificationCommands } : {}),
      },
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('DetailPanel verification commands', () => {
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
    vi.restoreAllMocks();
  });

  test('hydrates a "How to verify" list with a per-command copy button', async () => {
    const fetchMock = stubDetailFetch(['pnpm test detail', 'pnpm tsc --noEmit']);
    root = renderDetailPanel(container, completedAgent());

    // The existing digest renders immediately; the commands hydrate after the fetch.
    expect(container.querySelector('.detail-digest')?.textContent).toContain('Changed 1 file');
    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();

    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({ signal: expect.anything() }));

    const block = container.querySelector('[data-testid="verify-commands"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain('How to verify');

    const codes = block!.querySelectorAll('.detail-verify-commands-code');
    expect(codes.length).toBe(2);
    expect(codes[0]?.textContent).toBe('pnpm test detail');
    expect(codes[1]?.textContent).toBe('pnpm tsc --noEmit');

    const copyButtons = block!.querySelectorAll('.verify-command-copy');
    expect(copyButtons.length).toBe(2);
    expect(copyButtons[0]?.getAttribute('aria-label')).toBe('Copy command: pnpm test detail');
  });

  test('copy button writes the command to the clipboard', async () => {
    stubDetailFetch(['pnpm verify']);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    root = renderDetailPanel(container, completedAgent());
    await flush();

    const button = container.querySelector<HTMLButtonElement>('.verify-command-copy');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith('pnpm verify');
    // Visible + assistive-tech confirmation flips to "Copied".
    expect(button!.textContent).toBe('Copied');
    expect(button!.classList.contains('copied')).toBe(true);
    expect(button!.getAttribute('aria-label')).toBe('Copied command: pnpm verify');
  });

  test('renders nothing when there are no verification commands', async () => {
    stubDetailFetch(undefined);
    root = renderDetailPanel(container, completedAgent());
    await flush();

    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();
    // The existing digest still renders.
    expect(container.querySelector('.detail-digest')?.textContent).toContain('Changed 1 file');
  });

  test('a failed detail fetch does not break the completed pane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    root = renderDetailPanel(container, completedAgent());
    await flush();

    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();
    expect(container.querySelector('.detail-digest')?.textContent).toContain('Changed 1 file');
  });

  test('a non-ok HTTP response leaves the pane intact with no commands', async () => {
    // res.ok === false → json() is never read; the pane must not throw.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    root = renderDetailPanel(container, completedAgent());
    await flush();

    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();
    expect(container.querySelector('.detail-digest')?.textContent).toContain('Changed 1 file');
  });

  test('an { error } response body renders nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ error: 'not found' }) })));
    root = renderDetailPanel(container, completedAgent());
    await flush();

    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();
  });

  test('filters out non-string and blank command entries', async () => {
    // Defends against a malformed API payload — only real commands should render.
    stubDetailFetch(['', '   ', 'pnpm test', 42 as unknown as string, null as unknown as string]);
    root = renderDetailPanel(container, completedAgent());
    await flush();

    const codes = container.querySelectorAll('.detail-verify-commands-code');
    expect(codes.length).toBe(1);
    expect(codes[0]?.textContent).toBe('pnpm test');
  });

  test('switching taskId clears stale commands and hydrates the new task', async () => {
    // The fetch is keyed by taskId; the effect resets commands to [] on switch,
    // and the abort guard drops any late-resolving prior response.
    const byId: Record<string, string[]> = {
      'task-1': ['pnpm one'],
      'task-2': ['pnpm two'],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const id = url.split('/').pop()!;
      return {
        ok: true,
        json: async () => ({ taskId: id, completionDigest: { bullets: [], filesChanged: [], verificationCommands: byId[id] } }),
      };
    }));

    root = renderDetailPanel(container, { ...completedAgent(), taskId: 'task-1' });
    await flush();
    expect(container.querySelector('.detail-verify-commands-code')?.textContent).toBe('pnpm one');

    // Re-render with task-2 but do NOT flush the new fetch yet. The keyed
    // remount must drop task-1's commands on the very first frame — no stale
    // flash of 'pnpm one' on task-2's pane.
    act(() => {
      root!.render(
        React.createElement(DetailPanel, {
          agent: { ...completedAgent(), taskId: 'task-2' },
          send: vi.fn(() => true),
          onLaunch: vi.fn(),
          onRequestComplete: vi.fn(),
        }),
      );
    });
    expect(container.querySelector('[data-testid="verify-commands"]')).toBeNull();
    expect(container.textContent).not.toContain('pnpm one');

    await flush();

    const codes = container.querySelectorAll('.detail-verify-commands-code');
    expect(codes.length).toBe(1);
    expect(codes[0]?.textContent).toBe('pnpm two');
  });
});
