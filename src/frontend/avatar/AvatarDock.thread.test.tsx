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
vi.mock('../audio/ask-announcement.js', () => ({
  announceAsk: vi.fn(async () => 'started'),
  announcePermissionNotice: vi.fn(async () => 'started'),
  announceLaunchReport: vi.fn(async () => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
  setLiveAskSpeaker: vi.fn(() => () => {}),
}));

// The conversation engine has its own tests; here the dock is shown the states it can be in.
import type { UseLucyLiveResult } from '../lucy-live/useLucyLive.js';
const live = vi.hoisted(() => ({ current: null as unknown as UseLucyLiveResult, setEnabled: null as unknown as (enabled: boolean) => void }));
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: (): UseLucyLiveResult => live.current,
}));

import { AvatarDock } from './AvatarDock.js';
import { LUCY_CONVERSATION_ID_KEY, __forgetLucyTypedIdInMemoryForTests, __resetLucyTypedForTests, typedConversationId } from './LucyTypedInput.js';
import { __resetLastClipForTests, captureLastClip } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { CUT_OFF_BY_RELOAD_TEXT, __reloadLucyConversationForTests, __resetLucyConversationForTests } from '../store/lucy-conversation.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';

function base(overrides: Partial<UseLucyLiveResult> = {}): UseLucyLiveResult {
  return {
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: live.setEnabled, unavailableReason: null, serverStatus: { available: true },
    ...overrides,
  };
}

const ndjson = (...deltas: string[]): string =>
  [...deltas.map((delta) => ({ type: 'text', delta })), { type: 'done', end: 'answered' }].map((e) => JSON.stringify(e)).join('\n') + '\n';

/** Answers the next requests to `/api/lucy/turn` with these (one per request); anything else, like the settings, is not a turn. */
function answerTurnsWith(...responses: Array<() => Promise<Response>>): void {
  let turn = 0;
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input) !== '/api/lucy/turn') return new Response('{}', { status: 200 });
    const respond = responses[Math.min(turn, responses.length - 1)];
    turn += 1;
    return respond();
  });
}
const reply = (...deltas: string[]) => async () => new Response(ndjson(...deltas), { status: 200 });

