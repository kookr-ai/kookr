import { join } from 'node:path';
import type { Hono } from 'hono';
import { defaultGrokAuthPath } from '../../adapters/grok-auth-availability.js';
import { buildGrokAuthStatusResponse } from '../../adapters/grok-auth-status.js';

export interface GrokAuthRouteDeps {
  /**
   * Test seam for the operator home. Production uses `os.homedir()` so the
   * status inspects the same `~/.grok/auth.json` the grok-build adapter shares.
   */
  homedir?: string;
  settings?: {
    get: () => { roundRobinIndex: number };
  };
}

/** Literal path so documented-api-route-verifier can see the registration. */
const GROK_AUTH_STATUS_PATH = '/api/grok-auth-status';

/**
 * GET /api/grok-auth-status — Launch-dialog preflight for Grok credentials.
 *
 * Returns ok | missing | expired | invalid plus the same login command the
 * adapter already uses when it refuses a launch. Token values never leave
 * inspectGrokAuthFile.
 */
export function registerGrokAuthRoutes(app: Hono, deps: GrokAuthRouteDeps = {}): void {
  app.get(GROK_AUTH_STATUS_PATH, async (c) => {
    const authPath = defaultGrokAuthPath(deps.homedir ? join(deps.homedir, '.grok') : undefined);
    const body = await buildGrokAuthStatusResponse({
      authPath,
      roundRobinIndex: deps.settings?.get().roundRobinIndex ?? 0,
    });
    return c.json(body);
  });
}
