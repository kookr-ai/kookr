import { NO_ENV_ALLOWLIST, shouldScrubEnvKey } from '../test/scrub-agent-env.js';

/**
 * Provider credential variables the LLM factory reads *without* a `KOOKR_`
 * prefix (see `src/adapters/llm/factory.ts` and the OpenRouter/Requesty/
 * Baseten clients it wraps). An `auto`-mode factory accepts any of them, so
 * leaving one in the child env is enough to bring the task namer live against
 * a real provider — exactly what #3585 saw on developer machines.
 */
const PROVIDER_CREDENTIAL_ENV_KEYS: ReadonlySet<string> = new Set([
  'OPENROUTER_API_KEY',
  'REQUESTY_API_KEY',
  'BASETEN_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

/**
 * Build the environment for an E2E child test-server spawned from a Playwright
 * fixture.
 *
 * The Vitest suite deliberately scrubs ambient KOOKR_*, CLAUDE_*, and
 * ANTHROPIC_* variables so a local run matches clean CI (#1372). The Playwright
 * fixtures, however, used to spread `...process.env` straight into their child
 * servers, so a developer running the E2E suite with a live Kookr daemon /
 * Claude Code session — or a provider API key — in the parent shell would leak
 * that ambient config into the server under test — masking real behavior and
 * losing reliability signal (#2814, #3585).
 *
 * This is the one shared sanitizer for every E2E child server. It returns a
 * fresh copy of `process.env` in which:
 *   - every KOOKR_* / CLAUDE_* / ANTHROPIC_* key is removed — no allowlist,
 *     since the child server has its own defaults and each fixture passes the
 *     variables it actually needs via `overrides`;
 *   - every unprefixed provider credential the LLM factory reads is removed,
 *     so the child server always runs with AI features disabled;
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
    if (PROVIDER_CREDENTIAL_ENV_KEYS.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}
