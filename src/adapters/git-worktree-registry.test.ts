import { describe, expect, test } from 'vitest';
import { WorktreeRegistry, parseGitWorktreeList } from './git-worktree-registry.js';

const porcelain = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo-feature',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/feat/work',
  '',
  'worktree /repo-detached',
  'HEAD 3333333333333333333333333333333333333333',
  'detached',
  '',
  'worktree /repo-missing',
  'HEAD 4444444444444444444444444444444444444444',
  'branch refs/heads/stale',
  'prunable gitdir file points to non-existent location',
  '',
].join('\n');

describe('git worktree registry', () => {
  test('parses live, detached, and prunable worktrees', () => {
    const entries = parseGitWorktreeList(porcelain);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ path: '/repo', branch: 'main', isMain: true, isDetached: false, isPrunable: false });
    expect(entries[1]).toMatchObject({ path: '/repo-feature', branch: 'feat/work', isMain: false });
    expect(entries[2]).toMatchObject({ path: '/repo-detached', branch: null, isDetached: true });
    expect(entries[3]).toMatchObject({ path: '/repo-missing', branch: 'stale', isPrunable: true });
  });

  test('indexes refreshed worktrees by path and branch', async () => {
    const calls: string[][] = [];
    const registry = new WorktreeRegistry(async (_repoPath, args) => {
      calls.push(args);
      if (args.join(' ') === 'worktree list --porcelain') return porcelain;
      return '';
    });

    await registry.refresh('/repo');

    expect(calls).toEqual([['worktree', 'list', '--porcelain']]);
    expect(registry.byPath('/repo-feature')?.head).toBe('2222222222222222222222222222222222222222');
    expect(registry.byBranch('feat/work')?.path).toBe('/repo-feature');
    expect(registry.byPath('/repo-missing')?.isPrunable).toBe(true);
    expect(registry.snapshot().lastError).toBeNull();
  });

  test('keeps last-known-good entries and records stale errors on refresh failure', async () => {
    let fail = false;
    const registry = new WorktreeRegistry(async (_repoPath, args) => {
      if (fail) throw new Error('git unavailable');
      if (args.join(' ') === 'worktree list --porcelain') return porcelain;
      return '';
    });

    await registry.refresh('/repo');
    fail = true;
    const snapshot = await registry.refresh('/repo');

    expect(snapshot.lastError).toContain('git unavailable');
    expect(registry.byPath('/repo-feature')?.branch).toBe('feat/work');
  });
});
