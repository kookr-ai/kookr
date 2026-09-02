import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { AnomalySeverity } from '../shared/contracts/anomalies.js';
import type { CircuitBreakerSnapshot } from '../shared/contracts/circuit-breaker.js';
import type { OperationalAlertConfig } from './config.js';
import type {
  PersistenceHealthSnapshot,
  PersistenceHealthTarget,
  PersistenceTargetHealth,
} from '../core/persistence-health.js';
import type { ProviderHealthSnapshot } from '../shared/contracts/provider-health.js';

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
  | 'process_rss'
  | 'data_directory_disk_free'
  | 'provider_health';

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

/** Mutable edge-trigger state for one named circuit breaker. */
interface CircuitBreakerRuleState {
  /** Whether an alert is currently firing (awaiting recovery). */
  firing: boolean;
  /** Duration threshold that owns the current firing state. */
  configKey: string | null;
}

/** One windowed fallback-substitution increment: how many happened, and when. */
interface SubstitutionWindowEntry {
  atMs: number;
  delta: number;
}

/** Mutable edge-trigger state for the provider-health rule. */
interface ProviderHealthRuleState {
  /** Whether the standing provider-health alert is currently firing. */
  firing: boolean;
  /** Threshold tuple that owns the current firing state. */
  configKey: string | null;
  /** Last observed monotonic substitution counter, or `null` before the first sample. */
  lastSubstitutionCount: number | null;
  /** Recent substitution increments retained for windowed counting. */
  substitutionWindow: SubstitutionWindowEntry[];
}

