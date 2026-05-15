import { describe, expect, it } from 'vitest';

import { ControllerLeaseManager } from '../controller-lease.js';
import {
  asActorId,
  asClientId,
  asLeaseId,
  asNodeEpoch,
  asNodeId,
  asServerRevision,
  asSessionEpoch,
  asSessionId,
} from '../ids.js';
import type { LeaseChangedEvent } from '../control-events.js';

function manager() {
  const events: LeaseChangedEvent[] = [];
  const timers: Array<() => void> = [];
  let revision = 0;
  const leases = new ControllerLeaseManager({
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    nextServerRevision: () => asServerRevision(++revision),
    publish: (event) => events.push(event),
    setTimer: (cb) => {
      timers.push(cb);
      return cb as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });
  return { leases, events, timers };
}

describe('ControllerLeaseManager', () => {
  it('broadcasts disconnect uncertainty, presumes lost for clients, and revokes locally', () => {
    const { leases, events, timers } = manager();
    const acquired = leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });
    expect(acquired.ok).toBe(true);

    leases.handleRelayDisconnect();

    expect(leases.current(asSessionId('s1'))?.state).toBe('revoked');
    expect(events.at(-1)).toMatchObject({
      kind: 'lease.changed',
      payload: {
        sessionId: 's1',
        newState: 'held-uncertain',
      },
    });

    timers[0]();
    expect(events.at(-1)).toMatchObject({
      payload: {
        newState: 'held-presumed-lost',
        reason: 'node-disconnect',
      },
    });

    leases.handleRelayReconnect();
    expect(events.at(-1)).toMatchObject({
      payload: {
        newState: 'revoked',
        reason: 'node-disconnect',
      },
    });
  });

  it('turns one missed heartbeat into uncertain and two into node-side revoke', () => {
    const { leases, events } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    expect(leases.recordHeartbeatMiss({
      sessionId: asSessionId('s1'),
      leaseId: asLeaseId('lease-1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
    })).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ payload: { newState: 'held-uncertain' } });

    expect(leases.recordHeartbeatMiss({
      sessionId: asSessionId('s1'),
      leaseId: asLeaseId('lease-1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
    })).toEqual({
      ok: false,
      reason: 'error.leaseRevoked',
    });
    expect(events.at(-1)).toMatchObject({
      payload: {
        newState: 'revoked',
        reason: 'heartbeat-timeout',
      },
    });
  });

  it('rejects heartbeat spoofing from a non-holder client', () => {
    const { leases } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    expect(leases.recordHeartbeatAck({
      sessionId: asSessionId('s1'),
      leaseId: asLeaseId('lease-1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-2'),
    })).toEqual({
      ok: false,
      reason: 'error.leaseMismatch',
    });
  });

  it('owner override rejects delayed commands from the former holder', () => {
    const { leases, events } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    leases.acquireLocal({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
    });

    expect(events.some((event) => (
      event.payload.newState === 'revoked'
      && event.payload.reason === 'owner-override'
    ))).toBe(true);
    expect(leases.validateRemoteSubmit({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    })).toEqual({ ok: false, reason: 'error.leaseRevoked' });
  });
});
