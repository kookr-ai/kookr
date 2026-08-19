// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { getDefaultShortcutBindings } from '../../shared/contracts/shortcut-bindings.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({
  ActivityPanel: ({ onOpenDiff }: { onOpenDiff?: (target: { toolUseId: string; filePath: string }) => void }) => React.createElement(
    'div',
    { 'data-testid': 'activity-panel' },
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => onOpenDiff?.({ toolUseId: 'tool-1', filePath: '/tmp/example.ts' }),
      },
      'Open diff',
    ),
  ),
}));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({
  TerminalPanel: ({ visible }: { visible?: boolean }) => React.createElement('div', {
    'data-testid': 'terminal-panel',
    'data-visible': String(Boolean(visible)),
  }),
}));
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

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Implement GitHub Issue',
    events: [],
    anomaly: {
      type: 'needs_input',
      severity: 'info',
      explanation: 'Agent is waiting for input.',
      detectedAt: '2026-05-09T00:00:00.000Z',
    },
    agentType: 'codex-cli',
    cwd: '/home/jean/git/kookr',
    projectDisplayLabel: 'kookr',
    projectId: 'kookr-ai/kookr',
    gitBranch: 'main',
    gitIsWorktree: false,
    worktreeHealth: 'missing',
    startedAt: '2026-05-09T00:00:00.000Z',
    taskStatus: 'inProgress',
    tokenUsage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.42 },
    ...overrides,
  } as AgentState;
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

function renderFocusedDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
        terminalFocusMode: true,
      }),
    );
  });
  return root;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('DetailPanel dense metadata', () => {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test('keeps critical task state in the header and moves repeated metadata into details', () => {
    root = renderDetailPanel(container, makeAgent());

    const header = container.querySelector('.detail-header')!;
    expect(header.querySelector('h2')?.textContent).toBe('Implement GitHub Issue');
    expect(header.querySelector('.detail-header-warning')?.textContent).toBe('worktree missing');
    expect(header.querySelector('.detail-badge.input')?.textContent).toBe('NEEDS INPUT');

    expect(header.querySelector('.detail-header-right > .project-badge')).toBeNull();
    expect(header.querySelector('.detail-header-right > .detail-agent-type-group')).toBeNull();
    expect(header.querySelector('.detail-header-right > .detail-branch')).toBeNull();

    const metaMenu = header.querySelector('.detail-meta-menu')!;
    expect(metaMenu.querySelector('.detail-agent-provider--codex-cli')?.textContent).toContain('Codex CLI');
    expect(metaMenu.querySelector('.project-badge')?.textContent).toBe('kookr');
    expect(metaMenu.querySelector('.detail-branch')?.textContent).toContain('main');
    expect(metaMenu.textContent).toContain('$0.42');
    expect(metaMenu.textContent).toContain('1.5k tok');
  });

  test('shows $X.XX/h on the Cost row when the session is older than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T11:00:00.000Z'));
    root = renderDetailPanel(container, makeAgent({
      startedAt: '2026-06-11T10:00:00.000Z',
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 4,
      },
    }));
    expect(container.querySelector('.detail-cost')?.textContent).toBe('$4.00 · $4.00/h');
  });

  test('omits the Cost-row rate for a session younger than two minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:01:00.000Z'));
    root = renderDetailPanel(container, makeAgent({
      startedAt: '2026-06-11T10:00:00.000Z',
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 4,
      },
    }));
    expect(container.querySelector('.detail-cost')?.textContent).toBe('$4.00');
  });

  test('shows an estimated badge on the Cost row when pricingQuality is fallback', () => {
    root = renderDetailPanel(container, makeAgent({
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.42,
        pricingQuality: 'fallback',
      },
    }));
    const badge = container.querySelector('.pricing-fallback-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('estimated');
    expect(badge?.getAttribute('title')?.toLowerCase()).toContain('fallback');
  });

  test('omits the estimated badge when pricingQuality is exact', () => {
    root = renderDetailPanel(container, makeAgent({
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.42,
        pricingQuality: 'exact',
      },
    }));
    expect(container.querySelector('.pricing-fallback-badge')).toBeNull();
  });

  test('omits the estimated badge when pricingQuality is absent (legacy records)', () => {
    root = renderDetailPanel(container, makeAgent({
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.42,
      },
    }));
    expect(container.querySelector('.pricing-fallback-badge')).toBeNull();
  });

  test('terminal focus mode removes secondary detail chrome while keeping terminal active', () => {
    root = renderFocusedDetailPanel(container, makeAgent());

    expect(container.querySelector('.detail-panel.terminal-focus')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible')).toBe('true');
    expect(container.querySelector('.detail-split-left')).toBeNull();
    expect(container.querySelector('.detail-tabs-narrow')).toBeNull();
    expect(container.querySelector('[data-testid="task-dependencies"]')).toBeNull();
  });

  test('narrow detail tabs expose the active pane with aria-pressed', () => {
    useKookrStore.getState().handleGitHubUpdate('task-1', [], [
      {
        ref: {
          type: 'issue',
          owner: 'kookr-ai',
          repo: 'kookr',
          number: 1257,
          url: 'https://github.com/kookr-ai/kookr/issues/1257',
          detectedAt: new Date('2026-07-03T00:00:00.000Z'),
          detectedFrom: 'test',
          taskId: 'task-1',
        },
        title: 'Narrow tab accessibility',
        status: 'open',
        author: 'jeanibarz',
        labels: [],
        commentCount: 0,
        lastFetchedAt: new Date('2026-07-03T00:00:00.000Z'),
      },
    ], []);
    root = renderDetailPanel(container, makeAgent());

    const tabs = [...container.querySelectorAll<HTMLButtonElement>('.detail-tabs-narrow .detail-tab')];
    const activity = tabs.find((tab) => tab.textContent === 'Activity');
    const terminal = tabs.find((tab) => tab.textContent === 'Terminal');
    const github = tabs.find((tab) => tab.textContent === 'GitHub (1)');

    expect(activity?.getAttribute('aria-pressed')).toBe('true');
    expect(terminal?.getAttribute('aria-pressed')).toBe('false');
    expect(github?.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      terminal?.click();
    });

    expect(activity?.getAttribute('aria-pressed')).toBe('false');
    expect(terminal?.getAttribute('aria-pressed')).toBe('true');
    expect(github?.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      github?.click();
    });

    expect(activity?.getAttribute('aria-pressed')).toBe('false');
    expect(terminal?.getAttribute('aria-pressed')).toBe('false');
    expect(github?.getAttribute('aria-pressed')).toBe('true');
  });

  test('left-only detail pane mode hides terminal chrome and keeps a restore control visible', () => {
    useKookrStore.getState().setDetailPaneMode('left');
    root = renderDetailPanel(container, makeAgent());

    expect(container.querySelector('.detail-panel.detail-left-only')).not.toBeNull();
    expect(container.querySelector('.detail-split-left')).not.toBeNull();
    expect(container.querySelector('.detail-split-right')?.className).toContain('pane-hidden-wide');
    expect(container.querySelector('[data-testid="activity-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible')).toBe('false');

    const restore = container.querySelector<HTMLButtonElement>('button[aria-label="Show terminal/diff pane"]');
    expect(restore).not.toBeNull();
    act(() => {
      restore!.click();
    });

    expect(useKookrStore.getState().detailPaneMode).toBe('split');
  });

  test('right-only detail pane mode hides activity chrome and restores split mode from the persistent control', () => {
    useKookrStore.getState().setDetailPaneMode('right');
    root = renderDetailPanel(container, makeAgent());

    expect(container.querySelector('.detail-panel.terminal-focus')).not.toBeNull();
    expect(container.querySelector('.detail-split-left')).toBeNull();
    expect(container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible')).toBe('true');

    const restore = container.querySelector<HTMLButtonElement>('button[aria-label="Show Activity/GitHub pane"]');
    expect(restore).not.toBeNull();
    act(() => {
      restore!.click();
    });

    expect(useKookrStore.getState().detailPaneMode).toBe('split');
  });

  test('right-only diff mode keeps hidden terminal inactive', async () => {
    root = renderDetailPanel(container, makeAgent());

    const openDiff = container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button');
    expect(openDiff).not.toBeNull();
    act(() => {
      openDiff!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();

    act(() => {
      useKookrStore.getState().setDetailPaneMode('right');
    });
    await flush();

    expect(container.querySelector('.detail-panel.terminal-focus')).not.toBeNull();
    expect(container.querySelector('.detail-split-left')).toBeNull();
    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible')).toBe('false');
  });

  test('empty state shortcut hint uses provided bindings', () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        React.createElement(DetailPanel, {
          agent: null,
          send: vi.fn(() => true),
          onLaunch: vi.fn(),
          onRequestComplete: vi.fn(),
          shortcutBindings: getDefaultShortcutBindings('mac'),
        }),
      );
    });

    expect(container.querySelector('.detail-empty-hint')?.textContent).toContain('Cmd+Ctrl+L quick launch');
  });
});
