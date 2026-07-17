// Detection + healing logic for the test-suite git-repo guard.
//
// Why this exists: git worktrees SHARE the main repo's `.git/config`. A test
// that runs `git config user.email test@example.com` (or `git init --bare`)
// with a cwd that resolves into the real repo — an undefined tmpdir variable, a
// relative path, a test invoked from the wrong directory — silently rewrites the
// shared config for the whole repo and every worktree at once. The symptom
// surfaces days later: every commit is authored by a fake person and the CLA
// bot rejects the PR; or `core.bare` flips and `git status` breaks. This module
// lets a vitest globalSetup snapshot the shared config before the suite and, on
// teardown, detect → heal → fail if any test poisoned it — pinning the blame to
// the run that caused it instead of a downstream mystery.
//
// The pure `assessDrift` core is unit-tested; the git I/O is thin and defensive.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** RFC 2606 reserved documentation domains — never a real committer. Matches the
 * second-level domains and any subdomain of them (`x@sub.example.net`), plus the
 * `.example` TLD. Deliberately does NOT match `x@example.company`,
 * `x@myexample.com`, or `x@example.com.evil.com` (a real domain owned by evil). */
const TEST_IDENTITY_DOMAIN = /@(?:[^@\s]*\.)?example\.(?:com|org|net)$|@[^@\s]*\.example$/i;

/** Root entries that together look like a stray `git init --bare` skeleton. */
const BARE_SKELETON_ENTRIES = ['HEAD', 'objects', 'refs'] as const;

export interface RepoConfigSnapshot {
  /** Absolute path to the shared config (`$GIT_COMMON_DIR/config`). */
  sharedConfigPath: string;
  repoRoot: string;
  userEmail: string | null;
  userName: string | null;
  bare: string | null;
}

export interface RepoConfigState {
  userEmail: string | null;
  userName: string | null;
  bare: string | null;
  /** Bare-skeleton files found at the repo root (debris from a stray init). */
  rootDebris: string[];
}

export type DriftFinding =
  | { kind: 'identity'; detail: string }
  | { kind: 'core-bare'; detail: string }
  | { kind: 'bare-debris'; detail: string };

export function isTestIdentity(email: string | null): boolean {
  return email != null && TEST_IDENTITY_DOMAIN.test(email);
}

/**
 * Pure: compare the pre-suite snapshot against the post-suite state and report
 * what a test corrupted. Flags a test-domain `user.email`, a `core.bare` flip to
 * true in a working checkout, and a bare-repo skeleton appearing at the root.
 *
 * Detection keys on `user.email` — the reliable, CLA-relevant signal (there is
 * no dependable pattern for a "test" `user.name`). A poisoned name paired with a
 * *real* email is therefore not detected here; but whenever an identity finding
 * DOES fire, healing restores email and name together (see healRepoConfig), so a
 * name never survives half-healed.
 */
export function assessDrift(before: RepoConfigSnapshot, after: RepoConfigState): DriftFinding[] {
  const findings: DriftFinding[] = [];

  if (isTestIdentity(after.userEmail)) {
    findings.push({
      kind: 'identity',
      detail: `user.email is "${after.userEmail}"` + (isTestIdentity(before.userEmail) ? ' (already poisoned before the suite)' : ' (a test wrote it into the shared config)'),
    });
  }

  if (after.bare === 'true' && before.bare !== 'true') {
    findings.push({
      kind: 'core-bare',
      detail: 'core.bare flipped to true in a working checkout (a stray `git init --bare` ran in the repo)',
    });
  }

  if (after.rootDebris.length > 0) {
    findings.push({
      kind: 'bare-debris',
      detail: `bare-repo skeleton appeared at the repo root: ${after.rootDebris.join(', ')}`,
    });
  }

  return findings;
}

// ---- git I/O (thin, defensive) --------------------------------------------

/** Strip inherited GIT_* env that would redirect git away from the target repo.
 * vitest runs many test files in one worker and leaks these between them; a
 * stray GIT_DIR makes `git rev-parse` find a repo where there is none and
 * `git config --local` read the wrong config. The guard runs git against the
 * ambient repo, so it wants cwd-based discovery, never an inherited override. */
export function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
  ]) delete out[k];
  return out;
}

function gitCapture(args: string[], cwd?: string): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: cleanGitEnv() });
    return out.trim();
  } catch {
    return null;
  }
}

function localConfig(key: string, repoRoot: string): string | null {
  const v = gitCapture(['config', '--local', '--get', key], repoRoot);
  return v && v.length > 0 ? v : null;
}