/**
 * Edge-triggered evaluator for operational alerts on already-sampled host
 * signals (CPU, memory, event-loop delay, process RSS, data-directory disk
 * pressure).
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
  private readonly circuitBreakerStates = new Map<string, CircuitBreakerRuleState>();
  private readonly getProviderHealth: (() => ProviderHealthSnapshot) | null;
  private readonly providerHealthState: ProviderHealthRuleState = {
    firing: false,
    configKey: null,
    lastSubstitutionCount: null,
    substitutionWindow: [],
  };

  constructor(
    config: OperationalAlertConfig | (() => OperationalAlertConfig),
    getPersistenceHealth?: () => PersistenceHealthSnapshot,
    getProviderHealth?: () => ProviderHealthSnapshot,
  ) {
    this.getConfig = typeof config === 'function' ? config : () => config;
    this.getPersistenceHealth = getPersistenceHealth ?? null;
    this.getProviderHealth = getProviderHealth ?? null;
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
    this.states.set('process_rss', { consecutive: 0, firing: false, configKey: null });
    this.states.set('data_directory_disk_free', { consecutive: 0, firing: false, configKey: null });
    this.persistenceStates.set('task_state', { firing: false, configKey: null });
    this.persistenceStates.set('detection_stats', { firing: false, configKey: null });
  }

  /** Whether any host-resource, persistence-health, or provider-health rule is enabled. */
  hasEnabledRules(): boolean {
    const config = this.getConfig();
    return this.getPersistenceHealth !== null
      || this.rules.some((rule) => rule.threshold(config) > 0)
      || config.processRssBytes > 0
      || config.dataDirectoryFreePercent > 0
      || config.dataDirectoryFreeBytes > 0
      || config.circuitBreakerOpenMs > 0
      || (this.getProviderHealth !== null && this.providerHealthRulesEnabled(config));
  }

  /** Whether either provider-health sub-rule (substitution window / paused duration) is configured. */
  private providerHealthRulesEnabled(config: OperationalAlertConfig): boolean {
    const substitutionEnabled = config.providerFallbackSubstitutions > 0 && config.providerFallbackWindowMs > 0;
    const pausedEnabled = config.providerPausedMs > 0;
    return substitutionEnabled || pausedEnabled;
  }

  /**
   * Evaluate one sample and return any alert messages produced this tick
   * (zero, or one per rule that just crossed or just recovered).
   */
  evaluate(status: SystemResourceStatus): ServerMessage[] {
    const messages: ServerMessage[] = [];
    const config = this.getConfig();
    const sustainSamples = Math.max(1, Math.trunc(config.sustainSamples));
    // Issue #2771: on a stale fallback tick the host/server fields carry last
    // GOOD values (for display), not a fresh reading. Treat every
    // sampler-derived rule exactly like the "no data" case — hold both the
    // breach counter and any active alert — so a failed sample can neither
    // spuriously clear a firing alert nor advance one to a false breach.
    //
    // Persistence-, provider-, and circuit-breaker-health rules read from
    // separate live getters, so they keep RUNNING below. Note one seam: the
    // circuit-breaker and provider duration rules derive "now" from
    // `status.sampledAt`, which the service freezes to the last good sample
    // while stale. So their elapsed-duration thresholds (breaker-open ms,
    // provider-paused ms) stop advancing during a sampler outage — they
    // under-count rather than over-count (fail-safe: they cannot false-fire or
    // false-clear on their own state) and resume on the next fresh sample.
    const staleSample = status.stale != null;
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

      const value = staleSample ? null : rule.read(status);
      if (value === null || !Number.isFinite(value)) {
        // No data (or a stale fallback tick): leave both the counter and any
        // active alert untouched so transient sampler errors neither fire nor
        // clear.
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
    messages.push(...this.evaluateProcessRss(status, config, sustainSamples));
    messages.push(...this.evaluateDataDirectoryDiskPressure(status, config, sustainSamples));
    messages.push(...this.evaluatePersistenceHealth(sustainSamples));
    messages.push(...this.evaluateCircuitBreakers(status, config));
    messages.push(...this.evaluateProviderHealth(status, config));
    return messages;
  }

  /**
   * High-watermark rule on the Kookr process resident set size (RSS). Unlike
   * host `memoryUsedPercent`, this surfaces the supervisor process itself
   * "fattening" (e.g. retained snapshots/hook state) well before the host is
   * near OOM. Shares the scalar sustain-sample / edge-trigger contract, but
   * formats bytes as MiB/GiB and carries remediation hints.
   */
  private evaluateProcessRss(
    status: SystemResourceStatus,
    config: OperationalAlertConfig,
    sustainSamples: number,
  ): ServerMessage[] {
    const state = this.states.get('process_rss');
    if (!state) return [];
    const threshold = config.processRssBytes;
    if (threshold <= 0) {
      resetState(state);
      return [];
    }

    const configKey = `process-rss:${threshold}:${sustainSamples}`;
    if (state.configKey !== null && state.configKey !== configKey) {
      resetState(state);
    }
    state.configKey = configKey;

    // Issue #2771: a stale fallback tick carries last-good RSS (for display),
    // not a fresh reading — hold, like the "no data" case below.
    const staleSample = status.stale != null;
    const value = staleSample ? null : status.server.processRssBytes;
    if (value === null || !Number.isFinite(value)) {
      // No data: leave both the counter and any active alert untouched so
      // transient sampler errors neither fire nor clear.
      return [];
    }

    if (value >= threshold) {
      state.consecutive += 1;
      if (!state.firing && state.consecutive >= sustainSamples) {
        state.firing = true;
        return [buildProcessRssBreachAlert({ value, threshold, sustainSamples })];
      }
      return [];
    }

    state.consecutive = 0;
    if (state.firing) {
      state.firing = false;
      return [buildProcessRssRecoveryAlert({ value, threshold })];
    }
    return [];
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
    // Issue #2771: on a stale fallback tick the disk fields carry last-good
    // values, not a fresh probe — force "no data" so the rule holds instead of
    // breaching or recovering on stale readings.
    const staleSample = status.stale != null;
    const freePercent = staleSample ? null : disk.diskFreePercent;
    const freeBytes = staleSample ? null : disk.diskFreeBytes;
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

  private evaluateCircuitBreakers(
    status: SystemResourceStatus,
    config: OperationalAlertConfig,
  ): ServerMessage[] {
    const thresholdMs = config.circuitBreakerOpenMs;
    if (thresholdMs <= 0) {
      this.circuitBreakerStates.clear();
      return [];
    }

    const snapshots = status.circuitBreakers ?? [];
    const presentNames = new Set<string>();
    const messages: ServerMessage[] = [];
    const sampledAtMs = Date.parse(status.sampledAt);
    const nowMs = Number.isFinite(sampledAtMs) ? sampledAtMs : Date.now();
    const configKey = `circuit-breaker-open:${thresholdMs}`;

    for (const snapshot of snapshots) {
      presentNames.add(snapshot.name);
      const state = this.getCircuitBreakerState(snapshot.name);
      if (state.configKey !== null && state.configKey !== configKey) {
        resetCircuitBreakerState(state);
      }
      state.configKey = configKey;

      if (snapshot.state === 'open') {
        const openForMs = Math.max(0, nowMs - snapshot.lastStateChange);
        if (!state.firing && openForMs >= thresholdMs) {
          state.firing = true;
          messages.push(buildCircuitBreakerOpenAlert(snapshot, openForMs, thresholdMs));
        }
        continue;
      }

      if (state.firing) {
        state.firing = false;
        messages.push(buildCircuitBreakerRecoveryAlert(snapshot, thresholdMs));
      }
      if (!state.firing) {
        this.circuitBreakerStates.delete(snapshot.name);
      }
    }

    for (const name of this.circuitBreakerStates.keys()) {
      if (!presentNames.has(name)) {
        this.circuitBreakerStates.delete(name);
      }
    }

    return messages;
  }

  /**
   * Provider-health rule (issue #1897, WS1.5 of #1699). Fires a single standing
   * `warning` alert once the provider pool looks chronically degraded — either
   * `providerFallbackSubstitutions` fallback substitutions land inside a rolling
   * `providerFallbackWindowMs` window, OR the pool has been paused for at least
   * `providerPausedMs`. Clears with one `info` alert when both signals fall back
   * below their thresholds.
   *
   * Windowing is owned here so producers only maintain a monotonic substitution
   * counter (WS1.3): each tick, the positive delta of that counter is stamped
   * with the sample time and old entries slide out of the window. A counter
   * decrease (producer reset / process restart) rebases without emitting
   * phantom substitutions. Paused-duration reuses the circuit-breaker approach —
   * `sampledAt` minus the snapshot's `pausedSince` edge.
   *
   * Fail-open: a missing getter or a disabled config resets the rule and never
   * fires; a non-finite counter is ignored for that tick.
   */
  private evaluateProviderHealth(
    status: SystemResourceStatus,
    config: OperationalAlertConfig,
  ): ServerMessage[] {
    if (!this.getProviderHealth) return [];
    const state = this.providerHealthState;
    const substitutionThreshold = config.providerFallbackSubstitutions;
    const windowMs = config.providerFallbackWindowMs;
    const pausedThresholdMs = config.providerPausedMs;
    const substitutionRuleEnabled = substitutionThreshold > 0 && windowMs > 0;
    const pausedRuleEnabled = pausedThresholdMs > 0;

    if (!substitutionRuleEnabled && !pausedRuleEnabled) {
      resetProviderHealthState(state);
      return [];
    }

    const configKey = `provider-health:${substitutionThreshold}:${windowMs}:${pausedThresholdMs}`;
    if (state.configKey !== null && state.configKey !== configKey) {
      resetProviderHealthState(state);
    }
    state.configKey = configKey;

    const snapshot = this.getProviderHealth();
    const sampledAtMs = Date.parse(status.sampledAt);
    const nowMs = Number.isFinite(sampledAtMs) ? sampledAtMs : Date.now();

    let substitutionsInWindow = 0;
    if (substitutionRuleEnabled) {
      const count = snapshot.substitutionCount;
      if (Number.isFinite(count)) {
        if (state.lastSubstitutionCount === null || count < state.lastSubstitutionCount) {
          // First observation or a counter reset (producer restart): rebase to
          // the current value without counting the jump as substitutions.
          state.substitutionWindow = [];
        } else if (count > state.lastSubstitutionCount) {
          state.substitutionWindow.push({ atMs: nowMs, delta: count - state.lastSubstitutionCount });
        }
        state.lastSubstitutionCount = count;
        const cutoff = nowMs - windowMs;
        state.substitutionWindow = state.substitutionWindow.filter((entry) => entry.atMs >= cutoff);
        substitutionsInWindow = state.substitutionWindow.reduce((sum, entry) => sum + entry.delta, 0);
      }
    } else {
      state.substitutionWindow = [];
      state.lastSubstitutionCount = null;
    }

    let pausedForMs: number | null = null;
    if (pausedRuleEnabled && snapshot.pausedSince !== null && Number.isFinite(snapshot.pausedSince)) {
      pausedForMs = Math.max(0, nowMs - snapshot.pausedSince);
    }

    const substitutionBreached = substitutionRuleEnabled && substitutionsInWindow >= substitutionThreshold;
    const pausedBreached = pausedForMs !== null && pausedForMs >= pausedThresholdMs;
    const breached = substitutionBreached || pausedBreached;

    if (breached && !state.firing) {
      state.firing = true;
      return [buildProviderHealthBreachAlert({
        substitutionsInWindow,
        substitutionThreshold,
        windowMs,
        pausedForMs,
        pausedThresholdMs,
        substitutionBreached,
        pausedBreached,
      })];
    }
    if (!breached && state.firing) {
      state.firing = false;
      return [buildProviderHealthRecoveryAlert({
        substitutionThreshold,
        windowMs,
        pausedThresholdMs,
        substitutionRuleEnabled,
        pausedRuleEnabled,
      })];
    }
    return [];
  }

  private getCircuitBreakerState(name: string): CircuitBreakerRuleState {
    let state = this.circuitBreakerStates.get(name);
    if (!state) {
      state = { firing: false, configKey: null };
      this.circuitBreakerStates.set(name, state);
    }
    return state;
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

function resetCircuitBreakerState(state: CircuitBreakerRuleState): void {
  state.firing = false;
  state.configKey = null;
}

function resetProviderHealthState(state: ProviderHealthRuleState): void {
  state.firing = false;
  state.configKey = null;
  state.lastSubstitutionCount = null;
  state.substitutionWindow = [];
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
    operationalAlert: {
      key: `resource:${rule.metric}`,
      metric: rule.metric,
      state: 'fired',
    },
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
    operationalAlert: {
      key: `resource:${rule.metric}`,
      metric: rule.metric,
      state: 'recovered',
    },
  };
}

const PROCESS_RSS_REMEDIATION =
  'Inspect `/api/diagnostics/hook-ingestion` and the active task count for retained ' +
  'state, run `kookr maintenance prune --dry-run` to review conservative cleanup ' +
  'candidates, and clear finished tasks (clearCompleted) to release their retained snapshots.';

function buildProcessRssBreachAlert(args: {
  value: number;
  threshold: number;
  sustainSamples: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `High Kookr process RSS: ${formatBytes(args.value)} (threshold ${formatBytes(args.threshold)})`,
    details:
      `Sustained operational alert: Kookr process RSS at ${formatBytes(args.value)} for ` +
      `${args.sustainSamples} consecutive samples (threshold ${formatBytes(args.threshold)}). ` +
      PROCESS_RSS_REMEDIATION,
    severity,
    operationalAlert: {
      key: 'resource:process_rss',
      metric: 'process_rss',
      state: 'fired',
    },
  };
}

function buildProcessRssRecoveryAlert(args: {
  value: number;
  threshold: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered Kookr process RSS: ${formatBytes(args.value)} (below threshold ${formatBytes(args.threshold)})`,
    details:
      `Operational alert cleared: Kookr process RSS back below threshold ` +
      `(${formatBytes(args.threshold)}).`,
    severity,
    operationalAlert: {
      key: 'resource:process_rss',
      metric: 'process_rss',
      state: 'recovered',
    },
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
    operationalAlert: {
      key: 'resource:data_directory_disk_free',
      metric: 'data_directory_disk_free',
      state: 'fired',
    },
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
    operationalAlert: {
      key: 'resource:data_directory_disk_free',
      metric: 'data_directory_disk_free',
      state: 'recovered',
    },
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
    operationalAlert: {
      key: `persistence:${target.target}`,
      metric: `persistence:${target.target}`,
      state: 'fired',
    },
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
    operationalAlert: {
      key: `persistence:${target.target}`,
      metric: `persistence:${target.target}`,
      state: 'recovered',
    },
  };
}

function buildCircuitBreakerOpenAlert(
  snapshot: CircuitBreakerSnapshot,
  openForMs: number,
  thresholdMs: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Circuit breaker open: ${snapshot.name} has been OPEN for ${formatDuration(openForMs)}`,
    details:
      `Advisory operational alert: circuit breaker "${snapshot.name}" has remained OPEN for ` +
      `${formatDuration(openForMs)} (threshold ${formatDuration(thresholdMs)}). ` +
      `Calls protected by this breaker are degraded until it recovers or is manually rearmed.`,
    severity,
    operationalAlert: {
      key: `circuit_breaker:${snapshot.name}`,
      metric: 'circuit_breaker_open',
      state: 'fired',
    },
  };
}

function buildCircuitBreakerRecoveryAlert(
  snapshot: CircuitBreakerSnapshot,
  thresholdMs: number,
): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered circuit breaker: ${snapshot.name} is ${snapshot.state}`,
    details:
      `Operational alert cleared: circuit breaker "${snapshot.name}" is no longer OPEN ` +
      `(open-duration threshold ${formatDuration(thresholdMs)}).`,
    severity,
    operationalAlert: {
      key: `circuit_breaker:${snapshot.name}`,
      metric: 'circuit_breaker_open',
      state: 'recovered',
    },
  };
}

const PROVIDER_HEALTH_ALERT_KEY = 'provider:health';

function describeProviderSubstitutions(count: number, threshold: number, windowMs: number): string {
  return `${formatCount(count, 'fallback substitution')} within ${formatDuration(windowMs)} (threshold ${threshold})`;
}

function buildProviderHealthBreachAlert(args: {
  substitutionsInWindow: number;
  substitutionThreshold: number;
  windowMs: number;
  pausedForMs: number | null;
  pausedThresholdMs: number;
  substitutionBreached: boolean;
  pausedBreached: boolean;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'warning';
  const reasons: string[] = [];
  if (args.substitutionBreached) {
    reasons.push(
      describeProviderSubstitutions(args.substitutionsInWindow, args.substitutionThreshold, args.windowMs),
    );
  }
  if (args.pausedBreached && args.pausedForMs !== null) {
    reasons.push(`provider pool paused for ${formatDuration(args.pausedForMs)} (threshold ${formatDuration(args.pausedThresholdMs)})`);
  }
  const reasonText = reasons.join(' and ');
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Provider pool degraded: ${reasonText}`,
    details:
      `Standing operational alert: the provider pool is degraded — ${reasonText}. ` +
      'Repeated fallback substitutions or a sustained pause indicate a chronic upstream/provider ' +
      'outage that failover is masking. Inspect provider credentials/quota and the dispatch fallback ' +
      'chain; the alert clears automatically once substitutions fall out of the window and the pool resumes.',
    severity,
    operationalAlert: {
      key: PROVIDER_HEALTH_ALERT_KEY,
      metric: 'provider_health',
      state: 'fired',
    },
  };
}

