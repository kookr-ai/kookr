/** Maximum number of concurrently running (inProgress) tasks. */
export const MAX_ACTIVE_TASKS = 10;

/** Default consecutive breaching samples required before an operational alert fires. */
export const DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES = 3;

/**
 * Threshold configuration for operational alerts on already-sampled host
 * signals. A threshold of `0` (the default) disables that rule, mirroring the
 * `KOOKR_BUDGET_WARN_USD=0` opt-out convention.
 */
export interface OperationalAlertConfig {
  /** Host CPU usage percent threshold (`0` disables). */
  cpuPercent: number;
  /** Host memory used percent threshold (`0` disables). */
  memoryPercent: number;
  /** Event-loop delay p95 threshold in milliseconds (`0` disables). */
  eventLoopDelayMs: number;
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
 * Read operational alert thresholds from the environment. All thresholds
 * default to `0` (disabled) so the feature is opt-in and never surprises an
 * existing deployment with new alerts. Invalid or blank values fall back to
 * the documented defaults.
 */
export function readOperationalAlertConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OperationalAlertConfig {
  return {
    cpuPercent: readNonNegativeNumber(env.KOOKR_ALERT_CPU_PERCENT, 0),
    memoryPercent: readNonNegativeNumber(env.KOOKR_ALERT_MEMORY_PERCENT, 0),
    eventLoopDelayMs: readNonNegativeNumber(env.KOOKR_ALERT_EVENT_LOOP_DELAY_MS, 0),
    sustainSamples: readPositiveInt(
      env.KOOKR_ALERT_SUSTAIN_SAMPLES,
      DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    ),
  };
}
