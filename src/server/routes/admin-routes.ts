import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { RouteDeps } from './shared.js';

const ADMIN_TOKEN_HEADER = 'x-kookr-admin-token';

function getRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Admin auth mirrors the finding-evidence-review gate in diagnostics-routes.ts:
 * a configured `KOOKR_ADMIN_TOKEN` matched via the `x-kookr-admin-token` header
 * authorizes any caller; otherwise only loopback is trusted. An unauthenticated
 * drain would be a trivial DoS (issue #659), so every admin route passes through
 * this gate — including the read-only status GET, since drain state is operator
 * information.
 */
export function isAuthorizedAdminRequest(
  remoteAddress: string | undefined,
  tokenHeader: string | undefined,
): boolean {
  const configured = process.env.KOOKR_ADMIN_TOKEN?.trim();
  if (configured && tokenHeader === configured) return true;
  return remoteAddress !== undefined && isLoopbackAddress(remoteAddress);
}

/**
 * Operator drain / resume control (issue #659).
 *
 *   GET  /api/admin/drain   → { accepting, draining, since?, runningTasks }
 *   POST /api/admin/drain   → enter drain mode (refuse new launches)
 *   POST /api/admin/resume  → leave drain mode (accept launches)
 *
 * Routes are registered only when a {@link DrainController} is wired in; absent
 * it, the endpoints simply don't exist (tests and non-server callers can omit).
 */
export function registerAdminRoutes(app: Hono, deps: RouteDeps): void {
  const { drainController, taskStore } = deps;
  if (!drainController) return;

  const authorize = (c: Context): boolean =>
    isAuthorizedAdminRequest(getRemoteAddress(c), c.req.header(ADMIN_TOKEN_HEADER));

  const statusBody = () => ({
    ...drainController.status(),
    runningTasks: taskStore.getActiveCount(),
  });

  app.get('/api/admin/drain', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    return c.json(statusBody());
  });

  app.post('/api/admin/drain', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    const changed = drainController.drain();
    if (changed) {
      console.warn('[admin] drain mode ON — refusing new task launches (running agents continue)');
    }
    return c.json({ ...statusBody(), changed });
  });

  app.post('/api/admin/resume', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    const changed = drainController.resume();
    if (changed) {
      console.warn('[admin] drain mode OFF — accepting new task launches');
    }
    return c.json({ ...statusBody(), changed });
  });
}
