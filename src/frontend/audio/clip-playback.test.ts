// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

import {
  __resetClipPlaybackForTests,
  beginClipPlayback,
  replayClip,
  replayLastClip,
  stopReplay,
} from './clip-playback.js';
import { __resetLastClipForTests, captureLastClip, getClip, getLastClip, getLastClipSnapshot, markClipHeard } from './last-clip.js';
import { __resetSpeechBusForTests, subscribeSpeechBus, type SpeechBusEvent } from './speech-bus.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from './sound-preference.js';
import { AVATAR_PANEL_KEY, __resetAvatarPanelPrefsForTests } from '../store/avatar-panel-prefs.js';

let now = 0;
let visibility: DocumentVisibilityState = 'visible';

function setVisibility(value: DocumentVisibilityState): void {
  visibility = value;
  document.dispatchEvent(new Event('visibilitychange'));
}

const ofType = (type: string) => tracked.filter((event) => event.type === type);

describe('beginClipPlayback: heard rules and telemetry', () => {
  beforeEach(() => {
    tracked.length = 0;
    now = 0;
    visibility = 'visible';
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    __resetLastClipForTests();
    localStorage.clear();
    __resetAvatarPanelPrefsForTests();
    captureLastClip({ clipId: 'c1', text: 'hello', audio: new ArrayBuffer(4), durationMs: 10_000 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    __resetAvatarPanelPrefsForTests();
  });

  test('a clip played to the end with the tab visible is heard', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 10_050;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(false);
    expect(ofType('lucy_clip_ended')).toEqual([
      { type: 'lucy_clip_ended', clipId: 'c1', endedBy: 'finished', playedMs: 10_000, totalMs: 10_000 },
    ]);
  });

  test('stopping at 80% or more with the tab visible still counts as heard', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 8_000;
    playback.end('user_stop');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('stopping before 80% leaves it unheard', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 7_900;
    playback.end('user_stop');
    expect(getLastClipSnapshot().unheard).toBe(true);
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ endedBy: 'user_stop', playedMs: 7_900, totalMs: 10_000 });
  });

  test('a clip that played while the tab was hidden stays unheard', () => {
    visibility = 'hidden';
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(true);
    expect(ofType('lucy_clip_started')[0]).toMatchObject({ tabVisible: false });
  });

  test('the tab being hidden for most of the clip leaves it unheard, even if it is visible again at the end', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 1_000;
    setVisibility('hidden');
    now = 9_000;
    setVisibility('visible');
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(true);
  });

  test('a short hidden spell does not stop a clip from being heard', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 4_000;
    setVisibility('hidden');
    now = 5_000;
    setVisibility('visible');
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('without a known length only a finished clip with some visible time is heard', () => {
    const stopped = beginClipPlayback({ clipId: 'c1', totalMs: 0, trigger: 'click' });
    now = 500;
    stopped.end('user_stop');
    expect(getLastClipSnapshot().unheard).toBe(true);

    const finished = beginClipPlayback({ clipId: 'c1', totalMs: 0, trigger: 'click' });
    now = 900;
    finished.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('a superseded clip is heard only if enough of it was visible', () => {
    const short = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 1_000;
    short.end('superseded');
    expect(getLastClipSnapshot().unheard).toBe(true);
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ endedBy: 'superseded' });

    now = 2_000;
    const long = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 10_500;
    long.end('superseded');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('a clip that starts in a hidden tab and is visible for 9 of its 10 seconds is heard', () => {
    visibility = 'hidden';
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 1_000;
    setVisibility('visible');
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('exactly 80% visible counts as heard when the tab is hidden for the rest, including at end()', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 8_000;
    setVisibility('hidden');
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(false);
  });

  test('5 seconds visible and then hidden is not enough', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    now = 5_000;
    setVisibility('hidden');
    now = 10_000;
    playback.end('finished');
    expect(getLastClipSnapshot().unheard).toBe(true);
  });

  test('the visibility listener is removed when the playback ends', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    const listener = add.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
    expect(listener).toBeDefined();
    expect(remove).not.toHaveBeenCalledWith('visibilitychange', listener);
    playback.end('finished');
    expect(remove).toHaveBeenCalledWith('visibilitychange', listener);
  });

  test('end() counts once', () => {
    const playback = beginClipPlayback({ clipId: 'c1', totalMs: 10_000, trigger: 'click' });
    playback.end('finished');
    playback.end('user_stop');
    expect(ofType('lucy_clip_ended')).toHaveLength(1);
  });

  test('started event carries the trigger, panel state and tab visibility', () => {
    beginClipPlayback({ clipId: 'c1', totalMs: 1000, trigger: 'click' });
    expect(ofType('lucy_clip_started')[0]).toEqual({
      type: 'lucy_clip_started', clipId: 'c1', trigger: 'click', panelState: 'off', tabVisible: true,
    });

    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: true, position: null }));
    __resetAvatarPanelPrefsForTests();
    beginClipPlayback({ clipId: 'c1', totalMs: 1000, trigger: 'replay' });
    expect(ofType('lucy_clip_started')[1]).toMatchObject({ trigger: 'replay', panelState: 'minimized' });

    localStorage.setItem(AVATAR_PANEL_KEY, JSON.stringify({ enabled: true, minimized: false, position: null }));
    __resetAvatarPanelPrefsForTests();
    beginClipPlayback({ clipId: 'c1', totalMs: 1000, trigger: 'replay' });
    expect(ofType('lucy_clip_started')[2]).toMatchObject({ panelState: 'open' });
  });
});

