import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import type { CircuitBreakerSnapshot } from '../shared/contracts/circuit-breaker.js';
import { RESOURCE_STATUS_INTERVAL_MS } from './system-resource-sampler.js';

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
  intervalMs?: number;
  nowMs?: () => number;
  nowIso?: () => string;
  logger?: Pick<typeof console, 'warn'>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ResourceStatusService {
  private readonly sampler: ResourceStatusSampler;
  private readonly broadcastToAll: (msg: ServerMessage) => void;
  private readonly alertEvaluator: ResourceAlertEvaluator | null;
  private readonly getCircuitBreakerSnapshots: (() => CircuitBreakerSnapshot[]) | null;
  private readonly intervalMs: number;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly logger: Pick<typeof console, 'warn'>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private latest: SystemResourceStatus | null = null;
  private samplerErrorLogged = false;
  private alertEvaluatorErrorLogged = false;

  constructor(deps: ResourceStatusServiceDeps) {
    this.sampler = deps.sampler;
    this.broadcastToAll = deps.broadcastToAll;
    this.alertEvaluator = deps.alertEvaluator ?? null;
    this.getCircuitBreakerSnapshots = deps.getCircuitBreakerSnapshots ?? null;
    this.intervalMs = deps.intervalMs ?? RESOURCE_STATUS_INTERVAL_MS;
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

  private tick(expectedAtMs: number | null): void {
    if (!this.running) return;

    const status = this.attachCircuitBreakerSnapshots(this.takeSample(expectedAtMs));
    this.latest = status;
    this.broadcastToAll({ type: 'resourceStatus', status });

    for (const alert of this.evaluateAlerts(status)) {
      // Log every fire/recovery server-side so an operator can confirm from
      // logs alone that the alert path executed during an incident. The
      // summary text is self-describing (it says "Recovered" on clear).
      if (alert.type === 'alert') {
        this.logger.warn('[ops-alerts]', alert.summary);
      }
      this.broadcastToAll(alert);
    }

    const nextExpectedAtMs = this.nowMs() + this.intervalMs;
    this.timeout = this.setTimeoutFn(() => this.tick(nextExpectedAtMs), this.intervalMs);
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
