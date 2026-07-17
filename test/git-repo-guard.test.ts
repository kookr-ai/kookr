import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestIdentity,
  assessDrift,
  healedIdentity,
  snapshotRepoConfig,
  readRepoConfigState,
  healRepoConfig,
  type RepoConfigSnapshot,
} from './git-repo-guard.js';

const base = (over: Partial<RepoConfigSnapshot> = {}): RepoConfigSnapshot => ({
  sharedConfigPath: '/x/.git/config',
  repoRoot: '/x',
  userEmail: null,
  userName: null,
  bare: 'false',
  ...over,
});

describe('isTestIdentity', () => {
  it('flags RFC 2606 reserved domains, case-insensitively', () => {
    for (const e of ['test@example.com', 'ci@example.org', 'x@example.net', 'bot@build.example', 'TEST@EXAMPLE.COM']) {
      expect(isTestIdentity(e)).toBe(true);
    }
  });
  it('leaves real addresses and null alone', () => {
    for (const e of ['dev@company.com', 'jane@gmail.com', 'me@example.company', 'me@myexample.com', null]) {
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
  });

  it('does NOT flag a legit local identity', () => {
    const before = base({ userEmail: 'dev@company.com' });
    expect(assessDrift(before, { userEmail: 'dev@company.com', userName: 'Dev', bare: 'false', rootDebris: [] })).toEqual([]);
  });

  it('flags core.bare only when it flips to true', () => {
    expect(assessDrift(base({ bare: 'false' }), { userEmail: null, userName: null, bare: 'true', rootDebris: [] }))
      .toEqual([{ kind: 'core-bare', detail: expect.stringContaining('core.bare') }]);
    // Already-bare stays quiet (a genuine bare repo is not corruption).
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

describe('healedIdentity', () => {
  it('restores a real prior identity', () => {
    expect(healedIdentity('dev@company.com')).toBe('dev@company.com');
  });
  it('unsets when prior was absent or itself a test identity', () => {
    expect(healedIdentity(null)).toBeNull();
    expect(healedIdentity('test@example.com')).toBeNull();
  });
});

// Integration: prove the detect→heal loop against a REAL temp repo, exactly
// mirroring how the globalSetup uses these functions. This is the test that
// would fail if the guard stopped catching the actual poisoning.
describe('detect + heal against a real repo', () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-repo-guard-'));
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const snapshotOf = (): RepoConfigSnapshot => {
    const s = snapshotRepoConfig();
    // snapshotRepoConfig reads the ambient repo; re-point it at our temp repo.
    return { ...(s ?? base()), repoRoot: dir, sharedConfigPath: join(dir, '.git', 'config') };
  };

  it('catches a poisoned identity and heals to unset', () => {
    const before = { ...snapshotOf(), userEmail: null, userName: null };
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Kookr Test');

    const findings = assessDrift(before, readRepoConfigState(dir));
    expect(findings.some((f) => f.kind === 'identity')).toBe(true);

    healRepoConfig(before, findings);
    expect(readRepoConfigState(dir).userEmail).toBeNull();
  });

  it('heals a poisoned identity back to a real prior value', () => {
    git('config', 'user.email', 'real@dev.io');
    const before = { ...snapshotOf(), userEmail: 'real@dev.io' };
    git('config', 'user.email', 'test@example.com');

    const findings = assessDrift(before, readRepoConfigState(dir));
    healRepoConfig(before, findings);
    expect(readRepoConfigState(dir).userEmail).toBe('real@dev.io');
  });

  it('catches and resets a core.bare flip', () => {
    const before = { ...snapshotOf(), bare: 'false' };
    git('config', 'core.bare', 'true');

    const findings = assessDrift(before, readRepoConfigState(dir));
    expect(findings.some((f) => f.kind === 'core-bare')).toBe(true);

    healRepoConfig(before, findings);
    expect(readRepoConfigState(dir).bare).toBe('false');
  });

  it('stays silent when a legit identity is set and nothing is poisoned', () => {
    git('config', 'user.email', 'dev@company.com');
    const before = { ...snapshotOf(), userEmail: 'dev@company.com' };
    expect(assessDrift(before, readRepoConfigState(dir))).toEqual([]);
  });

  it('detects a bare-repo skeleton dropped at the root', () => {
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(dir, 'objects'), { recursive: true });
    mkdirSync(join(dir, 'refs'), { recursive: true });
    const before = snapshotOf();
    expect(assessDrift(before, readRepoConfigState(dir)).some((f) => f.kind === 'bare-debris')).toBe(true);
  });
});
