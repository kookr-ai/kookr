import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestIdentity,
  assessDrift,
  snapshotRepoConfig,
  readRepoConfigState,
  healRepoConfig,
  cleanGitEnv,
  type RepoConfigSnapshot,
} from './git-repo-guard.js';
import { runGuardTeardown } from './git-repo-guard.global.js';

// Run git with the same GIT_*-stripped env the guard uses, so temp repos are
// created and read correctly even when a sibling test file leaked GIT_DIR etc.
// into this worker's process.env.
const ENV = { stdio: 'ignore' as const, env: cleanGitEnv() };
const gitInit = (dir: string) => execFileSync('git', ['init', '-q', dir], ENV);

const base = (over: Partial<RepoConfigSnapshot> = {}): RepoConfigSnapshot => ({
  sharedConfigPath: '/x/.git/config',
  repoRoot: '/x',
  userEmail: null,
  userName: null,
  bare: 'false',
  ...over,
});

describe('isTestIdentity', () => {
  it('flags reserved domains and their subdomains, case-insensitively', () => {
    for (const e of [
      'test@example.com', 'ci@example.org', 'x@example.net', 'bot@build.example',
      'TEST@EXAMPLE.COM', 'dev@sub.example.net', 'a@deep.sub.example.com',
    ]) {
      expect(isTestIdentity(e)).toBe(true);
    }
  });
  it('leaves real addresses and null alone (no false positives)', () => {
    for (const e of [
      'dev@company.com', 'jane@gmail.com', 'me@example.company',
      'me@myexample.com', 'x@example.com.evil.com', null,
    ]) {
      expect(isTestIdentity(e)).toBe(false);
    }
  });
});

describe('assessDrift (pure)', () => {
  it('reports nothing for a clean, unchanged repo', () => {
    expect(assessDrift(base(), { userEmail: null, userName: null, bare: 'false', rootDebris: [] })).toEqual([]);
  });

  it('flags a test identity written during the suite', () => {
    const f = assessDrift(base(), { userEmail: 'test@example.com', userName: 'Kookr Test', bare: 'false', rootDebris: [] });
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('identity');
    expect(f[0].detail).toContain('a test wrote it');
  });

  it('notes when the identity was already poisoned before the suite', () => {
    const f = assessDrift(base({ userEmail: 'test@example.com' }), { userEmail: 'test@example.com', userName: null, bare: 'false', rootDebris: [] });
    expect(f[0].detail).toContain('already poisoned before the suite');
  });

  it('does NOT flag a legit local identity', () => {
    const before = base({ userEmail: 'dev@company.com' });
    expect(assessDrift(before, { userEmail: 'dev@company.com', userName: 'Dev', bare: 'false', rootDebris: [] })).toEqual([]);
  });

  it('flags core.bare only when it flips to true', () => {
    expect(assessDrift(base({ bare: 'false' }), { userEmail: null, userName: null, bare: 'true', rootDebris: [] }))
      .toEqual([{ kind: 'core-bare', detail: expect.stringContaining('core.bare') }]);
    expect(assessDrift(base({ bare: 'true' }), { userEmail: null, userName: null, bare: 'true', rootDebris: [] })).toEqual([]);
  });

  it('flags bare-repo debris at the root', () => {
    const f = assessDrift(base(), { userEmail: null, userName: null, bare: 'false', rootDebris: ['HEAD', 'objects', 'refs'] });
    expect(f).toEqual([{ kind: 'bare-debris', detail: expect.stringContaining('skeleton') }]);
  });

  it('reports every distinct corruption at once', () => {
    const f = assessDrift(base(), { userEmail: 'test@example.com', userName: 'T', bare: 'true', rootDebris: ['HEAD', 'objects', 'refs'] });
    expect(f.map((x) => x.kind).sort()).toEqual(['bare-debris', 'core-bare', 'identity']);
  });
});

