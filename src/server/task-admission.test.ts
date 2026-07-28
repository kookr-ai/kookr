import { describe, expect, test } from 'vitest';
import {
  DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS,
  DEFAULT_ADMISSION_RETRY_AFTER_SECONDS,
  EVENT_LOOP_SATURATED_CODE,
  evaluateTaskAdmission,
  readAdmissionControlConfigFromEnv,
  type AdmissionControlConfig,
} from './task-admission.js';

const cfg = (over: Partial<AdmissionControlConfig> = {}): AdmissionControlConfig => ({
  eventLoopDelayThresholdMs: 1_000,
  retryAfterSeconds: 2,
  ...over,
});

describe('readAdmissionControlConfigFromEnv', () => {
  test('defaults are enabled but tuned not to fire in normal operation', () => {
    const config = readAdmissionControlConfigFromEnv({});
    expect(config.eventLoopDelayThresholdMs).toBe(DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS);
    expect(config.retryAfterSeconds).toBe(DEFAULT_ADMISSION_RETRY_AFTER_SECONDS);
    // The default threshold sits far above steady-state p95 (single-digit ms).
    expect(config.eventLoopDelayThresholdMs).toBeGreaterThanOrEqual(500);
  });

  test('parses explicit values', () => {
    const config = readAdmissionControlConfigFromEnv({
      KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: '250',
      KOOKR_ADMISSION_RETRY_AFTER_SECONDS: '5',
    });
    expect(config).toEqual({ eventLoopDelayThresholdMs: 250, retryAfterSeconds: 5 });
  });

  test('0 threshold disables the gate (opt-out convention)', () => {
    const config = readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: '0' });
    expect(config.eventLoopDelayThresholdMs).toBe(0);
  });

  test('negative / invalid / blank threshold falls back safely', () => {
    expect(readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: '-5' }).eventLoopDelayThresholdMs).toBe(0);
    expect(readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: 'NaN' }).eventLoopDelayThresholdMs).toBe(DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS);
    expect(readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: '' }).eventLoopDelayThresholdMs).toBe(DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS);
    expect(readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS: 'Infinity' }).eventLoopDelayThresholdMs).toBe(DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS);
  });

  test('non-positive / fractional / invalid retry-after falls back to the default', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', 'Infinity']) {
      expect(readAdmissionControlConfigFromEnv({ KOOKR_ADMISSION_RETRY_AFTER_SECONDS: bad }).retryAfterSeconds)
        .toBe(DEFAULT_ADMISSION_RETRY_AFTER_SECONDS);
    }
  });
});

describe('evaluateTaskAdmission — invariants (issue #1590 invariant gate)', () => {
  // INV1: at or above the threshold, admission is denied.
  test('INV1: p95 >= threshold denies with a saturation rejection', () => {
    const atThreshold = evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 1_000 }), eventLoopDelayP95Ms: 1_000 });
    expect(atThreshold.admit).toBe(false);
    const above = evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 1_000 }), eventLoopDelayP95Ms: 5_000 });
    expect(above.admit).toBe(false);
    if (!above.admit) {
      expect(above.rejection.code).toBe(EVENT_LOOP_SATURATED_CODE);
      expect(above.rejection.observedEventLoopDelayP95Ms).toBe(5_000);
      expect(above.rejection.thresholdMs).toBe(1_000);
      expect(above.rejection.retryAfterSeconds).toBe(2);
      // INV3: the cause is identifiable and distinct from the #1536 429 codes.
      expect(above.rejection.error).toMatch(/saturat/i);
      expect(above.rejection.code).not.toBe('pending_queue_full');
      expect(above.rejection.code).not.toBe('spawn_burst_limit');
    }
  });

  // INV2: below the threshold, admission passes through unchanged.
  test('INV2: p95 < threshold admits', () => {
    expect(evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 1_000 }), eventLoopDelayP95Ms: 999.9 }).admit).toBe(true);
    expect(evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 1_000 }), eventLoopDelayP95Ms: 0 }).admit).toBe(true);
  });

  // INV4: the gate fails OPEN whenever it is disabled or the signal is missing.
  test('INV4: disabled threshold (<=0) always admits regardless of lag', () => {
    for (const p95 of [0, 10, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 0 }), eventLoopDelayP95Ms: p95 }).admit).toBe(true);
    }
  });

  test('INV4: missing / non-finite signal fails open (admits) even above a live threshold', () => {
    for (const p95 of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(evaluateTaskAdmission({ config: cfg({ eventLoopDelayThresholdMs: 1 }), eventLoopDelayP95Ms: p95 }).admit).toBe(true);
    }
  });

  test('Retry-After is always a positive integer (header safety), even for fractional/small config', () => {
    const decision = evaluateTaskAdmission({
      config: cfg({ eventLoopDelayThresholdMs: 10, retryAfterSeconds: 0.4 }),
      eventLoopDelayP95Ms: 100,
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.rejection.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(decision.rejection.retryAfterSeconds)).toBe(true);
    }
  });

  // Property sweep: the decision boundary is exactly `p95 >= threshold` for any
  // enabled threshold + finite signal, and the function is pure/synchronous.
  test('property: admit iff p95 < threshold across a generated grid', () => {
    const thresholds = [1, 5, 50, 250, 1_000, 5_000];
    for (const threshold of thresholds) {
      for (let i = 0; i <= 40; i++) {
        const p95 = (threshold * i) / 20; // 0 … 2× threshold
        const decision = evaluateTaskAdmission({
          config: cfg({ eventLoopDelayThresholdMs: threshold }),
          eventLoopDelayP95Ms: p95,
        });
        expect(decision.admit, `threshold=${threshold} p95=${p95}`).toBe(p95 < threshold);
      }
    }
  });

  test('property: evaluateTaskAdmission never throws for arbitrary numeric inputs', () => {
    const values = [0, -1, 0.5, 1e9, -1e9, Number.MIN_VALUE, Number.MAX_VALUE, Number.NaN, Infinity, -Infinity];
    for (const threshold of values) {
      for (const p95 of [...values, null, undefined]) {
        expect(() =>
          evaluateTaskAdmission({
            config: { eventLoopDelayThresholdMs: threshold, retryAfterSeconds: 2 },
            eventLoopDelayP95Ms: p95 as number,
          }),
        ).not.toThrow();
      }
    }
  });
});
