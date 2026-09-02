// Vitest setupFiles: scrub ambient KOOKR_*/CLAUDE_*/ANTHROPIC_* so a local
// run (with a live Kookr daemon / Claude Code session in the parent shell)
// sees the same env as clean CI (#1372).
//
// Vitest's `test.env` can only *set* variables; it never deletes ambient ones.
// This file runs once before every test file and removes every matching key
// that is not on the explicit allowlist below.
//
// The allowlist and scrub predicate live in ./scrub-agent-env.ts (a
// side-effect-free module the E2E child-server sanitizer also reuses, #2814).
// This file only re-exports them and runs the load-time scrub. Keep the
// allowlist in sync with vitest.config.ts `test.env` — do not grow it for
// ambient convenience. Tests that need a var should set it themselves
// (vi.stubEnv continues to work after the scrub).

export {
  ALLOWED_ENV_PREFIX_VARS,
  scrubAmbientAgentEnv,
  shouldScrubEnvKey,
} from './scrub-agent-env.js';

import { scrubAmbientAgentEnv } from './scrub-agent-env.js';

// Side effect: run at worker/setupFiles load time.
scrubAmbientAgentEnv();
