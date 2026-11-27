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
const track = vi.hoisted(() => vi.fn());
vi.mock('../telemetry.js', () => ({ track }));
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
import { ARMING_MS } from './BubbleDecisionCard.js';
import { BUBBLE_GROWN_KEY, MAX_REMEMBERED, OUTCOME_VISIBLE_MS, TYPING_QUIET_MS, __resetBubbleDecisionForTests } from './bubble-decision.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { __resetDndForTests, disableDnd, enableDnd } from '../hooks/useDnd.js';
import { AVATAR_PANEL_KEY, AVATAR_TRAY_EXPANDED_KEY, __resetAvatarPanelPrefsForTests, openLucyOnWaiting } from '../store/avatar-panel-prefs.js';
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
const answeredOn = (id: string, via: 'telegram' | 'dashboard', over: Partial<OperatorAskView> = {}): OperatorAskView => ask(id, {
  state: 'answered', resolution: 'answered', answeredVia: via, resolvedAt: Date.now(), answer: { kind: 'option', index: 0, label: 'Yes' }, ...over,
});

function permissionCard(id: string, over: Record<string, unknown> = {}, ttlMs = 5 * MIN, detectedAt = NOW) {
  return {
    promptId: id, taskId: `task-${id}`, agentId: `agent-${id}`, taskName: `Task ${id}`, toolName: 'Bash', command: 'git push origin main',
    since: detectedAt, approveKey: '1', denyKey: '3',
    permissionRequest: { requestId: id, toolName: 'Bash', toolInputHash: 'h', detectedAt: new Date(detectedAt).toISOString(), ttlMs },
    ...over,
  };
}

