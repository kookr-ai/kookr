// @vitest-environment happy-dom

/**
 * The task list's "Needs you" header counts questions and permission prompts with the findings, shows one
 * row for each, and pressing a row opens Lucy on it without answering anything. The same inputs give Lucy's
 * badge the same number.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../avatar/avatar-stage.js', () => ({
  AvatarStage: class {
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => null);
    dispose = vi.fn();
  },
}));
vi.mock('../avatar/assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: false },
  }),
}));
vi.mock('../audio/ask-announcement.js', () => ({ announceAsk: vi.fn(async () => 'started'), stopAskAnnouncement: vi.fn(), stopAllAskAnnouncements: vi.fn() }));

import { FindingsPanel } from './FindingsPanel.js';
import { OverviewEmptyState } from './OverviewEmptyState.js';
import { AvatarDock } from '../avatar/AvatarDock.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { useNeedsYou } from '../store/needs-you.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from '../store/lucy-permission.js';
import {
  AVATAR_PANEL_KEY,
  AVATAR_TRAY_EXPANDED_KEY,
  __resetAvatarPanelPrefsForTests,
  getAvatarPanelPrefs,
  loadTrayExpanded,
  updateAvatarPanelPrefs,
} from '../store/avatar-panel-prefs.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { AgentState } from '../../shared/protocol.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  useKookrStore.setState(Object.fromEntries(Object.entries(freshState).filter(([, value]) => typeof value !== 'function')));
}

function makeFinding(id: string, taskId = `task-${id}`, type = 'needs_input'): AgentState {
  return {
    agentId: `finding-${id}`, taskId, taskName: `Finding ${id}`, description: 'x', events: [], taskStatus: 'inProgress', cwd: '/tmp/p',
    anomaly: { type, severity: 'warning', explanation: 'Waiting', detectedAt: '2026-11-11T00:00:00.000Z' },
  } as unknown as AgentState;
}
function makeWorking(): AgentState {
  return { agentId: 'w1', taskId: 'wt1', taskName: 'Working one', events: [], anomaly: null, taskStatus: 'inProgress', cwd: '/tmp/p' } as unknown as AgentState;
}
function ask(over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id: 'a1b2c3d4e5f6', taskId: 'task-q', taskName: 'Fix login', question: 'Ship the migration now?', options: ['Yes', 'No'], allowText: false,
    state: 'pending', createdAt: Date.now() - 1000, expiresAt: Date.now() + 29 * 60_000 + 30_000, ...over,
  };
}
function permissionMessage() {
  return {
    type: 'lucyPermissionCards' as const,
    cards: [{ promptId: 'p1', taskId: 'task-p', agentId: 'agent-p', taskName: 'Build docs', toolName: 'Bash', command: 'rm -rf secret', since: Date.now() }],
  };
}

function Panel({ findings, healthy = [] }: { findings: AgentState[]; healthy?: AgentState[] }) {
  return (
    <FindingsPanel
      findings={findings} healthy={healthy} pending={[]} snoozed={[]} completed={[]}
      selectedAgentId={null} selectedTaskId={null} send={vi.fn()}
      clearCompletedFinishedCount={0} clearCompletedTerminatedCount={0}
    />
  );
}

describe('Needs you with questions and permission prompts', () => {
  let container: HTMLDivElement;
  let root: Root;
  const header = () => container.querySelector('[data-testid="findings-needs-you-header"]');
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="needs-you-lucy-row"]')];

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    syncGlobalStore();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    __resetAvatarPanelPrefsForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  test('nothing at all: "nothing waiting" and no rows', () => {
    act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
    expect(header()?.textContent).toBe('Needs you (0)nothing waiting');
    expect(rows()).toHaveLength(0);
  });

  test('one question and no findings: no "nothing waiting", one row, count 1', () => {
    act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
    act(() => handleOperatorAsks([ask()]));
    expect(header()?.textContent).toContain('Needs you (1)');
    expect(header()?.textContent).not.toContain('nothing waiting');
    expect(header()?.classList.contains('findings-needs-you-empty')).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('Fix login');
    expect(rows()[0].textContent).toContain('asks you a question');
    expect(rows()[0].textContent).toContain('29 min left');
    // The question's own text is on Lucy's card, not here.
    expect(rows()[0].textContent).not.toContain('Ship the migration');
    expect(rows()[0].querySelectorAll('button')).toHaveLength(0);
  });

  test('a permission prompt is a row naming the tool', () => {
    act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
    act(() => handleLucyPermissionCards(permissionMessage()));
    expect(header()?.textContent).toContain('Needs you (1)');
    expect(rows()[0].textContent).toContain('Build docs');
    expect(rows()[0].textContent).toContain('wants your permission to use Bash');
    expect(rows()[0].textContent).not.toContain('rm -rf');
  });

  test('a system question is named Kookr', () => {
    act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
    act(() => handleOperatorAsks([ask({ taskId: 'system:janitor', taskName: undefined })]));
    expect(rows()[0].textContent).toContain('Kookr');
  });

  test('a task with a question and a finding is two rows and a count of 2, said in words', () => {
    act(() => root.render(<Panel findings={[makeFinding('a', 'task-q')]} />));
    act(() => handleOperatorAsks([ask()]));
    expect(header()?.textContent).toContain('Needs you (2)');
    expect(header()?.textContent).toContain('1 question, 1 finding');
    expect(rows()).toHaveLength(1);
    expect(container.querySelectorAll('.finding-card')).toHaveLength(1);
    // Rows come before the findings and use their own ids as keys.
    const area = container.querySelector('.findings-scroll-area')!;
    const order = [...area.children].map((c) => (c as HTMLElement).dataset.testid ?? (c.classList.contains('finding-card') ? 'finding' : ''));
    expect(order.slice(0, 3)).toEqual(['findings-needs-you-header', 'needs-you-lucy-row', 'finding']);
  });

  test('findings only: the header is what it always was, with no kinds hint', () => {
    act(() => root.render(<Panel findings={[makeFinding('a'), makeFinding('b')]} />));
    expect(header()?.textContent).toBe('Needs you (2)');
  });

  test('the new rows do not take the place of a finding in the list or in "next finding"', () => {
    // Different types, so the list shows two cards and not one group.
    const agents = [makeFinding('a'), makeFinding('b', 'task-b', 'repeated_error')];
    act(() => useKookrStore.getState().handleSnapshot(agents));
    act(() => root.render(<Panel findings={agents} />));
    act(() => handleOperatorAsks([ask()]));
    // The rows are not finding cards, so anything that walks the finding cards still starts at the first finding.
    expect(header()?.textContent).toContain('1 question, 2 findings');
    expect(rows()[0].classList.contains('finding-card')).toBe(false);
    act(() => useKookrStore.getState().nextBottleneck());
    const first = useKookrStore.getState().selectedAgentId;
    expect(first).toMatch(/^finding-/);
    act(() => useKookrStore.getState().nextBottleneck());
    const second = useKookrStore.getState().selectedAgentId;
    expect(second).toMatch(/^finding-/);
    expect(second).not.toBe(first);
  });

  test('pressing a row opens Lucy: panel on, out of the bubble, strip unfolded; nothing is sent', () => {
    const send = vi.fn();
    act(() => root.render(<FindingsPanel findings={[]} healthy={[makeWorking()]} pending={[]} snoozed={[]} completed={[]} selectedAgentId={null} selectedTaskId={null} send={send} clearCompletedFinishedCount={0} clearCompletedTerminatedCount={0} />));
    act(() => handleOperatorAsks([ask()]));
    updateAvatarPanelPrefs({ enabled: false, minimized: true });
    expect(loadTrayExpanded()).toBe(false);
    act(() => rows()[0].click());
    expect(getAvatarPanelPrefs()).toMatchObject({ enabled: true, minimized: false });
    expect(JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY)!)).toMatchObject({ enabled: true, minimized: false });
    expect(sessionStorage.getItem(AVATAR_TRAY_EXPANDED_KEY)).toBe('1');
    expect(send).not.toHaveBeenCalled();
  });

  test('rows are real buttons, so Tab reaches them and Enter and Space press them', () => {
    act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
    act(() => handleOperatorAsks([ask()]));
    expect(rows()[0].tagName).toBe('BUTTON');
    expect(rows()[0].getAttribute('type')).toBe('button');
    expect(rows()[0].tabIndex).toBe(0);
  });

  test('overview: no "All clear" while a question waits; the row comes before findings; the tile counts it', () => {
    act(() => root.render(<OverviewEmptyState waiting={[]} running={[makeWorking()]} completed={[]} onLaunch={vi.fn()} />));
    expect(container.textContent).toContain('All clear — agents working autonomously.');
    act(() => handleOperatorAsks([ask()]));
    expect(container.textContent).not.toContain('All clear');
    const overviewRows = [...container.querySelectorAll('.overview-waiting-list > li')];
    expect(overviewRows[0].textContent).toContain('Fix login');
    expect(overviewRows[0].textContent).toContain('asks you a question');
    expect(overviewRows[0].textContent).toContain('29 min left');
    expect(container.querySelector('.overview-count-attention .overview-count-value')?.textContent).toBe('1');
  });

  test('overview: questions are listed before findings', () => {
    act(() => root.render(<OverviewEmptyState waiting={[makeFinding('a')]} running={[]} completed={[]} onLaunch={vi.fn()} />));
    act(() => handleOperatorAsks([ask()]));
    const overviewRows = [...container.querySelectorAll('.overview-waiting-list > li')];
    expect(overviewRows).toHaveLength(2);
    expect(overviewRows[0].textContent).toContain('asks you a question');
    expect(overviewRows[1].textContent).toContain('Finding a');
    expect(container.querySelector('.overview-count-attention .overview-count-value')?.textContent).toBe('2');
  });

  test('pressing a row unfolds the strip of a dock that is already open and folded', () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
    __resetAvatarPanelPrefsForTests();
    act(() => root.render(<><Panel findings={[]} healthy={[makeWorking()]} /><AvatarDock attentionCount={0} /></>));
    act(() => handleOperatorAsks([ask()]));
    const toggle = () => container.querySelector('[data-testid="avatar-tray-toggle"]')!;
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    act(() => rows()[0].click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  test('a question that runs out leaves the list within 15 seconds, without a server push', () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<Panel findings={[]} healthy={[makeWorking()]} />));
      act(() => handleOperatorAsks([ask({ expiresAt: Date.now() + 20_000 })]));
      expect(rows()).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(31_000); });
      expect(rows()).toHaveLength(0);
      expect(header()?.textContent).toBe('Needs you (0)nothing waiting');
    } finally {
      vi.useRealTimers();
    }
  });

  test('overview: the six-row cap is shared by questions and findings, and the rest is counted', () => {
    const findings = Array.from({ length: 6 }, (_, i) => makeFinding(`o${i}`));
    act(() => root.render(<OverviewEmptyState waiting={findings} running={[]} completed={[]} onLaunch={vi.fn()} />));
    act(() => handleOperatorAsks([ask({ id: 'q1aaaaaaaaaa' }), ask({ id: 'q2aaaaaaaaaa' })]));
    expect(container.querySelectorAll('.overview-waiting-list > li')).toHaveLength(6);
    expect(container.querySelector('.overview-waiting-more')?.textContent).toContain('+2 more in the findings rail');
  });

  test('minimised, the bubble names a waiting permission prompt in its label and card', () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
    __resetAvatarPanelPrefsForTests();
    act(() => root.render(<AvatarDock attentionCount={0} needsYouCount={1} permissionCount={1} />));
    const bubble = container.querySelector('[data-testid="avatar-bubble"]')!;
    expect(bubble.getAttribute('aria-label')).toContain('1 permission prompt waiting');
    act(() => { bubble.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); bubble.dispatchEvent(new FocusEvent('focus')); });
    expect(container.querySelector('[data-testid="avatar-bubble-card-permissions"]')?.textContent).toContain('1 permission prompt waiting');
  });

  test('Lucy badge and the header give the same number for the same inputs', () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
    __resetAvatarPanelPrefsForTests();
    const findings = [makeFinding('a'), makeFinding('b')];
    function Both() {
      const needsYou = useNeedsYou(findings);
      return (
        <>
          <Panel findings={findings} />
          <AvatarDock attentionCount={findings.length} needsYouCount={needsYou.total} permissionCount={needsYou.counts.permission} />
        </>
      );
    }
    act(() => root.render(<Both />));
    act(() => {
      handleOperatorAsks([ask(), ask({ id: 'b2', state: 'answered', resolvedAt: Date.now(), resolution: 'answered' }), ask({ id: 'c3', taskEnded: true })]);
      handleLucyPermissionCards(permissionMessage());
    });
    const headerNumber = header()!.textContent!.match(/Needs you \((\d+)\)/)![1];
    const badge = container.querySelector('.avatar-bubble-badge')!.textContent;
    expect(headerNumber).toBe('4');
    expect(badge).toBe(headerNumber);
  });
});
