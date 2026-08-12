/**
 * Pure resource-watchdog evaluation (issue #1724).
 *
 * Inputs: a host sample, the previous sample (for oom_kill delta), persisted
 * spawn timestamps, config, and a clock. Output: a Decision. No I/O.
 */

import type {
  ResourceWatchdogConfig,
  ResourceWatchdogDecision,
  ResourceWatchdogPersistedState,
  ResourceWatchdogSample,
  ResourceWatchdogSpawnKind,
  ResourceWatchdogTrigger,
} from './resource-watchdog-types.js';

export interface EvaluateResourceWatchdogInput {
  sample: ResourceWatchdogSample;
  /** Previous sample's oom_kill total — `null` on first tick or when unreadable. */
  previousOomKillTotal: number | null;
  state: ResourceWatchdogPersistedState;
  config: Pick<
    ResourceWatchdogConfig,
    | 'enabled'
    | 'swapUsedPercentThreshold'
    | 'memAvailableMbFloor'
    | 'processCeiling'
    | 'orphanCeiling'
    | 'throttleMs'
    | 'spawnBudget24h'
    | 'spawnBudgetWindowMs'
  >;
  nowMs: number;
}

/**
 * Collect every active trigger for this sample. Empty ⇒ no pressure.
 * `oom_kill` delta fires on any positive increment, independent of thresholds.
 */
export function collectTriggers(
  sample: ResourceWatchdogSample,
  previousOomKillTotal: number | null,
  config: EvaluateResourceWatchdogInput['config'],
): ResourceWatchdogTrigger[] {
  const triggers: ResourceWatchdogTrigger[] = [];

  if (
    previousOomKillTotal !== null
    && sample.oomKillTotal !== null
    && sample.oomKillTotal > previousOomKillTotal
  ) {
    const delta = sample.oomKillTotal - previousOomKillTotal;
    triggers.push({
      reason: 'oom_kill_delta',
      detail: `oom_kill increased by ${delta} (${previousOomKillTotal} → ${sample.oomKillTotal})`,
      observed: delta,
      threshold: 0,
    });
  }

  if (
    config.swapUsedPercentThreshold > 0
    && sample.swapUsedPercent !== null
    && sample.swapUsedPercent >= config.swapUsedPercentThreshold
  ) {
    triggers.push({
      reason: 'swap_percent',
      detail: `swap used ${sample.swapUsedPercent.toFixed(1)}% ≥ ${config.swapUsedPercentThreshold}%`,
      observed: sample.swapUsedPercent,
      threshold: config.swapUsedPercentThreshold,
    });
  }

  if (
    config.memAvailableMbFloor > 0
    && sample.memAvailableMb !== null
    && sample.memAvailableMb <= config.memAvailableMbFloor
  ) {
    triggers.push({
      reason: 'mem_available',
      detail: `MemAvailable ${sample.memAvailableMb.toFixed(0)} MiB ≤ ${config.memAvailableMbFloor} MiB`,
      observed: sample.memAvailableMb,
      threshold: config.memAvailableMbFloor,
    });
  }

  if (config.processCeiling > 0) {
    const families: Array<keyof ResourceWatchdogSample['processCounts']> = [
      'claude',
      'grok',
      'codex',
    ];
    for (const family of families) {
      const count = sample.processCounts[family];
      if (count >= config.processCeiling) {
        triggers.push({
          reason: 'process_ceiling',
          detail: `${family} process count ${count} ≥ ceiling ${config.processCeiling}`,
          observed: count,
          threshold: config.processCeiling,
        });
      }
    }
  }

  if (
    config.orphanCeiling > 0
    && sample.orphanSessionCount >= config.orphanCeiling
  ) {
    triggers.push({
      reason: 'orphan_ceiling',
      detail: `orphan sessions ${sample.orphanSessionCount} ≥ ceiling ${config.orphanCeiling}`,
      observed: sample.orphanSessionCount,
      threshold: config.orphanCeiling,
    });
  }

  return triggers;
}

/** Count spawns whose timestamps fall inside the rolling window ending at `nowMs`. */
export function countSpawnsInWindow(
  spawnTimestamps: readonly string[],
  nowMs: number,
  windowMs: number,
): number {
  const cutoff = nowMs - windowMs;
  let count = 0;
  for (const ts of spawnTimestamps) {
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms >= cutoff) count += 1;
  }
  return count;
}

/** Prune spawn timestamps older than the larger of throttle and budget windows. */
export function pruneSpawnTimestamps(
  spawnTimestamps: readonly string[],
  nowMs: number,
  retainMs: number,
): string[] {
  const cutoff = nowMs - retainMs;
  return spawnTimestamps.filter((ts) => {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) && ms >= cutoff;
  });
}

