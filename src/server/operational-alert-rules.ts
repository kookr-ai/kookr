import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { AnomalySeverity } from '../shared/contracts/anomalies.js';
import type { OperationalAlertConfig } from './config.js';
import type {
  PersistenceHealthSnapshot,
  PersistenceHealthTarget,
  PersistenceTargetHealth,
} from '../core/persistence-health.js';

/**
 * Synthetic agent id used for host-level operational alerts that are not tied
 * to any single agent session. The dashboard already accepts non-agent alert
 * ids (e.g. `'workspace'`), so this routes through the same alert channel.
 */
export const OPERATIONAL_ALERT_AGENT_ID = 'system';

export type OperationalAlertMetric = 'cpu' | 'memory' | 'event_loop_delay';

const PERSISTENCE_TARGET_LABELS: Record<PersistenceHealthTarget, string> = {
  task_state: 'task-state',
  detection_stats: 'detection-stats',
};

/**
 * Static description of one operational alert rule: how to read its value out
 * of an already-sampled `SystemResourceStatus`, and how to render it.
 */
interface RuleDefinition {
  metric: OperationalAlertMetric;
  /** Human-readable name used in alert text. */
  label: string;
  /** Unit suffix used in alert text (e.g. `%`, `ms`). */
  unit: string;
  /** Read the configured threshold; `<= 0` disables the rule. */
  threshold(config: OperationalAlertConfig): number;
  /** Extract the metric value from a sample, or `null` when unavailable. */
  read(status: SystemResourceStatus): number | null;
}

interface ActiveRuleDefinition extends Omit<RuleDefinition, 'threshold'> {
  threshold: number;
}

/** Mutable per-rule edge-trigger state. */
interface RuleState {
  /** Consecutive breaching samples observed since the last reset. */
  consecutive: number;
  /** Whether an alert is currently firing (awaiting recovery). */
  firing: boolean;
  /** Threshold/sustain tuple that owns the current streak. */
  configKey: string | null;
}

/** Mutable edge-trigger state for persistence health, whose failure count is owned by PersistenceHealthTracker. */
interface PersistenceRuleState {
  /** Whether an alert is currently firing (awaiting recovery). */
  firing: boolean;
  /** Sustain tuple that owns the current firing state. */
  configKey: string | null;
}

/**
 * Edge-triggered evaluator for operational alerts on already-sampled host
 * signals (CPU, memory, event-loop delay).
 *
 * For each rule it fires a single `warning` alert once the metric stays at or
 * above its threshold for `sustainSamples` consecutive samples, and a single
 * `info` "recovered" alert when the metric next drops back below the
 * threshold. This avoids per-tick alert spam while still surfacing sustained
 * saturation through Kookr's existing alert broadcast channel.
 *
 * Fail-open behaviour:
 * - A rule whose threshold is `<= 0` is disabled and never evaluated.
 * - A `null`/non-finite metric (sampler warming up or a sampler error
 *   producing an unavailable snapshot) is treated as "no data": it neither
 *   advances the breach counter nor clears an active alert, so transient
 *   sampler errors never spam or spuriously clear.
 */
export class OperationalAlertEvaluator {
  private readonly rules: RuleDefinition[];
  private readonly getConfig: () => OperationalAlertConfig;
  private readonly states = new Map<OperationalAlertMetric, RuleState>();
  private readonly getPersistenceHealth: (() => PersistenceHealthSnapshot) | null;
  private readonly persistenceStates = new Map<PersistenceHealthTarget, PersistenceRuleState>();

  constructor(
    config: OperationalAlertConfig | (() => OperationalAlertConfig),
    getPersistenceHealth?: () => PersistenceHealthSnapshot,
  ) {
    this.getConfig = typeof config === 'function' ? config : () => config;
    this.getPersistenceHealth = getPersistenceHealth ?? null;
    this.rules = [
      {
        metric: 'cpu',
        label: 'host CPU usage',
        unit: '%',
        threshold: (current) => current.cpuPercent,
        read: (status) => status.host.cpuUsagePercent,
      },
      {
        metric: 'memory',
        label: 'host memory usage',
        unit: '%',
        threshold: (current) => current.memoryPercent,
        read: (status) => status.host.memoryUsedPercent,
      },
      {
        metric: 'event_loop_delay',
        label: 'event-loop delay (p95)',
        unit: 'ms',
        threshold: (current) => current.eventLoopDelayMs,
        read: (status) => status.server.eventLoopDelayP95Ms,
      },
    ];
    for (const rule of this.rules) {
      this.states.set(rule.metric, { consecutive: 0, firing: false, configKey: null });
    }
    this.persistenceStates.set('task_state', { firing: false, configKey: null });
    this.persistenceStates.set('detection_stats', { firing: false, configKey: null });
  }

  /** Whether any host-resource or persistence-health rule is enabled. */
  hasEnabledRules(): boolean {
    const config = this.getConfig();
    return this.getPersistenceHealth !== null || this.rules.some((rule) => rule.threshold(config) > 0);
  }

