import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

const DEFAULT_MAX_ROUTES = 128;
const DEFAULT_MAX_SAMPLES_PER_ROUTE = 256;
export const REQUEST_LATENCIES_ROUTE = '/api/diagnostics/request-latencies';

export interface RequestDurationMetricsOptions {
  maxRoutes?: number;
  maxSamplesPerRoute?: number;
  nowMs?: () => number;
}

export interface RequestDurationSample {
  method: string;
  route: string;
  durationMs: number;
}

export interface RequestDurationRouteMetric {
  method: string;
  route: string;
  count: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface RequestDurationMetricsSnapshot {
  schemaVersion: 'request-duration-metrics.v1';
  maxRoutes: number;
  maxSamplesPerRoute: number;
  routeCount: number;
  droppedRouteCount: number;
  routes: RequestDurationRouteMetric[];
}

export class RequestDurationMetrics {
  private readonly maxRoutes: number;
  private readonly maxSamplesPerRoute: number;
  private readonly nowMs: () => number;
  private readonly routes = new Map<string, RouteDurationBucket>();
  private droppedRouteCount = 0;

  constructor(options: RequestDurationMetricsOptions = {}) {
    this.maxRoutes = positiveInteger(options.maxRoutes, DEFAULT_MAX_ROUTES);
    this.maxSamplesPerRoute = positiveInteger(options.maxSamplesPerRoute, DEFAULT_MAX_SAMPLES_PER_ROUTE);
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  now(): number {
    return this.nowMs();
  }

  record(sample: RequestDurationSample): void {
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
      bucket = new RouteDurationBucket(method, route, this.maxSamplesPerRoute);
      this.routes.set(key, bucket);
    }
    bucket.record(sample.durationMs);
  }

  snapshot(): RequestDurationMetricsSnapshot {
    return {
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: this.maxRoutes,
      maxSamplesPerRoute: this.maxSamplesPerRoute,
      routeCount: this.routes.size,
      droppedRouteCount: this.droppedRouteCount,
      routes: [...this.routes.values()]
        .map((bucket) => bucket.snapshot())
        .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.method.localeCompare(b.method)),
    };
  }
}

export function createRequestDurationMiddleware(metrics: RequestDurationMetrics): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = metrics.now();
    try {
      await next();
    } finally {
      const route = findLastRecordableRouteTemplate(matchedRoutes(c));
      if (!shouldRecordRequestDuration(c.req.method, c.req.path, route, c.res.status)) return;
      metrics.record({
        method: c.req.method,
        route,
        durationMs: metrics.now() - startedAt,
      });
    }
  };
}

function findLastRecordableRouteTemplate(routes: ReturnType<typeof matchedRoutes>): string {
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i]?.path;
    if (route && isRecordableRouteTemplate(route)) return route;
  }
  return '';
}

function isRecordableRouteTemplate(route: string): boolean {
  return route !== '*' && route !== '/*';
}

function shouldRecordRequestDuration(method: string, requestPath: string, matchedRoute: string, status: number): boolean {
  if (method === 'OPTIONS') return false;
  if (!requestPath.startsWith('/api/')) return false;
  if (!matchedRoute || !isRecordableRouteTemplate(matchedRoute)) return false;
  if (status === 404) return false;
  if (matchedRoute === REQUEST_LATENCIES_ROUTE) return false;
  if (matchedRoute === '/api/ready') return false;
  if (matchedRoute === '/api/health' || matchedRoute.startsWith('/api/health/')) return false;
  return true;
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

class RouteDurationBucket {
  private count = 0;
  private nextIndex = 0;
  private readonly samples: number[] = [];

  constructor(
    private readonly method: string,
    private readonly route: string,
    private readonly maxSamples: number,
  ) {}

  record(durationMs: number): void {
    this.count += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(durationMs);
      return;
    }
    this.samples[this.nextIndex] = durationMs;
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): RequestDurationRouteMetric {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      method: this.method,
      route: this.route,
      count: this.count,
      sampleCount: sorted.length,
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
