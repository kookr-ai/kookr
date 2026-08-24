import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IdempotencyLedger, IDEMPOTENCY_LEDGER_FILE, MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency-ledger.js';

describe('IdempotencyLedger', () => {
  let tempDir: string;
  let ledger: IdempotencyLedger;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'idempotency-ledger-test-'));
    ledger = new IdempotencyLedger(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('exports the bounded key length used by route validation', () => {
    expect(MAX_IDEMPOTENCY_KEY_LENGTH).toBeGreaterThan(0);
  });

  test('starts empty', async () => {
    await ledger.load();
    expect(ledger.size()).toBe(0);
  });

  test('first reserveOrWait for a key returns kind=own', async () => {
    await ledger.load();
    const reservation = ledger.reserveOrWait('k1');
    expect(reservation.kind).toBe('own');
  });

  test('finalize persists the entry and later calls replay it', async () => {
    await ledger.load();
    const reservation = ledger.reserveOrWait('k1');
    if (reservation.kind !== 'own') throw new Error('expected own');
    await reservation.finalize('task-1');

    const replay = ledger.reserveOrWait('k1');
    expect(replay).toEqual({ kind: 'replay', taskId: 'task-1' });

    const onDisk = JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8'));
    expect(onDisk.entries.k1.taskId).toBe('task-1');
  });

  test('persist writes compact JSON without pretty-print indentation (issue #2266)', async () => {
    await ledger.load();
    const reservation = ledger.reserveOrWait('k1');
    if (reservation.kind !== 'own') throw new Error('expected own');
    await reservation.finalize('task-1');

    const raw = readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8');
    // Compact form has no 2-space indent after newlines (pretty-print marker).
    expect(raw).not.toMatch(/\n {2}"/);
    // Canonical compact form: re-stringify of parse equals on-disk bytes.
    const parsed = JSON.parse(raw) as { schemaVersion: number; entries: { k1: { taskId: string } } };
    expect(raw).toBe(JSON.stringify(parsed));
    // Couple format to a real finalized payload (not empty/wrong file).
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.entries.k1.taskId).toBe('task-1');
  });

  test('load() accepts legacy pretty-printed idempotency-ledger.json (issue #2266)', async () => {
    const pretty = JSON.stringify(
      {
        schemaVersion: 1,
        entries: {
          legacy: {
            taskId: 'task-legacy',
            createdAt: new Date().toISOString(),
          },
        },
      },
      null,
      2,
    );
    // Sanity: fixture is actually pretty-printed (multi-space indent).
    expect(pretty).toMatch(/\n {2}/);
    writeFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), pretty, 'utf-8');

    const reloaded = new IdempotencyLedger(tempDir);
    await reloaded.load();
    expect(reloaded.reserveOrWait('legacy')).toEqual({ kind: 'replay', taskId: 'task-legacy' });
  });

  test('a second reserveOrWait for a still-pending key returns kind=wait, resolved by finalize', async () => {
    await ledger.load();
    const owner = ledger.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');

    const waiter = ledger.reserveOrWait('k1');
    if (waiter.kind !== 'wait') throw new Error('expected wait');

    const waitPromise = waiter.wait();
    await owner.finalize('task-1');

    await expect(waitPromise).resolves.toEqual({ ok: true, taskId: 'task-1' });
  });

  test('release drops the reservation and resolves waiters with ok:false', async () => {
    await ledger.load();
    const owner = ledger.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');

    const waiter = ledger.reserveOrWait('k1');
    if (waiter.kind !== 'wait') throw new Error('expected wait');
    const waitPromise = waiter.wait();

    await owner.release();
    await expect(waitPromise).resolves.toEqual({ ok: false });

    // The key is now claimable again — a retry succeeds.
    const retry = ledger.reserveOrWait('k1');
    expect(retry.kind).toBe('own');
  });

  test('release never writes to disk (nothing to persist for a failed launch)', async () => {
    await ledger.load();
    const owner = ledger.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');
    await owner.release();

    // No file was ever created — persist() is only called from finalize()/clear().
    const reloaded = new IdempotencyLedger(tempDir);
    await reloaded.load();
    expect(reloaded.size()).toBe(0);
  });

  test('finalize never throws when persist fails — in-memory state is kept (review item 1)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A kookrDir that was never created: atomicWriteFile's temp-file open
      // fails with ENOENT because the parent directory does not exist —
      // simulating a disk/permissions failure without mocking modules.
      const brokenDir = join(tempDir, 'does-not-exist-subdir');
      const brokenLedger = new IdempotencyLedger(brokenDir);
      await brokenLedger.load(); // tolerates a missing dir/file

      const owner = brokenLedger.reserveOrWait('k1');
      if (owner.kind !== 'own') throw new Error('expected own');
      await expect(owner.finalize('task-1')).resolves.toBeUndefined();

      // In-memory state is still finalized — same-process replay still works
      // even though the write to disk failed.
      expect(brokenLedger.reserveOrWait('k1')).toEqual({ kind: 'replay', taskId: 'task-1' });
      expect(errorSpy).toHaveBeenCalled(); // logged loudly, not silently swallowed
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('clear never throws when persist fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const brokenDir = join(tempDir, 'also-does-not-exist');
      const brokenLedger = new IdempotencyLedger(brokenDir);
      await brokenLedger.load();
      const owner = brokenLedger.reserveOrWait('k1');
      if (owner.kind !== 'own') throw new Error('expected own');
      await owner.finalize('task-1'); // logs but does not throw (same as above)
      errorSpy.mockClear();

      await expect(brokenLedger.clear('k1')).resolves.toBeUndefined();
      expect(brokenLedger.reserveOrWait('k1').kind).toBe('own'); // cleared in memory
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('different keys reserve independently', async () => {
    await ledger.load();
    const a = ledger.reserveOrWait('k1');
    const b = ledger.reserveOrWait('k2');
    expect(a.kind).toBe('own');
    expect(b.kind).toBe('own');
  });

  test('clear drops a finalized entry so the key becomes claimable again', async () => {
    await ledger.load();
    const owner = ledger.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');
    await owner.finalize('task-1');

    await ledger.clear('k1');
    const reservation = ledger.reserveOrWait('k1');
    expect(reservation.kind).toBe('own');
  });

  test('TTL expiry: a finalized entry older than the TTL is compacted inline and becomes reusable', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const ttlLedger = new IdempotencyLedger(tempDir, { ttlMs: 1000, now: () => nowMs });
    await ttlLedger.load();

    const owner = ttlLedger.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');
    await owner.finalize('task-1');

    // Still within TTL — replays.
    expect(ttlLedger.reserveOrWait('k1')).toEqual({ kind: 'replay', taskId: 'task-1' });

    // At exactly the TTL boundary the original result is still replayed.
    nowMs += 1000;
    expect(ttlLedger.reserveOrWait('k1')).toEqual({ kind: 'replay', taskId: 'task-1' });

    // Advance past the TTL — the entry is compacted on the next reserveOrWait
    // call and the key is claimable again (not a permanent replay lock).
    nowMs += 1001;
    const afterExpiry = ttlLedger.reserveOrWait('k1');
    expect(afterExpiry.kind).toBe('own');
    // The inline (reserveOrWait) expiry path also feeds the expiry counter.
    expect(ttlLedger.getMetrics().expiredTotal).toBe(1);
    // The inline compaction persists asynchronously because reserveOrWait is
    // intentionally synchronous; let that best-effort write finish before the
    // test's temporary directory is removed.
    await vi.waitFor(() => {
      expect(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries).toEqual({});
    });
  });

  test('size bound evicts the oldest finalized entry deterministically and survives restart', async () => {
    let nowMs = 1_000;
    const bounded = new IdempotencyLedger(tempDir, { maxEntries: 2, now: () => nowMs });
    await bounded.load();

    for (const [key, taskId] of [['a-tie', 'task-1'], ['z-tie', 'task-2']] as const) {
      const owner = bounded.reserveOrWait(key);
      if (owner.kind !== 'own') throw new Error('expected own');
      await owner.finalize(taskId);
    }
    nowMs++;
    const newest = bounded.reserveOrWait('newest');
    if (newest.kind !== 'own') throw new Error('expected own');
    await newest.finalize('task-3');

    expect(bounded.reserveOrWait('a-tie').kind).toBe('own');
    expect(bounded.reserveOrWait('z-tie')).toEqual({ kind: 'replay', taskId: 'task-2' });
    expect(bounded.reserveOrWait('newest')).toEqual({ kind: 'replay', taskId: 'task-3' });
    expect(bounded.getMetrics()).toMatchObject({ entryCount: 2, maxEntries: 2, evictedTotal: 1 });
    expect(Object.keys(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries)).toEqual([
      'z-tie',
      'newest',
    ]);

    const restarted = new IdempotencyLedger(tempDir, { maxEntries: 2, now: () => nowMs });
    await restarted.load();
    expect(restarted.reserveOrWait('a-tie').kind).toBe('own');
    expect(restarted.reserveOrWait('z-tie')).toEqual({ kind: 'replay', taskId: 'task-2' });
    expect(restarted.reserveOrWait('newest')).toEqual({ kind: 'replay', taskId: 'task-3' });
  });

  test('load compacts an oversized file and persists the deterministic eviction', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    writeFileSync(
      join(tempDir, IDEMPOTENCY_LEDGER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          oldest: { taskId: 'task-old', createdAt },
          middle: { taskId: 'task-middle', createdAt: new Date('2026-01-01T00:00:01.000Z').toISOString() },
          newest: { taskId: 'task-new', createdAt: new Date('2026-01-01T00:00:02.000Z').toISOString() },
        },
      }),
    );
    const loaded = new IdempotencyLedger(tempDir, {
      maxEntries: 2,
      now: () => Date.parse('2026-01-01T00:00:03.000Z'),
    });

    await loaded.load();
    expect(loaded.getMetrics()).toMatchObject({ entryCount: 2, evictedTotal: 1 });
    expect(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries).toEqual({
      middle: { taskId: 'task-middle', createdAt: '2026-01-01T00:00:01.000Z' },
      newest: { taskId: 'task-new', createdAt: '2026-01-01T00:00:02.000Z' },
    });

    const restarted = new IdempotencyLedger(tempDir, { maxEntries: 2, now: () => Date.parse('2026-01-01T00:00:03.000Z') });
    await restarted.load();
    expect(restarted.reserveOrWait('oldest').kind).toBe('own');
    expect(restarted.reserveOrWait('middle')).toEqual({ kind: 'replay', taskId: 'task-middle' });
    expect(restarted.reserveOrWait('newest')).toEqual({ kind: 'replay', taskId: 'task-new' });
  });

  test('configure applies a tighter bound and persists compaction', async () => {
    let nowMs = 10_000;
    const configurable = new IdempotencyLedger(tempDir, { maxEntries: 3, now: () => nowMs });
    await configurable.load();
    for (const [key, taskId] of [['one', 'task-1'], ['two', 'task-2'], ['three', 'task-3']] as const) {
      const owner = configurable.reserveOrWait(key);
      if (owner.kind !== 'own') throw new Error('expected own');
      await owner.finalize(taskId);
      nowMs++;
    }

    await configurable.configure({ maxEntries: 2 });
    expect(configurable.getMetrics()).toMatchObject({ entryCount: 2, maxEntries: 2, evictedTotal: 1 });
    expect(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries).toEqual({
      two: { taskId: 'task-2', createdAt: new Date(10_001).toISOString() },
      three: { taskId: 'task-3', createdAt: new Date(10_002).toISOString() },
    });
    expect(configurable.reserveOrWait('one').kind).toBe('own');
    expect(configurable.reserveOrWait('two')).toEqual({ kind: 'replay', taskId: 'task-2' });
    expect(configurable.reserveOrWait('three')).toEqual({ kind: 'replay', taskId: 'task-3' });
  });

  test('configure applies a tighter TTL and compacts newly-expired entries', async () => {
    let nowMs = 100_000;
    const configurable = new IdempotencyLedger(tempDir, { ttlMs: 60_000, now: () => nowMs });
    await configurable.load();

    const owner = configurable.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');
    await owner.finalize('task-1');
    // Still well within the 60s TTL.
    expect(configurable.reserveOrWait('k1')).toEqual({ kind: 'replay', taskId: 'task-1' });

    // Advance 2s of wall clock, then tighten the TTL to 1s so the entry is now
    // retroactively expired. configure() must run the expiry compaction, count
    // it, and persist the empty ledger.
    nowMs += 2_000;
    await configurable.configure({ ttlMs: 1_000 });

    expect(configurable.getMetrics()).toMatchObject({ entryCount: 0, ttlMs: 1_000, expiredTotal: 1 });
    expect(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries).toEqual({});
    expect(configurable.reserveOrWait('k1').kind).toBe('own');
  });

  test('size eviction never drops a live pending reservation', async () => {
    let nowMs = 1_000;
    const bounded = new IdempotencyLedger(tempDir, { maxEntries: 1, now: () => nowMs });
    await bounded.load();

    const first = bounded.reserveOrWait('finalized-1');
    if (first.kind !== 'own') throw new Error('expected own');
    await first.finalize('task-1');

    // A live pending reservation is in flight when the next finalize triggers
    // size compaction. Pending state is coordination-only: it must never count
    // toward the bound or be evicted while a waiter may still depend on it.
    nowMs++;
    const pending = bounded.reserveOrWait('pending-1');
    if (pending.kind !== 'own') throw new Error('expected own');
    const waiter = bounded.reserveOrWait('pending-1');
    if (waiter.kind !== 'wait') throw new Error('expected wait');

    nowMs++;
    const second = bounded.reserveOrWait('finalized-2');
    if (second.kind !== 'own') throw new Error('expected own');
    // finalizedCount (2) > maxEntries (1) → evict the oldest FINALIZED entry
    // (finalized-1), never the pending reservation.
    await second.finalize('task-2');

    expect(bounded.getMetrics()).toMatchObject({ entryCount: 1, pendingCount: 1, evictedTotal: 1 });
    expect(bounded.reserveOrWait('finalized-1').kind).toBe('own'); // evicted → reclaimable
    expect(bounded.reserveOrWait('finalized-2')).toEqual({ kind: 'replay', taskId: 'task-2' });

    // The still-live pending reservation resolves normally to its real task.
    await pending.finalize('task-pending');
    expect(await waiter.wait()).toEqual({ ok: true, taskId: 'task-pending' });
  });

  test('load persists TTL compaction so restart does not repeatedly scan expired rows', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    writeFileSync(
      join(tempDir, IDEMPOTENCY_LEDGER_FILE),
      JSON.stringify({ schemaVersion: 1, entries: { expired: { taskId: 'task-old', createdAt } } }),
    );
    const loaded = new IdempotencyLedger(tempDir, {
      ttlMs: 1000,
      now: () => Date.parse('2026-01-01T00:00:02.000Z'),
    });

    await loaded.load();
    expect(JSON.parse(readFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), 'utf-8')).entries).toEqual({});
    expect(loaded.getMetrics()).toMatchObject({ entryCount: 0, expiredTotal: 1 });
  });

  test('TTL expiry: load() drops entries already past the TTL from a stale file on disk', async () => {
    const staleCreatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const freshCreatedAt = new Date().toISOString();
    writeFileSync(
      join(tempDir, IDEMPOTENCY_LEDGER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          stale: { taskId: 'task-stale', createdAt: staleCreatedAt },
          fresh: { taskId: 'task-fresh', createdAt: freshCreatedAt },
        },
      }),
    );

    const reloaded = new IdempotencyLedger(tempDir);
    await reloaded.load();

    expect(reloaded.reserveOrWait('stale').kind).toBe('own'); // compacted — claimable again
    expect(reloaded.reserveOrWait('fresh')).toEqual({ kind: 'replay', taskId: 'task-fresh' });
  });

  test('restart durability: a finalized entry survives loading a fresh instance from the same dir', async () => {
    const first = new IdempotencyLedger(tempDir);
    await first.load();
    const owner = first.reserveOrWait('k1');
    if (owner.kind !== 'own') throw new Error('expected own');
    await owner.finalize('task-1');

    const second = new IdempotencyLedger(tempDir);
    await second.load();
    expect(second.reserveOrWait('k1')).toEqual({ kind: 'replay', taskId: 'task-1' });
  });

  test('load() tolerates a missing file (fresh Kookr data dir)', async () => {
    const fresh = new IdempotencyLedger(join(tempDir, 'does-not-exist-yet'));
    await expect(fresh.load()).resolves.toBeUndefined();
    expect(fresh.size()).toBe(0);
  });

  test('load() tolerates a corrupt file, starting empty', async () => {
    writeFileSync(join(tempDir, IDEMPOTENCY_LEDGER_FILE), '{not valid json');
    const corrupt = new IdempotencyLedger(tempDir);
    await expect(corrupt.load()).resolves.toBeUndefined();
    expect(corrupt.size()).toBe(0);
  });

  test('load() skips a malformed individual entry but keeps valid ones', async () => {
    writeFileSync(
      join(tempDir, IDEMPOTENCY_LEDGER_FILE),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          bad: { taskId: 123, createdAt: 'not-a-date' },
          good: { taskId: 'task-good', createdAt: new Date().toISOString() },
        },
      }),
    );
    const reloaded = new IdempotencyLedger(tempDir);
    await reloaded.load();
    expect(reloaded.reserveOrWait('bad').kind).toBe('own');
    expect(reloaded.reserveOrWait('good')).toEqual({ kind: 'replay', taskId: 'task-good' });
  });
});
