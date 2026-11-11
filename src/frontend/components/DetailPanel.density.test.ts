// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { getDefaultShortcutBindings } from '../../shared/contracts/shortcut-bindings.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

const terminalRender = vi.hoisted(() => vi.fn());

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
  TerminalPanel: (props: { visible?: boolean }) => {
    terminalRender(props);
    return React.createElement('div', {
    'data-testid': 'terminal-panel',
    'data-visible': String(Boolean(props.visible)),
    });
  },
}));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./TaskTimeline.js', () => ({ TaskTimeline: () => React.createElement('div', { 'data-testid': 'task-timeline' }) }));
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

  test('#3561 4b: the header carries one meta line and the facts column carries the metadata', () => {
    root = renderDetailPanel(container, makeAgent());

    const header = container.querySelector('.detail-header')!;
    expect(header.querySelector('h2')?.textContent).toBe('Implement GitHub Issue');
    expect(header.querySelector('.detail-header-warning')?.textContent).toBe('worktree missing');
    expect(header.querySelector('.detail-badge.input')?.textContent).toBe('NEEDS INPUT');

    // One meta line: project, branch and cost (the spike's frame), no popover.
    const meta = header.querySelector('[data-testid="detail-meta"]')!;
    expect(meta.textContent).toContain('kookr');
    expect(meta.textContent).toContain('main');
    expect(meta.textContent).toContain('$0.42');
    expect(header.querySelector('.detail-meta-menu, details')).toBeNull();
    expect(header.querySelector('.detail-agent-type-group')).toBeNull();

    const facts = container.querySelector('[data-testid="detail-facts"]')!;
    expect(facts.closest('.detail-header')).toBeNull();
    expect(facts.querySelector('.detail-agent-provider--codex-cli')?.textContent).toContain('Codex CLI');
    expect(facts.querySelector('.project-badge')?.textContent).toBe('kookr');
    expect(facts.querySelector('.detail-branch')?.textContent).toContain('main');
    expect(facts.textContent).toContain('$0.42');
    expect(facts.textContent).toContain('1.5k tok');
    // The Relationships row and the timestamp card moved here too.
    expect(facts.querySelector('[data-testid="task-dependencies"]')).not.toBeNull();
    expect(facts.querySelector('[data-testid="task-timeline"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="task-dependencies"]')).toHaveLength(1);
  });

  test('FR-TERM-005: unrelated agent updates do not render the terminal', async () => {
    root = renderFocusedDetailPanel(container, makeAgent());
    await act(async () => {});
    expect(terminalRender).toHaveBeenCalled();
    terminalRender.mockClear();
    act(() => useKookrStore.setState({ agents: [makeAgent({ agentId: 'other' })] }));
    expect(terminalRender).not.toHaveBeenCalled();
  });

  test('FR-TERM-005: selecting and clearing a task preserves React hook order', async () => {
    root = renderFocusedDetailPanel(container, makeAgent());
    await act(async () => {});
    const props = { send: vi.fn(() => true), onLaunch: vi.fn(), onRequestComplete: vi.fn() };
    expect(() => act(() => root!.render(React.createElement(DetailPanel, { ...props, agent: null })))).not.toThrow();
    expect(() => act(() => root!.render(React.createElement(DetailPanel, { ...props, agent: makeAgent() })))).not.toThrow();
  });

  test('FR-TERM-005: terminal callbacks survive selected-agent metadata changes', async () => {
    const agent = makeAgent();
    root = renderFocusedDetailPanel(container, agent);
    await act(async () => {});
    const before = terminalRender.mock.lastCall![0];
    act(() => root!.render(React.createElement(DetailPanel, {
      agent: { ...agent, taskName: 'Updated title' }, send: vi.fn(() => true),
      onLaunch: vi.fn(), onRequestComplete: vi.fn(), terminalFocusMode: true,
    })));
    const after = terminalRender.mock.lastCall![0];
    expect(after.onOpenFile).toBe(before.onOpenFile);
    expect(after.onEmptySubmit).toBe(before.onEmptySubmit);
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
    expect(container.querySelector('.detail-tabs')).toBeNull();
    expect(container.querySelector('[data-testid="task-dependencies"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-timeline"]')).toBeNull();
  });

  test('#3561 4b: the task timeline lives in the facts column and stays there on the GitHub pane', async () => {
    root = renderDetailPanel(container, makeAgent());

    const timeline = container.querySelector('[data-testid="task-timeline"]');
    expect(timeline).not.toBeNull();
    expect(timeline?.closest('[data-testid="detail-facts"]')).not.toBeNull();
    expect(container.querySelector('.detail-split-left [data-testid="task-timeline"]')).toBeNull();

    act(() => useKookrStore.getState().handleGitHubUpdate('task-1', [], [
      {
        ref: {
          type: 'issue', owner: 'kookr-ai', repo: 'kookr', number: 1257,
          url: 'https://github.com/kookr-ai/kookr/issues/1257',
          detectedAt: new Date('2026-07-03T00:00:00.000Z'), detectedFrom: 'test', taskId: 'task-1',
        },
        title: 'Timeline pane switch', status: 'open', author: 'jeanibarz', labels: [],
        commentCount: 0, lastFetchedAt: new Date('2026-07-03T00:00:00.000Z'),
      },
    ], []));
    await flush();
    const githubTab = [...container.querySelectorAll<HTMLButtonElement>('.detail-tabs .detail-tab')].find((el) => el.textContent === 'GitHub (1)');
    act(() => githubTab!.click());
    await flush();

    expect(container.querySelector('[data-testid="github-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="detail-facts"] [data-testid="task-timeline"]')).not.toBeNull();
  });

  function seedGitHubIssue() {
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
        title: 'Detail tab accessibility',
        status: 'open',
        author: 'jeanibarz',
        labels: [],
        commentCount: 0,
        lastFetchedAt: new Date('2026-07-03T00:00:00.000Z'),
      },
    ], []);
  }

  function renderWithWidth(agent: AgentState, wideDetailActive: boolean): Root {
    const r = createRoot(container);
    act(() => {
      r.render(React.createElement(DetailPanel, {
        agent, send: vi.fn(() => true), onLaunch: vi.fn(), onRequestComplete: vi.fn(), wideDetailActive,
      }));
    });
    return r;
  }

  function tab(name: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('.detail-tabs .detail-tab')].find((el) => el.textContent === name);
  }

  function splitToggle(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[data-testid="detail-split-toggle"]');
  }

  function terminalVisible(): string | null | undefined {
    return container.querySelector('[data-testid="terminal-panel"]')?.getAttribute('data-visible');
  }

  test('#3561 4a: by default the pane shows Conversation, Terminal and GitHub as tabs with Conversation selected', () => {
    seedGitHubIssue();
    root = renderDetailPanel(container, makeAgent());

    expect(useKookrStore.getState().detailPaneMode).toBe('tabs');
    expect(container.querySelector('.detail-panel.detail-tabbed')).not.toBeNull();
    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');
    expect(tab('Terminal')?.getAttribute('aria-pressed')).toBe('false');
    expect(tab('GitHub (1)')?.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('[data-testid="activity-panel"]')).not.toBeNull();
    expect(container.querySelector('.detail-split-left')?.className).not.toContain('pane-hidden-tab');
    expect(container.querySelector('.detail-split-right')?.className).toContain('pane-hidden-tab');
    // The hidden terminal must not hold the byte-stream subscription.
    expect(terminalVisible()).toBe('false');
  });

  test('#3561 4a: choosing the Terminal tab swaps the conversation out and activates the terminal', () => {
    seedGitHubIssue();
    root = renderDetailPanel(container, makeAgent());

    act(() => { tab('Terminal')!.click(); });

    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('false');
    expect(tab('Terminal')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.detail-split-left')?.className).toContain('pane-hidden-tab');
    expect(container.querySelector('.detail-split-right')?.className).not.toContain('pane-hidden-tab');
    expect(terminalVisible()).toBe('true');

    act(() => { tab('GitHub (1)')!.click(); });

    expect(tab('GitHub (1)')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="github-panel"]')).not.toBeNull();
    expect(terminalVisible()).toBe('false');
  });

  test('#3561 4a: the Split view toggle shows conversation and terminal side by side and persists', () => {
    root = renderDetailPanel(container, makeAgent());

    const toggle = splitToggle();
    expect(toggle?.textContent).toBe('Split view');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    act(() => { toggle!.click(); });

    expect(useKookrStore.getState().detailPaneMode).toBe('split');
    expect(localStorage.getItem('kookr-detail-panel-mode')).toBe('split');
    expect(splitToggle()?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.detail-panel.detail-tabbed')).toBeNull();
    expect(container.querySelector('.detail-split-left')?.className).not.toContain('pane-hidden-tab');
    expect(container.querySelector('.detail-split-right')?.className).not.toContain('pane-hidden-tab');
    expect(terminalVisible()).toBe('true');
    // The terminal is already on screen, so it is not offered as a tab.
    expect(tab('Terminal')).toBeUndefined();
    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');

    act(() => { splitToggle()!.click(); });

    expect(useKookrStore.getState().detailPaneMode).toBe('tabs');
    expect(localStorage.getItem('kookr-detail-panel-mode')).toBeNull();
    expect(terminalVisible()).toBe('false');
  });

  test('#3561 4a: narrow windows keep tabs and offer no Split view, even when split is stored', () => {
    useKookrStore.getState().setDetailPaneMode('split');
    root = renderWithWidth(makeAgent(), false);

    expect(splitToggle()).toBeNull();
    expect(container.querySelector('.detail-panel.detail-tabbed')).not.toBeNull();
    expect(tab('Terminal')).toBeDefined();
    expect(container.querySelector('.detail-split-right')?.className).toContain('pane-hidden-tab');
  });

  test('#3561 4a: opening a diff from the conversation reveals it, and Escape returns to the conversation', async () => {
    root = renderDetailPanel(container, makeAgent());

    const openDiff = container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button');
    act(() => { openDiff!.click(); });
    await flush();

    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();
    expect(container.querySelector('.detail-split-right')?.className).not.toContain('pane-hidden-tab');
    expect(container.querySelector('.detail-split-left')?.className).toContain('pane-hidden-tab');
    expect(terminalVisible()).toBe('false');

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await flush();

    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.detail-split-left')?.className).not.toContain('pane-hidden-tab');
    expect(container.querySelector('.detail-split-right')?.className).toContain('pane-hidden-tab');
  });

  test('#3561 4a: Escape leaves a diff alone while it sits behind the Conversation tab', async () => {
    root = renderDetailPanel(container, makeAgent());

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button')!.click(); });
    await flush();
    act(() => { tab('Conversation')!.click(); });

    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    act(() => { window.dispatchEvent(escape); });
    await flush();

    // The global handler (deselect) is free to act; the hidden diff stays open.
    expect(escape.defaultPrevented).toBe(false);
    act(() => { tab('Terminal')!.click(); });
    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();
    expect(container.querySelector<HTMLElement>('.right-pane-slot-diff')?.style.display).toBe('flex');
  });

  test('#3618: after the pane Terminal button is clicked, closing the diff stays on the Terminal tab', async () => {
    root = renderDetailPanel(container, makeAgent());

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button')!.click(); });
    await flush();
    expect(useKookrStore.getState().narrowTab).toBe('terminal');

    const paneTab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('.detail-pane-header .pane-tab'))
      .find((button) => button.textContent === label);
    act(() => { paneTab('Terminal')!.click(); });
    act(() => { paneTab('Diff')!.click(); });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await flush();

    expect(useKookrStore.getState().narrowTab).toBe('terminal');
    expect(tab('Terminal')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.detail-split-right')?.className).not.toContain('pane-hidden-tab');
  });

  function rerenderWith(agent: AgentState) {
    act(() => {
      root!.render(React.createElement(DetailPanel, {
        agent,
        send: vi.fn(() => true),
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
      }));
    });
  }

  test('#3618: moving to another task after a diff auto-selected Terminal opens the next task on Conversation', async () => {
    root = renderDetailPanel(container, makeAgent());

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button')!.click(); });
    await flush();
    expect(useKookrStore.getState().narrowTab).toBe('terminal');

    rerenderWith(makeAgent({ agentId: 'other-agent', taskId: 'other-task' }));
    await flush();

    expect(useKookrStore.getState().narrowTab).toBe('activity');
    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[data-testid="diff-pane"]')).toBeNull();
  });

  test('#3618: a Terminal tab the operator chose survives moving to another task', async () => {
    root = renderDetailPanel(container, makeAgent());

    act(() => { tab('Terminal')!.click(); });
    rerenderWith(makeAgent({ agentId: 'other-agent', taskId: 'other-task' }));
    await flush();

    expect(useKookrStore.getState().narrowTab).toBe('terminal');
  });

  test('#3618: after leaving a diff for another tab and coming back through Terminal, closing it stays on Terminal', async () => {
    root = renderDetailPanel(container, makeAgent());

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button')!.click(); });
    await flush();
    act(() => { tab('Conversation')!.click(); });
    act(() => { tab('Terminal')!.click(); });
    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await flush();

    expect(container.querySelector<HTMLElement>('.right-pane-slot-diff')?.style.display).toBe('none');
    expect(useKookrStore.getState().narrowTab).toBe('terminal');
    expect(tab('Terminal')?.getAttribute('aria-pressed')).toBe('true');
  });

  test('#3561 4a: a diff opened in split view leaves the remembered tab alone', async () => {
    useKookrStore.getState().setDetailPaneMode('split');
    root = renderDetailPanel(container, makeAgent());

    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="activity-panel"] button')!.click(); });
    await flush();

    expect(container.querySelector('[data-testid="diff-pane"]')).not.toBeNull();
    expect(useKookrStore.getState().narrowTab).toBe('activity');
  });

  test('right-only detail pane mode hides the conversation and returns to it from the persistent control', () => {
    useKookrStore.getState().setDetailPaneMode('right');
    root = renderDetailPanel(container, makeAgent());

    expect(container.querySelector('.detail-panel.terminal-focus')).not.toBeNull();
    expect(container.querySelector('.detail-split-left')).toBeNull();
    expect(container.querySelector('.detail-tabs')).toBeNull();
    expect(terminalVisible()).toBe('true');

    const restore = container.querySelector<HTMLButtonElement>('button[aria-label="Show conversation"]');
    expect(restore).not.toBeNull();
    act(() => {
      restore!.click();
    });

    expect(useKookrStore.getState().detailPaneMode).toBe('tabs');
    expect(useKookrStore.getState().narrowTab).toBe('activity');
    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');
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
    expect(terminalVisible()).toBe('false');
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
