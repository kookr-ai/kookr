// Vitest globalSetup: guards the shared git-repo config across a test run.
//
// setup() snapshots the shared config's identity + core.bare before any test
// worker spawns; teardown() (after all workers exit — no race) detects a
// test-identity, a core.bare flip, or bare-repo debris, heals the config, and
// throws so the run fails and names the cause. See ./git-repo-guard.ts for the
// rationale and the (unit-tested) detection logic.
//
// Defensive by design: if the repo can't be snapshotted (not a git checkout,
// git unavailable), it no-ops rather than breaking the suite.

import {
  snapshotRepoConfig,
  readRepoConfigState,
  assessDrift,
  healRepoConfig,
  formatFailure,
  type RepoConfigSnapshot,
} from './git-repo-guard.js';

let before: RepoConfigSnapshot | null = null;

export function setup(): void {
  before = snapshotRepoConfig();
}

export function teardown(): void {
  if (!before) return;
  const after = readRepoConfigState(before.repoRoot);
  const findings = assessDrift(before, after);
  if (findings.length === 0) return;
  const actions = healRepoConfig(before, findings);

  // Fail the run via process.exitCode — NOT by throwing. Verified on vitest 4:
  // a throw in globalSetup teardown is logged as "error during close" but leaves
  // the exit code 0, so `pnpm test` / CI would stay green while the config was
  // poisoned. Setting process.exitCode makes `vitest run` exit non-zero. Do not
  // "simplify" this back to a throw.
  process.exitCode = 1;
  console.error(formatFailure(findings, actions, before.sharedConfigPath));
}
