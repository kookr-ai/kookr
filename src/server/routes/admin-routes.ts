import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { RouteDeps } from './shared.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import { LOG_LEVELS, getLogLevelState, setLogLevel } from '../runtime-log-level.js';
import {
  OPERATIONAL_ALERT_CONFIG_FIELDS,
  getOperationalAlertConfigState,
  setOperationalAlertConfig,
} from '../operational-alert-config.js';

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

function logLevelBody() {
  const state = getLogLevelState();
  return {
    level: state.level,
    default: state.default,
    ttlExpiresAt: state.ttlExpiresAt === null ? null : new Date(state.ttlExpiresAt).toISOString(),
  };
}

function operationalAlertConfigBody() {
  return getOperationalAlertConfigState();
}

function operationalAlertHistoryBody(deps: RouteDeps) {
  // Tests and partial route harnesses can omit the resource-status service;
  // keep the admin route present and report an empty, explicitly unwired view.
  return deps.getOperationalAlertHistory?.() ?? {
    generatedAt: new Date().toISOString(),
    limit: 0,
    alerts: [],
  };
}

function broadcastDrainSnapshot(deps: RouteDeps): void {
  if (!deps.drainController || !deps.broadcastToAll || !deps.monitor || !deps.serverCwd) return;
  deps.broadcastToAll(createSnapshotMessage({
    monitor: deps.monitor,
    serverCwd: deps.serverCwd,
    drainStatus: deps.drainController.status(),
    activityMetaProvider: deps.hookIngestion,
    relationTaskStore: deps.taskStore,
    terminalInputSnapshots: deps.terminalInputCoordinator,
    userInputDeliveryProvider: deps.userInputDeliveries,
  }));
}

/**
 * Runtime debug-verbosity control (issue #662).
 *
 *   GET  /api/admin/log-level  → { level, default, ttlExpiresAt }
 *   POST /api/admin/log-level  { level, ttlSeconds? } → set the level
 *
 * Unlike drain, this needs no wired dependency — the level lives in a
 * process-global shim — so it registers unconditionally and is always present.
 */
function registerLogLevelRoutes(app: Hono, authorize: (c: Context) => boolean): void {
  app.get('/api/admin/log-level', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    return c.json(logLevelBody());
  });

  app.post('/api/admin/log-level', async (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }

    const { level, ttlSeconds } = (payload ?? {}) as { level?: unknown; ttlSeconds?: unknown };
    const result = setLogLevel(level, ttlSeconds);
    if (!result.ok) {
      return c.json({ error: result.error, validLevels: LOG_LEVELS }, 400);
    }

    const body = logLevelBody();
    console.warn(
      `[admin] log level set to '${body.level}'`
        + (body.ttlExpiresAt ? ` (auto-reverts to '${body.default}' at ${body.ttlExpiresAt})` : ''),
    );
    return c.json(body);
  });
}

/**
 * Runtime operational-alert threshold control (issue #737).
 *
 *   GET  /api/admin/operational-alert-config
 *     → { config: OperationalAlertConfig, default: OperationalAlertConfig }
 *   POST /api/admin/operational-alert-config
 *     { cpuPercent?, memoryPercent?, eventLoopDelayMs?, sustainSamples? }
 *
 * Env remains the boot default; POST mutates only this running process so alert
 * sensitivity can be tuned without restarting supervised agent sessions.
 */
function registerOperationalAlertConfigRoutes(app: Hono, authorize: (c: Context) => boolean): void {
  app.get('/api/admin/operational-alert-config', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    return c.json(operationalAlertConfigBody());
  });

  app.post('/api/admin/operational-alert-config', async (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-json' }, 400);
    }

    const result = setOperationalAlertConfig(payload);
    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          field: result.field,
          validFields: OPERATIONAL_ALERT_CONFIG_FIELDS,
        },
        400,
      );
    }

    const body = operationalAlertConfigBody();
    console.warn(`[admin] operational alert config updated: ${JSON.stringify(body.config)}`);
    return c.json(body);
  });
}

function registerOperationalAlertHistoryRoutes(
  app: Hono,
  deps: RouteDeps,
  authorize: (c: Context) => boolean,
): void {
  app.get('/api/admin/operational-alerts', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    return c.json(operationalAlertHistoryBody(deps));
  });
}

/**
 * Operator drain / resume control (issue #659).
 *
 *   GET  /api/admin/drain   → { accepting, draining, since?, runningTasks }
 *   POST /api/admin/drain   → enter drain mode (refuse new launches)
 *   POST /api/admin/resume  → leave drain mode (accept launches)
 *
 * Drain routes are registered only when a {@link DrainController} is wired in;
 * absent it, those endpoints don't exist. Runtime config routes with no wired
 * dependency (log level, operational alerts) always register.
 */
export function registerAdminRoutes(app: Hono, deps: RouteDeps): void {
  const { drainController, taskStore } = deps;

  const authorize = (c: Context): boolean =>
    isAuthorizedAdminRequest(getRemoteAddress(c), c.req.header(ADMIN_TOKEN_HEADER));

  registerLogLevelRoutes(app, authorize);
  registerOperationalAlertConfigRoutes(app, authorize);
  registerOperationalAlertHistoryRoutes(app, deps, authorize);

  if (!drainController) return;

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
      broadcastDrainSnapshot(deps);
    }
    return c.json({ ...statusBody(), changed });
  });

  app.post('/api/admin/resume', (c) => {
    if (!authorize(c)) return c.json({ error: 'admin-forbidden' }, 403);
    const changed = drainController.resume();
    if (changed) {
      console.warn('[admin] drain mode OFF — accepting new task launches');
      broadcastDrainSnapshot(deps);
    }
    return c.json({ ...statusBody(), changed });
  });
}
