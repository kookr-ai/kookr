/**
 * Load-based admission control for `POST /api/tasks` (issue #1590, #1992).
 *
 * Depth-based backpressure (#1536) rejects when the *pending queue* is full,
 * but it only measures queue depth: a saturated event loop lets a spawn POST
 * hang into a client timeout regardless of queue state (batch dd1fbcec's
 * wave-2 spawns, lucy #1654). This module adds orthogonal, load-based gates
 * that fast-fail a spawn POST with `503 + Retry-After` *before* any work is
 * done, so a saturated server says "no" honestly in ≤2s instead of hanging.
 *
 * Signals reused from the resource sampler (no second monitors):
 * - Event-loop delay p95 (`SystemResourceStatus.server.eventLoopDelayP95Ms`)
 *   — issue #1590.
 * - Data-directory free space (`host.dataDirectory`) — issue #1992. Fail-closed
 *   once free falls at or below the operational-alert floors for the same
 *   sustain-sample window, so unattended recovery stops spawning before ENOSPC.
 */

import {
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
  DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
} from './config.js';
import { isDataDirectoryFreeCritical } from '../core/system-resource-metrics.js';

/** Response `code` on the load-based 503, distinct from the #1536 depth 429s. */
export const EVENT_LOOP_SATURATED_CODE = 'event_loop_saturated';

/** Response `code` / `reason` when data-directory free space is critically low (#1992). */
export const DATA_DIRECTORY_DISK_CRITICAL_CODE = 'data_directory_disk_critical';

/**
 * Default event-loop delay p95 threshold (ms) above which a spawn POST is
 * shed. Chosen to sit far above steady-state p95 (single-digit to low-tens of
 * ms even under normal load) so the gate does not fire in normal operation,
 * while still tripping well before a saturated loop stretches a POST past a
 * typical client timeout.
 */
export const DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS = 1_000;

/** Default `Retry-After` hint (seconds) advertised on the load-based 503. */
export const DEFAULT_ADMISSION_RETRY_AFTER_SECONDS = 2;

export interface AdmissionControlConfig {
  /**
   * Event-loop delay p95 threshold in milliseconds. A spawn POST is shed when
   * the latest sampled p95 is at or above this value. `0` disables the gate
   * (mirroring the `KOOKR_ALERT_*=0` opt-out convention).
   */
  eventLoopDelayThresholdMs: number;
  /** `Retry-After` hint in seconds sent on the load-based 503 (always >= 1). */
  retryAfterSeconds: number;
}

/**
 * Data-directory free-space admission floors (issue #1992). Defaults reuse the
 * operational-alert knobs (`KOOKR_ALERT_DATA_DIR_FREE_*`,
 * `KOOKR_ALERT_SUSTAIN_SAMPLES`) so one set of thresholds drives both alerting
 * and fail-closed launch shedding.
 */
export interface DiskAdmissionConfig {
  /**
   * Free-percent floor; free ≤ this is a breach. `0` disables the percent rule
   * (same opt-out as the ops alert).
   */
  freePercentThreshold: number;
  /**
   * Free-bytes floor; free ≤ this is a breach. `0` disables the bytes rule.
   */
  freeBytesThreshold: number;
  /**
   * Consecutive breaching resource-sampler ticks required before the gate
   * rejects launches. Reuses the ops-alert sustain window so a single noisy
   * sample cannot false-positive admission shut.
   */
  sustainSamples: number;
  /** `Retry-After` hint in seconds on the disk-critical 503 (always ≥ 1). */
  retryAfterSeconds: number;
}

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < 0 ? 0 : parsed;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

/**
 * Read admission-control thresholds from the environment. The threshold
 * defaults to {@link DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS} (enabled, but tuned
 * not to fire in normal operation); `0` disables the gate. The Retry-After hint
 * defaults to {@link DEFAULT_ADMISSION_RETRY_AFTER_SECONDS}. Invalid or blank
 * values fall back to the documented defaults.
 */
