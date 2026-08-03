import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitExecEnv } from './git-helpers.js';
import { resolveWorktreeMergeStatus } from './worktree-merge-status.js';

/**
 * Real-git characterization tests for resolveWorktreeMergeStatus.
 *
 * Pins fail-closed merge-check failures and squash/aggregate patch-equivalence
 * against throwaway repos so destructive worktree cleanup cannot silently
 * misclassify unmerged work.
 */

function cleanGitEnv(): NodeJS.ProcessEnv {
  return gitExecEnv();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(cwd: string, name: string, contents: string, message: string): string {
  writeFileSync(join(cwd, name), contents);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

interface RepoFixture {
  root: string;
  repo: string;
}

function createRepo(): RepoFixture {
  const root = mkdtempSync(join(tmpdir(), 'kookr-merge-status-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'kookr-test@example.com');
  git(repo, 'config', 'user.name', 'Kookr Test');
  const baseHead = commitFile(repo, 'README.md', 'base\n', 'initial');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', baseHead);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  return { root, repo };
}

describe('resolveWorktreeMergeStatus real git integration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('classifies a fast-forward-merged branch as merged', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');
    // Fast-forward main (and origin/main) onto the feature tip.
    git(fixture.repo, 'switch', 'main');
    git(fixture.repo, 'merge', '--ff-only', 'feature');
    const ffHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', ffHead);

    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'origin/main',
      includeAheadCount: true,
    });

    expect(status).toMatchObject({
      baselineRef: 'origin/main',
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
      aheadCount: 0,
    });
    expect(status?.mergeCheckFailed).toBeUndefined();
  }, 10_000);

  it('classifies a multi-commit squash-merged branch as patch_equivalent', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');
    commitFile(fixture.repo, 'second-feature.txt', 'second feature\n', 'second feature change');

    // Squash the multi-commit feature into a single baseline commit with a
    // different SHA so ancestry alone cannot prove merge.
    git(fixture.repo, 'switch', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash multi-commit feature');
    // Unrelated baseline commit after the squash so cherry-pick alone is not
    // a trivial empty-range case.
    commitFile(fixture.repo, 'unrelated.txt', 'unrelated baseline change\n', 'unrelated baseline change');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'origin/main',
      includeAheadCount: true,
    });

    expect(status).toMatchObject({
      baselineRef: 'origin/main',
      classification: 'patch_equivalent',
      reasonCode: 'aggregate_patch_equivalent',
      aheadCount: 2,
    });
    expect(status?.mergeCheckFailed).toBeUndefined();
  }, 10_000);

  it('classifies a single-commit squash-merged branch as patch_equivalent', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');

    git(fixture.repo, 'switch', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash feature');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'origin/main',
      includeAheadCount: true,
    });

    expect(status).toMatchObject({
      baselineRef: 'origin/main',
      classification: 'patch_equivalent',
      // Identical single-commit patches usually yield empty cherry-pick output;
      // aggregate tree check still confirms equivalence.
      reasonCode: expect.stringMatching(/^(no_unique_patches|aggregate_patch_equivalent)$/),
      aheadCount: 1,
    });
    expect(status?.mergeCheckFailed).toBeUndefined();
  }, 10_000);

  it('classifies a branch with genuine unique commits as unique_commits', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');

    // Leave origin/main at the pre-feature baseline so feature is not merged.
    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'origin/main',
      includeAheadCount: true,
    });

    expect(status).toMatchObject({
      baselineRef: 'origin/main',
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
      aheadCount: 1,
    });
    expect(status?.mergeCheckFailed).toBeUndefined();
  }, 10_000);

  it('fails closed with unique_commits+mergeCheckFailed when merge-base check is unprovable', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');

    // Bogus baseline: merge-base --is-ancestor exits non-1 (fatal), not the
    // expected "not an ancestor" exit code 1. Must never classify as merged.
    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'refs/heads/definitely-does-not-exist',
      includeAheadCount: true,
    });

    expect(status).toMatchObject({
      baselineRef: 'refs/heads/definitely-does-not-exist',
      classification: 'unique_commits',
      reasonCode: 'merge_check_failed',
      mergeCheckFailed: true,
    });
    // Must never fail-open as merged when ancestry is unprovable.
    expect(status?.classification).not.toBe('merged');
    expect(status?.classification).not.toBe('patch_equivalent');
  }, 10_000);

  it('omits aheadCount when includeAheadCount is false', async () => {
    const fixture = createRepo();
    roots.push(fixture.root);

    git(fixture.repo, 'branch', 'feature', 'main');
    git(fixture.repo, 'switch', 'feature');
    commitFile(fixture.repo, 'feature.txt', 'feature\n', 'feature change');
    git(fixture.repo, 'switch', 'main');
    git(fixture.repo, 'merge', '--ff-only', 'feature');
    const ffHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', ffHead);

    const status = await resolveWorktreeMergeStatus(fixture.repo, 'feature', {
      baselineRef: 'origin/main',
    });

    expect(status).toMatchObject({
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
    });
    expect(status).not.toHaveProperty('aheadCount');
    expect(status).not.toHaveProperty('aheadCountCheckFailed');
  }, 10_000);
});
