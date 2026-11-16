import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../core/git-helpers.js';
import {
  defaultGitRunner,
  listTaskChanges,
  MAX_CHANGED_FILES,
  parseNameStatus,
  parseNumstat,
  parseUnifiedDiff,
  readTaskChangeFile,
} from './task-changes.js';

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, env: gitExecEnv(), encoding: 'utf8' });
}

function commitFile(rel: string, content: string, message: string): void {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
  git('add', rel);
  git('commit', '-q', '-m', message);
}

/**
 * main: base.txt, doomed.txt. staging = main + staging-only.txt (not promoted yet).
 * The task branch `feat` is cut from staging and commits feature.txt.
 */
function setUpStagingBranch(): void {
  commitFile('base.txt', 'one\ntwo\nthree\n', 'base');
  commitFile('doomed.txt', 'bye\n', 'doomed');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  commitFile('staging-only.txt', 'unpromoted\n', 'staging work');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  git('checkout', '-q', '-b', 'feat');
  commitFile('feature.txt', 'a\nb\n', 'feature');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'kookr-task-changes-'));
  repo = path.join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('listTaskChanges', () => {
  it('diffs a branch cut from origin/staging against staging, not main', async () => {
    setUpStagingBranch();
    const res = await listTaskChanges(repo, []);
    expect(res).toEqual({
      kind: 'ok',
      baseRef: 'origin/staging',
      branch: 'feat',
      repoRoot: git('rev-parse', '--show-toplevel').trim(),
      files: [{ path: 'feature.txt', status: 'added', added: 2, removed: 0 }],
      truncated: false,
    });
  });

  it('diffs a branch cut from origin/main against main', async () => {
    commitFile('base.txt', 'one\n', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'staging-tip');
    commitFile('staging-only.txt', 'x\n', 'staging work');
    git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'feat');
    commitFile('feature.txt', 'a\n', 'feature');

    const res = await listTaskChanges(repo, []);
    expect(res.kind === 'ok' && res.baseRef).toBe('origin/main');
    expect(res.kind === 'ok' && res.files.map((f) => f.path)).toEqual(['feature.txt']);
  });

  it('lists uncommitted edits, deletions, renames and new untracked files', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(repo, 'base.txt'), 'one\nTWO\nthree\nfour\n');
    unlinkSync(path.join(repo, 'doomed.txt'));
    git('mv', 'staging-only.txt', 'moved.txt');
    // Committed after the fork point and deleted again: nothing to show.
    commitFile('transient.txt', 'tmp\n', 'transient');
    unlinkSync(path.join(repo, 'transient.txt'));
    writeFileSync(path.join(repo, 'untracked.txt'), 'x\ny\nz');
    writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');

    const res = await listTaskChanges(repo, []);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.files).toEqual([
      { path: '.gitignore', status: 'added', added: 1, removed: 0 },
      { path: 'base.txt', status: 'modified', added: 2, removed: 1 },
      { path: 'doomed.txt', status: 'deleted', added: 0, removed: 1 },
      { path: 'feature.txt', status: 'added', added: 2, removed: 0 },
      { path: 'moved.txt', oldPath: 'staging-only.txt', status: 'renamed', added: 0, removed: 0 },
      { path: 'untracked.txt', status: 'added', added: 3, removed: 0 },
    ]);
  });

  it('never lets the PR base override a nearer base (PRs that open against main, merge into staging)', async () => {
    setUpStagingBranch();
    const res = await listTaskChanges(repo, [{ branch: 'feat', baseBranch: 'main' }]);
    expect(res.kind === 'ok' && res.baseRef).toBe('origin/staging');
    expect(res.kind === 'ok' && res.files.map((f) => f.path)).toEqual(['feature.txt']);
  });

  it('adds the task\'s own PR base to the candidates and lets it win a tie; other PRs are ignored', async () => {
    setUpStagingBranch();
    // origin/release points where origin/staging does: a tie, so the PR base wins.
    git('update-ref', 'refs/remotes/origin/release', 'refs/remotes/origin/staging');
    const own = await listTaskChanges(repo, [
      { branch: 'someone-else', baseBranch: 'main' },
      { branch: 'feat', baseBranch: 'release' },
    ]);
    expect(own.kind === 'ok' && own.baseRef).toBe('origin/release');
    expect(own.kind === 'ok' && own.files.map((f) => f.path)).toEqual(['feature.txt']);

    const otherPrOnly = await listTaskChanges(repo, [{ branch: 'someone-else', baseBranch: 'release' }]);
    expect(otherPrOnly.kind === 'ok' && otherPrOnly.baseRef).toBe('origin/staging');
  });

  it('ignores an unsafe PR base branch name', async () => {
    setUpStagingBranch();
    const res = await listTaskChanges(repo, [{ branch: 'feat', baseBranch: '--output=/tmp/x' }]);
    expect(res.kind === 'ok' && res.baseRef).toBe('origin/staging');
  });

  it('reports why there is no list', async () => {
    expect(await listTaskChanges(undefined, [])).toEqual({ kind: 'unavailable', reason: 'no_cwd' });
    expect(await listTaskChanges(path.join(root, 'missing'), [])).toEqual({ kind: 'unavailable', reason: 'worktree_gone' });
    const plain = path.join(root, 'plain');
    mkdirSync(plain);
    expect(await listTaskChanges(plain, [])).toEqual({ kind: 'unavailable', reason: 'not_git' });
    commitFile('base.txt', 'one\n', 'base');
    expect(await listTaskChanges(repo, [])).toEqual({ kind: 'unavailable', reason: 'no_base' });
  });

  it('counts an untracked symlink as one line and never follows it', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(root, 'big.txt'), 'x\n'.repeat(500));
    symlinkSync(path.join(root, 'big.txt'), path.join(repo, 'biglink'));
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    symlinkSync(path.join(root, 'pipe'), path.join(repo, 'pipelink'));
    // Following the FIFO link would block here forever.
    const res = await listTaskChanges(repo, []);
    expect(res.kind === 'ok' && res.files.filter((f) => f.path.endsWith('link'))).toEqual([
      { path: 'biglink', status: 'added', added: 1, removed: 0 },
      { path: 'pipelink', status: 'added', added: 1, removed: 0 },
    ]);
  });

  it('cuts the list at the file cap and says so', async () => {
    setUpStagingBranch();
    mkdirSync(path.join(repo, 'gen'));
    for (let i = 0; i < MAX_CHANGED_FILES + 1; i++) writeFileSync(path.join(repo, 'gen', `f${String(i).padStart(3, '0')}.txt`), 'x\n');
    const res = await listTaskChanges(repo, []);
    expect(res.kind === 'ok' && res.files.length).toBe(MAX_CHANGED_FILES);
    expect(res.kind === 'ok' && res.truncated).toBe(true);
    expect(res.kind === 'ok' && res.files.some((f) => f.path === 'feature.txt')).toBe(true);
  });

  it('marks the list truncated when the untracked listing fails or overflows', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(repo, 'one.txt'), '1\n');
    writeFileSync(path.join(repo, 'two.txt'), '2\n');
    const failing: typeof defaultGitRunner = async (args, cwd, opts) =>
      args[0] === 'ls-files' ? { ok: false, exitCode: null, stdout: '', tooLarge: false } : defaultGitRunner(args, cwd, opts);
    const failed = await listTaskChanges(repo, [], failing);
    expect(failed.kind === 'ok' && [failed.files.map((f) => f.path), failed.truncated]).toEqual([['feature.txt'], true]);

    // On overflow the paths that arrived are kept, minus the last one, which may be cut.
    const overflowing: typeof defaultGitRunner = async (args, cwd, opts) =>
      args[0] === 'ls-files' ? { ok: false, exitCode: null, stdout: 'one.txt\0two.t', tooLarge: true } : defaultGitRunner(args, cwd, opts);
    const overflowed = await listTaskChanges(repo, [], overflowing);
    expect(overflowed.kind === 'ok' && [overflowed.files.map((f) => f.path), overflowed.truncated]).toEqual([['feature.txt', 'one.txt'], true]);
  });

  it('lists a file once when it is untracked after git rm --cached', async () => {
    setUpStagingBranch();
    git('rm', '-q', '--cached', 'base.txt');
    const res = await listTaskChanges(repo, []);
    expect(res.kind === 'ok' && res.files.filter((f) => f.path === 'base.txt')).toEqual([
      { path: 'base.txt', status: 'deleted', added: 0, removed: 3 },
    ]);
  });

  it('works from a subdirectory of the worktree, with repository-relative paths', async () => {
    setUpStagingBranch();
    commitFile('pkg/inner.txt', 'in\n', 'inner');
    const res = await listTaskChanges(path.join(repo, 'pkg'), []);
    expect(res.kind === 'ok' && res.files.map((f) => f.path)).toEqual(['feature.txt', 'pkg/inner.txt']);
  });
});

