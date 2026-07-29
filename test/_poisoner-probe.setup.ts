// TEMPORARY CI diagnostic for issue #1437 — REMOVED before merge.
//
// The git-repo-guard globalSetup (test/git-repo-guard.global.ts) fires in CI
// because some test writes a test-domain user.email into the shared repo
// config, but it only sees the *final* poisoned state at teardown — it cannot
// name the offending test. This per-worker afterEach reads the shared config
// after every test and prints "@@@POISONER@@@ <test> :: <path>" the instant a
// test-domain identity appears, then heals it so the next test starts clean
// and the run still passes (the guard is left lenient for this diagnostic).
//
// It reads the config FILE directly (cheap) rather than spawning git per test
// (~9k tests), resolving the shared config path once per worker.
import { afterEach, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEST_IDENTITY = /^\s*email\s*=\s*(\S*@(?:[^@\s]*\.)?example\.(?:com|org|net)|\S*@[^@\s]*\.example)\s*$/im;

let sharedConfigPath: string | null = null;
try {
  sharedConfigPath =
    execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() + '/config';
} catch {
  sharedConfigPath = null;
}

afterEach(() => {
  if (!sharedConfigPath) return;
  let contents: string;
  try {
    contents = readFileSync(sharedConfigPath, 'utf8');
  } catch {
    return;
  }
  const match = TEST_IDENTITY.exec(contents);
  if (!match) return;
  // eslint-disable-next-line no-console
  console.error(
    `@@@POISONER@@@ email=${match[1]} :: ${expect.getState().currentTestName} :: ${expect.getState().testPath}`,
  );
  try {
    execFileSync('git', ['config', '--local', '--unset-all', 'user.email'], { stdio: 'ignore' });
    execFileSync('git', ['config', '--local', '--unset-all', 'user.name'], { stdio: 'ignore' });
  } catch {
    /* best-effort heal */
  }
});
