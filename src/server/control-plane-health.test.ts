import { describe, test, expect, vi } from 'vitest';
import {
  buildControlPlaneCollectionBlock,
  collectBounded,
  hookLagFreshnessFromSnapshot,
  raceWithDeadline,
  CONTROL_PLANE_COLLECTION_SCHEMA_VERSION,
} from './control-plane-health.js';
import type { HookIngestionDiagnosticsSnapshot } from './hook-ingestion.js';

function session(
  overrides: Partial<HookIngestionDiagnosticsSnapshot['sessions'][number]> = {},
): HookIngestionDiagnosticsSnapshot['sessions'][number] {
  return {
    kookrSessionId: 's-1',
    totalArrivals: 0,
    dispatchedArrivals: 0,
    duplicateArrivals: 0,
    missingWriteTimestampCount: 0,
    invalidWriteTimestampCount: 0,
    futureWriteTimestampCount: 0,
    notableLagCount: 0,
    startupReplayArrivalCount: 0,
    lastProcessedAt: null,
    lastWriteTimestampAt: null,
    lastWriteTimestampSource: null,
    lag: { count: 0, lastMs: null, meanMs: null, maxMs: null, p95Ms: null },
    sourceCounts: { file: 0, http: 0 },
    writeTimestampSourceCounts: { payload: 0, file_mtime: 0, missing: 0, invalid: 0 },
    ...overrides,
  };
}

describe('raceWithDeadline', () => {
  test('resolves value when work settles before the signal aborts', async () => {
    const controller = new AbortController();
    const result = await raceWithDeadline(Promise.resolve(42), controller.signal);
    expect(result).toEqual({ status: 'value', value: 42 });
  });

  test('resolves timeout when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await raceWithDeadline(new Promise<never>(() => {}), controller.signal);
    expect(result).toEqual({ status: 'timeout' });
  });

  test('resolves timeout when the signal aborts before work settles', async () => {
    const controller = new AbortController();
    const result = raceWithDeadline(new Promise<never>(() => {}), controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ status: 'timeout' });
  });

  test('reports a rejection as error, distinct from a timeout', async () => {
    const controller = new AbortController();
    const boom = new Error('boom');
    const result = await raceWithDeadline(Promise.reject(boom), controller.signal);
    expect(result).toEqual({ status: 'error', error: boom });
  });

  test('an already-aborted signal reports timeout and adopts a rejecting work (no leak)', async () => {
    const controller = new AbortController();
    controller.abort();
    // work rejects — the pre-aborted branch must still attach a catch handler.
    const result = await raceWithDeadline(Promise.reject(new Error('pre-aborted')), controller.signal);
    expect(result).toEqual({ status: 'timeout' });
    await Promise.resolve();
  });

  test('a late rejection after a timeout does not throw (handler stays attached)', async () => {
    const controller = new AbortController();
    let reject: (err: unknown) => void = () => {};
    const work = new Promise<number>((_, r) => { reject = r; });
    const result = raceWithDeadline(work, controller.signal);
    controller.abort();
    await expect(result).resolves.toEqual({ status: 'timeout' });
    // Rejecting after the race settled must be swallowed, not an unhandled rejection.
    reject(new Error('late'));
    await Promise.resolve();
  });
});

