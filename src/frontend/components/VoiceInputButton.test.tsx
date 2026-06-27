// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { useKookrStore } from '../store/useStore.js';
import { VoiceInputButton } from './VoiceInputButton.js';

vi.mock('../telemetry.js', () => ({
  track: vi.fn(),
}));

function createFakeMediaStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16_000 }), stop: vi.fn() }],
  } as unknown as MediaStream;
}

class FakeSTTWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSTTWebSocket[] = [];

  readyState = FakeSTTWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly send = vi.fn();

  constructor(readonly url: string) {
    FakeSTTWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeSTTWebSocket.CLOSED;
    this.onclose?.();
  }
}

const PROCESSING_TIMEOUT_MS = 15_000;

function installAudioCaptureStubs(): void {
  vi.stubGlobal('WebSocket', FakeSTTWebSocket);
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(createFakeMediaStream()),
    },
  });
  vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function () {
    return {
      sampleRate: 16_000,
      destination: {},
      close: vi.fn().mockResolvedValue(undefined),
      createMediaStreamSource: () => ({ connect: vi.fn() }),
      createScriptProcessor: () => ({
        connect: vi.fn(),
        disconnect: vi.fn(),
        onaudioprocess: null,
      }),
    };
  }));
}

function deferredResponse(body: unknown) {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () => resolve(new Response(JSON.stringify(body), { status: 200 })),
  };
}

describe('VoiceInputButton STT health gating', () => {
  let container: HTMLDivElement;
  let root: Root;
  let sttUrl: string;
  let testIndex = 0;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeSTTWebSocket.instances = [];
    sttUrl = `ws://stt.example.test/${testIndex++}`;
    useKookrStore.setState({ sttUrl, activeSTTInputId: null });
    installAudioCaptureStubs();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useKookrStore.setState({ sttUrl: '', activeSTTInputId: null });
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function renderButton(): Promise<HTMLButtonElement> {
    const buttons = await renderButtons(1);
    return buttons[0];
  }

  async function renderButtons(count: number): Promise<HTMLButtonElement[]> {
    await act(async () => {
      root.render(
        <>
          {Array.from({ length: count }, (_, index) => (
            <VoiceInputButton
              key={index}
              inputId={`voice-test-${index}`}
              onTranscript={vi.fn()}
            />
          ))}
        </>,
      );
    });
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(count);
    return buttons as HTMLButtonElement[];
  }

  async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function startAndFailSTT(button: HTMLButtonElement): Promise<void> {
    await click(button);
    expect(FakeSTTWebSocket.instances).toHaveLength(1);
    await act(async () => {
      FakeSTTWebSocket.instances[0].onerror?.();
    });
  }

  test('starts recording while STT is healthy', async () => {
    const button = await renderButton();

    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Click to start voice input');

    await click(button);

    expect(FakeSTTWebSocket.instances.map((ws) => ws.url)).toEqual([sttUrl]);
    expect(button.className).toContain('recording');
    expect(button.title).toBe('Recording... click to stop');
    expect(useKookrStore.getState().activeSTTInputId).toBe('voice-test-0');
  });

  test('shows a degraded retry affordance after an STT service failure', async () => {
    const button = await renderButton();

    await startAndFailSTT(button);

    expect(button.disabled).toBe(false);
    expect(button.className).toContain('error');
    expect(button.title).toContain('Speech-to-text unavailable: STT service connection failed');
    expect(button.title).toContain('Click to retry.');
  });

  test('shares degraded state across voice input controls for the same STT endpoint', async () => {
    const [firstButton, secondButton] = await renderButtons(2);

    await startAndFailSTT(firstButton);

    expect(firstButton.className).toContain('error');
    expect(secondButton.className).toContain('error');
    expect(secondButton.title).toContain('Speech-to-text unavailable: STT service connection failed');
  });

  test('clears degraded state when retry health returns ok', async () => {
    const button = await renderButton();
    await startAndFailSTT(button);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(button);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(button.className).toContain('idle');
    expect(button.title).toBe('Click to start voice input');
  });

  test('clears the original failed control when another control retry succeeds', async () => {
    const [firstButton, secondButton] = await renderButtons(2);
    await startAndFailSTT(firstButton);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(secondButton);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(firstButton.className).toContain('idle');
    expect(firstButton.title).toBe('Click to start voice input');
    expect(secondButton.className).toContain('idle');
    expect(secondButton.title).toBe('Click to start voice input');
  });

  test('clears the original timed-out control when another control retry succeeds', async () => {
    vi.useFakeTimers();
    const [firstButton, secondButton] = await renderButtons(2);
    await click(firstButton);
    await act(async () => {
      FakeSTTWebSocket.instances[0].onopen?.();
    });
    await click(firstButton);
    await act(async () => {
      vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await click(secondButton);

    expect(fetchMock).toHaveBeenCalledWith('/api/health/stt', { cache: 'no-store' });
    expect(firstButton.className).toContain('idle');
    expect(firstButton.title).toBe('Click to start voice input');
    expect(secondButton.className).toContain('idle');
    expect(secondButton.title).toBe('Click to start voice input');
  });

  test('keeps degraded state and debounces retry while STT remains unavailable', async () => {
    const button = await renderButton();
    await startAndFailSTT(button);
    const deferred = deferredResponse({ status: 'unavailable' });
    const fetchMock = vi.fn().mockReturnValue(deferred.promise);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('Checking speech-to-text health...');

    await act(async () => {
      deferred.resolve();
      await deferred.promise;
    });

    expect(button.disabled).toBe(false);
    expect(button.className).toContain('error');
    expect(button.title).toContain('Speech-to-text unavailable: STT service unavailable');
  });
});
