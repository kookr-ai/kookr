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

    // Advance past the TTL — the entry is compacted on the next reserveOrWait
    // call and the key is claimable again (not a permanent replay lock).
    nowMs += 1001;
    const afterExpiry = ttlLedger.reserveOrWait('k1');
    expect(afterExpiry.kind).toBe('own');
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
