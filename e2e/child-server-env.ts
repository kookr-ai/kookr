import { NO_ENV_ALLOWLIST, shouldScrubEnvKey } from '../test/scrub-agent-env.js';

/**
 * Build the environment for an E2E child test-server spawned from a Playwright
 * fixture.
 *
 * The Vitest suite deliberately scrubs ambient KOOKR_*, CLAUDE_*, and
 * ANTHROPIC_* variables so a local run matches clean CI (#1372). The Playwright
 * fixtures, however, used to spread `...process.env` straight into their child
 * servers, so a developer running the E2E suite with a live Kookr daemon /
 * Claude Code session in the parent shell would leak that ambient config into
 * the server under test — masking real behavior and losing reliability signal
 * (#2814).
 *
 * This is the one shared sanitizer for every E2E child server. It returns a
 * fresh copy of `process.env` in which:
 *   - every KOOKR_* / CLAUDE_* / ANTHROPIC_* key is removed — no allowlist,
 *     since the child server has its own defaults and each fixture passes the
 *     variables it actually needs via `overrides`;
 *   - all other keys — PATH, HOME, TMPDIR/TEMP/TMP, NODE_*, CI, DISPLAY, port
 *     hints, and anything else the OS/CI runner relies on — are preserved so
 *     platform execution is unaffected;
 *   - `overrides` are applied last, so a fixture's explicit E2E_* and KOOKR_*
 *     variables are always present in the child (and win over any ambient key).
 *
 * `process.env` in the Playwright runner is left untouched — only the returned
 * copy is sanitized.
 */
export function sanitizedChildServerEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (shouldScrubEnvKey(key, NO_ENV_ALLOWLIST)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
