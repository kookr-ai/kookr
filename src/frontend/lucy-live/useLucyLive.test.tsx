// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

import { useLucyLive, type UseLucyLiveResult } from './useLucyLive.js';
import { CONFIRMATION_TIMEOUT_MS } from './lucy-live-session.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests, subscribeSpeechBus, type SpeechBusEvent } from '../audio/speech-bus.js';
import { STT_LANGUAGE_KEY } from '../store/stt-language.js';

// --- Fakes -----------------------------------------------------------------

/** Everything the browser was asked to send, in order, so message order can be asserted. */
const wire: string[] = [];
const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  binaryType = '';
  closed = false;
  constructor(public url: string) { sockets.push(this); }
  send(data: string | ArrayBuffer): void {
    wire.push(typeof data === 'string' ? (JSON.parse(data) as { type: string }).type : 'pcm');
    if (typeof data === 'string') sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(message: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify(message) }); }
  drop(): void { this.readyState = 3; this.onclose?.(); }
}
const sent: Array<Record<string, unknown>> = [];

interface FakeSource {
  buffer: { duration: number; tag: string } | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}
interface FakeGainNode {
  gain: { value: number; cancelScheduledValues: ReturnType<typeof vi.fn>; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const gains: FakeGainNode[] = [];
const contexts: FakeAudioContext[] = [];
const processors: Array<{ onaudioprocess: ((e: unknown) => void) | null }> = [];
const sources: FakeSource[] = [];
/** Decoding a sentence waits for its gate when one exists; lets a test finish decoding out of order. */
const decodeGates = new Map<string, () => void>();
let holdDecoding: Set<string>;

class FakeAudioContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  audioWorklet = undefined;
  closed = false;
  constructor(public options?: { sampleRate?: number }) { contexts.push(this); }
  createMediaStreamSource() { return { connect: vi.fn() }; }
  createScriptProcessor() {
    const processor = { onaudioprocess: null as ((e: unknown) => void) | null, connect: vi.fn(), disconnect: vi.fn() };
    processors.push(processor);
    return processor;
  }
  createBufferSource(): FakeSource {
    const source: FakeSource = { buffer: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null };
    sources.push(source);
    return source;
  }
  createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0 }; }
  createGain(): FakeGainNode {
    const node: FakeGainNode = {
      gain: { value: 1, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    gains.push(node);
    return node;
  }
  async decodeAudioData(bytes: ArrayBuffer): Promise<{ duration: number; tag: string }> {
    const tag = String.fromCharCode(...new Uint8Array(bytes));
    if (holdDecoding.has(tag)) await new Promise<void>((resolve) => decodeGates.set(tag, resolve));
    return { duration: 1, tag };
  }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}

const trackStop = vi.fn();
let getUserMedia: ReturnType<typeof vi.fn>;

// --- Harness ---------------------------------------------------------------

let latest: UseLucyLiveResult;
function Probe(): null {
  latest = useLucyLive();
  return null;
}

let container: HTMLDivElement;
let root: Root | null = null;
let statusResponse: { ok: boolean; body: unknown };

const tick = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await tick();
}

async function turnOn(): Promise<FakeWebSocket> {
  await act(async () => { latest.setEnabled(true); });
  await settle();
  const ws = sockets[sockets.length - 1];
  await act(async () => { ws.open(); ws.receive({ type: 'ready' }); });
  return ws;
}

const FRAME = 512;
function frame(db: number): Float32Array {
  const amplitude = 10 ** (db / 20);
  return Float32Array.from({ length: FRAME }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude));
}
/** Deliver microphone audio, one 32 ms chunk at a time, the way the audio processor would. */
function mic(db: number, ms: number): void {
  const processor = processors[processors.length - 1];
  for (let t = 0; t < ms; t += 32) {
    act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(db) } }); });
  }
}
const QUIET = -65;
const SPEECH = -25;

