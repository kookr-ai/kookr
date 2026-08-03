import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
  DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
} from './config.js';
import {
  DATA_DIRECTORY_DISK_CRITICAL_CODE,
  DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS,
  DEFAULT_ADMISSION_RETRY_AFTER_SECONDS,
  DataDirectoryDiskAdmissionTracker,
  EVENT_LOOP_SATURATED_CODE,
  evaluateDiskAdmission,
  evaluateTaskAdmission,
  readAdmissionControlConfigFromEnv,
  readDiskAdmissionConfigFromEnv,
  type AdmissionControlConfig,
  type DiskAdmissionConfig,
} from './task-admission.js';

const cfg = (over: Partial<AdmissionControlConfig> = {}): AdmissionControlConfig => ({
  eventLoopDelayThresholdMs: 1_000,
  retryAfterSeconds: 2,
  ...over,
});

const diskCfg = (over: Partial<DiskAdmissionConfig> = {}): DiskAdmissionConfig => ({
  freePercentThreshold: 5,
  freeBytesThreshold: 2 * 1024 * 1024 * 1024,
  sustainSamples: 3,
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

describe('readDiskAdmissionConfigFromEnv (issue #1992)', () => {
  test('defaults reuse operational-alert floors and sustain samples', () => {
    const config = readDiskAdmissionConfigFromEnv({});
    expect(config.freePercentThreshold).toBe(DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT);
    expect(config.freeBytesThreshold).toBe(DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES);
    expect(config.sustainSamples).toBe(DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES);
    expect(config.retryAfterSeconds).toBe(DEFAULT_ADMISSION_RETRY_AFTER_SECONDS);
  });

  test('reuses KOOKR_ALERT_DATA_DIR_* when admission overrides are absent', () => {
    const config = readDiskAdmissionConfigFromEnv({
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '4',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '1000',
      KOOKR_ALERT_SUSTAIN_SAMPLES: '5',
    });
    expect(config).toMatchObject({
      freePercentThreshold: 4,
      freeBytesThreshold: 1000,
      sustainSamples: 5,
    });
  });

  test('admission-specific overrides win over alert knobs', () => {
    const config = readDiskAdmissionConfigFromEnv({
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '4',
      KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT: '2',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '1000',
      KOOKR_ADMISSION_DATA_DIR_FREE_BYTES: '500',
      KOOKR_ALERT_SUSTAIN_SAMPLES: '5',
      KOOKR_ADMISSION_DATA_DIR_SUSTAIN_SAMPLES: '7',
      KOOKR_ADMISSION_RETRY_AFTER_SECONDS: '9',
    });
    expect(config).toEqual({
      freePercentThreshold: 2,
      freeBytesThreshold: 500,
      sustainSamples: 7,
      retryAfterSeconds: 9,
    });
  });

  test('both floors at 0 disable the gate', () => {
    const config = readDiskAdmissionConfigFromEnv({
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '0',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '0',
    });
    expect(config.freePercentThreshold).toBe(0);
    expect(config.freeBytesThreshold).toBe(0);
  });
});

describe('evaluateDiskAdmission (issue #1992)', () => {
  test('rejects when free percent is at or below the floor (single-sample fail-closed)', () => {
    const decision = evaluateDiskAdmission({
      config: diskCfg({ freeBytesThreshold: 0 }),
      sample: { diskFreePercent: 5, diskFreeBytes: 99_000_000_000, path: '/data' },
    });
    expect(decision.admit).toBe(false);
    if (!decision.admit) {
      expect(decision.rejection.code).toBe(DATA_DIRECTORY_DISK_CRITICAL_CODE);
      expect(decision.rejection.reason).toBe(DATA_DIRECTORY_DISK_CRITICAL_CODE);
      expect(decision.rejection.retryAfterSeconds).toBe(2);
      expect(decision.rejection.path).toBe('/data');
      expect(decision.rejection.error).toMatch(/critical/i);
    }
  });

  test('admits when free space is above both floors', () => {
    expect(
      evaluateDiskAdmission({
        config: diskCfg(),
        sample: { diskFreePercent: 50, diskFreeBytes: 50_000_000_000 },
      }).admit,
    ).toBe(true);
  });

  test('disabled floors always admit', () => {
    expect(
      evaluateDiskAdmission({
        config: diskCfg({ freePercentThreshold: 0, freeBytesThreshold: 0 }),
        sample: { diskFreePercent: 0, diskFreeBytes: 0 },
      }).admit,
    ).toBe(true);
  });

  test('missing sample fails open unless critical flag is forced', () => {
    expect(evaluateDiskAdmission({ config: diskCfg(), sample: null }).admit).toBe(true);
    expect(
      evaluateDiskAdmission({ config: diskCfg(), sample: null, critical: true }).admit,
    ).toBe(false);
  });

  test('honors precomputed critical flag from the sustain tracker', () => {
    const admitDespiteLow = evaluateDiskAdmission({
      config: diskCfg(),
      sample: { diskFreePercent: 1, diskFreeBytes: 100 },
      critical: false,
    });
    expect(admitDespiteLow.admit).toBe(true);
    const rejectDespiteHigh = evaluateDiskAdmission({
      config: diskCfg(),
      sample: { diskFreePercent: 50, diskFreeBytes: 50_000_000_000 },
      critical: true,
    });
    expect(rejectDespiteHigh.admit).toBe(false);
  });
});

describe('DataDirectoryDiskAdmissionTracker (issue #1992)', () => {
  test('requires sustainSamples consecutive breaches before isCritical', () => {
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({ sustainSamples: 3, freeBytesThreshold: 0 });
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'a' }, config);
    expect(tracker.isCritical()).toBe(false);
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'b' }, config);
    expect(tracker.isCritical()).toBe(false);
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'c' }, config);
    expect(tracker.isCritical()).toBe(true);
    expect(tracker.getState().consecutive).toBe(3);
  });

  test('dedupes the same sampledAt so concurrent POSTs do not double-count', () => {
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({ sustainSamples: 2, freeBytesThreshold: 0 });
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'same' }, config);
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'same' }, config);
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'same' }, config);
    expect(tracker.getState().consecutive).toBe(1);
    expect(tracker.isCritical()).toBe(false);
  });

  test('recovery clears critical once free space is above floors', () => {
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({ sustainSamples: 1, freeBytesThreshold: 0 });
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'low' }, config);
    expect(tracker.isCritical()).toBe(true);
    tracker.observe({ diskFreePercent: 50, diskFreeBytes: 0, sampledAt: 'ok' }, config);
    expect(tracker.isCritical()).toBe(false);
    expect(tracker.getState().consecutive).toBe(0);
  });

  test('missing readings preserve an already-critical state (no false recovery)', () => {
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({ sustainSamples: 1, freeBytesThreshold: 0 });
    tracker.observe({ diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'low' }, config);
    expect(tracker.isCritical()).toBe(true);
    tracker.observe({ diskFreePercent: null, diskFreeBytes: null, sampledAt: 'gap' }, config);
    expect(tracker.isCritical()).toBe(true);
  });

  test('disabled floors clear critical and stop counting', () => {
    const tracker = new DataDirectoryDiskAdmissionTracker();
    tracker.observe(
      { diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'low' },
      diskCfg({ sustainSamples: 1, freeBytesThreshold: 0 }),
    );
    expect(tracker.isCritical()).toBe(true);
    tracker.observe(
      { diskFreePercent: 1, diskFreeBytes: 0, sampledAt: 'off' },
      diskCfg({ freePercentThreshold: 0, freeBytesThreshold: 0, sustainSamples: 1 }),
    );
    expect(tracker.isCritical()).toBe(false);
  });
});
