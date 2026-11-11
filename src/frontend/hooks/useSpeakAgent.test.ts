// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  formatSpeakFindingTimingLine,
  formatSpeakFindingTimingTitle,
} from '../speech-presentation.js';
import {
  setSpeakVerbositySnapshot,
  useSpeakAgent,
  type SpeakAgentHookState,
} from './useSpeakAgent.js';
import {
  __resetAudioAlertLogForTests,
  getAudioAlertSnapshot,
} from '../audio/audio-alert-log.js';
import { __resetSpeechBusForTests, subscribeSpeechBus } from '../audio/speech-bus.js';
import { __resetLastClipForTests, getLastClip, getLastClipSnapshot } from '../audio/last-clip.js';
import { __resetClipPlaybackForTests } from '../audio/clip-playback.js';
import { __resetSoundPreferenceForTests, setSoundEnabled } from '../audio/sound-preference.js';

const tracked = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../telemetry.js', () => ({ track: (event: Record<string, unknown>) => { tracked.push(event); } }));

describe('speak agent timing formatting', () => {
  test('shows generation, synthesis, decode, and audio timing', () => {
    expect(formatSpeakFindingTimingLine({
      llmMs: 1234,
      ttsMs: 480,
      decodeMs: 32,
      audioMs: 4560,
      cached: false,
    })).toBe('LLM 1.2s · TTS 480ms · decode 32ms · audio 4.6s');
  });

  test('calls out cache hits and detailed playback timing in the title', () => {
    const title = formatSpeakFindingTimingTitle({
      requestMs: 95,
      llmMs: 0,
      ttsMs: 0,
      decodeMs: 14,
      timeToStartMs: 130,
      audioMs: 2400,
      playedMs: 2388,
      cached: true,
    });

    expect(title).toContain('Request: 95ms');
    expect(title).toContain('Summary/TTS: cache hit');
    expect(title).toContain('Time to playback: 130ms');
    expect(title).toContain('Observed playback: 2.4s');
  });
});

type FakeBufferSource = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
};

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  destination = {};
  analyser = { fftSize: 0, smoothingTimeConstant: 0 };

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createAnalyser = vi.fn(() => this.analyser as unknown as AnalyserNode);

  decodeAudioData = vi.fn(async () => ({}) as AudioBuffer);
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  createBufferSource = vi.fn((): AudioBufferSourceNode => {
    const source: FakeBufferSource = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    return source as unknown as AudioBufferSourceNode;
  });
}

interface ProbeHandle {
  speak: () => void;
  stop: () => void;
  state: SpeakAgentHookState;
}

let probeHandle: ProbeHandle | null = null;

function Probe({ fetcher }: { fetcher: typeof fetch }) {
  const hook = useSpeakAgent(
    { agentId: 'agent-1', anomalyType: null, ttsAvailable: true },
    { fetcher },
  );
  probeHandle = hook as ProbeHandle;
  return null;
}

function mountProbe(fetcher: typeof fetch): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Probe, { fetcher }));
  });
  return { root, container };
}

