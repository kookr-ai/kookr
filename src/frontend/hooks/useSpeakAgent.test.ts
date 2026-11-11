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
      const events: Array<{ type: string; text?: string | null; durationMs?: number | null; analyser?: unknown }> = [];
      subscribeSpeechBus((event) => events.push(event));

      await speakAndSettle();

      expect(probeHandle!.state.status).toBe('playing');
      const ctx = FakeAudioContext.instances[0];
      expect(events.map((event) => event.type)).toEqual(['idle', 'generating', 'playing']);
      expect(events[2]).toMatchObject({ text: 'Two tasks need you.', durationMs: 2400, analyser: ctx.analyser });

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
  });
});
