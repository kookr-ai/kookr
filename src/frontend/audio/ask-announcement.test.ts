// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

import {
  HIDDEN_TAB_DELAY_MS,
  SPOKEN_ASKS_STORAGE_KEY,
  __resetAskAnnouncementForTests,
  announceAsk,
  announceLaunchReport,
  stopAllAskAnnouncements,
  stopAskAnnouncement,
} from './ask-announcement.js';
import { AUDIO_UNLOCK_TIMEOUT_MS, __resetClipPlaybackForTests, replayClip, replayingClipId } from './clip-playback.js';
import { __resetLastClipForTests, captureLastClip, getClipHistory } from './last-clip.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from './sound-preference.js';
import { __resetSpeechBusForTests, emitSpeechGenerating, emitSpeechIdle } from './speech-bus.js';
import { __resetDndForTests, enableDnd } from '../hooks/useDnd.js';
import { __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';

type FakeSource = { buffer: unknown; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = 'running';
  state: AudioContextState;
  destination = {};
  sources: FakeSource[] = [];
  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
  createAnalyser = vi.fn(() => ({ fftSize: 0, smoothingTimeConstant: 0 }) as unknown as AnalyserNode);
  static decodeGate: Promise<void> | null = null;
  decodeAudioData = vi.fn(async () => {
    if (FakeAudioContext.decodeGate) await FakeAudioContext.decodeGate;
    return { duration: 2 } as AudioBuffer;
  });
  static resumeNeverSettles = false;
  // The browser's autoplay policy: without a click, resume() leaves the context suspended,
  // and in real Chrome its promise may never settle at all.
  resume = vi.fn(() => (FakeAudioContext.resumeNeverSettles ? new Promise<void>(() => undefined) : Promise.resolve()));
  close = vi.fn(async () => { this.state = 'closed'; });
  createBufferSource = vi.fn(() => {
    const source: FakeSource = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
}

const ASK = 'a1b2c3d4e5f6';
let visibility: DocumentVisibilityState = 'visible';

function speakResponse(over: Record<string, unknown> = {}, status = 200): Response {
  return new Response(JSON.stringify({
    text: 'The task Fix login needs your input. Ship it? You can answer: Yes or No.',
    audioBase64: btoa('RIFFfake'), mimeType: 'audio/wav', durationMs: 2000, clipId: 'clip-ask-1', subject: 'Fix login',
    usedFallback: false, llmMs: 0, ttsMs: 40, cached: false, ...over,
  }), { status, headers: { 'content-type': 'application/json' } });
}

const fetcherOk = () => vi.fn(async () => speakResponse()) as unknown as typeof fetch;
const noWait = async (): Promise<void> => undefined;

describe('announceAsk', () => {
  beforeEach(() => {
    tracked.length = 0;
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.resumeNeverSettles = false;
    FakeAudioContext.decodeGate = null;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    localStorage.clear();
    __resetSoundPreferenceForTests();
    __resetDndForTests();
    __resetAvatarPanelPrefsForTests();
    __resetSpeechBusForTests();
    __resetClipPlaybackForTests();
    __resetLastClipForTests();
    __resetAskAnnouncementForTests();
  });

  afterEach(() => {
    // Here, not in a test's `finally`: a test that hangs under fake timers would otherwise leave them on for the next one.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    __resetDndForTests();
    __resetSoundPreferenceForTests();
  });

  test('fetches the spoken question, plays it and lists it as a message', async () => {
    const fetcher = fetcherOk();
    expect(await announceAsk(ASK, { fetcher })).toBe('started');
    expect(fetcher).toHaveBeenCalledWith(`/api/asks/${ASK}/speak`, expect.objectContaining({ method: 'POST' }));
    expect(FakeAudioContext.instances[0].sources[0].start).toHaveBeenCalledOnce();
    expect(replayingClipId()).toBe('clip-ask-1');
    expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-ask-1', subject: 'Fix login', heard: false });
    expect(tracked.find((e) => e.type === 'lucy_clip_started')).toMatchObject({ clipId: 'clip-ask-1', trigger: 'ask' });
  });

  test('only one of several tabs speaks the same question', async () => {
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
    // A second tab shares localStorage; simulated here by a second call for the same ask.
    const second = fetcherOk();
    expect(await announceAsk(ASK, { fetcher: second })).toBe('other-tab');
    expect(second).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]')).toEqual([ASK]);
  });

  test('a hidden tab waits before claiming, so a visible tab can go first', async () => {
    visibility = 'hidden';
    const sleep = vi.fn(async () => {
      // While this tab waited, a visible tab claimed the question.
      localStorage.setItem(SPOKEN_ASKS_STORAGE_KEY, JSON.stringify([ASK]));
    });
    expect(await announceAsk(ASK, { fetcher: fetcherOk(), sleep })).toBe('other-tab');
    expect(sleep).toHaveBeenCalledWith(HIDDEN_TAB_DELAY_MS);
  });

  test('with sound off nothing plays, and the question waits as an unheard message', async () => {
    setSoundEnabled(false);
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('muted');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-ask-1', heard: false });
    expect(tracked).toContainEqual({ type: 'lucy_clip_unheard', clipId: 'clip-ask-1', reason: 'muted' });
  });

  test('Do Not Disturb silences it the same way', async () => {
    enableDnd(null);
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('dnd');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()).toHaveLength(1);
    expect(tracked).toContainEqual({ type: 'lucy_clip_unheard', clipId: 'clip-ask-1', reason: 'dnd' });
  });

  test('a browser that refuses to start audio leaves the question as an unheard message', async () => {
    FakeAudioContext.initialState = 'suspended';
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('blocked');
    expect(replayingClipId()).toBeNull();
    expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-ask-1', heard: false });
    expect(tracked).toContainEqual({ type: 'lucy_clip_unheard', clipId: 'clip-ask-1', reason: 'audio_suspended' });
  });

  test('a page nobody has clicked in yet does not even try to start audio', async () => {
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('blocked');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-ask-1', heard: false });
    expect(tracked).toContainEqual({ type: 'lucy_clip_unheard', clipId: 'clip-ask-1', reason: 'audio_suspended' });
  });

  test('a browser that never answers the unlock request does not leave replay stuck', async () => {
    vi.useFakeTimers();
    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.resumeNeverSettles = true;
    const pending = announceAsk(ASK, { fetcher: fetcherOk() });
    await vi.advanceTimersByTimeAsync(AUDIO_UNLOCK_TIMEOUT_MS + 10);
    expect(await pending).toBe('blocked');
    // The existing Replay button must still work afterwards (a click unlocks audio).
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.resumeNeverSettles = false;
    expect(await replayClip('clip-ask-1')).toBe('started');
  });

  test('plays in a browser that reports the page as already interacted with (the case in every real browser)', async () => {
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true } });
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  test('tabs agree through a Web Lock when the browser has one, and fall back when it fails', async () => {
    const request = vi.fn(async (_name: string, callback: () => boolean) => callback());
    vi.stubGlobal('navigator', { locks: { request } });
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
    expect(request).toHaveBeenCalledWith('kookr-lucy-ask-claim', expect.any(Function));
    const second = fetcherOk();
    expect(await announceAsk(ASK, { fetcher: second })).toBe('other-tab');
    expect(second).not.toHaveBeenCalled();

    // The first question has been read to the end; a browser whose lock request fails still lets one tab speak.
    FakeAudioContext.instances[0].sources[0].onended?.();
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => { throw new Error('locks unavailable'); }) } });
    expect(await announceAsk('bbbbbbbbbbbb', { fetcher: fetcherOk() })).toBe('started');
    expect(JSON.parse(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]')).toEqual([ASK, 'bbbbbbbbbbbb']);
  });

  test('a question closed while a hidden tab was waiting is neither claimed nor fetched', async () => {
    visibility = 'hidden';
    const fetcher = fetcherOk();
    const sleep = vi.fn(async () => { stopAskAnnouncement(ASK); });
    expect(await announceAsk(ASK, { fetcher, sleep })).toBe('cancelled');
    expect(fetcher).not.toHaveBeenCalled();
    expect(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY)).toBeNull();
  });

  test('a question closed while it waited for her to finish is not started', async () => {
    const speaker = {};
    emitSpeechGenerating(speaker);
    const pending = announceAsk(ASK, { fetcher: fetcherOk() });
    await vi.waitFor(() => expect(getClipHistory()).toHaveLength(1));
    stopAskAnnouncement(ASK);
    emitSpeechIdle(speaker);
    expect(await pending).toBe('cancelled');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()).toHaveLength(0);
  });

  test('switching the panel off while the clip is being fetched means it is never played', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })) as unknown as typeof fetch;
    const pending = announceAsk(ASK, { fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    stopAllAskAnnouncements();
    release(speakResponse());
    expect(await pending).toBe('cancelled');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()).toHaveLength(0);
  });

  test('a question that closes while its audio is being prepared is not read out', async () => {
    let finishDecode: () => void = () => undefined;
    FakeAudioContext.decodeGate = new Promise<void>((resolve) => { finishDecode = resolve; });
    const pending = announceAsk(ASK, { fetcher: fetcherOk() });
    await vi.waitFor(() => expect(FakeAudioContext.instances).toHaveLength(1));
    stopAskAnnouncement(ASK);
    finishDecode();
    expect(await pending).toBe('cancelled');
    expect(replayingClipId()).toBeNull();
    expect(getClipHistory()).toHaveLength(0);
  });

  test('a second question is claimed at once, while the first is still being fetched', async () => {
    let answerFirst: (r: Response) => void = () => undefined;
    const fetcher = vi.fn((url: RequestInfo | URL) => (String(url).includes(ASK)
      ? new Promise<Response>((resolve) => { answerFirst = resolve; })
      : Promise.resolve(speakResponse({ clipId: 'clip-ask-2' })))) as unknown as typeof fetch;
    const first = announceAsk(ASK, { fetcher });
    const second = announceAsk('bbbbbbbbbbbb', { fetcher });
    // Both are claimed for this tab before either clip has arrived.
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]')).toEqual([ASK, 'bbbbbbbbbbbb']));
    expect(await second).toBe('started');
    answerFirst(speakResponse());
    FakeAudioContext.instances[0].sources[0].onended?.();
    expect(await first).toBe('started');
  });

  test('closing a question leaves another clip that is playing alone', async () => {
    // Question A gets a clip but is not played (sound off); then the operator replays another message.
    setSoundEnabled(false);
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('muted');
    setSoundEnabled(true);
    captureLastClip({ clipId: 'summary-clip', text: 'A summary', audio: new ArrayBuffer(4), durationMs: 2000 });
    expect(await replayClip('summary-clip')).toBe('started');
    stopAskAnnouncement(ASK);
    expect(replayingClipId()).toBe('summary-clip');
  });

  test('gives the question back to other tabs when the clip could not be fetched', async () => {
    expect(await announceAsk(ASK, { fetcher: vi.fn(async () => speakResponse({}, 502)) as unknown as typeof fetch })).toBe('error');
    expect(JSON.parse(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]')).toEqual([]);
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
  });

  test('waits for Lucy to finish what she is saying before asking', async () => {
    const speaker = {};
    emitSpeechGenerating(speaker);
    const pending = announceAsk(ASK, { fetcher: fetcherOk() });
    await vi.waitFor(() => expect(getClipHistory()).toHaveLength(1));
    expect(FakeAudioContext.instances).toHaveLength(0);
    emitSpeechIdle(speaker);
    expect(await pending).toBe('started');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  test('two questions waiting for her to finish are both spoken, one after the other', async () => {
    const speaker = {};
    emitSpeechGenerating(speaker);
    const fetcher = vi.fn(async (url: RequestInfo | URL) => speakResponse({ clipId: String(url).includes(ASK) ? 'clip-ask-1' : 'clip-ask-2' })) as unknown as typeof fetch;
    const first = announceAsk(ASK, { fetcher });
    const second = announceAsk('bbbbbbbbbbbb', { fetcher });
    // Both clips are fetched at once; neither plays while she is talking.
    await vi.waitFor(() => expect(getClipHistory()).toHaveLength(2));
    expect(FakeAudioContext.instances).toHaveLength(0);
    emitSpeechIdle(speaker);
    expect(await first).toBe('started');
    expect(replayingClipId()).toBe('clip-ask-1');
    // The second one waits while the first is being read, then plays.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(FakeAudioContext.instances).toHaveLength(1);
    FakeAudioContext.instances[0].sources[0].onended?.();
    expect(await second).toBe('started');
    expect(replayingClipId()).toBe('clip-ask-2');
  });

  test('a tab that may not start audio waits before claiming, so a tab that can speak goes first', async () => {
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    const sleep = vi.fn(async () => {
      // While this tab waited, a tab the operator has clicked in claimed the question.
      localStorage.setItem(SPOKEN_ASKS_STORAGE_KEY, JSON.stringify([ASK]));
    });
    const fetcher = fetcherOk();
    expect(await announceAsk(ASK, { fetcher, sleep })).toBe('other-tab');
    expect(sleep).toHaveBeenCalledWith(HIDDEN_TAB_DELAY_MS);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('gives up, leaving an unheard message, when she is still talking after the wait', async () => {
    emitSpeechGenerating({});
    expect(await announceAsk(ASK, { fetcher: fetcherOk(), busyWaitMs: 5 })).toBe('blocked');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-ask-1', heard: false });
  });

  test('stops reading the question out when it is answered meanwhile', async () => {
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
    stopAskAnnouncement(ASK);
    expect(replayingClipId()).toBeNull();
    expect(FakeAudioContext.instances[0].sources[0].stop).toHaveBeenCalled();
    // Nobody heard it to the end, and the question is closed: no unheard marker is left behind.
    expect(getClipHistory()).toHaveLength(0);
  });

  test('a question answered while muted leaves no unheard message behind', async () => {
    setSoundEnabled(false);
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('muted');
    expect(getClipHistory()).toHaveLength(1);
    stopAskAnnouncement(ASK);
    expect(getClipHistory()).toHaveLength(0);
  });

  test('does not stop another clip when a different question closes', async () => {
    expect(await announceAsk(ASK, { fetcher: fetcherOk() })).toBe('started');
    stopAskAnnouncement('ffffffffffff');
    expect(replayingClipId()).toBe('clip-ask-1');
  });

  test('never starts when the question closed while the clip was being fetched', async () => {
    const fetcher = vi.fn(async () => {
      stopAskAnnouncement(ASK);
      return speakResponse();
    }) as unknown as typeof fetch;
    expect(await announceAsk(ASK, { fetcher, sleep: noWait })).toBe('cancelled');
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(getClipHistory()).toHaveLength(0);
  });

  test('reports a closed question (409) and a missing speech service without throwing', async () => {
    expect(await announceAsk(ASK, { fetcher: vi.fn(async () => speakResponse({}, 409)) as unknown as typeof fetch })).toBe('cancelled');
    __resetAskAnnouncementForTests();
    localStorage.clear();
    expect(await announceAsk(ASK, { fetcher: vi.fn(async () => speakResponse({}, 503)) as unknown as typeof fetch })).toBe('error');
    localStorage.clear();
    expect(await announceAsk(ASK, { fetcher: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch })).toBe('error');
    expect(getClipHistory()).toHaveLength(0);
  });

  describe('the report of a task Lucy launched', () => {
    const reportFetcher = (clipId = 'clip-report-1') => vi.fn(async () => speakResponse({ clipId, text: 'The investigation finished.' })) as unknown as typeof fetch;

    test('posts only the task id to the report route and plays the clip', async () => {
      const fetcher = reportFetcher();
      expect(await announceLaunchReport('t9', 'finished', { fetcher })).toBe('started');
      expect(fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetcher).mock.calls[0]!;
      expect(url).toBe('/api/lucy/launch/report/speak');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual({ taskId: 't9' });
      expect(FakeAudioContext.instances[0].sources[0].start).toHaveBeenCalledOnce();
      expect(JSON.parse(localStorage.getItem(SPOKEN_ASKS_STORAGE_KEY) ?? '[]')).toEqual(['report:t9:finished']);
    });

    test('only one tab speaks the same report', async () => {
      expect(await announceLaunchReport('t9', 'finished', { fetcher: reportFetcher() })).toBe('started');
      const second = reportFetcher();
      expect(await announceLaunchReport('t9', 'finished', { fetcher: second })).toBe('other-tab');
      expect(second).not.toHaveBeenCalled();
    });

    test('with sound off the report is kept as an unheard clip, not played', async () => {
      setSoundEnabled(false);
      expect(await announceLaunchReport('t9', 'finished', { fetcher: reportFetcher() })).toBe('muted');
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(getClipHistory()[0]).toMatchObject({ clipId: 'clip-report-1', heard: false });
    });

    test('a report for a second task waits for Lucy to finish, then plays', async () => {
      const first = announceLaunchReport('t1', 'finished', { fetcher: reportFetcher('clip-r1') });
      const second = announceLaunchReport('t2', 'needs_input', { fetcher: reportFetcher('clip-r2') });
      await vi.waitFor(() => expect(replayingClipId()).toBe('clip-r1'));
      expect(FakeAudioContext.instances[0].sources).toHaveLength(1);
      FakeAudioContext.instances[0].sources[0].onended?.();
      emitSpeechIdle();
      expect(await first).toBe('started');
      expect(await second).toBe('started');
      expect(getClipHistory().map((c) => c.clipId)).toEqual(expect.arrayContaining(['clip-r1', 'clip-r2']));
    });
  });
});
