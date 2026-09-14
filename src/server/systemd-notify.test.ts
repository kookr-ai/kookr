import { execFile } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSystemdNotifierHealthBlock,
  createSystemdNotifier,
  SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION,
} from './systemd-notify.js';

// No test may invoke the host's notification helper or service manager.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('notification helper completion health', () => {
  function setup() {
    let wallTime = 1_000;
    const completions: Array<(error: unknown) => void> = [];
    vi.mocked(execFile).mockImplementation((_file, _args, callback) => {
      completions.push(callback as (error: unknown) => void);
      return {} as ReturnType<typeof execFile>;
    });
    const logger = vi.fn();
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: '/test/notify', WATCHDOG_USEC: '30000000' },
      now: () => 0,
      wallNow: () => wallTime,
      logger,
    });
    return { notifier, completions, logger, setWallTime: (time: number) => { wallTime = time; } };
  }

  it('distinguishes no attempt from a helper still running, without doing I/O on health reads', () => {
    const { notifier } = setup();
    expect(buildSystemdNotifierHealthBlock(notifier).sendHealth).toEqual({
      status: 'not-attempted', attempts: 0, failures: 0,
      lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
    });
    expect(execFile).not.toHaveBeenCalled();
    notifier.watchdog();
    const pending = buildSystemdNotifierHealthBlock(notifier);
    expect(pending.sendHealth).toMatchObject({ status: 'pending', attempts: 1, lastAttemptAt: 1_000, lastSuccessAt: null });
    notifier.watchdog(); // Throttled calls and health reads do not send again.
    expect(buildSystemdNotifierHealthBlock(notifier)).toEqual(pending);
    expect(execFile).toHaveBeenCalledExactlyOnceWith('systemd-notify', ['WATCHDOG=1'], expect.any(Function));
  });

  it.each([
    ['ENOENT', 'helper-missing'],
    [1, 'helper-exit'],
    ['EACCES', 'send-error'],
  ])('records %s failures without exposing raw helper errors', (code, category) => {
    const { notifier, completions, logger, setWallTime } = setup();
    notifier.watchdog();
    setWallTime(2_000);
    completions[0](Object.assign(new Error('private helper stderr and environment'), { code }));
    const health = buildSystemdNotifierHealthBlock(notifier);
    expect(health.sendHealth).toEqual({
      status: 'failed', attempts: 1, failures: 1,
      lastAttemptAt: 1_000, lastSuccessAt: null, lastFailureAt: 2_000, lastError: category,
    });
    expect(health.arming).toBe('watchdog-armed');
    expect(health.externalUnitStatus).toBe('unknown');
    expect(JSON.stringify(health)).not.toContain('private');
    expect(logger).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(category));
    expect(JSON.stringify(logger.mock.calls)).not.toContain('private');
  });

  it('clears the current error on recovery while retaining failure history and old snapshots', () => {
    const { notifier, completions, setWallTime } = setup();
    notifier.ready();
    completions[0]({ code: 1 });
    const failed = buildSystemdNotifierHealthBlock(notifier);
    setWallTime(2_000);
    notifier.watchdog();
    expect(buildSystemdNotifierHealthBlock(notifier).sendHealth?.status).toBe('failed');
    setWallTime(3_000);
    completions[1](null);
    expect(buildSystemdNotifierHealthBlock(notifier).sendHealth).toEqual({
      status: 'succeeded', attempts: 2, failures: 1,
      lastAttemptAt: 2_000, lastSuccessAt: 3_000, lastFailureAt: 1_000, lastError: null,
    });
    expect(failed.sendHealth?.status).toBe('failed');
    expect(buildSystemdNotifierHealthBlock(notifier).externalUnitStatus).toBe('unknown');
  });

  it('uses completion order for overlapping sends and counts each attempt only once', () => {
    const { notifier, completions } = setup();
    notifier.ready();
    notifier.watchdog();
    completions[1](null);
    completions[0]({ signal: 'SIGTERM' });
    completions[0](null);
    expect(buildSystemdNotifierHealthBlock(notifier).sendHealth).toMatchObject({
      status: 'failed', attempts: 2, failures: 1, lastSuccessAt: 1_000, lastError: 'helper-signal',
    });
  });

  it('records synchronous sender throws and does not mistake a void return for success', () => {
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: '/test/notify' },
      send: () => { throw new Error('private'); },
      logger: vi.fn(),
    });
    expect(() => notifier.ready()).not.toThrow();
    expect(buildSystemdNotifierHealthBlock(notifier).sendHealth).toMatchObject({
      status: 'failed', attempts: 1, failures: 1, lastError: 'send-error',
    });
    const pending = createSystemdNotifier({ env: { NOTIFY_SOCKET: '/test/notify' }, send: () => {} });
    pending.ready();
    expect(buildSystemdNotifierHealthBlock(pending).sendHealth?.status).toBe('pending');
  });
});