type FakeSource = {
  buffer: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static initialState: AudioContextState = 'running';
  static resumeLeavesSuspended = false;
  static decodeFails = false;
  static decodeGate: Promise<void> | null = null;
  state: AudioContextState;
  destination = {};
  analyser = { fftSize: 0, smoothingTimeConstant: 0 };
  sources: FakeSource[] = [];
  constructor() {
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
  createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => {
    if (FakeAudioContext.decodeGate) await FakeAudioContext.decodeGate;
    if (FakeAudioContext.decodeFails) throw new Error('bad audio');
    return { duration: 2 } as AudioBuffer;
  });
  resume = vi.fn(async () => {
    if (!FakeAudioContext.resumeLeavesSuspended) this.state = 'running';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createBufferSource = vi.fn(() => {
    const source: FakeSource = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  });
}

describe('replayLastClip', () => {
  const events: SpeechBusEvent[] = [];

  beforeEach(() => {
    tracked.length = 0;
    events.length = 0;
    now = 0;
    visibility = 'visible';
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = 'running';
    FakeAudioContext.resumeLeavesSuspended = false;
    FakeAudioContext.decodeFails = false;
    FakeAudioContext.decodeGate = null;
    vi.stubGlobal('AudioContext', FakeAudioContext);
    localStorage.clear();
    __resetSoundPreferenceForTests();
    __resetAvatarPanelPrefsForTests();
    __resetSpeechBusForTests();
    __resetClipPlaybackForTests();
    __resetLastClipForTests();
    subscribeSpeechBus((event) => events.push(event));
  });

  afterEach(() => {
    stopReplay('user_stop');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
    setSoundEnabled(true);
    __resetSoundPreferenceForTests();
  });

  function capture(): void {
    captureLastClip({ clipId: 'c1', text: 'Two tasks need you.', audio: new Uint8Array([1, 2, 3]).buffer, durationMs: 2000 });
  }

  test('does nothing without a clip', async () => {
    expect(await replayLastClip()).toBe('no-clip');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('plays the stored audio through the speech bus (speaking, text, loudness tap) and marks it heard at the end', async () => {
    capture();
    expect(await replayLastClip()).toBe('started');

    const ctx = FakeAudioContext.instances[0];
    const source = ctx.sources[0];
    expect(source.start).toHaveBeenCalled();
    expect(source.connect).toHaveBeenCalledWith(ctx.destination);
    expect(source.connect).toHaveBeenCalledWith(ctx.analyser);
    expect(events.map((e) => e.type)).toEqual(['idle', 'playing']);
    expect(events[1]).toEqual({ type: 'playing', analyser: ctx.analyser });
    expect(ofType('lucy_clip_started')[0]).toMatchObject({ clipId: 'c1', trigger: 'replay' });
    expect(getLastClipSnapshot().unheard).toBe(true);

    now = 2_000;
    source.onended?.();
    expect(events.map((e) => e.type)).toEqual(['idle', 'playing', 'idle']);
    expect(getLastClipSnapshot().unheard).toBe(false);
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'c1', endedBy: 'finished', totalMs: 2000 });
    expect(ctx.close).toHaveBeenCalled();
  });

  test('decodes a copy, so the stored bytes survive for the next replay', async () => {
    capture();
    await replayLastClip();
    const ctx = FakeAudioContext.instances[0];
    const passed = ctx.decodeAudioData.mock.calls[0][0] as ArrayBuffer;
    expect(passed).not.toBe(getLastClip()!.audio);
    expect(new Uint8Array(passed)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('resumes a suspended audio context (the click is the user gesture)', async () => {
    capture();
    FakeAudioContext.initialState = 'suspended';
    expect(await replayLastClip()).toBe('started');
    expect(FakeAudioContext.instances[0].resume).toHaveBeenCalled();
  });

  test('is blocked, and reports the clip as unheard, when the browser keeps audio suspended', async () => {
    capture();
    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.resumeLeavesSuspended = true;
    expect(await replayLastClip()).toBe('blocked');
    expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'c1', reason: 'audio_suspended' }]);
    expect(events.map((e) => e.type)).toEqual(['idle']);
    expect(getLastClipSnapshot().unheard).toBe(true);
  });

  test('does not bypass sound being switched off', async () => {
    capture();
    setSoundEnabled(false);
    expect(await replayLastClip()).toBe('muted');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  test('a second press while it plays is ignored', async () => {
    capture();
    await replayLastClip();
    expect(await replayLastClip()).toBe('busy');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  test('a decode failure reports an error and leaves the speech bus idle', async () => {
    capture();
    FakeAudioContext.decodeFails = true;
    expect(await replayLastClip()).toBe('error');
    expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'c1', reason: 'error' }]);
    expect(events.map((e) => e.type)).toEqual(['idle']);
    // and it can be tried again
    FakeAudioContext.decodeFails = false;
    expect(await replayLastClip()).toBe('started');
  });

  test('stopReplay cuts a replay short, tells the bus and records why', async () => {
    capture();
    await replayLastClip();
    now = 500;
    stopReplay('superseded');
    expect(events.map((e) => e.type)).toEqual(['idle', 'playing', 'idle']);
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ endedBy: 'superseded', playedMs: 500 });
    expect(getLastClipSnapshot().unheard).toBe(true);
  });

  test('a live clip arriving while a replay is still decoding cancels it, so it never plays over the live clip', async () => {
    capture();
    let release!: () => void;
    FakeAudioContext.decodeGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = replayLastClip();
    await Promise.resolve();
    stopReplay('superseded');
    release();
    expect(await pending).toBe('cancelled');
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.close).toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual(['idle']);
    expect(ofType('lucy_clip_started')).toEqual([]);
    expect(ofType('lucy_clip_unheard')).toEqual([]);
    // and a later replay works
    FakeAudioContext.decodeGate = null;
    expect(await replayLastClip()).toBe('started');
  });

  test('a replay cancelled by a live clip resolves as cancelled, not error, even when the decode then fails', async () => {
    capture();
    let release!: () => void;
    FakeAudioContext.decodeGate = new Promise<void>((resolve) => { release = resolve; });
    FakeAudioContext.decodeFails = true;
    const pending = replayLastClip();
    await Promise.resolve();
    stopReplay('superseded');
    release();
    expect(await pending).toBe('cancelled');
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
    expect(ofType('lucy_clip_unheard')).toEqual([]);
  });

  test('a replay failing or blocked on a clip that was already heard does not report it as unheard', async () => {
    capture();
    markClipHeard('c1');

    FakeAudioContext.decodeFails = true;
    expect(await replayLastClip()).toBe('error');
    FakeAudioContext.decodeFails = false;

    FakeAudioContext.initialState = 'suspended';
    FakeAudioContext.resumeLeavesSuspended = true;
    expect(await replayLastClip()).toBe('blocked');

    vi.stubGlobal('AudioContext', undefined);
    expect(await replayLastClip()).toBe('error');

    expect(ofType('lucy_clip_unheard')).toEqual([]);
  });

  test('a replay refused because the browser has no audio reports the unheard clip as an error', async () => {
    capture();
    vi.stubGlobal('AudioContext', undefined);
    expect(await replayLastClip()).toBe('error');
    expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'c1', reason: 'error' }]);
  });

  test('closing the panel while a replay is decoding also cancels it', async () => {
    capture();
    let release!: () => void;
    FakeAudioContext.decodeGate = new Promise<void>((resolve) => { release = resolve; });
    const pending = replayLastClip();
    await Promise.resolve();
    stopReplay('user_stop');
    release();
    expect(await pending).toBe('cancelled');
    expect(FakeAudioContext.instances[0].sources).toHaveLength(0);
  });

  test('two presses at once make one replay and one "busy"', async () => {
    capture();
    const results = await Promise.all([replayLastClip(), replayLastClip()]);
    expect(results).toEqual(['started', 'busy']);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  test('stopping a replay and then having its source report the end counts once', async () => {
    capture();
    await replayLastClip();
    const source = FakeAudioContext.instances[0].sources[0];
    now = 500;
    stopReplay('user_stop');
    source.onended?.();
    expect(ofType('lucy_clip_ended')).toHaveLength(1);
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ endedBy: 'user_stop' });
    expect(events.map((e) => e.type)).toEqual(['idle', 'playing', 'idle']);
  });

  test('a newer clip arriving during a replay is not marked heard by the older replay ending', async () => {
    capture();
    await replayLastClip();
    const source = FakeAudioContext.instances[0].sources[0];
    captureLastClip({ clipId: 'c2', text: 'Newer.', audio: new Uint8Array([4]).buffer, durationMs: 2000 });
    now = 2_000;
    source.onended?.();
    expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'c1', endedBy: 'finished' });
    expect(getLastClip()).toMatchObject({ clipId: 'c2', heard: false });
    expect(getLastClipSnapshot().unheard).toBe(true);
    expect(getClip('c1')?.heard).toBe(true);
  });

  describe('replaying a specific clip from the history', () => {
    function captureThree(): void {
      for (const id of ['old', 'mid', 'new']) {
        captureLastClip({ clipId: id, text: `text ${id}`, audio: new Uint8Array([id.length]).buffer, durationMs: 2000 });
      }
    }

    test('an unknown or dropped clip id is "no-clip"', async () => {
      captureThree();
      captureLastClip({ clipId: 'newest', text: 'x', audio: new Uint8Array([9]).buffer, durationMs: 2000 }); // drops "old"
      expect(await replayClip('old')).toBe('no-clip');
      expect(await replayClip('nope')).toBe('no-clip');
      expect(FakeAudioContext.instances).toHaveLength(0);
    });

    test('plays that clip\'s text and audio, reports its id, and marks only that clip heard', async () => {
      captureThree();
      expect(await replayClip('mid')).toBe('started');
      const ctx = FakeAudioContext.instances[0];
      expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
      expect(new Uint8Array(ctx.decodeAudioData.mock.calls[0][0])).toEqual(new Uint8Array([3])); // "mid".length
      expect(events[events.length - 1]).toMatchObject({ type: 'playing' });
      expect(ofType('lucy_clip_started')[0]).toMatchObject({ clipId: 'mid', trigger: 'replay' });

      now = 2_000;
      ctx.sources[0].onended?.();
      expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'mid', endedBy: 'finished' });
      expect(getClip('mid')?.heard).toBe(true);
      expect(getClip('old')?.heard).toBe(false);
      expect(getClip('new')?.heard).toBe(false);
      expect(getLastClipSnapshot()).toMatchObject({ unheardCount: 2 });
    });

    test('replayLastClip replays the newest clip', async () => {
      captureThree();
      expect(await replayLastClip()).toBe('started');
      expect(ofType('lucy_clip_started')[0]).toMatchObject({ clipId: 'new' });
    });

    test('a replay of an older clip that is stopped early leaves every clip unheard', async () => {
      captureThree();
      await replayClip('old');
      now = 500;
      stopReplay('user_stop');
      expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'old', endedBy: 'user_stop' });
      expect(getLastClipSnapshot()).toMatchObject({ unheardCount: 3 });
    });

    test('a second replay (of another clip) while one plays is "busy"', async () => {
      captureThree();
      await replayClip('old');
      expect(await replayClip('new')).toBe('busy');
      expect(FakeAudioContext.instances).toHaveLength(1);
    });

    test('a live clip cancels a replay of an older clip that is still decoding, and nothing is marked heard', async () => {
      captureThree();
      let release!: () => void;
      FakeAudioContext.decodeGate = new Promise<void>((resolve) => { release = resolve; });
      const pending = replayClip('old');
      stopReplay('superseded'); // what a live clip does first
      captureLastClip({ clipId: 'live', text: 'live', audio: new Uint8Array([7]).buffer, durationMs: 2000 });
      release();
      expect(await pending).toBe('cancelled');
      expect(FakeAudioContext.instances[0].sources).toHaveLength(0);
      expect(events.some((e) => e.type === 'playing')).toBe(false);
      expect(getLastClipSnapshot().unheardCount).toBe(3); // old was dropped by the live clip: mid, new, live
    });

    test('a live clip superseding a playing replay of an older clip ends it as superseded and marks nothing heard', async () => {
      captureThree();
      await replayClip('old');
      now = 100;
      stopReplay('superseded');
      captureLastClip({ clipId: 'live', text: 'live', audio: new Uint8Array([7]).buffer, durationMs: 2000 });
      expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'old', endedBy: 'superseded' });
      expect(getClip('live')?.heard).toBe(false);
      expect(getClip('new')?.heard).toBe(false);
    });

    test('failures on an older clip report only that clip as unheard, and only while it is unheard', async () => {
      captureThree();
      FakeAudioContext.decodeFails = true;
      expect(await replayClip('mid')).toBe('error');
      expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'mid', reason: 'error' }]);

      markClipHeard('old');
      expect(await replayClip('old')).toBe('error');
      expect(ofType('lucy_clip_unheard')).toHaveLength(1);
    });
  });
});
