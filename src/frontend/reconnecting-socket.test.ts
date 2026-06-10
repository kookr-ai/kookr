import { describe, expect, it } from 'vitest';
import {
  computeReconnectDelayMs,
  createReconnectingSocket,
  DEFAULT_BACKOFF,
  type CloseEventLike,
  type MessageEventLike,
  type ReconnectingSocketOptions,
} from './reconnecting-socket.js';

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;

  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEventLike) => void) | null = null;
  onclose: ((event?: CloseEventLike) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emitMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  emitClose(event?: CloseEventLike): void {
    this.readyState = 3;
    this.onclose?.(event);
  }
}

interface ScheduledTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
  ran?: boolean;
}

function createHarness(overrides: Partial<ReconnectingSocketOptions<FakeSocket>> = {}) {
  const sockets: FakeSocket[] = [];
  const timers: ScheduledTimer[] = [];
  const events: string[] = [];

  const controller = createReconnectingSocket<FakeSocket>({
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onEstablished: () => events.push('established'),
    onLost: () => events.push('lost'),
    setTimeoutFn: (fn, ms) => {
      const timer: ScheduledTimer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (handle) => {
      (handle as ScheduledTimer).cleared = true;
    },
    random: () => 0.5, // zero jitter — deterministic delays
    ...overrides,
  });

  function runPendingTimers(): void {
    const pending = timers.filter((t) => !t.cleared && !t.ran);
    for (const timer of pending) {
      timer.ran = true;
      timer.fn();
    }
  }

  return { controller, sockets, timers, events, runPendingTimers };
}

describe('computeReconnectDelayMs', () => {
  it('grows exponentially and caps at maxDelayMs', () => {
    const noJitter = () => 0.5;
    expect(computeReconnectDelayMs(0, DEFAULT_BACKOFF, noJitter)).toBe(1_000);
    expect(computeReconnectDelayMs(1, DEFAULT_BACKOFF, noJitter)).toBe(2_000);
    expect(computeReconnectDelayMs(2, DEFAULT_BACKOFF, noJitter)).toBe(4_000);
    expect(computeReconnectDelayMs(10, DEFAULT_BACKOFF, noJitter)).toBe(15_000);
  });

  it('keeps jitter within the configured ratio', () => {
    const low = computeReconnectDelayMs(0, DEFAULT_BACKOFF, () => 0);
    const high = computeReconnectDelayMs(0, DEFAULT_BACKOFF, () => 1);
    expect(low).toBe(800);
    expect(high).toBe(1_200);
  });

  it('never exceeds maxDelayMs even with maximum positive jitter', () => {
    expect(computeReconnectDelayMs(10, DEFAULT_BACKOFF, () => 1)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it('never returns a negative delay', () => {
    expect(
      computeReconnectDelayMs(0, { initialDelayMs: 10, maxDelayMs: 10, multiplier: 2, jitterRatio: 1 }, () => 0),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('createReconnectingSocket', () => {
  it("establishes on open in 'open' mode", () => {
    const { controller, sockets, events } = createHarness();
    controller.start();
    expect(sockets).toHaveLength(1);
    sockets[0].emitOpen();
    expect(events).toEqual(['established']);
    expect(controller.isEstablished()).toBe(true);
  });

  it("in 'first-message' mode, open alone does not establish — only server data does", () => {
    const { controller, sockets, events } = createHarness({ establishOn: 'first-message' });
    controller.start();
    sockets[0].emitOpen();
    expect(events).toEqual([]);
    expect(controller.isEstablished()).toBe(false);
    sockets[0].emitMessage('{"type":"snapshot"}');
    expect(events).toEqual(['established']);
    expect(controller.isEstablished()).toBe(true);
  });

  it("an upgrade accepted then dropped before any message never flaps established state ('first-message')", () => {
    // The dev-proxy / restarting-server flap: every retry opens then dies.
    const { controller, sockets, events, runPendingTimers } = createHarness({ establishOn: 'first-message' });
    controller.start();
    for (let i = 0; i < 3; i++) {
      sockets[i].emitOpen();
      sockets[i].emitClose({ code: 1006 });
      runPendingTimers();
    }
    expect(events).toEqual([]); // no established/lost churn → no UI flicker
    expect(controller.failedAttempts()).toBe(3);
  });

  it('schedules retries with growing backoff and resets once the server delivers data', () => {
    const { controller, sockets, timers, runPendingTimers } = createHarness();
    controller.start();
    sockets[0].emitClose(); // failed attempt 1
    runPendingTimers();
    sockets[1].emitClose(); // failed attempt 2
    runPendingTimers();
    expect(timers.map((t) => t.ms)).toEqual([1_000, 2_000]);

    sockets[2].emitOpen();
    sockets[2].emitMessage('data'); // server actually serving — counter resets
    expect(controller.failedAttempts()).toBe(0);
    sockets[2].emitClose();
    runPendingTimers();
    expect(timers[2].ms).toBe(1_000);
  });

  it("a bare open without data does NOT reset backoff ('open' mode accept-then-drop loop)", () => {
    // Regression guard: a server mid-restart (or a session-gone bridge) can
    // accept the upgrade and close immediately. If open reset the counter,
    // backoff would stay pinned at its minimum and hammer the server forever.
    const { controller, sockets, timers, runPendingTimers } = createHarness();
    controller.start();
    for (let i = 0; i < 3; i++) {
      const socket = sockets[sockets.length - 1];
      socket.emitOpen();
      socket.emitClose({ code: 1006 });
      runPendingTimers();
    }
    expect(controller.failedAttempts()).toBe(3);
    expect(timers.map((t) => t.ms)).toEqual([1_000, 2_000, 4_000]);
  });

  it('ignores close events from sockets that were replaced (no rival reconnect chain, no lost report)', () => {
    const { controller, sockets, timers, events, runPendingTimers } = createHarness();
    controller.start();
    sockets[0].emitClose(); // attempt fails → schedule retry
    runPendingTimers();
    sockets[1].emitOpen();
    expect(events).toEqual(['established']);

    const timerCount = timers.length;
    sockets[0].emitClose(); // zombie fires again — must be inert
    expect(events).toEqual(['established']);
    expect(controller.isEstablished()).toBe(true);
    expect(timers).toHaveLength(timerCount);
  });

  it('stop() closes the socket without scheduling a reconnect, and its close is treated as stale', () => {
    const { controller, sockets, timers, events } = createHarness();
    controller.start();
    sockets[0].emitOpen();
    controller.stop();
    expect(sockets[0].closeCalls).toBe(1);
    sockets[0].emitClose(); // browser delivers close after .close()
    expect(timers).toHaveLength(0);
    expect(events).toEqual(['established']); // no 'lost' from a deliberate stop
  });

  it('stop() cancels a pending retry timer', () => {
    const { controller, sockets, timers } = createHarness();
    controller.start();
    sockets[0].emitClose();
    expect(timers).toHaveLength(1);
    controller.stop();
    expect(timers[0].cleared).toBe(true);
  });

  it('honors shouldReconnect=false (e.g. clean PTY exit) and still reports the close', () => {
    const closes: Array<{ code?: number; wasEstablished: boolean }> = [];
    const { controller, sockets, timers } = createHarness({
      shouldReconnect: (event) => event.code !== 1000,
      onClose: (event, info) => closes.push({ code: event.code, wasEstablished: info.wasEstablished }),
    });
    controller.start();
    sockets[0].emitOpen();
    sockets[0].emitClose({ code: 1000 });
    expect(timers).toHaveLength(0);
    expect(closes).toEqual([{ code: 1000, wasEstablished: true }]);
  });

  it('reports lost exactly once per established connection', () => {
    const { controller, sockets, events, runPendingTimers } = createHarness();
    controller.start();
    sockets[0].emitOpen();
    sockets[0].emitClose({ code: 1006 });
    runPendingTimers();
    sockets[1].emitClose(); // retry failed — was never established
    expect(events).toEqual(['established', 'lost']);
  });

  it('send() delivers only on an open current socket', () => {
    const { controller, sockets } = createHarness();
    expect(controller.send('early')).toBe(false); // not started
    controller.start();
    expect(controller.send('connecting')).toBe(false);
    sockets[0].emitOpen();
    expect(controller.send('hello')).toBe(true);
    expect(sockets[0].sent).toEqual(['hello']);
    controller.stop();
    expect(controller.send('after-stop')).toBe(false);
  });

  it('onerror forces the current socket closed so close handling owns the retry', () => {
    const { controller, sockets, timers } = createHarness();
    controller.start();
    sockets[0].onerror?.();
    expect(sockets[0].closeCalls).toBe(1);
    sockets[0].emitClose(); // browser delivers close after .close()
    expect(timers).toHaveLength(1); // retry scheduled by the close handler
  });

  it('a throwing socket factory schedules a retry instead of crashing', () => {
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const timers: ScheduledTimer[] = [];
    const controller = createReconnectingSocket<FakeSocket>({
      createSocket: () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: (fn, ms) => {
        const timer: ScheduledTimer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeoutFn: (handle) => {
        (handle as ScheduledTimer).cleared = true;
      },
      random: () => 0.5,
    });
    controller.start();
    expect(timers).toHaveLength(1);
    timers[0].fn();
    expect(sockets).toHaveLength(1);
  });

  it('start() is idempotent while running', () => {
    const { controller, sockets } = createHarness();
    controller.start();
    controller.start();
    expect(sockets).toHaveLength(1);
  });
});
