import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { CircuitBreakerSnapshot } from '../shared/contracts/circuit-breaker.js';
import { RESOURCE_STATUS_INTERVAL_MS } from './system-resource-sampler.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

const DEFAULT_OPERATIONAL_ALERT_HISTORY_LIMIT = 100;

export interface ResourceStatusSampler {
  start(): void;
  stop(): void;
  sample(expectedAtMs?: number | null): SystemResourceStatus;
}

/**
 * Edge-triggered evaluator that turns an already-sampled resource status into
 * zero or more alert messages. Decoupled to an interface so the service does
 * not depend on the concrete rules implementation.
 */
export interface ResourceAlertEvaluator {
  evaluate(status: SystemResourceStatus): ServerMessage[];
}

export interface ResourceStatusServiceDeps {
  sampler: ResourceStatusSampler;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Optional operational-alert evaluator fed each broadcast sample. */
  alertEvaluator?: ResourceAlertEvaluator;
  /** Optional provider for dependency breaker snapshots sampled with each resource tick. */
  getCircuitBreakerSnapshots?: () => CircuitBreakerSnapshot[];
  /**
   * Fed the freshly sampled `server.eventLoopDelayP95Ms` on every tick (#1725,
   * #1785). This is the SAME sampler that already powers the #1590 admission
   * guard — wiring it here lets the dashboard WS load-shed gate and the
   * non-critical timer pause gate reuse the measurement rather than standing
   * up a second `monitorEventLoopDelay`. Called even when the sample is
   * `null` (sampler unavailable) so a consumer's own streak logic sees every
   * tick.
   */
  onEventLoopDelaySample?: (delayMs: number | null) => void;
  intervalMs?: number;
  operationalAlertHistoryLimit?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  logger?: Pick<typeof console, 'warn'>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface OperationalAlertHistoryEntry {
  id: number;
  key: string;
  metric: string;
  firstFiredAt: string | null;
  lastFiredAt: string | null;
  recoveredAt: string | null;
  active: boolean;
  fireCount: number;
  alert: AlertMessage;
  recoveryAlert: AlertMessage | null;
}

export interface OperationalAlertHistorySnapshot {
  generatedAt: string;
  limit: number;
  alerts: OperationalAlertHistoryEntry[];
}

export class ResourceStatusService {
  private readonly sampler: ResourceStatusSampler;
  private readonly broadcastToAll: (msg: ServerMessage) => void;
  private readonly alertEvaluator: ResourceAlertEvaluator | null;
  private readonly getCircuitBreakerSnapshots: (() => CircuitBreakerSnapshot[]) | null;
  private readonly onEventLoopDelaySample: ((delayMs: number | null) => void) | null;
  private readonly intervalMs: number;
  private readonly operationalAlertHistoryLimit: number;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly logger: Pick<typeof console, 'warn'>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private latest: SystemResourceStatus | null = null;
  private nextAlertHistoryId = 1;
  private readonly operationalAlertHistory: OperationalAlertHistoryEntry[] = [];
  private readonly activeOperationalAlerts = new Map<string, OperationalAlertHistoryEntry>();
  private samplerErrorLogged = false;
  private alertEvaluatorErrorLogged = false;

  constructor(deps: ResourceStatusServiceDeps) {
    this.sampler = deps.sampler;
    this.broadcastToAll = deps.broadcastToAll;
    this.alertEvaluator = deps.alertEvaluator ?? null;
    this.getCircuitBreakerSnapshots = deps.getCircuitBreakerSnapshots ?? null;
    this.onEventLoopDelaySample = deps.onEventLoopDelaySample ?? null;
    this.intervalMs = deps.intervalMs ?? RESOURCE_STATUS_INTERVAL_MS;
    this.operationalAlertHistoryLimit = normalizeHistoryLimit(deps.operationalAlertHistoryLimit);
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.logger = deps.logger ?? console;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sampler.start();
    this.tick(null);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeout) {
      this.clearTimeoutFn(this.timeout);
      this.timeout = null;
    }
    this.sampler.stop();
  }

  getLatest(): SystemResourceStatus | null {
    return this.latest;
  }

  getOperationalAlertHistory(): OperationalAlertHistorySnapshot {
    return {
      generatedAt: this.nowIso(),
      limit: this.operationalAlertHistoryLimit,
      alerts: this.operationalAlertHistory.map((entry) => ({ ...entry })),
    };
  }

