import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookIngestion,
  REPLAY_SESSION_PREFIX,
  deriveEventOrigin,
  mintEventId,
  type HookParseDegradationEvent,
  type HookEventInjector,
} from './hook-ingestion.js';
import type { EventOrigin } from '../core/types.js';
import { ActivityLedger, type HookEnvelopeV1 } from '../core/activity-ledger.js';

function envelopeRow(overrides: Partial<HookEnvelopeV1>): { envelope: HookEnvelopeV1; projection: 'parent_activity' | 'child_activity' | 'diagnostic_only' } {
  return {
    envelope: {
      schemaVersion: 'hook-envelope.v1',
      kookrSessionId: 'kookr-1',
      provider: 'claude-code',
      source: 'http',
      observedAt: '2026-05-13T12:00:00.000Z',
      sequence: 1,
      contentHash: 'a'.repeat(64),
      parentage: 'parent',
      parseStatus: 'ok',
      rawBytes: 100,
      ...overrides,
    },
    projection: overrides.parentage === 'child' ? 'child_activity' : 'parent_activity',
  };
}

function makeStubAdapter(): HookEventInjector & { calls: Array<{ tmux: string; raw: string }> } {
  const calls: Array<{ tmux: string; raw: string }> = [];
  return {
    calls,
    injectHookEvent(tmux: string, raw: string, sequence?: number) {
      calls.push({ tmux, raw });
      return {
        parseStatus: 'ok' as const,
        agentType: 'claude-code' as const,
        rawSessionId: 'stub-session',
        parentage: 'parent' as const,
        sequence: sequence ?? 0,
      };
    },
  };
}

