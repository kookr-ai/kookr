/**
 * Load-shed gate for the dashboard WebSocket snapshot fan-out (issue #1725).
 *
 * The 2026-07-31 prod incident showed the admission guard (#1590,
 * `event_loop_saturated`) protects **inbound** `POST /api/tasks` but nothing
 * shed **outbound** fan-out work: a saturated loop kept trying to serialize
 * and send 2.2 MB snapshots to 300+ sockets, which made the loop more
 * saturated, in a positive feedback loop.
 *
 * This gate REUSES the same sampled event-loop delay p95 that already powers
 * the #1590 admission guard (`SystemResourceStatus.server.eventLoopDelayP95Ms`,
 * refreshed every `RESOURCE_STATUS_INTERVAL_MS` by
 * {@link ../system-resource-sampler}) — it does not stand up a second
 * `monitorEventLoopDelay`. `ResourceStatusService.tick()` feeds each sample in
 * via {@link WebSocketLoadShedGate.noteSample}; the broadcaster asks
 * {@link WebSocketLoadShedGate.isActive} before doing the expensive per-scope
 * serialize-and-fan-out work.
 *
 * Hysteresis: entering shed mode requires `sustainTicks` CONSECUTIVE samples at
 * or above the threshold, and leaving requires `recoverTicks` CONSECUTIVE
 * samples back below it. Symmetric by design so a delay bouncing around the
 * threshold can't flap the gate every tick.
 */

/** Default event-loop delay p95 threshold (ms) above which shedding engages. */
export const DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS = 1_500;

/** Default consecutive resource-status ticks above threshold before shedding engages. */
export const DEFAULT_LOAD_SHED_SUSTAIN_TICKS = 3;

/** Default consecutive resource-status ticks below threshold before shedding disengages. */
export const DEFAULT_LOAD_SHED_RECOVER_TICKS = 3;

export interface WebSocketLoadShedConfig {
  /**
   * Event-loop delay p95 threshold in milliseconds. `0` disables shedding
   * entirely (mirroring the `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS=0` opt-out
   * convention from #1590).
   */
  eventLoopDelayThresholdMs: number;
  /** Consecutive above-threshold ticks required to engage shed mode. */
  sustainTicks: number;
  /** Consecutive below-threshold ticks required to disengage shed mode. */
  recoverTicks: number;
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
 * Read load-shed thresholds from the environment. Invalid or blank values fall
 * back to the documented defaults; `KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS=0`
 * disables shedding.
 */
export function readLoadShedConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebSocketLoadShedConfig {
  return {
    eventLoopDelayThresholdMs: readNonNegativeNumber(
      env.KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS,
      DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS,
    ),
    sustainTicks: readPositiveInt(
      env.KOOKR_WS_LOAD_SHED_SUSTAIN_TICKS,
      DEFAULT_LOAD_SHED_SUSTAIN_TICKS,
    ),
    recoverTicks: readPositiveInt(
      env.KOOKR_WS_LOAD_SHED_RECOVER_TICKS,
      DEFAULT_LOAD_SHED_RECOVER_TICKS,
    ),
  };
}

export interface WebSocketLoadShedGateDeps {
  logger?: Pick<typeof console, 'warn'>;
}

/**
 * Pure(ish) hysteresis tracker — synchronous, no I/O, no timers of its own.
 * `noteSample` is called once per resource-status tick with the freshly
 * sampled event-loop delay p95; {@link isActive} reflects the gate's current
 * state for the broadcaster to consult before serializing a snapshot.
 *
 * State transitions are logged once each (enter / recover), not per sample —
 * the whole point is avoiding the #832-style log storm (973 warn lines in one
 * incident) while the gate is engaged.
 */
export class WebSocketLoadShedGate {
  private readonly config: WebSocketLoadShedConfig;
  private readonly logger: Pick<typeof console, 'warn'>;
  private aboveStreak = 0;
  private belowStreak = 0;
  private active = false;
  private skippedSnapshotCount = 0;
  private lastSampleMs: number | null = null;

  constructor(config: WebSocketLoadShedConfig, deps: WebSocketLoadShedGateDeps = {}) {
    this.config = config;
    this.logger = deps.logger ?? console;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Total full-snapshot broadcasts skipped since the last time shed mode engaged. */
  get skippedSinceEngaged(): number {
    return this.skippedSnapshotCount;
  }

  /** Last sampled event-loop delay p95 (ms) passed to {@link noteSample}, or null before the first sample. */
  get lastEventLoopDelayP95Ms(): number | null {
    return this.lastSampleMs;
  }

  /**
   * Feed one sampled event-loop delay p95 (ms). Returns whether shed mode is
   * active after processing this sample. A disabled gate (`threshold <= 0`) or
   * a missing/non-finite sample (sampler unavailable) never moves the streaks
   * — missing data must never itself trigger shedding.
   */
  noteSample(delayMs: number | null | undefined): boolean {
    if (!(this.config.eventLoopDelayThresholdMs > 0)) {
      this.active = false;
      return false;
    }
    if (delayMs == null || !Number.isFinite(delayMs)) {
      return this.active;
    }
    this.lastSampleMs = delayMs;

    if (delayMs >= this.config.eventLoopDelayThresholdMs) {
      this.aboveStreak += 1;
      this.belowStreak = 0;
      if (!this.active && this.aboveStreak >= this.config.sustainTicks) {
        this.active = true;
        this.skippedSnapshotCount = 0;
        this.logger.warn('[websocket] load-shed mode engaged: full snapshot broadcasts suspended', {
          eventLoopDelayP95Ms: delayMs,
          thresholdMs: this.config.eventLoopDelayThresholdMs,
          sustainTicks: this.config.sustainTicks,
        });
      }
    } else {
      this.belowStreak += 1;
      this.aboveStreak = 0;
      if (this.active && this.belowStreak >= this.config.recoverTicks) {
        this.active = false;
        this.logger.warn('[websocket] load-shed mode recovered: resuming full snapshot broadcasts', {
          eventLoopDelayP95Ms: delayMs,
          thresholdMs: this.config.eventLoopDelayThresholdMs,
          skippedSnapshotBroadcasts: this.skippedSnapshotCount,
        });
        this.skippedSnapshotCount = 0;
      }
    }
    return this.active;
  }

  /** Record that one full snapshot broadcast was replaced with a degraded frame. */
  recordSkippedSnapshot(): void {
    this.skippedSnapshotCount += 1;
  }
}

export function createWebSocketLoadShedGate(
  config: WebSocketLoadShedConfig,
  deps?: WebSocketLoadShedGateDeps,
): WebSocketLoadShedGate {
  return new WebSocketLoadShedGate(config, deps);
}
