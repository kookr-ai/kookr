// Shared, side-effect-free scrub predicate for ambient agent/provider env.
//
// A local developer's shell (with a live Kookr daemon / Claude Code session)
// exports KOOKR_*, CLAUDE_*, and ANTHROPIC_* variables. Both the Vitest suite
// (test/setup-env.ts, #1372) and the Playwright child servers
// (e2e/child-server-env.ts, #2814) must run against the same clean environment
// as CI, so both scrub those variables. This module holds the shared prefixes
// and predicate; importing it never mutates any environment (unlike
// test/setup-env.ts, whose load-time side effect scrubs the current process).

/** Keys preserved across the Vitest scrub. Mirrors vitest.config.ts `test.env`. */
export const ALLOWED_ENV_PREFIX_VARS: ReadonlySet<string> = new Set([
  'KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE',
  'KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS',
  'KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS',
  'KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS',
  'KOOKR_LESSON_SPOOL',
  'KOOKR_SIGNAL_OUTBOX',
  'KOOKR_PROD_SMOKE_TICK',
  'KOOKR_DEPLOY_LAG_DETECTOR',
  'KOOKR_DEPLOY_CONVERGENCE',
  'KOOKR_RELAY_DIE_WITH_PARENT',
  'KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS',
  'KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS',
]);

/** An empty allowlist: scrub every matching key (used by E2E child servers). */
export const NO_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>();

/** Env-var prefixes that carry ambient project/agent/provider overrides. */
const SCRUB_PREFIXES = ['KOOKR_', 'CLAUDE_', 'ANTHROPIC_'] as const;

/** True when `key` matches a scrub prefix and is not on `allowlist`. */
export function shouldScrubEnvKey(
  key: string,
  allowlist: ReadonlySet<string> = ALLOWED_ENV_PREFIX_VARS,
): boolean {
  if (allowlist.has(key)) return false;
  return SCRUB_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Delete ambient agent-related env keys from `env` (defaults to process.env).
 * Returns the keys that were deleted (sorted for stable assertions).
 */
export function scrubAmbientAgentEnv(
  env: NodeJS.ProcessEnv = process.env,
  allowlist: ReadonlySet<string> = ALLOWED_ENV_PREFIX_VARS,
): string[] {
  const deleted: string[] = [];
  for (const key of Object.keys(env)) {
    if (!shouldScrubEnvKey(key, allowlist)) continue;
    delete env[key];
    deleted.push(key);
  }
  deleted.sort();
  return deleted;
}
