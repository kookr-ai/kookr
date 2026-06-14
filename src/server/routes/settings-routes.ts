import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';
import { createSnapshotMessage } from '../use-cases/get-snapshot.js';
import { validateSettingsWithWarnings } from '../../core/settings-store.js';

export function registerSettingsRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/settings', (c) => {
    if (!deps.settings) return c.json({ error: 'Settings not configured' }, 500);
    return c.json({
      ...deps.settings.get(),
      loadedFromDefaults: deps.settings.getLoadedFromDefaults(),
      warnings: deps.settings.getLoadWarnings?.() ?? [],
    });
  });

  app.put('/api/settings', async (c) => {
    if (!deps.settings) return c.json({ error: 'Settings not configured' }, 500);
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return c.json({ error: 'Body must be a JSON object' }, 400);
      }

      const { settings: validated, warnings: validationWarnings } = validateSettingsWithWarnings(body);
      const warnings = [
        ...validationWarnings,
        ...await deps.settings.update(validated),
      ];
      // Pass the live deps so the snapshot carries maxActiveTasks (and sttUrl,
      // activityMetaProvider, etc.) — without these the broadcast would emit a
      // partial payload and the frontend would have to fall back on stickiness.
      deps.broadcastToAll(createSnapshotMessage({
        monitor: deps.monitor,
        serverCwd: deps.serverCwd,
        sttUrl: deps.sttUrl,
        activityMetaProvider: deps.hookIngestion,
        getMaxActiveTasks: deps.getMaxActiveTasks,
        relationTaskStore: deps.taskStore,
      }));
      // Return what the server actually committed, not `validated`: the update
      // path overrides server-managed fields (e.g. roundRobinIndex) that the
      // client's body cannot authoritatively set.
      return c.json({ ...deps.settings.get(), warnings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
}