/**
 * Decide what the watchdog should do for this sample.
 *
 * Order:
 * 1. disabled → idle (caller may skip sampling entirely when disabled)
 * 2. no triggers → idle
 * 3. within throttle → suppress_throttled
 * 4. else spawn (meta_reflection when 24h budget already exhausted)
 */
export function evaluateResourceWatchdog(
  input: EvaluateResourceWatchdogInput,
): ResourceWatchdogDecision {
  const { sample, previousOomKillTotal, state, config, nowMs } = input;

  if (!config.enabled) {
    return { action: 'idle', sample };
  }

  const triggers = collectTriggers(sample, previousOomKillTotal, config);
  if (triggers.length === 0) {
    return { action: 'idle', sample };
  }

  const lastSpawnMs = state.lastSpawnAt ? Date.parse(state.lastSpawnAt) : NaN;
  if (Number.isFinite(lastSpawnMs)) {
    const elapsed = nowMs - lastSpawnMs;
    if (elapsed < config.throttleMs) {
      return {
        action: 'suppress_throttled',
        sample,
        triggers,
        throttleRemainingMs: Math.max(0, config.throttleMs - elapsed),
        lastSpawnAt: state.lastSpawnAt,
      };
    }
  }

  const spawnsInWindow = countSpawnsInWindow(
    state.spawnTimestamps,
    nowMs,
    config.spawnBudgetWindowMs,
  );

  // Once the rolling budget is exhausted, spawn at most one meta-reflection
  // per window. Further pressure stays throttled/idle for investigation until
  // the window slides — chronic meta thrash would worsen the resource problem.
  if (spawnsInWindow >= config.spawnBudget24h) {
    const metaInWindow = metaReflectionInWindow(
      state,
      nowMs,
      config.spawnBudgetWindowMs,
    );
    if (metaInWindow) {
      return {
        action: 'suppress_throttled',
        sample,
        triggers,
        // Reuse throttle semantics: quiet until the standard throttle elapses
        // (operator can still read health / audit for chronic pressure).
        throttleRemainingMs: config.throttleMs,
        lastSpawnAt: state.lastSpawnAt,
      };
    }
    return {
      action: 'spawn',
      sample,
      triggers,
      kind: 'meta_reflection',
      spawnsInWindow,
    };
  }

  return {
    action: 'spawn',
    sample,
    triggers,
    kind: 'investigation',
    spawnsInWindow,
  };
}

/** True when a meta-reflection spawn already sits inside the rolling window. */
export function metaReflectionInWindow(
  state: ResourceWatchdogPersistedState,
  nowMs: number,
  windowMs: number,
): boolean {
  if (!state.lastMetaReflectionAt) return false;
  const ms = Date.parse(state.lastMetaReflectionAt);
  if (!Number.isFinite(ms)) return false;
  return ms >= nowMs - windowMs;
}

/**
 * Default soft bound for `staleProcesses.dtach.count` on the
 * `pressureWhileDisabled` health signal (issue #2039) and the disabled-path
 * auto-enable trigger (issue #2354). Lower than the agent-family process
 * ceiling (40) because a live prod observation fired at ~21 dtach processes
 * while continuous monitoring was off.
 */
export const DEFAULT_DTACH_PRESSURE_SOFT_BOUND = 20;

/**
 * Pressure signal when the actuator master switch is off (issue #2039 / #2354).
 *
 * When `KOOKR_RESOURCE_WATCHDOG` is unset the full sampler stays off, so host
 * pressure can sit on `/api/health` without continuous monitoring. This pure
 * helper folds an already-cached external gauge (`staleProcesses.dtach`) into
 * the resourceWatchdog health block so operators/sentinel see
 * `pressureWhileDisabled=true`.
 *
 * Soft-bound semantics match other watchdog thresholds: `softBound <= 0`
 * disables the check. With `autoEnableOnPressure` (default true) the service
 * may still take a rate-limited investigation spawn — see
 * {@link evaluateDisabledPressureAutoEnable}.
 */
