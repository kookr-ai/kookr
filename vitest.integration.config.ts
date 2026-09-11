import { defineConfig } from 'vitest/config';

import { SELF_CONTAINED_INTEGRATION_FILES } from './scripts/integration-lane-inventory.ts';

/**
 * Deterministic root Vitest integration lane (#2823).
 *
 * Selects the self-contained subset from the shared inventory
 * (`scripts/integration-lane-inventory.ts`). Live-LLM files run via
 * `pnpm test:integration:live` instead.
 *
 * Uses the same env scrub / global setup as the unit suite so these tests
 * stay reproducible without provider credentials.
 */
export default defineConfig({
  test: {
    include: [...SELF_CONTAINED_INTEGRATION_FILES],
    passWithNoTests: true,
    testTimeout: 30_000,
    globalSetup: [
      './test/git-repo-guard.global.ts',
      './test/relay-orphan-reaper.global.ts',
      './test/dtach-master-reaper.global.ts',
    ],
    setupFiles: ['./test/setup-env.ts'],
    env: {
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
