import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { sharedGrokAuthPath } from '../../adapters/grok-home-composer.js';
import { buildGrokAuthStatusResponse } from '../../adapters/grok-auth-status.js';
import { GROK_AUTH_STATUS_PATH } from '../../shared/contracts/grok-auth-status.js';

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

/**
 * GET /api/grok-auth-status — Launch-dialog preflight for Grok credentials.
 *
 * Returns ok | missing | expired | invalid plus the same login command the
 * adapter already uses when it refuses a launch. Token values never leave
 * inspectGrokAuthFile.
 */
export function registerGrokAuthRoutes(app: Hono, deps: GrokAuthRouteDeps = {}): void {
  app.get(GROK_AUTH_STATUS_PATH, async (c) => {
    const home = deps.homedir ?? homedir();
    const authPath = sharedGrokAuthPath(join(home, '.grok'));
    const body = await buildGrokAuthStatusResponse({
      authPath,
      roundRobinIndex: deps.settings?.get().roundRobinIndex ?? 0,
    });
    return c.json(body);
  });
}
