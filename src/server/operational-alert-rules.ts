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

export type OperationalAlertMetric =
  | 'cpu'
  | 'memory'
  | 'event_loop_delay'
  | 'data_directory_disk_free';

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
 * signals (CPU, memory, event-loop delay, data-directory disk pressure).
 *
 * For scalar high-watermark rules it fires a single `warning` alert once the
 * metric stays at or above its threshold for `sustainSamples` consecutive
 * samples, and a single `info` "recovered" alert when the metric next drops
 * back below the threshold. Disk pressure uses the same edge-trigger state but
 * breaches when free space falls at or below either enabled floor. This avoids
 * per-tick alert spam while still surfacing sustained saturation through
 * Kookr's existing alert broadcast channel.
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
    this.states.set('data_directory_disk_free', { consecutive: 0, firing: false, configKey: null });
    this.persistenceStates.set('task_state', { firing: false, configKey: null });
    this.persistenceStates.set('detection_stats', { firing: false, configKey: null });
  }

  /** Whether any host-resource or persistence-health rule is enabled. */
  hasEnabledRules(): boolean {
    const config = this.getConfig();
    return this.getPersistenceHealth !== null
      || this.rules.some((rule) => rule.threshold(config) > 0)
      || config.dataDirectoryFreePercent > 0
      || config.dataDirectoryFreeBytes > 0;
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
    messages.push(...this.evaluateDataDirectoryDiskPressure(status, config, sustainSamples));
    messages.push(...this.evaluatePersistenceHealth(sustainSamples));
    return messages;
  }

  private evaluateDataDirectoryDiskPressure(
    status: SystemResourceStatus,
    config: OperationalAlertConfig,
    sustainSamples: number,
  ): ServerMessage[] {
    const state = this.states.get('data_directory_disk_free');
    if (!state) return [];
    const percentThreshold = config.dataDirectoryFreePercent;
    const bytesThreshold = config.dataDirectoryFreeBytes;
    if (percentThreshold <= 0 && bytesThreshold <= 0) {
      resetState(state);
      return [];
    }

    const configKey = `data-directory:${percentThreshold}:${bytesThreshold}:${sustainSamples}`;
    if (state.configKey !== null && state.configKey !== configKey) {
      resetState(state);
    }
    state.configKey = configKey;

    const disk = status.host.dataDirectory;
    const freePercent = disk.diskFreePercent;
    const freeBytes = disk.diskFreeBytes;
    const percentEnabled = percentThreshold > 0;
    const bytesEnabled = bytesThreshold > 0;
    const percentKnown = freePercent !== null && Number.isFinite(freePercent);
    const bytesKnown = freeBytes !== null && Number.isFinite(freeBytes);
    const percentBreached = percentEnabled && percentKnown && freePercent <= percentThreshold;
    const bytesBreached = bytesEnabled && bytesKnown && freeBytes <= bytesThreshold;
    const hasAnyEnabledReading = (percentEnabled && percentKnown) || (bytesEnabled && bytesKnown);

    if (!hasAnyEnabledReading) {
      // No data: preserve current state, matching the scalar fail-open rules.
      return [];
    }

    if (percentBreached || bytesBreached) {
      state.consecutive += 1;
      if (!state.firing && state.consecutive >= sustainSamples) {
        state.firing = true;
        return [buildDataDirectoryDiskBreachAlert({
          path: disk.path,
          freePercent,
          freeBytes,
          percentThreshold,
          bytesThreshold,
          sustainSamples,
        })];
      }
      return [];
    }

    const allEnabledReadingsKnown = (!percentEnabled || percentKnown) && (!bytesEnabled || bytesKnown);
    if (!allEnabledReadingsKnown) {
      return [];
    }

    state.consecutive = 0;
    if (state.firing) {
      state.firing = false;
      return [buildDataDirectoryDiskRecoveryAlert({
        path: disk.path,
        freePercent,
        freeBytes,
        percentThreshold,
        bytesThreshold,
      })];
    }
    return [];
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

function buildDataDirectoryDiskBreachAlert(args: {
  path: string | null;
  freePercent: number | null;
  freeBytes: number | null;
  percentThreshold: number;
  bytesThreshold: number;
  sustainSamples: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  const location = args.path ?? 'unknown data directory';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Low Kookr data-directory disk space: ${formatDiskFree(args.freePercent, args.freeBytes)}`,
    details:
      `Sustained operational alert: filesystem containing ${location} has ` +
      `${formatDiskFree(args.freePercent, args.freeBytes)} free for ` +
      `${args.sustainSamples} consecutive samples (threshold ${formatDiskThresholds(args.percentThreshold, args.bytesThreshold)}). ` +
      'Run `kookr maintenance prune --dry-run --dir <dataDir>` to inspect conservative cleanup candidates.',
    severity,
  };
}

function buildDataDirectoryDiskRecoveryAlert(args: {
  path: string | null;
  freePercent: number | null;
  freeBytes: number | null;
  percentThreshold: number;
  bytesThreshold: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  const location = args.path ?? 'unknown data directory';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered Kookr data-directory disk space: ${formatDiskFree(args.freePercent, args.freeBytes)}`,
    details:
      `Operational alert cleared: filesystem containing ${location} is back above ` +
      `the enabled low-space threshold(s) (${formatDiskThresholds(args.percentThreshold, args.bytesThreshold)}).`,
    severity,
  };
}

function formatDiskFree(freePercent: number | null, freeBytes: number | null): string {
  const percent = freePercent === null ? '--' : `${Math.round(freePercent * 10) / 10}%`;
  return `${percent} / ${formatBytes(freeBytes)}`;
}

function formatDiskThresholds(percentThreshold: number, bytesThreshold: number): string {
  const parts: string[] = [];
  if (percentThreshold > 0) parts.push(`<= ${percentThreshold}% free`);
  if (bytesThreshold > 0) parts.push(`<= ${formatBytes(bytesThreshold)} free`);
  return parts.join(' or ');
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '--';
  const gib = bytes / 1_073_741_824;
  if (gib >= 1) return `${Math.round(gib * 10) / 10} GiB`;
  const mib = bytes / 1_048_576;
  return `${Math.round(mib)} MiB`;
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
