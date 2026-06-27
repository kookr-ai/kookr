import type { Context, Hono } from 'hono';
import { API_TOKEN_HEADER, parseCookieHeader, remoteAddrFromContext, resolveActor } from '../auth.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusExposition,
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
      circuitBreakers: deps.circuitBreakerRegistry?.getAllSnapshots() ?? [],
      attentionQueueSuppressions: deps.queue?.getSuppressionCounts(),
    }), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
    });
  });
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
