// @vitest-environment jsdom

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
// What Lucy says and when is covered in ask-announcement.test.ts; here only that the panel asks for it.
const speech = vi.hoisted(() => ({ announceAsk: vi.fn(async () => 'started'), stopAskAnnouncement: vi.fn() }));
vi.mock('../audio/ask-announcement.js', () => speech);

import { AvatarDock } from './AvatarDock.js';
import { askOutcome, timeLeftText } from './AskCard.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetOperatorAsksForTests, handleOperatorAskResult, handleOperatorAsks } from '../store/operator-asks.js';

const ASK = 'a1b2c3d4e5f6';

function ask(over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id: ASK, taskId: 't1', taskName: 'Fix login', question: 'Ship the migration now?', context: 'Two tables change.',
    options: ['Yes, ship it', 'No, wait'], allowText: true, state: 'pending',
    createdAt: Date.now() - 1000, expiresAt: Date.now() + 29 * 60_000 + 30_000, ...over,
  };
}
const answered = (via: 'telegram' | 'dashboard', over: Partial<OperatorAskView> = {}): OperatorAskView => ask({
  state: 'answered', resolution: 'answered', answeredVia: via, resolvedAt: Date.now(),
  answer: { kind: 'option', index: 0, label: 'Yes, ship it' }, ...over,
});

