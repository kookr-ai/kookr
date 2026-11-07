/**
 * Fleet-aware auto-update routes (RFC Layer 4 / R6). Exposes the per-plugin
 * policy (`off | notify | apply-when-idle`), the audit trail / last decision, the
 * persistent verify-failure banner, a manual "evaluate now", and the scoped
 * rollback action. All mutations serialize through the shared
 * `PluginMutationService` lock (the runner acquires it internally), so a 409
 * names the lock holder.
 *
 * These routes carry task access (for the idle predicate), so — like the
 * config-drift routes — they take their own deps interface rather than widening
 * the deploy/plugin slice (which deliberately does not touch task state).
 */
import type { Hono } from 'hono';
import type { TaskStore } from '../../core/tasks.js';
import { PluginMutationBusyError } from '../plugin-manager/mutation-service.js';
import { buildAutoUpdateService } from '../plugin-manager/auto-update-wiring.js';
import {
  AUTO_UPDATE_POLICIES,
  type AutoUpdateActionError,
  type AutoUpdateActionResult,
  type AutoUpdatePolicy,
  type AutoUpdateSurface,
} from '../../shared/contracts/plugins.js';
import type { DeployRouteDeps } from './shared.js';

export interface PluginAutoUpdateRouteDeps extends DeployRouteDeps {
  taskStore: TaskStore;
}

function isPolicy(value: unknown): value is AutoUpdatePolicy {
  return typeof value === 'string' && (AUTO_UPDATE_POLICIES as readonly string[]).includes(value);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function busyResponse(c: import('hono').Context, err: PluginMutationBusyError, pluginId?: string): Response {
  return c.json<AutoUpdateActionError>(
    { error: 'Plugin mutation already in progress', ...(pluginId ? { pluginId } : {}), lockHolder: err.holder },
    409,
  );
}

export function registerPluginAutoUpdateRoutes(app: Hono, deps: PluginAutoUpdateRouteDeps): void {
  const validId = (id: string | undefined): id is string => Boolean(id && id.includes('@'));

  app.get('/api/plugins/auto-update', async (c) => {
    try {
      const { service, fleetPluginIds } = await buildAutoUpdateService(deps);
      const ids = await fleetPluginIds();
      return c.json<AutoUpdateSurface>(await service.getSurface(ids));
    } catch (err) {
      console.error(`[plugins] auto-update surface failed: ${errorMessage(err)}`);
      // Degrade, don't 500 — an empty surface is a legible "nothing configured".
      return c.json<AutoUpdateSurface>({ plugins: [], recentDecisions: [], applyEnabled: false });
    }
  });

  app.put('/api/plugins/:id/auto-update', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json<AutoUpdateActionError>({ error: 'Invalid plugin id', pluginId: id }, 400);
    let body: { policy?: unknown };
    try {
      body = (await c.req.json()) as { policy?: unknown };
    } catch {
      return c.json<AutoUpdateActionError>({ error: 'Invalid JSON body', pluginId: id }, 400);
    }
    if (!isPolicy(body.policy)) {
      return c.json<AutoUpdateActionError>(
        { error: `policy must be one of ${AUTO_UPDATE_POLICIES.join(' | ')}`, pluginId: id },
        400,
      );
    }
    try {
      const { service } = await buildAutoUpdateService(deps);
      const plugin = await service.setPolicy(id, body.policy);
      return c.json<AutoUpdateActionResult>({ status: 'ok', plugin });
    } catch (err) {
      if (err instanceof PluginMutationBusyError) return busyResponse(c, err, id);
      console.error(`[plugins] set auto-update policy failed id=${id}: ${errorMessage(err)}`);
      return c.json<AutoUpdateActionError>({ error: errorMessage(err), pluginId: id }, 500);
    }
  });

  app.post('/api/plugins/:id/auto-update/evaluate', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json<AutoUpdateActionError>({ error: 'Invalid plugin id', pluginId: id }, 400);
    try {
      const { service } = await buildAutoUpdateService(deps);
      await service.evaluatePlugin(id, { manual: true });
      return c.json<AutoUpdateActionResult>({ status: 'ok', plugin: await service.viewFor(id) });
    } catch (err) {
      if (err instanceof PluginMutationBusyError) return busyResponse(c, err, id);
      console.error(`[plugins] auto-update evaluate failed id=${id}: ${errorMessage(err)}`);
      return c.json<AutoUpdateActionError>({ error: errorMessage(err), pluginId: id }, 500);
    }
  });

  app.post('/api/plugins/:id/auto-update/rollback', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json<AutoUpdateActionError>({ error: 'Invalid plugin id', pluginId: id }, 400);
    try {
      const { service } = await buildAutoUpdateService(deps);
      await service.rollback(id);
      return c.json<AutoUpdateActionResult>({ status: 'ok', plugin: await service.viewFor(id) });
    } catch (err) {
      if (err instanceof PluginMutationBusyError) return busyResponse(c, err, id);
      console.error(`[plugins] auto-update rollback failed id=${id}: ${errorMessage(err)}`);
      return c.json<AutoUpdateActionError>({ error: errorMessage(err), pluginId: id }, 500);
    }
  });

  app.post('/api/plugins/:id/auto-update/dismiss-banner', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json<AutoUpdateActionError>({ error: 'Invalid plugin id', pluginId: id }, 400);
    try {
      const { service } = await buildAutoUpdateService(deps);
      await service.dismissBanner(id);
      return c.json<AutoUpdateActionResult>({ status: 'ok', plugin: await service.viewFor(id) });
    } catch (err) {
      console.error(`[plugins] auto-update dismiss-banner failed id=${id}: ${errorMessage(err)}`);
      return c.json<AutoUpdateActionError>({ error: errorMessage(err), pluginId: id }, 500);
    }
  });
}
