import { describe, expect, it } from 'vitest';
import { createKookrStore } from '../store/useStore.js';
import { parseServerMessageForClient } from '../hooks/useWebSocket.js';

describe('Phase 6 bundle cache mismatch compatibility', () => {
  it('Phase 6 store falls back to Phase 5 legacy STT fields when descriptors are absent', () => {
    const store = createKookrStore();

    store.getState().handleSnapshot([], '/repo', undefined, undefined, true, 'ws://legacy-stt');

    expect(store.getState().sttUrl).toBe('ws://legacy-stt');
    expect(store.getState().speechCapabilities).toBeNull();
  });

  it('Phase 6 store can use STT descriptors when legacy fields are absent', () => {
    const store = createKookrStore();

    store.getState().handleSnapshot(
      [],
      '/repo',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
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
    );

    expect(store.getState().sttUrl).toBe('ws://descriptor-stt');
    expect(store.getState().speechCapabilities?.capabilitiesByDevice['local-node']).toHaveLength(1);
  });

  it('older bundle parsing path tolerates Phase 6 speechCapabilities as an unknown snapshot field', () => {
    const parsed = parseServerMessageForClient(JSON.stringify({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      sttEnabled: true,
      sttUrl: 'ws://legacy-stt',
      speechCapabilities: {
        capabilitiesByDevice: {
          'local-node': [],
        },
      },
    }));

    expect(parsed).toMatchObject({
      type: 'snapshot',
      sttUrl: 'ws://legacy-stt',
      speechCapabilities: { capabilitiesByDevice: { 'local-node': [] } },
    });
  });
});