describe('useSpeakAgent request shape', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    probeHandle = null;
    setSpeakVerbositySnapshot(null);
    __resetAudioAlertLogForTests();
    __resetSpeechBusForTests();
    __resetLastClipForTests();
    __resetClipPlaybackForTests();
    setSoundEnabled(true);
    __resetSoundPreferenceForTests();
    tracked.length = 0;
    FakeAudioContext.instances = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
    setSpeakVerbositySnapshot(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('POSTs to /api/agents/<id>/speak with the verbosity snapshot in the body', async () => {
    setSpeakVerbositySnapshot('detailed');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        text: 'hi',
        audioBase64: 'AA==',
        mimeType: 'audio/wav',
        durationMs: 1,
        usedFallback: false,
        fallbackReason: null,
        llmMs: 0,
        ttsMs: 0,
        cached: false,
        resolvedMode: 'activity',
        effectiveVerbosity: 'detailed',
        requestId: 'req-1',
        cacheKey: 'k',
      }),
    } as unknown as Response));
    const mounted = mountProbe(fetchMock as unknown as typeof fetch);
    root = mounted.root;
    container = mounted.container;

    await act(async () => {
      probeHandle!.speak();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/agents/agent-1/speak');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ verbosity: 'detailed' });
  });

  test('defaults to verbosity=medium when no snapshot has been loaded yet', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        text: '',
        audioBase64: 'AA==',
        mimeType: 'audio/wav',
        durationMs: 1,
        usedFallback: false,
        fallbackReason: null,
        llmMs: 0,
        ttsMs: 0,
        cached: false,
        resolvedMode: 'activity',
        effectiveVerbosity: 'medium',
        requestId: 'req-2',
        cacheKey: 'k',
      }),
    } as unknown as Response));
    const mounted = mountProbe(fetchMock as unknown as typeof fetch);
    root = mounted.root;
    container = mounted.container;

    await act(async () => {
      probeHandle!.speak();
      await Promise.resolve();
      await Promise.resolve();
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ verbosity: 'medium' });
  });

  test('20-second timeout transitions to error with errorReason=timeout-client', async () => {
    vi.useFakeTimers();
    // Fetch promise that never resolves — simulates a stuck server.
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const mounted = mountProbe(fetchMock as unknown as typeof fetch);
    root = mounted.root;
    container = mounted.container;
    const busEvents: string[] = [];
    subscribeSpeechBus((event) => busEvents.push(event.type));

    act(() => {
      probeHandle!.speak();
    });
    expect(probeHandle!.state.status).toBe('generating');

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
    });

    expect(probeHandle!.state.status).toBe('error');
    expect(probeHandle!.state.errorReason).toBe('timeout-client');
    expect(busEvents).toEqual(['idle', 'generating', 'idle']);
    const snapshot = getAudioAlertSnapshot();
    const timeoutEntry = snapshot.entries.find((entry) => entry.reason === 'timeout_client');
    expect(timeoutEntry?.abortedAtPhase).toBe('generating');
  });

  test('stopping while generating records abortedAtPhase=generating', async () => {
    // Fetch promise that never resolves — keeps the hook in `generating`.
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const mounted = mountProbe(fetchMock as unknown as typeof fetch);
    root = mounted.root;
    container = mounted.container;
    const busEvents: string[] = [];
    subscribeSpeechBus((event) => busEvents.push(event.type));

    act(() => {
      probeHandle!.speak();
    });
    expect(probeHandle!.state.status).toBe('generating');

    act(() => {
      // Second click while in flight cancels the operation.
      probeHandle!.speak();
    });

    expect(probeHandle!.state.status).toBe('idle');
    expect(busEvents).toEqual(['idle', 'generating', 'idle']);
    const snapshot = getAudioAlertSnapshot();
    const cancelEntry = snapshot.entries.find((entry) => entry.reason === 'user_canceled');
    expect(cancelEntry?.abortedAtPhase).toBe('generating');
  });

  // The optional avatar panel follows playback through the speech bus. These cases pin what the
  // hook announces, so the avatar cannot be left "preparing" or "speaking" after the clip is over.
  describe('announcements on the speech bus', () => {
    function speakResponse(text: string): Response {
      return {
        ok: true,
        json: async () => ({
          text,
          audioBase64: 'AA==',
          mimeType: 'audio/wav',
          durationMs: 2400,
          usedFallback: false,
          fallbackReason: null,
          llmMs: 0,
          ttsMs: 0,
          cached: false,
          resolvedMode: 'activity',
          effectiveVerbosity: 'medium',
          requestId: 'req-bus',
          cacheKey: 'k',
        }),
      } as unknown as Response;
    }

    async function speakAndSettle(): Promise<void> {
      await act(async () => {
        probeHandle!.speak();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });
    }

    test('a clip is announced as generating, then playing with its text and a loudness tap, then idle when it ends', async () => {
      const mounted = mountProbe(vi.fn(async () => speakResponse('Two tasks need you.')) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
      const events: Array<{ type: string; text?: string | null; analyser?: unknown }> = [];
      subscribeSpeechBus((event) => events.push(event));

      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('playing');
      const ctx = FakeAudioContext.instances[0];
      expect(events.map((event) => event.type)).toEqual(['idle', 'generating', 'playing']);
      expect(events[2]).toEqual({ type: 'playing', text: 'Two tasks need you.', analyser: ctx.analyser });

      const source = ctx.createBufferSource.mock.results[0].value as unknown as FakeBufferSource;
      // The tap is an extra connection: the clip still goes to the speakers exactly as before.
      expect(source.connect).toHaveBeenCalledWith(ctx.destination);
      expect(source.connect).toHaveBeenCalledWith(ctx.analyser);

      act(() => {
        source.onended?.();
      });
      expect(probeHandle!.state.status).toBe('idle');
      expect(events.map((event) => event.type)).toEqual(['idle', 'generating', 'playing', 'idle']);
    });

    test('with nobody listening, playback creates no extra audio node', async () => {
      const mounted = mountProbe(vi.fn(async () => speakResponse('hi')) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;

      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('playing');
      const ctx = FakeAudioContext.instances[0];
      expect(ctx.createAnalyser).not.toHaveBeenCalled();
      const source = ctx.createBufferSource.mock.results[0].value as unknown as FakeBufferSource;
      expect(source.connect).toHaveBeenCalledTimes(1);
    });

    test('a clip the browser refuses to play (audio stays suspended) does not leave observers on generating', async () => {
      class SuspendedAudioContext extends FakeAudioContext {
        state: AudioContextState = 'suspended';
        resume = vi.fn(async () => {});
      }
      vi.stubGlobal('AudioContext', SuspendedAudioContext);
      const mounted = mountProbe(vi.fn(async () => speakResponse('hi')) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
      const events: string[] = [];
      subscribeSpeechBus((event) => events.push(event.type));

      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('suppressed');
      expect(events).toEqual(['idle', 'generating', 'idle']);
    });

    test('a failed request ends the announcement', async () => {
      const mounted = mountProbe(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
      const events: string[] = [];
      subscribeSpeechBus((event) => events.push(event.type));

      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('error');
      expect(events).toEqual(['idle', 'generating', 'idle']);
    });

    test('another speaker button going away while idle does not cut the announcement short', async () => {
      const mounted = mountProbe(vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
      const speaking = probeHandle!;
      const events: string[] = [];
      subscribeSpeechBus((event) => events.push(event.type));
      act(() => {
        speaking.speak();
      });
      expect(events).toEqual(['idle', 'generating']);

      // A second, idle instance of the hook (another task's speaker button) mounts and unmounts.
      const other = mountProbe(vi.fn() as unknown as typeof fetch);
      act(() => other.root.unmount());
      other.container.remove();

      expect(events).toEqual(['idle', 'generating']);
    });

    test('a button left suspended earlier cannot cut off a clip that another button is playing', async () => {
      // Button A: the browser keeps its audio suspended, so it ends up "suppressed" with its audio objects kept for a retry.
      class SuspendedAudioContext extends FakeAudioContext {
        state: AudioContextState = 'suspended';
        resume = vi.fn(async () => {});
      }
      vi.stubGlobal('AudioContext', SuspendedAudioContext);
      const first = mountProbe(vi.fn(async () => speakResponse('A')) as unknown as typeof fetch);
      await speakAndSettle();
      expect(probeHandle!.state.status).toBe('suppressed');

      // Button B plays normally.
      vi.stubGlobal('AudioContext', FakeAudioContext);
      const mounted = mountProbe(vi.fn(async () => speakResponse('B')) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
      const events: string[] = [];
      subscribeSpeechBus((event) => events.push(event.type));
      await speakAndSettle();
      expect(events).toEqual(['idle', 'generating', 'playing']);

      // Button A goes away (its task is closed) while B is still talking.
      act(() => first.root.unmount());
      first.container.remove();

      expect(events).toEqual(['idle', 'generating', 'playing']);
    });
  });
  // The last clip is remembered as soon as it arrives, so one nobody heard can be replayed.
  describe('last clip memory and interaction telemetry', () => {
    function clipResponse(extra: Record<string, unknown> = {}): Response {
      return {
        ok: true,
        json: async () => ({
          text: 'Two tasks need you.',
          audioBase64: 'AQID', // bytes 1, 2, 3
          mimeType: 'audio/wav',
          durationMs: 2400,
          usedFallback: false,
          fallbackReason: null,
          llmMs: 0,
          ttsMs: 0,
          cached: false,
          resolvedMode: 'activity',
          effectiveVerbosity: 'medium',
          requestId: 'req-clip',
          cacheKey: 'k',
          clipId: 'clip-srv-1',
          ...extra,
        }),
      } as unknown as Response;
    }

    async function speakAndSettle(): Promise<void> {
      await act(async () => {
        probeHandle!.speak();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });
    }

    function mount(response: () => Promise<Response>): void {
      const mounted = mountProbe(vi.fn(response) as unknown as typeof fetch);
      root = mounted.root;
      container = mounted.container;
    }

    const ofType = (type: string) => tracked.filter((event) => event.type === type);

    test('a played clip is remembered with its server clip id, starts unheard and is heard when it finishes in a visible tab', async () => {
      mount(async () => clipResponse());
      await speakAndSettle();

      const clip = getLastClip()!;
      expect(clip).toMatchObject({ clipId: 'clip-srv-1', text: 'Two tasks need you.', durationMs: 2400 });
      expect(new Uint8Array(clip.audio)).toEqual(new Uint8Array([1, 2, 3]));
      expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, text: 'Two tasks need you.' });
      expect(ofType('lucy_clip_started')).toEqual([
        { type: 'lucy_clip_started', clipId: 'clip-srv-1', trigger: 'click', panelState: 'off', tabVisible: true },
      ]);

      // decodeAudioData consumes the bytes it is given, so it must not be handed the stored copy.
      const ctx = FakeAudioContext.instances[0];
      expect(ctx.decodeAudioData.mock.calls[0][0]).not.toBe(clip.audio);

      const source = ctx.createBufferSource.mock.results[0].value as unknown as FakeBufferSource;
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2400);
      act(() => {
        source.onended?.();
      });
      expect(getLastClipSnapshot().unheard).toBe(false);
      expect(ofType('lucy_clip_ended')).toEqual([
        { type: 'lucy_clip_ended', clipId: 'clip-srv-1', endedBy: 'finished', playedMs: 2400, totalMs: 2400 },
      ]);
      expect(ofType('lucy_clip_unheard')).toEqual([]);
    });

    test('a locally generated id stands in when the server sent none', async () => {
      mount(async () => clipResponse({ clipId: undefined }));
      await speakAndSettle();
      expect(getLastClip()!.clipId).toMatch(/^local-/);
      expect(ofType('lucy_clip_started')[0]).toMatchObject({ clipId: getLastClip()!.clipId });
    });

    test('a clip the browser would not play is still remembered, and reported as unheard (audio suspended)', async () => {
      class SuspendedAudioContext extends FakeAudioContext {
        state: AudioContextState = 'suspended';
        resume = vi.fn(async () => {});
      }
      vi.stubGlobal('AudioContext', SuspendedAudioContext);
      mount(async () => clipResponse());
      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('suppressed');
      expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, text: 'Two tasks need you.' });
      expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'clip-srv-1', reason: 'audio_suspended' }]);
      expect(ofType('lucy_clip_started')).toEqual([]);
    });

    test('sound switched off while the summary was being prepared: remembered, not played, reported as muted', async () => {
      let release: (response: Response) => void = () => {};
      mount(() => new Promise<Response>((resolve) => { release = resolve; }));
      act(() => {
        probeHandle!.speak();
      });
      setSoundEnabled(false);
      await act(async () => {
        release(clipResponse());
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      });

      expect(probeHandle!.state.status).toBe('suppressed');
      expect(probeHandle!.state.errorReason).toBe('sound-muted');
      expect(FakeAudioContext.instances[0].createBufferSource).not.toHaveBeenCalled();
      expect(getLastClipSnapshot().unheard).toBe(true);
      expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'clip-srv-1', reason: 'muted' }]);
    });

    test('audio that cannot be decoded is reported as an error and is not kept for replay', async () => {
      class BadAudioContext extends FakeAudioContext {
        decodeAudioData = vi.fn(async () => { throw new Error('bad wav'); });
      }
      vi.stubGlobal('AudioContext', BadAudioContext);
      mount(async () => clipResponse());
      await speakAndSettle();

      expect(probeHandle!.state.errorReason).toBe('decode-failed');
      expect(getLastClipSnapshot().hasClip).toBe(false);
      expect(ofType('lucy_clip_unheard')).toEqual([{ type: 'lucy_clip_unheard', clipId: 'clip-srv-1', reason: 'error' }]);
    });

    test('stopping a clip part-way records user_stop and leaves it unheard', async () => {
      mount(async () => clipResponse());
      await speakAndSettle();
      expect(probeHandle!.state.status).toBe('playing');

      act(() => {
        probeHandle!.stop();
      });
      expect(ofType('lucy_clip_ended')).toHaveLength(1);
      expect(ofType('lucy_clip_ended')[0]).toMatchObject({ clipId: 'clip-srv-1', endedBy: 'user_stop', totalMs: 2400 });
      expect(getLastClipSnapshot().unheard).toBe(true);
    });

    test('a newer clip replaces the older one and starts unheard', async () => {
      mount(async () => clipResponse());
      await speakAndSettle();
      const source = FakeAudioContext.instances[0].createBufferSource.mock.results[0].value as unknown as FakeBufferSource;
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 5000);
      act(() => {
        source.onended?.();
      });
      expect(getLastClipSnapshot().unheard).toBe(false);

      mount(async () => clipResponse({ clipId: 'clip-srv-2', text: 'Something else.' }));
      await speakAndSettle();
      expect(getLastClip()!.clipId).toBe('clip-srv-2');
      expect(getLastClipSnapshot()).toEqual({ hasClip: true, unheard: true, text: 'Something else.' });
    });

    test('a failed request leaves the previous clip alone', async () => {
      mount(async () => clipResponse());
      await speakAndSettle();
      act(() => {
        probeHandle!.stop();
      });
      mount(async () => { throw new Error('offline'); });
      await speakAndSettle();
      expect(getLastClip()!.clipId).toBe('clip-srv-1');
    });
  });
});
