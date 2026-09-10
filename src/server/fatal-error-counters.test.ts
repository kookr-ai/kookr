import { describe, test, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  MAX_FATAL_MESSAGE_LENGTH,
  getFatalErrorHealth,
  installProcessFatalHandlers,
  recordUncaughtException,
  recordUnhandledRejection,
  resetFatalErrorCounters,
} from './fatal-error-counters.js';

// Issue #3112: the process fatal handlers in start.ts log-and-continue but must
// also stamp observable counters so a daemon quietly absorbing rejections is
// visible on /api/health. These tests exercise the record functions and the
// installed handlers directly.
describe('fatal-error-counters (issue #3112)', () => {
  beforeEach(() => {
    resetFatalErrorCounters();
  });

  test('starts at a clean baseline', () => {
    expect(getFatalErrorHealth()).toEqual({
      unhandledRejectionTotal: 0,
      uncaughtExceptionTotal: 0,
      lastFatalError: null,
      lastFatalAt: null,
    });
  });

  test('recordUnhandledRejection increments its own counter and stamps last-error fields', () => {
    recordUnhandledRejection(new Error('leaked promise'), () => '2026-09-10T00:00:00.000Z');
    const snap = getFatalErrorHealth();
    expect(snap.unhandledRejectionTotal).toBe(1);
    expect(snap.uncaughtExceptionTotal).toBe(0);
    expect(snap.lastFatalError).toBe('leaked promise');
    expect(snap.lastFatalAt).toBe('2026-09-10T00:00:00.000Z');
  });

  test('recordUncaughtException increments its own counter and stamps last-error fields', () => {
    recordUncaughtException(new Error('boom'), () => '2026-09-10T01:00:00.000Z');
    const snap = getFatalErrorHealth();
    expect(snap.uncaughtExceptionTotal).toBe(1);
    expect(snap.unhandledRejectionTotal).toBe(0);
    expect(snap.lastFatalError).toBe('boom');
    expect(snap.lastFatalAt).toBe('2026-09-10T01:00:00.000Z');
  });

  test('counters are monotonic and last-error reflects the most recent event', () => {
    recordUnhandledRejection(new Error('first'), () => '2026-09-10T00:00:00.000Z');
    recordUnhandledRejection(new Error('second'), () => '2026-09-10T00:00:01.000Z');
    recordUncaughtException(new Error('third'), () => '2026-09-10T00:00:02.000Z');
    const snap = getFatalErrorHealth();
    expect(snap.unhandledRejectionTotal).toBe(2);
    expect(snap.uncaughtExceptionTotal).toBe(1);
    expect(snap.lastFatalError).toBe('third');
    expect(snap.lastFatalAt).toBe('2026-09-10T00:00:02.000Z');
  });

  test('stores the message string for a non-Error rejection reason (no object retained)', () => {
    recordUnhandledRejection('string rejection', () => '2026-09-10T00:00:00.000Z');
    expect(getFatalErrorHealth().lastFatalError).toBe('string rejection');
  });

  test('caps an oversized message so it cannot bloat the health payload', () => {
    const huge = 'x'.repeat(MAX_FATAL_MESSAGE_LENGTH + 1000);
    recordUncaughtException(new Error(huge), () => '2026-09-10T00:00:00.000Z');
    const { lastFatalError } = getFatalErrorHealth();
    // Capped to the limit plus a single ellipsis marker.
    expect(lastFatalError).toBe(`${'x'.repeat(MAX_FATAL_MESSAGE_LENGTH)}…`);
    expect(lastFatalError!.length).toBe(MAX_FATAL_MESSAGE_LENGTH + 1);
  });

  test('a message exactly at the cap is stored verbatim (no ellipsis)', () => {
    const exact = 'y'.repeat(MAX_FATAL_MESSAGE_LENGTH);
    recordUnhandledRejection(new Error(exact), () => '2026-09-10T00:00:00.000Z');
    expect(getFatalErrorHealth().lastFatalError).toBe(exact);
  });

  test('never throws on a hostile rejection reason whose coercion throws', () => {
    const hostile = {
      [Symbol.toPrimitive]() {
        throw new Error('nope');
      },
    };
    expect(() => recordUnhandledRejection(hostile, () => '2026-09-10T00:00:00.000Z')).not.toThrow();
    const snap = getFatalErrorHealth();
    expect(snap.unhandledRejectionTotal).toBe(1);
    expect(snap.lastFatalError).toBe('<unstringifiable fatal value>');
  });

  test('never throws when Error.message is not a string (it is writable at runtime)', () => {
    const err = new Error('placeholder');
    // message is typed string but writable — a caller can set it to anything.
    (err as unknown as { message: unknown }).message = null;
    expect(() => recordUncaughtException(err, () => '2026-09-10T00:00:00.000Z')).not.toThrow();
    const snap = getFatalErrorHealth();
    expect(snap.uncaughtExceptionTotal).toBe(1);
    // Coerced to a string so the later length check cannot throw.
    expect(typeof snap.lastFatalError).toBe('string');
    expect(snap.lastFatalError).toBe('null');
  });

  test('redacts credential shapes from the stored message (no secrets on health)', () => {
    const secretRe = /synthetic-secret-token|abcDEF123456ghij|hunter2|sk-live-0123456789abcdef|synthetic-private-key|synthetic secret phrase|SUPERSECRETPAYLOAD/;
    const cases: Array<[string, RegExp]> = [
      ['request failed Authorization: Bearer synthetic-secret-token', /Authorization: Bearer <redacted>/i],
      ['connecting with Bearer abcDEF123456ghij', /Bearer <redacted>/],
      ['db url postgres://user:hunter2@db.internal:5432/app', /postgres:\/\/<redacted>@db\.internal/],
      ['boom api_key=sk-live-0123456789abcdef trailing', /api_key=<redacted>/],
      // Quoted JSON key + value (round-2 reviewer case).
      ['request failed: {"api_key":"synthetic-private-key"}', /"api_key":<redacted>/],
      // Quoted value containing spaces (round-2 reviewer case).
      ['connection failed password="synthetic secret phrase"', /password=<redacted>/],
      // JWT with no nearby key.
      ['token rejected eyJhbGciOi.SUPERSECRETPAYLOAD.sig', /<redacted>/],
    ];
    for (const [input, expected] of cases) {
      resetFatalErrorCounters();
      recordUnhandledRejection(new Error(input), () => '2026-09-10T00:00:00.000Z');
      const msg = getFatalErrorHealth().lastFatalError!;
      expect(msg).toMatch(expected);
      expect(msg).not.toMatch(secretRe);
    }
  });

  test('leaves an ordinary message without credentials untouched', () => {
    recordUncaughtException(new Error('ECONNREFUSED connecting to 127.0.0.1:4800'), () => '2026-09-10T00:00:00.000Z');
    expect(getFatalErrorHealth().lastFatalError).toBe('ECONNREFUSED connecting to 127.0.0.1:4800');
  });

  test('the default clock stamps a real ISO-8601 timestamp when no clock is injected', () => {
    recordUncaughtException(new Error('boom'));
    const { lastFatalAt } = getFatalErrorHealth();
    expect(lastFatalAt).not.toBeNull();
    // Round-trips through Date ⇒ a valid ISO-8601 instant.
    expect(new Date(lastFatalAt!).toISOString()).toBe(lastFatalAt);
  });

  describe('installProcessFatalHandlers', () => {
    test('the installed handlers stamp counters while still logging (log-and-continue)', () => {
      const emitter = new EventEmitter();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let logCallCount: number;
      try {
        installProcessFatalHandlers(emitter);
        emitter.emit('uncaughtException', new Error('boom'), 'uncaughtException');
        emitter.emit('unhandledRejection', new Error('leaked promise'));
        // Capture before mockRestore() clears the call history.
        logCallCount = errSpy.mock.calls.length;
      } finally {
        errSpy.mockRestore();
      }
      const snap = getFatalErrorHealth();
      expect(snap.uncaughtExceptionTotal).toBe(1);
      expect(snap.unhandledRejectionTotal).toBe(1);
      expect(snap.lastFatalError).toBe('leaked promise');
      expect(snap.lastFatalAt).not.toBeNull();
      // Both events were also logged — the handlers keep logging, not just counting.
      expect(logCallCount).toBe(2);
    });

    test('an emitted fatal event does not re-raise out of the handler', () => {
      const emitter = new EventEmitter();
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        installProcessFatalHandlers(emitter);
        expect(() => emitter.emit('unhandledRejection', 'plain string reason')).not.toThrow();
      } finally {
        errSpy.mockRestore();
      }
      expect(getFatalErrorHealth().lastFatalError).toBe('plain string reason');
    });
  });
});