export function readAdmissionControlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdmissionControlConfig {
  return {
    eventLoopDelayThresholdMs: readNonNegativeNumber(
      env.KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS,
      DEFAULT_ADMISSION_EVENT_LOOP_DELAY_MS,
    ),
    retryAfterSeconds: readPositiveInt(
      env.KOOKR_ADMISSION_RETRY_AFTER_SECONDS,
      DEFAULT_ADMISSION_RETRY_AFTER_SECONDS,
    ),
  };
}

/**
 * Read data-directory disk admission floors from the environment (issue #1992).
 *
 * Reuses the operational-alert env knobs so operators tune one set of numbers:
 * - `KOOKR_ALERT_DATA_DIR_FREE_PERCENT` (default 5)
 * - `KOOKR_ALERT_DATA_DIR_FREE_BYTES` (default 2 GiB)
 * - `KOOKR_ALERT_SUSTAIN_SAMPLES` (default 3)
 *
 * Optional admission-specific overrides win when set:
 * - `KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT`
 * - `KOOKR_ADMISSION_DATA_DIR_FREE_BYTES`
 * - `KOOKR_ADMISSION_DATA_DIR_SUSTAIN_SAMPLES`
 *
 * Retry-After reuses `KOOKR_ADMISSION_RETRY_AFTER_SECONDS`. Both floors at `0`
 * disables the gate (opt-out).
 */
export function readDiskAdmissionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DiskAdmissionConfig {
  return {
    freePercentThreshold: readNonNegativeNumber(
      env.KOOKR_ADMISSION_DATA_DIR_FREE_PERCENT ?? env.KOOKR_ALERT_DATA_DIR_FREE_PERCENT,
      DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
    ),
    freeBytesThreshold: readNonNegativeNumber(
      env.KOOKR_ADMISSION_DATA_DIR_FREE_BYTES ?? env.KOOKR_ALERT_DATA_DIR_FREE_BYTES,
      DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
    ),
    sustainSamples: readPositiveInt(
      env.KOOKR_ADMISSION_DATA_DIR_SUSTAIN_SAMPLES ?? env.KOOKR_ALERT_SUSTAIN_SAMPLES,
      DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    ),
    retryAfterSeconds: readPositiveInt(
      env.KOOKR_ADMISSION_RETRY_AFTER_SECONDS,
      DEFAULT_ADMISSION_RETRY_AFTER_SECONDS,
    ),
  };
}

/** Shape of the load-based 503 body — carries the cause so a client can tell it apart from a 429. */
export interface EventLoopSaturationDetails {
  /** Human-readable cause (field order mirrors the sibling 429 bodies: `error` first, then `code`). */
  error: string;
  code: typeof EVENT_LOOP_SATURATED_CODE;
  /** Sampled event-loop delay p95 (ms) that tripped the gate. */
  observedEventLoopDelayP95Ms: number;
  /** Configured threshold (ms) that was met or exceeded. */
  thresholdMs: number;
  /** Retry-After hint (seconds) also sent as the header. */
  retryAfterSeconds: number;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; rejection: EventLoopSaturationDetails };

/**
 * Decide whether a spawn POST may proceed given the latest sampled event-loop
 * delay p95. Pure and synchronous — never awaits I/O — so it adds no latency of
 * its own and can be exercised exhaustively.
 *
 * Fails OPEN (admits) whenever the gate is disabled (`threshold <= 0`) or the
 * saturation signal is unavailable (`null`/non-finite — e.g. before the first
 * sample, or when the sampler reports `event_loop_unavailable`). Admission must
 * never turn a missing metric into a spurious rejection.
 */
export function evaluateTaskAdmission(input: {
  config: AdmissionControlConfig;
  eventLoopDelayP95Ms: number | null | undefined;
}): AdmissionDecision {
  const { config, eventLoopDelayP95Ms } = input;
  const threshold = config.eventLoopDelayThresholdMs;
  if (!(threshold > 0)) return { admit: true };
  if (eventLoopDelayP95Ms == null || !Number.isFinite(eventLoopDelayP95Ms)) {
    return { admit: true };
  }
  if (eventLoopDelayP95Ms < threshold) return { admit: true };

  const retryAfterSeconds = Math.max(1, Math.floor(config.retryAfterSeconds));
  return {
    admit: false,
    rejection: {
      error:
        `Server saturated: event-loop delay p95 ${eventLoopDelayP95Ms.toFixed(1)}ms ` +
        `>= threshold ${threshold}ms. Retry after ${retryAfterSeconds}s. ` +
        `(Distinct from the #1536 pending-queue 429: the queue may be fine — the ` +
        `event loop is overloaded.)`,
      code: EVENT_LOOP_SATURATED_CODE,
      observedEventLoopDelayP95Ms: eventLoopDelayP95Ms,
      thresholdMs: threshold,
      retryAfterSeconds,
    },
  };
}