function buildProviderHealthRecoveryAlert(args: {
  substitutionThreshold: number;
  windowMs: number;
  pausedThresholdMs: number;
  substitutionRuleEnabled: boolean;
  pausedRuleEnabled: boolean;
}): Extract<ServerMessage, { type: 'alert' }> {
  const severity: AnomalySeverity = 'info';
  // Only describe the sub-rules that are actually enabled, so a paused-only or
  // substitution-only configuration does not render a nonsensical "below 0 per
  // 0ms" clause for the disabled half.
  const parts: string[] = [];
  if (args.substitutionRuleEnabled) {
    parts.push(`fallback substitutions back below ${args.substitutionThreshold} per ${formatDuration(args.windowMs)}`);
  }
  if (args.pausedRuleEnabled) {
    parts.push(`pool pause below ${formatDuration(args.pausedThresholdMs)}`);
  }
  const detail = parts.join(' and ');
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered provider pool: back below degradation thresholds',
    details: `Operational alert cleared: provider pool healthy — ${detail}.`,
    severity,
    operationalAlert: {
      key: PROVIDER_HEALTH_ALERT_KEY,
      metric: 'provider_health',
      state: 'recovered',
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes * 10) / 10}m`;
  const hours = minutes / 60;
  return `${Math.round(hours * 10) / 10}h`;
}

export function createOperationalAlertEvaluator(
  config: OperationalAlertConfig | (() => OperationalAlertConfig),
  getPersistenceHealth?: () => PersistenceHealthSnapshot,
  getProviderHealth?: () => ProviderHealthSnapshot,
): OperationalAlertEvaluator {
  return new OperationalAlertEvaluator(config, getPersistenceHealth, getProviderHealth);
}
