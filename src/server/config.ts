/** Maximum number of concurrently running (inProgress) tasks. */
export const MAX_ACTIVE_TASKS = 10;

/** Default consecutive breaching samples required before an operational alert fires. */
export const DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES = 3;
export const DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT = 5;
export const DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS = 30 * 1000;
/**
 * Default Kookr process RSS alert threshold (issue #1612). The 2026-07-26/27
 * OOMs crashed near a ~3.9 GB heap ceiling; a 3 GiB threshold fires the #1497
 * operational alert ~900 MB below that danger line while sustained multi-agent
 * load still climbs, giving an operator lead time to restart before HTTP
 * starvation. Set `KOOKR_ALERT_PROCESS_RSS_BYTES=0` to disable, or raise it for
 * hosts with a larger heap budget.
 */
export const DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES = 3 * 1024 * 1024 * 1024;

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
 * Read operational alert thresholds from the environment. CPU, memory, and
 * event-loop thresholds default to `0` (disabled); process-RSS and
 * data-directory disk pressure use conservative enabled defaults. Invalid or
 * blank values fall back to the documented defaults.
 */
export function readOperationalAlertConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OperationalAlertConfig {
  return {
    cpuPercent: readNonNegativeNumber(env.KOOKR_ALERT_CPU_PERCENT, 0),
    memoryPercent: readNonNegativeNumber(env.KOOKR_ALERT_MEMORY_PERCENT, 0),
    eventLoopDelayMs: readNonNegativeNumber(env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS, 0),
    processRssBytes: readNonNegativeNumber(
      env.KOOKR_ALERT_PROCESS_RSS_BYTES,
      DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
    ),
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

/**
 * CPU-aware task admission threshold (issue #1630), expressed as 1-minute load
 * average per logical CPU. `0` (the default) disables the gate — mirroring the
 * `0`-disables convention used by the operational-alert thresholds — so
 * behavior is unchanged unless an operator opts in. When set > 0, a new task
 * launch is rejected while `os.loadavg()[0] / os.cpus().length` exceeds this
 * value, so a burst of compile/test-heavy tasks cannot saturate the host and
 * starve the supervisor's event loop. A sensible starting point on a busy
 * shared host is ~0.9–1.0 (reject once average load reaches the core count).
 */
export const DEFAULT_MAX_HOST_LOAD_PER_CPU = 0;

/** Read the CPU-aware task-admission threshold (load-per-core) from the environment. */
export function readMaxHostLoadPerCpuFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readNonNegativeNumber(env.KOOKR_MAX_HOST_LOAD_PER_CPU, DEFAULT_MAX_HOST_LOAD_PER_CPU);
}
