import type { Anomaly } from './types.js';

/**
 * Per-task breach state. Each level fires at most once until reset().
 */
interface BudgetState {
  warned: boolean;
  critical: boolean;
}

/**
 * Reactive cost threshold checker.
 *
 * Compares actual costUsd from TokenTracker against a configurable warning
 * threshold and emits a `budget_exceeded` anomaly the first time a task
 * crosses the warning level (severity `warning`) and again when it crosses
 * 2x the threshold (severity `critical`).
 *
 * This is REACTIVE, not preventive. Token usage is observed via transcript
 * JSONL after API calls complete, and the token scan runs on an interval,
 * so an agent may overshoot the threshold by one expensive turn before the
 * alert fires. The explanation text flags this explicitly.
 */
export class BudgetChecker {
  private states = new Map<string, BudgetState>();

  constructor(private readonly thresholdUsd: number) {}

  /** Current warning threshold in USD. 0 or negative disables the check. */
  getThresholdUsd(): number {
    return this.thresholdUsd;
  }

  /**
   * Evaluate a task's current cost against the threshold.
   *
   * Returns a new `Anomaly` only on the FIRST breach of each level. Later
   * calls for the same task return null until `reset()` is called. This
   * matches the issue #98 contract: alert the developer once per level,
   * not on every tick.
   *
   * A single call can fire at most once. If the cost jumps past both the
   * warning and the critical thresholds between ticks, the critical alert
   * is preferred — it implicitly marks the warning level as delivered so
   * we do not enqueue a duplicate warning on the next tick.
   */
  check(
    taskId: string,
    agentId: string,
    costUsd: number,
    now = new Date(),
    thresholdUsd = this.thresholdUsd,
  ): Anomaly | null {
    if (thresholdUsd <= 0) return null;

    let state = this.states.get(taskId);
    if (!state) {
      state = { warned: false, critical: false };
      this.states.set(taskId, state);
    }

    const criticalThresholdUsd = thresholdUsd * 2;

    if (!state.critical && costUsd >= criticalThresholdUsd) {
      state.critical = true;
      state.warned = true;
      return {
        agentId,
        type: 'budget_exceeded',
        severity: 'critical',
        explanation: buildExplanation(costUsd, criticalThresholdUsd, 'critical'),
        detectedAt: now,
      };
    }

    if (!state.warned && costUsd >= thresholdUsd) {
      state.warned = true;
      return {
        agentId,
        type: 'budget_exceeded',
        severity: 'warning',
        explanation: buildExplanation(costUsd, thresholdUsd, 'warning'),
        detectedAt: now,
      };
    }

    return null;
  }

  /** Forget per-task state (call on task deletion). */
  reset(taskId: string): void {
    this.states.delete(taskId);
  }

  /** Inspect whether a task has already fired a given level (for tests). */
  hasFired(taskId: string): { warning: boolean; critical: boolean } {
    const state = this.states.get(taskId);
    return { warning: state?.warned ?? false, critical: state?.critical ?? false };
  }
}

function buildExplanation(
  costUsd: number,
  thresholdUsd: number,
  level: 'warning' | 'critical',
): string {
  const label = level === 'critical' ? '2x threshold' : 'threshold';
  return (
    `Task cost $${costUsd.toFixed(2)} exceeds ${label} ($${thresholdUsd.toFixed(2)}). `
    + `Reactive alert — may overshoot by one turn.`
  );
}

/**
 * Parse `KOOKR_BUDGET_WARN_USD` from process.env.
 * Returns the default when the var is unset, blank, or unparseable.
 * Negative values are clamped to 0 (disables the check).
 */
export function readBudgetThresholdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaultUsd = 25,
): number {
  const raw = env.KOOKR_BUDGET_WARN_USD;
  if (raw == null || raw.trim() === '') return defaultUsd;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultUsd;
  return parsed < 0 ? 0 : parsed;
}
