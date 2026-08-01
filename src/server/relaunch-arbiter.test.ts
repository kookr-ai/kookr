import { describe, it, expect, beforeEach } from 'vitest';
import {
  RelaunchArbiter,
  DEFAULT_RELAUNCH_BACKOFF_MS,
} from './relaunch-arbiter.js';

const KEY = { repo: 'github.com/kookr-ai/kookr', number: 1711 };
const KEY_B = { repo: 'github.com/kookr-ai/kookr', number: 999 };

describe('RelaunchArbiter', () => {
  let now: number;
  let live: Set<string>;
  let arbiter: RelaunchArbiter;

  beforeEach(() => {
    now = 1_000_000;
    live = new Set<string>();
    arbiter = new RelaunchArbiter({
      backoffMs: 60_000,
      now: () => now,
      isHolderLive: (id) => live.has(id),
    });
  });

  it('defaults backoff to DEFAULT_RELAUNCH_BACKOFF_MS', () => {
    const a = new RelaunchArbiter({ now: () => now });
    expect(DEFAULT_RELAUNCH_BACKOFF_MS).toBe(15 * 60 * 1000);
    const first = a.tryAcquire(KEY, 't1');
    expect(first.ok).toBe(true);
    a.release(KEY, 't1');
    const second = a.tryAcquire(KEY, 't2');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe('backoff');
      if (second.reason === 'backoff') {
        expect(second.retryAfterMs).toBe(DEFAULT_RELAUNCH_BACKOFF_MS);
      }
    }
  });

  it('grants a free key to the first actuator', () => {
    live.add('actuator-a');
    const result = arbiter.tryAcquire(KEY, 'actuator-a');
    expect(result).toMatchObject({
      ok: true,
      reentrant: false,
      lease: { holderId: 'actuator-a', key: KEY },
    });
    expect(arbiter.isHeld(KEY)).toBe(true);
    expect(arbiter.getLease(KEY)?.holderId).toBe('actuator-a');
  });

  it('mutual exclusion: second actuator is denied while first holds', () => {
    live.add('a1');
    expect(arbiter.tryAcquire(KEY, 'a1').ok).toBe(true);
    const denied = arbiter.tryAcquire(KEY, 'a2');
    expect(denied).toEqual({
      ok: false,
      reason: 'held',
      lease: expect.objectContaining({ holderId: 'a1' }),
    });
    // Independent keys do not contend.
    expect(arbiter.tryAcquire(KEY_B, 'a2').ok).toBe(true);
  });

  it('re-entrant acquire for the same holder succeeds without resetting', () => {
    live.add('a1');
    const first = arbiter.tryAcquire(KEY, 'a1');
    now += 5_000;
    const second = arbiter.tryAcquire(KEY, 'a1');
    expect(second).toMatchObject({ ok: true, reentrant: true });
    if (first.ok && second.ok) {
      expect(second.lease.acquiredAt).toBe(first.lease.acquiredAt);
    }
  });

  it('evaluate admits free keys and denies held / backoff without granting', () => {
    expect(arbiter.evaluate(KEY)).toEqual({ admit: true });
    live.add('a1');
    arbiter.tryAcquire(KEY, 'a1');
    expect(arbiter.evaluate(KEY)).toMatchObject({ admit: false, reason: 'held' });
    expect(arbiter.isHeld(KEY)).toBe(true);

    arbiter.release(KEY, 'a1');
    expect(arbiter.evaluate(KEY)).toMatchObject({ admit: false, reason: 'backoff' });
    expect(arbiter.isHeld(KEY)).toBe(false);
  });

  it('release starts a backoff window that blocks every actuator', () => {
    live.add('a1');
    arbiter.tryAcquire(KEY, 'a1');
    expect(arbiter.release(KEY, 'a1')).toBe(true);
    expect(arbiter.release(KEY, 'a1')).toBe(false); // already free

    const during = arbiter.tryAcquire(KEY, 'a2');
    expect(during).toMatchObject({
      ok: false,
      reason: 'backoff',
      retryAfterMs: 60_000,
    });

    now += 60_000;
    expect(arbiter.tryAcquire(KEY, 'a2')).toMatchObject({
      ok: true,
      reentrant: false,
      lease: { holderId: 'a2' },
    });
  });

  it('orphan reclaim of a dead holder starts backoff (no immediate re-acquire)', () => {
    live.add('dead-task');
    expect(arbiter.tryAcquire(KEY, 'dead-task').ok).toBe(true);
    live.delete('dead-task'); // task went terminal; claim released elsewhere

    // Next actuator hits orphan reclaim → backoff, not an immediate grant.
    const result = arbiter.tryAcquire(KEY, 'fresh-task');
    expect(result).toMatchObject({ ok: false, reason: 'backoff' });
    expect(arbiter.isHeld(KEY)).toBe(false);

    now += 60_000;
    expect(arbiter.tryAcquire(KEY, 'fresh-task').ok).toBe(true);
  });

  it('without isHolderLive, holds stay until explicit release', () => {
    const plain = new RelaunchArbiter({ backoffMs: 1_000, now: () => now });
    plain.tryAcquire(KEY, 'ghost');
    // No liveness probe → still held, second denied.
    expect(plain.tryAcquire(KEY, 'other')).toMatchObject({ ok: false, reason: 'held' });
    plain.release(KEY, 'ghost');
    expect(plain.tryAcquire(KEY, 'other')).toMatchObject({ ok: false, reason: 'backoff' });
    now += 1_000;
    expect(plain.tryAcquire(KEY, 'other').ok).toBe(true);
  });

  it('backoffMs <= 0 disables cooldown after release', () => {
    const noCd = new RelaunchArbiter({
      backoffMs: 0,
      now: () => now,
      isHolderLive: (id) => live.has(id),
    });
    live.add('a1');
    noCd.tryAcquire(KEY, 'a1');
    noCd.release(KEY, 'a1');
    expect(noCd.tryAcquire(KEY, 'a2').ok).toBe(true);
  });
});
