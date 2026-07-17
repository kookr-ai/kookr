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

/** Whether the guard fails the run (strict) or only heals + warns. Off by
 * default: this guard is being rolled out on a codebase that already has a
 * pre-existing poisoner (surfaced by this very guard in CI — see the linked
 * follow-up), so like any linter it warns first and enforces once the existing
 * violation is fixed. Set KOOKR_GIT_GUARD_STRICT=1 to enforce. The healing —
 * the actual prevention of durable damage — always runs regardless. */
export function isStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.KOOKR_GIT_GUARD_STRICT;
  return v === '1' || v === 'true';
}

/**
 * The guard's decision + action, split out so it can be tested against an
 * isolated temp-repo snapshot without touching the process cwd or the ambient
 * repo. All git I/O runs against `before.repoRoot`.
 *
 * Always heals the poisoned config and warns loudly. In strict mode it also
 * fails the run via process.exitCode — NOT by throwing. Verified on vitest 4:
 * a throw in globalSetup teardown is logged as "error during close" but leaves
 * the exit code 0, so `pnpm test` / CI would stay green. Setting
 * process.exitCode makes `vitest run` exit non-zero. Do not "simplify" the
 * strict failure back to a throw.
 */
export function runGuardTeardown(snapshot: RepoConfigSnapshot | null): void {
  if (!snapshot) return;
  const after = readRepoConfigState(snapshot.repoRoot);
  const findings = assessDrift(snapshot, after);
  if (findings.length === 0) return;
  const actions = healRepoConfig(snapshot, findings);
  if (isStrict()) process.exitCode = 1;
  console.error(formatFailure(findings, actions, snapshot.sharedConfigPath, isStrict()));
}

export function teardown(): void {
  runGuardTeardown(before);
}
