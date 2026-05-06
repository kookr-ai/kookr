import { describe, test, expect } from 'vitest';
import {
  endsWithProtectedSuffix,
  deriveParentRepoFromProtected,
  isProtectedWorktreePath,
} from './worktree-protection.js';

describe('endsWithProtectedSuffix', () => {
  test('matches the canonical kookr-prod path', () => {
    expect(endsWithProtectedSuffix('/workspace/kookr-prod')).toBe(true);
  });

  test('matches when the path is just the suffix', () => {
    expect(endsWithProtectedSuffix('kookr-prod')).toBe(true);
  });

  test('does not match unrelated repos that happen to share a prefix', () => {
    expect(endsWithProtectedSuffix('/workspace/kookr')).toBe(false);
    expect(endsWithProtectedSuffix('/workspace/kookr-rfc')).toBe(false);
    expect(endsWithProtectedSuffix('/workspace/kookr-prod-old')).toBe(false);
  });

  test('does not match when the suffix is followed by additional path segments', () => {
    expect(endsWithProtectedSuffix('/workspace/kookr-prod/sub')).toBe(false);
  });
});

describe('deriveParentRepoFromProtected', () => {
  test('strips the trailing -prod', () => {
    expect(deriveParentRepoFromProtected('/workspace/kookr-prod')).toBe(
      '/workspace/kookr',
    );
  });

  test('only strips the trailing -prod, not interior occurrences', () => {
    // Pathological but defensible: any -prod that is not at the end is left alone.
    expect(deriveParentRepoFromProtected('/foo-prod/bar-prod')).toBe(
      '/foo-prod/bar',
    );
  });

  test('is a no-op when -prod is not the suffix', () => {
    expect(deriveParentRepoFromProtected('/workspace/kookr')).toBe(
      '/workspace/kookr',
    );
  });
});

describe('isProtectedWorktreePath', () => {
  test('matches an absolute kookr-prod path', () => {
    expect(isProtectedWorktreePath('/workspace/kookr-prod')).toBe(true);
  });

  test('matches a relative path after canonicalization', () => {
    // resolve('./foo/kookr-prod') becomes <cwd>/foo/kookr-prod, which still ends with the suffix.
    expect(isProtectedWorktreePath('./kookr-prod')).toBe(true);
  });

  test('does not match unrelated repos', () => {
    expect(isProtectedWorktreePath('/workspace/kookr')).toBe(false);
    expect(isProtectedWorktreePath('/workspace/some-other-repo')).toBe(false);
  });
});
