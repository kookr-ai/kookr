/** Maximum number of concurrently running (inProgress) tasks. */
export const MAX_ACTIVE_TASKS = 10;

/** Default consecutive breaching samples required before an operational alert fires. */
export const DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES = 3;
export const DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT = 5;
export const DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS = 30 * 1000;

/** Default maximum JSON request body size accepted by the dashboard server. */
export const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 1_000_000;

/**
 * Threshold configuration for operational alerts on already-sampled host
 * signals. A threshold of `0` disables that rule, mirroring the
 * `KOOKR_BUDGET_WARN_USD=0` opt-out convention.
 */
export interface OperationalAlertConfig {
  /** Host CPU usage percent threshold (`0` disables). */
  cpuPercent: number;
  /** Host memory used percent threshold (`0` disables). */
  memoryPercent: number;
  /** Event-loop delay p95 threshold in milliseconds (`0` disables). */
  eventLoopDelayMs: number;
  /** Kookr process resident-set-size (RSS) threshold in bytes (`0` disables). */
  processRssBytes: number;
  /** Data-directory filesystem free-space percent threshold (`0` disables). */
  dataDirectoryFreePercent: number;
  /** Data-directory filesystem free-space byte threshold (`0` disables). */
  dataDirectoryFreeBytes: number;
  /** Circuit-breaker OPEN duration threshold in milliseconds (`0` disables). */
  circuitBreakerOpenMs: number;
  /** Consecutive breaching samples required before firing (>= 1). */
  sustainSamples: number;
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
 * Read operational alert thresholds from the environment. CPU, memory,
 * event-loop, and process-RSS thresholds default to `0` (disabled);
 * data-directory disk pressure uses conservative enabled defaults. Invalid or
 * blank values fall back to the documented defaults.
 */
export function readOperationalAlertConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OperationalAlertConfig {
  return {
    cpuPercent: readNonNegativeNumber(env.KOOKR_ALERT_CPU_PERCENT, 0),
    memoryPercent: readNonNegativeNumber(env.KOOKR_ALERT_MEMORY_PERCENT, 0),
    eventLoopDelayMs: readNonNegativeNumber(env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS, 0),
    processRssBytes: readNonNegativeNumber(env.KOOKR_ALERT_PROCESS_RSS_BYTES, 0),
    dataDirectoryFreePercent: readNonNegativeNumber(
      env.KOOKR_ALERT_DATA_DIR_FREE_PERCENT,
      DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
    ),
    dataDirectoryFreeBytes: readNonNegativeNumber(
      env.KOOKR_ALERT_DATA_DIR_FREE_BYTES,
      DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
    ),
    circuitBreakerOpenMs: readNonNegativeNumber(
      env.KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS,
      DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
    ),
    sustainSamples: readPositiveInt(
      env.KOOKR_ALERT_SUSTAIN_SAMPLES,
      DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    ),
  };
}

/** Read the dashboard server JSON request body limit from the environment. */
export function readRequestBodyLimitBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveInt(env.KOOKR_REQUEST_BODY_LIMIT_BYTES, DEFAULT_REQUEST_BODY_LIMIT_BYTES);
}
