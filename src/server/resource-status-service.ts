import type { ServerMessage, SystemResourceStatus } from '../shared/contracts/messages.js';
import { RESOURCE_STATUS_INTERVAL_MS, type SystemResourceSampler } from './system-resource-sampler.js';

export interface ResourceStatusSampler {
  start(): void;
  stop(): void;
  sample(expectedAtMs?: number | null): SystemResourceStatus;
}

export interface ResourceStatusServiceDeps {
  sampler: ResourceStatusSampler;
  broadcastToAll: (msg: ServerMessage) => void;
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

  constructor(deps: ResourceStatusServiceDeps) {
    this.sampler = deps.sampler;
    this.broadcastToAll = deps.broadcastToAll;
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

    const status = this.takeSample(expectedAtMs);
    this.latest = status;
    this.broadcastToAll({ type: 'resourceStatus', status });

    const nextExpectedAtMs = this.nowMs() + this.intervalMs;
    this.timeout = this.setTimeoutFn(() => this.tick(nextExpectedAtMs), this.intervalMs);
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

export function createResourceStatusService(deps: Omit<ResourceStatusServiceDeps, 'sampler'> & { sampler: SystemResourceSampler }): ResourceStatusService {
  return new ResourceStatusService(deps);
}
