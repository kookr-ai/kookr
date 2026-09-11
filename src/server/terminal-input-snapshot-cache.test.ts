import { describe, expect, it } from 'vitest';
import { TerminalInputSnapshotCache, TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY } from './terminal-input-snapshot-cache.js';

describe('TerminalInputSnapshotCache', () => {
  it('keeps the newest snapshot by version and ignores older stragglers for a cached id', () => {
    const cache = new TerminalInputSnapshotCache<string>(4);
    cache.admitLive('a', 'v5', 5);
    cache.admitLive('a', 'v3-late', 3); // older version must not overwrite
    expect(cache.get('a')).toBe('v5');
    cache.admitLive('a', 'v9', 9);
    expect(cache.get('a')).toBe('v9');
  });

  it('returns null for an unknown session and for a completed (tombstoned) one', () => {
    const cache = new TerminalInputSnapshotCache<string>(4);
    expect(cache.get('missing')).toBeNull();
    cache.admitLive('a', 'A', 1);
    cache.admitTombstone('a', 2);
    expect(cache.get('a')).toBeNull();
    expect(cache.has('a')).toBe(true); // tombstone retained for stale-response protection
  });

  it('rejects a new id only under genuine live overload, leaving live entries intact', () => {
    const cache = new TerminalInputSnapshotCache<string>(2);
    cache.admitLive('a', 'A', 1);
    cache.admitLive('b', 'B', 2);
    cache.admitLive('c', 'C', 3); // every slot is live — no tombstone to reclaim
    expect(cache.get('c')).toBeNull();
    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBe('B');
  });

  it('reclaims a completed slot so a fresh session is cached at capacity', () => {
    const cache = new TerminalInputSnapshotCache<string>(2);
    cache.admitLive('a', 'A', 1);
    cache.admitLive('b', 'B', 2);
    cache.admitTombstone('a', 3); // a completes
    cache.admitLive('c', 'C', 4); // reclaims a's slot
    expect(cache.get('c')).toBe('C');
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe('B');
  });

  it('fences a stale live straggler for a reclaimed id so it cannot resurrect or cascade-evict', () => {
    const cache = new TerminalInputSnapshotCache<string>(4);
    cache.admitLive('a', 'A', 1);
    cache.admitLive('b', 'B', 2);
    cache.admitLive('c', 'C', 3);
    cache.admitLive('d', 'D', 4);
    cache.admitTombstone('a', 5); // a and b complete
    cache.admitTombstone('b', 6);
    cache.admitLive('e', 'E', 7); // reclaims a's slot -> floor = 5
    expect(cache.has('a')).toBe(false);

    // A reordered pre-cleanup live snapshot for a (version 3 <= floor 5) must be
    // rejected: admitting it would resurrect a completed session and steal b's
    // tombstone slot, starving a later fresh session's readiness.
    cache.admitLive('a', 'A-straggler', 3);
    expect(cache.get('a')).toBeNull();
    // b's tombstone was NOT cascade-evicted, so a genuinely new session still fits.
    cache.admitLive('f', 'F', 8);
    expect(cache.get('f')).toBe('F');
  });

  it('fences a stale null straggler so it cannot re-establish a reclaimed id (closing the has()-bypass)', () => {
    const cache = new TerminalInputSnapshotCache<string>(2);
    cache.admitLive('a', 'A', 10);
    cache.admitLive('b', 'B', 20);
    cache.admitTombstone('a', 30); // a completes
    cache.admitLive('x', 'X', 40); // reclaims a's slot -> floor = 30
    expect(cache.has('a')).toBe(false);

    cache.delete('b'); // a pending cleanup frees a slot

    // A delayed null response for a (version 25 <= floor 30) must NOT re-insert
    // an entry: doing so would make has(a) true and let a later stale live
    // straggler bypass the fence and resurrect a.
    cache.admitTombstone('a', 25);
    expect(cache.has('a')).toBe(false);
    cache.admitLive('a', 'A-straggler', 28); // still fenced (28 <= floor 30, a not cached)
    expect(cache.get('a')).toBeNull();

    // A genuine re-registration above the floor is still admitted.
    cache.admitLive('a', 'A-reborn', 50);
    expect(cache.get('a')).toBe('A-reborn');
  });

  it('never stores a tombstone past capacity for an uncached id (tombstones protect, they do not reclaim)', () => {
    const cache = new TerminalInputSnapshotCache<string>(2);
    cache.admitLive('a', 'A', 1);
    cache.admitLive('b', 'B', 2); // every slot live
    cache.admitTombstone('c', 9); // uncached id at capacity — must be dropped, not grown
    expect(cache.has('c')).toBe(false);
    expect(cache.size).toBe(2);
    // A tombstone for an already-cached id at capacity is still recorded.
    cache.admitTombstone('a', 3);
    expect(cache.get('a')).toBeNull();
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(2);
  });

  it('applies the per-id version guard at and below the current version for both entry kinds', () => {
    const cache = new TerminalInputSnapshotCache<string>(4);
    cache.admitLive('a', 'v5', 5);
    cache.admitLive('a', 'v5-again', 5); // equal version overwrites (<=)
    expect(cache.get('a')).toBe('v5-again');
    cache.admitTombstone('a', 4); // older than the live entry — ignored
    expect(cache.get('a')).toBe('v5-again');
    cache.admitTombstone('a', 5); // equal version tombstones it (<=)
    expect(cache.get('a')).toBeNull();
  });

  it('fences a completed session even when its tombstone is dropped at capacity', () => {
    const cache = new TerminalInputSnapshotCache<string>(3);
    // Old completed sessions leave reclaimable tombstones; A is live alongside them.
    cache.admitLive('t1', 'T1', 1); cache.admitTombstone('t1', 2);
    cache.admitLive('a', 'A', 3);
    cache.admitLive('t2', 'T2', 4); cache.admitTombstone('t2', 5); // full: t1✝, a, t2✝
    // A is cleaned up locally and another registration fills the freed slot
    // before A's own cleanup reply lands.
    cache.delete('a');
    cache.admitLive('b', 'B', 514); // full again: t1✝, t2✝, b
    // A's cleanup reply (version 515) cannot be stored at capacity — but its
    // fence must survive, or the delayed straggler below reclaims an old
    // tombstone and resurrects the completed session.
    cache.admitTombstone('a', 515);
    expect(cache.has('a')).toBe(false);
    // A delayed pre-cleanup live reply for A (version 513 < 515) must NOT resurrect it.
    cache.admitLive('a', 'A-straggler', 513);
    expect(cache.get('a')).toBeNull();
  });

  it('resets the reclaim floor per generation so a restarted child (versions from 0) is not fenced', () => {
    const cache = new TerminalInputSnapshotCache<string>(1);
    cache.admitLive('a', 'A', 10);
    cache.admitTombstone('a', 20);
    cache.admitLive('b', 'B', 30); // reclaims a -> floor = 20
    cache.clear(); // generation exit clears the map
    cache.resetGeneration(); // new child restarts its version counter at 0

    cache.admitLive('a', 'A-fresh', 1); // version 1 would be <= the old floor 20
    expect(cache.get('a')).toBe('A-fresh');
  });

  it('defaults to the production capacity', () => {
    expect(TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY).toBe(512);
    const cache = new TerminalInputSnapshotCache<string>();
    for (let i = 0; i < TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY; i++) cache.admitLive(`s${i}`, `v${i}`, i + 1);
    expect(cache.size).toBe(TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY);
    cache.admitLive('overflow', 'v', 100_000); // all live -> rejected
    expect(cache.get('overflow')).toBeNull();
  });
});
