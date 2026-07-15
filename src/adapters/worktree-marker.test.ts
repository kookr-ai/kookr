import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import {
  isProtectedWorktreePath,
  readProtectedMarker,
  resolveParentRepoFromMarker,
  migrateLegacyProtectedWorktree,
} from './worktree-marker.js';
import { PROTECTED_MARKER } from '../core/worktree-protection.js';
import {
  isPrimaryWorkingTree,
  isRegisteredLinkedWorktree,
  isProtectedBranch,
  looksLikeLinkedWorktree,
} from './worktree-safety.js';
import { execFileSync } from 'node:child_process';

describe('protected worktree documentation', () => {
  const userGuide = readFileSync(new URL('../../docs/user-guide.md', import.meta.url), 'utf8');

  test('keeps the documented marker filename aligned with the exported constant', () => {
    expect(userGuide).toContain(`\`${PROTECTED_MARKER}\``);
    expect(userGuide).toContain('parentRepo: /path/to/project');
    expect(userGuide).toContain('skip removal with reason `protected`');
  });

  test.each([
    ['data directory reference', '../../docs/reference/data-directory.md'],
    ['troubleshooting guide', '../../docs/troubleshooting.md'],
  ])('%s links to the canonical user-guide section', (_name, path) => {
    const page = readFileSync(new URL(path, import.meta.url), 'utf8');
    expect(page).toContain('user-guide.md#protecting-a-worktree-from-automatic-cleanup');
  });
});

describe('worktree-marker', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wt-marker-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('isProtectedWorktreePath', () => {
    test('returns false when the marker is absent', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      expect(isProtectedWorktreePath(wt)).toBe(false);
    });

    test('returns true when the marker file exists', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), 'production runtime\n');
      expect(isProtectedWorktreePath(wt)).toBe(true);
    });

    test('returns true regardless of basename when marker is present', async () => {
      const wt = join(root, 'kookr-runtime');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), 'production runtime\n');
      expect(isProtectedWorktreePath(wt)).toBe(true);
    });

    test('tolerates a trailing path separator', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), 'production runtime\n');
      expect(isProtectedWorktreePath(`${wt}/`)).toBe(true);
    });

    test('returns false for a kookr-prod basename without the marker (post-migration window)', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      // Acceptance criterion: basename alone no longer confers protection.
      expect(isProtectedWorktreePath(wt)).toBe(false);
    });
  });

  describe('readProtectedMarker', () => {
    test('returns null when the marker is missing', () => {
      expect(readProtectedMarker(join(root, 'kookr-prod'))).toBeNull();
    });

    test('returns null when the marker is empty', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), '');
      expect(readProtectedMarker(wt)).toBeNull();
    });

    test('parses reason and parentRepo', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(
        join(wt, '.kookr-protected'),
        'production runtime\nparentRepo: /home/me/git/kookr\n',
      );
      expect(readProtectedMarker(wt)).toEqual({
        reason: 'production runtime',
        parentRepo: '/home/me/git/kookr',
      });
    });

    test('parses reason without parentRepo', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), 'production runtime\n');
      expect(readProtectedMarker(wt)).toEqual({
        reason: 'production runtime',
        parentRepo: null,
      });
    });
  });

  describe('resolveParentRepoFromMarker', () => {
    test('uses parentRepo from the marker when present', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(
        join(wt, '.kookr-protected'),
        'production runtime\nparentRepo: /custom/parent\n',
      );
      expect(resolveParentRepoFromMarker(wt)).toBe('/custom/parent');
    });

    test('falls back to legacy basename strip when marker lacks parentRepo', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);
      await writeFile(join(wt, '.kookr-protected'), 'production runtime\n');
      expect(resolveParentRepoFromMarker(wt)).toBe(join(root, 'kookr'));
    });

    test('falls back to legacy basename strip when no marker exists', () => {
      // No directory needs to exist for the pure-string fallback.
      expect(resolveParentRepoFromMarker('/workspace/kookr-prod')).toBe(
        '/workspace/kookr',
      );
    });
  });

  describe('migrateLegacyProtectedWorktree', () => {
    test('writes the marker on a legacy kookr-prod worktree that lacks one', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);

      expect(migrateLegacyProtectedWorktree(wt)).toBe(true);
      const marker = join(wt, '.kookr-protected');
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, 'utf8')).toBe(
        `production runtime\nparentRepo: ${join(root, 'kookr')}\n`,
      );
    });

    test('is idempotent — second call is a no-op', async () => {
      const wt = join(root, 'kookr-prod');
      await mkdir(wt);

      expect(migrateLegacyProtectedWorktree(wt)).toBe(true);
      expect(migrateLegacyProtectedWorktree(wt)).toBe(false);
    });

    test('skips worktrees whose basename does not match the legacy convention', async () => {
      const wt = join(root, 'kookr-runtime');
      await mkdir(wt);

      expect(migrateLegacyProtectedWorktree(wt)).toBe(false);
      expect(existsSync(join(wt, '.kookr-protected'))).toBe(false);
    });

    test('skips when the worktree path does not exist', () => {
      expect(migrateLegacyProtectedWorktree(join(root, 'kookr-prod'))).toBe(false);
    });
  });
});

describe('worktree safety predicates', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wt-safety-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('distinguishes the primary checkout from a registered linked worktree', async () => {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Kookr Test'], { stdio: 'ignore' });
    await writeFile(join(repo, 'tracked.txt'), 'tracked\n');
    execFileSync('git', ['-C', repo, 'add', 'tracked.txt'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'initial'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'feature', linked], { stdio: 'ignore' });

    expect(await isPrimaryWorkingTree(repo)).toBe(true);
    expect(await isPrimaryWorkingTree(linked)).toBe(false);
    expect(looksLikeLinkedWorktree(repo)).toBe(false);
    expect(looksLikeLinkedWorktree(linked)).toBe(true);
    expect(await isRegisteredLinkedWorktree(linked, repo)).toBe(true);
    expect(await isRegisteredLinkedWorktree(repo, repo)).toBe(false);
  });

  test('rejects an ordinary directory as a linked worktree', async () => {
    const ordinary = join(root, 'ordinary');
    await mkdir(ordinary);
    expect(looksLikeLinkedWorktree(ordinary)).toBe(false);
    expect(await isPrimaryWorkingTree(ordinary)).toBe(false);
  });

  test.each(['main', 'MASTER', 'develop', 'Dev'])('protects %s by default', (branch) => {
    expect(isProtectedBranch(branch)).toBe(true);
  });

  test('allows callers to supply a narrower protected-branch allowlist', () => {
    expect(isProtectedBranch('release', ['release'])).toBe(true);
    expect(isProtectedBranch('main', ['release'])).toBe(false);
    expect(isProtectedBranch(undefined)).toBe(false);
  });
});
