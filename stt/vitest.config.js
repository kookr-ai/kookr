import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A developer's microphone-corpus opt-in must never archive mock audio.
    // Corpus tests opt in explicitly with their own temporary directories.
    env: { KOOKR_STT_CORPUS: 'false' },
    include: ['src/**/*.test.js'],
    exclude: ['src/**/*.integration.test.js'],
  },
});
