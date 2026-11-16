// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

import { useLucyLive, type UseLucyLiveResult } from './useLucyLive.js';
import { CONFIRMATION_TIMEOUT_MS, DUCK_GAIN } from './lucy-live-session.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound-preference.js';
import { __resetSpeechBusForTests, emitSpeechIdle, emitSpeechPlaying, subscribeSpeechBus, type SpeechBusEvent } from '../audio/speech-bus.js';
import { __resetPlayingClipsForTests, clipStarted } from '../audio/playing-clips.js';
import { __resetAskAnnouncementForTests, announceAsk, stopAskAnnouncement } from '../audio/ask-announcement.js';
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
const scriptProcessorSizes: Array<number | undefined> = [];
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
  createScriptProcessor(size?: number) {
    scriptProcessorSizes.push(size);
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
/** What the probe passes to the hook; a test may set it before rendering. */
const probeOptions: Parameters<typeof useLucyLive>[0] = {};
function Probe(): null {
  latest = useLucyLive(probeOptions);
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
    scriptProcessorSizes.length = 0;
    sources.length = 0;
    gains.length = 0;
    decodeGates.clear();
    holdDecoding = new Set();
    tracked.length = 0;
    trackStop.mockClear();
    localStorage.clear();
    __resetSoundPreferenceForTests();
    __resetSpeechBusForTests();
    __resetPlayingClipsForTests();
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

  test('an open request from the server is handed to onOpen and its outcome reported back (#3929)', async () => {
    const onOpen = vi.fn(() => 'blocked' as const);
    probeOptions.onOpen = onOpen;
    try {
      const ws = await turnOn();
      const target = { kind: 'link', url: 'https://claude.ai/artifact/abc' };
      await act(async () => { ws.receive({ type: 'open', requestId: 'open-1', target }); });
      expect(onOpen).toHaveBeenCalledWith(target);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(sent.filter((m) => m.type === 'open_result')).toEqual([{ type: 'open_result', requestId: 'open-1', outcome: 'blocked' }]);
    } finally {
      delete probeOptions.onOpen;
    }
  });

  test('without an onOpen handler an open request is reported as unavailable', async () => {
    const ws = await turnOn();
    await act(async () => { ws.receive({ type: 'open', requestId: 'open-2', target: { kind: 'task', taskId: 't1' } }); });
    expect(sent).toContainEqual({ type: 'open_result', requestId: 'open-2', outcome: 'unavailable' });
  });

  test('the ScriptProcessor fallback asks for 1024-sample chunks', async () => {
    await turnOn();
    expect(scriptProcessorSizes).toEqual([1024]);
  });

  test('with an AudioWorklet the node is built with a 1024-sample buffer and its chunks reach the detector', async () => {
    const port: { onmessage: ((e: { data: unknown }) => void) | null } = { onmessage: null };
    const nodeArgs: unknown[][] = [];
    class WorkletContext extends FakeAudioContext {
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) } as never;
    }
    vi.stubGlobal('AudioContext', WorkletContext);
    vi.stubGlobal('AudioWorkletNode', class {
      port = port;
      connect = vi.fn();
      disconnect = vi.fn();
      constructor(...args: unknown[]) { nodeArgs.push(args.slice(1)); }
    });
    const ws = await turnOn();
    expect(nodeArgs).toEqual([['pcm-processor', { processorOptions: { bufferSize: 1024 } }]]);
    expect(scriptProcessorSizes).toEqual([]);
    expect(processors).toHaveLength(0);
    const chunk = (db: number): Float32Array => Float32Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 10 ** (db / 20) : -(10 ** (db / 20))));
    act(() => { for (let i = 0; i < 16; i++) port.onmessage?.({ data: chunk(QUIET) }); });
    act(() => { for (let i = 0; i < 20; i++) port.onmessage?.({ data: chunk(SPEECH) }); });
    expect(sent.some((m) => m.type === 'speech_start')).toBe(true);
    expect(wire).toContain('pcm');
    expect(ws.closed).toBe(false);
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

  test('turn_done while an earlier sentence is still decoding plays both in order and ends idle', async () => {
    const events: SpeechBusEvent[] = [];
    subscribeSpeechBus((e) => events.push(e));
    const ws = await turnOn();
    speakTurn();
    const id = lastTurnId();
    holdDecoding = new Set([`${id}:0`]);
    await act(async () => { ws.receive({ type: 'state', state: 'speaking' }); ws.receive(sentence(id, 0)); ws.receive(sentence(id, 1)); });
    await settle();
    await act(async () => { ws.receive({ type: 'turn_done', turnId: id, end: 'answered' }); ws.receive({ type: 'state', state: 'idle' }); });
    expect(sources).toHaveLength(0); // seq 0 is still decoding: nothing was skipped
    await act(async () => { decodeGates.get(`${id}:0`)!(); });
    await settle();
    expect(sources.map((s) => s.buffer!.tag)).toEqual([`${id}:0`, `${id}:1`]);
    await act(async () => { sources[0].onended!(); sources[1].onended!(); });
    expect(sent.filter((m) => m.type === 'played').map((m) => m.seq)).toEqual([0, 1]);
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

    test('sound while her answer is still being prepared is a candidate too, so a rejected noise keeps the question', async () => {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'silero' } };
      const ws = await turnOn();
      speakTurn(); // the operator asked something; it is being transcribed, nothing is audible yet
      const question = lastTurnId();
      await act(async () => { ws.receive({ type: 'state', state: 'transcribing' }); });
      sent.length = 0;
      talkOver();
      const start = sent.find((m) => m.type === 'speech_start');
      expect(start).toMatchObject({ lucyAudible: true });
      const candidate = lastTurnId();
      expect(candidate).not.toBe(question);
      await act(async () => { ws.receive({ type: 'speech_rejected', turnId: candidate }); });
      // The answer to the original question still plays.
      await act(async () => {
        ws.receive({ type: 'state', state: 'speaking' });
        ws.receive(sentence(question, 0));
      });
      await settle();
      expect(sources.length).toBeGreaterThan(0);
      expect(sent.map((m) => m.type)).not.toContain('barge_in');
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

    describe('a verdict that arrives after a newer turn has started', () => {
      /**
       * A candidate is still waiting for its verdict when Lucy finishes her answer, and the
       * operator then starts a normal turn. Returns the candidate's id and the new turn's id.
       */
      async function candidateOutlivesTheAnswer({ fakeTimers = false } = {}) {
        const { ws, id } = await lucyIsSpeaking();
        // After setup, which needs real timers; from here on everything runs synchronously.
        if (fakeTimers) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        talkOver();
        const candidate = lastTurnId();
        gains[0].gain.value = DUCK_GAIN; // the fake does not run the ramp; this is where it lands
        mic(SPEECH, 300);
        mic(QUIET, 800); // the candidate's speech_end goes out; its verdict is delayed
        act(() => {
          sources[0].onended!();
          sources[1].onended!();
          ws.receive({ type: 'turn_done', turnId: id, end: 'answered' });
          ws.receive({ type: 'state', state: 'idle' });
        });
        sent.length = 0;
        mic(SPEECH, 300);
        const start = sent.find((m) => m.type === 'speech_start');
        expect(start).toBeDefined();
        expect(start).not.toHaveProperty('lucyAudible'); // Lucy is quiet: a normal turn
        const fresh = lastTurnId();
        expect(fresh).not.toBe(candidate);
        return { ws, candidate, fresh };
      }

      test('a late speech_rejected does not stop the new turn', async () => {
        const { ws, candidate, fresh } = await candidateOutlivesTheAnswer();
        await act(async () => { ws.receive({ type: 'speech_rejected', turnId: candidate }); });
        wire.length = 0;
        mic(SPEECH, 300);
        expect(wire).toContain('pcm');
        mic(QUIET, 800);
        expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: fresh }]);
      });

      test('a late speech_confirmed does not drop the new turn\'s answer', async () => {
        const { ws, candidate, fresh } = await candidateOutlivesTheAnswer();
        await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: candidate }); });
        mic(QUIET, 800);
        expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: fresh }]);
        const sourcesBefore = sources.length;
        await act(async () => { ws.receive(sentence(fresh, 0, 'Here you go.')); });
        await settle();
        expect(sources).toHaveLength(sourcesBefore + 1);
        expect(latest.lucyText).toBe('Here you go.');
        expect(latest.lastTurnEnd).toBe('answered');
      });

      test('the new turn plays at full volume', async () => {
        await candidateOutlivesTheAnswer();
        expect(gains[0].gain.value).toBe(1);
      });

      test('the old candidate\'s confirmation timeout does not stop the new turn', async () => {
        try {
          const { fresh } = await candidateOutlivesTheAnswer({ fakeTimers: true });
          act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS * 2); });
          expect(wire).not.toContain('barge_in');
          mic(QUIET, 800);
          expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: fresh }]);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    test('a confirmation that crosses the speech_end leaves the promoted turn waiting for its answer', async () => {
      const { ws } = await lucyIsSpeaking();
      talkOver();
      const candidate = lastTurnId();
      mic(SPEECH, 300);
      mic(QUIET, 800); // speech_end goes out before the verdict comes back
      expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: candidate }]);
      // The server confirmed before it read that speech_end: it promotes the candidate to a listening turn.
      await act(async () => {
        ws.receive({ type: 'speech_confirmed', turnId: candidate });
        ws.receive({ type: 'state', state: 'listening' });
      });
      // Until the server says it is transcribing, a new sound must not replace the question:
      // it is checked as a possible interruption, as after any other speech_end.
      sent.length = 0;
      talkOver();
      expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
    });

    describe('a second candidate while the first one\'s verdict is still on its way (#3907)', () => {
      /** Candidate A ends; before its verdict arrives, a new sound B starts a second candidate. */
      async function secondCandidateOverTheFirst() {
        const { ws, id } = await lucyIsSpeaking();
        talkOver();
        const first = lastTurnId();
        mic(SPEECH, 300);
        mic(QUIET, 800); // A's speech_end goes out; the server confirmed A, but that has not arrived
        expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: first }]);
        sent.length = 0;
        talkOver();
        const second = lastTurnId();
        expect(second).not.toBe(first);
        expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
        return { ws, id, first, second };
      }

      test('the first candidate\'s late confirmation still makes it the turn, so its answer plays after the second is rejected', async () => {
        const { ws, id, first, second } = await secondCandidateOverTheFirst();
        await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: first }); });
        // Lucy's old answer stops for good: the operator asked something new.
        expect(sources[0].stop).toHaveBeenCalledTimes(1);
        expect(sources[1].stop).toHaveBeenCalledTimes(1);
        expect(sent.filter((m) => m.type === 'played')).toEqual([{ type: 'played', turnId: id, seq: 0, complete: false }]);
        expect(gains[0].gain.value).toBe(DUCK_GAIN); // the second candidate is still being checked
        await act(async () => {
          ws.receive({ type: 'state', state: 'transcribing' });
          ws.receive({ type: 'speech_rejected', turnId: second });
        });
        expect(gains[0].gain.linearRampToValueAtTime.mock.calls.at(-1)?.[0]).toBe(1);
        const sourcesBefore = sources.length;
        await act(async () => {
          ws.receive({ type: 'state', state: 'speaking' });
          ws.receive(sentence(first, 0, 'Here is the answer.'));
        });
        await settle();
        expect(sources).toHaveLength(sourcesBefore + 1);
        expect(latest.lucyText).toBe('Here is the answer.');
      });

      test('the first candidate\'s late confirmation does not take over a normal turn started after Lucy went quiet', async () => {
        const { ws, id, first } = await secondCandidateOverTheFirst();
        mic(SPEECH, 300);
        mic(QUIET, 800); // the second candidate ends too, still undecided
        act(() => {
          sources[0].onended!();
          sources[1].onended!();
          ws.receive({ type: 'turn_done', turnId: id, end: 'answered' });
          ws.receive({ type: 'state', state: 'idle' });
        });
        sent.length = 0;
        mic(SPEECH, 300);
        expect(sent.find((m) => m.type === 'speech_start')).not.toHaveProperty('lucyAudible'); // a normal turn
        const fresh = lastTurnId();
        await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: first }); });
        mic(QUIET, 800);
        expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: fresh }]);
        const sourcesBefore = sources.length;
        await act(async () => { ws.receive(sentence(fresh, 0, 'Here you go.')); });
        await settle();
        expect(sources).toHaveLength(sourcesBefore + 1);
        expect(latest.lucyText).toBe('Here you go.');
      });

      test('a late rejection of the first candidate leaves the second one in charge', async () => {
        const { ws, first, second } = await secondCandidateOverTheFirst();
        await act(async () => { ws.receive({ type: 'speech_rejected', turnId: first }); });
        expect(sources[0].stop).not.toHaveBeenCalled();
        expect(gains[0].gain.linearRampToValueAtTime.mock.calls.at(-1)?.[0]).toBe(DUCK_GAIN);
        await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: second }); });
        expect(sources[0].stop).toHaveBeenCalledTimes(1);
        await act(async () => { ws.receive({ type: 'transcript', turnId: second, text: 'wait', final: false }); });
        expect(latest.operatorText).toBe('wait');
      });
    });

    describe('with no verdict', () => {
      afterEach(() => { vi.useRealTimers(); });

      describe('a timeout that beats a confirmation sent before the candidate\'s speech_end (#3907)', () => {
        /** The candidate ends, then the timeout fires before its verdict arrives. */
        async function timeoutAfterSpeechEnd() {
          const { ws } = await lucyIsSpeaking();
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          talkOver();
          const candidate = lastTurnId();
          mic(SPEECH, 300);
          mic(QUIET, 800);
          expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId: candidate }]);
          act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS + 10); });
          expect(wire).toContain('barge_in');
          // Lucy is no longer speaking; the server's 'transcribing' state has not arrived yet.
          act(() => { ws.receive({ type: 'state', state: 'listening' }); });
          return { ws, candidate };
        }

        test('a new sound is checked as an interruption, not started as a turn over the question', async () => {
          const { ws, candidate } = await timeoutAfterSpeechEnd();
          act(() => { ws.receive({ type: 'speech_confirmed', turnId: candidate }); });
          sent.length = 0;
          talkOver();
          expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
        });

        test('even before the late confirmation arrives', async () => {
          await timeoutAfterSpeechEnd();
          sent.length = 0;
          talkOver();
          expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
        });

        test('a late rejection releases it: the next sound is a normal turn', async () => {
          const { ws, candidate } = await timeoutAfterSpeechEnd();
          act(() => {
            ws.receive({ type: 'speech_rejected', turnId: candidate });
            ws.receive({ type: 'state', state: 'idle' });
          });
          sent.length = 0;
          talkOver();
          const start = sent.find((m) => m.type === 'speech_start');
          expect(start).toBeDefined();
          expect(start).not.toHaveProperty('lucyAudible');
        });

        test('the confirmed question\'s answer plays', async () => {
          const { ws, candidate } = await timeoutAfterSpeechEnd();
          act(() => {
            ws.receive({ type: 'speech_confirmed', turnId: candidate });
            ws.receive({ type: 'state', state: 'transcribing' });
          });
          vi.useRealTimers();
          const sourcesBefore = sources.length;
          await act(async () => {
            ws.receive({ type: 'state', state: 'speaking' });
            ws.receive(sentence(candidate, 0, 'Done.'));
          });
          await settle();
          expect(sources).toHaveLength(sourcesBefore + 1);
          expect(latest.lucyText).toBe('Done.');
          expect(gains[0].gain.value).toBe(1);
        });
      });

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

      test('after the timeout the operator\'s words keep flowing under the same turn id and end with speech_end', async () => {
        await lucyIsSpeaking();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        talkOver();
        const turnId = lastTurnId();
        act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS + 10); });
        const bargeAt = wire.indexOf('barge_in');
        expect(bargeAt).toBeGreaterThan(-1);
        wire.length = 0;
        mic(SPEECH, 200);
        expect(wire).toContain('pcm');
        mic(QUIET, 800);
        expect(sent.filter((m) => m.type === 'speech_end')).toEqual([{ type: 'speech_end', turnId }]);
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

  test('a connection lost while a possible interruption is checked turns Lucy back up (#3907)', async () => {
    statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'silero' } };
    const ws = await turnOn();
    speakTurn();
    const id = lastTurnId();
    await act(async () => {
      ws.receive({ type: 'state', state: 'speaking' });
      ws.receive(sentence(id, 0));
    });
    await settle();
    sent.length = 0;
    mic(-15, 400); // a candidate: Lucy is ducked
    expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
    gains[0].gain.value = DUCK_GAIN; // the fake does not run the ramp; this is where it lands
    await act(async () => { ws.drop(); });
    expect(gains[0].gain.value).toBe(1);
  });

  test('a failed turn shows the server reason and keeps the session running; the next turn clears it', async () => {
    const ws = await turnOn();
    speakTurn();
    const id = lastTurnId();
    await act(async () => { ws.receive({ type: 'turn_done', turnId: id, end: 'error', reason: 'I could not hear that: the speech recogniser failed (boom).' }); });
    expect(latest.status).toBe('ready');
    expect(latest.lastTurnEnd).toBe('error');
    expect(latest.errorMessage).toBe('I could not hear that: the speech recogniser failed (boom).');
    speakTurn();
    expect(latest.errorMessage).toBeNull();
  });

  test('a failed turn without a reason still shows a plain message', async () => {
    const ws = await turnOn();
    speakTurn();
    await act(async () => { ws.receive({ type: 'turn_done', turnId: lastTurnId(), end: 'error' }); });
    expect(latest.errorMessage).toMatch(/problem/);
  });

  test('an internal or bad_message server error is shown while the socket is open, without ending the session', async () => {
    const ws = await turnOn();
    await act(async () => { ws.receive({ type: 'error', code: 'internal', message: 'Lucy live hit an internal error' }); });
    expect(latest.status).toBe('ready');
    expect(latest.enabled).toBe(true);
    expect(latest.errorMessage).toBe('Lucy live hit an internal error');
    await act(async () => { ws.receive({ type: 'error', code: 'bad_message', message: 'Unknown or malformed message' }); });
    expect(latest.status).toBe('ready');
    expect(latest.errorMessage).toBe('Unknown or malformed message');
  });

  test('an unavailable server error ends the session', async () => {
    const ws = await turnOn();
    await act(async () => { ws.receive({ type: 'error', code: 'unavailable', message: 'Lucy live is not available' }); });
    expect(latest.status).toBe('unavailable');
    expect(latest.enabled).toBe(false);
  });

  describe('her other clips (speaker button, Replay) with Talk on (#3672)', () => {
    /** A clip as `useSpeakAgent` or Replay registers it: its volume and its stop are recorded. */
    function playClip() {
      let release: () => void = () => undefined;
      const clip = {
        setVolume: vi.fn((_gain: number) => undefined),
        stop: vi.fn((_reason: string) => { release(); }),
      };
      act(() => { release = clipStarted(clip); });
      return { clip, end: () => act(() => { release(); }) };
    }
    async function talkOn(confirmation: 'silero' | 'off' = 'silero'): Promise<FakeWebSocket> {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: confirmation } };
      const ws = await turnOn();
      wire.length = 0;
      sent.length = 0;
      return ws;
    }
    /** Talk over her until the detector fires. */
    function talkOver(): void {
      const processor = processors[processors.length - 1];
      for (let i = 0; i < 40 && !sent.some((m) => m.type === 'speech_start'); i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
      }
    }
    const speechStart = () => sent.find((m) => m.type === 'speech_start');

    test('a playing clip makes her busy: talking over it is a candidate and turns the clip down at once', async () => {
      await talkOn();
      const { clip } = playClip();
      talkOver();
      expect(speechStart()).toMatchObject({ lucyAudible: true });
      expect(clip.setVolume).toHaveBeenCalledWith(DUCK_GAIN);
      expect(clip.stop).not.toHaveBeenCalled();
      expect(wire).not.toContain('barge_in');
    });

    test('once the clip has ended, the same sound is an ordinary turn again', async () => {
      await talkOn();
      const { end } = playClip();
      end();
      talkOver();
      expect(speechStart()).not.toHaveProperty('lucyAudible');
    });

    test('confirmed speech stops the clip as a barge-in and the operator\'s words become the next turn', async () => {
      const ws = await talkOn();
      const { clip } = playClip();
      talkOver();
      const candidate = lastTurnId();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: candidate }); });
      expect(clip.stop).toHaveBeenCalledWith('barge_in');
      expect(latest.lastTurnEnd).toBe('interrupted');
      await act(async () => { ws.receive({ type: 'transcript', turnId: candidate, text: 'which tasks', final: false }); });
      expect(latest.operatorText).toBe('which tasks');
    });

    test('a rejected sound turns the clip back up and it plays on', async () => {
      const ws = await talkOn();
      const { clip } = playClip();
      talkOver();
      await act(async () => { ws.receive({ type: 'speech_rejected', turnId: lastTurnId() }); });
      expect(clip.setVolume.mock.calls.map((c) => c[0])).toEqual([DUCK_GAIN, 1]);
      expect(clip.stop).not.toHaveBeenCalled();
    });

    test('no verdict in time stops the clip too', async () => {
      await talkOn();
      const { clip } = playClip();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); // before the candidate arms its timeout
      try {
        talkOver();
        act(() => { vi.advanceTimersByTime(CONFIRMATION_TIMEOUT_MS + 10); });
        expect(clip.stop).toHaveBeenCalledWith('barge_in');
        expect(wire).toContain('barge_in');
      } finally {
        vi.useRealTimers();
      }
    });

    test('without a server check, talking over a clip stops it at once', async () => {
      await talkOn('off');
      const { clip } = playClip();
      for (let i = 0; i < 40 && clip.stop.mock.calls.length === 0; i++) {
        mic(-15, 32);
      }
      expect(clip.stop).toHaveBeenCalledWith('barge_in');
      expect(clip.setVolume).not.toHaveBeenCalled();
    });

    test('a clip that starts while she is answering stops her answer and tells the server', async () => {
      const ws = await talkOn();
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
      sent.length = 0;
      const { clip } = playClip();
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(sources[1].stop).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([{ type: 'played', turnId: id, seq: 0, complete: false }, { type: 'barge_in' }]);
      expect(latest.lastTurnEnd).toBe('interrupted');
      // The rest of that answer, still on its way, is not played, even after the clip ends.
      await act(async () => { ws.receive(sentence(id, 2)); });
      await settle();
      act(() => { clip.stop('barge_in'); });
      await settle();
      expect(sources).toHaveLength(2);
    });

    test('an answer that is ready while a clip plays waits for the clip, then plays', async () => {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive({ type: 'state', state: 'thinking' }); });
      const { clip, end } = playClip(); // pressed while she was still thinking
      expect(wire).not.toContain('barge_in');
      await act(async () => {
        ws.receive(sentence(id, 0));
        ws.receive(sentence(id, 1));
        ws.receive({ type: 'state', state: 'speaking' });
      });
      await settle();
      expect(sources).toHaveLength(0);
      expect(clip.stop).not.toHaveBeenCalled();
      end();
      await settle();
      expect(sources).toHaveLength(2);
      expect(sources[0].start).toHaveBeenCalled();
      expect(sources[1].start.mock.calls[0][0]).toBeGreaterThan(sources[0].start.mock.calls[0][0] as number);
    });

    /** Operator asked something; she is thinking and a clip is playing. */
    async function thinkingBehindClip() {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive({ type: 'state', state: 'thinking' }); });
      const first = playClip();
      await act(async () => { ws.receive(sentence(id, 0)); ws.receive({ type: 'state', state: 'speaking' }); });
      await settle();
      expect(sources).toHaveLength(0); // waiting behind the clip
      sent.length = 0;
      tracked.length = 0;
      return { ws, id, first };
    }

    test('talking over a clip with an answer waiting behind it never starts that answer', async () => {
      const { ws, first } = await thinkingBehindClip();
      talkOver();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: lastTurnId() }); });
      await settle();
      expect(first.clip.stop).toHaveBeenCalledWith('barge_in');
      expect(sources).toHaveLength(0);
      expect(sent.some((m) => m.type === 'played')).toBe(false);
      expect(tracked.some((e) => e.kind === 'end_to_first_audio')).toBe(false);
    });

    test('without a server check, the same: the clip stops and the waiting answer is never started', async () => {
      const ws = await talkOn('off');
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive({ type: 'state', state: 'thinking' }); });
      const { clip } = playClip();
      await act(async () => { ws.receive(sentence(id, 0)); });
      await settle();
      sent.length = 0;
      for (let i = 0; i < 40 && clip.stop.mock.calls.length === 0; i++) mic(-15, 32);
      expect(clip.stop).toHaveBeenCalledWith('barge_in');
      expect(sources).toHaveLength(0);
      expect(sent.some((m) => m.type === 'played')).toBe(false);
    });

    test('a second clip does not throw away an answer waiting behind the first; it plays after both', async () => {
      const { first } = await thinkingBehindClip();
      const second = playClip();
      expect(wire).not.toContain('barge_in');
      expect(latest.lastTurnEnd).not.toBe('interrupted');
      first.end();
      await settle();
      expect(sources).toHaveLength(0);
      second.end();
      await settle();
      expect(sources).toHaveLength(1);
    });

    test('a clip that starts while a sound is being checked over her answer does not send barge_in', async () => {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive(sentence(id, 0)); ws.receive({ type: 'state', state: 'speaking' }); });
      await settle();
      sent.length = 0;
      talkOver(); // a candidate is now being checked
      expect(speechStart()).toMatchObject({ lucyAudible: true });
      sent.length = 0;
      wire.length = 0;
      playClip();
      expect(sources[0].stop).toHaveBeenCalled();
      expect(wire).not.toContain('barge_in'); // the server would take the sound as the operator's words
    });

    test('a connection lost while a clip is turned down brings it back to full volume', async () => {
      const ws = await talkOn();
      const { clip } = playClip();
      talkOver();
      act(() => { ws.drop(); });
      expect(clip.setVolume.mock.calls.at(-1)?.[0]).toBe(1);
      expect(clip.stop).not.toHaveBeenCalled();
    });

    test('while a clip is audible, her thinking does not take the speech bus; when it ends the bus shows her preparing', async () => {
      const events: SpeechBusEvent[] = [];
      subscribeSpeechBus((e) => events.push(e));
      const ws = await talkOn();
      speakTurn();
      const owner = {};
      // What a real clip player does: announce on the bus, then register as playing.
      act(() => { emitSpeechPlaying(owner, { createAnalyser: () => ({}) as AnalyserNode }, { connect: () => undefined } as unknown as AudioNode); });
      const { end } = playClip();
      await act(async () => { ws.receive({ type: 'state', state: 'thinking' }); });
      expect(events.at(-1)?.type).toBe('playing');
      // And what it does at the end: leave the list, then announce idle.
      end();
      act(() => { emitSpeechIdle(owner); });
      expect(events.at(-1)?.type).toBe('generating');
    });

    test('a clip that starts while a sound is being checked is turned down with the rest', async () => {
      await talkOn();
      playClip();
      talkOver();
      const { clip: second } = playClip();
      expect(second.setVolume).toHaveBeenCalledWith(DUCK_GAIN);
    });

    test('switching Talk off while a clip is turned down brings it back to full volume and leaves it playing', async () => {
      await talkOn();
      const { clip } = playClip();
      talkOver();
      await act(async () => { latest.setEnabled(false); });
      expect(clip.setVolume.mock.calls.at(-1)?.[0]).toBe(1);
      expect(clip.stop).not.toHaveBeenCalled();
    });

    test('with Talk off a clip opens no microphone and nothing touches it', async () => {
      const { clip, end } = playClip();
      await settle();
      end();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(0);
      expect(clip.setVolume).not.toHaveBeenCalled();
      expect(clip.stop).not.toHaveBeenCalled();
    });

    test('after Talk is switched off, a new clip leaves nothing behind for the old session to act on', async () => {
      const ws = await talkOn();
      speakTurn();
      await act(async () => { ws.receive(sentence(lastTurnId(), 0)); });
      await settle();
      await act(async () => { latest.setEnabled(false); });
      sent.length = 0;
      const { clip } = playClip();
      expect(sent).toEqual([]);
      expect(clip.setVolume).not.toHaveBeenCalled();
    });
  });

  describe("a task's question with Talk on (#3711)", () => {
    const ASK = 'ask-3711';
    const fetcher = vi.fn(async () => { throw new Error('the clip route must not be called'); }) as unknown as typeof fetch;
    beforeEach(() => {
      __resetAskAnnouncementForTests();
      (fetcher as unknown as ReturnType<typeof vi.fn>).mockClear();
    });

    async function talkOn(): Promise<FakeWebSocket> {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'silero' } };
      const ws = await turnOn();
      wire.length = 0;
      sent.length = 0;
      return ws;
    }
    /** The server starts the question's turn and sends its two sentences. */
    async function serverReadsIt(ws: FakeWebSocket, turnId = 'lucy-ask-1'): Promise<void> {
      await act(async () => {
        ws.receive({ type: 'turn_start', turnId, askId: ASK });
        ws.receive({ type: 'state', state: 'thinking' });
        ws.receive(sentence(turnId, 0, 'The task Cleanup needs your input.'));
        ws.receive(sentence(turnId, 1, 'When should I run it?'));
        ws.receive({ type: 'state', state: 'speaking' });
      });
      await settle();
    }

    test('is handed to the conversation (say_ask), with no clip fetched', async () => {
      await talkOn();
      let result: string | undefined;
      await act(async () => { result = await announceAsk(ASK, { fetcher }); });
      expect(result).toBe('live');
      expect(fetcher).not.toHaveBeenCalled();
      expect(sent).toEqual([{ type: 'say_ask', askId: ASK }]);
    });

    test('its sentences play as the current turn and their text is shown', async () => {
      const ws = await talkOn();
      await serverReadsIt(ws);
      expect(sources.map((s) => s.buffer!.tag)).toEqual(['lucy-ask-1:0', 'lucy-ask-1:1']);
      expect(latest.lucyText).toBe('The task Cleanup needs your input. When should I run it?');
      await act(async () => { sources[0].onended!(); });
      expect(sent.filter((m) => m.type === 'played')).toEqual([{ type: 'played', turnId: 'lucy-ask-1', seq: 0, complete: true }]);
    });

    test('talking over it ducks her, and speech_confirmed stops her and reports what was cut, as for an answer', async () => {
      const ws = await talkOn();
      await serverReadsIt(ws);
      const processor = processors[processors.length - 1];
      for (let i = 0; i < 40 && !sent.some((m) => m.type === 'speech_start'); i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
      }
      expect(sent.find((m) => m.type === 'speech_start')).toMatchObject({ lucyAudible: true });
      expect(gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(DUCK_GAIN, expect.any(Number));
      expect(sources[0].stop).not.toHaveBeenCalled();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: lastTurnId() }); });
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(sources[1].stop).toHaveBeenCalledTimes(1);
      expect(sent.filter((m) => m.type === 'played')).toEqual([{ type: 'played', turnId: 'lucy-ask-1', seq: 0, complete: false }]);
    });

    test('a turn_start that arrives while the operator has just begun to speak does not take over their turn', async () => {
      const ws = await talkOn();
      mic(QUIET, 500);
      mic(SPEECH, 400); // the operator is speaking: their turn is being sent
      const operatorTurn = lastTurnId();
      await serverReadsIt(ws);
      expect(sources).toHaveLength(0);
      mic(QUIET, 800);
      // The server held the question back; the operator's own transcript and answer are what she shows and plays.
      await act(async () => {
        ws.receive({ type: 'turn_done', turnId: 'lucy-ask-1', end: 'interrupted' });
        ws.receive({ type: 'transcript', turnId: operatorTurn, text: 'what is new', final: true });
        ws.receive(sentence(operatorTurn, 0, 'Nothing new.'));
      });
      await settle();
      expect(latest.operatorText).toBe('what is new');
      expect(sources.map((s) => s.buffer!.tag)).toEqual([`${operatorTurn}:0`]);
    });

    test('a question closed while she reads it stops her at once and tells the server', async () => {
      const ws = await talkOn();
      await act(async () => { await announceAsk(ASK, { fetcher }); });
      await serverReadsIt(ws);
      sent.length = 0;
      act(() => { stopAskAnnouncement(ASK); });
      expect(sources[0].stop).toHaveBeenCalledTimes(1);
      expect(sources[1].stop).toHaveBeenCalledTimes(1);
      expect(sent).toEqual([
        { type: 'played', turnId: 'lucy-ask-1', seq: 0, complete: false },
        { type: 'drop_ask', askId: ASK },
      ]);
      expect(latest.lucyText).toBe('');
      // A sentence of the question that was already on its way is not played.
      const before = sources.length;
      await act(async () => { ws.receive(sentence('lucy-ask-1', 2, 'You can answer: now or tonight.')); });
      await settle();
      expect(sources).toHaveLength(before);
      expect(latest.lucyText).toBe('');
    });

    test('an answer waiting behind a clip is not lost when a question starts: it plays first, then the question', async () => {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      let releaseClip: () => void = () => undefined;
      act(() => { releaseClip = clipStarted({ setVolume: () => undefined, stop: () => { releaseClip(); } }); });
      await act(async () => {
        ws.receive(sentence(id, 0));
        ws.receive(sentence(id, 1));
        ws.receive({ type: 'turn_done', turnId: id, end: 'answered' });
      });
      await settle();
      expect(sources).toHaveLength(0); // waiting for the clip
      // The server cannot see the clip, so it starts a question, then a second one.
      await serverReadsIt(ws, 'lucy-ask-1');
      await act(async () => {
        ws.receive({ type: 'turn_done', turnId: 'lucy-ask-1', end: 'answered' });
        ws.receive({ type: 'turn_start', turnId: 'lucy-ask-2', askId: 'ask-2' });
        ws.receive(sentence('lucy-ask-2', 0, 'Another task asks.'));
      });
      await settle();
      expect(sources).toHaveLength(0);
      act(() => { releaseClip(); });
      await settle();
      expect(sources.map((s) => s.buffer!.tag)).toEqual([`${id}:0`, `${id}:1`, 'lucy-ask-1:0', 'lucy-ask-1:1', 'lucy-ask-2:0']);
      for (const source of [...sources]) await act(async () => { source.onended!(); });
      expect(sent.filter((m) => m.type === 'played').map((m) => `${m.turnId as string}:${m.seq as number}`))
        .toEqual([`${id}:0`, `${id}:1`, 'lucy-ask-1:0', 'lucy-ask-1:1', 'lucy-ask-2:0']);
    });

    test('a question held behind waiting audio and then closed is never played', async () => {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      let releaseClip: () => void = () => undefined;
      act(() => { releaseClip = clipStarted({ setVolume: () => undefined, stop: () => { releaseClip(); } }); });
      await act(async () => { ws.receive(sentence(id, 0)); ws.receive({ type: 'turn_done', turnId: id, end: 'answered' }); });
      await settle();
      await act(async () => { await announceAsk(ASK, { fetcher }); });
      await serverReadsIt(ws);
      act(() => { stopAskAnnouncement(ASK); });
      expect(sent.at(-1)).toEqual({ type: 'drop_ask', askId: ASK });
      act(() => { releaseClip(); });
      await settle();
      expect(sources.map((s) => s.buffer!.tag)).toEqual([`${id}:0`]);
    });

    test('closing a question leaves the question held behind it, which then plays', async () => {
      const ws = await talkOn();
      let releaseClip: () => void = () => undefined;
      act(() => { releaseClip = clipStarted({ setVolume: () => undefined, stop: () => { releaseClip(); } }); });
      await act(async () => { await announceAsk(ASK, { fetcher }); });
      await serverReadsIt(ws, 'lucy-ask-1'); // waits behind the clip
      await act(async () => {
        ws.receive({ type: 'turn_done', turnId: 'lucy-ask-1', end: 'answered' });
        ws.receive({ type: 'turn_start', turnId: 'lucy-ask-2', askId: 'ask-2' });
        ws.receive(sentence('lucy-ask-2', 0, 'Another task asks.'));
      });
      await settle();
      act(() => { stopAskAnnouncement(ASK); }); // the first question is answered on its card
      act(() => { releaseClip(); });
      await settle();
      expect(sources.map((s) => s.buffer!.tag)).toEqual(['lucy-ask-2:0']);
    });

    test('a question held when the operator interrupts her is dropped, and never cuts into her next answer', async () => {
      const ws = await talkOn();
      speakTurn();
      const id = lastTurnId();
      holdDecoding = new Set([`${id}:0`]); // her answer is still being decoded when the question starts
      await act(async () => { ws.receive(sentence(id, 0)); ws.receive({ type: 'turn_done', turnId: id, end: 'answered' }); });
      await serverReadsIt(ws); // held behind her waiting answer
      expect(sources).toHaveLength(0);
      const processor = processors[processors.length - 1];
      for (let i = 0; i < 40 && sent.filter((m) => m.type === 'speech_start').length < 2; i++) {
        act(() => { processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame(-15) } }); });
      }
      const candidate = lastTurnId();
      await act(async () => { ws.receive({ type: 'speech_confirmed', turnId: candidate }); });
      mic(QUIET, 800);
      await act(async () => { ws.receive(sentence(candidate, 0, 'Sure.')); ws.receive(sentence(candidate, 1, 'Here it is.')); });
      await settle();
      expect(sources.map((s) => s.buffer!.tag)).toEqual([`${candidate}:0`, `${candidate}:1`]);
    });

    test('before the server says it is ready, the conversation refuses the question, which is played as a clip', async () => {
      statusResponse = { ok: true, body: { available: true, bargeInConfirmation: 'silero' } };
      await act(async () => { latest.setEnabled(true); });
      await settle();
      const ws = sockets[sockets.length - 1];
      await act(async () => { ws.open(); }); // connected, but no `ready` yet (also the state while reconnecting)
      const clipFetcher = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
      let result: string | undefined;
      await act(async () => { result = await announceAsk(ASK, { fetcher: clipFetcher }); });
      expect(result).toBe('error');
      expect(clipFetcher).toHaveBeenCalledOnce();
      expect(sent.some((m) => m.type === 'say_ask')).toBe(false);
    });

    test('once the operator has started a new turn, closing the question she read earlier does not cut her answer', async () => {
      const ws = await talkOn();
      await act(async () => { await announceAsk(ASK, { fetcher }); });
      await serverReadsIt(ws);
      for (const source of [...sources]) await act(async () => { source.onended!(); });
      await act(async () => { ws.receive({ type: 'turn_done', turnId: 'lucy-ask-1', end: 'answered' }); ws.receive({ type: 'state', state: 'idle' }); });
      speakTurn();
      const id = lastTurnId();
      await act(async () => { ws.receive(sentence(id, 0, 'You want: tonight. Shall I send that?')); });
      await settle();
      const answer = sources.at(-1)!;
      expect(answer.buffer!.tag).toBe(`${id}:0`);
      act(() => { stopAskAnnouncement(ASK); });
      expect(answer.stop).not.toHaveBeenCalled();
      expect(sent.at(-1)).toEqual({ type: 'drop_ask', askId: ASK });
    });

    test('with Talk off again the question goes back to the clip path', async () => {
      await talkOn();
      await act(async () => { latest.setEnabled(false); });
      await settle();
      const clipFetcher = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
      let result: string | undefined;
      await act(async () => { result = await announceAsk('ask-after-off', { fetcher: clipFetcher }); });
      expect(result).toBe('error');
      expect(clipFetcher).toHaveBeenCalledOnce();
      expect(sent.some((m) => m.type === 'say_ask')).toBe(false);
    });
  });
});
