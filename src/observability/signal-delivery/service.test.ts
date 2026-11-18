import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { SignalDeliveryConfig } from './config.js';
import { DELIVERED_MARKER_FILE, loadDeliveredMarker, writeOperatorSignal } from './operator-signal.js';
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
    telegramSignals: 'all',
    dryRun: false,
    pollIntervalMs: 15_000,
    minSendIntervalMs: 60_000,
    bootDelayMs: 5_000,
    backoffBaseMs: 30_000,
    backoffMaxMs: 900_000,
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
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    const r = await svc.tick();
    expect(r.delivered).toEqual([]);
    expect(r.pending).toBe(1);

    // Recovers once the back-off window elapses: next attempt succeeds and
    // delivers exactly once.
    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    clock.advance(30_000);
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

describe('SignalDeliveryService — signal read isolation', () => {
  test('delivers healthy signals once and retries an unreadable entry after repair', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const clock = new Clock(0);
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });
    const retained = await writeOperatorSignal(dir, { key: 'a', kind: 'alert', source: 's', title: 'retained alert' });
    const healthy = await writeOperatorSignal(dir, { key: 'z', kind: 'alert', source: 's', title: 'healthy alert' });
    await rename(retained.path, join(dir, 'retained'));
    await mkdir(retained.path); // A real EISDIR read fault before z.json in scan order.

    expect((await svc.tick()).delivered).toEqual(['z.json']);
    expect(await loadDeliveredMarker(dir)).toEqual({ 'z.json': healthy.signal.createdAt });
    expect(svc.status()).toMatchObject({
      pending: 0, scanFailures: 1, scanFailedFiles: 1,
      lastScanFailureAt: clock.now().toISOString(), consecutiveFailures: 0, lastFailureAt: null,
    });
    expect(svc.status().lastScanError).toBe('Unable to read one or more signal files');
    expect(svc.status().lastError).toBeUndefined();
    expect(svc.status().nextAttemptAt).toBeUndefined();

    clock.advance(60_000);
    expect((await svc.tick()).delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(svc.status().scanFailures).toBe(2);
    const lastScanFailureAt = svc.status().lastScanFailureAt;

    await rm(retained.path, { recursive: true });
    await rename(join(dir, 'retained'), retained.path);
    clock.advance(60_000);
    expect((await svc.tick()).delivered).toEqual(['a.json']);
    expect(svc.status()).toMatchObject({ scanFailures: 2, scanFailedFiles: 0, lastScanFailureAt });
    expect(svc.status().lastScanError).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const messages = fetchImpl.mock.calls.map((call) => JSON.parse(call[1]!.body as string) as { content: string });
    expect(messages[0]!.content).toContain('healthy alert');
    expect(messages[0]!.content).not.toContain('retained alert');
    expect(messages[1]!.content).toContain('retained alert');
    expect(messages[1]!.content).not.toContain('healthy alert');

    const restarted = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });
    expect((await restarted.tick()).delivered).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('bounds scan diagnostics and clears the current error on an empty successful scan', async () => {
    const dir = await tempDir();
    const log = vi.fn();
    const fetchImpl = okFetch();
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: () => new Date(0), log });
    for (let i = 0; i < 20; i++) {
      await mkdir(join(dir, `private-token-${i}.json`));
    }
    expect((await svc.tick()).delivered).toEqual([]);
    expect(svc.status()).toMatchObject({ scanFailedFiles: 20, scanFailures: 20, consecutiveFailures: 0 });
    expect(JSON.stringify(svc.status())).not.toContain('private-token');
    expect(JSON.stringify(svc.status()).length).toBeLessThan(500);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    await rm(dir, { recursive: true });
    await mkdir(dir);
    await svc.tick();
    expect(svc.status()).toMatchObject({ scanFailedFiles: 0, scanFailures: 20 });
    expect(svc.status().lastScanError).toBeUndefined();
  });

  test('missing and malformed signals keep their existing skip behavior', async () => {
    const dir = await tempDir();
    await symlink(join(dir, 'absent'), join(dir, 'a.json'));
    await writeFile(join(dir, 'b.json'), '{broken');
    await writeFile(join(dir, 'c.json'), JSON.stringify({ schemaVersion: 'unknown', key: 'c' }));
    await writeOperatorSignal(dir, { key: 'z', kind: 'alert', source: 's', title: 'healthy' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl: okFetch(), log: () => {} });

    expect((await svc.tick()).delivered).toEqual(['z.json']);
    expect(svc.status()).toMatchObject({ scanFailures: 0, scanFailedFiles: 0, lastScanFailureAt: null });
    expect(svc.status().lastScanError).toBeUndefined();
  });

  test.each(['directory', 'marker read', 'marker write'])('%s errors still reject the tick', async (fault) => {
    const root = await tempDir();
    const dir = join(root, 'signals');
    await writeOperatorSignal(dir, { key: 'z', kind: 'alert', source: 's', title: 'healthy' });
    const fetchImpl = okFetch();
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, log: () => {} });
    if (fault === 'directory') {
      await rm(dir, { recursive: true });
      await writeFile(dir, 'not a directory');
    } else {
      await mkdir(join(dir, fault === 'marker read' ? DELIVERED_MARKER_FILE : `${DELIVERED_MARKER_FILE}.tmp-write`));
    }

    await expect(svc.tick()).rejects.toMatchObject({ code: fault === 'directory' ? 'ENOTDIR' : 'EISDIR' });
    expect(fetchImpl).toHaveBeenCalledTimes(fault === 'marker write' ? 1 : 0);
    expect(svc.status()).toMatchObject({ scanFailures: 0, scanFailedFiles: 0, consecutiveFailures: 0 });
    if (fault === 'marker write') {
      await expect(readFile(join(dir, DELIVERED_MARKER_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('scan recovery does not reset channel backoff', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'a.json'));
    await writeOperatorSignal(dir, { key: 'z', kind: 'alert', source: 's', title: 'healthy' });
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const clock = new Clock(0);
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    await svc.tick();
    expect(svc.status()).toMatchObject({ pending: 1, scanFailures: 1, consecutiveFailures: 1 });
    const nextAttemptAt = svc.status().nextAttemptAt;
    await rm(join(dir, 'a.json'), { recursive: true });
    clock.advance(15_000);
    expect((await svc.tick()).backoff).toBe(true);
    expect(svc.status()).toMatchObject({ scanFailedFiles: 0, scanFailures: 1, consecutiveFailures: 1, nextAttemptAt });
    expect(svc.status().lastScanError).toBeUndefined();
    expect(svc.status().lastError).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    clock.advance(15_000);
    expect((await svc.tick()).delivered).toEqual(['z.json']);
    expect(svc.status()).toMatchObject({ scanFailures: 1, consecutiveFailures: 0 });
  });
});

