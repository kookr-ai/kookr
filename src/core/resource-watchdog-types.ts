/**
 * Resource watchdog contracts (issue #1724).
 *
 * A host-level safety net that samples machine pressure (swap, available
 * memory, oom_kill deltas, agent-family process counts, orphan sessions) and
 * — when pressure is real — spawns a throttled, briefed investigation task so
 * the supervisor can self-heal instead of waiting for the kernel OOM killer.
 *
 * Pure types only: evaluation, persistence, sampling, and spawn live in
 * sibling modules so unit tests never need real `/proc` or real launches.
 */

export const RESOURCE_WATCHDOG_STATE_SCHEMA_VERSION = 1 as const;
export const RESOURCE_WATCHDOG_AUDIT_SCHEMA_VERSION = 'resource-watchdog-audit.v1' as const;

/** Durable comparison point for detecting `oom_kill` changes across restarts. */
export interface ResourceWatchdogOomKillBaseline {
  total: number;
  sampledAt: string;
}

/** Per-agent-family process counts observed in one sample. */
export interface AgentFamilyProcessCounts {
  claude: number;
  grok: number;
  codex: number;
  /** `dtach` masters + attach clients (both ends of a session socket). */
  dtach: number;
}

/**
 * Compact top consumer entry for the investigation brief. The sampler may
 * leave this empty when RSS is unavailable (non-Linux); evaluation never
 * thresholds on it.
 */
export interface TopConsumerSnapshot {
  pid: number;
  rssKb: number;
  command: string;
}

/** One host sample. All fields are already-resolved numbers — no I/O here. */
export interface ResourceWatchdogSample {
  sampledAt: string;
  /** Swap used as a percent of SwapTotal; `null` when swap is absent/unreadable. */
  swapUsedPercent: number | null;
  /** Available memory in MiB (`MemAvailable`); `null` when unreadable. */
  memAvailableMb: number | null;
  /** Absolute `/proc/vmstat` `oom_kill` counter; `null` when unreadable. */
  oomKillTotal: number | null;
  processCounts: AgentFamilyProcessCounts;
  /**
   * Orphan + terminal-task-leak session counts from the last reaper sweep
   * (issue #1720). Sourced from the reaper's cheap in-memory health snapshot —
   * never a fresh process scan on the watchdog path.
   */
  orphanSessionCount: number;
  terminalLeakCount: number;
  /** Optional top RSS consumers for the brief (not thresholded). */
  topConsumers: TopConsumerSnapshot[];
}

export type ResourceWatchdogTriggerReason =
  | 'swap_percent'
  | 'mem_available'
  | 'oom_kill_delta'
  | 'process_ceiling'
  | 'orphan_ceiling'
  /** Soft-bound dtach pressure while the actuator is opt-in disabled (issue #2354). */
  | 'dtach_soft_bound';

export interface ResourceWatchdogTrigger {
  reason: ResourceWatchdogTriggerReason;
  /** Human-readable detail for the audit line + brief. */
  detail: string;
  /** Observed value that breached (or the oom delta). */
  observed: number;
  /** Configured threshold (0 for oom_kill_delta — any positive delta fires). */
  threshold: number;
}

export type ResourceWatchdogSpawnKind = 'investigation' | 'meta_reflection';

/**
 * Outcome of one evaluate-and-decide step. Pure: the service layer turns
 * `spawn` into a real launch and persists the resulting state.
 */
export type ResourceWatchdogDecision =
  | { action: 'idle'; sample: ResourceWatchdogSample }
  | {
      action: 'suppress_throttled';
      sample: ResourceWatchdogSample;
      triggers: ResourceWatchdogTrigger[];
      throttleRemainingMs: number;
      lastSpawnAt: string | null;
    }
  | {
      action: 'spawn';
      sample: ResourceWatchdogSample;
      triggers: ResourceWatchdogTrigger[];
      kind: ResourceWatchdogSpawnKind;
      /** Spawns already recorded in the rolling 24h window *before* this one. */
      spawnsInWindow: number;
    };

export interface ResourceWatchdogConfig {
  /** Master enable. Default false — operator must opt in. */
  enabled: boolean;
  /**
   * When the master switch is off, still allow a rate-limited investigation
   * spawn if soft-bound host pressure is already tripping (issue #2354).
   * Default true. Set `KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0` for page-only.
   */
  autoEnableOnPressure: boolean;
  /** Sampler cadence. Default 60s. */
  intervalMs: number;
  /** Swap used % at/above which we trigger. Default 50. `0` disables. */
  swapUsedPercentThreshold: number;
  /** Available memory (MiB) at/below which we trigger. Default 512. `0` disables. */
  memAvailableMbFloor: number;
  /**
   * Any single agent-family process count at/above this fires. Default 40.
   * `0` disables. Applied independently to claude/grok/codex (not dtach).
   */
  processCeiling: number;
  /** Orphan session count at/above which we trigger. Default 5. `0` disables. */
  orphanCeiling: number;
  /** Minimum ms between spawns (investigation or meta). Default 30 min. */
  throttleMs: number;
  /**
   * Rolling 24h spawn budget. When the count of prior spawns in the window is
   * ≥ this value, the next trigger spawns a meta-reflection task instead of
   * another investigation. Default 4.
   */
  spawnBudget24h: number;
  /** Rolling window length for the spawn budget. Default 24h. */
  spawnBudgetWindowMs: number;
  /** Working directory for the spawned investigation/meta task. */
  taskCwd: string;
  /** Absolute path to the persisted throttle, budget, and OOM-baseline state file. */
  stateFilePath: string;
  /** Absolute path to the JSONL audit trail. */
  auditLogPath: string;
}

