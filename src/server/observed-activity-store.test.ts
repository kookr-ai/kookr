import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ObservedActivityStore,
  OBSERVED_SESSION_PREFIX,
} from './observed-activity-store.js';

describe('ObservedActivityStore', () => {
  let dir: string;
  let clock: number;
  // Every store built during a test. Persists are fire-and-forget, so a write
  // may still be landing on disk when the test body returns; the directory must
  // not be removed until those writes finish, or `rmSync` races the atomic
  // rename and intermittently fails with ENOTEMPTY (issue #3586).
  let stores: ObservedActivityStore[];
  const sid = `${OBSERVED_SESSION_PREFIX}alpha`;

  function makeStore(opts: Partial<ConstructorParameters<typeof ObservedActivityStore>[1]> = {}) {
    const store = new ObservedActivityStore(dir, { now: () => clock, ...opts });
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hermes-obs-'));
    clock = 1_000_000;
    stores = [];
  });
  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()));
    rmSync(dir, { recursive: true, force: true });
  });

  test('accepts a pulse and surfaces it with counters', async () => {
    const store = makeStore();
    const outcome = await store.record({ sessionId: sid, state: 'working', label: 'PR #1', ts: 1 });
    expect(outcome).toBe('accepted');
    const snap = await store.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ sessionId: sid, state: 'working', effectiveState: 'working', label: 'PR #1', pulseCount: 1 });
    expect(snap.counters.accepted).toBe(1);
    expect(snap.counters.lastAcceptedAt).toBe(clock);
  });

  test('persists durably and survives a "restart" (R7: no false-negative blanking)', async () => {
    const a = makeStore();
    await a.record({ sessionId: sid, state: 'working', label: 'reviewing', ts: 1 });
    await a.flush();
    // Simulate a fresh process: a new store over the same dir.
    const b = makeStore();
    await b.load();
    const snap = await b.snapshot();
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0]).toMatchObject({ sessionId: sid, state: 'working', label: 'reviewing' });
  });

  test('a stale working session reloads as `stale`, never fresh `working` (R6 at restart)', async () => {
    const a = makeStore({ staleMs: 1000 });
    await a.record({ sessionId: sid, state: 'working', ts: 1 });
    await a.flush();
    // Advance well past the stale window, then "restart".
    clock += 10_000;
    const b = makeStore({ staleMs: 1000 });
    await b.load();
    const snap = await b.snapshot();
    expect(snap.sessions).toHaveLength(1); // not blanked (R7)
    expect(snap.sessions[0].state).toBe('working'); // raw self-report preserved
    expect(snap.sessions[0].effectiveState).toBe('stale'); // but decayed (R6)
  });

  test('an exact retry (same state+label+ts) is deduped and does NOT refresh receivedAt', async () => {
    const store = makeStore();
    await store.record({ sessionId: sid, state: 'working', label: 'x', ts: 5 });
    const firstReceivedAt = (await store.snapshot()).sessions[0].receivedAt;
    clock += 5000;
    const outcome = await store.record({ sessionId: sid, state: 'working', label: 'x', ts: 5 });
    expect(outcome).toBe('deduped');
    const snap = await store.snapshot();
    expect(snap.counters.deduped).toBe(1);
    expect(snap.counters.accepted).toBe(1);
    expect(snap.sessions[0].receivedAt).toBe(firstReceivedAt); // not refreshed
  });

  test('a heartbeat (same state, new ts) is accepted and refreshes liveness', async () => {
    const store = makeStore({ staleMs: 1000 });
    await store.record({ sessionId: sid, state: 'working', ts: 1 });
    clock += 2000; // would be stale now
    expect((await store.snapshot()).sessions[0].effectiveState).toBe('stale');
    const outcome = await store.record({ sessionId: sid, state: 'working', ts: 2 });
    expect(outcome).toBe('accepted');
    expect((await store.snapshot()).sessions[0].effectiveState).toBe('working'); // healed
  });

  test('enforces the per-window rate limit by throwing RangeError', async () => {
    const store = makeStore({ rateLimit: 2, rateWindowMs: 10_000 });
    await store.record({ sessionId: sid, state: 'working', ts: 1 });
    await store.record({ sessionId: sid, state: 'working', ts: 2 });
    await expect(store.record({ sessionId: sid, state: 'working', ts: 3 })).rejects.toBeInstanceOf(RangeError);
    // Window rolls over -> admits again.
    clock += 10_000;
    await expect(store.record({ sessionId: sid, state: 'working', ts: 4 })).resolves.toBe('accepted');
  });

  test('evicts the oldest session beyond the cap', async () => {
    const store = makeStore({ maxSessions: 2 });
    await store.record({ sessionId: `${OBSERVED_SESSION_PREFIX}a`, state: 'working', ts: 1 });
    clock += 1; await store.record({ sessionId: `${OBSERVED_SESSION_PREFIX}b`, state: 'working', ts: 1 });
    clock += 1; await store.record({ sessionId: `${OBSERVED_SESSION_PREFIX}c`, state: 'working', ts: 1 });
    const ids = (await store.snapshot()).sessions.map((s) => s.sessionId);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(`${OBSERVED_SESSION_PREFIX}a`); // oldest dropped
  });

  test('evicts sessions older than the TTL', async () => {
    const store = makeStore({ ttlMs: 1000 });
    await store.record({ sessionId: sid, state: 'working', ts: 1 });
    clock += 2000;
    await store.record({ sessionId: `${OBSERVED_SESSION_PREFIX}fresh`, state: 'working', ts: 1 });
    const ids = (await store.snapshot()).sessions.map((s) => s.sessionId);
    expect(ids).toContain(`${OBSERVED_SESSION_PREFIX}fresh`);
    expect(ids).not.toContain(sid);
  });

  test('a corrupt durable file quarantines and falls back to empty (never blocks boot)', async () => {
    const store = makeStore();
    writeFileSync(store.getFilePath(), '{ this is not json');
    await store.load();
    const snap = await store.snapshot();
    expect(snap.sessions).toHaveLength(0);
    // The corrupt file was quarantined (renamed), not merely unlinked — forensics
    // are preserved. A bare `unlink` implementation would pass the existsSync
    // check below but fail this quarantine-artifact assertion.
    expect(existsSync(store.getFilePath())).toBe(false);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith(`${basename(store.getFilePath())}.corrupt-`));
    expect(quarantined).toHaveLength(1);
  });

  test('durable file is written with owner-only permissions (0600)', async () => {
    const store = makeStore();
    await store.record({ sessionId: sid, state: 'working', ts: 1 });
    await store.flush();
    const raw = readFileSync(store.getFilePath(), 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
    // Session labels can carry PR titles / repo context — the file must be
    // owner-only. Dropping `{ mode: 0o600 }` from the atomic write fails this.
    if (process.platform !== 'win32') {
      expect(statSync(store.getFilePath()).mode & 0o777).toBe(0o600);
    }
  });
});
