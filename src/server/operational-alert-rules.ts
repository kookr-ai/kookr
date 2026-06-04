import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { AnomalySeverity } from '../shared/contracts/anomalies.js';
import type { OperationalAlertConfig } from './config.js';

/**
 * Synthetic agent id used for host-level operational alerts that are not tied
 * to any single agent session. The dashboard already accepts non-agent alert
 * ids (e.g. `'workspace'`), so this routes through the same alert channel.
 */
export const OPERATIONAL_ALERT_AGENT_ID = 'system';

export type OperationalAlertMetric = 'cpu' | 'memory' | 'event_loop_delay';

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
  /** Configured threshold; `<= 0` disables the rule. */
  threshold: number;
  /** Extract the metric value from a sample, or `null` when unavailable. */
  read(status: SystemResourceStatus): number | null;
}

/** Mutable per-rule edge-trigger state. */
interface RuleState {
  /** Consecutive breaching samples observed since the last reset. */
  consecutive: number;
  /** Whether an alert is currently firing (awaiting recovery). */
  firing: boolean;
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
  private readonly sustainSamples: number;
  private readonly states = new Map<OperationalAlertMetric, RuleState>();

  constructor(config: OperationalAlertConfig) {
    this.sustainSamples = Math.max(1, Math.trunc(config.sustainSamples));
    this.rules = [
      {
        metric: 'cpu',
        label: 'host CPU usage',
        unit: '%',
        threshold: config.cpuPercent,
        read: (status) => status.host.cpuUsagePercent,
      },
      {
        metric: 'memory',
        label: 'host memory usage',
        unit: '%',
        threshold: config.memoryPercent,
        read: (status) => status.host.memoryUsedPercent,
      },
      {
        metric: 'event_loop_delay',
        label: 'event-loop delay (p95)',
        unit: 'ms',
        threshold: config.eventLoopDelayMs,
        read: (status) => status.server.eventLoopDelayP95Ms,
      },
    ];
    for (const rule of this.rules) {
      this.states.set(rule.metric, { consecutive: 0, firing: false });
    }
  }

  /** Whether any rule is enabled (threshold `> 0`). */
  hasEnabledRules(): boolean {
    return this.rules.some((rule) => rule.threshold > 0);
  }

  /**
   * Evaluate one sample and return any alert messages produced this tick
   * (zero, or one per rule that just crossed or just recovered).
   */
  evaluate(status: SystemResourceStatus): ServerMessage[] {
    const messages: ServerMessage[] = [];
    for (const rule of this.rules) {
      if (rule.threshold <= 0) continue;
      const state = this.states.get(rule.metric);
      if (!state) continue;

      const value = rule.read(status);
      if (value === null || !Number.isFinite(value)) {
        // No data: leave both the counter and any active alert untouched so
        // transient sampler errors neither fire nor clear.
        continue;
      }

      if (value >= rule.threshold) {
        state.consecutive += 1;
        if (!state.firing && state.consecutive >= this.sustainSamples) {
          state.firing = true;
          messages.push(buildBreachAlert(rule, value, this.sustainSamples));
        }
      } else {
        state.consecutive = 0;
        if (state.firing) {
          state.firing = false;
          messages.push(buildRecoveryAlert(rule, value));
        }
      }
    }
    return messages;
  }
}

function formatValue(rule: RuleDefinition, value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${rule.unit}`;
}

function buildBreachAlert(
  rule: RuleDefinition,
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
  rule: RuleDefinition,
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

export function createOperationalAlertEvaluator(config: OperationalAlertConfig): OperationalAlertEvaluator {
  return new OperationalAlertEvaluator(config);
}
