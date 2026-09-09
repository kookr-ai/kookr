import { defineConfig } from 'vitest/config';

/**
 * Root Vitest integration lane (#2823).
 *
 * The default vitest.config.ts excludes src glob patterns
 * "*.integration.test.ts" and "*-e2e.test.ts" so `pnpm test` stays
 * credential-free and fast. This config is the dedicated command for
 * those files.
 *
 * Inventory (keep in sync with scripts/integration-lane-inventory.test.ts):
 * - credential-gated: skip without a provider API key (describe.skipIf)
 * - self-contained: none today — hyphen-named "*-integration.test.ts"
 *   files already run under `pnpm test` by design
 *
 * Do not load test/setup-env.ts here: that scrub deletes ANTHROPIC_*,
 * which the live naming tests need when a key is present.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts', 'src/**/*-e2e.test.ts'],
    // Empty self-contained subset must still exit 0.
    passWithNoTests: true,
    // Live LLM calls need more headroom than the unit suite.
    testTimeout: 30_000,
    globalSetup: [
      './test/git-repo-guard.global.ts',
      './test/relay-orphan-reaper.global.ts',
      './test/dtach-master-reaper.global.ts',
    ],
    env: {
      // Pin provider selection: this lane skips test/setup-env.ts, so ambient
      // KOOKR_LLM_PROVIDER from a developer shell would otherwise leak in and
      // can desync hasApiKey vs createLlmClient() (e.g. ANTHROPIC key present
      // but KOOKR_LLM_PROVIDER=baseten yields no client).
      KOOKR_LLM_PROVIDER: 'auto',
      KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0',
      KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS: '0',
      KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS: '0',
      KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS: '0',
      KOOKR_LESSON_SPOOL: '0',
      KOOKR_SIGNAL_OUTBOX: '0',
      KOOKR_PROD_SMOKE_TICK: '0',
      KOOKR_DEPLOY_LAG_DETECTOR: '0',
      KOOKR_DEPLOY_CONVERGENCE: '0',
      KOOKR_RELAY_DIE_WITH_PARENT: '1',
      KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS: '250',
      KOOKR_RELAY_ORPHAN_SWEEP_INTERVAL_HOURS: '0',
    },
  },
});
