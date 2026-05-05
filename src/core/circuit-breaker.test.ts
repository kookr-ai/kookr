import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CircuitBreakerOpenError,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('starts in closed state', () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.getState()).toBe('closed');
    expect(cb.getSnapshot().state).toBe('closed');
    cb.dispose();
  });

  test('call passes through when closed', async () => {
    const cb = new CircuitBreaker({ name: 'test' });
    const result = await cb.call(async () => 42);
    expect(result).toBe(42);
    cb.dispose();
  });

  test('call propagates errors and records failure', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
    await expect(cb.call(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(cb.getSnapshot().failureCount).toBe(1);
    expect(cb.getState()).toBe('closed');
    cb.dispose();
  });

  test('trips open after failure threshold', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    }
    expect(cb.getState()).toBe('open');
    cb.dispose();
  });

  test('rejects calls when open with CircuitBreakerOpenError', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe('open');

    await expect(cb.call(async () => 'ok')).rejects.toBeInstanceOf(CircuitBreakerOpenError);
    await expect(cb.call(async () => 'ok')).rejects.toHaveProperty('breakerName', 'test');
    cb.dispose();
  });

  test('transitions to half-open after reset timeout', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 5000 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe('open');

    vi.advanceTimersByTime(5000);
    expect(cb.getState()).toBe('half-open');
    cb.dispose();
  });

  test('half-open closes after enough successes', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      halfOpenSuccessThreshold: 2,
    });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    vi.advanceTimersByTime(1000);
    expect(cb.getState()).toBe('half-open');

    await cb.call(async () => 'ok');
    expect(cb.getState()).toBe('half-open');

    await cb.call(async () => 'ok');
    expect(cb.getState()).toBe('closed');
    cb.dispose();
  });

  test('half-open reopens on any failure', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
    });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    vi.advanceTimersByTime(1000);
    expect(cb.getState()).toBe('half-open');

    await cb.call(async () => { throw new Error('fail again'); }).catch(() => {});
    expect(cb.getState()).toBe('open');
    cb.dispose();
  });

  test('sliding failure window expires old failures', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      failureWindowMs: 5000,
    });

    // Record 2 failures
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getSnapshot().failureCount).toBe(2);

    // Advance past window — old failures expire
    vi.advanceTimersByTime(6000);

    // Third failure is the only one in the window
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getSnapshot().failureCount).toBe(1);
    expect(cb.getState()).toBe('closed');
    cb.dispose();
  });

  test('manual rearm closes the breaker', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe('open');

    cb.rearm();
    expect(cb.getState()).toBe('closed');

    // Should accept calls again
    const result = await cb.call(async () => 'ok');
    expect(result).toBe('ok');
    cb.dispose();
  });

  test('emits state change events', async () => {
    const cb = new CircuitBreaker({
      name: 'test',
      failureThreshold: 1,
      resetTimeoutMs: 1000,
    });
    const events: CircuitBreakerSnapshot[] = [];
    cb.onChange((snap) => events.push(snap));

    // Trip open
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe('open');

    // Auto half-open
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(2);
    expect(events[1].state).toBe('half-open');

    // Rearm to closed
    cb.rearm();
    expect(events).toHaveLength(3);
    expect(events[2].state).toBe('closed');

    cb.dispose();
  });

  test('unsubscribe stops delivering events', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    const events: CircuitBreakerSnapshot[] = [];
    const unsub = cb.onChange((snap) => events.push(snap));

    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(events).toHaveLength(1);

    unsub();
    cb.rearm();
    // No new event after unsubscribe
    expect(events).toHaveLength(1);
    cb.dispose();
  });

  test('dispose clears timers and listeners', async () => {
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 1000 });
    const events: CircuitBreakerSnapshot[] = [];
    cb.onChange((snap) => events.push(snap));

    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe('open');

    cb.dispose();
    vi.advanceTimersByTime(2000);
    // Should NOT have transitioned — timer was cleared
    expect(cb.getState()).toBe('open');
    expect(events).toHaveLength(1); // only the trip event
  });

  test('snapshot includes lastFailureTime', async () => {
    const cb = new CircuitBreaker({ name: 'test' });
    expect(cb.getSnapshot().lastFailureTime).toBeNull();

    const now = Date.now();
    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getSnapshot().lastFailureTime).toBe(now);
    cb.dispose();
  });
});

describe('CircuitBreakerRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('register and get breakers', () => {
    const registry = new CircuitBreakerRegistry();
    const cb = new CircuitBreaker({ name: 'llm' });
    registry.register(cb);

    expect(registry.get('llm')).toBe(cb);
    expect(registry.get('unknown')).toBeUndefined();
    registry.dispose();
  });

  test('getAllSnapshots returns all registered breakers', () => {
    const registry = new CircuitBreakerRegistry();
    registry.register(new CircuitBreaker({ name: 'llm' }));
    registry.register(new CircuitBreaker({ name: 'github' }));

    const snapshots = registry.getAllSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map(s => s.name).sort()).toEqual(['github', 'llm']);
    registry.dispose();
  });

  test('rearm delegates to the breaker', async () => {
    const registry = new CircuitBreakerRegistry();
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    registry.register(cb);

    await cb.call(async () => { throw new Error('fail'); }).catch(() => {});
    expect(cb.getState()).toBe('open');

    expect(registry.rearm('test')).toBe(true);
    expect(cb.getState()).toBe('closed');

    expect(registry.rearm('unknown')).toBe(false);
    registry.dispose();
  });

  test('registry onChange fires for any breaker state change', async () => {
    const registry = new CircuitBreakerRegistry();
    const cb1 = new CircuitBreaker({ name: 'a', failureThreshold: 1 });
    const cb2 = new CircuitBreaker({ name: 'b', failureThreshold: 1 });
    registry.register(cb1);
    registry.register(cb2);

    const events: CircuitBreakerSnapshot[] = [];
    registry.onChange((snap) => events.push(snap));

    await cb1.call(async () => { throw new Error('fail'); }).catch(() => {});
    await cb2.call(async () => { throw new Error('fail'); }).catch(() => {});

    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('a');
    expect(events[1].name).toBe('b');
    registry.dispose();
  });

  test('dispose cleans up all breakers', () => {
    const registry = new CircuitBreakerRegistry();
    const cb = new CircuitBreaker({ name: 'test', failureThreshold: 1, resetTimeoutMs: 1000 });
    registry.register(cb);

    registry.dispose();
    expect(registry.get('test')).toBeUndefined();
    expect(registry.getAllSnapshots()).toHaveLength(0);
  });
});
