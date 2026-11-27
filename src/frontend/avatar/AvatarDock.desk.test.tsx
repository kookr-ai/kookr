// @vitest-environment happy-dom

// The desk: Lucy's room as three columns. The regions and their titles, the Decisions list in the order of the
// needs-you list with its "Next:" line, finding cards with their one button, the empty state, the Fleet rows,
// the header's summary, and the columns each width gets.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./avatar-stage.js', () => ({
  AvatarStage: class {
    setState = vi.fn();
    setAnalyser = vi.fn();
    snapshot = vi.fn(() => null);
    dispose = vi.fn();
  },
}));
vi.mock('./assets/lucy-bust.glb?url', () => ({ default: '/lucy-bust.glb' }));
vi.mock('../telemetry.js', () => ({ track: vi.fn() }));
// Counts how often the Fleet column works out a row's "how long": that happens only when it draws again.
const durationCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../presentation.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../presentation.js')>();
  return { ...original, formatDuration: (...args: Parameters<typeof original.formatDuration>) => { durationCalls.n += 1; return original.formatDuration(...args); } };
});
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: false },
  }),
}));
vi.mock('../audio/ask-announcement.js', () => ({
  announceAsk: vi.fn(async () => 'started'),
  announcePermissionNotice: vi.fn(async () => 'started'),
  announceLaunchReport: vi.fn(async () => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  setLiveAskSpeaker: vi.fn(() => () => {}),
}));

import { AvatarDock, type AvatarDockProps } from './AvatarDock.js';
import type { AgentState } from '../../shared/protocol.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, AVATAR_ROOM_KEY, __resetAvatarPanelPrefsForTests, getAvatarRoom } from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests, appendConversationEntry } from '../store/lucy-conversation.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from '../store/lucy-permission.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLucyBriefingForTests } from './useLucyBriefing.js';

const MIN = 60_000;
const NOW = new Date(2026, 10, 16, 12, 0, 0).getTime();

function ask(id: string, over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id, taskId: `task-${id}`, taskName: `Task ${id}`, question: `Question ${id}?`, options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - MIN, expiresAt: NOW + 30 * MIN, ...over,
  };
}

function permission(over: Partial<LucyPermissionCardView> = {}): LucyPermissionCardView {
  const since = NOW - MIN;
  return {
    promptId: 'req-aaaa', taskId: 'task-perm', agentId: 'kookr-perm', taskName: 'Billing migration', toolName: 'Bash',
    command: 'npm publish', since,
    permissionRequest: { requestId: 'req-aaaa', toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(since).toISOString(), ttlMs: 5 * MIN },
    approveKey: '1', denyKey: '3',
    ...over,
  };
}

function agent(id: string, over: Record<string, unknown> = {}): AgentState {
  return {
    agentId: `agent-${id}`, taskId: `task-${id}`, taskName: `Run ${id}`, cwd: `/work/${id}-project`, description: '', events: [], anomaly: null,
    startedAt: new Date(NOW - 12 * MIN).toISOString(), ...over,
  } as unknown as AgentState;
}

const finishedFinding = (over: Record<string, unknown> = {}): AgentState => agent('rel', {
  taskName: 'Package release',
  turnState: 'completed_turn',
  anomaly: { agentId: 'agent-rel', type: 'needs_input', severity: 'warning', explanation: 'The agent says the release is done.\nMore detail.', detectedAt: new Date(NOW) },
  ...over,
});