export function evaluatePressureWhileDisabled(input: {
  enabled: boolean;
  /** Cached `staleProcesses.dtach.count`; null when the gauge is unavailable. */
  dtachCount: number | null;
  /**
   * Soft bound for the dtach gauge. Defaults to
   * {@link DEFAULT_DTACH_PRESSURE_SOFT_BOUND} when the caller omits it.
   * `0` disables the check.
   */
  softBound?: number;
  /**
   * Whether disabled-under-pressure auto-enable is armed. Affects the reason
   * string only (visibility). Defaults to true to match config default.
   */
  autoEnableOnPressure?: boolean;
}): { pressureWhileDisabled: boolean; pressureWhileDisabledReason: string | null } {
  const softBound = input.softBound ?? DEFAULT_DTACH_PRESSURE_SOFT_BOUND;
  if (input.enabled) {
    return { pressureWhileDisabled: false, pressureWhileDisabledReason: null };
  }
  if (softBound <= 0 || input.dtachCount === null) {
    return { pressureWhileDisabled: false, pressureWhileDisabledReason: null };
  }
  if (input.dtachCount < softBound) {
    return { pressureWhileDisabled: false, pressureWhileDisabledReason: null };
  }
  const autoEnable = input.autoEnableOnPressure !== false;
  const actionHint = autoEnable
    ? 'auto-enable will attempt a rate-limited investigation spawn '
      + '(set KOOKR_RESOURCE_WATCHDOG=1 for continuous monitoring, or '
      + 'KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0 for page-only)'
    : 'host-pressure auto-investigation will not spawn '
      + '(set KOOKR_RESOURCE_WATCHDOG=1 to enable, or leave '
      + 'KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0 for page-only)';
  return {
    pressureWhileDisabled: true,
    pressureWhileDisabledReason:
      `staleProcesses.dtach.count=${input.dtachCount} ≥ soft bound ${softBound} ` +
      `while resourceWatchdog is disabled; ${actionHint}`,
  };
}

/** Build the synthetic trigger used when soft-bound dtach pressure fires auto-enable. */
export function buildDtachSoftBoundTrigger(
  dtachCount: number,
  softBound: number = DEFAULT_DTACH_PRESSURE_SOFT_BOUND,
): ResourceWatchdogTrigger {
  return {
    reason: 'dtach_soft_bound',
    detail:
      `staleProcesses.dtach.count=${dtachCount} ≥ soft bound ${softBound} ` +
      'while resourceWatchdog master switch is off (auto-enable path, issue #2354)',
    observed: dtachCount,
    threshold: softBound,
  };
}

/**
 * Decision table when the master switch is off (issue #2354).
 *
 * Order:
 * 1. auto-enable off or no soft-bound pressure → stay_disabled
 * 2. within throttle → suppress_throttled (still records an explicit decision)
 * 3. 24h budget exhausted → meta_reflection once, else suppress
 * 4. else spawn investigation (rate-limited)
 *
 * Pure: no I/O. Caller arms throttle/state and launches on `spawn`.
 */
export type DisabledPressureAutoEnableDecision =
  | { action: 'stay_disabled' }
  | {
      action: 'suppress_throttled';
      triggers: ResourceWatchdogTrigger[];
      throttleRemainingMs: number;
      lastSpawnAt: string | null;
    }
  | {
      action: 'spawn';
      triggers: ResourceWatchdogTrigger[];
      kind: ResourceWatchdogSpawnKind;
      spawnsInWindow: number;
    };

export function evaluateDisabledPressureAutoEnable(input: {
  enabled: boolean;
  autoEnableOnPressure: boolean;
  dtachCount: number | null;
  softBound?: number;
  state: ResourceWatchdogPersistedState;
  throttleMs: number;
  spawnBudget24h: number;
  spawnBudgetWindowMs: number;
  nowMs: number;
}): DisabledPressureAutoEnableDecision {
  if (input.enabled || !input.autoEnableOnPressure) {
    return { action: 'stay_disabled' };
  }
  const softBound = input.softBound ?? DEFAULT_DTACH_PRESSURE_SOFT_BOUND;
  const pressure = evaluatePressureWhileDisabled({
    enabled: false,
    dtachCount: input.dtachCount,
    softBound,
    autoEnableOnPressure: true,
  });
  if (!pressure.pressureWhileDisabled || input.dtachCount === null) {
    return { action: 'stay_disabled' };
  }

  const triggers = [buildDtachSoftBoundTrigger(input.dtachCount, softBound)];
  const lastSpawnMs = input.state.lastSpawnAt ? Date.parse(input.state.lastSpawnAt) : NaN;
  if (Number.isFinite(lastSpawnMs)) {
    const elapsed = input.nowMs - lastSpawnMs;
    if (elapsed < input.throttleMs) {
      return {
        action: 'suppress_throttled',
        triggers,
        throttleRemainingMs: Math.max(0, input.throttleMs - elapsed),
        lastSpawnAt: input.state.lastSpawnAt,
      };
    }
  }

  const spawnsInWindow = countSpawnsInWindow(
    input.state.spawnTimestamps,
    input.nowMs,
    input.spawnBudgetWindowMs,
  );

  if (spawnsInWindow >= input.spawnBudget24h) {
    if (metaReflectionInWindow(input.state, input.nowMs, input.spawnBudgetWindowMs)) {
      return {
        action: 'suppress_throttled',
        triggers,
        throttleRemainingMs: input.throttleMs,
        lastSpawnAt: input.state.lastSpawnAt,
      };
    }
    return {
      action: 'spawn',
      triggers,
      kind: 'meta_reflection',
      spawnsInWindow,
    };
  }

  return {
    action: 'spawn',
    triggers,
    kind: 'investigation',
    spawnsInWindow,
  };
}