const b64 = (text: string): string => btoa(text);
function sentence(turnId: string, seq: number, text = `s${seq}`) {
  return { type: 'sentence', turnId, seq, text, wavBase64: b64(`${turnId}:${seq}`), durationMs: 1000 };
}
const lastTurnId = (): string => [...sent].reverse().find((m) => m.type === 'speech_start')!.turnId as string;

/** Run a spoken turn through to `speech_end`. */
function speakTurn(): void {
  mic(QUIET, 500);
  mic(SPEECH, 800);
  mic(QUIET, 800);
}

describe('useLucyLive', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    wire.length = 0;
    sent.length = 0;
    sockets.length = 0;
    contexts.length = 0;
    processors.length = 0;
    sources.length = 0;
    gains.length = 0;
    decodeGates.clear();
    holdDecoding = new Set();
    tracked.length = 0;
    trackStop.mockClear();
    localStorage.clear();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    statusResponse = { ok: true, body: { available: true } };
    getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: trackStop }],
      getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16_000 }) }],
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: statusResponse.ok, json: async () => statusResponse.body })));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('AudioContext', FakeAudioContext);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<Probe />); });
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    vi.unstubAllGlobals();
  });

  test('is off at mount and learns whether the feature exists without opening the microphone', async () => {
    await settle();
    expect(latest.status).toBe('off');
    expect(latest.enabled).toBe(false);
    expect(latest.serverStatus).toEqual({ available: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  test('opens the microphone with echo cancellation, noise suppression and auto gain, then the socket on the same origin', async () => {
    await turnOn();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(sockets[0].url).toBe(`ws://${location.host}/ws/lucy-live`);
    expect(latest.status).toBe('ready');
    expect(sent[0]).toEqual({ type: 'hello', language: 'en' });
  });

  test('says hello in French when dictation is set to French, English for auto', async () => {
    localStorage.setItem(STT_LANGUAGE_KEY, 'fr');
    await turnOn();
    expect(sent[0]).toEqual({ type: 'hello', language: 'fr' });
  });

  test('a normal turn sends hello, speech_start, audio, speech_end in that order, with audio only in between', async () => {
    await turnOn();
    speakTurn();
    const start = wire.indexOf('speech_start');
    const end = wire.indexOf('speech_end');
    expect(wire[0]).toBe('hello');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(wire.slice(1, start)).toEqual([]);
    expect(wire.slice(start + 1, end).every((w) => w === 'pcm')).toBe(true);
    expect(wire.slice(start + 1, end).length).toBeGreaterThan(10);
    expect(wire.slice(end + 1)).toEqual([]);
    // The turn carries one id.
    expect(sent.find((m) => m.type === 'speech_end')!.turnId).toBe(lastTurnId());
  });

  test('a click is withdrawn with speech_cancel, not answered', async () => {
    await turnOn();
    mic(QUIET, 500);
    mic(SPEECH, 192); // starts (>= 150 ms) but is far under the 250 ms minimum
    mic(QUIET, 800);
    expect(wire).toContain('speech_start');
    expect(wire).toContain('speech_cancel');
    expect(wire).not.toContain('speech_end');
    expect(sent.find((m) => m.type === 'speech_cancel')!.turnId).toBe(lastTurnId());
  });

  test('shows the operator transcript and the answer so far, ignoring other turns', async () => {
    const ws = await turnOn();
    speakTurn();
    const id = lastTurnId();
    await act(async () => { ws.receive({ type: 'transcript', turnId: id, text: 'what is', final: false }); });
    expect(latest.operatorText).toBe('what is');
    expect(latest.operatorFinal).toBe(false);
    await act(async () => { ws.receive({ type: 'transcript', turnId: id, text: 'what is up', final: true }); });
    expect(latest.operatorFinal).toBe(true);
    await act(async () => { ws.receive({ type: 'transcript', turnId: 'other', text: 'nope', final: true }); });
    expect(latest.operatorText).toBe('what is up');
    await act(async () => { ws.receive(sentence(id, 0, 'All good.')); ws.receive(sentence(id, 1, 'Two tasks done.')); });
    await settle();
    expect(latest.lucyText).toBe('All good. Two tasks done.');
    await act(async () => { ws.receive({ type: 'turn_done', turnId: id, end: 'answered' }); });
    expect(latest.lastTurnEnd).toBe('answered');
  });

  test('plays sentences in seq order even when decoding finishes out of order, and announces each on the speech bus', async () => {
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    const ws = await turnOn();
    speakTurn();
    const id = lastTurnId();
    holdDecoding = new Set([`${id}:0`]);
    await act(async () => { ws.receive({ type: 'state', state: 'thinking' }); });
    expect(events.at(-1)).toEqual({ type: 'generating' });
    await act(async () => { ws.receive(sentence(id, 0)); ws.receive(sentence(id, 1)); });
    await settle();
    // Sentence 1 is ready but must wait for sentence 0.
    expect(sources).toHaveLength(0);
    await act(async () => { decodeGates.get(`${id}:0`)!(); });
    await settle();
    expect(sources.map((s) => s.buffer!.tag)).toEqual([`${id}:0`, `${id}:1`]);
    const [first, second] = sources;
    const firstStart = first.start.mock.calls[0][0] as number;
    expect(second.start.mock.calls[0][0]).toBeCloseTo(firstStart + 1, 6); // back to back
    // The avatar taps the sentence that is actually playing.
    const playing = events.filter((e) => e.type === 'playing');
    expect(playing).toHaveLength(1);
    expect(first.connect).toHaveBeenCalledTimes(2); // speakers and the loudness tap

    await act(async () => { first.onended!(); });
    expect(events.filter((e) => e.type === 'playing')).toHaveLength(2);
    expect(sent.filter((m) => m.type === 'played')).toEqual([{ type: 'played', turnId: id, seq: 0, complete: true }]);

    await act(async () => { ws.receive({ type: 'state', state: 'idle' }); second.onended!(); });
    expect(sent.filter((m) => m.type === 'played').at(-1)).toEqual({ type: 'played', turnId: id, seq: 1, complete: true });
    expect(events.at(-1)).toEqual({ type: 'idle' });
  });

  test('drops sentences that belong to an earlier turn', async () => {
    const ws = await turnOn();
    speakTurn();
    await act(async () => { ws.receive(sentence('an-old-turn', 0)); });
    await settle();
    expect(sources).toHaveLength(0);
    expect(latest.lucyText).toBe('');
  });

  test('records how long the first sentence took after the operator finished', async () => {
    const ws = await turnOn();
    speakTurn();
    await act(async () => { ws.receive(sentence(lastTurnId(), 0)); });
    await settle();
    expect(latest.timings.endToFirstAudioMs).toBeGreaterThanOrEqual(0);
    expect(tracked.find((e) => e.type === 'lucy_live_timing' && e.kind === 'end_to_first_audio')).toBeTruthy();
  });

  describe('barge-in', () => {
    async function lucyIsSpeaking() {
      const events: SpeechBusEvent[] = [];
      subscribeSpeechBus((e) => events.push(e));
      const ws = await turnOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => {
        ws.receive({ type: 'state', state: 'thinking' });
        ws.receive(sentence(id, 0));
        ws.receive(sentence(id, 1));
        ws.receive({ type: 'state', state: 'speaking' });
      });
      await settle();
      expect(sources).toHaveLength(2);
      wire.length = 0;
      sent.length = 0;
      return { ws, id, events };
    }

    test('stops every sound in the same tick the detector fires, before any server reply', async () => {
      const { events, id } = await lucyIsSpeaking();
      const processor = processors[processors.length - 1];
      // Talk over her frame by frame until the detector fires.
      let stoppedAfterFrames = 0;
      for (let i = 1; i <= 40 && sources[0].stop.mock.calls.length === 0; i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
        stoppedAfterFrames = i;
      }
      // Guarded mode needs about 300 ms (10 frames of 32 ms), not the 150 ms of a normal start.
      expect(stoppedAfterFrames).toBeGreaterThanOrEqual(9);
      expect(stoppedAfterFrames).toBeLessThanOrEqual(11);
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(sources[1].stop).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: 'idle' });
      // The server was told after the stop, in this order, with no reply needed in between.
      expect(wire.filter((w) => w !== 'pcm').slice(0, 3)).toEqual(['played', 'barge_in', 'speech_start']);
      expect(sent.find((m) => m.type === 'played')).toEqual({ type: 'played', turnId: id, seq: 0, complete: false });
      expect(sent.filter((m) => m.type === 'played')).toHaveLength(1); // the queued sentence never began
      expect(lastTurnId()).not.toBe(id);
      expect(latest.timings.bargeInStopMs).not.toBeNull();
      expect(tracked.find((e) => e.type === 'lucy_live_timing' && e.kind === 'barge_in_stop')).toBeTruthy();
    });

    test('ignores sentences of the interrupted turn that arrive afterwards', async () => {
      const { ws, id } = await lucyIsSpeaking();
      mic(-15, 400);
      const sourcesBefore = sources.length;
      await act(async () => { ws.receive(sentence(id, 2)); });
      await settle();
      expect(sources).toHaveLength(sourcesBefore);
    });

    test('a small noise does not interrupt her', async () => {
      await lucyIsSpeaking();
      mic(-48, 1000); // clears the normal start bar but not the higher guarded one
      expect(sources[0].stop).not.toHaveBeenCalled();
      expect(wire).not.toContain('barge_in');
    });
  });

  describe('barge-in with server confirmation', () => {
    const CANDIDATE_FRAMES = 5; // 150 ms of loud sound starts a candidate when Silero confirms

    async function lucyIsSpeaking() {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'silero' } };
      const events: SpeechBusEvent[] = [];
      subscribeSpeechBus((e) => events.push(e));
      const ws = await turnOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => {
        ws.receive({ type: 'state', state: 'thinking' });
        ws.receive(sentence(id, 0));
        ws.receive(sentence(id, 1));
        ws.receive({ type: 'state', state: 'speaking' });
      });
      await settle();
      expect(sources).toHaveLength(2);
      wire.length = 0;
      sent.length = 0;
      tracked.length = 0;
      return { ws, id, events };
    }
    /** Talk over her until the detector fires. */
    function talkOver(): void {
      const processor = processors[processors.length - 1];
      for (let i = 0; i < 40 && !sent.some((m) => m.type === 'speech_start'); i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
      }
    }
    const timing = (kind: string) => tracked.filter((e) => e.type === 'lucy_live_timing' && e.kind === kind);

    test('ducks her within the same tick, starts a candidate after about 150 ms, and does not stop or send barge_in', async () => {
      const { events, id } = await lucyIsSpeaking();
      const processor = processors[processors.length - 1];
      let frames = 0;
      for (let i = 1; i <= 40 && !sent.some((m) => m.type === 'speech_start'); i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
        frames = i;
      }
      expect(frames).toBeGreaterThanOrEqual(CANDIDATE_FRAMES - 1);
      expect(frames).toBeLessThanOrEqual(CANDIDATE_FRAMES + 1);
      const gain = gains[0].gain;
      expect(gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
      const [target, at] = gain.linearRampToValueAtTime.mock.calls[0] as [number, number];
      expect(target).toBe(0.25);
      expect(at - (gain.setValueAtTime.mock.calls[0][1] as number)).toBeCloseTo(0.03, 6);
      expect(sources[0].stop).not.toHaveBeenCalled();
      expect(sources[1].stop).not.toHaveBeenCalled();
      expect(wire).not.toContain('barge_in');
      expect(wire).not.toContain('played');
      expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
      expect(lastTurnId()).not.toBe(id);
      expect(events.at(-1)?.type).not.toBe('idle'); // ducking is not silence
      expect(timing('barge_in_duck')).toHaveLength(1);
      expect(timing('barge_in_stop')).toHaveLength(0);
      // Every sentence goes through the one gain node.
      expect(sources[0].connect.mock.calls[0][0]).toBe(gains[0]);
    });

    test('speech_confirmed stops every sound, reports played, goes idle on the bus and measures the stop from detection', async () => {
      const { ws, id, events } = await lucyIsSpeaking();
      talkOver();
      const candidate = lastTurnId();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: candidate }); });
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(sources[1].stop).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({ type: 'idle' });
      expect(sent.filter((m) => m.type === 'played')).toEqual([{ type: 'played', turnId: id, seq: 0, complete: false }]);
      expect(timing('barge_in_stop')).toHaveLength(1);
      expect(latest.timings.bargeInStopMs).not.toBeNull();
      expect(latest.lastTurnEnd).toBe('interrupted');
      expect(gains[0].gain.value).toBe(1);
      // Words of the interrupted answer that arrive later are dropped; the new turn is the current one.
      const sourcesBefore = sources.length;
      await act(async () => { ws.receive(sentence(id, 2)); });
      await settle();
      expect(sources).toHaveLength(sourcesBefore);
      await act(async () => { ws.receive({ type: 'transcript', turnId: candidate, text: 'stop', final: false }); });
      expect(latest.operatorText).toBe('stop');
    });

    test('speech_rejected turns her back up and the queued sentences keep playing in order', async () => {
      const { ws, id, events } = await lucyIsSpeaking();
      talkOver();
      await act(async () => { ws.receive({ type: 'speech_rejected', turnId: lastTurnId() }); });
      const gain = gains[0].gain;
      expect(gain.linearRampToValueAtTime).toHaveBeenCalledTimes(2);
      expect(gain.linearRampToValueAtTime.mock.calls[1][0]).toBe(1);
      expect(sources[0].stop).not.toHaveBeenCalled();
      expect(events.at(-1)?.type).not.toBe('idle');
      expect(timing('barge_in_rejected')).toHaveLength(1);
      // The answer goes on: a later sentence is queued behind the earlier ones.
      holdDecoding = new Set();
      await act(async () => { ws.receive(sentence(id, 2)); });
      await settle();
      expect(sources).toHaveLength(3);
      const second = sources[1].start.mock.calls[0][0] as number;
      expect(sources[2].start.mock.calls[0][0]).toBeCloseTo(second + 1, 6);
    });

    test('a sentence that arrives while the candidate is pending is still queued', async () => {
      const { ws, id } = await lucyIsSpeaking();
      talkOver();
      await act(async () => { ws.receive(sentence(id, 2)); });
      await settle();
      expect(sources).toHaveLength(3);
    });

    test('a short noise: speech_cancel goes to the server and rejection resumes her', async () => {
      const { ws } = await lucyIsSpeaking();
      mic(-15, 192);
      mic(QUIET, 800);
      expect(wire).toContain('speech_cancel');
      expect(wire).not.toContain('barge_in');
      await act(async () => { ws.receive({ type: 'speech_rejected', turnId: lastTurnId() }); });
      expect(gains[0].gain.linearRampToValueAtTime.mock.calls.at(-1)?.[0]).toBe(1);
      expect(sources[0].stop).not.toHaveBeenCalled();
    });

    test('verdicts for another turn are ignored', async () => {
      const { ws } = await lucyIsSpeaking();
      talkOver();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: 'someone-else' }); ws.receive({ type: 'speech_rejected', turnId: 'someone-else' }); });
      expect(sources[0].stop).not.toHaveBeenCalled();
      expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1);
    });

    describe('with no verdict', () => {
      afterEach(() => { vi.useRealTimers(); });

      test('stops her after the confirmation timeout and tells the server', async () => {
        const { id } = await lucyIsSpeaking();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // after setup, which needs real timers
        talkOver();
        act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS - 10); });
        expect(sources[0].stop).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(20); });
        expect(sources[0].stop).toHaveBeenCalledTimes(1);
        expect(sources[1].stop).toHaveBeenCalledTimes(1);
        expect(wire).toContain('barge_in');
        expect(sent.find((m) => m.type === 'played')).toEqual({ type: 'played', turnId: id, seq: 0, complete: false });
        expect(timing('barge_in_stop')).toHaveLength(1);
      });

      test('a verdict that arrives in time cancels the timeout', async () => {
        const { ws } = await lucyIsSpeaking();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        talkOver();
        act(() => { ws.receive({ type: 'speech_rejected', turnId: lastTurnId() }); });
        act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS * 2); });
        expect(sources[0].stop).not.toHaveBeenCalled();
        expect(wire).not.toContain('barge_in');
      });
    });
  });

  describe('barge-in when the server cannot confirm', () => {
    test('stops her at once and sends barge_in then speech_start, with no ducking', async () => {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'off' } };
      const ws = await turnOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive(sentence(id, 0)); ws.receive({ type: 'state', state: 'speaking' }); });
      await settle();
      wire.length = 0;
      const processor = processors[processors.length - 1];
      for (let i = 0; i < 40 && sources[0].stop.mock.calls.length === 0; i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
      }
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(wire.filter((w) => w !== 'pcm').slice(0, 3)).toEqual(['played', 'barge_in', 'speech_start']);
      expect(sent.find((m) => m.type === 'speech_start')).not.toHaveProperty('lucyAudible');
      expect(gains[0].gain.linearRampToValueAtTime).not.toHaveBeenCalled();
      expect(tracked.some((e) => e.kind === 'barge_in_duck')).toBe(false);
    });
  });

  test('stays off and says why when sound is off in Settings', async () => {
    act(() => { setSoundEnabled(false); });
    await act(async () => { latest.setEnabled(true); });
    await settle();
    expect(latest.status).toBe('unavailable');
    expect(latest.unavailableReason).toBe('Sound is off in Settings');
    expect(latest.enabled).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
  });

  test('reports the server reason when the feature is not available', async () => {
    statusResponse = { ok: true, body: { available: false, reason: 'No speech recogniser configured' } };
    await act(async () => { latest.setEnabled(true); });
    await settle();
    expect(latest.status).toBe('unavailable');
    expect(latest.unavailableReason).toBe('No speech recogniser configured');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  test('reports a denied microphone as an error and lets the operator try again', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'));
    await act(async () => { latest.setEnabled(true); });
    await settle();
    expect(latest.status).toBe('error');
    expect(latest.errorMessage).toBe('Microphone permission denied');
    expect(latest.enabled).toBe(false);
    expect(sockets).toHaveLength(0);
  });

  test('turning off releases the microphone, the socket and the audio', async () => {
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    const ws = await turnOn();
    speakTurn();
    await act(async () => { ws.receive(sentence(lastTurnId(), 0)); });
    await settle();
    expect(events.at(-1)?.type).toBe('playing');
    await act(async () => { latest.setEnabled(false); });
    expect(trackStop).toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    expect(sources[0].stop).toHaveBeenCalled();
    expect(contexts.every((c) => c.closed)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'idle' });
    expect(latest.status).toBe('off');
  });

  test('unmounting does the same cleanup', async () => {
    const ws = await turnOn();
    act(() => { root!.unmount(); });
    root = null;
    expect(trackStop).toHaveBeenCalled();
    expect(ws.closed).toBe(true);
    expect(contexts.every((c) => c.closed)).toBe(true);
  });

  test('reconnects once after an unexpected close, then gives up with a message', async () => {
    const first = await turnOn();
    await act(async () => { first.drop(); });
    expect(latest.status).toBe('connecting');
    await tick(650);
    expect(sockets).toHaveLength(2);
    await act(async () => { sockets[1].open(); sockets[1].receive({ type: 'ready' }); });
    expect(latest.status).toBe('ready');
    await act(async () => { sockets[1].drop(); });
    expect(latest.status).toBe('error');
    expect(latest.errorMessage).toMatch(/Lost the connection/);
    expect(sockets).toHaveLength(2);
    expect(trackStop).toHaveBeenCalled();
  });

  test('a per-turn server error is shown without ending the session', async () => {
    const ws = await turnOn();
    await act(async () => { ws.receive({ type: 'error', code: 'recogniser_failed', message: 'I could not hear that' }); });
    expect(latest.status).toBe('ready');
    expect(latest.errorMessage).toBe('I could not hear that');
  });
});