describe('readTaskChangeFile', () => {
  it('returns the hunks of a changed tracked file', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(repo, 'feature.txt'), 'a\nB\n');
    const res = await readTaskChangeFile(repo, [], 'feature.txt');
    expect(res).toEqual({
      kind: 'patch',
      path: 'feature.txt',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+B'] }],
    });
  });

  it('diffs a renamed file against its old path, so a pure rename has no hunks', async () => {
    setUpStagingBranch();
    renameSync(path.join(repo, 'staging-only.txt'), path.join(repo, 'moved.txt'));
    git('add', '-A');
    expect(await readTaskChangeFile(repo, [], 'moved.txt')).toEqual({ kind: 'patch', path: 'moved.txt', hunks: [] });
  });

  it('returns the patch of a new untracked file', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(repo, 'fresh.txt'), 'hello\n');
    const res = await readTaskChangeFile(repo, [], 'fresh.txt');
    expect(res).toEqual({
      kind: 'patch',
      path: 'fresh.txt',
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }],
    });
  });

  it('marks a binary file', async () => {
    setUpStagingBranch();
    writeFileSync(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 0, 255]));
    git('add', 'image.bin');
    const list = await listTaskChanges(repo, []);
    expect(list.kind === 'ok' && list.files.find((f) => f.path === 'image.bin')).toEqual({
      path: 'image.bin', status: 'added', added: null, removed: null,
    });
    expect(await readTaskChangeFile(repo, [], 'image.bin')).toEqual({ kind: 'binary', path: 'image.bin' });
  });

  it('refuses a path that is not in the change list', async () => {
    setUpStagingBranch();
    expect(await readTaskChangeFile(repo, [], 'base.txt')).toBeNull();
    expect(await readTaskChangeFile(repo, [], '../../etc/passwd')).toBeNull();
  });

  it('passes the unavailable reason through', async () => {
    expect(await readTaskChangeFile(undefined, [], 'x')).toEqual({ kind: 'unavailable', reason: 'no_cwd' });
  });

  it('answers too_large when the patch exceeds the output cap', async () => {
    setUpStagingBranch();
    const res = await readTaskChangeFile(repo, [], 'feature.txt', async (args, cwd) => {
      if (args[0] === 'diff' && !args.includes('-z')) {
        return { ok: false, exitCode: null, stdout: '', tooLarge: true };
      }
      const { defaultGitRunner } = await import('./task-changes.js');
      return defaultGitRunner(args, cwd);
    });
    expect(res).toEqual({ kind: 'too_large', path: 'feature.txt' });
  });
});

