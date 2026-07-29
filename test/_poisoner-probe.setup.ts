// TEMPORARY CI diagnostic for issue #1437 — REMOVED before merge.
//
// The git-repo-guard globalSetup (test/git-repo-guard.global.ts) fires in CI
// because some test writes a test-domain user.email into the shared repo
// config, but it only sees the *final* poisoned state at teardown — it cannot
// name the offending test. This per-worker hook reads the shared config after
// every test AND after every file, printing "@@@POISONER@@@ <test> :: <path>"
// the instant a test-domain identity appears, then heals it so the next test
// starts clean and the run still passes (the guard is left lenient here).
//
// It mirrors the guard's own read (`git config --local --get-all user.email`
// with cwd pinned to the repo root, resolved once per worker) so it sees
// exactly the config the guard checks — no path-format assumptions.
import { afterEach, afterAll, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const TEST_IDENTITY = /@(?:[^@\s]*\.)?example\.(?:com|org|net)$|@[^@\s]*\.example$/i;

// Repo root, resolved once in the worker's initial cwd (the checkout root).
let repoRoot: string;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() || process.cwd();
} catch {
  repoRoot = process.cwd();
}

function poisonedEmail(): string | null {
  if (!repoRoot) return null;
  try {
    const out = execFileSync('git', ['-C', repoRoot, 'config', '--local', '--get-all', 'user.email'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const email = line.trim();
      if (email && TEST_IDENTITY.test(email)) return email;
    }
  } catch {
    /* no local email set — clean */
  }
  return null;
}

function heal(): void {
  if (!repoRoot) return;
  try {
    execFileSync('git', ['-C', repoRoot, 'config', '--local', '--unset-all', 'user.email'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    execFileSync('git', ['-C', repoRoot, 'config', '--local', '--unset-all', 'user.name'], { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
}

afterEach(() => {
  const email = poisonedEmail();
  if (!email) return;
  const state = expect.getState();
  // eslint-disable-next-line no-console
  console.error(`@@@POISONER@@@ email=${email} :: TEST=${state.currentTestName} :: ${state.testPath}`);
  heal();
});

afterAll(() => {
  const email = poisonedEmail();
  if (!email) return;
  const state = expect.getState();
  // Poison landed in a file-level hook (beforeAll/afterAll) — no test owns it.
  // eslint-disable-next-line no-console
  console.error(`@@@POISONER@@@ email=${email} :: FILE-HOOK :: ${state.testPath}`);
  heal();
});
