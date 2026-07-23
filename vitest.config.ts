import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'relay/**/*.test.ts', 'scripts/**/*.test.ts', 'demo/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*-e2e.test.ts'],
    // Multi-server integration tests (relay + createKookrServerInternal) regularly
    // need >5s under concurrent suite load on a busy workstation. Unit tests still
    // finish in ms; this only raises the hang ceiling.
    testTimeout: 15_000,
    // Fails the run if a test poisons the shared git config (test identity,
    // core.bare flip, or bare-repo debris) and heals it. See test/git-repo-guard.ts.
    globalSetup: ['./test/git-repo-guard.global.ts'],
    env: {
      // Claude Code launches submit the prompt via bracketed paste so the
      // trailing Enter is parsed as a keystroke (see
      // resolveBracketedPasteSubmit). The unit suite opts out so launch
      // tests exercise the legacy single-write delivery path and stay fast;
      // dedicated tests pass `promptBracketedPaste: true` explicitly.
      KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0',
      // SessionBridge waits for the browser FitAddon size before ring replay
      // in production; unit tests that never send resize would otherwise pay
      // the full wait on every start(). Dedicated tests set these explicitly.
      KOOKR_SESSION_BRIDGE_INITIAL_RESIZE_WAIT_MS: '0',
      KOOKR_SESSION_BRIDGE_RESIZE_DEBOUNCE_MS: '0',
      KOOKR_SESSION_BRIDGE_LIVE_REDRAW_NUDGE_MS: '0',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/server/start.ts'],
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: 'coverage',
    },
  },
});