describe('parsers', () => {
  it('parseUnifiedDiff reads hunk headers without line counts and the no-newline marker', () => {
    const out = [
      'diff --git a/f b/f',
      'index 1..2 100644',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1 @@ ctx',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(parseUnifiedDiff(out)).toEqual([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new', '\\ No newline at end of file'] },
    ]);
  });

  it('parseUnifiedDiff keeps removed lines that look like headers inside a hunk', () => {
    const out = '--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n--- not a header\n keep\n';
    expect(parseUnifiedDiff(out)[0].lines).toEqual(['--- not a header', ' keep']);
  });

  it('parseNumstat handles renames and binary files', () => {
    const out = '3\t1\ta.txt\0' + '-\t-\tbin.png\0' + '0\t0\t\0old.txt\0new.txt\0';
    expect([...parseNumstat(out)]).toEqual([
      ['a.txt', { added: 3, removed: 1 }],
      ['bin.png', { added: null, removed: null }],
      ['new.txt', { added: 0, removed: 0 }],
    ]);
  });

  it('parseNameStatus maps git status letters', () => {
    const out = 'M\0a\0A\0b\0D\0c\0R087\0old\0new\0T\0d\0';
    expect(parseNameStatus(out)).toEqual([
      { path: 'a', status: 'modified' },
      { path: 'b', status: 'added' },
      { path: 'c', status: 'deleted' },
      { path: 'new', oldPath: 'old', status: 'renamed' },
      { path: 'd', status: 'modified' },
    ]);
  });
});
