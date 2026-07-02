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
  const timers: Array<{ cb: () => void; active: boolean; id: number; ms: number }> = [];
  let nowMs = 0;
  let nextTimerId = 0;
  let revision = 0;
  const leases = new ControllerLeaseManager({
    nodeId: asNodeId('node-1'),
    nodeEpoch: asNodeEpoch('1'),
    nextServerRevision: () => asServerRevision(++revision),
    publish: (event) => events.push(event),
    heartbeatIntervalMs: 100,
    presumedLostGraceMs: 50,
    now: () => nowMs,
    setTimer: (cb, ms) => {
      const timer = { cb, active: true, id: ++nextTimerId, ms };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      const timerId = (timer as unknown as { id: number }).id;
      const found = timers.find((entry) => entry.id === timerId);
      if (found) found.active = false;
    },
  });
  return {
    leases,
    events,
    advance: (ms: number) => {
      nowMs += ms;
    },
    fireTimer: (index: number, expectedMs: number) => {
      const timer = timers[index];
      expect(timer?.active).toBe(true);
      expect(timer.ms).toBe(expectedMs);
      timer.active = false;
      timer.cb();
    },
  };
}

describe('ControllerLeaseManager', () => {
  it('broadcasts disconnect uncertainty, presumes lost for clients, and revokes locally', () => {
    const { leases, events, fireTimer } = manager();
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

    fireTimer(1, 250);
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

  it('sweeps stale held-remote leases after the heartbeat timeout', () => {
    const { leases, events, advance, fireTimer } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    advance(100);
    fireTimer(0, 100);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(100);
    fireTimer(1, 100);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(49);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(1);
    fireTimer(2, 50);
    expect(leases.current(asSessionId('s1'))?.state).toBe('revoked');
    expect(events.at(-1)).toMatchObject({
      payload: {
        newState: 'revoked',
        reason: 'heartbeat-timeout',
      },
    });
  });

  it('uses heartbeat acknowledgements to refresh the sweep timeout', () => {
    const { leases, advance, fireTimer } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    advance(100);
    fireTimer(0, 100);
    advance(100);
    fireTimer(1, 100);
    advance(40);
    expect(leases.recordHeartbeatAck({
      sessionId: asSessionId('s1'),
      leaseId: asLeaseId('lease-1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
    })).toMatchObject({ ok: true });

    advance(10);
    fireTimer(2, 50);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(100);
    fireTimer(3, 100);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(100);
    fireTimer(4, 100);
    expect(leases.current(asSessionId('s1'))?.state).toBe('held-remote');

    advance(40);
    fireTimer(5, 40);
    expect(leases.current(asSessionId('s1'))?.state).toBe('revoked');
  });

  it('schedules the next sweep for the nearest remote lease deadline', () => {
    const { leases, advance, fireTimer } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    advance(100);
    fireTimer(0, 100);
    advance(100);
    fireTimer(1, 100);
    advance(50);
    fireTimer(2, 50);
    expect(leases.current(asSessionId('s1'))?.state).toBe('revoked');
  });

  it('uses the earliest deadline when multiple remote leases are held', () => {
    const { leases, advance, fireTimer } = manager();
    leases.acquireRemote({
      sessionId: asSessionId('s1'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-1'),
      clientId: asClientId('client-1'),
      leaseId: asLeaseId('lease-1'),
    });

    advance(100);
    fireTimer(0, 100);
    leases.acquireRemote({
      sessionId: asSessionId('s2'),
      sessionEpoch: asSessionEpoch('1'),
      actorId: asActorId('owner-2'),
      clientId: asClientId('client-2'),
      leaseId: asLeaseId('lease-2'),
    });

    advance(100);
    fireTimer(1, 100);
    advance(50);
    fireTimer(2, 50);
    expect(leases.current(asSessionId('s1'))?.state).toBe('revoked');
    expect(leases.current(asSessionId('s2'))?.state).toBe('held-remote');

    advance(100);
    fireTimer(3, 100);
    expect(leases.current(asSessionId('s2'))?.state).toBe('revoked');
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
