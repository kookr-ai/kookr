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
