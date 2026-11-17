// @vitest-environment happy-dom

/**
 * Lucy's column as a chat: bubbles with a time, the line that says what she is doing, short lists in her
 * replies, the welcome and the suggestion buttons, the composer's keys, the one function that sends a typed
 * turn, the conversation shared between tabs, and the slot for cards waiting for a decision.
 */
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
vi.mock('../audio/ask-announcement.js', () => ({
  announceAsk: vi.fn(async () => 'started'),
  announcePermissionNotice: vi.fn(async () => 'started'),
  announceLaunchReport: vi.fn(async () => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  setLiveAskSpeaker: vi.fn(() => () => {}),
}));
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: true },
  }),
}));

import { AvatarDock } from './AvatarDock.js';
import { LucyThread, WELCOME_CHIPS, WELCOME_TEXT, formatClock, replyBlocks } from './LucyThread.js';
import {
  LUCY_CONVERSATION_ID_KEY,
  NO_REPLY_TEXT,
  __forgetLucyTypedIdInMemoryForTests,
  __resetLucyTypedForTests,
  describeLucyTool,
  getLucyTypedState,
  lookedAtText,
  sendLucyTypedText,
  typedConversationId,
} from './LucyTypedInput.js';
import { __resetLastClipForTests } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import {
  LUCY_CONVERSATION_KEY,
  __resetLucyConversationForTests,
  appendConversationEntry,
  getConversationEntries,
  type ConversationEntry,
} from '../store/lucy-conversation.js';
import { __resetLucyLaunchForTests } from '../store/lucy-launch.js';
import { __resetOperatorAsksForTests } from '../store/operator-asks.js';
import { LUCY_LOOK_TOOL_NAMES, LUCY_PROPOSE_LAUNCH_TOOL } from '../../shared/contracts/lucy-turn.js';

const DONE = { type: 'done', end: 'answered' };
const ndjson = (...events: object[]): string => [...events, DONE].map((e) => JSON.stringify(e)).join('\n') + '\n';
const textReply = (text: string): string => ndjson({ type: 'text', delta: text });

/** A turn whose events the test hands over one at a time, as the server streams them. */
function streamedTurn(): { response: Response; push: (event: object) => Promise<void>; end: () => Promise<void> } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  return {
    response: new Response(body, { status: 200 }),
    push: async (event) => { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); await settle(); },
    end: async () => { controller.enqueue(encoder.encode(`${JSON.stringify(DONE)}\n`)); controller.close(); await settle(); },
  };
}

/** A local time today at `hours:minutes:seconds`, as epoch milliseconds. */
const at = (hours: number, minutes: number, seconds = 0): number => new Date(2026, 10, 17, hours, minutes, seconds).getTime();