describe('collectBounded', () => {
  test('live when the producer resolves within budget', async () => {
    const result = await collectBounded('comp', async () => 'ok', 10_000);
    expect(result).toEqual({ name: 'comp', source: 'live', value: 'ok' });
  });

  test('error when the producer rejects', async () => {
    const result = await collectBounded('comp', async () => { throw new Error('nope'); }, 10_000);
    expect(result).toEqual({ name: 'comp', source: 'error' });
  });

  test('error when the producer throws synchronously', async () => {
    const result = await collectBounded('comp', () => { throw new Error('sync'); }, 10_000);
    expect(result).toEqual({ name: 'comp', source: 'error' });
  });

  test('timed-out when the producer never settles before the budget elapses', async () => {
    vi.useFakeTimers();
    try {
      const pending = collectBounded('slow', () => new Promise<string>(() => {}), 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ name: 'slow', source: 'timed-out' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hookLagFreshnessFromSnapshot', () => {
  const nowMs = Date.parse('2026-08-28T00:00:10.000Z');

  test('returns null when the snapshot is undefined (hook ingestion unwired)', () => {
    expect(hookLagFreshnessFromSnapshot(undefined, nowMs)).toBeNull();
  });

  test('returns a null-filled reading when no session has processed a record', () => {
    expect(hookLagFreshnessFromSnapshot({ sessions: [session()] }, nowMs)).toEqual({
      lastLagMs: null,
      lastProcessedAt: null,
      ageMs: null,
    });
  });

  test('uses the lag of the most-recently-processed session and its freshness', () => {
    const snapshot = {
      sessions: [
        session({
          kookrSessionId: 'old',
          lastProcessedAt: '2026-08-28T00:00:00.000Z',
          lag: { count: 1, lastMs: 999, meanMs: 999, maxMs: 999, p95Ms: 999 },
        }),
        session({
          kookrSessionId: 'new',
          lastProcessedAt: '2026-08-28T00:00:05.000Z',
          lag: { count: 1, lastMs: 291_000, meanMs: 291_000, maxMs: 291_000, p95Ms: 291_000 },
        }),
      ],
    };
    expect(hookLagFreshnessFromSnapshot(snapshot, nowMs)).toEqual({
      lastLagMs: 291_000,
      lastProcessedAt: '2026-08-28T00:00:05.000Z',
      ageMs: 5_000,
    });
  });

  test('skips sessions with an unparseable lastProcessedAt', () => {
    const snapshot = {
      sessions: [
        session({ kookrSessionId: 'bad', lastProcessedAt: 'not-a-date' }),
        session({
          kookrSessionId: 'good',
          lastProcessedAt: '2026-08-28T00:00:08.000Z',
          lag: { count: 1, lastMs: 12, meanMs: 12, maxMs: 12, p95Ms: 12 },
        }),
      ],
    };
    expect(hookLagFreshnessFromSnapshot(snapshot, nowMs)).toEqual({
      lastLagMs: 12,
      lastProcessedAt: '2026-08-28T00:00:08.000Z',
      ageMs: 2_000,
    });
  });
});

describe('buildControlPlaneCollectionBlock', () => {
  const nowMs = Date.parse('2026-08-28T00:00:10.000Z');
  const collectedAtMs = Date.parse('2026-08-28T00:00:04.000Z');

  test('ok when live and every component collected', () => {
    const block = buildControlPlaneCollectionBlock({
      source: 'live',
      collectedAtMs: nowMs,
      nowMs,
      hookLag: null,
    });
    expect(block).toEqual({
      schemaVersion: CONTROL_PLANE_COLLECTION_SCHEMA_VERSION,
      collectionStatus: 'ok',
      source: 'live',
      lastGoodAt: '2026-08-28T00:00:10.000Z',
      lastGoodAgeMs: 0,
      timedOutComponents: [],
      erroredComponents: [],
      hookLag: null,
    });
  });

  test('degraded (live) when a component timed out, with counts still live', () => {
    const block = buildControlPlaneCollectionBlock({
      source: 'live',
      collectedAtMs: nowMs,
      nowMs,
      timedOutComponents: ['pipelineStarvation'],
      erroredComponents: ['ciBlindDebt'],
      hookLag: null,
    });
    expect(block.collectionStatus).toBe('degraded');
    expect(block.source).toBe('live');
    expect(block.timedOutComponents).toEqual(['pipelineStarvation']);
    expect(block.erroredComponents).toEqual(['ciBlindDebt']);
  });

  test('degraded (last-good) preserves the collection time and its age', () => {
    const block = buildControlPlaneCollectionBlock({
      source: 'last-good',
      collectedAtMs,
      nowMs,
      timedOutComponents: ['healthAssembly'],
      hookLag: null,
    });
    expect(block.collectionStatus).toBe('degraded');
    expect(block.source).toBe('last-good');
    expect(block.lastGoodAt).toBe('2026-08-28T00:00:04.000Z');
    expect(block.lastGoodAgeMs).toBe(6_000);
  });

  test('unavailable when there is nothing to serve — no fabricated timestamp', () => {
    const block = buildControlPlaneCollectionBlock({
      source: 'unavailable',
      collectedAtMs: null,
      nowMs,
      timedOutComponents: ['healthAssembly'],
      hookLag: null,
    });
    expect(block.collectionStatus).toBe('unavailable');
    expect(block.lastGoodAt).toBeNull();
    expect(block.lastGoodAgeMs).toBeNull();
  });

  test('copies component arrays so later mutation cannot leak into the block', () => {
    const timedOut = ['a'];
    const block = buildControlPlaneCollectionBlock({
      source: 'live',
      collectedAtMs: nowMs,
      nowMs,
      timedOutComponents: timedOut,
      hookLag: null,
    });
    timedOut.push('b');
    expect(block.timedOutComponents).toEqual(['a']);
  });
});
