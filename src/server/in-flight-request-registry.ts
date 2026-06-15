import type { MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';

const DEFAULT_SHUTDOWN_LOG_INTERVAL_MS = 2_000;
const DEFAULT_SHUTDOWN_LOG_TOP_N = 5;

export interface InFlightRequestRegistryOptions {
  nowMs?: () => number;
}

export interface InFlightRequestSnapshotEntry {
  id: number;
  method: string;
  route: string;
  elapsedMs: number;
  startedAtMs: number;
}

export interface StartShutdownLoggerOptions {
  intervalMs?: number;
  topN?: number;
  nowMs?: () => number;
  log?: (message: string) => void;
}

interface ActiveRequest {
  method: string;
  route: string;
  startedAtMs: number;
}

export class InFlightRequestRegistry {
  private readonly nowMs: () => number;
  private readonly requests = new Map<number, ActiveRequest>();
  private nextId = 1;

  constructor(options: InFlightRequestRegistryOptions = {}) {
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  start(input: { method: string; route: string; startedAtMs?: number }): number {
    const id = this.nextId;
    this.nextId += 1;
    this.requests.set(id, {
      method: normalizeMethod(input.method),
      route: sanitizeRoute(input.route),
      startedAtMs: input.startedAtMs ?? this.nowMs(),
    });
    return id;
  }

  finish(id: number): void {
    this.requests.delete(id);
  }

  size(): number {
    return this.requests.size;
  }

  snapshot(options: { nowMs?: number; limit?: number } = {}): InFlightRequestSnapshotEntry[] {
    const nowMs = options.nowMs ?? this.nowMs();
    const limit = positiveInteger(options.limit, this.requests.size);
    return [...this.requests.entries()]
      .map(([id, request]) => ({
        id,
        method: request.method,
        route: request.route,
        startedAtMs: request.startedAtMs,
        elapsedMs: Math.max(0, Math.round(nowMs - request.startedAtMs)),
      }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs || a.startedAtMs - b.startedAtMs || a.id - b.id)
      .slice(0, limit);
  }

}

export const inFlightRequestRegistry = new InFlightRequestRegistry();

export function createInFlightRequestMiddleware(registry: InFlightRequestRegistry): MiddlewareHandler {
  return async (c, next) => {
    const id = registry.start({
      method: c.req.method,
      // Hono exposes matched route templates for normal routes; middleware-only
      // or fallback requests keep the sanitized path so shutdown logs stay useful.
      route: findLastRouteTemplate(matchedRoutes(c)) || c.req.path,
    });
    try {
      await next();
    } finally {
      registry.finish(id);
    }
  };
}

export function startInFlightRequestShutdownLogger(
  registry: InFlightRequestRegistry,
  options: StartShutdownLoggerOptions = {},
): () => void {
  const intervalMs = positiveInteger(options.intervalMs, DEFAULT_SHUTDOWN_LOG_INTERVAL_MS);
  const topN = positiveInteger(options.topN, DEFAULT_SHUTDOWN_LOG_TOP_N);
  const nowMs = options.nowMs ?? (() => performance.now());
  const log = options.log ?? ((message) => console.warn(message));

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const logSnapshot = () => {
    if (stopped) return;
    const snapshot = registry.snapshot({ nowMs: nowMs(), limit: topN });
    if (snapshot.length === 0) return;
    log(`[shutdown] Waiting for ${registry.size()} in-flight HTTP request(s): ${formatSnapshot(snapshot)}`);
  };

  logSnapshot();
  timer = setInterval(logSnapshot, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}

function formatSnapshot(snapshot: InFlightRequestSnapshotEntry[]): string {
  return snapshot
    .map((request) => `${request.method} ${request.route} elapsedMs=${request.elapsedMs}`)
    .join('; ');
}

function normalizeMethod(method: string): string {
  const normalized = method.trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

function sanitizeRoute(route: string): string {
  const path = route.split('?', 1)[0]?.trim() ?? '';
  return path || '/';
}

function findLastRouteTemplate(routes: ReturnType<typeof matchedRoutes>): string {
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const route = routes[i]?.path;
    if (route && route !== '*' && route !== '/*') return route;
  }
  return '';
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
