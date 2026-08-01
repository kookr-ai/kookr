import type { Context, Hono } from 'hono';
import {
  API_TOKEN_HEADER,
  getAuthThrottleSnapshot,
  parseCookieHeader,
  remoteAddrFromContext,
  resolveActor,
} from '../auth.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusExposition,
  type TerminalWriteMetricsSnapshot,
} from '../prometheus-exposition.js';
import type { RouteDeps } from './shared.js';

export function registerMetricsRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/metrics', (c) => {
    const authResponse = authorizeMetricsRequest(c, deps);
    if (authResponse) return authResponse;

    const requestDurations = deps.requestDurationMetrics?.snapshot() ?? {
      // Direct route tests may register this module without createRoutes(), which
      // normally wires the live request-duration metrics instance.
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: 0,
      maxSamplesPerRoute: 0,
      routeCount: 0,
      droppedRouteCount: 0,
      routes: [],
    };

    return c.body(renderPrometheusExposition({
      requestDurations,
      toolLatencies: deps.watchdog?.getToolLatencyMetrics().snapshot(),
      circuitBreakers: deps.circuitBreakerRegistry?.getAllSnapshots() ?? [],
      attentionQueueSuppressions: deps.queue?.getSuppressionCounts(),
      auditSinks: deps.auditSinks?.getAllSnapshots() ?? [],
      authThrottle: getAuthThrottleSnapshot(deps.apiAuth),
      webhookDeliveries: deps.webhookNotifier?.getDeliveryCounts(),
      terminalWrite: collectTerminalWriteMetrics(deps),
      terminalInputRtt: deps.terminalInputRttMetrics?.snapshot(),
    }), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
    });
  });
}

/** Assemble terminalWrite saturation gauges from backend + coordinator (issue #1776). */
export function collectTerminalWriteMetrics(deps: Pick<
  RouteDeps,
  'terminalBackend' | 'terminalInputCoordinator'
>): TerminalWriteMetricsSnapshot {
  const backend = deps.terminalBackend?.getStats();
  const coordinator = deps.terminalInputCoordinator?.getWriteMetrics();
  return {
    pendingWriters: backend?.pendingWriters ?? 0,
    maxPendingWriters: backend?.maxPendingWriters ?? 0,
    writeTimeoutCount: backend?.writeTimeoutCount ?? 0,
    pendingWrites: coordinator?.pendingWrites ?? 0,
    maxPendingWrites: coordinator?.maxPendingWrites ?? 0,
  };
}

function authorizeMetricsRequest(c: Context, deps: RouteDeps): Response | undefined {
  const apiAuth = deps.apiAuth;
  if (!apiAuth?.required || !apiAuth.token) return undefined;

  const actor = resolveActor(apiAuth, {
    authorization: c.req.header('authorization'),
    apiTokenHeader: c.req.header(API_TOKEN_HEADER),
    cookies: parseCookieHeader(c.req.header('cookie')),
    remoteAddr: remoteAddrFromContext(c),
  });
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  if (actor.kind !== 'owner') return c.json({ error: 'forbidden' }, 403);
  c.set('actor', actor);
  return undefined;
}