/** Snapshot the shared-config identity/bare state of the repo at `cwd` (default
 * the process cwd). Returns null when not in a usable git repo, so callers can
 * no-op instead of failing the suite. The `cwd` param keeps this testable
 * without process.chdir (which is unsupported in vitest worker threads). */
export function snapshotRepoConfig(cwd: string = process.cwd()): RepoConfigSnapshot | null {
  const repoRoot = gitCapture(['rev-parse', '--show-toplevel'], cwd);
  const commonDir = gitCapture(['rev-parse', '--git-common-dir'], cwd);
  if (!repoRoot || !commonDir) return null;
  const sharedConfigPath = join(repoRoot, commonDir, 'config');
  return {
    sharedConfigPath,
    repoRoot,
    userEmail: localConfig('user.email', repoRoot),
    userName: localConfig('user.name', repoRoot),
    bare: localConfig('core.bare', repoRoot),
  };
}

export function readRepoConfigState(repoRoot: string): RepoConfigState {
  const rootDebris = BARE_SKELETON_ENTRIES.filter((e) => existsSync(join(repoRoot, e)));
  return {
    userEmail: localConfig('user.email', repoRoot),
    userName: localConfig('user.name', repoRoot),
    bare: localConfig('core.bare', repoRoot),
    // Only report debris when the *whole* skeleton is present — a repo may
    // legitimately have a tracked `refs/` or `objects/` dir name elsewhere, but
    // HEAD+objects+refs together at the worktree root is the stray-init signature.
    rootDebris: rootDebris.length === BARE_SKELETON_ENTRIES.length ? rootDebris : [],
  };
}

/** Surgically undo config poisoning (never touches unrelated config). Debris
 * files are reported, not deleted, since removing files in a teardown is riskier
 * than a config edit. Returns the actions taken, for the failure message. */
export function healRepoConfig(before: RepoConfigSnapshot, findings: DriftFinding[]): string[] {
  const actions: string[] = [];
  const root = before.repoRoot;

  const restore = (key: string, value: string | null): void => {
    if (value == null) gitCapture(['config', '--local', '--unset', key], root);
    else gitCapture(['config', '--local', key, value], root);
  };

  if (findings.some((f) => f.kind === 'identity')) {
    // Restore the pre-suite identity VERBATIM — that is the known-good state —
    // healing email and name together as one unit so neither is left half-set.
    // If the pre-suite email was itself a test identity (already poisoned before
    // the run), the whole identity is untrusted: unset both so the global
    // identity applies. Keying the name off the email's trust (not the name's
    // own prior value) is deliberate — email and name are one identity.
    const priorPoisoned = isTestIdentity(before.userEmail);
    restore('user.email', priorPoisoned ? null : before.userEmail);
    restore('user.name', priorPoisoned ? null : before.userName);
    actions.push(
      priorPoisoned
        ? 'unset the poisoned identity (global identity now applies)'
        : `restored the pre-suite identity (email=${before.userEmail ?? '<unset>'}, name=${before.userName ?? '<unset>'})`,
    );
  }

  if (findings.some((f) => f.kind === 'core-bare')) {
    restore('core.bare', before.bare ?? 'false');
    actions.push(`reset core.bare to ${before.bare ?? 'false'}`);
  }

  if (findings.some((f) => f.kind === 'bare-debris')) {
    actions.push('left the bare-repo debris in place — remove it manually: rm -rf HEAD objects refs branches config description info');
  }

  return actions;
}

export function formatFailure(findings: DriftFinding[], actions: string[], sharedConfigPath: string, strict = true): string {
  return [
    '',
    strict
      ? 'git-repo-guard: a test corrupted the shared git repository config.'
      : 'git-repo-guard WARNING: a test corrupted the shared git repository config (healed; set KOOKR_GIT_GUARD_STRICT=1 to fail the run).',
    `  shared config: ${sharedConfigPath}`,
    '',
    'Findings:',
    ...findings.map((f) => `  - [${f.kind}] ${f.detail}`),
    '',
    'Auto-healed:',
    ...actions.map((a) => `  - ${a}`),
    '',
    'Root cause: a test ran a git command (git config / git init) with a cwd that',
    'resolved into the real repo instead of an isolated temp dir. Worktrees share',
    "the main repo's .git/config, so the write hit the whole repo. Fix the test to",
    'operate on a mktemp repo (pass -C <tmpdir> / cwd, and set identity there only).',
    '',
  ].join('\n');
}
