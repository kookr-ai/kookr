import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { registerDiagnosticsRoutes } from './routes/diagnostics-routes.js';
import { registerAdminRoutes } from './routes/admin-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerDeployRoutes } from './routes/deploy-routes.js';
import { registerScheduleRoutes } from './routes/schedule-routes.js';
import { registerSettingsRoutes } from './routes/settings-routes.js';
import { registerTaskRoutes } from './routes/task-routes.js';
import { registerCoordinatorRoutes } from './routes/coordinator-routes.js';
import { registerAgentRoutes } from './routes/agent-routes.js';
import { registerCostComparisonRoutes } from './routes/cost-comparison-routes.js';
import { registerTaskRelationsRoutes } from './routes/task-relations-routes.js';
import { registerRalphRoutes } from './ralph/routes.js';
import { registerOssAttemptRoutes } from './routes/oss-attempts-routes.js';
import { registerShareRoutes } from './routes/share-routes.js';
import { registerContactShareRoutes } from './routes/contact-share-routes.js';
import { registerRelayConnectionRoutes } from './routes/relay-connection-routes.js';
import { registerSessionSharingRecoveryRoutes } from './routes/session-sharing-recovery-routes.js';
import { registerCollaborationPairingRoutes } from './routes/collaboration-pairing-routes.js';
import { registerSpeechRoutes } from './routes/speech-routes.js';
import { AgentSpeakCache } from './agent-speak-cache.js';
import { DEFAULT_TTS_VOICE } from './tts-manager.js';
import { TaskSpeechSummaryCache } from './task-speech-summary-cache.js';
import { CoordinatorSuppressionStore } from './coordinator/suppression-store.js';
import { createApiAuthMiddleware } from './auth.js';
import { registerAuthSessionRoutes, createCsrfMiddleware } from './auth-session.js';
import { isShareGuardedRoute } from './routes/share-routes.js';
import { readRequestBodyLimitBytesFromEnv } from './config.js';
import { createJsonRequestBodyLimitMiddleware, type RouteDeps } from './routes/shared.js';
import { createRequestDurationMiddleware, RequestDurationMetrics } from './request-duration-metrics.js';

export type { RouteDeps } from './routes/shared.js';

export function createRoutes(deps: RouteDeps): Hono {
  const app = new Hono();

  // Issue #708: when the server bound to a non-loopback host, enforce a bearer
  // token on state-changing requests. Registered before route handlers and
  // body-reading middleware. On a loopback bind `apiAuth.required` is false and
  // this is a no-op pass-through, keeping the default localhost flow token-free.
  if (deps.apiAuth?.required) {
    app.use('*', createApiAuthMiddleware(deps.apiAuth));
    // #804: double-submit CSRF guard for owner cookie mutations. Installed right
    // after the actor gate so it only ever sees already-authenticated requests;
    // a no-op when no CSRF secret is configured (e.g. tests construct routes
    // without the session feature).
    if (deps.sessionAuth) {
      app.use(
        '*',
        createCsrfMiddleware({
          apiAuth: deps.apiAuth,
          csrfSecret: deps.sessionAuth.csrfSecret,
          // The relay/contact-share routes enforce their own CSRF on the same
          // `x-kookr-csrf` header (different nonce); skip them to avoid a collision.
          isExempt: isShareGuardedRoute,
        }),
      );
    }
  }

  app.use(
    '/api/*',
    createJsonRequestBodyLimitMiddleware(
      deps.requestBodyLimitBytes ?? readRequestBodyLimitBytesFromEnv(),
    ),
  );

  const requestDurationMetrics = deps.requestDurationMetrics ?? new RequestDurationMetrics();
  app.use('*', createRequestDurationMiddleware(requestDurationMetrics));

  // Hoist the coordinator-suppression-store fallback so task-routes (PATCH /edges
  // snapshot broadcast) and coordinator-routes (3 mutation handlers) share one
  // instance. Pre-split, a single closure-scoped store backed both call sites;
  // splitting the module would otherwise leave each module to construct its own
  // fallback, silently diverging the suppression view across the two surfaces.
  const sharedDeps: RouteDeps = {
    ...deps,
    requestDurationMetrics,
    coordinatorSuppressions:
      deps.coordinatorSuppressions ?? new CoordinatorSuppressionStore(deps.kookrDir ?? deps.serverCwd),
  };

  // #804: browser cookie-exchange endpoint (POST /api/auth/session). Allow-listed
  // past the actor gate (isUnauthenticatedRoute) but enforces its own same-origin
  // + transport-posture checks. A no-op 503 when the session feature is unconfigured.
  registerAuthSessionRoutes(app, { apiAuth: sharedDeps.apiAuth, sessionAuth: sharedDeps.sessionAuth });

  registerDiagnosticsRoutes(app, sharedDeps);
  registerAdminRoutes(app, sharedDeps);
  registerSettingsRoutes(app, sharedDeps);
  registerRalphRoutes(app, sharedDeps);
  registerTaskRoutes(app, sharedDeps);
  registerCoordinatorRoutes(app, sharedDeps);
  registerAgentRoutes(app, sharedDeps);
  registerTaskRelationsRoutes(app, sharedDeps);
  registerCostComparisonRoutes(app, sharedDeps);
  registerProjectRoutes(app, sharedDeps);
  registerOssAttemptRoutes(app, sharedDeps);
  registerScheduleRoutes(app, sharedDeps);
  registerDeployRoutes(app, sharedDeps);
  registerContactShareRoutes(app, sharedDeps);
  registerShareRoutes(app, sharedDeps);
  registerRelayConnectionRoutes(app, sharedDeps);
  registerSessionSharingRecoveryRoutes(app, sharedDeps);
  registerCollaborationPairingRoutes(app, sharedDeps);

  const speakEnabled = deps.speakFindingEnabled !== false;
  const speakCache = deps.ttsUrl
    ? new AgentSpeakCache({
        llmClient: deps.llmClient ?? null,
        ttsUrl: deps.ttsUrl,
        voice: deps.ttsVoice ?? DEFAULT_TTS_VOICE,
      })
    : null;
  const taskSpeakCache = deps.ttsUrl
    ? new TaskSpeechSummaryCache({
        llmClient: deps.llmClient ?? null,
        ttsUrl: deps.ttsUrl,
        voice: deps.ttsVoice ?? DEFAULT_TTS_VOICE,
      })
    : null;
  registerSpeechRoutes(app, sharedDeps, {
    enabled: speakEnabled,
    cache: speakCache,
    taskCache: taskSpeakCache,
    ttsUrl: deps.ttsUrl,
    ttsVoice: deps.ttsVoice ?? DEFAULT_TTS_VOICE,
  });

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
