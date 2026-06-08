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
});
