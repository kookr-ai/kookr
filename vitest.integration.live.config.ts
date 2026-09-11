import { defineConfig } from 'vitest/config';

import { CREDENTIAL_GATED_INTEGRATION_FILES } from './scripts/integration-lane-inventory.ts';

/**
 * Opt-in live-LLM integration lane (#2823).
 *
 * Selects the credential-gated subset from the shared inventory. Files use
 * `describe.skipIf` without a provider API key so the command stays exit-0
 * when keys are absent; with keys present it hits real providers.
 *
 * Do not load `test/setup-env.ts` here: that scrub deletes ANTHROPIC_*, which
 * the live naming tests need when a key is present.
 */
export default defineConfig({
  test: {
    include: [...CREDENTIAL_GATED_INTEGRATION_FILES],
    passWithNoTests: true,
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
