export const CONTROL_PLANE_LATENCIES_ROUTE = '/api/diagnostics/control-plane-latencies';

/**
 * Fixed slow-probe threshold (ms). Observations at or above this are counted as
 * `slowCount` so an operator can distinguish a control plane that answers slowly
 * from one that answers fast — matching the external five-second probe timeout
 * that motivated the histogram (issue #2774).
 */
const DEFAULT_SLOW_THRESHOLD_MS = 5000;

// Control-plane surfaces are a small, closed set (`/api/health`, its subroutes,
// and `/api/ready`). The route cap is a defensive cardinality bound, not an
// expected working size — real deployments register well under a dozen.
const DEFAULT_MAX_ROUTES = 16;
const DEFAULT_MAX_SAMPLES_PER_ROUTE = 256;

export interface ControlPlaneLatencyMetricsOptions {
  maxRoutes?: number;
  maxSamplesPerRoute?: number;
  slowThresholdMs?: number;
}

export interface ControlPlaneLatencySample {
  method: string;
  route: string;
  durationMs: number;
  /** HTTP status the probe completed with; ≥ 400 counts toward `errorCount`. */
  status: number;
}

export interface ControlPlaneLatencyRouteMetric {
  method: string;
  route: string;
  count: number;
  sampleCount: number;
  errorCount: number;
  slowCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ControlPlaneLatencyMetricsSnapshot {
  schemaVersion: 'control-plane-latency-metrics.v1';
  maxRoutes: number;
  maxSamplesPerRoute: number;
  slowThresholdMs: number;
  routeCount: number;
  droppedRouteCount: number;
  routes: ControlPlaneLatencyRouteMetric[];
}

/**
 * Bounded latency + completion-status histogram for the control-plane probe
 * surfaces that the request-duration histogram deliberately excludes
 * (`/api/health`, health subroutes, `/api/ready`). Keeps a fixed set of
 * reservoir-sampled buckets so an unattended operator can see a slow or failing
 * control plane rather than only a binary status (issue #2774).
 *
 * The caller supplies each observation's already-measured `durationMs` (the
 * request-duration middleware times the probe off its own clock), so this class
 * keeps no clock of its own. Every method is synchronous, allocation-light, and
 * never throws on bad input, so recording from the middleware cannot delay or
 * fail the health response it observes.
 */
export class ControlPlaneLatencyMetrics {
  private readonly maxRoutes: number;
  private readonly maxSamplesPerRoute: number;
  private readonly slowThresholdMs: number;
  private readonly routes = new Map<string, ControlPlaneLatencyBucket>();
  private droppedRouteCount = 0;

  constructor(options: ControlPlaneLatencyMetricsOptions = {}) {
    this.maxRoutes = positiveInteger(options.maxRoutes, DEFAULT_MAX_ROUTES);
    this.maxSamplesPerRoute = positiveInteger(options.maxSamplesPerRoute, DEFAULT_MAX_SAMPLES_PER_ROUTE);
    this.slowThresholdMs = positiveNumber(options.slowThresholdMs, DEFAULT_SLOW_THRESHOLD_MS);
  }

  record(sample: ControlPlaneLatencySample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
    const method = normalizeMethod(sample.method);
    const route = normalizeRoute(sample.route);
    if (!route) return;

    const key = `${method} ${route}`;
    let bucket = this.routes.get(key);
    if (!bucket) {
      if (this.routes.size >= this.maxRoutes) {
        this.droppedRouteCount += 1;
        return;
      }
      bucket = new ControlPlaneLatencyBucket(method, route, this.maxSamplesPerRoute);
      this.routes.set(key, bucket);
    }
    bucket.record(sample.durationMs, sample.status, sample.durationMs >= this.slowThresholdMs);
  }

  snapshot(): ControlPlaneLatencyMetricsSnapshot {
    return {
      schemaVersion: 'control-plane-latency-metrics.v1',
      maxRoutes: this.maxRoutes,
      maxSamplesPerRoute: this.maxSamplesPerRoute,
      slowThresholdMs: this.slowThresholdMs,
      routeCount: this.routes.size,
      droppedRouteCount: this.droppedRouteCount,
      routes: [...this.routes.values()]
        .map((bucket) => bucket.snapshot())
        .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.method.localeCompare(b.method)),
    };
  }
}

export const EMPTY_CONTROL_PLANE_LATENCY_SNAPSHOT: ControlPlaneLatencyMetricsSnapshot = {
  schemaVersion: 'control-plane-latency-metrics.v1',
  maxRoutes: 0,
  maxSamplesPerRoute: 0,
  slowThresholdMs: DEFAULT_SLOW_THRESHOLD_MS,
  routeCount: 0,
  droppedRouteCount: 0,
  routes: [],
};

/**
 * Control-plane probe routes excluded from the general request-duration
 * histogram but recorded here instead: `/api/ready`, `/api/health`, and health
 * subroutes.
 */
export function isControlPlaneLatencyRoute(matchedRoute: string): boolean {
  return (
    matchedRoute === '/api/ready' ||
    matchedRoute === '/api/health' ||
    matchedRoute.startsWith('/api/health/')
  );
}

function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

function normalizeRoute(route: string): string {
  return route.trim().replace(/\/+$/, '') || '/';
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

class ControlPlaneLatencyBucket {
  private count = 0;
  private errorCount = 0;
  private slowCount = 0;
  private nextIndex = 0;
  private readonly samples: number[] = [];

  constructor(
    private readonly method: string,
    private readonly route: string,
    private readonly maxSamples: number,
  ) {}

  record(durationMs: number, status: number, slow: boolean): void {
    this.count += 1;
    if (Number.isFinite(status) && status >= 400) this.errorCount += 1;
    if (slow) this.slowCount += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(durationMs);
      return;
    }
    this.samples[this.nextIndex] = durationMs;
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): ControlPlaneLatencyRouteMetric {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      method: this.method,
      route: this.route,
      count: this.count,
      sampleCount: sorted.length,
      errorCount: this.errorCount,
      slowCount: this.slowCount,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }
}

function percentile(sortedSamples: number[], percentileRank: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedSamples.length) - 1),
  );
  return roundMs(sortedSamples[index]);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
