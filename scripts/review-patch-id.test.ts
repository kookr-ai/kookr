/**
 * review-patch-id.sh: the stable patch id of a PR's own diff (#3788).
 * Runs the real script against throwaway git repos; the PR mode additionally
 * uses a stub `gh` and a bare origin that carries refs/pull/<n>/head.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';

const SCRIPT = join(process.cwd(), 'scripts/review-patch-id.sh');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitExecEnv(),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(repo: string, name: string, body: string): void {
  writeFileSync(join(repo, name), body);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', `add ${name}`);
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-patch-id-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commitFile(dir, 'base.txt', 'one\ntwo\nthree\n');
  return dir;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...gitExecEnv(), ...env },
  });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr };
}

describe('review-patch-id.sh (local refs)', () => {
  it('prints the same id before and after rebasing onto a moved base', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    const before = run(repo, ['main']);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toMatch(/^[0-9a-f]{40}$/);

    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'other.txt', 'moved base\n');
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');

    const after = run(repo, ['main', 'feature']);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before.stdout);
  });

  it('prints a different id after an extra change', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    const before = run(repo, ['main']).stdout;
    commitFile(repo, 'more.txt', 'extra\n');
    const after = run(repo, ['main']).stdout;
    expect(after).toMatch(/^[0-9a-f]{40}$/);
    expect(after).not.toBe(before);
  });

  it('prints nothing and exits non-zero for an empty diff', () => {
    const repo = makeRepo();
    const r = run(repo, ['main']);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('empty');
  });

  it('exits 2 on bad usage', () => {
    expect(run(makeRepo(), []).status).toBe(2);
  });
});

describe('review-patch-id.sh --pr', () => {
  function setup() {
    const repo = makeRepo();
    const bare = mkdtempSync(join(tmpdir(), 'review-patch-id-origin-'));
    dirs.push(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'hello\n');
    git(repo, 'push', '-q', 'origin', 'feature:refs/pull/7/head');
    const stub = mkdtempSync(join(tmpdir(), 'review-patch-id-gh-'));
    dirs.push(stub);
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, 'gh'), '#!/usr/bin/env bash\necho main\n');
    chmodSync(join(stub, 'gh'), 0o755);
    return { repo, stub };
  }

  it('matches the local-ref id and leaves branches and the working tree alone', () => {
    const { repo, stub } = setup();
    const local = run(repo, ['main', 'feature']).stdout;
    const branchesBefore = git(repo, 'branch', '--list');
    const r = run(repo, ['--pr', '7'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(local);
    expect(git(repo, 'branch', '--list')).toBe(branchesBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('fails when the pull ref cannot be fetched', () => {
    const { repo, stub } = setup();
    const r = run(repo, ['--pr', '8'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});
