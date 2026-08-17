import { join } from 'node:path';
import type { Hono } from 'hono';
import {
  defaultGrokAuthPath,
  grokAuthUsabilityToPreflightResult,
  GrokAuthAvailabilityCache,
} from '../../adapters/grok-auth-availability.js';
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
  /**
   * Shared launch-time availability cache (issue #2537). The preflight endpoint
   * must return the SAME verdict the launch path reads — `isUsable()` after
   * `ensureFresh()` — so `launchWouldRefuse` can never disagree with what a
   * launch in the same TTL window would actually do. Production wires the server's
   * single `grokAuthAvailability` instance; when omitted (unit tests / callers
   * that don't share a cache) the route falls back to a private cache that reads
   * the operator's `auth.json` fresh, preserving the pre-#2537 behavior.
   */
  grokAuthAvailability?: Pick<GrokAuthAvailabilityCache, 'ensureFresh'>;
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
    // Project the DTO from the SAME cached verdict the launch path reads, using
    // the SAME `ensureFresh()` freshness policy (#2537). Within the cache TTL the
    // endpoint and a concurrent launch now agree by construction; a fresh disk
    // inspect here would diverge for up to the TTL after a credential change.
    const cache = deps.grokAuthAvailability
      ?? new GrokAuthAvailabilityCache({ resolveAuthPath: () => authPath });
    const verdict = await cache.ensureFresh();
    const body = await buildGrokAuthStatusResponse({
      authPath,
      roundRobinIndex: deps.settings?.get().roundRobinIndex ?? 0,
      inspect: async () => grokAuthUsabilityToPreflightResult(verdict),
    });
    return c.json(body);
  });
}