describe('snapshotRepoConfig', () => {
  it('returns null outside a git repo (defensive no-op path)', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'git-repo-guard-nongit-'));
    try {
      expect(snapshotRepoConfig(nonGit)).toBeNull();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// Integration: detect→heal against REAL temp repos, with an explicit baseline
// (never reads the ambient repo — the very thing this guard exists to stamp out).
describe('detect + heal against a real repo', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: cleanGitEnv() });
  const snap = (over: Partial<RepoConfigSnapshot> = {}) =>
    base({ repoRoot: dir, sharedConfigPath: join(dir, '.git', 'config'), ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-repo-guard-'));
    gitInit(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('catches a poisoned identity and heals to unset (email AND name)', () => {
    const before = snap({ userEmail: null, userName: null });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Kookr Test');

    const findings = assessDrift(before, readRepoConfigState(dir));
    expect(findings.some((f) => f.kind === 'identity')).toBe(true);

    healRepoConfig(before, findings);
    const after = readRepoConfigState(dir);
    expect(after.userEmail).toBeNull();
    expect(after.userName).toBeNull();
  });

  it('restores a poisoned identity back to a real prior email AND name', () => {
    git('config', 'user.email', 'real@dev.io');
    git('config', 'user.name', 'Real Dev');
    const before = snap({ userEmail: 'real@dev.io', userName: 'Real Dev' });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Kookr Test');

    healRepoConfig(before, assessDrift(before, readRepoConfigState(dir)));
    const after = readRepoConfigState(dir);
    expect(after.userEmail).toBe('real@dev.io');
    expect(after.userName).toBe('Real Dev');
  });

  it('preserves a legit local user.name when only the email was inherited from global', () => {
    // Regression: before = real name, no local email. A test poisons the email.
    // Heal must NOT delete the real name (the earlier bug did).
    git('config', 'user.name', 'Real Dev');
    const before = snap({ userEmail: null, userName: 'Real Dev' });
    git('config', 'user.email', 'test@example.com');

    healRepoConfig(before, assessDrift(before, readRepoConfigState(dir)));
    const after = readRepoConfigState(dir);
    expect(after.userEmail).toBeNull();
    expect(after.userName).toBe('Real Dev');
  });

  it('catches and resets a core.bare flip', () => {
    const before = snap({ bare: 'false' });
    git('config', 'core.bare', 'true');

    const findings = assessDrift(before, readRepoConfigState(dir));
    expect(findings.some((f) => f.kind === 'core-bare')).toBe(true);

    healRepoConfig(before, findings);
    expect(readRepoConfigState(dir).bare).toBe('false');
  });

  it('stays silent when a legit identity is set and nothing is poisoned', () => {
    git('config', 'user.email', 'dev@company.com');
    const before = snap({ userEmail: 'dev@company.com' });
    expect(assessDrift(before, readRepoConfigState(dir))).toEqual([]);
  });

  it('detects a bare-repo skeleton dropped at the root', () => {
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(dir, 'objects'), { recursive: true });
    mkdirSync(join(dir, 'refs'), { recursive: true });
    const before = snap();
    expect(assessDrift(before, readRepoConfigState(dir)).some((f) => f.kind === 'bare-debris')).toBe(true);
  });
});

// The load-bearing "fail the run" link: drive the real teardown decision
// (runGuardTeardown) against an isolated temp-repo snapshot and prove it BOTH
// heals AND sets process.exitCode. This is the exact behavior a
// throw-instead-of-exitCode regression (see the guard's comment) would break
// while every other test stayed green. No process.chdir — the snapshot's
// repoRoot drives all I/O, so this is safe in vitest's worker pool.
describe('runGuardTeardown fails the run on poisoning', () => {
  let dir: string;
  const snapshotOf = () => ({
    sharedConfigPath: join(dir, '.git', 'config'),
    repoRoot: dir,
    userEmail: null,
    userName: null,
    bare: 'false' as string | null,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-repo-guard-e2e-'));
    gitInit(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('in strict mode sets process.exitCode=1 and heals when poisoned', () => {
    const before = snapshotOf(); // clean baseline
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], ENV);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Kookr Test'], ENV);

    const priorExit = process.exitCode;
    const priorStrict = process.env.KOOKR_GIT_GUARD_STRICT;
    process.env.KOOKR_GIT_GUARD_STRICT = '1';
    try {
      runGuardTeardown(before);
      expect(process.exitCode).toBe(1); // the fail-the-run contract (strict)
      const healed = readRepoConfigState(dir);
      expect(healed.userEmail).toBeNull();
      expect(healed.userName).toBeNull();
    } finally {
      // Restore so this test doesn't fail the real suite — vitest tracks
      // pass/fail independently of process.exitCode.
      process.exitCode = priorExit;
      if (priorStrict === undefined) delete process.env.KOOKR_GIT_GUARD_STRICT;
      else process.env.KOOKR_GIT_GUARD_STRICT = priorStrict;
    }
  });

  it('by default (non-strict) heals but does NOT fail the run', () => {
    const before = snapshotOf();
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], ENV);

    const priorExit = process.exitCode;
    const priorStrict = process.env.KOOKR_GIT_GUARD_STRICT;
    delete process.env.KOOKR_GIT_GUARD_STRICT;
    try {
      runGuardTeardown(before);
      expect(process.exitCode).toBe(priorExit); // did not fail the run
      expect(readRepoConfigState(dir).userEmail).toBeNull(); // but still healed
    } finally {
      process.exitCode = priorExit;
      if (priorStrict === undefined) delete process.env.KOOKR_GIT_GUARD_STRICT;
      else process.env.KOOKR_GIT_GUARD_STRICT = priorStrict;
    }
  });

  it('leaves process.exitCode untouched when nothing is poisoned', () => {
    const priorExit = process.exitCode;
    runGuardTeardown(snapshotOf());
    expect(process.exitCode).toBe(priorExit);
  });

  it('no-ops on a null snapshot', () => {
    const priorExit = process.exitCode;
    runGuardTeardown(null);
    expect(process.exitCode).toBe(priorExit);
  });
});
