// @vitest-environment happy-dom

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
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  setLiveAskSpeaker: vi.fn(() => () => {}),
}));

import { AvatarDock } from './AvatarDock.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests } from '../store/lucy-conversation.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from '../store/lucy-permission.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-16T12:00:00Z');

function ask(id: string, over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id, taskId: `task-${id}`, taskName: `Task ${id}`, question: `Question ${id}?`, options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - MIN, expiresAt: NOW + 30 * MIN, ...over,
  };
}
const closed = (id: string): OperatorAskView => ask(id, {
  state: 'answered', resolution: 'answered', answeredVia: 'telegram', resolvedAt: NOW, answer: { kind: 'option', index: 0, label: 'Yes' },
});

describe('AvatarDock: the "Waiting on you" tray', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const all = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
  const onAnswerAsk = vi.fn(() => true);
  const render = () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} onAnswerAsk={onAnswerAsk} />); });
  };
  const push = (asks: OperatorAskView[]) => act(() => { handleOperatorAsks(asks, undefined, NOW); });
  const later = (ms: number) => act(() => { vi.setSystemTime(Date.now() + ms); });
  /** A click that waits out the "cards just changed" guard first. */
  const click = (element: Element | null | undefined) => {
    later(500);
    act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };
  /** Which question each row/card stands for, in the order on screen. */
  const idsOf = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)].map((el) => el.dataset.askId);
  const openCardId = () => q('avatar-ask')?.dataset.askId;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    onAnswerAsk.mockReturnValue(true);
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.useRealTimers();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    document.body.innerHTML = '';
  });

  test('is not shown when nothing waits', () => {
    render();
    expect(q('avatar-tray')).toBeNull();
  });

  describe('questions a task may be waiting for', () => {
    test('are ordered by the time they close, soonest first; the first is open and the others are one line each', () => {
      render();
      push([
        ask('late', { expiresAt: NOW + 50 * MIN }),
        ask('soon', { expiresAt: NOW + 5 * MIN }),
        ask('mid', { expiresAt: NOW + 20 * MIN }),
      ]);
      expect(openCardId()).toBe('soon');
      expect(idsOf('[data-ask-id]')).toEqual(['soon', 'mid', 'late']);
      const rows = all('avatar-ask-row');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
      // One line: who asks, the start of the question, the time left. Real buttons, so the keyboard reaches them.
      expect(rows[0].tagName).toBe('BUTTON');
      expect(rows[0].textContent).toContain('Task mid asks');
      expect(rows[0].textContent).toContain('Question mid?');
      expect(rows[0].textContent).toContain('20 min left');
      expect(rows[0].querySelector('[data-testid="avatar-ask-option"]')).toBeNull();
    });

    test('pressing a row opens its card and folds the one that was open', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN })]);
      expect(openCardId()).toBe('a');
      click(all('avatar-ask-row')[0]);
      expect(openCardId()).toBe('b');
      expect(all('avatar-ask')).toHaveLength(1);
      expect(all('avatar-ask-row').map((row) => row.closest<HTMLElement>('[data-ask-id]')!.dataset.askId)).toEqual(['a']);
      // The open card's top line folds it again.
      const collapse = q<HTMLButtonElement>('avatar-ask-collapse')!;
      expect(collapse.getAttribute('aria-expanded')).toBe('true');
      click(collapse);
      expect(all('avatar-ask')).toHaveLength(0);
      expect(all('avatar-ask-row')).toHaveLength(2);
    });

    test('a question that arrives later, even one closing sooner, does not take the open card away', () => {
      render();
      push([ask('a', { expiresAt: NOW + 30 * MIN })]);
      const input = q<HTMLInputElement>('avatar-ask-input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'half an answ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      push([ask('a', { expiresAt: NOW + 30 * MIN }), ask('urgent', { expiresAt: NOW + 2 * MIN })]);
      expect(openCardId()).toBe('a');
      expect(q<HTMLInputElement>('avatar-ask-input')!.value).toBe('half an answ');
      // The row list still puts the one closing soonest first.
      expect(idsOf('[data-ask-id]')).toEqual(['urgent', 'a']);
    });

    test('a half-typed answer survives folding the card and opening it again', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN })]);
      const input = q<HTMLInputElement>('avatar-ask-input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my own words');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      click(all('avatar-ask-row')[0]); // opens b, folds a
      expect(q<HTMLInputElement>('avatar-ask-input')!.value).toBe('');
      click(all('avatar-ask-row')[0]); // opens a again
      expect(q<HTMLInputElement>('avatar-ask-input')!.value).toBe('my own words');
    });

    test('when the open question closes, the first one still waiting opens', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN }), ask('c', { expiresAt: NOW + 15 * MIN })]);
      click(all('avatar-ask-row')[1]); // opens c
      expect(openCardId()).toBe('c');
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN }), { ...closed('c') }]);
      expect(openCardId()).toBe('a');
    });

    test('after the open question is answered and none is left, the next one that arrives is open by default', () => {
      render();
      push([ask('a')]);
      expect(openCardId()).toBe('a');
      push([closed('a')]);
      expect(all('avatar-ask-collapse')).toHaveLength(0);
      push([closed('a'), ask('b')]);
      expect(openCardId()).toBe('b');
    });

    test('a card the operator folded stays folded when another question arrives', () => {
      render();
      push([ask('a')]);
      click(q('avatar-ask-collapse'));
      expect(all('avatar-ask')).toHaveLength(0);
      push([ask('a'), ask('b', { expiresAt: NOW + MIN })]);
      expect(all('avatar-ask')).toHaveLength(0);
      expect(all('avatar-ask-row')).toHaveLength(2);
    });

    test('an older server that does not say taskEnded is read as "a task may be waiting"', () => {
      render();
      push([ask('a')]);
      expect(openCardId()).toBe('a');
      expect(q('avatar-opinions')).toBeNull();
    });

    test('the list is named and counts the questions that wait', () => {
      render();
      push([ask('a'), ask('b')]);
      expect(q('avatar-asks')!.getAttribute('aria-label')).toBe('Questions waiting for your answer (2)');
      expect(q('avatar-asks')!.getAttribute('role')).toBe('list');
    });
  });

  describe('opinion requests from finished tasks', () => {
    const fifteen = (): OperatorAskView[] => [
      ask('live', { expiresAt: NOW + 9 * MIN, taskEnded: false }),
      // Pushed in a scrambled order, closing 4 h to 17 h from now.
      ...[7, 3, 12, 1, 14, 5, 9, 2, 11, 6, 13, 4, 10, 8].map((n) => ask(`op${String(n).padStart(2, '0')}`, { expiresAt: NOW + (3 + n) * 60 * MIN, taskEnded: true })),
    ];

    test('fold into one row that says how many there are and when the first closes; folded by default', () => {
      render();
      push(fifteen());
      const toggle = q<HTMLButtonElement>('avatar-opinions-toggle')!;
      expect(toggle.textContent).toContain('14 opinions wanted by finished tasks');
      expect(toggle.textContent).toContain('first closes in 4 h');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(q('avatar-opinion-list')).toBeNull();
      // Only the live question is a card; no opinion has a card or a row yet.
      expect(idsOf('[data-testid="avatar-ask"]')).toEqual(['live']);
      expect(all('avatar-ask-row')).toHaveLength(0);
    });

    test('unfolded, the rows run from the one closing soonest to the one closing last', () => {
      render();
      push(fifteen());
      click(q('avatar-opinions-toggle'));
      expect(q('avatar-opinions-toggle')!.getAttribute('aria-expanded')).toBe('true');
      const rows = idsOf('[data-testid="avatar-opinion-list"] > [data-ask-id]');
      expect(rows).toHaveLength(14);
      expect(rows[0]).toBe('op01'); // the smallest expiresAt
      expect(rows).toEqual([...rows].sort());
      expect(rows.at(-1)).toBe('op14');
      // Folding it again hides them.
      click(q('avatar-opinions-toggle'));
      expect(q('avatar-opinion-list')).toBeNull();
    });

    test('pressing an opinion row opens its full card, one at a time, and folds the open question', () => {
      render();
      push(fifteen());
      click(q('avatar-opinions-toggle'));
      expect(openCardId()).toBe('live');
      click(container.querySelector('[data-ask-id="op01"] [data-testid="avatar-ask-row"]'));
      expect(idsOf('[data-testid="avatar-ask"]')).toEqual(['op01']);
      expect(q('avatar-ask')!.querySelectorAll('[data-testid="avatar-ask-option"]')).toHaveLength(2);
      click(container.querySelector('[data-ask-id="op02"] [data-testid="avatar-ask-row"]'));
      expect(idsOf('[data-testid="avatar-ask"]')).toEqual(['op02']);
    });

    test('are not counted in the header: it counts permissions and questions a task may be waiting for', () => {
      render();
      push(fifteen());
      expect(q('avatar-tray-count')!.textContent).toBe('1');
      act(() => {
        handleLucyPermissionCards({ type: 'lucyPermissionCards', serverNow: NOW, cards: [{
          promptId: 'req-1', taskId: 'tp', agentId: 'ap', taskName: 'Push task', toolName: 'Bash', command: 'git push', since: NOW - MIN,
          approveKey: '1', denyKey: '3',
          permissionRequest: { requestId: 'req-1', toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(NOW - MIN).toISOString(), ttlMs: 5 * MIN },
        }] });
      });
      expect(q('avatar-tray-count')!.textContent).toBe('2');
      // The permission card comes before the questions.
      const tray = q('avatar-tray')!;
      const permission = tray.querySelector('[data-testid="avatar-permission"]')!;
      const question = tray.querySelector('[data-testid="avatar-ask"]')!;
      expect(permission.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('with only opinions the tray still shows, with a count of 0 and the folded row', () => {
      render();
      push([ask('op1', { taskEnded: true }), ask('op2', { taskEnded: true, expiresAt: NOW + 2 * 60 * MIN })]);
      expect(q('avatar-tray-count')!.textContent).toBe('0');
      expect(q('avatar-opinions-toggle')!.textContent).toContain('2 opinions wanted by finished tasks');
      expect(q('avatar-asks')!.getAttribute('aria-label')).toBe('Opinion requests (2)');
    });

    test('the minimised bubble counts only questions a task may wait for; opinions get their own words and add nothing to the badge', () => {
      localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
      __resetAvatarPanelPrefsForTests();
      root = createRoot(container);
      act(() => { root!.render(<AvatarDock attentionCount={2} />); });
      push(fifteen());
      // 2 findings + 1 live question = 3; the fourteen opinions are not in the number.
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')!.textContent).toBe('3');
      const label = q('avatar-bubble')!.getAttribute('aria-label')!;
      expect(label).toBe('Open Lucy. 1 question is waiting for your answer. 14 opinions wanted. 2 findings need your attention.');
      expect(label).not.toContain('15 questions');
      act(() => { q('avatar-bubble')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
      expect(q('avatar-bubble-card-asks')!.textContent).toBe('1 question for you');
      expect(q('avatar-bubble-card-opinions')!.textContent).toBe('14 opinions wanted');
    });

    test('with only opinions the bubble has no badge number and no "questions for you" row, but still says what is there', () => {
      localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
      __resetAvatarPanelPrefsForTests();
      root = createRoot(container);
      act(() => { root!.render(<AvatarDock attentionCount={0} />); });
      push([ask('op1', { taskEnded: true }), ask('op2', { taskEnded: true })]);
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')).toBeNull();
      expect(q('avatar-bubble')!.getAttribute('aria-label')).toBe('Open Lucy. 2 opinions wanted.');
      act(() => { q('avatar-bubble')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
      expect(q('avatar-bubble-card-asks')).toBeNull();
      expect(q('avatar-bubble-card-opinions')!.textContent).toBe('2 opinions wanted');
    });
  });

  describe('closed questions', () => {
    test('keep their compact outcome row with Dismiss, after the open questions', () => {
      render();
      push([closed('done'), ask('a')]);
      const tray = q('avatar-tray')!;
      expect(idsOf('[data-testid="avatar-asks"] > [data-ask-id]')).toEqual(['a', 'done']);
      expect(tray.querySelector('[data-ask-id="done"] [data-testid="avatar-ask-outcome"]')!.textContent).toBe('Answered on Telegram: Yes');
      click(tray.querySelector('[data-ask-id="done"] [data-testid="avatar-ask-dismiss"]'));
      expect(tray.querySelector('[data-ask-id="done"]')).toBeNull();
    });
  });

  describe('guards that stop a wrong answer', () => {
    test('opening or folding a row counts as the cards changing: an answer pressed in the next 400 ms is ignored', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN })]);
      later(500);
      act(() => { all('avatar-ask-row')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      // The pointer is now over a button of the card that just opened, not the one it was aimed at.
      later(100);
      act(() => { all('avatar-ask-option')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onAnswerAsk).not.toHaveBeenCalled();
      later(400);
      act(() => { all('avatar-ask-option')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onAnswerAsk).toHaveBeenCalledOnce();
      expect(onAnswerAsk).toHaveBeenCalledWith('b', { optionIndex: 0 });
    });

    test('a permission card arriving above the questions also counts: an answer pressed in the next 400 ms is ignored', () => {
      render();
      push([ask('a')]);
      later(500);
      act(() => {
        handleLucyPermissionCards({ type: 'lucyPermissionCards', serverNow: Date.now(), cards: [{
          promptId: 'req-9', taskId: 'tp', agentId: 'ap', taskName: 'Push task', toolName: 'Bash', command: 'git push', since: Date.now() - MIN,
          approveKey: '1', denyKey: '3',
          permissionRequest: { requestId: 'req-9', toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(Date.now() - MIN).toISOString(), ttlMs: 5 * MIN },
        }] });
      });
      later(100);
      act(() => { all('avatar-ask-option')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onAnswerAsk).not.toHaveBeenCalled();
      later(400);
      act(() => { all('avatar-ask-option')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      expect(onAnswerAsk).toHaveBeenCalledOnce();
    });

    test('keyboard focus follows a row that was pressed to its card\'s top line, never to an answer button', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b', { expiresAt: NOW + 10 * MIN })]);
      const row = all<HTMLButtonElement>('avatar-ask-row')[0];
      act(() => { row.focus(); });
      click(row);
      expect(document.activeElement).toBe(q('avatar-ask-collapse'));
    });

    test('focus on the open card\'s top line returns to its row when it is folded', () => {
      render();
      push([ask('a')]);
      const collapse = q<HTMLButtonElement>('avatar-ask-collapse')!;
      act(() => { collapse.focus(); });
      click(collapse);
      expect(document.activeElement).toBe(q('avatar-ask-row'));
    });
  });
});
