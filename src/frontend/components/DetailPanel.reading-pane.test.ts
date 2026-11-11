// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { TaskGitHub } from '../store/store-types.js';
import type { GitHubPRState } from '../../shared/contracts/github.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({
  EffectiveHookSettingsModal: ({ onClose }: { onClose: () => void }) => React.createElement(
    'button',
    { type: 'button', 'data-testid': 'hooks-modal-close', onClick: onClose },
    'close hooks',
  ),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(Object.entries(freshState).filter(([, value]) => typeof value !== 'function')));
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Reading pane task',
    events: [],
    agentType: 'claude-code',
    cwd: '/home/jean/git/kookr',
    projectDisplayLabel: 'kookr',
    gitBranch: 'feat/x',
    startedAt: '2026-05-09T00:00:00.000Z',
    taskStatus: 'inProgress',
    description: 'You are fixing the reading pane. Full prompt text here.',
    ...overrides,
  } as AgentState;
}

describe('DetailPanel reading pane header and facts (#3561 slice 4b)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let sent: ClientMessage[];

  function render(agent: AgentState, extra: Record<string, unknown> = {}) {
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(DetailPanel, {
        agent,
        send: (msg: ClientMessage) => { sent.push(msg); return true; },
        onLaunch: vi.fn(),
        onRequestComplete: vi.fn(),
        ...extra,
      }));
    });
  }

  const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const headerButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.detail-header-right button')]
    .map((button) => button.getAttribute('data-testid'));

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    sent = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  test.each(['split', 'tabs'] as const)('in the %s layout, Conversation takes the highlight when the open GitHub tab loses its references (#3618)', async (detailPaneMode) => {
    const pr: GitHubPRState = {
      ref: { type: 'pr', owner: 'kookr-ai', repo: 'kookr', number: 7, url: 'https://github.com/kookr-ai/kookr/pull/7', detectedAt: new Date(0), detectedFrom: 'test', taskId: 'task-1' },
      title: 'PR', status: 'open', mergeable: 'MERGEABLE', author: 'me', branch: 'b', baseBranch: 'main',
      reviewDecision: null, reviewers: [], unresolvedThreads: [], totalComments: 0, checks: [], lastFetchedAt: new Date(0),
    };
    const withRefs: TaskGitHub = { taskId: 'task-1', prs: [pr], issues: [], changes: [] };
    useKookrStore.setState({ narrowTab: 'github', leftPane: 'github', detailPaneMode, githubState: { 'task-1': withRefs } });
    render(makeAgent());
    const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('.detail-tab')]
      .find((button) => button.textContent?.startsWith(label));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(tab('GitHub')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('github-panel')).not.toBeNull();

    act(() => useKookrStore.setState({ githubState: { 'task-1': { ...withRefs, prs: [] } } }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(tab('GitHub')).toBeUndefined();
    expect(tab('Conversation')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('.detail-tab.active:not(.detail-split-toggle)')).toHaveLength(1);
    expect(q('activity-panel')).not.toBeNull();
  });

  test.each([
    ['inProgress', ['action-complete', 'detail-more-actions']],
    ['pending', ['detail-more-actions']],
    ['terminated', ['action-mark-done', 'detail-more-actions']],
    ['completed', ['action-relaunch', 'detail-more-actions']],
    ['cancelled', ['action-relaunch', 'detail-more-actions']],
  ] as const)('a %s task shows one main action and the menu at rest', (taskStatus, expected) => {
    render(makeAgent({ taskStatus }));
    expect(headerButtons()).toEqual(expected);
    expect(q('action-cancel')).toBeNull();
  });

  test('Cancel is reachable from the menu, closes it and still asks for confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(makeAgent());
    act(() => q('detail-more-actions')!.click());
    expect(q('detail-more-actions')!.getAttribute('aria-expanded')).toBe('true');
    const items = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
    expect(items).toEqual(['Reflect…', 'Cancel task…']);
    act(() => q('action-cancel')!.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent.some((msg) => msg.type === 'cancelTask')).toBe(false);
  });

  test('Escape closes the menu and returns focus to its trigger', () => {
    render(makeAgent());
    act(() => q('detail-more-actions')!.click());
    expect(document.activeElement?.getAttribute('data-testid')).toBe('action-reflect');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(q('detail-more-actions'));
  });

  test('Reopen and Relaunch of a finished task are one click into the menu', async () => {
    render(makeAgent({ taskStatus: 'completed' }));
    act(() => q('detail-more-actions')!.click());
    act(() => q('action-reopen')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(sent).toContainEqual({ type: 'reopenTask', taskId: 'task-1' });
  });

  test('the Complete button keeps the signal-ready pulse', () => {
    render(makeAgent({
      anomaly: { type: 'needs_input', severity: 'info', explanation: 'done', detectedAt: '2026-05-09T00:00:00.000Z' },
      turnState: 'completed_turn',
      pendingSignal: { kind: 'completion-ready', note: 'ready', at: '2026-05-09T00:00:00.000Z' },
    } as unknown as Partial<AgentState>));
    expect(q('action-complete')?.className).toContain('action-btn--signal-ready');
  });

  test('the meta line shows a state chip without a finding and the finding badge with one', () => {
    render(makeAgent());
    expect(q('detail-state-chip')?.textContent).toBe('Working');
    expect(container.querySelectorAll('.detail-badge')).toHaveLength(0);
    act(() => root!.unmount());
    render(makeAgent({ anomaly: { type: 'permission_blocked', severity: 'warning', explanation: 'Bash', detectedAt: '2026-05-09T00:00:00.000Z' } } as unknown as Partial<AgentState>));
    expect(q('detail-state-chip')).toBeNull();
    expect(container.querySelectorAll('.detail-badge')).toHaveLength(1);
    expect(container.querySelector('.detail-badge')?.textContent).toContain('PERMISSION');
  });

  test('the facts column holds the copy, share and full-prompt links', () => {
    render(makeAgent());
    const facts = q('detail-facts')!;
    expect(facts.querySelector('[data-testid="task-share-button"]')).not.toBeNull();
    expect(facts.querySelector('.detail-facts-prompt summary')?.textContent).toBe('View full prompt');
    expect(facts.querySelector('.detail-facts-prompt-text')?.textContent).toContain('Full prompt text here.');
    expect(facts.querySelector('[data-testid="detail-fact-pr"]')?.textContent).toContain('none yet');
    act(() => root!.unmount());
    render(makeAgent({ taskStatus: 'completed' }));
    // A finished task without a pull request does not promise one.
    expect(q('detail-fact-pr')).toBeNull();
    // Docked on a wide pane, so there is no Details toggle.
    expect(q('detail-facts-toggle')).toBeNull();
  });

  test('split view folds the facts column behind a Details toggle that opens it over the pane', () => {
    useKookrStore.getState().setDetailPaneMode('split');
    render(makeAgent());
    expect(q('detail-facts')).toBeNull();
    const toggle = q('detail-facts-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(q('detail-facts')?.className).toContain('detail-facts--overlay');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => container.querySelector<HTMLButtonElement>('.detail-facts-close')!.click());
    expect(q('detail-facts')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  test('terminal focus keeps the facts reachable from the Details toggle', () => {
    render(makeAgent(), { terminalFocusMode: true });
    expect(q('detail-facts')).toBeNull();
    act(() => q('detail-facts-toggle')!.click());
    const facts = q('detail-facts')!;
    expect(facts.className).toContain('detail-facts--overlay');
    expect(facts.querySelector('.detail-hook-settings-btn')).not.toBeNull();
    expect(facts.querySelector('[data-testid="task-share-button"]')).not.toBeNull();
  });

  test('the overlay closes when the column docks, so a later undock starts closed', () => {
    useKookrStore.getState().setDetailPaneMode('split');
    render(makeAgent());
    act(() => q('detail-facts-toggle')!.click());
    expect(q('detail-facts')?.className).toContain('detail-facts--overlay');
    act(() => useKookrStore.getState().setDetailPaneMode('tabs'));
    expect(q('detail-facts')?.className).not.toContain('detail-facts--overlay');
    act(() => useKookrStore.getState().setDetailPaneMode('split'));
    expect(q('detail-facts')).toBeNull();
  });

  test('a completion digest still shows the facts column', () => {
    render(makeAgent({
      taskStatus: 'completed',
      completionDigest: { bullets: ['Shipped'], filesChanged: [] },
    } as unknown as Partial<AgentState>));
    expect(q('detail-facts')).not.toBeNull();
  });

  test('the hooks view opened from the facts column returns focus to its button', async () => {
    render(makeAgent());
    const hooks = container.querySelector<HTMLButtonElement>('.detail-hook-settings-btn')!;
    act(() => hooks.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => q('hooks-modal-close')!.click());
    expect(document.activeElement).toBe(hooks);
  });

  test('a finding docks a decision card above the reply box with the ask, the last message and the answers', () => {
    useKookrStore.getState().handleSuggestion('agent-1', [], [
      { label: 'Allow once', value: 'allow', keystroke: '1' },
      { label: 'Deny', value: 'deny', keystroke: '3' },
    ]);
    render(makeAgent({
      anomaly: {
        type: 'permission_blocked',
        severity: 'warning',
        explanation: 'Bash wants to run pnpm db:migrate --env staging',
        detectedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
        transcriptContext: { lastAssistantMessage: { excerpt: 'I need to migrate the database.', truncated: false } },
      },
    } as unknown as Partial<AgentState>));
    const card = q('decision-card')!;
    // Docked at the foot of the conversation pane, right above the reply box.
    expect(card.parentElement?.classList.contains('detail-split-left')).toBe(true);
    expect(card.parentElement?.lastElementChild).toBe(card);
    const reply = container.querySelector('.response-row')!;
    expect(card.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain('Bash wants to run pnpm db:migrate --env staging');
    expect(card.textContent).toContain('waiting 4m');
    expect(card.querySelector('[data-testid="detail-transcript-context"]')?.textContent).toContain('I need to migrate the database.');
    expect([...card.querySelectorAll('.btn-quick-action')].map((b) => b.textContent)).toEqual(['Allow once', 'Deny']);
    expect(card.textContent).toContain('or reply below');
    // Skip and Snooze moved into the card; the reply row keeps input and Send.
    expect(card.querySelector('[data-testid="finding-skip"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="finding-snooze"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="finding-skip"]')).toHaveLength(1);
    expect(reply.querySelector('[data-testid="finding-skip"]')).toBeNull();
    // The answers moved: nothing duplicates them outside the card.
    expect(container.querySelectorAll('.quick-actions')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="detail-transcript-context"]')).toHaveLength(1);
  });

  test('a stuck or failed finding uses the red card, a working task has none', () => {
    render(makeAgent({ anomaly: { type: 'repeated_error', severity: 'error', explanation: 'Same error 3 times', detectedAt: new Date().toISOString() } } as unknown as Partial<AgentState>));
    expect(q('decision-card')?.className).toContain('decision-card--bad');
    act(() => root!.unmount());
    render(makeAgent());
    expect(q('decision-card')).toBeNull();
  });

  test('split view keeps the card in the conversation pane, beside a full-height terminal', () => {
    useKookrStore.getState().setDetailPaneMode('split');
    render(makeAgent({ anomaly: { type: 'permission_blocked', severity: 'warning', explanation: 'x', detectedAt: new Date().toISOString() } } as unknown as Partial<AgentState>));
    expect(q('decision-card')?.closest('.detail-split-left')).not.toBeNull();
    expect(container.querySelector('.detail-split-right [data-testid="decision-card"], .response-area [data-testid="decision-card"]')).toBeNull();
  });

  test('with the terminal filling the pane the card folds away and only the answer buttons stay', () => {
    useKookrStore.getState().handleSuggestion('agent-1', [], [{ label: 'Allow once', value: 'allow', keystroke: '1' }]);
    const anomaly = { type: 'permission_blocked', severity: 'warning', explanation: 'Bash wants to run ls', detectedAt: new Date().toISOString() };
    render(makeAgent({ anomaly } as unknown as Partial<AgentState>));
    expect(q('decision-card')).not.toBeNull();
    act(() => q('detail-tab-terminal')!.click());
    expect(q('decision-card')).toBeNull();
    expect([...container.querySelectorAll('.response-area .btn-quick-action')].map((b) => b.textContent)).toEqual(['Allow once']);
    expect(container.querySelector('.response-row [data-testid="finding-skip"]')).not.toBeNull();
    act(() => root!.unmount());
    render(makeAgent({ anomaly } as unknown as Partial<AgentState>), { terminalFocusMode: true });
    expect(q('decision-card')).toBeNull();
    expect(container.querySelectorAll('.response-area .btn-quick-action')).toHaveLength(1);
  });

  test('Snooze in the decision card opens the snooze dialog', () => {
    render(makeAgent({ anomaly: { type: 'needs_input', severity: 'info', explanation: 'x', detectedAt: new Date().toISOString() } } as unknown as Partial<AgentState>));
    act(() => q('finding-snooze')!.click());
    expect(container.querySelector('.snooze-dialog')).not.toBeNull();
  });
});