describe('AvatarDock: the conversation thread', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
  const thread = () => q('avatar-thread')!;
  /** What the thread shows, one string per entry, oldest first. */
  const lines = () => [...thread().querySelectorAll('li')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());
  const render = () => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
  };
  const update = (next: UseLucyLiveResult) => {
    live.current = next;
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
  };
  const typeAndSend = async (value: string) => {
    const input = q('avatar-typed-input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q('avatar-typed')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const clip = (id: string, text: string) => act(() => { captureLastClip({ clipId: id, text, audio: new ArrayBuffer(4), durationMs: 1000 }); });
  const ask = (over: Partial<OperatorAskView> = {}): OperatorAskView => ({
    id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', question: 'Ship it?', options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30 * 60_000, ...over,
  });

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    live.setEnabled = vi.fn();
    live.current = base();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(ndjson('On it', '.'), { status: 200 })));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    vi.unstubAllGlobals();
    __resetOperatorAsksForTests();
    document.body.innerHTML = '';
  });

  describe('what was typed', () => {
    test('after two typed turns both sentences and both replies are in the thread, in order', async () => {
      answerTurnsWith(reply('Five tasks', ' are running.'), reply('Two of them are pushing.'));
      render();
      await typeAndSend('Give me a status of every running task.');
      await settle();
      await typeAndSend('Which of them are pushing?');
      await settle();
      expect(lines()).toEqual([
        'You Give me a status of every running task.',
        'Lucy Five tasks are running.',
        'You Which of them are pushing?',
        'Lucy Two of them are pushing.',
      ]);
      expect(all('avatar-typed-you')).toHaveLength(2);
      expect(all('avatar-typed-reply')).toHaveLength(2);
    });

    test('sending clears the box, keeps focus in it, and the reply streams into its own entry ("Thinking…" first)', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      answerTurnsWith(async () => {
        await gate;
        return new Response(ndjson('Looking', ' into it.'), { status: 200 });
      });
      render();
      const input = q('avatar-typed-input') as HTMLInputElement;
      input.focus();
      await typeAndSend('investigate the chaining bug');
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(input);
      expect(lines()).toEqual(['You investigate the chaining bug', 'Lucy Thinking…']);

      // A second request while the first is still being answered is not sent.
      expect(q('avatar-typed-send')!.getAttribute('aria-disabled')).toBe('true');
      await typeAndSend('another one');
      expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/lucy/turn')).toHaveLength(1);

      await act(async () => { release(); await new Promise((r) => setTimeout(r, 20)); });
      expect(lines()).toEqual(['You investigate the chaining bug', 'Lucy Looking into it.']);
      expect(q('avatar-typed-send')!.getAttribute('aria-disabled')).toBeNull();
    });

    test('an error shows in the reply\'s place, not in a box that is gone after the next send', async () => {
      answerTurnsWith(async () => new Response(JSON.stringify({ message: 'Lucy is busy.' }), { status: 503 }));
      render();
      await typeAndSend('hello');
      await settle();
      expect(lines()).toEqual(['You hello', 'Lucy Lucy is busy.']);
      expect(q('avatar-typed-error')!.textContent).toContain('Lucy is busy.');
      expect(all('avatar-typed-reply')).toHaveLength(0);
    });

    test('the finished reply is announced from the composer\'s status region, because the thread itself is silent', async () => {
      render();
      const announce = q('avatar-typed-announce')!;
      expect(announce.getAttribute('role')).toBe('status');
      expect(announce.textContent).toBe('');
      await typeAndSend('hello');
      await settle();
      expect(announce.textContent).toBe('On it.');
      expect(thread().getAttribute('aria-live')).toBe('off');
    });

    test('when the feature is off (404) the request is taken back out of the thread and the box goes', async () => {
      answerTurnsWith(async () => new Response(JSON.stringify({ message: 'off' }), { status: 404 }));
      render();
      await typeAndSend('hello');
      await settle();
      expect(q('avatar-typed')).toBeNull();
      expect(lines()).toEqual([]);
    });
  });

  describe('a page reload in the same tab', () => {
    test('keeps the thread and the conversation id, so she still remembers the earlier turns', async () => {
      render();
      await typeAndSend('remember me');
      await settle();
      const id = typedConversationId();
      expect(sessionStorage.getItem(LUCY_CONVERSATION_ID_KEY)).toBe(id);
      expect(localStorage.getItem(LUCY_CONVERSATION_ID_KEY)).toBeNull();

      // What a reload does: the module state is gone, sessionStorage stays.
      act(() => root!.unmount());
      root = null;
      __forgetLucyTypedIdInMemoryForTests();
      __reloadLucyConversationForTests();
      container.innerHTML = '';
      render();
      expect(lines()).toEqual(['You remember me', 'Lucy On it.']);
      expect(typedConversationId()).toBe(id);
      await typeAndSend('and again');
      await settle();
      const bodies = vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/lucy/turn').map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies.map((b) => b.conversationId)).toEqual([id, id]);
    });

    test('an answer that was still arriving does not stay on "Thinking…" forever', () => {
      render();
      act(() => { root!.unmount(); });
      root = null;
      sessionStorage.setItem('kookr:lucyConversation', JSON.stringify([
        { id: 'x1', at: 1, kind: 'typed-you', text: 'long question' },
        { id: 'x2', at: 2, kind: 'typed-lucy', text: '', status: 'pending' },
      ]));
      __reloadLucyConversationForTests();
      container.innerHTML = '';
      render();
      expect(lines()).toEqual(['You long question', `Lucy ${CUT_OFF_BY_RELOAD_TEXT}`]);
    });
  });

  describe('spoken messages while questions wait', () => {
    test('a clip spoken while a question is pending is visible in the thread (the thread no longer hides)', () => {
      render();
      act(() => { handleOperatorAsks([ask(), ask({ id: 'b2b2b2b2b2b2', question: 'Second?', taskEnded: true })]); });
      expect(q('avatar-asks')).not.toBeNull();
      clip('c1', 'Two tasks need you. The build is red.');
      const message = q('avatar-message')!;
      expect(message.querySelector('.avatar-msg-text')!.textContent).toBe('Two tasks need you. The build is red.');
      expect(thread().contains(message)).toBe(true);
      expect(q('avatar-thread-wrap')!.hasAttribute('hidden')).toBe(false);
      expect(q('avatar-hint')).toBeNull();
    });

    test('spoken and typed entries share one list in the order they happened', async () => {
      render();
      clip('c1', 'First, spoken.');
      await typeAndSend('then typed');
      await settle();
      clip('c2', 'Last, spoken.');
      expect(lines().map((l) => l.replace(/said aloud.*$/, '').trim())).toEqual(['First, spoken.', 'You then typed', 'Lucy On it.', 'Last, spoken.']);
    });
  });

  describe('hands-free Talk exchanges', () => {
    const talking = (over: Partial<UseLucyLiveResult> = {}) => base({ enabled: true, status: 'ready', ...over });

    test('every exchange stays in the thread, and the live draft is the last entry while it is in progress', () => {
      render();
      update(talking({ operatorText: 'any news on', operatorFinal: false }));
      expect(lines()).toEqual(['You any news on']);
      expect(q('avatar-live-you')!.getAttribute('data-final')).toBe('false');

      update(talking({ operatorText: 'any news on the build?', operatorFinal: true, lucyText: 'The build' }));
      update(talking({ operatorText: 'any news on the build?', operatorFinal: true, lucyText: 'The build passed.' }));
      expect(lines()).toEqual(['You any news on the build?', 'Lucy The build passed.']);
      expect(q('avatar-live-you')!.getAttribute('data-final')).toBe('true');

      // The session clears both when the next exchange starts; the first exchange stays.
      update(talking({ operatorText: '', operatorFinal: false, lucyText: '' }));
      update(talking({ operatorText: 'and the tests', operatorFinal: false }));
      expect(lines()).toEqual(['You any news on the build?', 'Lucy The build passed.', 'You and the tests']);
      update(talking({ operatorText: 'and the tests?', operatorFinal: true }));
      update(talking({ operatorText: 'and the tests?', operatorFinal: true, lucyText: 'Green.' }));
      expect(lines()).toEqual(['You any news on the build?', 'Lucy The build passed.', 'You and the tests?', 'Lucy Green.']);
    });

    test('the draft stays open while the final transcript is on its way, so it is one entry, not two', () => {
      render();
      update(talking({ operatorText: 'any news', operatorFinal: false }));
      // The session empties the text when the operator stops speaking, then the final one arrives.
      update(talking({ operatorText: '', operatorFinal: false }));
      update(talking({ operatorText: 'any news?', operatorFinal: true }));
      expect(lines()).toEqual(['You any news?']);
    });

    test('a new answer that does not continue the old one is a new entry even if the empty text in between was never seen', () => {
      render();
      update(talking({ lucyText: 'The build passed.' }));
      update(talking({ lucyText: 'The build passed. Tests too.' }));
      update(talking({ lucyText: 'Different answer.' }));
      expect(lines()).toEqual(['Lucy The build passed. Tests too.', 'Lucy Different answer.']);
    });

    test('a draft that never became final goes when Talk is switched off', () => {
      render();
      update(talking({ operatorText: 'half a sent', operatorFinal: false }));
      update(base());
      expect(lines()).toEqual([]);
    });

    test('a notice about Talk is an entry; the same notice twice in a row is one', () => {
      render();
      update(base({ errorMessage: 'The microphone is blocked.' }));
      expect(lines()).toEqual(['The microphone is blocked.']);
      expect(q('avatar-live-notice')!.textContent).toBe('The microphone is blocked.');
      update(base({ errorMessage: null }));
      update(base({ errorMessage: 'The microphone is blocked.' }));
      expect(lines()).toEqual(['The microphone is blocked.']);
    });

    test('everything said while the panel is minimised is in the thread when it opens', () => {
      localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true }));
      __resetAvatarPanelPrefsForTests();
      root = createRoot(container);
      act(() => { root!.render(<AvatarDock attentionCount={0} />); });
      update(talking({ operatorText: 'hello', operatorFinal: true, lucyText: 'Hi.' }));
      update(talking({ operatorText: '', operatorFinal: false, lucyText: '' }));
      act(() => { container.querySelector<HTMLElement>('[data-testid="avatar-bubble"]')!.click(); });
      expect(lines()).toEqual(['You hello', 'Lucy Hi.']);
    });
  });

  describe('scrolling', () => {
    /** happy-dom does no layout: give the scroll region a size so the thread's "am I at the bottom" arithmetic has numbers. */
    function fakeLayout(): { setTop: (top: number) => void; top: () => number } {
      const el = thread();
      let scrollTop = 800;
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 1000 });
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 200 });
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
      return { setTop: (top) => { scrollTop = top; act(() => { el.dispatchEvent(new Event('scroll')); }); }, top: () => scrollTop };
    }

    test('a new entry scrolls to the bottom while the operator is there; scrolled up, it shows a "New message" button instead', () => {
      render();
      clip('c1', 'one');
      const layout = fakeLayout();
      layout.setTop(800); // at the bottom
      clip('c2', 'two');
      expect(layout.top()).toBe(1000);
      expect(q('avatar-thread-new')).toBeNull();

      layout.setTop(100); // scrolled up to read
      clip('c3', 'three');
      expect(layout.top()).toBe(100);
      expect(q('avatar-thread-new')!.textContent).toBe('New message');

      act(() => q('avatar-thread-new')!.click());
      expect(layout.top()).toBe(1000);
      expect(q('avatar-thread-new')).toBeNull();
      expect(document.activeElement).toBe(thread());
    });

    test('scrolling back to the bottom by hand removes the button too', () => {
      render();
      clip('c1', 'one');
      const layout = fakeLayout();
      layout.setTop(0);
      clip('c2', 'two');
      expect(q('avatar-thread-new')).not.toBeNull();
      layout.setTop(790);
      expect(q('avatar-thread-new')).toBeNull();
    });
  });
});
