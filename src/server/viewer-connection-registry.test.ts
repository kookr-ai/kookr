import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { Actor } from './auth.js';
import {
  ViewerConnectionRegistry,
  type GrantLiveness,
  type SweepEviction,
} from './viewer-connection-registry.js';

function fakeSocket(readyState: number = WebSocket.OPEN): WebSocket & { close: ReturnType<typeof vi.fn> } {
  return {
    readyState,
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket & { close: ReturnType<typeof vi.fn> };
}

/**
 * A fake socket that additionally implements the ping/pong surface
 * (`on`/`ping`/`terminate`) the #1725 liveness sweep depends on. `pong()`
 * simulates the peer answering a ping. `bufferedAmount` is a plain mutable
 * field so a test can simulate a draining send backlog between sweeps.
 * `capabilities` lets a test omit `on` or `ping` individually (R12 coverage).
 */
function livenessSocket(
  readyState: number = WebSocket.OPEN,
  opts: { bufferedAmount?: number; capabilities?: { on?: boolean; ping?: boolean } } = {},
): WebSocket & {
  close: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  pong: () => void;
  bufferedAmount: number;
} {
  let pongHandler: (() => void) | undefined;
  const hasOn = opts.capabilities?.on ?? true;
  const hasPing = opts.capabilities?.ping ?? true;
  return {
    readyState,
    bufferedAmount: opts.bufferedAmount ?? 0,
    close: vi.fn(),
    send: vi.fn(),
    ...(hasPing ? { ping: vi.fn() } : {}),
    terminate: vi.fn(),
    ...(hasOn
      ? {
          on: (event: string, handler: () => void) => {
            if (event === 'pong') pongHandler = handler;
          },
        }
      : {}),
    pong: () => pongHandler?.(),
  } as unknown as WebSocket & {
    close: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    pong: () => void;
    bufferedAmount: number;
  };
}

const OWNER: Actor = { kind: 'owner' };
function viewer(grantId: string): Actor {
  return { kind: 'viewer', grantId, scope: { kind: 'all' } };
}

describe('ViewerConnectionRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('register/unregister track dashboard and terminal pools independently', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    const dash = fakeSocket();
    const term = fakeSocket();
    registry.register(dash, OWNER, 'dashboard');
    registry.register(term, viewer('g1'), 'terminal', { sessionName: 'kookr-1' });

    expect(registry.size()).toBe(2);
    expect(registry.dashboardCount()).toBe(1);

    registry.unregister(dash);
    expect(registry.size()).toBe(1);
    expect(registry.dashboardCount()).toBe(0);
  });

  test('getOpenDashboardSockets returns a snapshot copy of only open dashboard sockets', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    const open = fakeSocket(WebSocket.OPEN);
    const closing = fakeSocket(WebSocket.CLOSING);
    const term = fakeSocket(WebSocket.OPEN);
    registry.register(open, OWNER, 'dashboard');
    registry.register(closing, OWNER, 'dashboard');
    registry.register(term, OWNER, 'terminal', { sessionName: 's' });

    const snapshot = registry.getOpenDashboardSockets();
    expect(snapshot).toEqual([open]);

    // Mutating the returned array does not affect the registry, and the array is
    // a copy taken at call time — later registrations don't appear in it.
    snapshot.push(term);
    registry.register(fakeSocket(), OWNER, 'dashboard');
    expect(registry.getOpenDashboardSockets()).toHaveLength(2);
  });

  test('snapshotDashboardConnections pairs each open socket with its actor', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    const dash = fakeSocket();
    registry.register(dash, viewer('g7'), 'dashboard');
    const conns = registry.snapshotDashboardConnections();
    expect(conns).toEqual([{ ws: dash, actor: viewer('g7') }]);
  });

  test('findByGrant returns sockets in both pools held by a grant', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    const dash = fakeSocket();
    const term = fakeSocket();
    const other = fakeSocket();
    registry.register(dash, viewer('g1'), 'dashboard');
    registry.register(term, viewer('g1'), 'terminal', { sessionName: 'kookr-a' });
    registry.register(other, viewer('g2'), 'dashboard');

    const found = registry.findByGrant('g1');
    expect(found.map((e) => e.kind).sort()).toEqual(['dashboard', 'terminal']);
    expect(registry.findByGrant('g2')).toHaveLength(1);
    expect(registry.findByGrant('missing')).toHaveLength(0);
  });

  test('sweep drops revoked/expired/not-found viewer sockets in both pools and keeps owners + valid viewers', () => {
    const liveness: Record<string, GrantLiveness> = {
      revoked: 'revoked',
      expired: 'expired',
      gone: 'not-found',
      live: 'active',
    };
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: (grantId) => liveness[grantId] ?? 'not-found',
    });
    const ownerDash = fakeSocket();
    const revokedDash = fakeSocket();
    const expiredTerm = fakeSocket();
    const goneDash = fakeSocket();
    const liveDash = fakeSocket();
    registry.register(ownerDash, OWNER, 'dashboard');
    registry.register(revokedDash, viewer('revoked'), 'dashboard');
    registry.register(expiredTerm, viewer('expired'), 'terminal', { sessionName: 's' });
    registry.register(goneDash, viewer('gone'), 'dashboard');
    registry.register(liveDash, viewer('live'), 'dashboard');

    registry.sweep();

    // Owner + live viewer survive; revoked/expired/not-found are dropped + closed.
    // Assert removal from the map (findByGrant), not just OPEN-ness, so a sweep
    // that closed sockets without deleting them would fail.
    expect(registry.size()).toBe(2);
    expect(registry.findByGrant('revoked')).toHaveLength(0);
    expect(registry.findByGrant('expired')).toHaveLength(0);
    expect(registry.findByGrant('gone')).toHaveLength(0);
    expect(registry.findByGrant('live')).toHaveLength(1);
    expect(registry.getOpenDashboardSockets()).toEqual(expect.arrayContaining([ownerDash, liveDash]));
    expect(revokedDash.close).toHaveBeenCalledWith(1008, 'Access revoked');
    expect(expiredTerm.close).toHaveBeenCalledWith(1008, 'Access revoked');
    expect(goneDash.close).toHaveBeenCalledWith(1008, 'Access revoked');
    expect(ownerDash.close).not.toHaveBeenCalled();
    expect(liveDash.close).not.toHaveBeenCalled();
  });

  test('onEvict audit hook receives grant id, pool kind, session name, and reason', () => {
    const evictions: SweepEviction[] = [];
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: () => 'revoked',
      onEvict: (e) => evictions.push(e),
    });
    registry.register(fakeSocket(), viewer('g1'), 'terminal', { sessionName: 'kookr-x' });
    registry.sweep();
    expect(evictions).toEqual([
      { grantId: 'g1', kind: 'terminal', sessionName: 'kookr-x', reason: 'revoked' },
    ]);
  });

  // #810: reassignment TOCTOU (RFC F8). A still-live grant may hold a terminal
  // socket whose task was reassigned out of scope after it opened; the sweep
  // re-checks terminal scope each tick and drops the now-out-of-scope socket.
  test('sweep evicts a terminal viewer socket whose task left scope (out-of-scope), keeping in-scope + dashboard sockets', () => {
    const evictions: SweepEviction[] = [];
    // Session→project mapping flips: kookr-moved leaves the grant's scope.
    const projectOf: Record<string, string> = { 'kookr-stay': 'p1', 'kookr-moved': 'p9' };
    const projectsViewer: Actor = { kind: 'viewer', grantId: 'gp', scope: { kind: 'projects', projectIds: ['p1'] } };
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      // All grants stay live — only scope changed, not revocation.
      resolveGrantLiveness: () => 'active',
      isActorAllowedTerminalSession: (actor, sessionName) => {
        if (actor.kind === 'owner' || actor.scope.kind === 'all') return true;
        const projectId = projectOf[sessionName];
        return projectId !== undefined && actor.scope.projectIds.includes(projectId);
      },
      onEvict: (e) => evictions.push(e),
    });
    const stayTerm = fakeSocket();
    const movedTerm = fakeSocket();
    const dashSock = fakeSocket(); // dashboard sockets are never scope-checked by the sweep
    registry.register(stayTerm, projectsViewer, 'terminal', { sessionName: 'kookr-stay' });
    registry.register(movedTerm, projectsViewer, 'terminal', { sessionName: 'kookr-moved' });
    registry.register(dashSock, projectsViewer, 'dashboard');

    registry.sweep();

    expect(registry.size()).toBe(2);
    // The MOVED terminal specifically is gone (not merely "some socket was
    // dropped" — a wrong-victim eviction would still leave count 2).
    expect(registry.findByGrant('gp').map((e) => e.sessionName)).not.toContain('kookr-moved');
    expect(registry.findByGrant('gp').map((e) => e.sessionName)).toContain('kookr-stay');
    expect(movedTerm.close).toHaveBeenCalledWith(1008, 'Out of scope');
    expect(stayTerm.close).not.toHaveBeenCalled();
    expect(dashSock.close).not.toHaveBeenCalled();
    expect(evictions).toEqual([
      { grantId: 'gp', kind: 'terminal', sessionName: 'kookr-moved', reason: 'out-of-scope' },
    ]);
  });

  // #810: a scope re-check that throws must fail CLOSED — the terminal is evicted,
  // not silently retained (which would leave the TOCTOU window open forever).
  test('sweep evicts (fail-closed) a terminal socket whose scope re-check throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const projectsViewer: Actor = { kind: 'viewer', grantId: 'gp', scope: { kind: 'projects', projectIds: ['p1'] } };
    const term = fakeSocket();
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: () => 'active',
      isActorAllowedTerminalSession: () => {
        throw new Error('task lookup blew up');
      },
    });
    registry.register(term, projectsViewer, 'terminal', { sessionName: 'kookr-x' });
    expect(() => registry.sweep()).not.toThrow();
    expect(registry.size()).toBe(0);
    expect(term.close).toHaveBeenCalledWith(1008, 'Out of scope');
  });

  test('sweep does not scope-check owner terminal sockets', () => {
    const isActorAllowedTerminalSession = vi.fn().mockReturnValue(true);
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: () => 'active',
      isActorAllowedTerminalSession,
    });
    const ownerTerm = fakeSocket();
    registry.register(ownerTerm, OWNER, 'terminal', { sessionName: 'kookr-owner' });
    registry.sweep();
    // Owner sockets short-circuit before the scope predicate (they aren't viewers).
    expect(isActorAllowedTerminalSession).not.toHaveBeenCalled();
    expect(ownerTerm.close).not.toHaveBeenCalled();
  });

  test('a throwing onEvict hook does not abort the sweep; the socket is still dropped and closed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeSocket();
    const b = fakeSocket();
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: () => 'revoked',
      onEvict: () => {
        throw new Error('audit sink down');
      },
    });
    registry.register(a, viewer('g1'), 'dashboard');
    registry.register(b, viewer('g2'), 'dashboard');

    expect(() => registry.sweep()).not.toThrow();
    expect(registry.size()).toBe(0);
    expect(a.close).toHaveBeenCalledWith(1008, 'Access revoked');
    expect(b.close).toHaveBeenCalledWith(1008, 'Access revoked');
  });

  test('a throwing ws.close during eviction does not abort the sweep for other sockets', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = fakeSocket();
    (bad.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket already torn down');
    });
    const good = fakeSocket();
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: () => 'expired',
    });
    registry.register(bad, viewer('g1'), 'dashboard');
    registry.register(good, viewer('g2'), 'dashboard');

    expect(() => registry.sweep()).not.toThrow();
    // Both are removed from the map even though one close threw.
    expect(registry.size()).toBe(0);
    expect(good.close).toHaveBeenCalledOnce();
  });

  test('a throwing liveness resolver isolates the bad socket and does not abort the tick or future ticks', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = fakeSocket();
    const good = fakeSocket();
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      resolveGrantLiveness: (grantId) => {
        if (grantId === 'bad') throw new Error('resolver blew up');
        return 'revoked';
      },
    });
    registry.register(bad, viewer('bad'), 'dashboard');
    registry.register(good, viewer('good'), 'dashboard');

    expect(() => registry.sweep()).not.toThrow();
    // The good socket is still evicted despite the bad one throwing.
    expect(good.close).toHaveBeenCalledOnce();
    expect(registry.findByGrant('good')).toHaveLength(0);
    // The throwing socket is left registered (it was never successfully resolved),
    // and a later tick still runs.
    expect(registry.findByGrant('bad')).toHaveLength(1);
    expect(bad.close).not.toHaveBeenCalled();
    expect(registry.sweepTickCount).toBe(1);
    expect(() => registry.sweep()).not.toThrow();
    expect(registry.sweepTickCount).toBe(2);
  });

  test('sweepTickCount and lastSweepAt are exposed and advance per tick', () => {
    let clock = 1000;
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      now: () => clock,
    });
    expect(registry.sweepTickCount).toBe(0);
    expect(registry.lastSweepAt).toBeNull();
    registry.sweep();
    expect(registry.sweepTickCount).toBe(1);
    expect(registry.lastSweepAt).toBe(1000);
    clock = 2000;
    registry.sweep();
    expect(registry.sweepTickCount).toBe(2);
    expect(registry.lastSweepAt).toBe(2000);
  });

  test('the interval-driven sweep stops after stopSweep', () => {
    vi.useFakeTimers();
    const registry = new ViewerConnectionRegistry({ sweepIntervalMs: 1000 });
    vi.advanceTimersByTime(3000);
    expect(registry.sweepTickCount).toBe(3);
    registry.stopSweep();
    vi.advanceTimersByTime(5000);
    expect(registry.sweepTickCount).toBe(3);
  });

  test('closeAll closes every socket in both pools and clears the registry', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    const dash = fakeSocket();
    const term = fakeSocket();
    registry.register(dash, OWNER, 'dashboard');
    registry.register(term, viewer('g1'), 'terminal', { sessionName: 's' });
    registry.closeAll();
    expect(dash.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(term.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(registry.size()).toBe(0);
  });

  test('viewerRoster reports only open viewer sockets with connection metadata (#808)', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false, now: () => 1_700_000_000_000 });
    const owner = fakeSocket();
    const dashViewer = fakeSocket();
    const termViewer = fakeSocket();
    const closingViewer = fakeSocket(WebSocket.CLOSING);
    registry.register(owner, OWNER, 'dashboard'); // owner excluded
    registry.register(dashViewer, viewer('g1'), 'dashboard', { remoteAddr: '10.0.0.5' });
    registry.register(termViewer, viewer('g1'), 'terminal', { sessionName: 'kookr-7', remoteAddr: '10.0.0.5' });
    registry.register(closingViewer, viewer('g2'), 'dashboard'); // not open → excluded

    const roster = registry.viewerRoster();
    expect(roster).toHaveLength(2);
    expect(roster).toContainEqual({
      grantId: 'g1',
      kind: 'dashboard',
      connectedAt: '2023-11-14T22:13:20.000Z',
      remoteAddr: '10.0.0.5',
      scopeEffective: { kind: 'all' },
    });
    expect(roster).toContainEqual({
      grantId: 'g1',
      kind: 'terminal',
      sessionName: 'kookr-7',
      connectedAt: '2023-11-14T22:13:20.000Z',
      remoteAddr: '10.0.0.5',
      scopeEffective: { kind: 'all' },
    });
  });

  test('connectedViewerCount counts distinct connected viewer grants (#808)', () => {
    const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
    registry.register(fakeSocket(), OWNER, 'dashboard');
    registry.register(fakeSocket(), viewer('g1'), 'dashboard');
    registry.register(fakeSocket(), viewer('g1'), 'terminal', { sessionName: 's' });
    registry.register(fakeSocket(), viewer('g2'), 'dashboard');
    registry.register(fakeSocket(WebSocket.CLOSING), viewer('g3'), 'dashboard'); // not open
    expect(registry.connectedViewerCount()).toBe(2);
  });

  test('broadcasterHealth exposes sweep cadence, liveness and viewer count (#808 / R10)', () => {
    let clock = 1_700_000_000_000;
    const registry = new ViewerConnectionRegistry({
      autoStartSweep: false,
      sweepIntervalMs: 10_000,
      now: () => clock,
    });
    expect(registry.broadcasterHealth()).toEqual({
      sweepIntervalMs: 10_000,
      lastSweepAt: null,
      sweepTickCount: 0,
      connectedViewerCount: 0,
    });
    registry.register(fakeSocket(), viewer('g1'), 'dashboard');
    clock = 1_700_000_005_000;
    registry.sweep();
    const health = registry.broadcasterHealth();
    expect(health.sweepIntervalMs).toBe(10_000);
    expect(health.sweepTickCount).toBe(1);
    expect(health.lastSweepAt).toBe('2023-11-14T22:13:25.000Z');
    expect(health.connectedViewerCount).toBe(1);
  });

  describe('dead-socket liveness reaping (#1725)', () => {
    test('an OPEN socket that answers pong survives repeated sweeps and owners are covered too', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket();
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep();
      expect(ws.ping).toHaveBeenCalledTimes(1);
      ws.pong();
      registry.sweep();
      expect(ws.ping).toHaveBeenCalledTimes(2);
      ws.pong();
      registry.sweep();

      expect(ws.terminate).not.toHaveBeenCalled();
      expect(registry.size()).toBe(1);
    });

    test('a socket that never answers pong is terminated on the sweep after the missed round', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket();
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep(); // sends the first ping, no pong yet expected
      expect(registry.size()).toBe(1);
      expect(ws.terminate).not.toHaveBeenCalled();

      registry.sweep(); // ping unanswered for a full tick → reaped
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });

    test('a socket already non-OPEN (CLOSE-WAIT/CLOSING) is terminated and dropped immediately, without waiting on its close handler', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket(WebSocket.CLOSING);
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep();

      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });

    test('liveness reaping covers viewer AND terminal sockets, not just dashboard owners', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const dead = livenessSocket();
      registry.register(dead, viewer('g1'), 'terminal', { sessionName: 'kookr-1' });

      registry.sweep();
      registry.sweep(); // unanswered ping → reaped

      expect(dead.terminate).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });

    test('a socket that answers pong is never reaped even under many sweeps', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket();
      registry.register(ws, OWNER, 'dashboard');
      for (let i = 0; i < 5; i++) {
        registry.sweep();
        ws.pong();
      }
      expect(ws.terminate).not.toHaveBeenCalled();
    });

    test('livenessSweepEnabled: false opts out entirely — a dead socket is left for the revocation path only', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false, livenessSweepEnabled: false });
      const ws = livenessSocket();
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep();
      registry.sweep();
      registry.sweep();

      expect(ws.ping).not.toHaveBeenCalled();
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(registry.size()).toBe(1);
    });

    test('a socket lacking ping/on (lightweight test double) only gets the readyState check, never throws', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const openPlain = fakeSocket(WebSocket.OPEN);
      const closingPlain = fakeSocket(WebSocket.CLOSING);
      registry.register(openPlain, OWNER, 'dashboard');
      registry.register(closingPlain, OWNER, 'dashboard');

      expect(() => registry.sweep()).not.toThrow();
      expect(registry.size()).toBe(1); // only the CLOSING one was reaped
    });

    test('a throwing ping reaps the socket immediately instead of waiting a tick', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket();
      (ws.ping as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('socket already destroyed');
      });
      registry.register(ws, OWNER, 'dashboard');

      expect(() => registry.sweep()).not.toThrow();
      expect(ws.terminate).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(0);
    });

    test('livenessHealth reports enabled state, reap count and last-reap timestamp', () => {
      let clock = 1_700_000_000_000;
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false, now: () => clock });
      expect(registry.livenessHealth()).toEqual({ enabled: true, reapCount: 0, lastReapAt: null });

      const dead = livenessSocket();
      registry.register(dead, OWNER, 'dashboard');
      registry.sweep();
      registry.sweep(); // reaps
      clock = 1_700_000_010_000;

      const health = registry.livenessHealth();
      expect(health.enabled).toBe(true);
      expect(health.reapCount).toBe(1);
      expect(health.lastReapAt).toBe('2023-11-14T22:13:20.000Z');
    });

    test('a throwing liveness check for one socket does not block reaping/revocation of the rest of the tick', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const registry = new ViewerConnectionRegistry({
        autoStartSweep: false,
        resolveGrantLiveness: () => 'revoked',
      });
      const poison = livenessSocket();
      (poison.ping as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom');
      });
      const revokedViewer = fakeSocket();
      registry.register(poison, OWNER, 'dashboard');
      registry.register(revokedViewer, viewer('g1'), 'dashboard');

      expect(() => registry.sweep()).not.toThrow();
      expect(revokedViewer.close).toHaveBeenCalledWith(1008, 'Access revoked');
      expect(registry.size()).toBe(0);
    });

    test('a socket with a nonzero send backlog is NOT reaped for missing a pong — ping physically queues behind the backlog (R1)', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket(WebSocket.OPEN, { bufferedAmount: 2_000_000 }); // mid-drain on a large snapshot
      registry.register(ws, OWNER, 'dashboard');

      // Many sweeps while backlogged — never pinged, never reaped, because a
      // ping would just queue behind the backlog and can never return in time.
      for (let i = 0; i < 5; i++) registry.sweep();

      expect(ws.ping).not.toHaveBeenCalled();
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(registry.size()).toBe(1);
    });

    test('a socket drains mid-liveness-check and resumes normal ping/pong reaping once backlog clears', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket(WebSocket.OPEN, { bufferedAmount: 2_000_000 });
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep(); // backlogged: exempt, not pinged
      expect(ws.ping).not.toHaveBeenCalled();

      ws.bufferedAmount = 0; // drains
      registry.sweep(); // first ping now that it's clear
      expect(ws.ping).toHaveBeenCalledTimes(1);
      expect(registry.size()).toBe(1);

      registry.sweep(); // unanswered ping on a now-healthy socket → reaped
      expect(ws.terminate).toHaveBeenCalledTimes(1);
    });

    test('reaping a viewer socket fires the onEvict audit hook with reason liveness-timeout (R11)', () => {
      const evictions: SweepEviction[] = [];
      const registry = new ViewerConnectionRegistry({
        autoStartSweep: false,
        onEvict: (e) => evictions.push(e),
      });
      const ws = livenessSocket();
      registry.register(ws, viewer('g9'), 'dashboard');

      registry.sweep();
      registry.sweep(); // unanswered ping → reaped

      expect(evictions).toEqual([{ grantId: 'g9', kind: 'dashboard', sessionName: undefined, reason: 'liveness-timeout' }]);
    });

    test('reaping an OWNER socket does not call onEvict (audit hook is viewer-only, matching evict())', () => {
      const evictions: SweepEviction[] = [];
      const registry = new ViewerConnectionRegistry({
        autoStartSweep: false,
        onEvict: (e) => evictions.push(e),
      });
      const ws = livenessSocket();
      registry.register(ws, OWNER, 'dashboard');

      registry.sweep();
      registry.sweep();

      expect(evictions).toEqual([]);
    });

    test('a socket with ping but no on() is treated as unsupported — never reaped via liveness (R12)', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket(WebSocket.OPEN, { capabilities: { on: false, ping: true } });
      registry.register(ws, OWNER, 'dashboard');

      for (let i = 0; i < 5; i++) registry.sweep();

      expect(ws.ping).not.toHaveBeenCalled();
      expect(ws.terminate).not.toHaveBeenCalled();
      expect(registry.size()).toBe(1);
    });

    test('a socket with on() but no ping is treated as unsupported — never reaped via liveness (R12)', () => {
      const registry = new ViewerConnectionRegistry({ autoStartSweep: false });
      const ws = livenessSocket(WebSocket.OPEN, { capabilities: { on: true, ping: false } });
      registry.register(ws, OWNER, 'dashboard');

      for (let i = 0; i < 5; i++) registry.sweep();

      expect(ws.terminate).not.toHaveBeenCalled();
      expect(registry.size()).toBe(1);
    });
  });
});