describe('SignalDeliveryService — failure back-off (issue #3046)', () => {
  test('persistent all-channel failures space out attempts instead of re-POSTing every poll', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    // First failure: one POST attempted, back-off armed for 30s.
    const r1 = await svc.tick();
    expect(r1.pending).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(svc.status().consecutiveFailures).toBe(1);

    // Poll again well within the back-off window (default poll ~15s): gated, NO
    // new POST — this is the retry storm the issue removes.
    clock.advance(15_000);
    const r2 = await svc.tick();
    expect(r2.backoff).toBe(true);
    expect(r2.pending).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past the 30s window: one more attempt is made (still failing) and the
    // window doubles to 60s.
    clock.advance(16_000); // now = 31s
    const r3 = await svc.tick();
    expect(r3.backoff).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(svc.status().consecutiveFailures).toBe(2);

    // 45s later (< 60s window from t=31s): still gated.
    clock.advance(45_000);
    const r4 = await svc.tick();
    expect(r4.backoff).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('the back-off window is capped (does not grow unbounded)', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({
      dir, config: baseConfig({ backoffBaseMs: 1000, backoffMaxMs: 4000 }), fetchImpl, now: clock.now, log: () => {},
    });

    // Drive many consecutive failures, always waiting out the current window.
    for (let i = 0; i < 8; i++) {
      await svc.tick();
      clock.advance(4000); // ≥ cap, so the next tick is always eligible
    }
    // Window never exceeds the cap: at t just past cap, the next attempt fires.
    const before = fetchImpl.mock.calls.length;
    clock.advance(4000);
    await svc.tick();
    expect(fetchImpl.mock.calls.length).toBe(before + 1);
    expect(svc.status().consecutiveFailures).toBeGreaterThanOrEqual(8);
  });

  test('a success after back-off resets the counter and resumes normal cadence', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    await svc.tick(); // fail #1 → back-off 30s
    clock.advance(31_000);
    await svc.tick(); // fail #2 → back-off 60s
    expect(svc.status().consecutiveFailures).toBe(2);

    // Recover.
    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    clock.advance(61_000);
    const ok = await svc.tick();
    expect(ok.delivered).toEqual(['k.json']);
    expect(svc.status().consecutiveFailures).toBe(0);
    expect(svc.status().nextAttemptAt).toBeUndefined();

    // Next signal is gated only by the ordinary min-send interval, not back-off.
    await writeOperatorSignal(dir, { key: 'k2', kind: 'alert', source: 's', title: 't2' });
    clock.advance(61_000);
    const ok2 = await svc.tick();
    expect(ok2.delivered).toEqual(['k2.json']);
  });

  test('honors a 429 Retry-After as a lower bound on the next attempt', async () => {
    const dir = await tempDir();
    // Retry-After: 120s — far longer than the 30s base window.
    const fetchImpl = vi.fn(async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }));
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // 60s later — past the 30s base but inside the 120s Retry-After: still gated.
    clock.advance(60_000);
    const gated = await svc.tick();
    expect(gated.backoff).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past 120s: attempt is allowed again.
    clock.advance(61_000);
    await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('caps an honored Retry-After so a hostile value cannot stall recovery', async () => {
    const dir = await tempDir();
    // Server demands 600s, but the bridge cap is 60s.
    const fetchImpl = vi.fn(async () =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '600' } }));
    const clock = new Clock(0);
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    const svc = new SignalDeliveryService({
      dir, config: baseConfig({ backoffBaseMs: 5_000, backoffMaxMs: 60_000 }), fetchImpl, now: clock.now, log: () => {},
    });

    await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Just past the 60s cap (< the 600s the server asked for): attempt resumes.
    clock.advance(61_000);
    await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('status() surfaces configured / pending / failure fields for health', async () => {
    const dir = await tempDir();
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const clock = new Clock(1_700_000_000_000);
    const svc = new SignalDeliveryService({ dir, config: baseConfig(), fetchImpl, now: clock.now, log: () => {} });

    // Healthy, nothing sent yet.
    const s0 = svc.status();
    expect(s0.configured).toBe(true);
    expect(s0.consecutiveFailures).toBe(0);
    expect(s0.lastSendAt).toBeNull();
    expect(s0.lastFailureAt).toBeNull();
    expect(s0.lastError).toBeUndefined();

    // After a failure: failure fields populate, timestamps are ISO strings.
    await writeOperatorSignal(dir, { key: 'k', kind: 'alert', source: 's', title: 't' });
    await svc.tick();
    const s1 = svc.status();
    expect(s1.consecutiveFailures).toBe(1);
    expect(s1.pending).toBe(1);
    expect(s1.lastFailureAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(typeof s1.lastError).toBe('string');
    expect(s1.nextAttemptAt).toBe(new Date(1_700_000_000_000 + 30_000).toISOString());

    // After recovery: send timestamp set, pending cleared, failure fields reset.
    fetchImpl.mockImplementation(async () => new Response(null, { status: 204 }));
    clock.advance(30_000);
    await svc.tick();
    const s2 = svc.status();
    expect(s2.consecutiveFailures).toBe(0);
    expect(s2.pending).toBe(0);
    expect(s2.lastSendAt).toBe(new Date(1_700_000_000_000 + 30_000).toISOString());
    expect(s2.nextAttemptAt).toBeUndefined();
    expect(s2.lastError).toBeUndefined();
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

describe('SignalDeliveryService — Telegram gets decisions only', () => {
  const TELEGRAM = { botToken: 't', chatId: 'c' };
  const telegramOnly = (level: 'decisions' | 'all' = 'decisions') =>
    baseConfig({ discord: undefined, telegram: TELEGRAM, telegramSignals: level });
  const calls = (fetchImpl: ReturnType<typeof okFetch>) =>
    (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => {
      const body = JSON.parse(String(init.body)) as { text?: string; content?: string };
      return { url, text: body.text ?? body.content ?? '' };
    });
  const sentText = (fetchImpl: ReturnType<typeof okFetch>, call: number): string => calls(fetchImpl)[call]!.text;

  test('status alerts, clears and notices never reach a Telegram-only install', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'train:halted', kind: 'alert', source: 'integration-train', title: 'halted' });
    await writeOperatorSignal(dir, { key: 'smoke:clear', kind: 'clear', source: 'prod_smoke_tick', title: 'recovered' });
    await writeOperatorSignal(dir, { key: 'train:bypass', kind: 'info', source: 'integration-train', title: 'bypassed' });

    const svc = new SignalDeliveryService({ dir, config: telegramOnly(), fetchImpl, now: () => new Date(0), log: () => {} });
    const r = await svc.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.delivered).toEqual([]);
    expect(r.withheld).toEqual(['smoke-clear.json', 'train-bypass.json', 'train-halted.json']);
    expect(r.pending).toBe(0);
    expect(svc.status().pending).toBe(0);

    // Acknowledged once: neither a later tick nor a switch to `all` replays them.
    expect((await svc.tick()).withheld).toBeUndefined();
    const all = new SignalDeliveryService({ dir, config: telegramOnly('all'), fetchImpl, now: () => new Date(0), log: () => {} });
    await all.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a permission-prompt wait and an agent self-report still page Telegram; their clears do not', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'op:permission_prompt:t1:alert', kind: 'alert', source: 'permission_prompt_wait', title: 'waits on Bash' });
    await writeOperatorSignal(dir, { key: 'op:self-report:a1:alert', kind: 'alert', source: 'agent_self_report', title: 'prompt unusable' });
    await writeOperatorSignal(dir, { key: 'op:permission_prompt:t0:clear', kind: 'clear', source: 'permission_prompt_wait', title: 'answered' });

    const svc = new SignalDeliveryService({ dir, config: telegramOnly(), fetchImpl, now: () => new Date(0), log: () => {} });
    const r = await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const text = sentText(fetchImpl, 0);
    expect(text).toContain('waits on Bash');
    expect(text).toContain('prompt unusable');
    expect(text).not.toContain('answered');
    expect(r.delivered).toHaveLength(2);
    expect(r.withheld).toEqual(['op-permission_prompt-t0-clear.json']);
  });

  test('with Discord too, Discord gets every signal and Telegram only the decision', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'train', kind: 'alert', source: 'integration-train', title: 'train halted' });
    await writeOperatorSignal(dir, { key: 'perm', kind: 'alert', source: 'permission_prompt_wait', title: 'waits on Bash' });

    const config = baseConfig({ telegram: TELEGRAM, telegramSignals: 'decisions' });
    const svc = new SignalDeliveryService({ dir, config, fetchImpl, now: () => new Date(0), log: () => {} });
    const r = await svc.tick();
    expect(r.delivered).toEqual(['perm.json', 'train.json']);
    expect(r.withheld).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const discord = calls(fetchImpl).find((c) => c.url === 'https://discord/webhook')!.text;
    const telegram = calls(fetchImpl).find((c) => c.url.includes('/sendMessage'))!.text;
    expect(discord).toContain('train halted');
    expect(discord).toContain('waits on Bash');
    expect(telegram).toContain('waits on Bash');
    expect(telegram).not.toContain('train halted');
  });

  test('with Discord too, a batch of status signals posts to Discord only', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'train', kind: 'alert', source: 'integration-train', title: 'train halted' });

    const config = baseConfig({ telegram: TELEGRAM, telegramSignals: 'decisions' });
    const svc = new SignalDeliveryService({ dir, config, fetchImpl, now: () => new Date(0), log: () => {} });
    expect((await svc.tick()).delivered).toEqual(['train.json']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://discord/webhook');
  });

  test('a status signal is acknowledged even while the send interval holds decisions back', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const clock = new Clock(0);
    const svc = new SignalDeliveryService({ dir, config: telegramOnly(), fetchImpl, now: clock.now, log: () => {} });
    await writeOperatorSignal(dir, { key: 'perm1', kind: 'alert', source: 'permission_prompt_wait', title: 'first' });
    await svc.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock.advance(1_000);
    await writeOperatorSignal(dir, { key: 'perm2', kind: 'alert', source: 'permission_prompt_wait', title: 'second' });
    await writeOperatorSignal(dir, { key: 'train', kind: 'alert', source: 'integration-train', title: 'halted' });
    const held = await svc.tick();
    expect(held.throttled).toBe(true);
    expect(held.pending).toBe(1);
    expect(held.withheld).toEqual(['train.json']);
    expect(svc.status().pending).toBe(1);
    expect((await loadDeliveredMarker(dir))['train.json']).toBeDefined();
  });

  test('KOOKR_SIGNAL_TELEGRAM_LEVEL=all keeps the full stream on Telegram', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    await writeOperatorSignal(dir, { key: 'train', kind: 'alert', source: 'integration-train', title: 'train halted' });
    const svc = new SignalDeliveryService({ dir, config: telegramOnly('all'), fetchImpl, now: () => new Date(0), log: () => {} });
    expect((await svc.tick()).delivered).toEqual(['train.json']);
    expect(sentText(fetchImpl, 0)).toContain('train halted');
  });

  test('dry-run logs the Telegram batch without the status signals', async () => {
    const dir = await tempDir();
    const fetchImpl = okFetch();
    const log = vi.fn();
    await writeOperatorSignal(dir, { key: 'train', kind: 'alert', source: 'integration-train', title: 'train halted' });
    await writeOperatorSignal(dir, { key: 'perm', kind: 'alert', source: 'permission_prompt_wait', title: 'waits on Bash' });
    const config = baseConfig({ discord: undefined, telegram: TELEGRAM, telegramSignals: 'decisions', dryRun: true });
    const svc = new SignalDeliveryService({ dir, config, fetchImpl, now: () => new Date(0), log });
    await svc.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    const dry = log.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('DRY-RUN'));
    expect(dry).toHaveLength(1);
    expect(dry[0]).toContain('waits on Bash');
    expect(dry[0]).not.toContain('train halted');
  });
});