/** Latest data-directory free-space reading used by disk admission (#1992). */
export interface DataDirectoryDiskSample {
  diskFreePercent: number | null | undefined;
  diskFreeBytes: number | null | undefined;
  path?: string | null;
  /** Resource-status `sampledAt` — used to dedupe multi-observe of the same tick. */
  sampledAt?: string | null;
}

/** Structured body for the disk-critical launch 503 (issue #1992). */
export interface DiskCriticalDetails {
  error: string;
  code: typeof DATA_DIRECTORY_DISK_CRITICAL_CODE;
  /** Stable machine-readable reason (mirrors drain's `reason` field). */
  reason: typeof DATA_DIRECTORY_DISK_CRITICAL_CODE;
  diskFreePercent: number | null;
  diskFreeBytes: number | null;
  freePercentThreshold: number;
  freeBytesThreshold: number;
  path: string | null;
  retryAfterSeconds: number;
}

export type DiskAdmissionDecision =
  | { admit: true }
  | { admit: false; rejection: DiskCriticalDetails };

/**
 * Edge-triggered consecutive-breach tracker for data-directory free space
 * (issue #1992). Fed once per resource-sampler tick; rejects launches only
 * after `sustainSamples` consecutive breaches so a single noisy reading cannot
 * false-positive the gate shut (same discipline as the ops-alert evaluator).
 *
 * Fail-open on missing data: a null/non-finite reading neither advances the
 * counter nor clears an active critical state (matches ops-alert rules).
 */
export class DataDirectoryDiskAdmissionTracker {
  private consecutive = 0;
  private critical = false;
  private configKey: string | null = null;
  private lastSampledAt: string | null = null;

  /**
   * Observe one resource-status sample. No-ops when `sampledAt` matches the
   * previous observation so concurrent POST handlers cannot double-count a
   * single tick.
   */
  observe(sample: DataDirectoryDiskSample, config: DiskAdmissionConfig): void {
    if (sample.sampledAt != null && sample.sampledAt === this.lastSampledAt) {
      return;
    }
    if (sample.sampledAt != null) {
      this.lastSampledAt = sample.sampledAt;
    }

    const percentThreshold = config.freePercentThreshold;
    const bytesThreshold = config.freeBytesThreshold;
    const sustainSamples = Math.max(1, Math.floor(config.sustainSamples));

    if (!(percentThreshold > 0) && !(bytesThreshold > 0)) {
      this.consecutive = 0;
      this.critical = false;
      this.configKey = null;
      return;
    }

    const configKey = `disk:${percentThreshold}:${bytesThreshold}:${sustainSamples}`;
    if (this.configKey !== null && this.configKey !== configKey) {
      this.consecutive = 0;
      this.critical = false;
    }
    this.configKey = configKey;

    const percentEnabled = percentThreshold > 0;
    const bytesEnabled = bytesThreshold > 0;
    const freePercent = sample.diskFreePercent;
    const freeBytes = sample.diskFreeBytes;
    const percentKnown = freePercent != null && Number.isFinite(freePercent);
    const bytesKnown = freeBytes != null && Number.isFinite(freeBytes);
    const hasAnyEnabledReading =
      (percentEnabled && percentKnown) || (bytesEnabled && bytesKnown);

    if (!hasAnyEnabledReading) {
      // No data: preserve streak + critical flag (fail-open on missing, do not
      // spuriously clear a true critical state during a transient sampler blip).
      return;
    }

    const breached = isDataDirectoryFreeCritical({
      freePercent,
      freeBytes,
      percentThreshold,
      bytesThreshold,
    });

    if (breached) {
      this.consecutive += 1;
      if (!this.critical && this.consecutive >= sustainSamples) {
        this.critical = true;
      }
      return;
    }

    // Recovery requires every enabled floor to have a known reading above the
    // floor (same as the ops-alert recovery path).
    const allEnabledReadingsKnown =
      (!percentEnabled || percentKnown) && (!bytesEnabled || bytesKnown);
    if (!allEnabledReadingsKnown) return;

    this.consecutive = 0;
    this.critical = false;
  }

