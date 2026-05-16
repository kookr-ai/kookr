import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'src/**/*-e2e.test.ts'],
    env: {
      // Claude Code launches submit the prompt via bracketed paste so the
      // trailing Enter is parsed as a keystroke (see
      // resolveBracketedPasteSubmit). The unit suite opts out so launch
      // tests exercise the legacy single-write delivery path and stay fast;
      // dedicated tests pass `promptBracketedPaste: true` explicitly.
      KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/frontend/**', 'src/server/start.ts'],
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      reportsDirectory: 'coverage',
    },
  },
});
