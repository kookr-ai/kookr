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
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitFile(repo: string, name: string, body: string | Buffer): void {
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
    env: { ...gitExecEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
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

  it('is stable when the base moves in the SAME file far from the hunk', () => {
    const repo = makeRepo();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    commitFile(repo, 'big.txt', `${lines.join('\n')}\n`);
    git(repo, 'checkout', '-q', '-b', 'feature');
    const edited = [...lines];
    edited[35] = 'line 35 changed';
    commitFile(repo, 'big.txt', `${edited.join('\n')}\n`);
    const before = run(repo, ['main']).stdout;
    git(repo, 'checkout', '-q', 'main');
    commitFile(repo, 'big.txt', `new first line\nanother\n${lines.join('\n')}\n`);
    git(repo, 'checkout', '-q', 'feature');
    git(repo, 'rebase', '-q', 'main');
    const after = run(repo, ['main', 'feature']);
    expect(after.status, after.stderr).toBe(0);
    expect(after.stdout).toBe(before);
  });

  describe('is sensitive to every content byte', () => {
    function branchWith(file: string, body: string | Buffer) {
      const repo = makeRepo();
      commitFile(repo, file, typeof body === 'string' ? '' : Buffer.from([0, 1, 2, 3]));
      git(repo, 'checkout', '-q', '-b', 'feature');
      return repo;
    }
    const idOf = (repo: string) => {
      const r = run(repo, ['main']);
      expect(r.status, r.stderr).toBe(0);
      return r.stdout;
    };

    it('(a) a whitespace-only re-indent of a changed line', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'f.js', 'if (x) {\n  run();\n}\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'f.js', 'if (x) {\n    run();\n}\n');
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(b) removing one space inside a string on a changed line', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'f.js', 'const s = "a b";\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'f.js', 'const s = "ab";\n');
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(c) replacing the bytes of a binary file the PR adds', () => {
      const a = branchWith('x.txt', 'x');
      commitFile(a, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 5]));
      const b = branchWith('x.txt', 'x');
      commitFile(b, 'blob.bin', Buffer.from([0, 1, 2, 3, 4, 6]));
      expect(idOf(a)).not.toBe(idOf(b));
    });

    it('(d) a file mode change', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      commitFile(a, 'run.sh', 'echo hi\n');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      commitFile(b, 'run.sh', 'echo hi\n');
      const before = idOf(b);
      git(b, 'update-index', '--chmod=+x', 'run.sh');
      git(b, 'commit', '-q', '-m', 'chmod');
      expect(idOf(b)).not.toBe(before);
      expect(idOf(b)).not.toBe(idOf(a));
    });

    it('(e) a rename with identical content', () => {
      const a = makeRepo();
      git(a, 'checkout', '-q', '-b', 'feature');
      git(a, 'mv', 'base.txt', 'renamed.txt');
      git(a, 'commit', '-q', '-m', 'rename');
      const b = makeRepo();
      git(b, 'checkout', '-q', '-b', 'feature');
      git(b, 'mv', 'base.txt', 'other-name.txt');
      git(b, 'commit', '-q', '-m', 'rename');
      const idA = idOf(a);
      expect(idA).toMatch(/^[0-9a-f]{40}$/);
      expect(idA).not.toBe(idOf(b));
    });
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

  it('--expect-head passes when the fetched head matches, and fails when it does not', () => {
    const { repo, stub } = setup();
    const env = { PATH: `${stub}:${process.env.PATH}` };
    const head = git(repo, 'rev-parse', 'feature');
    const ok = run(repo, ['--pr', '7', '--expect-head', head.toUpperCase()], env);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(run(repo, ['main', 'feature']).stdout);
    const bad = run(repo, ['--pr', '7', '--expect-head', 'f'.repeat(40)], env);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('not the expected head');
  });

  it('--expect-head is rejected without --pr', () => {
    expect(run(makeRepo(), ['main', '--expect-head', 'a'.repeat(40)]).status).toBe(2);
  });

  it('fails when the pull ref cannot be fetched', () => {
    const { repo, stub } = setup();
    const r = run(repo, ['--pr', '8'], { PATH: `${stub}:${process.env.PATH}` });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });
});