describe('AvatarDock: the desk', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const all = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
  const dock = () => q('avatar-dock')!;
  const text = (id: string) => q(id)?.textContent ?? null;
  const onOpenTask = vi.fn((_taskId: string) => true);

  const render = (props: Partial<AvatarDockProps> = {}): void => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
    sessionStorage.setItem(AVATAR_ROOM_KEY, '1');
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} onOpenTask={onOpenTask} {...props} />); });
  };
  const click = (element: Element | null | undefined): void => {
    expect(element).not.toBeNull();
    act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  const setWindowWidth = (width: number): void => {
    act(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      window.dispatchEvent(new Event('resize'));
    });
  };
  const pushAsks = (asks: OperatorAskView[]) => act(() => { handleOperatorAsks(asks, undefined, NOW); });
  const pushPermissions = (cards: LucyPermissionCardView[]) => act(() => { handleLucyPermissionCards({ type: 'lucyPermissionCards', cards }); });
  const region = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name}"]`);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    onOpenTask.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    __resetLucyBriefingForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1080 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    localStorage.clear();
    sessionStorage.clear();
    __resetAvatarPanelPrefsForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    __resetLucyConversationForTests();
    document.body.innerHTML = '';
  });

  describe('the columns', () => {
    test('Decisions, Fleet and Conversation are labelled regions, in that tab order, with their titles and counts', () => {
      render({ running: [agent('a'), agent('b')], findings: [finishedFinding()] });
      pushAsks([ask('q1')]);
      expect(dock().getAttribute('data-desk-columns')).toBe('3');
      const decisions = region('Decisions')!;
      const fleet = region('Fleet')!;
      const conversation = region('Conversation')!;
      expect([decisions, fleet, conversation].every((element) => element !== null)).toBe(true);
      expect(conversation.getAttribute('role')).toBe('region');
      expect(decisions.compareDocumentPosition(fleet) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(fleet.compareDocumentPosition(conversation) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(decisions.querySelector('h2')!.textContent).toBe('Decisions · 2');
      expect(fleet.querySelector('h2')!.textContent).toBe('Fleet · 2 running');
      // Her 3D view, the thread and the composer are the conversation's.
      expect(conversation.contains(container.querySelector('.avatar-dock-view'))).toBe(true);
      expect(conversation.contains(q('avatar-composer'))).toBe(true);
    });

    test('three columns from 1500 px, two from 1100 px, one below; Fleet is only where there are side columns', () => {
      render({ running: [agent('a')] });
      for (const [width, columns] of [[2560, '3'], [1920, '3'], [1500, '3'], [1499, '2'], [1100, '2'], [1099, '1']] as const) {
        setWindowWidth(width);
        expect(dock().getAttribute('data-desk-columns')).toBe(columns);
        expect(q('avatar-desk-fleet') !== null).toBe(columns !== '1');
      }
      setWindowWidth(1920);
      expect(dock().style.getPropertyValue('--lucy-desk-side-width')).toBe('499px');
      setWindowWidth(2560);
      expect(dock().style.getPropertyValue('--lucy-desk-side-width')).toBe('520px');
    });

    test('the header says in one plain line what runs and what needs the operator', () => {
      render({ running: [agent('a'), agent('b'), agent('c')], findings: [finishedFinding()] });
      expect(text('avatar-desk-summary')).toBe('3 running · 1 needs you');
      pushAsks([ask('q1')]);
      expect(text('avatar-desk-summary')).toBe('3 running · 2 need you');
    });

    test('the header\u2019s running count is the Fleet column\u2019s count, whatever the data and the width', () => {
      const count = (): [string | null, string | null] => [text('avatar-desk-summary')?.match(/^(\d+) running/)?.[1] ?? null, text('avatar-desk-fleet-count')];
      render({ running: [agent('a'), agent('b')], findings: [finishedFinding()] });
      expect(count()).toEqual(['2', '2']);
      pushAsks([ask('q1')]);
      setWindowWidth(1280);
      expect(count()).toEqual(['2', '2']);
      act(() => { root!.render(<AvatarDock attentionCount={0} onOpenTask={onOpenTask} running={[]} />); });
      expect(count()).toEqual(['0', '0']);
    });

    test('with only her opening words the thread is marked so the desk puts them under her portrait; a real exchange ends it', () => {
      render();
      const content = () => container.querySelector('.avatar-thread-content')!;
      expect(content().getAttribute('data-opening')).toBe('true');
      act(() => { appendConversationEntry({ kind: 'lucy', text: 'Here is your briefing.' }); });
      expect(content().getAttribute('data-opening')).toBe('true');
      act(() => { appendConversationEntry({ kind: 'typed-you', text: 'What is running?' }); });
      expect(content().hasAttribute('data-opening')).toBe(false);
    });

    test('the button that opens it is called Desk, with the same tooltip', () => {
      sessionStorage.clear();
      localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
      __resetAvatarPanelPrefsForTests();
      root = createRoot(container);
      act(() => { root!.render(<AvatarDock attentionCount={0} />); });
      const toggle = q<HTMLButtonElement>('avatar-room-toggle')!;
      expect(toggle.textContent).toBe('Desk');
      expect(toggle.title).toBe('Give Lucy the whole window');
    });
  });

  describe('Decisions', () => {
    test('questions, then permission prompts, then findings; the Next line names the first in words', () => {
      pushAsks([ask('late', { expiresAt: NOW + 117 * MIN }), ask('soon', { expiresAt: NOW + 5 * MIN })]);
      pushPermissions([permission()]);
      render({ findings: [finishedFinding()] });
      const order = [...region('Decisions')!.querySelectorAll('[data-testid="avatar-ask"], [data-testid="avatar-permission"], [data-testid="avatar-desk-finding"]')]
        .map((element) => element.getAttribute('data-testid') === 'avatar-ask' ? `ask:${element.getAttribute('data-ask-id')}` : element.getAttribute('data-testid'));
      expect(order).toEqual(['ask:soon', 'ask:late', 'avatar-permission', 'avatar-desk-finding']);
      expect(text('avatar-desk-next')).toBe('Next: answer Task soon, 5 min left');
      // All the cards are open: no folded row to press first.
      expect(all('avatar-ask-row')).toHaveLength(0);
    });

    test('Next names a permission prompt when that comes first, and a finding when only findings wait', () => {
      pushPermissions([permission()]);
      render({ findings: [finishedFinding()] });
      expect(text('avatar-desk-next')).toBe('Next: Billing migration wants your permission to use Bash');
      pushPermissions([]);
      expect(text('avatar-desk-next')).toBe('Next: review Package release, it says it is finished');
    });

    test('Next scrolls its card into view and lights it, without taking focus', () => {
      pushAsks([ask('q1')]);
      render();
      const card = container.querySelector<HTMLElement>('[data-testid="avatar-ask"][data-ask-id="q1"]')!;
      const scroll = vi.fn();
      card.scrollIntoView = scroll;
      const before = document.activeElement;
      click(q('avatar-desk-next'));
      expect(scroll).toHaveBeenCalledOnce();
      expect(card.classList.contains('avatar-desk-flash')).toBe(true);
      expect(document.activeElement).toBe(before);
    });

    test('a finding card shows its kind, the task, one line of its own explanation and only "Open task"', () => {
      render({ findings: [finishedFinding()] });
      const card = q('avatar-desk-finding')!;
      expect(text('avatar-desk-finding-kind')).toBe('Says it is finished');
      expect(card.textContent).toContain('Package release');
      expect(text('avatar-desk-finding-line')).toBe('The agent says the release is done.');
      const buttons = [...card.querySelectorAll('button')];
      expect(buttons.map((button) => button.textContent)).toEqual(['Open task']);
    });

    test('a finding with no explanation has no second line', () => {
      render({ findings: [finishedFinding({ anomaly: { agentId: 'agent-rel', type: 'needs_input', severity: 'warning', explanation: '', detectedAt: new Date(NOW) } })] });
      expect(q('avatar-desk-finding-line')).toBeNull();
    });

    test('pressing "Open task" on a finding leaves the desk and selects that task', () => {
      render({ findings: [finishedFinding()] });
      expect(getAvatarRoom()).toBe(true);
      click(q('avatar-desk-finding-open'));
      expect(onOpenTask).toHaveBeenCalledWith('task-rel');
      expect(getAvatarRoom()).toBe(false);
    });

    test('a task stopped on a permission prompt shows the prompt card, not a second card for its finding', () => {
      pushPermissions([permission({ taskId: 'task-blocked' })]);
      render({
        findings: [agent('blocked', { taskId: 'task-blocked', anomaly: { agentId: 'agent-blocked', type: 'permission_blocked', severity: 'warning', explanation: 'Waiting.', detectedAt: new Date(NOW) } })],
      });
      expect(all('avatar-permission')).toHaveLength(1);
      expect(all('avatar-desk-finding')).toHaveLength(0);
      expect(text('avatar-tray-count')).toBe('1');
    });

    test('with nothing waiting it says so, and lists up to five questions closed today with their outcome', () => {
      const closed = (id: string, over: Partial<OperatorAskView>) => ask(id, { state: 'answered', answeredVia: 'dashboard', answer: { kind: 'option', label: 'Yes' }, resolvedAt: NOW - 10 * MIN, ...over });
      pushAsks([
        closed('a', {}),
        closed('b', { state: 'expired', answer: undefined, resolvedAt: NOW - 20 * MIN }),
        closed('yesterday', { resolvedAt: new Date(2026, 10, 15, 12).getTime() }),
      ]);
      render();
      expect(text('avatar-tray-empty')).toBe('Nothing waits on you.');
      expect(text('avatar-tray-count')).toBe('0');
      expect(q('avatar-desk-next')).toBeNull();
      const rows = [...q('avatar-desk-decided')!.querySelectorAll('li')].map((row) => row.textContent);
      expect(rows).toEqual(['Task aYou answered: Yes', 'Task bExpired with no answer']);
    });

    test('with nothing waiting and nothing decided today it shows only the first sentence', () => {
      render();
      expect(text('avatar-tray-empty')).toBe('Nothing waits on you.');
      expect(q('avatar-desk-decided')).toBeNull();
    });
  });

  describe('Fleet', () => {
    test('running rows: needs-you tasks first (marked), the dashboard order otherwise, a second line only when the data has one', () => {
      const tool = { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'pnpm test' }, timestamp: new Date(NOW).toISOString() };
      render({
        running: [
          agent('a', { tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.42 }, events: [tool] }),
          agent('b'),
          agent('c'),
        ],
      });
      pushAsks([ask('c')]);
      const rows = all('avatar-desk-row');
      expect(rows.map((row) => row.querySelector('.avatar-desk-row-name')!.textContent)).toEqual(['Run c', 'Run a', 'Run b']);
      expect(rows.map((row) => row.getAttribute('data-needs-you'))).toEqual(['true', null, null]);
      expect(rows[0]!.querySelector('.avatar-mark-diamond')).not.toBeNull();
      expect(rows[1]!.querySelector('.avatar-mark-diamond')).toBeNull();
      // Only the row whose task is on a tool has the line, taken from the dashboard's own label.
      expect(rows.map((row) => row.querySelector('[data-testid="avatar-desk-row-doing"]')?.textContent ?? null)).toEqual([null, 'pnpm test', null]);
      expect(rows[1]!.querySelector('.avatar-desk-row-meta')!.textContent).toBe('a-project · 12m · $0.42');
      expect(rows[2]!.querySelector('.avatar-desk-row-meta')!.textContent).toBe('b-project · 12m');
    });

    test('pressing a row leaves the desk and opens the task', () => {
      render({ running: [agent('a')] });
      click(q('avatar-desk-row'));
      expect(onOpenTask).toHaveBeenCalledWith('task-a');
      expect(getAvatarRoom()).toBe(false);
    });

    test('"Finished today" lists up to eight tasks finished today, each opening its task; nothing older', () => {
      const done = (id: string, finishedAt: number) => agent(id, { finishedAt: new Date(finishedAt).toISOString(), tokenUsage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 1.5 } });
      render({
        completed: [
          ...Array.from({ length: 10 }, (_, i) => done(`f${i}`, NOW - (i + 1) * 5 * MIN)),
          done('old', new Date(2026, 10, 15, 12).getTime()),
        ],
      });
      const rows = all('avatar-desk-row');
      expect(rows).toHaveLength(8);
      expect(rows[0]!.textContent).toContain('Run f0');
      expect(rows[0]!.textContent).toContain('5m ago');
      expect(rows[0]!.textContent).toContain('$1.50');
      expect(container.textContent).toContain('Finished today');
      expect(container.textContent).not.toContain('Run old');
      click(rows[0]);
      expect(onOpenTask).toHaveBeenCalledWith('task-f0');
    });

    test('the rows are not drawn again when the dashboard pushes the same agents', () => {
      const running = [agent('a'), agent('b')];
      render({ running });
      const rows = all('avatar-desk-row');
      const drawn = durationCalls.n;
      expect(drawn).toBeGreaterThan(0);
      // The dock draws again with the same buckets (a message that changed nothing here): the Fleet column does not.
      act(() => { root!.render(<AvatarDock attentionCount={0} onOpenTask={onOpenTask} running={running} />); });
      expect(durationCalls.n).toBe(drawn);
      expect(all('avatar-desk-row')).toEqual(rows);
      // New buckets do draw it again.
      act(() => { root!.render(<AvatarDock attentionCount={0} onOpenTask={onOpenTask} running={[...running, agent('c')]} />); });
      expect(durationCalls.n).toBeGreaterThan(drawn);
    });

    test('with nothing running it says so', () => {
      render();
      expect(text('avatar-desk-fleet-empty')).toBe('No tasks are running.');
    });
  });
});
