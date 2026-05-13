import { describe, expect, it, vi } from 'vitest';
import { HookIngestion, type HookEventInjector } from './hook-ingestion.js';

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
    const b = ingestion.ingest({ kookrSessionId: 'kookr-1', raw, source: 'file' });

    expect(a.dispatched).toBe(true);
    expect(b.dispatched).toBe(false);
    expect(b.reason).toBe('duplicate');
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
