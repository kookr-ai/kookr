import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookIngestion, type HookEventInjector } from './hook-ingestion.js';
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
});

describe('HookIngestion.hydrateFromLedger (restart-replay edge case)', () => {
  function makeDir(): string {
    return mkdtempSync(join(tmpdir(), 'kookr-ingest-hydrate-'));
  }

  it('replays hydrated records into live state without writing duplicate ledger rows', async () => {
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

      const initialRowCount = (await ledger.readAll('kookr-1')).length;

      // Simulate file-replay arriving with the same payload. It must rebuild
      // in-memory monitor/watchdog state after restart, but must not append a
      // duplicate diagnostic ledger row.
      const result = ingestion.injectHookEvent('kookr-1', raw);
      expect(result.parseStatus).toBe('ok');
      expect(adapter.calls).toHaveLength(1);
      expect(await ledger.readAll('kookr-1')).toHaveLength(initialRowCount);
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a post-restart replay does not advance the sequence counter or write phantom diagnostic rows', async () => {
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

      // File-watcher replay arrives. It rebuilds live state, but must NOT
      // bump the sequence counter (otherwise the next REAL event jumps to 9
      // instead of 8) and must NOT write a diagnostic-only ledger row
      // (otherwise stats inflates by N on every restart).
      const result = ingestion.injectHookEvent('kookr-1', raw);
      expect(result.parseStatus).toBe('ok');
      expect(adapter.calls).toHaveLength(1);

      const afterRowCount = (await ledger.readAll('kookr-1')).length;
      expect(afterRowCount).toBe(initialRowCount); // no phantom diagnostic row

      // The next fresh event takes sequence 8, not 9.
      const adapterWithSeq: HookEventInjector & { lastSeq?: number } = {
        injectHookEvent(_t, _r, seq) {
          adapterWithSeq.lastSeq = seq;
          return { parseStatus: 'ok', agentType: 'claude-code', parentage: 'parent', sequence: seq ?? 0 };
        },
      };
      const ingestion2 = new HookIngestion({ adapter: adapterWithSeq, activityLedger: ledger });
      await ingestion2.hydrateFromLedger('kookr-1', ledger);
      ingestion2.injectHookEvent('kookr-1', raw);                // replay hit — counter stays
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
