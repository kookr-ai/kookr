import { describe, expect, test } from 'vitest';
import { GpuProbe, type GpuCommandResult } from './gpu-probe.js';

const RTX_LINE = '0, NVIDIA GeForce RTX 3090, 27, 2288, 24576, 49.50, 33.20\n';

function ok(stdout: string = RTX_LINE): GpuCommandResult {
  return { notInstalled: false, ok: true, stdout };
}
const FAILED: GpuCommandResult = { notInstalled: false, ok: false, stdout: '' };
const NOT_INSTALLED: GpuCommandResult = { notInstalled: true, ok: false, stdout: '' };

/** A probe whose command results and clock the test controls. */
function harness(results: GpuCommandResult[]) {
  let now = 0;
  let calls = 0;
  const probe = new GpuProbe({
    run: async () => {
      calls += 1;
      return results.shift() ?? FAILED;
    },
    nowMs: () => now,
    maxAgeMs: 20_000,
    absentRetryMs: 300_000,
  });
  return {
    probe,
    advance: (ms: number) => { now += ms; },
    calls: () => calls,
  };
}

describe('GpuProbe', () => {
  test('is "warming up" until the first probe finishes', () => {
    const { probe } = harness([ok()]);
    expect(probe.snapshot()).toEqual({ devices: [], ageMs: null, unavailable: 'warming_up' });
  });

  test('returns the parsed devices and their age after a successful probe', async () => {
    const h = harness([ok()]);
    await h.probe.refresh();
    h.advance(4_000);
    const snapshot = h.probe.snapshot();
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.ageMs).toBe(4_000);
    expect(snapshot.devices).toHaveLength(1);
    expect(snapshot.devices[0].name).toBe('NVIDIA GeForce RTX 3090');
    expect(snapshot.devices[0].utilizationPercent).toBe(27);
  });

  test('a host without nvidia-smi is reported as such and not probed again for a while', async () => {
    const h = harness([NOT_INSTALLED, ok()]);
    await h.probe.refresh();
    expect(h.probe.snapshot().unavailable).toBe('not_installed');
    h.advance(60_000);
    await h.probe.refresh();
    await h.probe.refresh();
    expect(h.calls()).toBe(1);
    // After the retry delay the probe runs again and picks up a newly installed driver.
    h.advance(300_000);
    await h.probe.refresh();
    expect(h.calls()).toBe(2);
    expect(h.probe.snapshot().unavailable).toBeNull();
  });

  test('a failed probe keeps the last good reading until it is too old', async () => {
    const h = harness([ok(), FAILED, FAILED]);
    await h.probe.refresh();
    h.advance(4_000);
    await h.probe.refresh();
    expect(h.probe.snapshot().unavailable).toBeNull();
    expect(h.probe.snapshot().ageMs).toBe(4_000);
    h.advance(17_000);
    await h.probe.refresh();
    expect(h.probe.snapshot()).toEqual({ devices: [], ageMs: null, unavailable: 'probe_failed' });
  });

  test('a reading that aged out with no failure reads as warming up again', async () => {
    const h = harness([ok()]);
    await h.probe.refresh();
    // Nobody refreshed for a while (no dashboard was open).
    h.advance(25_000);
    expect(h.probe.snapshot()).toEqual({ devices: [], ageMs: null, unavailable: 'warming_up' });
  });

  test('after three failures in a row the probe retries once a minute', async () => {
    const h = harness([FAILED, FAILED, FAILED, ok()]);
    for (let i = 0; i < 3; i++) {
      await h.probe.refresh();
      h.advance(4_000);
    }
    expect(h.calls()).toBe(3);
    await h.probe.refresh();
    h.advance(30_000);
    await h.probe.refresh();
    expect(h.calls()).toBe(3);
    h.advance(30_000);
    await h.probe.refresh();
    expect(h.calls()).toBe(4);
    expect(h.probe.snapshot().unavailable).toBeNull();
  });

  test('a command that lists no device is "no devices", not a failure', async () => {
    const h = harness([ok('')]);
    await h.probe.refresh();
    expect(h.probe.snapshot().unavailable).toBe('no_devices');
  });

  test('a slow probe does not start a second one', async () => {
    let release: (result: GpuCommandResult) => void = () => undefined;
    let calls = 0;
    const probe = new GpuProbe({
      run: () => {
        calls += 1;
        return new Promise<GpuCommandResult>((resolve) => { release = resolve; });
      },
      nowMs: () => 0,
    });
    const first = probe.refresh();
    const second = probe.refresh();
    expect(calls).toBe(1);
    // The caller's timer is never blocked: the snapshot is readable while the probe hangs.
    expect(probe.snapshot().unavailable).toBe('warming_up');
    release(ok());
    await Promise.all([first, second]);
    expect(probe.snapshot().unavailable).toBeNull();
  });

  test('a runner that throws is treated as a failed probe', async () => {
    const probe = new GpuProbe({
      run: async () => { throw new Error('spawn EACCES'); },
      nowMs: () => 0,
    });
    await probe.refresh();
    expect(probe.snapshot().unavailable).toBe('probe_failed');
  });
});
