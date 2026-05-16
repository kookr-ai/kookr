// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { dispatchSnapshotMessageForClient } from '../hooks/useWebSocket.js';
import { useKookrStore } from '../store/useStore.js';
import { VoiceInputButton } from '../components/VoiceInputButton.js';
import { firstReadyKookrSTTEndpoint } from '../../shared/contracts/speech.js';
import type { SnapshotMessage } from '../../shared/contracts/messages.js';

// Phase 6 acceptance gate 4 (issue #333): a SnapshotMessage may carry BOTH
// the legacy Phase-5 STT/TTS fields and the additive SpeechCapability
// descriptors. The migration is parallel-fields, not a swap — the dashboard
// must ignore neither path, and local STT must keep functioning.

const LEGACY_STT_URL = 'ws://legacy-stt';
const DESCRIPTOR_STT_URL = 'ws://descriptor-stt';

/**
 * A snapshot in the parallel-fields state: legacy `sttEnabled`/`sttUrl` and
 * `ttsEnabled`/`ttsUrl` present alongside the Phase 6 `speechCapabilities`
 * descriptors. The legacy STT URL and the descriptor endpoint are
 * deliberately different so a test can tell which path drove a connection.
 */
function parallelFieldsSnapshot(): SnapshotMessage {
  return {
    type: 'snapshot',
    agents: [],
    serverCwd: '/repo',
    sttEnabled: true,
    sttUrl: LEGACY_STT_URL,
    ttsEnabled: true,
    ttsUrl: 'http://legacy-tts',
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
            endpointUrl: DESCRIPTOR_STT_URL,
            advertisedAt: '2026-05-15T22:00:00.000Z',
            expiresAt: '2026-05-15T22:05:00.000Z',
            readiness: 'ready',
            privacy: 'local-only',
          },
          {
            kind: 'tts',
            deviceId: 'local-node',
            deviceSessionId: 'local-node-ui',
            capabilityId: 'local-node-tts',
            displayName: 'Kookr local text-to-speech',
            locality: 'node-local',
            scope: 'local-node-ui-only',
            endpointUrl: 'http://descriptor-tts',
            advertisedAt: '2026-05-15T22:00:00.000Z',
            expiresAt: '2026-05-15T22:05:00.000Z',
            readiness: 'ready',
            privacy: 'local-only',
          },
        ],
      },
    },
  };
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 2_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${label}`));
      }
    }, 10);
  });
}

function createFakeMediaStream(): MediaStream {
  return {
    getTracks: () => [{ stop: vi.fn() }],
    getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 16_000 }), stop: vi.fn() }],
  } as unknown as MediaStream;
}

class FakeSTTWebSocket {
  static readonly OPEN = 1;
  static openedUrls: string[] = [];

  readyState = FakeSTTWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSTTWebSocket.openedUrls.push(url);
    setTimeout(() => this.onopen?.(), 0);
  }

  send(data: string | ArrayBuffer): void {
    // Answer on whichever URL the hook opened, so the openedUrls assertion
    // below — not this mock — is the single source of truth for which path
    // (legacy sttUrl vs descriptor endpoint) the resolver actually chose.
    if (typeof data === 'string' && data.includes('"config"')) {
      setTimeout(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'progressive',
            fixedText: 'bonjour',
            activeText: 'hello',
          }),
        });
      }, 0);
    }
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

describe('Phase 6 parallel-fields coexistence', () => {
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
    FakeSTTWebSocket.openedUrls = [];
    vi.unstubAllGlobals();
  });

  it('keeps both the legacy STT field and the SpeechCapability descriptors when a snapshot carries both', () => {
    dispatchSnapshotMessageForClient(parallelFieldsSnapshot(), useKookrStore.getState().handleSnapshot);
    const state = useKookrStore.getState();

    // Legacy field consumed: the dashboard drives STT off the legacy sttUrl.
    expect(state.sttUrl).toBe(LEGACY_STT_URL);
    // New field consumed: descriptors retained verbatim, not dropped.
    expect(state.speechCapabilities?.capabilitiesByDevice['local-node']).toHaveLength(2);
    // The descriptor path stays independently resolvable for the migration.
    expect(firstReadyKookrSTTEndpoint(state.speechCapabilities ?? undefined)).toBe(DESCRIPTOR_STT_URL);
  });

  it('falls back to the descriptor endpoint when a legacy sttUrl is present but disabled', () => {
    // Legacy sttUrl is still in the snapshot but sttEnabled is false. The
    // resolver must not use the stale legacy URL — it falls back to the
    // descriptor endpoint. This pins the sttEnabled guard in handleSnapshot.
    dispatchSnapshotMessageForClient(
      { ...parallelFieldsSnapshot(), sttEnabled: false },
      useKookrStore.getState().handleSnapshot,
    );
    const state = useKookrStore.getState();

    expect(state.sttUrl).toBe(DESCRIPTOR_STT_URL);
    expect(state.speechCapabilities?.capabilitiesByDevice['local-node']).toHaveLength(2);
  });

  it('drives local STT to draft text while both legacy and descriptor fields are present', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    installAudioCaptureStubs();
    dispatchSnapshotMessageForClient(parallelFieldsSnapshot(), useKookrStore.getState().handleSnapshot);

    let draft = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(VoiceInputButton, {
        inputId: 'parallel-fields-coexist',
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

    await waitForCondition(() => draft === 'bonjour hello', 'parallel-fields STT draft text');
    // Local STT functions with both fields present, and the legacy sttUrl
    // stays authoritative for the live connection. Descriptor-driven STT (the
    // legacy-stripped case) is covered by bilingual-stt-parity-ui.test.ts; the
    // descriptors still being retained is asserted by the first test above.
    expect(FakeSTTWebSocket.openedUrls).toEqual([LEGACY_STT_URL]);
    expect(useKookrStore.getState().activeSTTInputId).toBe('parallel-fields-coexist');
  });
});