  /** True once free space has stayed critical for `sustainSamples` ticks. */
  isCritical(): boolean {
    return this.critical;
  }

  /** Test/diagnostics snapshot. */
  getState(): { consecutive: number; critical: boolean } {
    return { consecutive: this.consecutive, critical: this.critical };
  }

  /** Reset to a clean non-critical state (tests). */
  reset(): void {
    this.consecutive = 0;
    this.critical = false;
    this.configKey = null;
    this.lastSampledAt = null;
  }
}

/**
 * Decide whether a spawn POST may proceed given data-directory free space.
 *
 * Prefer feeding {@link DataDirectoryDiskAdmissionTracker} from the resource-
 * status tick and passing `critical: tracker.isCritical()` so the sustain
 * window is measured in sampler ticks, not launch attempts. When no tracker is
 * wired, a single-sample breach still fails closed (sustainSamples treated as
 * already met) so tests and partial wiring remain fail-closed under known
 * critical free space.
 *
 * Disabled when both floors are `<= 0`. Missing readings fail open unless the
 * tracker already marked critical.
 */
export function evaluateDiskAdmission(input: {
  config: DiskAdmissionConfig;
  sample: DataDirectoryDiskSample | null | undefined;
  /**
   * Precomputed critical flag from {@link DataDirectoryDiskAdmissionTracker}.
   * When omitted, falls back to a pure single-sample breach check.
   */
  critical?: boolean;
}): DiskAdmissionDecision {
  const { config, sample } = input;
  const percentThreshold = config.freePercentThreshold;
  const bytesThreshold = config.freeBytesThreshold;
  if (!(percentThreshold > 0) && !(bytesThreshold > 0)) {
    return { admit: true };
  }

  const freePercent = sample?.diskFreePercent ?? null;
  const freeBytes = sample?.diskFreeBytes ?? null;
  const path = sample?.path ?? null;

  const isCritical =
    input.critical
    ?? isDataDirectoryFreeCritical({
      freePercent,
      freeBytes,
      percentThreshold,
      bytesThreshold,
    });

  if (!isCritical) return { admit: true };

  const retryAfterSeconds = Math.max(1, Math.floor(config.retryAfterSeconds));
  const freePctText =
    freePercent != null && Number.isFinite(freePercent)
      ? `${freePercent.toFixed(1)}%`
      : 'unknown';
  const freeBytesText =
    freeBytes != null && Number.isFinite(freeBytes)
      ? `${Math.round(freeBytes)}B`
      : 'unknown';

  return {
    admit: false,
    rejection: {
      error:
        `Data-directory disk free is critical (${freePctText} / ${freeBytesText}` +
        `${path ? ` at ${path}` : ''}). Refusing new task launches to avoid ENOSPC. ` +
        `Retry after ${retryAfterSeconds}s once free space recovers above the floors ` +
        `(percent≤${percentThreshold || 'off'}, bytes≤${bytesThreshold || 'off'}). ` +
        `Reclaim/reap paths remain available.`,
      code: DATA_DIRECTORY_DISK_CRITICAL_CODE,
      reason: DATA_DIRECTORY_DISK_CRITICAL_CODE,
      diskFreePercent: freePercent != null && Number.isFinite(freePercent) ? freePercent : null,
      diskFreeBytes: freeBytes != null && Number.isFinite(freeBytes) ? freeBytes : null,
      freePercentThreshold: percentThreshold,
      freeBytesThreshold: bytesThreshold,
      path: path ?? null,
      retryAfterSeconds,
    },
  };
}