describe('HookIngestion — retention metrics (issue #1612)', () => {
  it('reports cheap per-session buffer sizes for the memory ledger', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    expect(ingestion.getRetentionMetrics()).toMatchObject({
      cacheEntries: 0,
      sequenceCounters: 0,
      metaSessions: 0,
      coordinatorAuditTail: 0,
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' }));
    ingestion.ingestFromHttp('kookr-2', JSON.stringify({ session_id: 'y', hook_event_name: 'SessionStart' }));

    const metrics = ingestion.getRetentionMetrics();
    expect(metrics.sequenceCounters).toBe(2);
    // Two distinct sessions × one event each → two dedup-cache entries (within
    // the 5s TTL window), up from 0 before ingest.
    expect(metrics.cacheEntries).toBe(2);
  });
});

describe('HookIngestion — dual-delivery dedup (rfc-activity-log-reliability §5)', () => {
  it('HTTP-only delivery still reaches the monitor', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const result = ingestion.ingestFromHttp('kookr-1', raw);

    expect(result.dispatched).toBe(true);
    expect(adapter.calls).toEqual([{ tmux: 'kookr-1', raw }]);
  });

  it('file-only delivery still reaches the monitor', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    ingestion.injectHookEvent('kookr-1', raw);

    expect(adapter.calls).toEqual([{ tmux: 'kookr-1', raw }]);
  });

  it('retains a metadata-only coordinator audit tail for detector evaluation', () => {
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: () => 'task-1',
      },
      now: () => Date.parse('2026-05-21T12:00:00.000Z'),
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse' }));

    expect(ingestion.getCoordinatorAuditTail()).toEqual([{
      taskId: 'task-1',
      observedAt: '2026-05-21T12:00:00.000Z',
      rawHookEventName: 'PostToolUse',
      envelope: {
        taskId: 'task-1',
        kookrSessionId: 'kookr-1',
        observedAt: '2026-05-21T12:00:00.000Z',
        rawHookEventName: 'PostToolUse',
      },
    }]);
  });

  it('keeps latest PostToolUse rows available after unrelated audit-tail overflow', () => {
    let clock = Date.parse('2026-05-21T12:00:00.000Z');
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: (sessionId: string) => (sessionId === 'kookr-keep' ? 'task-keep' : `task-${sessionId}`),
      },
      now: () => clock,
    });

    ingestion.ingestFromHttp('kookr-keep', JSON.stringify({ session_id: 'keep', hook_event_name: 'PostToolUse' }));
    for (let i = 0; i < 1001; i++) {
      clock += 1;
      ingestion.ingestFromHttp(`kookr-noise-${i}`, JSON.stringify({ session_id: `noise-${i}`, hook_event_name: 'PostToolUse' }));
    }

    expect(ingestion.getCoordinatorAuditTail()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-keep',
        observedAt: '2026-05-21T12:00:00.000Z',
        rawHookEventName: 'PostToolUse',
      }),
    ]));
  });

  it('forgets task-keyed retained PostToolUse rows when the owning session is forgotten', () => {
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: () => 'task-1',
      },
      now: () => Date.parse('2026-05-21T12:00:00.000Z'),
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse' }));
    ingestion.forgetSession('kookr-1');

    expect(ingestion.getCoordinatorAuditTail()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-1',
        observedAt: '2026-05-21T12:00:00.000Z',
      }),
    ]));
  });

  it('reuses cached coordinator audit-tail rows when the underlying audit data is unchanged', () => {
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: () => 'task-1',
      },
      now: () => Date.parse('2026-05-21T12:00:00.000Z'),
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse' }));

    const first = ingestion.getCoordinatorAuditTail();
    const second = ingestion.getCoordinatorAuditTail();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  it('invalidates the cached coordinator audit-tail projection when a row is appended', () => {
    let clock = Date.parse('2026-05-21T12:00:00.000Z');
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: (sessionId: string) => `task-${sessionId}`,
      },
      now: () => clock,
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse', n: 1 }));
    const beforeAppend = ingestion.getCoordinatorAuditTail();

    clock += 1;
    ingestion.ingestFromHttp('kookr-2', JSON.stringify({ session_id: 'y', hook_event_name: 'PostToolUse', n: 2 }));
    const afterAppend = ingestion.getCoordinatorAuditTail();

    expect(afterAppend).toHaveLength(2);
    expect(afterAppend[0]).not.toBe(beforeAppend[0]);
    expect(afterAppend).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-kookr-2',
        observedAt: '2026-05-21T12:00:00.001Z',
        rawHookEventName: 'PostToolUse',
      }),
    ]));
  });

  it('does not let callers mutate cached coordinator audit-tail state', () => {
    const adapter: HookEventInjector = {
      injectHookEvent(_tmux, _raw, sequence) {
        return {
          parseStatus: 'ok',
          agentType: 'claude-code',
          parentage: 'parent',
          rawHookEventName: 'PostToolUse',
          sequence: sequence ?? 0,
        };
      },
    };
    const ingestion = new HookIngestion({
      adapter,
      taskStore: {
        findTaskIdBySession: () => 'task-1',
      },
      now: () => Date.parse('2026-05-21T12:00:00.000Z'),
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({ session_id: 'x', hook_event_name: 'PostToolUse' }));
    const exposedRows = ingestion.getCoordinatorAuditTail();
    exposedRows.push({
      taskId: 'task-injected',
      observedAt: '2026-05-21T12:01:00.000Z',
      envelope: {
        taskId: 'task-injected',
        kookrSessionId: 'kookr-injected',
        observedAt: '2026-05-21T12:01:00.000Z',
      },
    });
    try {
      exposedRows[0]!.rawHookEventName = 'Mutated';
      exposedRows[0]!.envelope!.rawHookEventName = 'Mutated';
    } catch {
      // Frozen cached rows may throw under ESM strict mode; either way, the
      // observable contract is that caller mutation cannot leak back in.
    }

    expect(ingestion.getCoordinatorAuditTail()).toEqual([{
      taskId: 'task-1',
      observedAt: '2026-05-21T12:00:00.000Z',
      rawHookEventName: 'PostToolUse',
      envelope: {
        taskId: 'task-1',
        kookrSessionId: 'kookr-1',
        observedAt: '2026-05-21T12:00:00.000Z',
        rawHookEventName: 'PostToolUse',
      },
    }]);
  });

  it('HTTP-then-file delivery produces exactly one adapter call', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const a = ingestion.ingestFromHttp('kookr-1', raw);
    // File-source path uses the HookEventInjector entry-point (the same one
    // HookFileWatcher uses in production) so this test mirrors the real
    // wiring rather than a now-private internal `ingest` shape.
    ingestion.injectHookEvent('kookr-1', raw);

    expect(a.dispatched).toBe(true);
    expect(adapter.calls).toHaveLength(1);
  });

  it('file-then-HTTP delivery produces exactly one adapter call', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    ingestion.injectHookEvent('kookr-1', raw);
    const second = ingestion.ingestFromHttp('kookr-1', raw);

    expect(second.dispatched).toBe(false);
    expect(adapter.calls).toHaveLength(1);
  });

  it('different sessions with identical payloads do not collide', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    ingestion.injectHookEvent('kookr-1', raw);
    ingestion.injectHookEvent('kookr-2', raw);

    expect(adapter.calls.map((c) => c.tmux)).toEqual(['kookr-1', 'kookr-2']);
  });

  it('different payloads on the same session both dispatch', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    ingestion.injectHookEvent('kookr-1', JSON.stringify({ session_id: 'x', n: 1 }));
    ingestion.injectHookEvent('kookr-1', JSON.stringify({ session_id: 'x', n: 2 }));

    expect(adapter.calls).toHaveLength(2);
  });

  it('a re-arrival after the dedup TTL expires dispatches again', () => {
    const adapter = makeStubAdapter();
    let t = 1_000_000;
    const ingestion = new HookIngestion({ adapter, dedupTtlMs: 5000, now: () => t });

    const raw = JSON.stringify({ session_id: 'x', n: 1 });
    ingestion.injectHookEvent('kookr-1', raw);
    t += 6000;
    const result = ingestion.injectHookEvent('kookr-1', raw);

    void result;
    expect(adapter.calls).toHaveLength(2);
  });

  it('rejects empty payload and does not poison the cache', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    expect(ingestion.ingestFromHttp('kookr-1', '   ')).toMatchObject({ dispatched: false, reason: 'empty' });
    expect(adapter.calls).toHaveLength(0);

    const real = JSON.stringify({ session_id: 'x' });
    expect(ingestion.ingestFromHttp('kookr-1', real).dispatched).toBe(true);
  });

  it('normalizes whitespace so file/HTTP payloads with trailing newline dedup', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x' });
    ingestion.injectHookEvent('kookr-1', raw);
    const second = ingestion.ingestFromHttp('kookr-1', `${raw}\n`);

    expect(second.dispatched).toBe(false);
    expect(adapter.calls).toHaveLength(1);
  });

  it('records HTTP arrival via HttpPushTracker for telemetry on duplicates too', () => {
    const adapter = makeStubAdapter();
    const recordHttpArrival = vi.fn();
    const httpPushTracker = { recordHttpArrival } as unknown as Parameters<typeof HookIngestion>[0]['httpPushTracker'];
    const ingestion = new HookIngestion({ adapter, httpPushTracker });

    const raw = JSON.stringify({ session_id: 'x' });
    ingestion.injectHookEvent('kookr-1', raw);            // file first
    ingestion.ingestFromHttp('kookr-1', raw);             // http arrives second

    // First HTTP arrival is still recorded (telemetry on dup) even though we
    // did not dispatch to the adapter.
    expect(recordHttpArrival).toHaveBeenCalledTimes(1);
  });

  it('restores cache entry when adapter.injectHookEvent throws so a replay can retry', () => {
    let throwOnce = true;
    const adapter: HookEventInjector = {
      injectHookEvent: () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error('boom');
        }
        return {
          parseStatus: 'ok' as const,
          agentType: 'claude-code' as const,
          parentage: 'parent' as const,
          rawSessionId: 'x',
          sequence: 1,
        };
      },
    };
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x' });
    expect(() => ingestion.injectHookEvent('kookr-1', raw)).toThrow('boom');

    // Cache was rolled back; a second delivery (file replay or HTTP) is allowed
    // to retry the same payload.
    const retry = ingestion.ingestFromHttp('kookr-1', raw);
    expect(retry.dispatched).toBe(true);
  });

  it('aggregates write-to-processed lag per session and logs threshold crossings', () => {
    const adapter = makeStubAdapter();
    let now = Date.parse('2026-06-11T12:00:10.000Z');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ingestion = new HookIngestion({
      adapter,
      now: () => now,
      lagWarningThresholdMs: 2000,
    });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({
      session_id: 'x',
      hook_event_name: 'SessionStart',
      kookr_hook_written_at: '2026-06-11T12:00:09.000Z',
    }));
    now = Date.parse('2026-06-11T12:00:14.000Z');
    ingestion.ingestFromHttp('kookr-1', JSON.stringify({
      session_id: 'x',
      hook_event_name: 'PreToolUse',
      kookr_hook_written_at_ms: Date.parse('2026-06-11T12:00:10.000Z'),
    }));

    const snapshot = ingestion.getDiagnosticsSnapshot();
    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 'hook-ingestion-diagnostics.v1',
      lagWarningThresholdMs: 2000,
      sessionCount: 1,
      totalArrivals: 2,
      notableLagCount: 1,
    }));
    expect(snapshot.sessions[0]).toEqual(expect.objectContaining({
      kookrSessionId: 'kookr-1',
      totalArrivals: 2,
      dispatchedArrivals: 2,
      missingWriteTimestampCount: 0,
      notableLagCount: 1,
      sourceCounts: { file: 0, http: 2 },
      writeTimestampSourceCounts: { payload: 2, file_mtime: 0, missing: 0, invalid: 0 },
      lag: {
        count: 2,
        lastMs: 4000,
        meanMs: 2500,
        maxMs: 4000,
        p95Ms: 4000,
      },
    }));
    expect(warn).toHaveBeenCalledWith('[hook-ingestion] lag threshold crossed', {
      kookrSessionId: 'kookr-1',
      source: 'http',
      lagMs: 4000,
      thresholdMs: 2000,
      writeTimestampSource: 'payload',
    });
    warn.mockRestore();
  });

  it('records file-mtime fallback lag even when the file arrival is a duplicate', () => {
    const adapter = makeStubAdapter();
    let now = Date.parse('2026-06-11T12:00:10.000Z');
    const ingestion = new HookIngestion({ adapter, now: () => now });
    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });

    ingestion.ingestFromHttp('kookr-1', raw);
    now = Date.parse('2026-06-11T12:00:14.000Z');
    ingestion.injectHookEvent('kookr-1', raw, undefined, {
      fileMtimeMs: Date.parse('2026-06-11T12:00:12.000Z'),
    });

    const session = ingestion.getDiagnosticsSnapshot().sessions[0];
    expect(adapter.calls).toHaveLength(1);
    expect(session).toEqual(expect.objectContaining({
      totalArrivals: 2,
      dispatchedArrivals: 1,
      duplicateArrivals: 1,
      missingWriteTimestampCount: 1,
      sourceCounts: { file: 1, http: 1 },
      writeTimestampSourceCounts: { payload: 0, file_mtime: 1, missing: 1, invalid: 0 },
      lag: expect.objectContaining({
        count: 1,
        lastMs: 2000,
        maxMs: 2000,
      }),
    }));
  });

  it('counts invalid and future hook write timestamps in diagnostics', () => {
    const adapter = makeStubAdapter();
    const now = Date.parse('2026-06-11T12:00:10.000Z');
    const ingestion = new HookIngestion({ adapter, now: () => now });

    ingestion.ingestFromHttp('kookr-1', JSON.stringify({
      session_id: 'x',
      hook_event_name: 'SessionStart',
      timestamp: 'not-a-date',
    }));
    ingestion.ingestFromHttp('kookr-1', JSON.stringify({
      session_id: 'x',
      hook_event_name: 'PreToolUse',
      timestamp: '2026-06-11T12:00:12.000Z',
    }));

    const session = ingestion.getDiagnosticsSnapshot().sessions[0];
    expect(session).toEqual(expect.objectContaining({
      totalArrivals: 2,
      invalidWriteTimestampCount: 1,
      futureWriteTimestampCount: 1,
      writeTimestampSourceCounts: { payload: 1, file_mtime: 0, missing: 0, invalid: 1 },
      lag: expect.objectContaining({
        count: 1,
        lastMs: 0,
        maxMs: 0,
      }),
    }));
  });

  it('counts startup replay arrivals without treating historical file mtimes as live lag', () => {
    const adapter = makeStubAdapter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ingestion = new HookIngestion({
      adapter,
      now: () => Date.parse('2026-06-11T12:00:00.000Z'),
      lagWarningThresholdMs: 2000,
    });

    ingestion.injectHookEvent('kookr-1', JSON.stringify({
      session_id: 'x',
      hook_event_name: 'SessionStart',
    }), undefined, {
      startupReplay: true,
      fileMtimeMs: Date.parse('2026-06-11T11:00:00.000Z'),
    });

    const session = ingestion.getDiagnosticsSnapshot().sessions[0];
    expect(session).toEqual(expect.objectContaining({
      totalArrivals: 1,
      dispatchedArrivals: 1,
      startupReplayArrivalCount: 1,
      notableLagCount: 0,
      lag: {
        count: 0,
        lastMs: null,
        meanMs: null,
        maxMs: null,
        p95Ms: null,
      },
    }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('HookIngestion.hydrateFromLedger (restart-replay edge case)', () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), 'kookr-ingest-hydrate-'));
  }

  it('replays hydrated records into live state and backfills raw rows for future checkpoint resumes', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const raw = JSON.stringify({ session_id: 'parent-1', hook_event_name: 'SessionStart' });
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(raw.trim()).digest('hex');
      await ledger.append(envelopeRow({ sequence: 1, contentHash, rawSessionId: 'parent-1' }));
      await ledger.flush();

      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger });

      const hydrated = await ingestion.hydrateFromLedger('kookr-1', ledger);
      expect(hydrated.hydratedHashes).toBe(1);
      expect(hydrated.maxSequence).toBe(1);
      expect(hydrated.liveStateReplayed).toBe(false);

      const initialRowCount = (await ledger.readAll('kookr-1')).length;

      // Simulate file-replay arriving with the same payload. It rebuilds
      // in-memory monitor/watchdog state after restart and backfills the raw
      // payload so a later checkpoint hit can replay live state from ledger.
      const result = ingestion.injectHookEvent('kookr-1', raw);
      expect(result.parseStatus).toBe('ok');
      expect(adapter.calls).toHaveLength(1);
      const rows = await ledger.readAll('kookr-1');
      expect(rows).toHaveLength(initialRowCount + 1);
      expect(rows[1]).toEqual(expect.objectContaining({
        rawJson: raw,
        projection: 'diagnostic_only',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrates coordinator audit-tail metadata from durable ledger rows', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append(envelopeRow({
        taskId: 'task-1',
        kookrSessionId: 'kookr-1',
        rawHookEventName: 'PostToolUse',
        observedAt: '2026-05-21T11:45:00.000Z',
        sequence: 3,
        contentHash: 'c'.repeat(64),
      }));
      await ledger.flush();

      const ingestion = new HookIngestion({ adapter: makeStubAdapter() });
      await ingestion.hydrateFromLedger('kookr-1', ledger);

      expect(ingestion.getCoordinatorAuditTail()).toEqual([{
        taskId: 'task-1',
        observedAt: '2026-05-21T11:45:00.000Z',
        rawHookEventName: 'PostToolUse',
        envelope: {
          taskId: 'task-1',
          kookrSessionId: 'kookr-1',
          observedAt: '2026-05-21T11:45:00.000Z',
          rawHookEventName: 'PostToolUse',
        },
      }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips diagnostic-only rows (duplicates / malformed) so only first-observation hashes seed the cache', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append(envelopeRow({ sequence: 1, contentHash: 'a'.repeat(64) })); // parent_activity
      await ledger.append({
        envelope: {
          schemaVersion: 'hook-envelope.v1',
          kookrSessionId: 'kookr-1',
          provider: 'claude-code',
          source: 'file',
          observedAt: '2026-05-13T12:00:01.000Z',
          sequence: 2,
          contentHash: 'b'.repeat(64),
          parentage: 'unknown',
          parseStatus: 'malformed',
          rawBytes: 50,
        },
        projection: 'diagnostic_only',
      });
      await ledger.flush();

      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter });
      const hydrated = await ingestion.hydrateFromLedger('kookr-1', ledger);
      // Only the parent_activity row seeds — the malformed row does not.
      expect(hydrated.hydratedHashes).toBe(1);
      expect(hydrated.liveStateReplayed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a post-restart replay does not advance the sequence counter while backfilling raw replay rows', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const raw = JSON.stringify({ session_id: 'parent-1', hook_event_name: 'SessionStart' });
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(raw.trim()).digest('hex');
      // Seed the durable ledger with a single parent_activity row at sequence 7.
      await ledger.append(envelopeRow({ sequence: 7, contentHash, rawSessionId: 'parent-1' }));
      await ledger.flush();
      const initialRowCount = (await ledger.readAll('kookr-1')).length;

      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger, dedupTtlMs: 5000 });
      await ingestion.hydrateFromLedger('kookr-1', ledger);

      // File-watcher replay arrives. It rebuilds live state and backfills raw
      // payload, but must NOT bump the sequence counter (otherwise the next
      // REAL event jumps to 9 instead of 8).
      const result = ingestion.injectHookEvent('kookr-1', raw);
      expect(result.parseStatus).toBe('ok');
      expect(adapter.calls).toHaveLength(1);

      const afterRowCount = (await ledger.readAll('kookr-1')).length;
      expect(afterRowCount).toBe(initialRowCount + 1);

      // The next fresh event takes sequence 8, not 9.
      const adapterWithSeq: HookEventInjector & { lastSeq?: number } = {
        injectHookEvent(_t, _r, seq) {
          adapterWithSeq.lastSeq = seq;
          return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: seq ?? 0 };
        },
      };
      const ingestion2 = new HookIngestion({ adapter: adapterWithSeq, activityLedger: ledger });
      const hydration = await ingestion2.hydrateFromLedger('kookr-1', ledger, { replayLiveState: true });
      expect(hydration.liveStateReplayed).toBe(true);
      ingestion2.injectHookEvent('kookr-1', JSON.stringify({ n: 'fresh' })); // new record
      expect(adapterWithSeq.lastSeq).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hydrated cache entries survive past dedupTtlMs so a slow replay still dedups', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const raw = JSON.stringify({ session_id: 'parent-1', hook_event_name: 'SessionStart' });
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(raw.trim()).digest('hex');
      await ledger.append(envelopeRow({ sequence: 1, contentHash, rawSessionId: 'parent-1' }));
      await ledger.flush();

      const adapter = makeStubAdapter();
      // Aggressively short TTL so the test exercises the pinned-entry path
      // without needing a long sleep.
      let clock = 0;
      const ingestion = new HookIngestion({
        adapter,
        activityLedger: ledger,
        dedupTtlMs: 100,
        now: () => clock,
      });
      await ingestion.hydrateFromLedger('kookr-1', ledger);

      // Advance the clock well past the TTL window.
      clock = 1_000_000;
      const result = ingestion.injectHookEvent('kookr-1', raw);
      expect(result.parseStatus).toBe('ok');
      // The hydrated entry was NOT swept by gcExpired; replay still uses the
      // original sequence and dispatches once into live state.
      expect(adapter.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays live state directly from ledger rows that carry raw payloads', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const raw = JSON.stringify({ session_id: 'parent-1', hook_event_name: 'SessionStart' });
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(raw.trim()).digest('hex');
      await ledger.append({
        ...envelopeRow({ sequence: 4, contentHash, rawSessionId: 'parent-1' }),
        rawJson: raw,
      });
      await ledger.flush();

      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger });
      const hydrated = await ingestion.hydrateFromLedger('kookr-1', ledger, { replayLiveState: true });

      expect(hydrated).toEqual(expect.objectContaining({
        hydratedHashes: 1,
        maxSequence: 4,
        liveStateReplayed: true,
      }));
      expect(adapter.calls).toEqual([{ tmux: 'kookr-1', raw }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report live-state replay for an empty ledger', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger });

      const hydrated = await ingestion.hydrateFromLedger('kookr-1', ledger, { replayLiveState: true });

      expect(hydrated).toEqual({
        hydratedHashes: 0,
        maxSequence: 0,
        liveStateReplayed: false,
      });
      expect(adapter.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report live-state replay when a raw ledger row fails to parse on replay', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      const raw = JSON.stringify({ session_id: 'parent-1', hook_event_name: 'SessionStart' });
      const { createHash } = await import('node:crypto');
      const contentHash = createHash('sha256').update(raw.trim()).digest('hex');
      await ledger.append({
        ...envelopeRow({ sequence: 4, contentHash, rawSessionId: 'parent-1' }),
        rawJson: raw,
      });
      await ledger.flush();

      const adapter: HookEventInjector & { calls: string[] } = {
        calls: [],
        injectHookEvent(_tmux, replayedRaw, sequence) {
          adapter.calls.push(replayedRaw);
          return {
            parseStatus: 'malformed',
            agentType: 'claude-code',
            error: 'no longer parses',
            sequence,
          };
        },
      };
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger });
      const hydrated = await ingestion.hydrateFromLedger('kookr-1', ledger, { replayLiveState: true });

      expect(hydrated).toEqual(expect.objectContaining({
        hydratedHashes: 1,
        maxSequence: 4,
        liveStateReplayed: false,
      }));
      expect(adapter.calls).toEqual([raw]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('advances the per-session sequence counter to the hydrated max so post-restart sequences continue', async () => {
    const dir = makeDir();
    try {
      const ledger = new ActivityLedger(dir);
      await ledger.append(envelopeRow({ sequence: 5 }));
      await ledger.append(envelopeRow({ sequence: 9, contentHash: 'c'.repeat(64) }));
      await ledger.flush();

      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter });
      await ingestion.hydrateFromLedger('kookr-1', ledger);

      // First new event after hydration gets sequence 10 (not 1).
      const fresh = JSON.stringify({ session_id: 'parent-1', n: 'new' });
      ingestion.injectHookEvent('kookr-1', fresh);
      // Stub adapter doesn't expose the actual sequence — we observe via call.
      // The contract: HookIngestion's internal sequenceCounter advanced.
      // Re-injecting the same fresh payload would be a duplicate (sequence
      // doesn't matter for dedup), so we exercise the counter via a SECOND
      // distinct payload and confirm via the third sequence number visible
      // through the adapter stub.
      const adapterWithSeq: HookEventInjector & { lastSeq?: number } = {
        injectHookEvent(_t, _r, seq) {
          adapterWithSeq.lastSeq = seq;
          return {
            parseStatus: 'ok',
            agentType: 'claude-code',
            parentage: 'parent',
            sequence: seq ?? 0,
            rawSessionId: 'parent-1',
          };
        },
      };
      const ingestion2 = new HookIngestion({ adapter: adapterWithSeq });
      await ingestion2.hydrateFromLedger('kookr-1', ledger);
      ingestion2.injectHookEvent('kookr-1', JSON.stringify({ session_id: 'parent-1', n: 'new' }));
      expect(adapterWithSeq.lastSeq).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HookIngestion — diagnostic_only projection of duplicates (issue #357)', () => {
  it('projects the second (duplicate) arrival as diagnostic_only and never dispatches it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-ingest-dedup-'));
    try {
      const ledger = new ActivityLedger(dir);
      const adapter = makeStubAdapter();
      const ingestion = new HookIngestion({ adapter, activityLedger: ledger });

      // One pasted line, delivered by both transports (HTTP fast path, then
      // the durable file watcher) — the classic dual-delivery duplicate.
      const raw = JSON.stringify({
        session_id: 'x',
        hook_event_name: 'UserPromptSubmit',
        prompt: '{"pasted": "line"}',
      });
      const first = ingestion.ingestFromHttp('kookr-1', raw);
      ingestion.injectHookEvent('kookr-1', raw); // file-source duplicate

      expect(first.dispatched).toBe(true);
      // The duplicate is dropped before the adapter — so it never reaches the
      // monitor window and therefore never the activity panel.
      expect(adapter.calls).toHaveLength(1);

      await ledger.flush();
      const rows = await ledger.readAll('kookr-1');
      // The ledger keeps both arrivals for diagnostics/export, but the
      // duplicate is projected `diagnostic_only` so it is not user-facing
      // activity — and it was never dispatched, so it cannot reach the panel.
      expect(rows.map((r) => r.projection).sort()).toEqual([
        'diagnostic_only',
        'parent_activity',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HookIngestion — end-to-end correlation id (#705)', () => {
  it('mints a deterministic, redaction-safe correlation id from (session, sequence)', () => {
    const id = mintEventId('kookr-session-1', 7);
    expect(id).toMatch(/^evt_[0-9a-f]{12}_7$/);
    // Pure function: identical inputs → identical id (the thread-unchanged guarantee).
    expect(mintEventId('kookr-session-1', 7)).toBe(id);
    // Different session or sequence → different id.
    expect(mintEventId('kookr-session-2', 7)).not.toBe(id);
    expect(mintEventId('kookr-session-1', 8)).not.toBe(id);
    // The raw session id is hashed, not embedded verbatim.
    expect(id).not.toContain('kookr-session-1');
  });

  it('surfaces the minted id on the ingest result, matching the allocated sequence', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const result = ingestion.ingestFromHttp('kookr-1', raw);

    expect(result.dispatched).toBe(true);
    expect(result.injectResult.sequence).toBe(1);
    expect(result.eventId).toBe(mintEventId('kookr-1', 1));
  });

  it('reports the SAME correlation id for a dual-delivery duplicate', () => {
    const adapter = makeStubAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    // HTTP delivers first and dispatches; the file watcher then replays the
    // identical record within the dedup TTL → a duplicate.
    const first = ingestion.ingestFromHttp('kookr-1', raw);
    const duplicate = ingestion.ingestFromHttp('kookr-1', raw);

    expect(first.dispatched).toBe(true);
    expect(duplicate.reason).toBe('duplicate');
    // Both arrivals are the same logical event → same correlation id.
    expect(duplicate.eventId).toBe(first.eventId);
  });
});

describe('HookIngestion — replay-vs-live origin tagging (issue #701)', () => {
  function makeOriginAdapter(): HookEventInjector & {
    origins: Array<EventOrigin | undefined>;
  } {
    const origins: Array<EventOrigin | undefined> = [];
    return {
      origins,
      injectHookEvent(_tmux, _raw, sequence, options) {
        origins.push(options?.origin);
        return {
          parseStatus: 'ok' as const,
          agentType: 'claude-code' as const,
          parentage: 'parent' as const,
          rawSessionId: 'x',
          sequence: sequence ?? 0,
        };
      },
    };
  }

  it('deriveEventOrigin classifies replay-prefixed sessions as replay, others as live', () => {
    expect(deriveEventOrigin(`${REPLAY_SESSION_PREFIX}demo`)).toBe('replay');
    expect(deriveEventOrigin('kookr-task-123')).toBe('live');
  });

  it('tags records on a replay session as origin=replay and forwards it to the adapter', () => {
    const adapter = makeOriginAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const result = ingestion.ingestFromHttp(`${REPLAY_SESSION_PREFIX}demo`, raw);

    expect(result.dispatched).toBe(true);
    expect(result.origin).toBe('replay');
    expect(result.injectResult.origin).toBe('replay');
    expect(adapter.origins).toEqual(['replay']);
  });

  it('tags records on a real session as origin=live', () => {
    const adapter = makeOriginAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const result = ingestion.ingestFromHttp('kookr-task-1', raw);

    expect(result.origin).toBe('live');
    expect(result.injectResult.origin).toBe('live');
    expect(adapter.origins).toEqual(['live']);
  });

  it('does not let a replayed record dedup against an identical live record (per-session scoping)', () => {
    // KB lesson distinguish-replayed-events-from-fresh-events: a replayed tail
    // record must never be confused with fresh live output. Because dedup is
    // keyed by session id and replay uses a dedicated synthetic session, the
    // same payload dispatches independently on each, each tagged by origin.
    const adapter = makeOriginAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'Stop' });
    const live = ingestion.ingestFromHttp('kookr-task-1', raw);
    const replay = ingestion.ingestFromHttp(`${REPLAY_SESSION_PREFIX}demo`, raw);

    expect(live.dispatched).toBe(true);
    expect(replay.dispatched).toBe(true);
    expect(live.origin).toBe('live');
    expect(replay.origin).toBe('replay');
    expect(adapter.origins).toEqual(['live', 'replay']);
  });

  it('tags the duplicate (dual-delivery) arrival origin=replay without re-dispatching', () => {
    const adapter = makeOriginAdapter();
    const ingestion = new HookIngestion({ adapter });

    const raw = JSON.stringify({ session_id: 'x', hook_event_name: 'SessionStart' });
    const session = `${REPLAY_SESSION_PREFIX}demo`;
    ingestion.ingestFromHttp(session, raw);            // first observation dispatches
    const dup = ingestion.ingestFromHttp(session, raw); // dual-delivery duplicate

    expect(dup).toMatchObject({ dispatched: false, reason: 'duplicate', origin: 'replay' });
    expect(dup.injectResult.origin).toBe('replay');
    expect(adapter.origins).toEqual(['replay']); // adapter called once
  });

  it('reports origin=replay on the empty-payload rejection path', () => {
    const adapter = makeOriginAdapter();
    const ingestion = new HookIngestion({ adapter });

    const result = ingestion.ingestFromHttp(`${REPLAY_SESSION_PREFIX}demo`, '   ');
    expect(result).toMatchObject({ dispatched: false, reason: 'empty', origin: 'replay' });
    expect(result.injectResult.origin).toBe('replay');
    expect(adapter.origins).toHaveLength(0);
  });
});

describe('HookIngestion — hook parse degradation alerting (issue #841)', () => {
  function makeMalformedAdapter(error = 'Unexpected token b in JSON at position 1'): HookEventInjector {
    return {
      injectHookEvent(_tmux, _raw, sequence, options) {
        return {
          parseStatus: 'malformed',
          agentType: 'claude-code',
          error,
          sequence: sequence ?? 0,
          origin: options?.origin,
        };
      },
    };
  }

  it('reports live malformed hook records with a bounded excerpt', () => {
    const observed: HookParseDegradationEvent[] = [];
    const ingestion = new HookIngestion({
      adapter: makeMalformedAdapter('bad hook JSON'),
      now: () => Date.parse('2026-06-11T10:00:00.000Z'),
      onParseDegradation: (event) => observed.push(event),
    });

    const raw = '{"hook_event_name":"SessionStart","payload":"broken schema","long":"' + 'x'.repeat(300) + '"}';
    const result = ingestion.ingestFromHttp('kookr-live-1', raw);

    expect(result.dispatched).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      kookrSessionId: 'kookr-live-1',
      source: 'http',
      error: 'bad hook JSON',
      eventId: result.eventId,
      sequence: 1,
      observedAt: '2026-06-11T10:00:00.000Z',
    });
    expect(observed[0].excerpt).toContain('SessionStart');
    expect(observed[0].excerpt.length).toBeLessThanOrEqual(160);
  });

  it('does not report startup replay of old malformed records', () => {
    const onParseDegradation = vi.fn();
    const ingestion = new HookIngestion({
      adapter: makeMalformedAdapter(),
      onParseDegradation,
    });

    ingestion.injectHookEvent('kookr-live-1', '{"bad":', undefined, { startupReplay: true });

    expect(onParseDegradation).not.toHaveBeenCalled();
    expect(ingestion.getActivityMeta('kookr-live-1')?.malformedRecordCount).toBe(1);
  });

  it('does not report synthetic replay sessions as live parse degradation', () => {
    const onParseDegradation = vi.fn();
    const ingestion = new HookIngestion({
      adapter: makeMalformedAdapter(),
      onParseDegradation,
    });

    ingestion.ingestFromHttp(`${REPLAY_SESSION_PREFIX}demo`, '{"bad":');

    expect(onParseDegradation).not.toHaveBeenCalled();
  });

});
