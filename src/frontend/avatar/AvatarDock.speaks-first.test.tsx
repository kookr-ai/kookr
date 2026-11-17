// @vitest-environment happy-dom

/**
 * Lucy writes first and speaks second: what the dock writes into her thread on its own.
 * The rules behind each piece have their own tests (`useLucyBriefing`, `useLucySays`, `unspoken-words`,
 * `operator-presence`); here the dock is checked to be wired to them.
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
vi.mock('../lucy-live/useLucyLive.js', () => ({
  SOUND_OFF_REASON: 'Sound is off in Settings',
  useLucyLive: () => ({
    status: 'off', lucyState: 'idle', operatorText: '', operatorFinal: false, lucyText: '', lastTurnEnd: null,
    timings: { endToFirstAudioMs: null, bargeInStopMs: null }, micLevel: 0, errorMessage: null,
    enabled: false, setEnabled: vi.fn(), unavailableReason: null, serverStatus: { available: false },
  }),
}));
// How a clip is fetched and played is covered in ask-announcement.test.ts; here only how the announcement ended.
const speech = vi.hoisted(() => ({
  announceAsk: vi.fn(async (): Promise<string> => 'started'),
  announcePermissionNotice: vi.fn(async (): Promise<string> => 'started'),
  announceLaunchReport: vi.fn(async (): Promise<string> => 'started'),
  stopAskAnnouncement: vi.fn(),
  stopPermissionNotice: vi.fn(),
  stopAllAskAnnouncements: vi.fn(),
}));
vi.mock('../audio/ask-announcement.js', () => speech);

import { AvatarDock } from './AvatarDock.js';
import { __resetLucyTypedForTests } from './LucyTypedInput.js';
import { __resetLucyBriefingForTests } from './useLucyBriefing.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { LUCY_BRIEFING_PATH } from '../../shared/contracts/lucy-briefing.js';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import { __resetLastClipForTests, captureLastClip } from '../audio/last-clip.js';
import { __resetSoundPreferenceForTests } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests } from '../audio/speech-bus.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';
import { __resetLucyConversationForTests, getConversationEntries } from '../store/lucy-conversation.js';
import { __resetLucyPermissionForTests, handleLucyPermissionCards } from '../store/lucy-permission.js';
import { __resetLucySaysForTests, handleLucySays } from '../store/lucy-says.js';
import { __resetOperatorAsksForTests, handleOperatorAsks } from '../store/operator-asks.js';

const BRIEFING = {
  text: 'Billing migration is stopped on a question. Two more are working.',
  chips: ['Walk me through the question', 'What is everyone working on?'],
  signature: 'sig-1',
  at: 1,
};

function ask(over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Billing migration', question: 'Run the table rename on production now?',
    options: ['Yes', 'No', 'Later'], allowText: false, state: 'pending', createdAt: Date.now() - 1000, expiresAt: Date.now() + 30 * 60_000, ...over,
  };
}

function card(over: Partial<LucyPermissionCardView> = {}): LucyPermissionCardView {
  return { promptId: 'req-aaaa', taskId: 't7', agentId: 'kookr-t7', taskName: 'Fix the login page', toolName: 'Bash', command: 'rm -rf build', since: Date.now() - 60_000, ...over };
}
const NOTICE: LucyPermissionAnnouncement = {
  noticeId: 'perm-1', promptIds: ['req-aaaa'],
  text: 'The task "Fix the login page" is waiting for your permission to use Bash. The command is on my card.',
};

describe('AvatarDock: she writes first', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  /** The messages Lucy wrote on her own, as the thread store holds them. */
  const written = () => getConversationEntries().filter((entry) => entry.kind === 'typed-lucy');
  /** What the thread shows, one string per entry. */
  const lines = () => [...container.querySelectorAll('[data-testid="avatar-thread"] li')].map((li) => {
    // The chat surface adds a time, follow-up buttons and "Open task" to a line: compare the bubble's words only.
    const copy = li.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('button, time').forEach((el) => el.remove());
    return copy.textContent!.replace(/\s+/g, ' ').trim();
  });
  /** How often the briefing route was asked (the dock makes other requests too). */
  const briefingRequests = () => vi.mocked(fetch).mock.calls.filter((call) => String(call[0]) === LUCY_BRIEFING_PATH).length;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const render = async (minimized = false) => {
    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized, position: null }));
    __resetAvatarPanelPrefsForTests();
    root = createRoot(container);
    act(() => { root!.render(<AvatarDock attentionCount={0} />); });
    await settle();
  };
  /** The server answers the briefing route with `briefing`; a number is an error status. Speech routes answer 503. */
  const serve = (briefing: typeof BRIEFING | number) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== LUCY_BRIEFING_PATH) return new Response('{}', { status: 503 });
      return typeof briefing === 'number' ? new Response('{}', { status: briefing }) : new Response(JSON.stringify(briefing), { status: 200 });
    }));
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.clearAllMocks();
    speech.announceAsk.mockResolvedValue('started');
    speech.announcePermissionNotice.mockResolvedValue('started');
    __resetLucyConversationForTests();
    __resetLucyTypedForTests();
    __resetLucyBriefingForTests();
    __resetLucySaysForTests();
    __resetLucyPermissionForTests();
    __resetLastClipForTests();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetOperatorAsksForTests();
    serve(404);
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
    __resetLucyPermissionForTests();
    document.body.innerHTML = '';
  });

  describe('the briefing', () => {
    test('opening the panel writes the briefing in the thread, with its follow-ups stored on the entry', async () => {
      serve(BRIEFING);
      await render();
      expect(lines()).toEqual([`Lucy ${BRIEFING.text}`]);
      expect(written()).toEqual([expect.objectContaining({ status: 'done', text: BRIEFING.text, chips: BRIEFING.chips, briefing: 'sig-1' })]);
      expect(speech.announceAsk).not.toHaveBeenCalled();
    });

    test('a minimised panel writes no briefing', async () => {
      serve(BRIEFING);
      await render(true);
      expect(briefingRequests()).toBe(0);
      expect(written()).toEqual([]);
    });

    test('with Lucy\'s conversation off (404) the thread stays empty', async () => {
      await render();
      expect(briefingRequests()).toBe(1);
      expect(written()).toEqual([]);
    });
  });

  describe('a word about a task she did not launch', () => {
    test('a lucy_says line is written in the thread and remembers its task', async () => {
      await render();
      act(() => {
        handleLucySays({ type: 'lucy_says', id: 'says-1', kind: 'task_wants_review', text: 'Docs link audit says it is finished and wants your review.', taskIds: ['t9'], at: 1 });
      });
      expect(lines()).toEqual(['Lucy Docs link audit says it is finished and wants your review.']);
      expect(written()).toEqual([expect.objectContaining({ status: 'done', taskId: 't9' })]);
    });

    test('it is written while the panel is minimised too, and nothing is spoken for it', async () => {
      await render(true);
      act(() => { handleLucySays({ type: 'lucy_says', id: 'says-2', kind: 'task_failed', text: 'Docs link audit failed.', taskIds: ['t9'], at: 1 }); });
      expect(written().map((entry) => entry.text)).toEqual(['Docs link audit failed.']);
      expect(speech.announceAsk).not.toHaveBeenCalled();
      expect(speech.announcePermissionNotice).not.toHaveBeenCalled();
    });
  });

  describe('a question that could not be spoken', () => {
    test('no clip could be fetched: the question is written in the thread, once, as "<task> asks: <question>"', async () => {
      speech.announceAsk.mockResolvedValue('error');
      await render();
      act(() => { handleOperatorAsks([ask()], ask().id); });
      await settle();
      expect(written()).toEqual([
        expect.objectContaining({ status: 'done', text: 'Billing migration asks: Run the table rename on production now?', taskId: 't1' }),
      ]);
      expect(lines()).toContain('Lucy Billing migration asks: Run the table rename on production now?');
    });

    test.each(['started', 'muted', 'dnd', 'blocked', 'other-tab', 'cancelled', 'live'])(
      'an announcement that ended as "%s" writes nothing extra', async (result) => {
        speech.announceAsk.mockResolvedValue(result);
        await render();
        act(() => { handleOperatorAsks([ask()], ask().id); });
        await settle();
        expect(written()).toEqual([]);
      },
    );

    test('a clip that was fetched but could not be played is in the thread once, as the clip', async () => {
      // What the real announcer does in that case: it fetched the clip through the fetcher it was given, kept it, then failed to play it.
      speech.announceAsk.mockImplementation((async (_askId: string, options: { fetcher: typeof fetch }) => {
        await options.fetcher('/api/asks/a1b2c3d4e5f6/speak', { method: 'POST' });
        captureLastClip({ clipId: 'clip-1', text: 'The task Billing migration needs your input: Run the table rename on production now? Three choices are on my card.', audio: new ArrayBuffer(4), durationMs: 1000 });
        return 'error';
      }) as unknown as () => Promise<string>);
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
        (String(input) === LUCY_BRIEFING_PATH ? new Response('{}', { status: 404 }) : new Response('{"clipId":"clip-1"}', { status: 200 }))));
      await render();
      act(() => { handleOperatorAsks([ask()], ask().id); });
      await settle();
      expect(written()).toEqual([]);
      expect(getConversationEntries().filter((entry) => entry.kind === 'clip')).toHaveLength(1);
    });

    test('a question answered before the failure is known is not written', async () => {
      let fail: (result: string) => void = () => {};
      speech.announceAsk.mockImplementation(() => new Promise<string>((resolve) => { fail = resolve; }));
      await render();
      act(() => { handleOperatorAsks([ask()], ask().id); });
      act(() => { handleOperatorAsks([ask({ state: 'answered', resolution: 'answered', answeredVia: 'telegram', resolvedAt: Date.now(), answer: { kind: 'option', index: 0, label: 'Yes' } })]); });
      await act(async () => { fail('error'); });
      await settle();
      expect(written()).toEqual([]);
    });
  });

  describe('a permission notice that could not be spoken', () => {
    const push = (cards: LucyPermissionCardView[], announce?: LucyPermissionAnnouncement) =>
      act(async () => { handleLucyPermissionCards({ type: 'lucyPermissionCards', cards, ...(announce ? { announce } : {}) }); });

    test('no clip could be fetched: the server\'s sentence is written in the thread, once, about that task', async () => {
      speech.announcePermissionNotice.mockResolvedValue('error');
      await render();
      await push([card()], NOTICE);
      await settle();
      expect(written()).toEqual([expect.objectContaining({ status: 'done', text: NOTICE.text, taskId: 't7' })]);
    });

    test('a notice that was spoken, or kept as an unheard clip, writes nothing extra', async () => {
      for (const result of ['started', 'muted', 'blocked']) {
        speech.announcePermissionNotice.mockResolvedValue(result);
        await render();
        await push([card()], { ...NOTICE, noticeId: `perm-${result}` });
        await settle();
        act(() => root?.unmount());
        __resetLucyPermissionForTests();
      }
      root = null;
      expect(written()).toEqual([]);
    });

    test('a notice whose prompt was answered meanwhile is not written', async () => {
      let fail: (result: string) => void = () => {};
      speech.announcePermissionNotice.mockImplementation(() => new Promise<string>((resolve) => { fail = resolve; }));
      await render();
      await push([card()], NOTICE);
      await push([]);
      await act(async () => { fail('error'); });
      await settle();
      expect(written()).toEqual([]);
    });
  });
});
