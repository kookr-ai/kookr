import { describe, expect, it } from 'vitest';
import {
  dispatchAlertMessageForClient,
  dispatchCoordinatorSnapshotMessageForClient,
  dispatchSnapshotMessageForClient,
  parseServerMessageForClient,
} from './useWebSocket.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';

describe('parseServerMessageForClient snapshot tolerance', () => {
  it('preserves unknown snapshot fields for additive server-message compatibility', () => {
    const parsed = parseServerMessageForClient(JSON.stringify({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    }));

    expect(parsed).toMatchObject({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      futureField: { ok: true },
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseServerMessageForClient('{not-json')).toBeNull();
  });

  it('dispatches Phase 6 speech capabilities through the snapshot runtime path', () => {
    const calls: unknown[][] = [];
    dispatchSnapshotMessageForClient({
      type: 'snapshot',
      agents: [],
      serverCwd: '/repo',
      maxActiveTasks: 7,
      coordinator: { outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }], chips: [], findings: [], chains: {} },
      speechCapabilities: {
        capabilitiesByDevice: {
          'local-node': [],
        },
      },
    }, (...args) => {
      calls.push(args);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0][12]).toBe(7);
    expect(calls[0][13]).toEqual({ capabilitiesByDevice: { 'local-node': [] } });
    expect(calls[0][14]).toEqual({ outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }], chips: [], findings: [], chains: {} });
  });

  it('dispatches standalone coordinator snapshots through the coordinator runtime path', () => {
    const coordinator = {
      outputs: [{ detectorId: 'stale', taskId: 'task-1', evidence: {} }],
      chips: [],
      findings: [],
      chains: {},
    };

    useKookrStore.setState({ coordinator: null });
    dispatchCoordinatorSnapshotMessageForClient({
      type: 'coordinator.snapshot',
      coordinator,
    });

    expect(useKookrStore.getState().coordinator).toEqual(coordinator);
  });

  it('dispatches alert details through the WebSocket alert runtime path', () => {
    const store = createKookrStore();

    dispatchAlertMessageForClient({
      type: 'alert',
      agentId: '',
      summary: 'Error starting "demo": spawn failed',
      details: 'Run `pnpm run doctor` from the Kookr checkout.',
      severity: 'critical',
    }, store.getState().handleAlert);

    expect(store.getState().alerts[0]).toMatchObject({
      summary: 'Error starting "demo": spawn failed',
      details: 'Run `pnpm run doctor` from the Kookr checkout.',
      severity: 'error',
    });
  });
});
