import type { Hono } from 'hono';
import type { LucyLiveStatus } from '../../shared/contracts/lucy-live.js';

export interface LucyLiveRouteDeps {
  /** What the server worked out at startup; absent in partial harnesses, which report unavailable. */
  lucyLiveStatus?: LucyLiveStatus;
}

/** GET /api/lucy-live/status: lets the dashboard know whether the spoken conversation can be switched on. */
export function registerLucyLiveRoutes(app: Hono, deps: LucyLiveRouteDeps): void {
  app.get('/api/lucy-live/status', (c) => {
    const status: LucyLiveStatus = deps.lucyLiveStatus ?? { available: false, reason: 'Lucy live is not configured on this server.' };
    return c.json(status);
  });
}

