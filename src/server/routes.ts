import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { registerDiagnosticsRoutes } from './routes/diagnostics-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerDeployRoutes } from './routes/deploy-routes.js';
import { registerScheduleRoutes } from './routes/schedule-routes.js';
import { registerSettingsRoutes } from './routes/settings-routes.js';
import { registerTaskRoutes } from './routes/task-routes.js';
import { registerOssAttemptRoutes } from './routes/oss-attempts-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import type { RouteDeps } from './routes/shared.js';

export type { RouteDeps } from './routes/shared.js';

export function createRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  registerDiagnosticsRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerOssAttemptRoutes(app, deps);
  registerScheduleRoutes(app, deps);
  registerDeployRoutes(app, deps);
  registerShareRoutes(app, deps);

  // Cache headers for frontend assets:
  // - /assets/* have content hashes in filenames → cache forever
  // - everything else (index.html) → always revalidate so deploys take effect
  app.use('/*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/assets/')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (!c.req.path.startsWith('/api/') && !c.req.path.startsWith('/ws')) {
      c.header('Cache-Control', 'no-cache');
    }
  });

  // Serve frontend static files from dist/frontend. In dev mode the frontend
  // is served by Vite on its own port, so dist/frontend doesn't exist — skip
  // registering serveStatic to avoid its "root path is not found" warning on
  // every request. The notFound handler below still returns a useful message
  // when a user hits the backend for frontend assets without a build.
  if (existsSync(deps.frontendDir)) {
    app.use('/*', serveStatic({ root: deps.frontendDir }));
  }

  // SPA fallback — uses notFound handler so routes registered later (e.g. test
  // endpoints) are checked before this fallback fires.
  app.notFound(async (c) => {
    // API routes should return 404 JSON, not the SPA HTML
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Not Found' }, 404);
    }
    try {
      const indexPath = join(deps.frontendDir, 'index.html');
      const html = await readFile(indexPath, 'utf-8');
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    } catch {
      return c.text('Frontend not built. Run: pnpm build:frontend', 404);
    }
  });

  return app;
}
