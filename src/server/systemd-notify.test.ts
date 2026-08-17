import { describe, expect, it, vi } from 'vitest';

import { createSystemdNotifier } from './systemd-notify.js';

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
      expect(logs.every((l) => l.includes('boom'))).toBe(true);
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
