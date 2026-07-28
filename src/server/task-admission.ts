/**
 * Load-based admission control for `POST /api/tasks` (issue #1590).
 *
 * Depth-based backpressure (#1536) rejects when the *pending queue* is full,
 * but it only measures queue depth: a saturated event loop lets a spawn POST
 * hang into a client timeout regardless of queue state (batch dd1fbcec's
 * wave-2 spawns, lucy #1654). This module adds an orthogonal, load-based gate
 * that fast-fails a spawn POST with `503 + Retry-After` *before* any work is
 * done, so a saturated server says "no" honestly in ≤2s instead of hanging.
 *
 * The saturation signal is the already-sampled event-loop delay p95 that the
 * resource sampler publishes into health snapshots
 * (`SystemResourceStatus.server.eventLoopDelayP95Ms`, refreshed ~every 2s by
 * {@link ../system-resource-sampler}). Admission REUSES that value rather than
 * standing up a second `monitorEventLoopDelay` — one monitor, two consumers
 * (alerts + admission), per the issue's "reuse or extend" constraint.
 */

/** Response `code` on the load-based 503, distinct from the #1536 depth 429s. */
export const EVENT_LOOP_SATURATED_CODE = 'event_loop_saturated';

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
