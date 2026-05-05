import type { Hono } from 'hono';
import type { RouteDeps } from './shared.js';

export function registerSettingsRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/api/settings', (c) => {
    if (!deps.settings) return c.json({ error: 'Settings not configured' }, 500);
    return c.json({
      ...deps.settings.get(),
      loadedFromDefaults: deps.settings.getLoadedFromDefaults(),
    });
  });

  app.put('/api/settings', async (c) => {
    if (!deps.settings) return c.json({ error: 'Settings not configured' }, 500);
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return c.json({ error: 'Body must be a JSON object' }, 400);
      }

      const { validateSettings } = await import('../../core/settings-store.js');
      const validated = validateSettings(body);
      const warnings = await deps.settings.update(validated);
      return c.json({ ...validated, warnings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });
}