describe('AvatarDock: questions from tasks (kookr ask)', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onAnswerAsk = vi.fn(() => true);
  const q = <T extends Element = HTMLElement>(testId: string) => container.querySelector<T>(`[data-testid="${testId}"]`);
  const all = <T extends Element = HTMLElement>(testId: string) => [...container.querySelectorAll<T>(`[data-testid="${testId}"]`)];
  const render = (props: { minimized?: boolean; attentionCount?: number } = {}) => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: props.minimized ?? false, position: null }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={props.attentionCount ?? 0} onAnswerAsk={onAnswerAsk} />); });
  };
  const push = (asks: OperatorAskView[], announce?: string) => act(() => { handleOperatorAsks(asks, announce); });
  const click = (element: Element | null | undefined) => act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    onAnswerAsk.mockReturnValue(true);
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    __resetOperatorAsksForTests();
    document.body.innerHTML = '';
  });

  test('shows no question area when no task is asking', () => {
    render();
    expect(q('avatar-asks')).toBeNull();
  });

  test('shows a waiting question with who asks, the background, a button per choice and a text box', () => {
    render();
    push([ask()]);
    const card = q('avatar-ask')!;
    expect(card.dataset.askState).toBe('pending');
    expect(card.textContent).toContain('Fix login asks');
    expect(q('avatar-ask-question')!.textContent).toBe('Ship the migration now?');
    expect(card.querySelector('details')!.textContent).toContain('Two tables change.');
    expect(all('avatar-ask-option').map((b) => b.textContent)).toEqual(['Yes, ship it', 'No, wait']);
    expect(q('avatar-ask-input')).not.toBeNull();
    expect(q('avatar-ask-note')!.textContent).toBe('Also on Telegram. The first answer wins.');
    expect(card.textContent).toContain('29 min left');
    expect(q('avatar-asks')!.getAttribute('aria-label')).toBe('Questions waiting for your answer (1)');
  });

  test('a question without a task name or text answers still reads well', () => {
    render();
    push([ask({ taskName: undefined, allowText: false, context: undefined })]);
    expect(q('avatar-ask')!.textContent).toContain('A task asks');
    expect(q('avatar-ask-input')).toBeNull();
    expect(q('avatar-ask')!.querySelector('details')).toBeNull();
  });

  test('pressing a choice sends that answer once and shows it is on its way', () => {
    render();
    push([ask()]);
    click(all('avatar-ask-option')[1]);
    expect(onAnswerAsk).toHaveBeenCalledWith(ASK, { optionIndex: 1 });
    expect(q('avatar-ask-note')!.textContent).toBe('Sending your answer…');
    expect(all('avatar-ask-option').every((b) => b.getAttribute('aria-disabled') === 'true')).toBe(true);
    click(all('avatar-ask-option')[0]);
    expect(onAnswerAsk).toHaveBeenCalledOnce();
  });

  test('a typed answer is sent trimmed, and an empty one is not sent', () => {
    render();
    push([ask()]);
    const input = q<HTMLInputElement>('avatar-ask-input')!;
    const form = input.closest('form')!;
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onAnswerAsk).not.toHaveBeenCalled();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '  do both  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onAnswerAsk).toHaveBeenCalledWith(ASK, { text: 'do both' });
  });

  test('the card turns into "You answered" once the server confirms', () => {
    render();
    push([ask()]);
    click(all('avatar-ask-option')[0]);
    act(() => { handleOperatorAskResult(ASK, true); });
    push([answered('dashboard')]);
    expect(q('avatar-ask')!.dataset.askState).toBe('answered');
    expect(q('avatar-ask-outcome')!.textContent).toBe('You answered: Yes, ship it');
    expect(all('avatar-ask-option')).toHaveLength(0);
  });

  test('an answer given on Telegram closes the card here and stops Lucy reading the question', () => {
    render();
    push([ask()], ASK);
    push([answered('telegram')]);
    expect(q('avatar-ask-outcome')!.textContent).toBe('Answered on Telegram: Yes, ship it');
    // Told to a screen reader from the panel's always-present status region, not from the card that just appeared.
    expect(q('avatar-ask-announce')!.textContent).toBe('Answered on Telegram: Yes, ship it. Question: Ship the migration now?');
    expect(q('avatar-ask-announce')!.closest('[role="status"]')).not.toBeNull();
    expect(all('avatar-ask-option')).toHaveLength(0);
    expect(speech.stopAskAnnouncement).toHaveBeenCalledWith(ASK);
    expect(q('avatar-asks')!.getAttribute('aria-label')).toBe('Recent questions');
  });

  test('a new question is announced to a screen reader briefly; Lucy speaks the question itself', () => {
    render();
    push([ask()], ASK);
    expect(q('avatar-ask-announce')!.textContent).toBe('New question from Fix login.');
  });

  test('the answers form one group named by its question, so two cards cannot be confused', () => {
    render();
    push([ask(), ask({ id: 'bbbbbbbbbbbb', question: 'Second?' })]);
    const groups = [...container.querySelectorAll('[role="group"]')];
    expect(groups).toHaveLength(2);
    const names = groups.map((group) => document.getElementById(group.getAttribute('aria-labelledby')!)!.textContent);
    expect(names).toEqual(['Ship the migration now?', 'Second?']);
    expect(groups[0].querySelector('[data-testid="avatar-ask-input"]')).not.toBeNull();
    expect(q('avatar-asks')!.getAttribute('role')).toBe('list');
  });

  test('keyboard focus stays on the card when it closes under the pressed button', () => {
    render();
    push([ask()]);
    const option = all<HTMLButtonElement>('avatar-ask-option')[0];
    act(() => { option.focus(); });
    click(option);
    push([answered('dashboard')]);
    expect(document.activeElement).toBe(q('avatar-ask-dismiss'));
  });

  test('keyboard focus moves to the panel, not the top of the page, when the focused card is dismissed', () => {
    render();
    push([answered('telegram')]);
    const dismiss = q<HTMLButtonElement>('avatar-ask-dismiss')!;
    act(() => { dismiss.focus(); });
    click(dismiss);
    expect(document.activeElement).toBe(q('avatar-dock'));
  });

  test('focus is left alone when the operator was not in a card', () => {
    render();
    push([ask()]);
    push([answered('telegram')]);
    expect(document.activeElement).toBe(document.body);
  });

  test('a refused answer says why and leaves the buttons usable', () => {
    render();
    push([ask()]);
    click(all('avatar-ask-option')[0]);
    act(() => { handleOperatorAskResult(ASK, false, 'task_gone'); });
    expect(q('avatar-ask-note')!.textContent).toBe('The task is no longer running, so the answer was not delivered.');
    expect(all('avatar-ask-option')[0].getAttribute('aria-disabled')).toBeNull();
  });

  test('says so when the answer could not leave the browser', () => {
    onAnswerAsk.mockReturnValue(false);
    render();
    push([ask()]);
    click(all('avatar-ask-option')[0]);
    expect(q('avatar-ask-note')!.textContent).toContain('Not connected');
  });

  test('Lucy speaks a question when it is created, not when it is merely listed', () => {
    render();
    push([ask()]);
    expect(speech.announceAsk).not.toHaveBeenCalled();
    push([ask({ id: 'bbbbbbbbbbbb', question: 'Second?' }), ask()], 'bbbbbbbbbbbb');
    expect(speech.announceAsk).toHaveBeenCalledOnce();
    expect(speech.announceAsk).toHaveBeenCalledWith('bbbbbbbbbbbb');
  });

  test('a closed question can be dismissed', () => {
    render();
    push([answered('telegram')]);
    click(q('avatar-ask-dismiss'));
    expect(q('avatar-asks')).toBeNull();
  });

  test('minimised, the bubble counts waiting questions with the findings and names them', () => {
    render({ minimized: true, attentionCount: 2 });
    push([ask(), answered('telegram', { id: 'bbbbbbbbbbbb' })], ASK);
    const bubble = q('avatar-bubble')!;
    expect(bubble.querySelector('.avatar-bubble-badge')!.textContent).toBe('3');
    expect(bubble.getAttribute('aria-label')).toContain('1 question is waiting for your answer');
    expect(speech.announceAsk).toHaveBeenCalledWith(ASK);
  });

  test('words: time left and outcomes', () => {
    expect(timeLeftText(10_000, 0)).toBe('under a minute left');
    expect(timeLeftText(5 * 60_000 + 1, 0)).toBe('5 min left');
    expect(timeLeftText(5 * 3_600_000, 0)).toBe('5 h left');
    expect(askOutcome(ask({ state: 'expired', resolution: 'expired' }))).toEqual({ text: 'Expired with no answer', answered: false });
    expect(askOutcome(ask({ state: 'cancelled', resolution: 'task_gone' })).text).toBe('The task ended before an answer was given');
    expect(askOutcome(ask({ state: 'cancelled', resolution: 'cancelled' })).text).toBe('The task withdrew this question');
    expect(askOutcome(ask({ state: 'answered', answer: { kind: 'text', text: 'do both' } })).text).toBe('Answered on Telegram: do both');
  });
});
