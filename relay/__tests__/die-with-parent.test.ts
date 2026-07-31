import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DIE_WITH_PARENT_INTERVAL_MS,
  installDieWithParentWatchdog,
  readDieWithParentConfig,
  readLivePpid,
} from '../die-with-parent.js';

describe('readLivePpid', () => {
  it.skipIf(process.platform !== 'linux')('reads the live parent pid from /proc on Linux', () => {
    // At process start nothing has reparented, so the live /proc read must
    // agree with Node's (start-time-cached) process.ppid.
    expect(readLivePpid()).toBe(process.ppid);
  });

  it('returns a positive integer on any platform', () => {
    expect(Number.isInteger(readLivePpid())).toBe(true);
    expect(readLivePpid()).toBeGreaterThan(0);
  });
});

describe('readDieWithParentConfig', () => {
  it('is disabled by default', () => {
    expect(readDieWithParentConfig({})).toEqual({
      enabled: false,
      intervalMs: DEFAULT_DIE_WITH_PARENT_INTERVAL_MS,
    });
  });

  it('enables on "1" and "true"', () => {
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT: '1' }).enabled).toBe(true);
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT: 'true' }).enabled).toBe(true);
  });

  it('does not enable on other values', () => {
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT: '0' }).enabled).toBe(false);
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT: 'yes' }).enabled).toBe(false);
  });

  it('reads an explicit parent pid from KOOKR_RELAY_PARENT_PID', () => {
    expect(readDieWithParentConfig({ KOOKR_RELAY_PARENT_PID: '4242' }).expectedPpid).toBe(4242);
    // init / invalid values are ignored (there is no meaningful parent to watch).
    expect(readDieWithParentConfig({ KOOKR_RELAY_PARENT_PID: '1' }).expectedPpid).toBeUndefined();
    expect(readDieWithParentConfig({ KOOKR_RELAY_PARENT_PID: '0' }).expectedPpid).toBeUndefined();
    expect(readDieWithParentConfig({ KOOKR_RELAY_PARENT_PID: 'nope' }).expectedPpid).toBeUndefined();
    expect(readDieWithParentConfig({}).expectedPpid).toBeUndefined();
  });

  it('parses a positive custom interval and ignores garbage', () => {
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS: '250' }).intervalMs).toBe(250);
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS: '0' }).intervalMs).toBe(
      DEFAULT_DIE_WITH_PARENT_INTERVAL_MS,
    );
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS: '-5' }).intervalMs).toBe(
      DEFAULT_DIE_WITH_PARENT_INTERVAL_MS,
    );
    expect(readDieWithParentConfig({ KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS: 'abc' }).intervalMs).toBe(
      DEFAULT_DIE_WITH_PARENT_INTERVAL_MS,
    );
  });
});

describe('installDieWithParentWatchdog', () => {
  function fakeTimers() {
    const scheduled: Array<{ fn: () => void; handle: { unref(): void } }> = [];
    const setIntervalFn = ((fn: () => void) => {
      const handle = { unref: () => {} };
      scheduled.push({ fn, handle });
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as unknown as (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    const clearIntervalFn = vi.fn();
    return { scheduled, setIntervalFn, clearIntervalFn };
  }

  it('fires onParentExit once when ppid changes, then stops', () => {
    const { scheduled, setIntervalFn, clearIntervalFn } = fakeTimers();
    let ppid = 4242;
    const onParentExit = vi.fn();

    const handle = installDieWithParentWatchdog({
      getPpid: () => ppid,
      onParentExit,
      setIntervalFn,
      clearIntervalFn,
    });

    expect(handle.initialPpid).toBe(4242);
    // Parent still alive: ticking does nothing.
    expect(handle.check()).toBe(false);
    expect(onParentExit).not.toHaveBeenCalled();

    // Parent dies → reparented to init.
    ppid = 1;
    expect(handle.check()).toBe(true);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    expect(onParentExit).toHaveBeenCalledWith({ initialPpid: 4242, currentPpid: 1 });
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);

    // Idempotent: further ticks never re-fire.
    ppid = 99;
    expect(handle.check()).toBe(true);
    expect(onParentExit).toHaveBeenCalledTimes(1);
    // The scheduled interval callback is safe to call after tripping.
    expect(scheduled).toHaveLength(1);
    scheduled[0]!.fn();
    expect(onParentExit).toHaveBeenCalledTimes(1);
  });

  it('trips on a reparent to a subreaper (ppid changes but is not 1)', () => {
    const { setIntervalFn, clearIntervalFn } = fakeTimers();
    let ppid = 500;
    const onParentExit = vi.fn();
    const handle = installDieWithParentWatchdog({
      getPpid: () => ppid,
      onParentExit,
      setIntervalFn,
      clearIntervalFn,
    });
    ppid = 987; // reparented to a subreaper, not init
    expect(handle.check()).toBe(true);
    expect(onParentExit).toHaveBeenCalledWith({ initialPpid: 500, currentPpid: 987 });
  });

  it('uses an explicit expectedPpid and trips when the live ppid diverges from it', () => {
    const { setIntervalFn, clearIntervalFn } = fakeTimers();
    // The declared parent is 700; the live ppid is already 3184 (parent died
    // during startup) — the watchdog must trip immediately on the first check.
    let live = 3184;
    const onParentExit = vi.fn();
    const handle = installDieWithParentWatchdog({
      expectedPpid: 700,
      getPpid: () => live,
      onParentExit,
      setIntervalFn,
      clearIntervalFn,
    });
    expect(handle.initialPpid).toBe(700);
    expect(handle.check()).toBe(true);
    expect(onParentExit).toHaveBeenCalledWith({ initialPpid: 700, currentPpid: 3184 });

    // And it does NOT trip while the live ppid still matches the declared parent.
    const second = fakeTimers();
    live = 700;
    const onParentExit2 = vi.fn();
    const handle2 = installDieWithParentWatchdog({
      expectedPpid: 700,
      getPpid: () => live,
      onParentExit: onParentExit2,
      setIntervalFn: second.setIntervalFn,
      clearIntervalFn: second.clearIntervalFn,
    });
    expect(handle2.check()).toBe(false);
    expect(onParentExit2).not.toHaveBeenCalled();
  });

  it('never trips and never schedules when the initial ppid is already init (1)', () => {
    const { scheduled, setIntervalFn, clearIntervalFn } = fakeTimers();
    const onParentExit = vi.fn();
    const handle = installDieWithParentWatchdog({
      getPpid: () => 1,
      onParentExit,
      setIntervalFn,
      clearIntervalFn,
    });
    expect(scheduled).toHaveLength(0);
    expect(handle.check()).toBe(false);
    expect(onParentExit).not.toHaveBeenCalled();
  });

  it('stop() halts polling and prevents future trips', () => {
    const { setIntervalFn, clearIntervalFn } = fakeTimers();
    let ppid = 321;
    const onParentExit = vi.fn();
    const handle = installDieWithParentWatchdog({
      getPpid: () => ppid,
      onParentExit,
      setIntervalFn,
      clearIntervalFn,
    });
    handle.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    ppid = 1;
    expect(handle.check()).toBe(false);
    expect(onParentExit).not.toHaveBeenCalled();
  });
});
