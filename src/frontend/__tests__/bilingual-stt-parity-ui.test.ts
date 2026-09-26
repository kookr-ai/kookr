// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { dispatchSnapshotMessageForClient } from '../hooks/useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { VoiceInputButton } from '../components/VoiceInputButton.js';

function createFakeMediaStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16_000 }), stop: vi.fn() }],
  } as unknown as MediaStream;
}

class FakeSTTWebSocket {
  static readonly OPEN = 1;
  static openedUrls: string[] = [];
  static instances: FakeSTTWebSocket[] = [];

  readyState = FakeSTTWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSTTWebSocket.openedUrls.push(url);
    FakeSTTWebSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (this.url === 'ws://descriptor-stt' && typeof data === 'string' && data.includes('"config"')) {
      this.onmessage?.({
        data: JSON.stringify({
          type: 'progressive',
          fixedText: 'bonjour',
          activeText: 'hello',
        }),
      });
    }
  }

  finish(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'transcription', text: 'bonjour hello', is_final: true }) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

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

describe('Phase 6 descriptor-only STT frontend parity', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    container?.remove();
    root = null;
    container = null;
    useKookrStore.setState({ sttUrl: '', speechCapabilities: null, activeSTTInputId: null });
    vi.unstubAllGlobals();
  });

  it('drives VoiceInputButton/useSTT to draft text from SpeechCapability descriptors without legacy STT fields', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    FakeSTTWebSocket.openedUrls = [];
    FakeSTTWebSocket.instances = [];
    installAudioCaptureStubs();
    dispatchSnapshotMessageForClient({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      speechCapabilities: {
        capabilitiesByDevice: {
          'local-node': [
            {
              kind: 'stt',
              deviceId: 'local-node',
              deviceSessionId: 'local-node-ui',
              capabilityId: 'local-node-stt',
              displayName: 'Kookr local speech-to-text',
              locality: 'node-local',
              scope: 'local-node-ui-only',
              protocol: 'kookr-stt-ws',
              endpointUrl: 'ws://descriptor-stt',
              advertisedAt: '2026-05-15T22:00:00.000Z',
              expiresAt: '2026-05-15T22:05:00.000Z',
              readiness: 'ready',
              privacy: 'local-only',
            },
          ],
        },
      },
    }, useKookrStore.getState().handleSnapshot);

    let draft = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(VoiceInputButton, {
        inputId: 'bilingual-parity',
        onTranscript: (text: string) => {
          draft = text;
        },
      }));
    });

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => FakeSTTWebSocket.instances.at(-1)!.onopen?.());
    expect(container.querySelector('.voice-preview[role="status"]')?.textContent).toBe('bonjour hello');
    expect(draft).toBe('');
    await act(async () => button!.click());
    await act(async () => FakeSTTWebSocket.instances.at(-1)!.finish());
    expect(draft).toBe('bonjour hello');
    expect(FakeSTTWebSocket.openedUrls).toEqual(['ws://descriptor-stt']);
    expect(useKookrStore.getState().activeSTTInputId).toBeNull();
  });
});