describe('Lucy\'s column as a chat', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const all = <T extends HTMLElement = HTMLElement>(id: string) => [...container.querySelectorAll<T>(`[data-testid="${id}"]`)];
  const entries = () => [...container.querySelectorAll<HTMLElement>('.avatar-thread-list > li')];
  const turnBodies = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/lucy/turn').map(([, init]) => JSON.parse(String(init?.body)) as { text: string; conversationId: string; input: string });
  const render = () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
  };
  const add = (entry: Parameters<typeof appendConversationEntry>[0]) => act(() => { appendConversationEntry(entry); });
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const input = () => q<HTMLTextAreaElement>('avatar-typed-input')!;
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    act(() => { input().dispatchEvent(event); });
    return event;
  };
  /** Answer every turn with this body; anything else (the settings) is not a turn. */
  const answerTurns = (body: () => Response | Promise<Response>) => vi.mocked(fetch).mockImplementation(async (url) => (
    String(url) === '/api/lucy/turn' ? body() : new Response('{}', { status: 200 })
  ));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLucyLaunchForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (String(url) === '/api/lucy/turn' ? new Response(textReply('On it.'), { status: 200 }) : new Response('{}', { status: 200 }))));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('bubbles', () => {
    test('the operator\'s words are a bubble on the right, hers a bubble on the left, and a screen reader hears who speaks', () => {
      render();
      add({ kind: 'typed-you', text: 'Brief me.', at: at(9, 2) });
      add({ kind: 'typed-lucy', text: 'Three tasks wait.', status: 'done', at: at(9, 3) });
      add({ kind: 'talk-you', text: 'and the build?', final: true, at: at(9, 5) });
      add({ kind: 'talk-lucy', text: 'Green.', at: at(9, 7) });
      const [you, lucy, talkYou, talkLucy] = entries();
      for (const mine of [you, talkYou]) {
        expect(mine.classList.contains('avatar-entry-you')).toBe(true);
        expect(mine.classList.contains('avatar-entry-lucy')).toBe(false);
      }
      for (const hers of [lucy, talkLucy]) {
        expect(hers.classList.contains('avatar-entry-lucy')).toBe(true);
        expect(hers.classList.contains('avatar-entry-you')).toBe(false);
      }
      // Who speaks is said in words that only a screen reader gets; nobody sees a "You" / "Lucy" label.
      const label = (li: HTMLElement) => li.querySelector('.avatar-entry-bubble > .sr-only')!.textContent!.trim();
      expect([you, lucy, talkYou, talkLucy].map(label)).toEqual(['You', 'Lucy', 'You', 'Lucy']);
      expect(container.querySelector('.avatar-live-who')).toBeNull();
      expect(you.querySelector('.avatar-entry-bubble')!.textContent).toBe('You Brief me.');
    });

    test('each bubble shows the local time it was said, as HH:MM', () => {
      render();
      add({ kind: 'typed-you', text: 'one', at: at(9, 2) });
      add({ kind: 'typed-lucy', text: 'two', status: 'done', at: at(14, 30) });
      const times = all('avatar-entry-time');
      expect(times.map((t) => t.textContent)).toEqual(['09:02', '14:30']);
      expect(times[0].tagName).toBe('TIME');
      expect(times[0].getAttribute('datetime')).toBe(new Date(at(9, 2)).toISOString());
      expect(entries()[0].contains(times[0])).toBe(true);
    });

    test('entries from the same speaker within a minute share one time, shown under the last of them', () => {
      render();
      add({ kind: 'typed-lucy', text: 'first', status: 'done', at: at(9, 2, 0) });
      add({ kind: 'typed-lucy', text: 'second', status: 'done', at: at(9, 2, 40) });
      add({ kind: 'typed-lucy', text: 'a minute later', status: 'done', at: at(9, 3, 40) });
      add({ kind: 'typed-you', text: 'mine, same minute', at: at(9, 3, 50) });
      const timeOf = (li: HTMLElement) => li.querySelector('[data-testid="avatar-entry-time"]')?.textContent ?? null;
      // first shares second's; second is 60 s before the third, which is not "within a minute"; the speaker changes after the third.
      expect(entries().map(timeOf)).toEqual([null, '09:02', '09:03', '09:03']);
    });

    test('formatClock pads both parts and uses the 24-hour local clock', () => {
      expect(formatClock(at(0, 5))).toBe('00:05');
      expect(formatClock(at(9, 2))).toBe('09:02');
      expect(formatClock(at(23, 59))).toBe('23:59');
    });

    test('a notice and a launch outcome are lines of their own, not bubbles, and carry no time', () => {
      render();
      add({ kind: 'notice', text: 'The microphone is blocked.' });
      add({ kind: 'launch-outcome', text: 'Cancelled', started: false });
      for (const li of entries()) {
        expect(li.querySelector('.avatar-entry-bubble')).toBeNull();
        expect(li.querySelector('[data-testid="avatar-entry-time"]')).toBeNull();
      }
    });
  });

  describe('what she is doing while a typed turn runs', () => {
    test('one quiet line under the operator\'s message follows the look-ups, then shrinks to "Looked at N things" when her answer starts', async () => {
      const turn = streamedTurn();
      answerTurns(() => turn.response);
      render();
      type('What needs me?');
      press('Enter');
      await settle();
      const doing = () => q('avatar-typed-doing')!;
      // Before anything arrives.
      expect(entries().map((li) => li.dataset.testid)).toEqual(['avatar-typed-you', 'avatar-typed-reply']);
      expect(doing().textContent).toBe('Lucy Thinking…');
      expect(q('avatar-typed-reply')!.querySelector('.avatar-entry-bubble')).toBeNull();

      await turn.push({ type: 'tool_call', id: 'call_9f3a', name: 'read_board', args: {} });
      expect(doing().textContent).toBe('Lucy Reading the board…');
      await turn.push({ type: 'tool_result', id: 'call_9f3a', name: 'read_board', ok: true, summary: '6 tasks, 3 waiting' });
      await turn.push({ type: 'tool_call', id: 'call_77b1', name: 'read_task_output', args: { task: 'kookr-t-4411', lines: 80 } });
      expect(doing().textContent).toBe('Lucy Reading a task’s terminal…');
      await turn.push({ type: 'tool_result', id: 'call_77b1', name: 'read_task_output', ok: true, summary: 'screen of kookr-t-4411' });
      await turn.push({ type: 'tool_call', id: 'call_c0de', name: 'read_questions', args: {} });
      expect(doing().textContent).toBe('Lucy Reading the questions…');
      await turn.push({ type: 'tool_result', id: 'call_c0de', name: 'read_questions', ok: true, summary: '3 questions' });
      // Only one line, however many look-ups.
      expect(all('avatar-typed-doing')).toHaveLength(1);

      await turn.push({ type: 'text', delta: 'Three tasks' });
      expect(doing().textContent).toBe('Looked at 3 things');
      expect(doing().classList.contains('avatar-entry-doing-now')).toBe(false);
      expect(q('avatar-typed-reply')!.querySelector('.avatar-entry-bubble')!.textContent).toBe('Lucy Three tasks');
      await turn.push({ type: 'text', delta: ' wait on you.' });
      await turn.end();
      expect(q('avatar-typed-reply')!.querySelector('.avatar-entry-bubble')!.textContent).toBe('Lucy Three tasks wait on you.');
      expect(doing().textContent).toBe('Looked at 3 things');
      // The line sits between the operator's message and her bubble.
      const reply = q('avatar-typed-reply')!;
      expect(reply.firstElementChild).toBe(doing());
      // Nothing of the ids, handles, arguments or result summaries is ever on screen or kept.
      const shown = q('avatar-thread')!.textContent!;
      // An entry's own id and time are left out of what is searched: one is random and the other is the clock,
      // so either can hold "80" by chance (a time of 1794888074960 did).
      const kept = JSON.stringify(getConversationEntries().map(({ id: _id, at: _at, ...rest }) => rest));
      for (const secret of ['call_9f3a', 'call_77b1', 'kookr-t-4411', '80', '6 tasks', 'read_board', 'read_task_output']) {
        expect(shown).not.toContain(secret);
        expect(kept).not.toContain(secret);
      }
    });

    test('a look-up that failed is not counted, and one look-up is singular', async () => {
      answerTurns(() => new Response(ndjson(
        { type: 'tool_call', id: '1', name: 'read_task', args: {} },
        { type: 'tool_result', id: '1', name: 'read_task', ok: false, summary: 'no such task' },
        { type: 'tool_call', id: '2', name: 'read_board', args: {} },
        { type: 'tool_result', id: '2', name: 'read_board', ok: true, summary: 'ok' },
        { type: 'text', delta: 'Done.' },
      ), { status: 200 }));
      render();
      type('status');
      press('Enter');
      await settle();
      expect(q('avatar-typed-doing')!.textContent).toBe('Looked at 1 thing');
    });

    test('a reply with no look-up at all has no line once it has started', async () => {
      render();
      type('hello');
      press('Enter');
      await settle();
      expect(q('avatar-typed-reply')!.querySelector('.avatar-entry-bubble')!.textContent).toBe('Lucy On it.');
      expect(q('avatar-typed-doing')).toBeNull();
    });

    test('preparing a launch has its own phrase and is not "something she looked at"', async () => {
      const turn = streamedTurn();
      answerTurns(() => turn.response);
      render();
      type('start it');
      press('Enter');
      await settle();
      await turn.push({ type: 'tool_call', id: '1', name: 'propose_launch', args: { secret: 'x' } });
      expect(q('avatar-typed-doing')!.textContent).toBe('Lucy Preparing a task to start…');
      await turn.push({ type: 'tool_result', id: '1', name: 'propose_launch', ok: true, summary: 'Prepared a launch card' });
      await turn.push({ type: 'text', delta: 'Ready.' });
      await turn.end();
      expect(q('avatar-typed-doing')).toBeNull();
    });

    test('every tool she has is given a plain phrase, and a name the model made up gets one that names nothing', () => {
      const phrases = [...LUCY_LOOK_TOOL_NAMES, LUCY_PROPOSE_LAUNCH_TOOL].map(describeLucyTool);
      expect(phrases).toEqual([
        'Reading the board…',
        'Reading a task…',
        'Reading a task’s terminal…',
        'Reading the questions…',
        'Opening a task…',
        'Looking at the projects…',
        'Preparing a task to start…',
      ]);
      for (const invented of ['rm_rf', 'constructor', 'toString', '__proto__', '']) {
        expect(describeLucyTool(invented)).toBe('Looking something up…');
      }
      expect(lookedAtText(1)).toBe('Looked at 1 thing');
      expect(lookedAtText(2)).toBe('Looked at 2 things');
    });

    test('a turn that ends without a word from her says so instead of "Thinking…" for ever', async () => {
      answerTurns(() => new Response(ndjson({ type: 'tool_call', id: '1', name: 'read_board', args: {} }), { status: 200 }));
      render();
      type('hello?');
      press('Enter');
      await settle();
      expect(q('avatar-typed-doing')).toBeNull();
      expect(q('avatar-typed-error')!.textContent).toContain(NO_REPLY_TEXT);
      expect(q('avatar-typed-announce')!.textContent).toBe(NO_REPLY_TEXT);
      expect(getLucyTypedState().busy).toBe(false);
    });
  });

  describe('short lists in her typed replies', () => {
    test('lines that start with "- " or "• " are one compact list; the rest stays text as written', () => {
      render();
      add({ kind: 'typed-lucy', status: 'done', text: 'Three tasks wait:\n- Billing migration: run tonight\n- Invoice export bug\n• Docs link audit\nNothing is running.' });
      const bubble = entries()[0].querySelector('.avatar-entry-bubble')!;
      const list = bubble.querySelector('ul')!;
      expect(bubble.querySelectorAll('ul')).toHaveLength(1);
      expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Billing migration: run tonight', 'Invoice export bug', 'Docs link audit']);
      expect([...bubble.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Three tasks wait:', 'Nothing is running.']);
      // In the order written: text, list, text.
      expect([...bubble.children].filter((el) => !el.classList.contains('sr-only')).map((el) => el.tagName)).toEqual(['P', 'UL', 'P']);
    });

    test('nothing else is interpreted: markup and other markdown in a reply are shown as the characters they are', () => {
      render();
      const text = '<img src=x onerror="window.__pwned = 1"> **bold** `code` [link](https://example.com)\n- <b>item</b> with <script>alert(1)</script>\n# not a heading\n1. not a list';
      add({ kind: 'typed-lucy', status: 'done', text });
      const bubble = entries()[0].querySelector('.avatar-entry-bubble')!;
      expect(bubble.querySelector('img, b, script, a, h1, strong, code, ol')).toBeNull();
      expect(bubble.querySelector('ul li')!.textContent).toBe('<b>item</b> with <script>alert(1)</script>');
      expect(bubble.textContent).toContain('<img src=x onerror="window.__pwned = 1"> **bold** `code` [link](https://example.com)');
      expect(bubble.textContent).toContain('# not a heading\n1. not a list');
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });

    test('replyBlocks: what is and is not a list line', () => {
      expect(replyBlocks('just text\nover two lines')).toEqual([{ kind: 'text', text: 'just text\nover two lines' }]);
      expect(replyBlocks('- a\n- b')).toEqual([{ kind: 'list', items: ['a', 'b'] }]);
      expect(replyBlocks('  - indented\n•   spaced')).toEqual([{ kind: 'list', items: ['indented', 'spaced'] }]);
      // A dash needs a space after it and something to say.
      expect(replyBlocks('-5 tasks\n-\n- \n--- rule')).toEqual([{ kind: 'text', text: '-5 tasks\n-\n- \n--- rule' }]);
      // Text between two lists keeps them apart; blank lines around a list are spacing, not text.
      expect(replyBlocks('- a\n\nthen\n\n- b\n')).toEqual([
        { kind: 'list', items: ['a'] },
        { kind: 'text', text: 'then' },
        { kind: 'list', items: ['b'] },
      ]);
      expect(replyBlocks('')).toEqual([]);
    });

    test('what the operator typed is never turned into a list', () => {
      render();
      add({ kind: 'typed-you', text: '- do this\n- and that' });
      expect(entries()[0].querySelector('ul')).toBeNull();
      expect(entries()[0].querySelector('.avatar-entry-bubble')!.textContent).toBe('You - do this\n- and that');
    });
  });

  describe('an inviting start', () => {
    test('an empty thread shows a short welcome from her and three buttons', () => {
      render();
      const welcome = q('avatar-hint')!;
      expect(welcome.querySelector('.avatar-entry-bubble')!.textContent).toBe(`Lucy ${WELCOME_TEXT}`);
      expect(welcome.textContent).not.toContain('speaker button');
      expect(all('avatar-chip').map((chip) => chip.textContent)).toEqual(['Brief me', 'What needs me right now?', 'What can you do?']);
      expect([...WELCOME_CHIPS]).toEqual(['Brief me', 'What needs me right now?', 'What can you do?']);
      expect(all('avatar-chip').every((chip) => chip.tagName === 'BUTTON')).toBe(true);
    });

    test('pressing one sends exactly that text as a typed turn, and the welcome gives way to the conversation', async () => {
      render();
      act(() => { all('avatar-chip')[1].click(); });
      await settle();
      expect(turnBodies()).toHaveLength(1);
      expect(turnBodies()[0]).toMatchObject({ text: 'What needs me right now?', input: 'typed', conversationId: typedConversationId() });
      expect(q('avatar-hint')).toBeNull();
      expect(entries().map((li) => li.querySelector('.avatar-entry-bubble')!.textContent)).toEqual(['You What needs me right now?', 'Lucy On it.']);
    });

    test('a suggestion button that holds keyboard focus hands it to the thread when its row goes away', async () => {
      render();
      const chip = all('avatar-chip')[1];
      act(() => { chip.focus(); });
      expect(document.activeElement).toBe(chip);
      act(() => { chip.click(); });
      await settle();
      expect(chip.isConnected).toBe(false);
      expect(document.activeElement).toBe(q('avatar-thread'));
    });

    test('focus the operator moved to the text box is not taken back when the row goes away', async () => {
      render();
      const chip = all('avatar-chip')[1];
      act(() => { chip.focus(); });
      act(() => { input().focus(); });
      act(() => { chip.click(); });
      await settle();
      expect(chip.isConnected).toBe(false);
      expect(document.activeElement).toBe(input());
    });

    test('the buttons are gone, with the text box, when typed requests are switched off on the server', async () => {
      answerTurns(() => new Response('{}', { status: 404 }));
      render();
      act(() => { all('avatar-chip')[0].click(); });
      await settle();
      expect(q('avatar-typed')).toBeNull();
      expect(q('avatar-hint')).not.toBeNull();
      expect(all('avatar-chip')).toHaveLength(0);
    });
  });

  describe('suggestion buttons on her messages', () => {
    test('an entry of hers with chips shows them as buttons under the bubble, and a press sends that text', async () => {
      render();
      add({ kind: 'lucy', text: 'Good morning. Three tasks are stopped on a question.', chips: ['Walk me through them', 'What should I do first?'] });
      const message = q('avatar-lucy-message')!;
      const chips = [...message.querySelectorAll<HTMLElement>('[data-testid="avatar-chip"]')];
      expect(chips.map((chip) => chip.textContent)).toEqual(['Walk me through them', 'What should I do first?']);
      // Under the bubble, not inside it.
      expect(message.querySelector('.avatar-entry-bubble')!.contains(chips[0])).toBe(false);
      act(() => { chips[0].click(); });
      await settle();
      expect(turnBodies().map((body) => body.text)).toEqual(['Walk me through them']);
    });

    test('only her newest entry offers them: older suggestions are about a moment that has passed', () => {
      render();
      add({ kind: 'lucy', text: 'Briefing.', chips: ['Old one'] });
      expect(all('avatar-chip').map((chip) => chip.textContent)).toEqual(['Old one']);
      add({ kind: 'typed-lucy', text: 'Reply.', status: 'done', chips: ['New one'] });
      expect(all('avatar-chip').map((chip) => chip.textContent)).toEqual(['New one']);
      add({ kind: 'typed-you', text: 'ok' });
      expect(all('avatar-chip')).toHaveLength(0);
    });

    test('while a reply is arriving a press sends nothing, and the buttons say they are unavailable', async () => {
      const turn = streamedTurn();
      answerTurns(() => turn.response);
      render();
      act(() => { all('avatar-chip')[0].click(); });
      await settle();
      expect(turnBodies()).toHaveLength(1);
      // A message with chips arrives while she is still answering.
      add({ kind: 'lucy', text: 'By the way.', chips: ['Tell me more'] });
      const chip = q('avatar-chip')!;
      expect(chip.getAttribute('aria-disabled')).toBe('true');
      act(() => { chip.click(); });
      await settle();
      expect(turnBodies()).toHaveLength(1);
      await turn.push({ type: 'text', delta: 'Here.' });
      await turn.end();
    });
  });

  describe('sending a typed turn from code', () => {
    test('sendLucyTypedText does what the box does: the sentence and her reply are entries, in one conversation', async () => {
      render();
      let sent = false;
      act(() => { sent = sendLucyTypedText('  Brief me  '); });
      expect(sent).toBe(true);
      await settle();
      expect(turnBodies()).toEqual([{ text: 'Brief me', conversationId: typedConversationId(), input: 'typed' }]);
      expect(getConversationEntries().map((e) => [e.kind, e.text])).toEqual([['typed-you', 'Brief me'], ['typed-lucy', 'On it.']]);
      expect(q('avatar-typed-announce')!.textContent).toBe('On it.');
    });

    test('it works with the panel minimised or not mounted at all', async () => {
      let sent = false;
      await act(async () => { sent = sendLucyTypedText('status?'); await new Promise((r) => setTimeout(r, 20)); });
      expect(sent).toBe(true);
      expect(getConversationEntries().map((e) => e.text)).toEqual(['status?', 'On it.']);
    });

    test('it refuses, and sends nothing, for empty text, while a reply is arriving, and once the feature is off', async () => {
      const turn = streamedTurn();
      answerTurns(() => turn.response);
      render();
      expect(sendLucyTypedText('   ')).toBe(false);
      expect(turnBodies()).toHaveLength(0);
      act(() => { expect(sendLucyTypedText('first')).toBe(true); });
      await settle();
      expect(getLucyTypedState().busy).toBe(true);
      expect(sendLucyTypedText('second')).toBe(false);
      await turn.push({ type: 'text', delta: 'ok' });
      await turn.end();
      expect(getLucyTypedState().busy).toBe(false);
      expect(turnBodies().map((body) => body.text)).toEqual(['first']);

      answerTurns(() => new Response('{}', { status: 404 }));
      act(() => { expect(sendLucyTypedText('third')).toBe(true); });
      await settle();
      expect(getLucyTypedState().off).toBe(true);
      expect(sendLucyTypedText('fourth')).toBe(false);
    });

    test('a fetcher handed in is the one used', async () => {
      const fetcher = vi.fn(async () => new Response(textReply('From the stub.'), { status: 200 }));
      await act(async () => { sendLucyTypedText('hello', { fetcher: fetcher as unknown as typeof fetch }); await new Promise((r) => setTimeout(r, 20)); });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(turnBodies()).toHaveLength(0);
      expect(getConversationEntries().at(-1)!.text).toBe('From the stub.');
    });
  });

  describe('the composer', () => {
    test('is a text area that starts at one line, with the new placeholder', () => {
      render();
      expect(input().tagName).toBe('TEXTAREA');
      expect(input().getAttribute('rows')).toBe('1');
      expect(input().placeholder).toBe('Ask Lucy, or tell her what to do');
      expect(container.querySelector(`label[for="${input().id}"]`)!.textContent).toBe('Type a request to Lucy');
    });

    test('Enter sends and clears the box; the key press is not left to add a line', async () => {
      render();
      type('What is running?');
      const event = press('Enter');
      expect(event.defaultPrevented).toBe(true);
      expect(input().value).toBe('');
      await settle();
      expect(turnBodies().map((body) => body.text)).toEqual(['What is running?']);
    });

    test('Shift+Enter makes a new line: nothing is sent and the key is left to the text area', async () => {
      render();
      type('line one');
      const event = press('Enter', { shiftKey: true });
      expect(event.defaultPrevented).toBe(false);
      await settle();
      expect(turnBodies()).toHaveLength(0);
      expect(input().value).toBe('line one');
      // A request typed over several lines is sent whole.
      type('line one\nline two');
      press('Enter');
      await settle();
      expect(turnBodies().map((body) => body.text)).toEqual(['line one\nline two']);
      expect(entries()[0].querySelector('.avatar-entry-bubble')!.textContent).toBe('You line one\nline two');
    });

    test('an Enter that only confirms a composed character (IME) sends nothing', async () => {
      render();
      type('こん');
      const event = press('Enter', { isComposing: true });
      expect(event.defaultPrevented).toBe(false);
      await settle();
      expect(turnBodies()).toHaveLength(0);
      expect(input().value).toBe('こん');
    });

    test('other keys, and Enter in an empty box, send nothing', async () => {
      render();
      press('Enter');
      type('abc');
      press('a');
      press('Tab');
      await settle();
      expect(turnBodies()).toHaveLength(0);
    });

    test('the Send button still sends, and keeps the cursor in the box', async () => {
      render();
      input().focus();
      type('by button');
      await act(async () => { q('avatar-typed-send')!.click(); });
      await settle();
      expect(turnBodies().map((body) => body.text)).toEqual(['by button']);
      expect(document.activeElement).toBe(input());
    });
  });

  describe('the conversation survives a new tab', () => {
    test('a conversation saved by the browser is there when the panel opens, with the same conversation id', async () => {
      localStorage.setItem(LUCY_CONVERSATION_ID_KEY, 'typed-0123456789abcdef');
      __forgetLucyTypedIdInMemoryForTests();
      // What another tab (or the same one before a restart) left behind.
      localStorage.setItem(LUCY_CONVERSATION_KEY, JSON.stringify([
        { id: 'e1', at: at(9, 2), kind: 'typed-you', text: 'Brief me.' },
        { id: 'e2', at: at(9, 3), kind: 'typed-lucy', text: 'Three tasks wait.', status: 'done' },
      ] satisfies ConversationEntry[]));
      window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_KEY, newValue: localStorage.getItem(LUCY_CONVERSATION_KEY) }));
      render();
      expect(entries().map((li) => li.querySelector('.avatar-entry-bubble')!.textContent)).toEqual(['You Brief me.', 'Lucy Three tasks wait.']);
      expect(q('avatar-hint')).toBeNull();
      type('and now?');
      press('Enter');
      await settle();
      // The server-side memory of the conversation continues: the same id is sent.
      expect(turnBodies()[0].conversationId).toBe('typed-0123456789abcdef');
    });

    test('an entry another tab adds while this one is open appears here without a reload', () => {
      render();
      add({ kind: 'typed-you', text: 'mine' });
      const mine = JSON.parse(localStorage.getItem(LUCY_CONVERSATION_KEY)!) as ConversationEntry[];
      const theirs = [...mine, { id: 'o1', at: Date.now(), kind: 'typed-lucy', text: 'Answered in the other tab.', status: 'done' } satisfies ConversationEntry];
      localStorage.setItem(LUCY_CONVERSATION_KEY, JSON.stringify(theirs));
      act(() => { window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_KEY, newValue: JSON.stringify(theirs) })); });
      expect(entries().map((li) => li.querySelector('.avatar-entry-bubble')!.textContent)).toEqual(['You mine', 'Lucy Answered in the other tab.']);
    });

    test('a conversation id another tab saved is adopted, and a malformed one is not', () => {
      const first = typedConversationId();
      window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_ID_KEY, newValue: 'typed-fromtheothertab' }));
      expect(typedConversationId()).toBe('typed-fromtheothertab');
      window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_ID_KEY, newValue: 'not a valid id!' }));
      window.dispatchEvent(new StorageEvent('storage', { key: LUCY_CONVERSATION_ID_KEY, newValue: null }));
      expect(typedConversationId()).toBe('typed-fromtheothertab');
      expect(first).not.toBe('typed-fromtheothertab');
    });

    test('storage that cannot be read or written still gives a conversation id for this page', () => {
      __forgetLucyTypedIdInMemoryForTests();
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
        removeItem: () => { throw new Error('denied'); },
      });
      const id = typedConversationId();
      expect(id).toMatch(/^typed-[A-Za-z0-9]+$/);
      expect(typedConversationId()).toBe(id);
    });
  });

  describe('scrolling and the slot for cards', () => {
    const base = { clips: [], nowMs: at(9, 0), liveReady: false, connecting: false, replayUnavailable: null, replayReasonId: 'r', onReplay: () => {} };
    const some = (n: number): ConversationEntry[] => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, at: at(9, i), kind: 'typed-you', text: `message ${i}` }));
    /**
     * happy-dom does no layout: for the length of `run`, every element is 200 px tall with 1000 px of content, and
     * remembers where it was scrolled to. Put in place before the thread is first rendered, as a real layout is.
     */
    async function withLayout(run: () => void | Promise<void>): Promise<void> {
      const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
      const tops = new WeakMap<Element, number>();
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 200 });
      Object.defineProperty(proto, 'scrollTop', { configurable: true, get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, v: number) { tops.set(this, v); } });
      try {
        await run();
      } finally {
        // These shadowed the ones every element inherits; taking them away brings those back.
        for (const name of ['scrollHeight', 'clientHeight', 'scrollTop']) delete proto[name];
      }
    }

    test('a thread that opens with a saved conversation starts at the newest entry', async () => {
      await withLayout(() => {
        root = createRoot(container);
        act(() => { root!.render(<LucyThread {...base} entries={some(30)} />); });
        expect(q('avatar-thread')!.scrollTop).toBe(1000);
        expect(q('avatar-thread-new')).toBeNull();
      });
    });

    test('pendingCards is shown after the last entry, inside the scrolling area and outside the list', () => {
      root = createRoot(container);
      act(() => { root!.render(<LucyThread {...base} entries={some(2)} pendingCards={<div data-testid="a-card">Decide</div>} />); });
      const card = q('a-card')!;
      expect(q('avatar-thread')!.contains(card)).toBe(true);
      expect(card.closest('ol')).toBeNull();
      expect(q('avatar-messages')!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Two cards, side by side in the slot, are both there: a second card type is one more child.
      act(() => { root!.render(<LucyThread {...base} entries={some(2)} pendingCards={<><div data-testid="a-card">Decide</div><div data-testid="b-card">Send</div></>} />); });
      expect(q('avatar-thread-cards')!.children).toHaveLength(2);
    });

    test('a card that appears is brought into view even when the operator had scrolled up to read', async () => {
      await withLayout(async () => {
        root = createRoot(container);
        act(() => { root!.render(<LucyThread {...base} entries={some(30)} pendingCards={null} />); });
        const thread = q('avatar-thread')!;
        // The operator scrolls up.
        thread.scrollTop = 100;
        act(() => { thread.dispatchEvent(new Event('scroll')); });
        // A new entry does not pull them down: it shows the "New message" button.
        act(() => { root!.render(<LucyThread {...base} entries={some(31)} pendingCards={null} />); });
        expect(thread.scrollTop).toBe(100);
        expect(q('avatar-thread-new')).not.toBeNull();
        // A card does.
        await act(async () => {
          root!.render(<LucyThread {...base} entries={some(31)} pendingCards={<div data-testid="a-card">Decide</div>} />);
          await new Promise((r) => setTimeout(r, 0));
        });
        expect(thread.scrollTop).toBe(1000);
        expect(q('avatar-thread-new')).toBeNull();
      });
    });

    test('a card that only changes what it says (a countdown) does not pull the operator back down', async () => {
      await withLayout(async () => {
        root = createRoot(container);
        const card = (seconds: number) => <div data-testid="a-card">Starts in {seconds} s</div>;
        await act(async () => { root!.render(<LucyThread {...base} entries={some(30)} pendingCards={card(8)} />); await new Promise((r) => setTimeout(r, 0)); });
        const thread = q('avatar-thread')!;
        thread.scrollTop = 100;
        act(() => { thread.dispatchEvent(new Event('scroll')); });
        await act(async () => { root!.render(<LucyThread {...base} entries={some(30)} pendingCards={card(7)} />); await new Promise((r) => setTimeout(r, 0)); });
        expect(q('a-card')!.textContent).toBe('Starts in 7 s');
        expect(thread.scrollTop).toBe(100);
      });
    });
  });

  describe('the header', () => {
    test('keeps Replay and Minimise, as real buttons with a name each', () => {
      render();
      const buttons = [...container.querySelectorAll<HTMLButtonElement>('.avatar-dock-header button')];
      expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['Replay last message', 'Minimise Lucy']);
      expect(buttons.every((b) => b.classList.contains('avatar-dock-button'))).toBe(true);
    });
  });
});
