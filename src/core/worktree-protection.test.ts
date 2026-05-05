import { describe, test, expect } from 'vitest';
import {
  endsWithProtectedSuffix,
  deriveParentRepoFromProtected,
  isProtectedWorktreePath,
} from './worktree-protection.js';

describe('endsWithProtectedSuffix', () => {
  test('matches the canonical kookr-prod path', () => {
    expect(endsWithProtectedSuffix('/home/jean/git/kookr-prod')).toBe(true);
  });

  test('matches when the path is just the suffix', () => {
    expect(endsWithProtectedSuffix('kookr-prod')).toBe(true);
  });

  test('does not match unrelated repos that happen to share a prefix', () => {
    expect(endsWithProtectedSuffix('/home/jean/git/kookr')).toBe(false);
    expect(endsWithProtectedSuffix('/home/jean/git/kookr-rfc')).toBe(false);
    expect(endsWithProtectedSuffix('/home/jean/git/kookr-prod-old')).toBe(false);
  });

  test('does not match when the suffix is followed by additional path segments', () => {
    expect(endsWithProtectedSuffix('/home/jean/git/kookr-prod/sub')).toBe(false);
  });
});

describe('deriveParentRepoFromProtected', () => {
  test('strips the trailing -prod', () => {
    expect(deriveParentRepoFromProtected('/home/jean/git/kookr-prod')).toBe(
      '/home/jean/git/kookr',
    );
  });

  test('only strips the trailing -prod, not interior occurrences', () => {
    // Pathological but defensible: any -prod that is not at the end is left alone.
    expect(deriveParentRepoFromProtected('/foo-prod/bar-prod')).toBe(
      '/foo-prod/bar',
    );
  });

  test('is a no-op when -prod is not the suffix', () => {
    expect(deriveParentRepoFromProtected('/home/jean/git/kookr')).toBe(
      '/home/jean/git/kookr',
    );
  });
});

describe('isProtectedWorktreePath', () => {
  test('matches an absolute kookr-prod path', () => {
    expect(isProtectedWorktreePath('/home/jean/git/kookr-prod')).toBe(true);
  });

  test('matches a relative path after canonicalization', () => {
    // resolve('./foo/kookr-prod') becomes <cwd>/foo/kookr-prod, which still ends with the suffix.
    expect(isProtectedWorktreePath('./kookr-prod')).toBe(true);
  });

  test('does not match unrelated repos', () => {
    expect(isProtectedWorktreePath('/home/jean/git/kookr')).toBe(false);
    expect(isProtectedWorktreePath('/home/jean/git/some-other-repo')).toBe(false);
  });
});