  /**
   * Evaluate one sample and return any alert messages produced this tick
   * (zero, or one per rule that just crossed or just recovered).
   */
  evaluate(status: SystemResourceStatus): ServerMessage[] {
    const messages: ServerMessage[] = [];
    const config = this.getConfig();
    const sustainSamples = Math.max(1, Math.trunc(config.sustainSamples));
    for (const rule of this.rules) {
      const threshold = rule.threshold(config);
      const state = this.states.get(rule.metric);
      if (!state) continue;
      if (threshold <= 0) {
        resetState(state);
        continue;
      }
      const configKey = `${threshold}:${sustainSamples}`;
      if (state.configKey !== null && state.configKey !== configKey) {
        resetState(state);
      }
      state.configKey = configKey;
      const activeRule: ActiveRuleDefinition = { ...rule, threshold };

      const value = rule.read(status);
      if (value === null || !Number.isFinite(value)) {
        // No data: leave both the counter and any active alert untouched so
        // transient sampler errors neither fire nor clear.
        continue;
      }

      if (value >= threshold) {
        state.consecutive += 1;
        if (!state.firing && state.consecutive >= sustainSamples) {
          state.firing = true;
          messages.push(buildBreachAlert(activeRule, value, sustainSamples));
        }
      } else {
        state.consecutive = 0;
        if (state.firing) {
          state.firing = false;
          messages.push(buildRecoveryAlert(activeRule, value));
        }
      }
    }
    messages.push(...this.evaluatePersistenceHealth(sustainSamples));
    return messages;
  }

  private evaluatePersistenceHealth(sustainSamples: number): ServerMessage[] {
    if (!this.getPersistenceHealth) return [];
    const messages: ServerMessage[] = [];
    const snapshot = this.getPersistenceHealth();

    for (const target of Object.values(snapshot.targets)) {
      const state = this.persistenceStates.get(target.target);
      if (!state) continue;
      const configKey = `persistence:${sustainSamples}`;
      if (state.configKey !== null && state.configKey !== configKey) {
        resetPersistenceState(state);
      }
      state.configKey = configKey;

      const activeFailure = target.consecutiveFailures > 0;
      const shouldFire = activeFailure && (
        target.consecutiveFailures >= sustainSamples || target.lastError?.hard === true
      );
      if (shouldFire && !state.firing) {
        state.firing = true;
        messages.push(buildPersistenceBreachAlert(target, sustainSamples));
        continue;
      }
      if (!activeFailure) {
        if (state.firing) {
          state.firing = false;
          messages.push(buildPersistenceRecoveryAlert(target));
        }
      }
    }
    return messages;
  }
}

function resetState(state: RuleState): void {
  state.consecutive = 0;
  state.firing = false;
  state.configKey = null;
}

function resetPersistenceState(state: PersistenceRuleState): void {
  state.firing = false;
  state.configKey = null;
}

function formatValue(rule: Pick<ActiveRuleDefinition, 'unit'>, value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${rule.unit}`;
}

function buildBreachAlert(
  rule: ActiveRuleDefinition,
  value: number,
  sustainSamples: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `High ${rule.label}: ${formatValue(rule, value)} (threshold ${rule.threshold}${rule.unit})`,
    details:
      `Sustained operational alert: ${rule.metric} at ${formatValue(rule, value)} ` +
      `for ${sustainSamples} consecutive samples (threshold ${rule.threshold}${rule.unit}).`,
    severity,
  };
}

function buildRecoveryAlert(
  rule: ActiveRuleDefinition,
  value: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered ${rule.label}: ${formatValue(rule, value)} (below threshold ${rule.threshold}${rule.unit})`,
    details: `Operational alert cleared: ${rule.metric} back below threshold (${rule.threshold}${rule.unit}).`,
    severity,
  };
}

function buildPersistenceBreachAlert(
  target: PersistenceTargetHealth,
  sustainSamples: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  const label = PERSISTENCE_TARGET_LABELS[target.target];
  const code = target.lastError?.code ? ` (${target.lastError.code})` : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Persistence failure: ${label} save failed ${formatCount(target.consecutiveFailures, 'consecutive time')}`,
    details:
      `${label} persistence has failed ${formatCount(target.consecutiveFailures, 'consecutive save attempt')}, ` +
      `${formatCount(target.totalFailures, 'total failure')}. Alert threshold is ` +
      `${formatCount(sustainSamples, 'consecutive failure')}, with ENOSPC/EACCES/EROFS/EDQUOT firing immediately. ` +
      `Last error${code}: ${target.lastError?.message ?? 'unknown'}`,
    severity,
  };
}

function formatCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function buildPersistenceRecoveryAlert(
  target: PersistenceTargetHealth,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  const label = PERSISTENCE_TARGET_LABELS[target.target];
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered ${label} persistence`,
    details:
      `${label} persistence recovered after ${formatCount(target.totalFailures, 'total failure')}. ` +
      `Last successful save: ${target.lastSuccessAt ?? 'unknown'}.`,
    severity,
  };
}

export function createOperationalAlertEvaluator(
  config: OperationalAlertConfig | (() => OperationalAlertConfig),
  getPersistenceHealth?: () => PersistenceHealthSnapshot,
): OperationalAlertEvaluator {
  return new OperationalAlertEvaluator(config, getPersistenceHealth);
}
