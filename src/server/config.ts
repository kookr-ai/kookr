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

/**
 * Provider-health durable-alert defaults (issue #1897, WS1.5 of #1699). Failover
 * masks a chronic provider outage; these thresholds decide when the masking
 * becomes a standing operational alert. Enabled by default — inert until the
 * WS1.3 substitution counter / pool-pause producer feeds real signals, so
 * turning them on now means the alert "just works" once that lands.
 *
 * `KOOKR_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS` substitutions within
 * `KOOKR_ALERT_PROVIDER_FALLBACK_WINDOW_MS`, OR a pool pause lasting at least
 * `KOOKR_ALERT_PROVIDER_PAUSED_MS`, fires the alert. Set the count and the
 * paused-ms to `0` to disable the respective rule.
 */
export const DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS = 5;
export const DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS = 5 * 60 * 1000;

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
  /**
   * Provider fallback-substitution count that, within
   * {@link providerFallbackWindowMs}, fires the standing provider-health alert
   * (`0` disables the substitution rule).
   */
  providerFallbackSubstitutions: number;
  /**
   * Rolling window in milliseconds over which {@link providerFallbackSubstitutions}
   * substitutions are counted (`0` disables the substitution rule).
   */
  providerFallbackWindowMs: number;
  /**
   * Provider-pool paused-duration threshold in milliseconds that fires the
   * standing provider-health alert (`0` disables the paused-duration rule).
   */
  providerPausedMs: number;
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
    providerFallbackSubstitutions: readNonNegativeNumber(
      env.KOOKR_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
      DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
    ),
    providerFallbackWindowMs: readNonNegativeNumber(
      env.KOOKR_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
      DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
    ),
    providerPausedMs: readNonNegativeNumber(
      env.KOOKR_ALERT_PROVIDER_PAUSED_MS,
      DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
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

/**
 * Default minimum age (ms) an UNOWNED dtach session must reach before the
 * orphan/terminal-task session reaper (issue #1720) terminates it — 24h, so
 * the sweep never races a mid-launch session (#1537 item 2).
 */
export const DEFAULT_REAP_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Default under-pressure unowned-orphan age (issue #2081) — 2h. When
 * `staleProcesses.dtach.count` is at/above the soft bound the reaper uses this
 * shorter threshold so unowned masters reclaim before a full-day wait risks
 * OOM. Override with `KOOKR_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS` (preferred) or
 * the issue-#2081 alias `KOOKR_SESSION_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS`.
 */
export const DEFAULT_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS = 2 * 60 * 60 * 1000;

/**
 * Default grace period (ms) a session whose OWNING TASK has already reached a
 * terminal status must sit before the reaper terminates it (issue #1720 leak
 * class 2 — a `completed`/`terminated` task whose session process tree is
 * still resident). Much shorter than the orphan threshold: the owning task is
 * already known to be done, so this only guards against double-signalling a
 * session `completeTask`'s own fire-and-forget `adapter.stop()` is still in
 * the middle of stopping.
 */
export const DEFAULT_REAP_TERMINAL_TASK_GRACE_MS = 60 * 1000;

export interface SessionReapEnvConfig {
  enabled: boolean;
  /** Steady-state unowned-orphan age (default 24h). */
  orphanAgeThresholdMs: number;
  /**
   * Under-pressure unowned-orphan age (default 2h, issue #2081). Applied when
   * the dtach soft-bound pressure signal is high.
   */
  orphanAgeUnderPressureMs: number;
  terminalTaskGraceMs: number;
}

/**
 * Read the orphan/terminal-task session reaper configuration (issue #1720 /
 * #2081) from the environment. `KOOKR_REAP_ORPHAN_SESSIONS` defaults ON — set
 * to `'false'` to disable the whole sweep (both leak classes it acts on; the
 * boot-only stale-attach-client sweep shares this same flag).
 */
export function readSessionReapConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SessionReapEnvConfig {
  // Prefer the `KOOKR_REAP_*` family; accept the issue-#2081
  // `KOOKR_SESSION_REAP_*` alias so operators following that name still bind.
  const underPressureRaw =
    env.KOOKR_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS
    ?? env.KOOKR_SESSION_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS;
  return {
    enabled: env.KOOKR_REAP_ORPHAN_SESSIONS !== 'false',
    orphanAgeThresholdMs: readNonNegativeNumber(env.KOOKR_REAP_ORPHAN_AGE_MS, DEFAULT_REAP_ORPHAN_AGE_MS),
    orphanAgeUnderPressureMs: readNonNegativeNumber(
      underPressureRaw,
      DEFAULT_REAP_ORPHAN_AGE_UNDER_PRESSURE_MS,
    ),
    terminalTaskGraceMs: readNonNegativeNumber(
      env.KOOKR_REAP_TERMINAL_TASK_GRACE_MS,
      DEFAULT_REAP_TERMINAL_TASK_GRACE_MS,
    ),
  };
}

// ---------------------------------------------------------------------------
// Ring fleet memory budget (issue #1779)
// ---------------------------------------------------------------------------

/**
 * Default fleet-wide sum of live session ring buffer capacities. Each session
 * still allocates a full 1 MiB ring when active; when the sum of capacities
 * exceeds this budget, least-recently-active rings shrink to 64 KiB. `0`
 * disables enforcement (pre-#1779 behaviour). 32 MiB ≈ 32 full rings before
 * pressure starts reclaiming idle scrollback.
 */
export const DEFAULT_RING_FLEET_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Read `KOOKR_RING_FLEET_BUDGET_BYTES` — fleet sum of ring capacities. `0`
 * disables dynamic shrink. Invalid/blank values fall back to the default.
 */
export function readRingFleetBudgetBytesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readNonNegativeNumber(env.KOOKR_RING_FLEET_BUDGET_BYTES, DEFAULT_RING_FLEET_BUDGET_BYTES);
}

// ---------------------------------------------------------------------------
// Resource watchdog (issue #1724) — OFF by default; operator opt-in actuator.
// ---------------------------------------------------------------------------

/** Default sample cadence (60s). */
export const DEFAULT_RESOURCE_WATCHDOG_INTERVAL_MS = 60_000;
/** Default swap-used % threshold. */
export const DEFAULT_RESOURCE_WATCHDOG_SWAP_PERCENT = 50;
/** Default MemAvailable floor (MiB). */
export const DEFAULT_RESOURCE_WATCHDOG_MEM_AVAILABLE_MB = 512;
/** Default per-agent-family process ceiling. */
export const DEFAULT_RESOURCE_WATCHDOG_PROCESS_CEILING = 40;
/** Default orphan-session count ceiling. */
export const DEFAULT_RESOURCE_WATCHDOG_ORPHAN_CEILING = 5;
/** Default minimum gap between spawns (30 min). */
export const DEFAULT_RESOURCE_WATCHDOG_THROTTLE_MS = 30 * 60 * 1000;
/** Default rolling-24h spawn budget before meta-reflection. */
export const DEFAULT_RESOURCE_WATCHDOG_SPAWN_BUDGET_24H = 4;
/** Rolling budget window (24h). */
export const DEFAULT_RESOURCE_WATCHDOG_SPAWN_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResourceWatchdogEnvConfig {
  enabled: boolean;
  /**
   * When master is off, still auto-enable a rate-limited investigation under
   * soft-bound pressure (issue #2354). Default true; set
   * `KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0` for page-only.
   */
  autoEnableOnPressure: boolean;
  intervalMs: number;
  swapUsedPercentThreshold: number;
  memAvailableMbFloor: number;
  processCeiling: number;
  orphanCeiling: number;
  throttleMs: number;
  spawnBudget24h: number;
  spawnBudgetWindowMs: number;
}

function readTruthyEnvFlag(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Truthy flag that defaults to **true** when unset/empty (issue #2354).
 * Explicit 0/false/no/off disables; 1/true/yes/on enables.
 */
function readTruthyEnvFlagDefaultTrue(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') return true;
  const v = raw.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Read the resource-watchdog configuration (issue #1724 / #2354) from the
 * environment.
 *
 * **Master switch disabled by default.** Set `KOOKR_RESOURCE_WATCHDOG=1` (or
 * true/yes/on) for continuous sampling. When the master is off,
 * `KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE` defaults to on so soft-bound pressure
 * still gets one rate-limited investigation spawn. Thresholds of `0` disable
 * the individual rule (same convention as operational alerts).
 */
export function readResourceWatchdogConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResourceWatchdogEnvConfig {
  return {
    enabled: readTruthyEnvFlag(env.KOOKR_RESOURCE_WATCHDOG),
    autoEnableOnPressure: readTruthyEnvFlagDefaultTrue(
      env.KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE,
    ),
    intervalMs: Math.max(
      1_000,
      readNonNegativeNumber(env.KOOKR_RESOURCE_WATCHDOG_INTERVAL_MS, DEFAULT_RESOURCE_WATCHDOG_INTERVAL_MS)
        || DEFAULT_RESOURCE_WATCHDOG_INTERVAL_MS,
    ),
    swapUsedPercentThreshold: readNonNegativeNumber(
      env.KOOKR_RESOURCE_WATCHDOG_SWAP_PERCENT,
      DEFAULT_RESOURCE_WATCHDOG_SWAP_PERCENT,
    ),
    memAvailableMbFloor: readNonNegativeNumber(
      env.KOOKR_RESOURCE_WATCHDOG_MEM_AVAILABLE_MB,
      DEFAULT_RESOURCE_WATCHDOG_MEM_AVAILABLE_MB,
    ),
    processCeiling: readNonNegativeNumber(
      env.KOOKR_RESOURCE_WATCHDOG_PROCESS_CEILING,
      DEFAULT_RESOURCE_WATCHDOG_PROCESS_CEILING,
    ),
    orphanCeiling: readNonNegativeNumber(
      env.KOOKR_RESOURCE_WATCHDOG_ORPHAN_CEILING,
      DEFAULT_RESOURCE_WATCHDOG_ORPHAN_CEILING,
    ),
    throttleMs: Math.max(
      0,
      readNonNegativeNumber(env.KOOKR_RESOURCE_WATCHDOG_THROTTLE_MS, DEFAULT_RESOURCE_WATCHDOG_THROTTLE_MS),
    ),
    spawnBudget24h: Math.max(
      1,
      readPositiveInt(env.KOOKR_RESOURCE_WATCHDOG_SPAWN_BUDGET_24H, DEFAULT_RESOURCE_WATCHDOG_SPAWN_BUDGET_24H),
    ),
    spawnBudgetWindowMs: Math.max(
      60_000,
      readNonNegativeNumber(
        env.KOOKR_RESOURCE_WATCHDOG_SPAWN_BUDGET_WINDOW_MS,
        DEFAULT_RESOURCE_WATCHDOG_SPAWN_BUDGET_WINDOW_MS,
      ) || DEFAULT_RESOURCE_WATCHDOG_SPAWN_BUDGET_WINDOW_MS,
    ),
  };
}