/**
 * Unit coverage for the sd_notify(3) helper (issue #2491). Every case injects a
 * fake sender and clock — no test talks to a live systemd — and asserts the
 * exact notify payloads and the arming/throttling rules.
 */
describe('createSystemdNotifier', () => {
  function makeSender() {
    const payloads: string[] = [];
    return { send: (p: string) => payloads.push(p), payloads };
  }

  describe('when NOTIFY_SOCKET is unset (behaves exactly as today)', () => {
    it('is disabled and every method is a no-op', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({ env: {}, send });

      notifier.ready();
      notifier.watchdog();

      expect(notifier.enabled).toBe(false);
      expect(notifier.watchdogEnabled).toBe(false);
      expect(notifier.watchdogIntervalMs).toBe(0);
      expect(payloads).toEqual([]);
    });

    it('sends nothing even when WATCHDOG_USEC is present', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { WATCHDOG_USEC: '30000000' },
        send,
      });

      notifier.ready();
      notifier.watchdog();

      expect(notifier.watchdogEnabled).toBe(false);
      expect(payloads).toEqual([]);
    });
  });

  describe('ready()', () => {
    it('sends READY=1 exactly once per call when enabled', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify' },
        send,
      });

      notifier.ready();
      notifier.ready();

      expect(notifier.enabled).toBe(true);
      expect(payloads).toEqual(['READY=1', 'READY=1']);
    });

    it('works even when the watchdog is not armed', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify' },
        send,
      });

      notifier.ready();
      notifier.watchdog();

      expect(notifier.watchdogEnabled).toBe(false);
      expect(payloads).toEqual(['READY=1']);
    });
  });

  describe('watchdog() arming', () => {
    it('arms on NOTIFY_SOCKET + a positive WATCHDOG_USEC and computes half the deadline', () => {
      const { send } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
        send,
      });

      expect(notifier.watchdogEnabled).toBe(true);
      // 30_000_000 µs = 30_000 ms; ping at half → 15_000 ms.
      expect(notifier.watchdogIntervalMs).toBe(15_000);
    });

    it('sends WATCHDOG=1 on the first tick', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
        send,
        now: () => 0,
      });

      notifier.watchdog();

      expect(payloads).toEqual(['WATCHDOG=1']);
    });

    it('stays disarmed when WATCHDOG_USEC is absent, zero, or non-numeric', () => {
      for (const usec of [undefined, '0', 'abc', '-1', '', '12x']) {
        const { send, payloads } = makeSender();
        const notifier = createSystemdNotifier({
          env: { NOTIFY_SOCKET: '/run/systemd/notify', ...(usec === undefined ? {} : { WATCHDOG_USEC: usec }) },
          send,
        });
        notifier.watchdog();
        expect(notifier.watchdogEnabled, `usec=${JSON.stringify(usec)}`).toBe(false);
        expect(payloads).toEqual([]);
      }
    });

    it('honors WATCHDOG_PID: armed when it matches our pid', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000', WATCHDOG_PID: '4242' },
        pid: 4242,
        send,
        now: () => 0,
      });

      notifier.watchdog();

      expect(notifier.watchdogEnabled).toBe(true);
      expect(payloads).toEqual(['WATCHDOG=1']);
    });

    it('disarms when WATCHDOG_PID belongs to another process', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000', WATCHDOG_PID: '4242' },
        pid: 9999,
        send,
      });

      notifier.watchdog();

      expect(notifier.watchdogEnabled).toBe(false);
      expect(payloads).toEqual([]);
    });

    it('disarms when WATCHDOG_PID is present but non-numeric', () => {
      const { send, payloads } = makeSender();
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000', WATCHDOG_PID: 'abc' },
        pid: 4242,
        send,
      });

      notifier.watchdog();

      expect(notifier.watchdogEnabled).toBe(false);
      expect(payloads).toEqual([]);
    });
  });

  describe('watchdog() throttling', () => {
    it('drops pings inside the interval and resumes once it elapses', () => {
      const { send, payloads } = makeSender();
      let clock = 1_000;
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
        send,
        now: () => clock,
      });
      // Interval is 15_000 ms.

      notifier.watchdog(); // t=1000 → send
      clock = 5_000;
      notifier.watchdog(); // +4s → throttled
      clock = 15_999;
      notifier.watchdog(); // +14.999s → still throttled
      clock = 16_000;
      notifier.watchdog(); // +15s exactly → send
      clock = 16_500;
      notifier.watchdog(); // throttled again

      expect(payloads).toEqual(['WATCHDOG=1', 'WATCHDOG=1']);
    });
  });

  describe('failure isolation', () => {
    it('never throws when the sender throws, and logs instead', () => {
      const logs: string[] = [];
      const notifier = createSystemdNotifier({
        env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
        send: () => {
          throw new Error('boom');
        },
        now: () => 0,
        logger: (msg) => logs.push(msg),
      });

      expect(() => notifier.ready()).not.toThrow();
      expect(() => notifier.watchdog()).not.toThrow();
      expect(logs.length).toBe(2);
      expect(logs.every((l) => l.includes('send-error'))).toBe(true);
    });
  });

  describe('default sender', () => {
    it('a disabled notifier never spawns a subprocess and never warns', () => {
      // With no `send` override the default sender is the `systemd-notify`
      // subprocess. NOTIFY_SOCKET is unset here, so `enabled` is false and both
      // methods short-circuit before ever reaching the spawn — the point of this
      // test is that the default-sender path stays completely inert (no spawn, no
      // warn) when the notifier is disabled. The live spawn is intentionally not
      // exercised: no unit test should talk to a real systemd-notify/systemd.
      const notifier = createSystemdNotifier({ env: {} });
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => notifier.ready()).not.toThrow();
      expect(() => notifier.watchdog()).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

/**
 * Health/ops-digest projection (issue #2853). The block reports only the
 * notifier's cheap in-memory arming state and must never claim the external
 * unit is active or that restart is guaranteed.
 */
describe('buildSystemdNotifierHealthBlock', () => {
  it('reports "absent" when NOTIFY_SOCKET was unset', () => {
    const notifier = createSystemdNotifier({ env: {}, send: () => {} });

    const block = buildSystemdNotifierHealthBlock(notifier);

    expect(block).toEqual({
      schemaVersion: SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION,
      arming: 'absent',
      notificationEnabled: false,
      watchdogArmed: false,
      watchdogIntervalMs: 0,
      externalUnitStatus: 'unknown',
      sendHealth: {
        status: 'not-attempted', attempts: 0, failures: 0,
        lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
      },
    });
  });

  it('reports "notifier-only" when notification is enabled but the watchdog is not armed', () => {
    // NOTIFY_SOCKET present, no WATCHDOG_USEC ⇒ readiness armed, watchdog not.
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: '/run/systemd/notify' },
      send: () => {},
    });

    const block = buildSystemdNotifierHealthBlock(notifier);

    expect(block.arming).toBe('notifier-only');
    expect(block.notificationEnabled).toBe(true);
    expect(block.watchdogArmed).toBe(false);
    expect(block.watchdogIntervalMs).toBe(0);
    expect(block.externalUnitStatus).toBe('unknown');
  });

  it('reports "watchdog-armed" with the half-deadline heartbeat interval', () => {
    const notifier = createSystemdNotifier({
      env: { NOTIFY_SOCKET: '/run/systemd/notify', WATCHDOG_USEC: '30000000' },
      send: () => {},
    });

    const block = buildSystemdNotifierHealthBlock(notifier);

    expect(block.arming).toBe('watchdog-armed');
    expect(block.notificationEnabled).toBe(true);
    expect(block.watchdogArmed).toBe(true);
    // WATCHDOG_USEC / 1000 / 2 → 15s.
    expect(block.watchdogIntervalMs).toBe(15_000);
    expect(block.externalUnitStatus).toBe('unknown');
  });

  it('never advertises a heartbeat cadence when the watchdog is not armed', () => {
    // A hostile/odd input where an interval is present without arming must still
    // report 0 so the block never implies pings are flowing.
    const block = buildSystemdNotifierHealthBlock({
      enabled: true,
      watchdogEnabled: false,
      watchdogIntervalMs: 15_000,
      sendHealth: createSystemdNotifier({ env: {} }).sendHealth,
    });

    expect(block.arming).toBe('notifier-only');
    expect(block.watchdogIntervalMs).toBe(0);
  });
});
