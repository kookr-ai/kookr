import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { SignalDeliveryConfig } from './config.js';
import { writeOperatorSignal } from './operator-signal.js';
import { SignalDeliveryService, formatBatch } from './service.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-delivery-'));
}

function okFetch() {
  return vi.fn(async () => new Response(null, { status: 204 }));
}

function baseConfig(overrides: Partial<SignalDeliveryConfig> = {}): SignalDeliveryConfig {
  return {
    discord: { webhookUrl: 'https://discord/webhook' },
    dryRun: false,
    pollIntervalMs: 15_000,
    minSendIntervalMs: 60_000,
    bootDelayMs: 5_000,
    ...overrides,
  };
}

class Clock {
  constructor(private ms: number) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void { this.ms += ms; }
}

describe('SignalDeliveryService — AC: exactly one POST, restart-safe', () => {
  test('a spooled signal produces exactly one POST', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'deploy-lag:alert', kind: 'alert', source: 'deploy-lag', title: 'ALERT' });

    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });
    const r1 = await svc.tick();
    expect(r1.delivered).toEqual(['deploy-lag-alert.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Same instance: nothing new pending → no further POST.
    clock.advance(120_000);
    const r2 = await svc.tick();
    expect(r2.delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('re-emitting the same key with a fresh createdAt re-delivers (flap / 6h re-emit)', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const clock = new Clock(0);
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    // First occurrence.
    await writeOperatorSignal(dir, { key: 'deploy-lag:alert', kind: 'alert', source: 'deploy-lag', title: 'ALERT' }, () => new Date(0));
    expect((await svc.tick()).delivered).toEqual(['deploy-lag-alert.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Same key re-fires later — overwrites the file with a fresh createdAt.
    await writeOperatorSignal(dir, { key: 'deploy-lag:alert', kind: 'alert', source: 'deploy-lag', title: 'ALERT AGAIN' }, () => new Date(120_000));
    clock.advance(120_000); // past min-send interval
    const r = await svc.tick();
    expect(r.delivered).toEqual(['deploy-lag-alert.json']); // re-delivered, not swallowed
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // No further change → not re-posted again.
    clock.advance(120_000);
    expect((await svc.tick()).delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('a restart (fresh instance, same dir) does not re-post', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });

    const first = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: () => new Date(0), log: () => {} });
    await first.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Simulate process restart: brand-new service, persisted marker on disk.
    const second = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: () => new Date(999_999), log: () => {} });
    const r = await second.tick();
    expect(r.delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('Telegram-only: exactly one POST and no re-post after restart', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const config = baseConfig({ discord: undefined, telegram: { botToken: 't', chatId: 'c' } });
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });

    const first = new SignalDeliveryService({ dir, config, fetchImpl, now: () => new Date(0), log: () => {} });
    expect((await first.tick()).delivered).toEqual(['k.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toContain('/sendMessage');

    const second = new SignalDeliveryService({ dir, config, fetchImpl, now: () => new Date(999_999), log: () => {} });
    expect((await second.tick()).delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('SignalDeliveryService — batching ≤1/min', () => {
  test('holds a new signal until the min-send interval elapses', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const clock = new Clock(1_000_000);
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    await writeOperatorSignal(dir, { key: 'a', kind: 'alert', source: 's', title: 'a' });
    expect((await svc.tick()).delivered).toEqual(['a.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // New signal within the minute → throttled.
    await writeOperatorSignal(dir, { key: 'b', kind: 'alert', source: 's', title: 'b' });
    clock.advance(30_000);
    const throttled = await svc.tick();
    expect(throttled.throttled).toBe(true);
    expect(throttled.pending).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the interval → delivered.
    clock.advance(31_000);
    expect((await svc.tick()).delivered).toEqual(['b.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('drains multiple pending signals into a single batched POST', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'a', kind: 'alert', source: 's', title: 'first' });
    await writeOperatorSignal(dir, { key: 'b', kind: 'clear', source: 's', title: 'second' });

    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: () => new Date(0), log: () => {} });
    const r = await svc.tick();
    expect(r.delivered.sort()).toEqual(['a.json', 'b.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as { content: string };
    expect(body.content).toContain('first');
    expect(body.content).toContain('second');
  });
});

describe('SignalDeliveryService — dry-run', () => {
  test('never POSTs but marks delivered so it does not loop', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({
      dir, config: baseConfig({ dryRun: true }), fetchImpl, now: () => new Date(0), log: () => {},
    });
    const r = await svc.tick();
    expect(r.delivered).toEqual(['k.json']);
    expect(fetchImpl).not.toHaveBeenCalled();

    const r2 = await svc.tick();
    expect(r2.delivered).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('SignalDeliveryService — failure handling', () => {
  test('all-channels-failed leaves the signal pending for retry', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: () => new Date(0), log: () => {} });

    const r = await svc.tick();
    expect(r.delivered).toEqual([]);
    expect(r.pending).toBe(1);

    // Recovers: next attempt succeeds and delivers exactly once.
    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    const r2 = await svc.tick();
    expect(r2.delivered).toEqual(['k.json']);
  });

  test('marks a partial success delivered (no duplicate re-post)', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('discord') ? new Response(null, { status: 204 }) : new Response('x', { status: 500 }));
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const config = baseConfig({ telegram: { botToken: 't', chatId: 'c' } });
    const svc = new SignalDeliveryService({ dir, config, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => new Date(0), log: () => {} });

    const r = await svc.tick();
    expect(r.delivered).toEqual(['k.json']); // discord ok → delivered despite telegram fail
    const calls = fetchImpl.mock.calls.length;
    const r2 = await svc.tick();
    expect(r2.delivered).toEqual([]);
    expect(fetchImpl.mock.calls.length).toBe(calls); // no re-post
  });
});

describe('formatBatch', () => {
  test('renders kind emoji, source, title, and detail', () => {
    const msg = formatBatch([
      { schemaVersion: 'operator-signal.v1', key: 'k', kind: 'alert', source: 'deploy-lag', title: 'behind', detail: '7 commits', createdAt: 'x' },
    ]);
    expect(msg).toContain('deploy-lag');
    expect(msg).toContain('behind');
    expect(msg).toContain('7 commits');
    expect(msg).toContain('🚨');
  });
});