  private tick(expectedAtMs: number | null): void {
    if (!this.running) return;

    // #1725 review finding: the reschedule at the bottom of this method must
    // run EVEN IF something in the body throws. Before #1725 a dead tick loop
    // only meant stale `resourceStatus`/ops-alerts; #1725 makes this loop the
    // sole feed for the dashboard WS load-shed gate (`onEventLoopDelaySample`
    // below), so a silently-dead loop can now leave that gate stuck wherever
    // it last was — permanently shed-active in the worst case. `broadcastToAll`
    // and `evaluateAlerts` are caller-supplied and can throw for reasons this
    // service doesn't control (a consumer's enrichment step, a custom alert
    // evaluator); this `finally` guarantees the next tick is scheduled
    // regardless, matching `takeSample`'s existing fail-open discipline.
    try {
      const status = this.attachCircuitBreakerSnapshots(this.takeSample(expectedAtMs));
      this.latest = status;
      this.broadcastToAll({ type: 'resourceStatus', status });

      // #1725: feed the SAME sampled event-loop delay p95 that just went out on
      // `status` to the dashboard WS load-shed gate. Isolated so a throwing
      // consumer can never take down the resource-status tick loop.
      if (this.onEventLoopDelaySample) {
        try {
          this.onEventLoopDelaySample(status.server.eventLoopDelayP95Ms);
        } catch (err) {
          this.logger.warn('[resource-status] onEventLoopDelaySample threw; continuing', err);
        }
      }

      for (const alert of this.evaluateAlerts(status)) {
        // Log every fire/recovery server-side so an operator can confirm from
        // logs alone that the alert path executed during an incident. The
        // summary text is self-describing (it says "Recovered" on clear).
        if (alert.type === 'alert') {
          this.logger.warn('[ops-alerts]', alert.summary);
          this.recordOperationalAlert(alert);
        }
        this.broadcastToAll(alert);
      }
    } catch (err) {
      this.logger.warn('[resource-status] tick body threw; rescheduling next tick anyway', err);
    } finally {
      if (this.running) {
        const nextExpectedAtMs = this.nowMs() + this.intervalMs;
        this.timeout = this.setTimeoutFn(() => this.tick(nextExpectedAtMs), this.intervalMs);
      }
    }
  }

  private recordOperationalAlert(alert: AlertMessage): void {
    const metadata = alert.operationalAlert;
    // Generic dashboard alerts share the same message type but are not
    // operational rule events, so they are intentionally excluded here.
    if (!metadata) return;

    const occurredAt = this.nowIso();
    if (metadata.state === 'fired') {
      const active = this.activeOperationalAlerts.get(metadata.key);
      if (active) {
        active.lastFiredAt = occurredAt;
        active.fireCount += 1;
        active.alert = alert;
        return;
      }

      const entry: OperationalAlertHistoryEntry = {
        id: this.nextAlertHistoryId++,
        key: metadata.key,
        metric: metadata.metric,
        firstFiredAt: occurredAt,
        lastFiredAt: occurredAt,
        recoveredAt: null,
        active: true,
        fireCount: 1,
        alert,
        recoveryAlert: null,
      };
      this.pushAlertHistoryEntry(entry);
      this.activeOperationalAlerts.set(metadata.key, entry);
      return;
    }

    const active = this.activeOperationalAlerts.get(metadata.key);
    if (active) {
      active.recoveredAt = occurredAt;
      active.active = false;
      active.recoveryAlert = alert;
      this.activeOperationalAlerts.delete(metadata.key);
      return;
    }

    this.pushAlertHistoryEntry({
      id: this.nextAlertHistoryId++,
      key: metadata.key,
      metric: metadata.metric,
      firstFiredAt: null,
      lastFiredAt: null,
      recoveredAt: occurredAt,
      active: false,
      fireCount: 0,
      alert,
      recoveryAlert: alert,
    });
  }

  private pushAlertHistoryEntry(entry: OperationalAlertHistoryEntry): void {
    this.operationalAlertHistory.push(entry);
    while (this.operationalAlertHistory.length > this.operationalAlertHistoryLimit) {
      const evicted = this.operationalAlertHistory.shift();
      if (evicted?.active) this.activeOperationalAlerts.delete(evicted.key);
    }
  }

  private evaluateAlerts(status: SystemResourceStatus): ServerMessage[] {
    if (!this.alertEvaluator) return [];
    try {
      return this.alertEvaluator.evaluate(status);
    } catch (err) {
      if (!this.alertEvaluatorErrorLogged) {
        this.alertEvaluatorErrorLogged = true;
        this.logger.warn(
          '[resource-status] alert evaluator failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
      return [];
    }
  }

  private takeSample(expectedAtMs: number | null): SystemResourceStatus {
    try {
      return this.sampler.sample(expectedAtMs);
    } catch (err) {
      if (!this.samplerErrorLogged) {
        this.samplerErrorLogged = true;
        this.logger.warn('[resource-status] sampler failed:', err instanceof Error ? err.message : String(err));
      }
      return createUnavailableResourceStatus(this.nowIso());
    }
  }

  private attachCircuitBreakerSnapshots(status: SystemResourceStatus): SystemResourceStatus {
    if (!this.getCircuitBreakerSnapshots) return status;
    const circuitBreakers = this.getCircuitBreakerSnapshots();
    if (circuitBreakers.length === 0) return status;
    return { ...status, circuitBreakers };
  }
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_OPERATIONAL_ALERT_HISTORY_LIMIT;
  if (!Number.isFinite(value)) return DEFAULT_OPERATIONAL_ALERT_HISTORY_LIMIT;
  return Math.max(1, Math.trunc(value));
}

export function createUnavailableResourceStatus(sampledAt: string): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt,
    sampleGapMs: null,
    timerDriftMs: null,
    host: {
      cpuUsagePercent: null,
      memoryUsedPercent: null,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
      dataDirectory: {
        path: null,
        diskFreeBytes: null,
        diskTotalBytes: null,
        diskFreePercent: null,
      },
    },
    server: {
      eventLoopDelayP95Ms: null,
      processRssBytes: null,
      processHeapUsedBytes: null,
      processHeapTotalBytes: null,
    },
    unavailable: ['sampler_error'],
  };
}

export function createResourceStatusService(deps: ResourceStatusServiceDeps): ResourceStatusService {
  return new ResourceStatusService(deps);
}