describe('AvatarDock: the minimised bubble grows into a decision', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onAnswerAsk = vi.fn(() => true);
  const onPermissionChoice = vi.fn(() => true);
  const q = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const all = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
  const card = () => q('lucy-bubble-card');
  const render = (minimized = true, extra: { needsYouCount?: number; dialogOpen?: boolean } = {}) => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} onAnswerAsk={onAnswerAsk} onPermissionChoice={onPermissionChoice} {...extra} />); });
  };
  const push = (asks: OperatorAskView[], announce?: string) => act(() => { handleOperatorAsks(asks, announce, NOW); });
  const pushPermission = (cards: ReturnType<typeof permissionCard>[]) => act(() => {
    handleLucyPermissionCards({ type: 'lucyPermissionCards', serverNow: Date.now(), cards: cards as never });
  });
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  const click = (element: Element | null | undefined) => act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const key = (name: string, target: EventTarget = document) => act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
  const actions = () => track.mock.calls.map(([event]) => (event as { action?: string }).action).filter((a): a is string => typeof a === 'string' && a.startsWith('bubble_card_'));
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    onAnswerAsk.mockReturnValue(true);
    onPermissionChoice.mockReturnValue(true);
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    __resetBubbleDecisionForTests();
    disableDnd();
    __resetDndForTests();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    disableDnd();
    vi.useRealTimers();
    __resetOperatorAsksForTests();
    __resetLucyPermissionForTests();
    document.body.innerHTML = '';
  });

  describe('when it appears', () => {
    test('a pending question grows the bubble: who asks, time left, the question, its answers, Open Lucy and Later', () => {
      render();
      push([ask('a')]);
      expect(card()).not.toBeNull();
      expect(card()!.textContent).toContain('Task a asks');
      expect(card()!.textContent).toContain('30 min left');
      expect(q('avatar-ask-question')!.textContent).toBe('Question a?');
      expect(all('avatar-ask-option').map((b) => b.textContent)).toEqual(['Yes', 'No']);
      expect(q('avatar-ask-note')!.textContent).toContain('Also on Telegram');
      expect(q('lucy-bubble-card-open')!.textContent).toBe('Open Lucy');
      expect(q('lucy-bubble-card-later')!.textContent).toBe('Later');
      // The compact card has no text box, no background and no links.
      expect(q('avatar-ask-input')).toBeNull();
      expect(actions()).toEqual(['bubble_card_shown']);
      // The badge is still on the bubble.
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')!.textContent).toBe('1');
    });

    test('a question from Kookr itself says "Kookr asks", not a task name', () => {
      render();
      push([ask('a', { system: 'restart', taskName: undefined })]);
      expect(card()!.textContent).toContain('Kookr asks');
    });

    test('it is announced through the polite status region and never takes keyboard focus', () => {
      render();
      push([ask('a', { question: 'Ship it?' })]);
      expect(card()).not.toBeNull();
      expect(document.activeElement === document.body || !card()!.contains(document.activeElement)).toBe(true);
      const note = q('avatar-ask-announce')!;
      expect(note.parentElement!.getAttribute('role')).toBe('status');
      expect(note.textContent).toContain('Task a asks: Ship it?');
      advance(5000);
      expect(card()!.contains(document.activeElement)).toBe(false);
    });

    test('not while the panel is open', () => {
      render(false);
      push([ask('a')]);
      expect(card()).toBeNull();
    });

    test('opinion requests from finished tasks never grow the bubble', () => {
      render();
      push([ask('op', { taskEnded: true })]);
      expect(card()).toBeNull();
    });

    test('not with Do Not Disturb on: the badge shows, and the card comes when it goes off', () => {
      act(() => enableDnd());
      render();
      push([ask('a')]);
      expect(card()).toBeNull();
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')!.textContent).toBe('1');
      act(() => disableDnd());
      expect(card()).not.toBeNull();
    });

    test('not while the operator is typing: it waits until 2 s after the last key', () => {
      render();
      key('a');
      push([ask('a')]);
      expect(card()).toBeNull();
      advance(TYPING_QUIET_MS - 100);
      expect(card()).toBeNull();
      key('b');
      advance(TYPING_QUIET_MS - 100);
      expect(card()).toBeNull();
      advance(200);
      expect(card()).not.toBeNull();
    });

    test('focus moving into a text field or a terminal also holds it back for 2 s', () => {
      render();
      const field = document.createElement('textarea');
      field.className = 'xterm-helper-textarea';
      document.body.appendChild(field);
      act(() => { field.focus(); });
      push([ask('a')]);
      expect(card()).toBeNull();
      advance(TYPING_QUIET_MS + 50);
      expect(card()).not.toBeNull();
    });

    test('while the tab is hidden nothing happens; it appears on return and only then counts as shown', () => {
      render();
      setVisibility('hidden');
      push([ask('a')]);
      expect(card()).toBeNull();
      expect(sessionStorage.getItem(BUBBLE_GROWN_KEY)).toBeNull();
      expect(actions()).toEqual([]);
      setVisibility('visible');
      expect(card()).not.toBeNull();
      expect(JSON.parse(sessionStorage.getItem(BUBBLE_GROWN_KEY)!)).toEqual(['a:a']);
    });

    test('text from a task is shown as text, never as markup', () => {
      render();
      push([ask('a', { question: '<img src=x onerror="alert(1)"> **bold**', taskName: '<b>Evil</b>', options: ['<i>Yes</i>', 'No'] })]);
      expect(card()!.querySelector('img, b, i')).toBeNull();
      expect(q('avatar-ask-question')!.textContent).toBe('<img src=x onerror="alert(1)"> **bold**');
      expect(all('avatar-ask-option')[0].textContent).toBe('<i>Yes</i>');
    });
  });

  describe('it never answers by accident', () => {
    test('a press in the first 600 ms does nothing; after that the answer is sent', () => {
      render();
      push([ask('a')]);
      advance(100);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      expect(all('avatar-ask-option')[0].getAttribute('aria-disabled')).toBe('true');
      advance(ARMING_MS);
      expect(all('avatar-ask-option')[0].getAttribute('aria-disabled')).toBeNull();
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).toHaveBeenCalledOnce();
      expect(onAnswerAsk).toHaveBeenCalledWith('a', { optionIndex: 0 });
      expect(actions()).toEqual(['bubble_card_shown', 'bubble_card_answered']);
    });

    test('a changed question re-arms the card: the press right after is ignored', () => {
      render();
      push([ask('a')]);
      advance(1000);
      push([ask('a', { question: 'A different question?', options: ['Left', 'Right'] })]);
      advance(100);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      advance(ARMING_MS);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).toHaveBeenCalledWith('a', { optionIndex: 0 });
    });

    test('a second item that takes its place also starts unarmed', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b')]);
      advance(1000);
      click(q('lucy-bubble-card-later'));
      advance(100);
      expect(card()!.textContent).toContain('Task b asks');
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
    });
  });

  describe('Later, Escape and once per item', () => {
    test('"Later" shrinks it back to the bubble with its badge, and the item never grows it again in this tab', () => {
      render();
      push([ask('a')]);
      advance(ARMING_MS + 10);
      click(q('lucy-bubble-card-later'));
      expect(card()).toBeNull();
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')!.textContent).toBe('1');
      expect(actions()).toEqual(['bubble_card_shown', 'bubble_card_dismissed']);
      push([ask('a'), ask('c', { expiresAt: NOW + 60 * MIN })]);
      advance(10_000);
      // The new one grows it; the dismissed one does not.
      expect(card()!.textContent).toContain('Task c asks');
      click(q('lucy-bubble-card-later'));
      push([ask('a'), ask('c')]);
      advance(10_000);
      expect(card()).toBeNull();
      // A rebuilt panel (same tab) remembers too.
      act(() => root!.unmount());
      render();
      advance(10_000);
      expect(card()).toBeNull();
    });

    test('Escape with focus inside the card puts it away, and focus goes to the bubble', () => {
      render();
      push([ask('a')]);
      const later = q<HTMLButtonElement>('lucy-bubble-card-later')!;
      act(() => { later.focus(); });
      key('Escape', later);
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(q('avatar-bubble'));
      expect(actions()).toEqual(['bubble_card_shown', 'bubble_card_dismissed']);
    });

    test('Escape elsewhere on the page does not touch it', () => {
      render();
      push([ask('a')]);
      key('Escape');
      expect(card()).not.toBeNull();
    });

    test('the remembered ids are bounded', () => {
      render();
      const many = Array.from({ length: MAX_REMEMBERED + 20 }, (_, i) => ask(`q${i}`, { expiresAt: NOW + (i + 1) * MIN }));
      for (const item of many) {
        push([item]);
        advance(ARMING_MS + 10);
        if (card()) click(q('lucy-bubble-card-later'));
      }
      expect(JSON.parse(sessionStorage.getItem(BUBBLE_GROWN_KEY)!).length).toBeLessThanOrEqual(MAX_REMEMBERED);
    });
  });

  describe('which one, and the queue', () => {
    test('a live permission prompt first, then the question that closes soonest; "+N more waiting" opens her column', () => {
      render();
      push([ask('late', { expiresAt: NOW + 50 * MIN }), ask('soon', { expiresAt: NOW + 5 * MIN })]);
      pushPermission([permissionCard('req-1')]);
      // The question that was there first already has the card; the prompt waits its turn...
      expect(card()!.textContent).toContain('Task soon asks');
      // ...so start again with both present before the card appears.
      act(() => root!.unmount());
      sessionStorage.clear();
      render();
      expect(q('lucy-bubble-card-permission')).not.toBeNull();
      expect(q('lucy-bubble-card-more')!.textContent).toBe('+2 more waiting');
      click(q('lucy-bubble-card-more'));
      expect(q('avatar-dock')).not.toBeNull();
      expect(actions()).toContain('bubble_card_opened');
    });

    test('the question closing soonest comes first', () => {
      render();
      push([ask('late', { expiresAt: NOW + 50 * MIN }), ask('soon', { expiresAt: NOW + 5 * MIN }), ask('mid', { expiresAt: NOW + 20 * MIN })]);
      expect(card()!.textContent).toContain('Task soon asks');
      expect(q('lucy-bubble-card-more')!.textContent).toBe('+2 more waiting');
    });

    test('an item that arrives while a card is shown waits its turn, and is shown when the first is put away', () => {
      render();
      push([ask('a', { expiresAt: NOW + 20 * MIN })]);
      push([ask('a', { expiresAt: NOW + 20 * MIN }), ask('urgent', { expiresAt: NOW + MIN })]);
      expect(card()!.textContent).toContain('Task a asks');
      expect(q('lucy-bubble-card-more')!.textContent).toBe('+1 more waiting');
      advance(ARMING_MS + 10);
      click(q('lucy-bubble-card-later'));
      expect(card()!.textContent).toContain('Task urgent asks');
      expect(q('lucy-bubble-card-more')!.textContent).toBe('+1 more waiting');
    });

    test('with several waiting there is one card at a time', () => {
      render();
      push([ask('a'), ask('b'), ask('c')]);
      expect(all('lucy-bubble-card')).toHaveLength(1);
    });
  });

  describe('outcomes are said', () => {
    test('after the operator answers: "You answered: ..." for 4 seconds, then the next item', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b')]);
      advance(ARMING_MS + 10);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).toHaveBeenCalledWith('a', { optionIndex: 0 });
      expect(q('avatar-ask-note')!.textContent).toBe('Sending your answer…');
      push([answeredOn('a', 'dashboard'), ask('b')]);
      expect(q('avatar-ask-outcome')!.textContent).toBe('You answered: Yes');
      expect(card()!.textContent).not.toContain('Task b asks');
      advance(OUTCOME_VISIBLE_MS - 100);
      expect(q('avatar-ask-outcome')).not.toBeNull();
      advance(200);
      expect(q('avatar-ask-outcome')).toBeNull();
      expect(card()!.textContent).toContain('Task b asks');
    });

    test('answered on Telegram while the card is up: it says so for 4 seconds instead of vanishing, then the bubble', () => {
      render();
      push([ask('a')]);
      push([answeredOn('a', 'telegram')]);
      expect(q('avatar-ask-outcome')!.textContent).toBe('Answered on Telegram: Yes');
      expect(q('avatar-ask-dismiss')).toBeNull();
      advance(OUTCOME_VISIBLE_MS + 100);
      expect(card()).toBeNull();
    });

    test('expired and withdrawn questions say so too', () => {
      render();
      push([ask('a')]);
      push([ask('a', { state: 'expired', resolution: 'expired', resolvedAt: Date.now() })]);
      expect(q('avatar-ask-outcome')!.textContent).toBe('Expired with no answer');
      advance(OUTCOME_VISIBLE_MS + 100);
      push([ask('b')]);
      push([ask('b', { state: 'cancelled', resolution: 'cancelled', resolvedAt: Date.now() })]);
      expect(q('avatar-ask-outcome')!.textContent).toBe('The task withdrew this question');
    });

    test('a refused answer is shown on the card (already answered elsewhere)', () => {
      render();
      push([ask('a')]);
      advance(ARMING_MS + 10);
      onAnswerAsk.mockReturnValue(false);
      click(all('avatar-ask-option')[0]);
      expect(q('avatar-ask-note')!.textContent).toBe('Not connected to Kookr. Try again in a moment.');
    });
  });

  describe('long content', () => {
    test('a long question is cut to five lines with "Show all" inside the card', () => {
      render();
      push([ask('a', { question: 'Why would anyone? '.repeat(40) })]);
      const question = q('avatar-ask-question')!;
      expect(question.classList.contains('lucy-bubble-clamp')).toBe(true);
      const toggle = q('avatar-ask-show-all')!;
      expect(toggle.textContent).toBe('Show all');
      click(toggle);
      expect(q('avatar-ask-question')!.classList.contains('lucy-bubble-clamp')).toBe(false);
      expect(q('avatar-ask-show-all')!.textContent).toBe('Show less');
      expect(card()!.contains(q('avatar-ask-show-all'))).toBe(true);
    });

    test('a short question has no "Show all"', () => {
      render();
      push([ask('a')]);
      expect(q('avatar-ask-show-all')).toBeNull();
    });

    test('more than four answers: one button "Open Lucy to answer" in their place', () => {
      render();
      push([ask('a', { options: ['One', 'Two', 'Three', 'Four', 'Five'] })]);
      expect(all('avatar-ask-option')).toHaveLength(0);
      expect(q('avatar-ask-open-lucy')!.textContent).toBe('Open Lucy to answer');
      click(q('avatar-ask-open-lucy'));
      expect(q('avatar-dock')).not.toBeNull();
    });

    test('four answers still fit as buttons', () => {
      render();
      push([ask('a', { options: ['One', 'Two', 'Three', 'Four'] })]);
      expect(all('avatar-ask-option')).toHaveLength(4);
    });

    test('an answer label that cannot fit also sends the operator to Lucy', () => {
      render();
      push([ask('a', { options: ['Yes', 'A very long answer that would never fit on a small card without wrapping'] })]);
      expect(all('avatar-ask-option')).toHaveLength(0);
      expect(q('avatar-ask-open-lucy')).not.toBeNull();
    });
  });

  describe('permission prompts', () => {
    test('a live prompt shows the task, the tool, the whole command in a scrollable box, Approve once and Deny', () => {
      render();
      const command = Array.from({ length: 20 }, (_, i) => `echo line ${i}`).join('\n');
      pushPermission([permissionCard('req-1', { command })]);
      const box = q('lucy-bubble-card-permission')!;
      expect(box.textContent).toContain('Task req-1 asks permission');
      expect(box.textContent).toContain('Bash');
      expect(q('lucy-bubble-card-command')!.textContent).toBe(command);
      expect(q('lucy-bubble-card-command')!.classList.contains('lucy-bubble-command')).toBe(true);
      expect(q('lucy-bubble-card-approve')!.textContent).toBe('Approve once');
      expect(q('lucy-bubble-card-deny')!.textContent).toBe('Deny');
    });

    test('Approve once is ignored for 600 ms, then sends the same message as the finding card, bound to the prompt', () => {
      render();
      pushPermission([permissionCard('req-1')]);
      advance(100);
      click(q('lucy-bubble-card-approve'));
      expect(onPermissionChoice).not.toHaveBeenCalled();
      advance(ARMING_MS);
      click(q('lucy-bubble-card-approve'));
      expect(onPermissionChoice).toHaveBeenCalledOnce();
      expect(onPermissionChoice.mock.calls[0][0]).toMatchObject({ type: 'permissionChoice', agentId: 'agent-req-1', keystroke: '1' });
      expect(actions()).toContain('bubble_card_answered');
      expect(q('lucy-bubble-card-note')!.textContent).toContain('Sent');
      // The server's next list drops it: the card says what was chosen, then goes.
      pushPermission([]);
      expect(q('lucy-bubble-card-outcome')!.textContent).toBe('You chose Approve once');
      advance(OUTCOME_VISIBLE_MS + 100);
      expect(card()).toBeNull();
    });

    test('Deny sends the deny key', () => {
      render();
      pushPermission([permissionCard('req-1')]);
      advance(ARMING_MS + 10);
      click(q('lucy-bubble-card-deny'));
      expect(onPermissionChoice.mock.calls[0][0]).toMatchObject({ keystroke: '3' });
    });

    test('a prompt answered in the task while the card is up says so', () => {
      render();
      pushPermission([permissionCard('req-1')]);
      pushPermission([]);
      expect(q('lucy-bubble-card-outcome')!.textContent).toBe('Answered in the task');
    });

    test('a prompt whose five-minute binding has died does not grow the bubble', () => {
      render();
      pushPermission([permissionCard('req-old', {}, 5 * MIN, NOW - 10 * MIN)]);
      expect(card()).toBeNull();
      // Nor one that has no button at all.
      pushPermission([permissionCard('req-nokeys', { approveKey: undefined, denyKey: undefined })]);
      expect(card()).toBeNull();
    });

    test('the buttons timing out while the card is up takes it away without an outcome', () => {
      render();
      pushPermission([permissionCard('req-1', {}, 5 * MIN, NOW)]);
      expect(card()).not.toBeNull();
      advance(5 * MIN + 2000);
      expect(card()).toBeNull();
    });

    test('a command cut short by its source cannot be approved from the bubble; the card says to open the task', () => {
      render();
      pushPermission([permissionCard('req-1', { command: 'rm -rf /tmp/some/very/long/path/…' })]);
      advance(ARMING_MS + 10);
      expect(q('lucy-bubble-card-approve')!.getAttribute('aria-disabled')).toBe('true');
      click(q('lucy-bubble-card-approve'));
      expect(onPermissionChoice).not.toHaveBeenCalled();
      expect(q('lucy-bubble-card-note')!.textContent).toContain('Open the task');
    });

    test('a command is shown as text', () => {
      render();
      pushPermission([permissionCard('req-1', { command: '<script>alert(1)</script>', taskName: '<b>x</b>' })]);
      expect(card()!.querySelector('script, b')).toBeNull();
      expect(q('lucy-bubble-card-command')!.textContent).toBe('<script>alert(1)</script>');
    });
  });

  describe('Open Lucy', () => {
    test('opens the column with the waiting strip unfolded and the soonest question whole', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b')]);
      click(q('lucy-bubble-card-open'));
      expect(q('avatar-bubble')).toBeNull();
      expect(JSON.parse(localStorage.getItem(AVATAR_PANEL_KEY)!).minimized).toBe(false);
      expect(q('avatar-tray-toggle')!.getAttribute('aria-expanded')).toBe('true');
      expect(sessionStorage.getItem(AVATAR_TRAY_EXPANDED_KEY)).toBe('1');
      expect(all('avatar-ask').map((el) => el.dataset.askId)).toEqual(['a']);
      expect(actions()).toEqual(['bubble_card_shown', 'bubble_card_opened']);
      // The question has grown the bubble once: minimising again brings the next one, not that one.
      click(container.querySelector('button[aria-label="Minimise Lucy"]'));
      advance(10_000);
      expect(card()!.textContent).toContain('Task b asks');
      advance(ARMING_MS + 10);
      click(q('lucy-bubble-card-later'));
      advance(10_000);
      expect(card()).toBeNull();
    });
  });

  describe('with the dashboard\'s own count and dialogs', () => {
    test('"+N more waiting" and the badge agree with needsYouCount when it is passed', () => {
      render(true, { needsYouCount: 3 });
      push([ask('a'), ask('b'), ask('c')]);
      expect(q('avatar-bubble')!.querySelector('.avatar-bubble-badge')!.textContent).toBe('3');
      expect(q('lucy-bubble-card-more')!.textContent).toBe('+2 more waiting');
    });

    test('pressing a dashboard row (openLucyOnWaiting) unfolds the strip again after the operator folded it by hand', () => {
      render(false);
      push([ask('a')]);
      const toggle = () => q('avatar-tray-toggle')!;
      click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      act(() => openLucyOnWaiting());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(q('avatar-ask')).not.toBeNull();
    });

    test('"Open Lucy" on the card is the same request as a dashboard row: the panel opens with the strip unfolded', () => {
      render();
      push([ask('a')]);
      click(q('lucy-bubble-card-open'));
      expect(q('avatar-tray-toggle')!.getAttribute('aria-expanded')).toBe('true');
    });

    test('while a modal dialog is open the card is not shown, and it returns when the dialog closes', () => {
      render(true, { dialogOpen: true });
      push([ask('a')]);
      expect(card()).toBeNull();
      expect(actions()).toEqual([]);
      act(() => root!.render(<AvatarDock attentionCount={0} onAnswerAsk={onAnswerAsk} dialogOpen={false} />));
      expect(card()).not.toBeNull();
    });
  });

  describe('review fixes', () => {
    test('the "+N more waiting" line coming or going re-arms the card: a press right after is ignored', () => {
      render();
      push([ask('a')]);
      advance(1000);
      push([ask('a'), ask('b', { expiresAt: NOW + 60 * MIN })]);
      expect(q('lucy-bubble-card-more')).not.toBeNull();
      click(all('avatar-ask-option')[1]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      advance(ARMING_MS + 10);
      push([ask('a')]);
      expect(q('lucy-bubble-card-more')).toBeNull();
      click(all('avatar-ask-option')[1]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      advance(ARMING_MS + 10);
      click(all('avatar-ask-option')[1]);
      expect(onAnswerAsk).toHaveBeenCalledWith('a', { optionIndex: 1 });
    });

    test('the "+N more waiting" line does not change the height of the footer row (nothing moves under the pointer)', () => {
      render();
      push([ask('a')]);
      expect(q('lucy-bubble-card-more')).toBeNull();
      expect(q('lucy-bubble-card-more')?.closest('.lucy-bubble-card-list')).toBeUndefined();
      push([ask('a'), ask('b')]);
      expect(q('lucy-bubble-card-more')!.parentElement!.classList.contains('lucy-bubble-card-actions')).toBe(true);
    });

    test('a prompt card is re-armed by the "+N more" line as well', () => {
      render();
      pushPermission([permissionCard('req-1')]);
      advance(1000);
      push([ask('a')]);
      click(q('lucy-bubble-card-deny'));
      expect(onPermissionChoice).not.toHaveBeenCalled();
    });

    test('re-arm is pinned part by part: only the question, only the options, only a prompt\'s command', () => {
      render();
      push([ask('a')]);
      advance(1000);
      push([ask('a', { question: 'Only the question changed?' })]);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      advance(1000);
      push([ask('a', { question: 'Only the question changed?', options: ['Left', 'Right'] })]);
      click(all('avatar-ask-option')[0]);
      expect(onAnswerAsk).not.toHaveBeenCalled();
      act(() => root!.unmount());
      sessionStorage.clear();
      __resetOperatorAsksForTests();
      render();
      pushPermission([permissionCard('req-9', { command: 'git status' })]);
      advance(1000);
      pushPermission([permissionCard('req-9', { command: 'git push --force' })]);
      click(q('lucy-bubble-card-approve'));
      expect(onPermissionChoice).not.toHaveBeenCalled();
      advance(ARMING_MS + 10);
      pushPermission([permissionCard('req-9', { command: 'git push --force', toolName: 'Write' })]);
      click(q('lucy-bubble-card-approve'));
      expect(onPermissionChoice).not.toHaveBeenCalled();
    });

    test('the 4 seconds of an outcome count only while the tab is visible', () => {
      render();
      push([ask('a')]);
      setVisibility('hidden');
      push([answeredOn('a', 'telegram')]);
      advance(OUTCOME_VISIBLE_MS * 3);
      setVisibility('visible');
      expect(q('avatar-ask-outcome')!.textContent).toBe('Answered on Telegram: Yes');
      advance(OUTCOME_VISIBLE_MS - 100);
      expect(q('avatar-ask-outcome')).not.toBeNull();
      advance(200);
      expect(card()).toBeNull();
    });

    test('keyboard focus goes to the bubble, not the page, when its card is replaced under it', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b')]);
      advance(ARMING_MS + 10);
      const option = all<HTMLButtonElement>('avatar-ask-option')[0];
      act(() => { option.focus(); });
      click(option);
      push([answeredOn('a', 'dashboard'), ask('b')]);
      expect(document.activeElement).toBe(q('avatar-bubble'));
      advance(OUTCOME_VISIBLE_MS + 100);
      expect(card()!.textContent).toContain('Task b asks');
    });

    test('focus resting on Later survives the outcome swap by going to the bubble', () => {
      render();
      push([ask('a')]);
      const later = q<HTMLButtonElement>('lucy-bubble-card-later')!;
      act(() => { later.focus(); });
      push([answeredOn('a', 'telegram')]);
      advance(OUTCOME_VISIBLE_MS + 100);
      expect(card()).toBeNull();
      expect(document.activeElement).toBe(q('avatar-bubble'));
    });

    test('a URL in a question is plain text on the card, not a link', () => {
      render();
      push([ask('a', { question: 'Deploy? see https://evil.example/x now' })]);
      expect(card()!.querySelector('a')).toBeNull();
      expect(q('avatar-ask-question')!.textContent).toBe('Deploy? see https://evil.example/x now');
    });

    test('"Later" is held back after one card replaces another', () => {
      render();
      push([ask('a', { expiresAt: NOW + 5 * MIN }), ask('b')]);
      advance(ARMING_MS + 10);
      click(q('lucy-bubble-card-later'));
      expect(card()!.textContent).toContain('Task b asks');
      click(q('lucy-bubble-card-later'));
      expect(card()!.textContent).toContain('Task b asks');
    });

    test('a question whose answer could not be sent is not logged as answered from the bubble', () => {
      render();
      push([ask('a')]);
      advance(ARMING_MS + 10);
      onAnswerAsk.mockReturnValue(false);
      click(all('avatar-ask-option')[0]);
      expect(actions()).toEqual(['bubble_card_shown']);
    });

    test('a component dialog open before the item arrives: nothing is marked, logged or announced until it closes', async () => {
      let open = true;
      const dashboardDialogOpen = () => open;
      localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
      __resetAvatarPanelPrefsForTests();
      root = createRoot(container);
      act(() => { root!.render(<AvatarDock attentionCount={0} onAnswerAsk={onAnswerAsk} dashboardDialogOpen={dashboardDialogOpen} />); });
      push([ask('a')]);
      expect(card()).toBeNull();
      expect(actions()).toEqual([]);
      expect(sessionStorage.getItem(BUBBLE_GROWN_KEY)).toBeNull();
      expect(q('avatar-ask-announce')).toBeNull();
      open = false;
      act(() => { document.body.appendChild(document.createElement('div')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      expect(card()).not.toBeNull();
      expect(actions()).toEqual(['bubble_card_shown']);
      expect(q('avatar-ask-announce')!.textContent).toContain('Task a asks');
    });
  });
});