/** Durable throttle, rolling-budget, and OOM-baseline state. */
export interface ResourceWatchdogPersistedState {
  schemaVersion: typeof RESOURCE_WATCHDOG_STATE_SCHEMA_VERSION;
  /** ISO timestamps of spawns still inside the rolling window (or recent enough to matter for throttle). */
  spawnTimestamps: string[];
  lastSpawnAt: string | null;
  lastSpawnKind: ResourceWatchdogSpawnKind | null;
  lastSpawnTaskId: string | null;
  lastTriggerAt: string | null;
  lastTriggerReasons: ResourceWatchdogTriggerReason[];
  lastMetaReflectionAt: string | null;
  /**
   * Last readable kernel `oom_kill` sample. Legacy schema-v1 files omit this
   * field; the state store normalizes that shape to `null` on load.
   */
  oomKillBaseline: ResourceWatchdogOomKillBaseline | null;
}

export type ResourceWatchdogAuditAction =
  | 'trigger'
  | 'suppress_throttled'
  | 'spawn'
  | 'spawn_failed'
  | 'disabled_skip'
  /** Actuator was off; soft-bound pressure auto-enabled one investigation cycle (#2354). */
  | 'auto_enable';

export interface ResourceWatchdogAuditRecord {
  schemaVersion: typeof RESOURCE_WATCHDOG_AUDIT_SCHEMA_VERSION;
  timestamp: string;
  action: ResourceWatchdogAuditAction;
  triggers?: ResourceWatchdogTrigger[];
  kind?: ResourceWatchdogSpawnKind;
  taskId?: string;
  error?: string;
  throttleRemainingMs?: number;
  spawnsInWindow?: number;
  sample?: {
    swapUsedPercent: number | null;
    memAvailableMb: number | null;
    oomKillTotal: number | null;
    processCounts: AgentFamilyProcessCounts;
    orphanSessionCount: number;
    terminalLeakCount: number;
  };
}

/** Cheap in-memory snapshot for `/api/health` (issue #1553: no I/O on read). */
export interface ResourceWatchdogHealthSnapshot {
  enabled: boolean;
  lastSampleAt: string | null;
  lastSample: {
    swapUsedPercent: number | null;
    memAvailableMb: number | null;
    oomKillTotal: number | null;
    processCounts: AgentFamilyProcessCounts;
    orphanSessionCount: number;
    terminalLeakCount: number;
  } | null;
  lastTriggerAt: string | null;
  lastTriggerReasons: ResourceWatchdogTriggerReason[];
  lastSpawnAt: string | null;
  lastSpawnKind: ResourceWatchdogSpawnKind | null;
  lastSpawnTaskId: string | null;
  spawnsIn24h: number;
  throttleOpen: boolean;
  throttleRemainingMs: number;
  lastDecision: ResourceWatchdogDecision['action'] | 'disabled' | 'auto_enable' | null;
  /**
   * Issue #2039 / #2354: true when the watchdog master switch is off *and* a
   * host-pressure gauge (currently `staleProcesses.dtach`) exceeds its soft
   * bound. When `autoEnableOnPressure` is true the service may still spawn a
   * rate-limited investigation; this flag stays true so operators see the
   * opt-in gap until they set `KOOKR_RESOURCE_WATCHDOG=1`.
   */
  pressureWhileDisabled: boolean;
  /** Human-readable detail when `pressureWhileDisabled` is true; else null. */
  pressureWhileDisabledReason: string | null;
  /**
   * Issue #2354: whether disabled-under-pressure auto-enable is armed.
   * Mirrors config so `/api/health` / doctor can show page-only vs actuator.
   */
  autoEnableOnPressure: boolean;
  /** Cached durable OOM comparison point; never performs I/O on the health path. */
  oomKillBaseline: (ResourceWatchdogOomKillBaseline & {
    /** Freshness relative to the health snapshot clock; null for an invalid timestamp. */
    ageMs: number | null;
    /** Whether this process loaded the baseline or observed it itself. */
    source: 'persisted_state' | 'runtime_sample';
  }) | null;
}
