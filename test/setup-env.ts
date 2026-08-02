// Vitest setupFiles: scrub ambient KOOKR_*/CLAUDE_*/ANTHROPIC_* so a local
// run (with a live Kookr daemon / Claude Code session in the parent shell)
// sees the same env as clean CI (#1372).
//
// Vitest's `test.env` can only *set* variables; it never deletes ambient ones.
// This file runs once before every test file and removes every matching key
// that is not on the explicit allowlist below.
//
// Allowlist = keys intentionally injected by vitest.config.ts `test.env`.
// Keep it short and in sync with that block — do not grow it for ambient
// convenience. Tests that need a var should set it themselves (vi.stubEnv
// continues to work after the scrub).

/** Keys preserved across the scrub. Mirrors vitest.config.ts `test.env`. */
export const ALLOWED_ENV_PREFIX_VARS: ReadonlySet<string> = new Set([
  'KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE',
  'KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS',
  'KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS',
  'KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS',
  'KOOKR_LESSON_SPOOL',
  'KOOKR_SIGNAL_OUTBOX',
  'KOOKR_PROD_SMOKE_TICK',
  'KOOKR_DEPLOY_LAG_DETECTOR',
  'KOOKR_RELAY_DIE_WITH_PARENT',
  'KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS',
  'KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS',
]);

const SCRUB_PREFIXES = ['KOOKR_', 'CLAUDE_', 'ANTHROPIC_'] as const;

/** True when `key` matches a scrub prefix and is not on the allowlist. */
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

// Side effect: run at worker/setupFiles load time.
scrubAmbientAgentEnv();
