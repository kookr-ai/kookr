/**
 * Pause gate for non-critical background timer ticks (issue #1785).
 *
 * When the sampled event-loop delay p95 is elevated, GitHub scanner polls and
 * other non-critical lifecycle intervals skip their next body so the loop can
 * serve terminal I/O. Critical loops (token scan, watchdog, liveness, save,
 * snooze expiry, quota poll) are intentionally out of scope.
 *
 * Reuses the SAME `eventLoopDelayP95Ms` sample that already powers admission
 * (#1590) and WS load-shed (#1725) — `ResourceStatusService` feeds each sample
 * via {@link NonCriticalTimerPauseGate.noteSample}. Fail-open: missing /
 * non-finite samples and a disabled threshold never pause work.
 */

/** Default event-loop delay p95 threshold (ms) above which non-critical ticks skip. */
export const DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS = 1_500;

export interface NonCriticalTimerPauseConfig {
  /**
   * Event-loop delay p95 threshold in milliseconds. Ticks skip when the latest
   * sample is strictly greater than this value. `0` disables pausing entirely
   * (mirrors the `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS=0` / load-shed opt-out).
   */
  eventLoopDelayThresholdMs: number;
}

function readNonNegativeNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed < 0 ? 0 : parsed;
}

/**
 * Read pause-gate threshold from the environment. Invalid or blank values fall
 * back to the documented default; `KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS=0`
 * disables pausing.
 */
export function readNonCriticalTimerPauseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): NonCriticalTimerPauseConfig {
  return {
    eventLoopDelayThresholdMs: readNonNegativeNumber(
      env.KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS,
      DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS,
    ),
  };
}

/**
 * Pure decision: should a non-critical timer skip its body given the latest
 * sample? Fail-open on disabled threshold or missing/non-finite sample.
 * Issue wording is "delayP95 > threshold" (strict).
 */
export function shouldSkipNonCriticalTimerTick(input: {
  eventLoopDelayP95Ms: number | null | undefined;
  thresholdMs: number;
}): boolean {
  const { eventLoopDelayP95Ms, thresholdMs } = input;
  if (!(thresholdMs > 0)) return false;
  if (eventLoopDelayP95Ms == null || !Number.isFinite(eventLoopDelayP95Ms)) return false;
  return eventLoopDelayP95Ms > thresholdMs;
}

export interface NonCriticalTimerPauseSnapshot {
  schemaVersion: 'non-critical-timer-pause.v1';
  /** Whether the latest sample would cause the next non-critical tick to skip. */
  paused: boolean;
  /** Configured threshold (ms); 0 means the gate is disabled. */
  thresholdMs: number;
  /** Last finite sample passed to {@link NonCriticalTimerPauseGate.noteSample}, or null. */
  lastEventLoopDelayP95Ms: number | null;
  /** Total non-critical ticks skipped since process start (pause metric). */
  pausedTicksTotal: number;
}

/**
 * Holds the latest event-loop delay sample and a process-lifetime pause counter.
 * Synchronous, no I/O, no timers of its own — safe to consult from interval
 * callbacks. Resume is automatic: once a sample falls back to ≤ threshold,
 * {@link shouldSkipTick} returns false again.
 */
export class NonCriticalTimerPauseGate {
  private readonly config: NonCriticalTimerPauseConfig;
  private lastSampleMs: number | null = null;
  private pausedTicksTotal = 0;

  constructor(config: NonCriticalTimerPauseConfig) {
    this.config = config;
  }

  /** Feed one sampled event-loop delay p95 (ms). Null/non-finite samples leave the last finite sample unchanged. */
  noteSample(delayMs: number | null | undefined): void {
    if (delayMs == null || !Number.isFinite(delayMs)) return;
    this.lastSampleMs = delayMs;
  }

  /** Whether the next non-critical tick should skip its body (fail open). */
  shouldSkipTick(): boolean {
    return shouldSkipNonCriticalTimerTick({
      eventLoopDelayP95Ms: this.lastSampleMs,
      thresholdMs: this.config.eventLoopDelayThresholdMs,
    });
  }

  /**
   * Record that one non-critical tick was skipped. Returns the new total so
   * callers can log without re-reading the snapshot.
   */
  recordPause(_timerName?: string): number {
    this.pausedTicksTotal += 1;
    return this.pausedTicksTotal;
  }

  getSnapshot(): NonCriticalTimerPauseSnapshot {
    return {
      schemaVersion: 'non-critical-timer-pause.v1',
      paused: this.shouldSkipTick(),
      thresholdMs: this.config.eventLoopDelayThresholdMs,
      lastEventLoopDelayP95Ms: this.lastSampleMs,
      pausedTicksTotal: this.pausedTicksTotal,
    };
  }
}

export function createNonCriticalTimerPauseGate(
  config: NonCriticalTimerPauseConfig = readNonCriticalTimerPauseConfigFromEnv(),
): NonCriticalTimerPauseGate {
  return new NonCriticalTimerPauseGate(config);
}
