import { describe, expect, test } from 'vitest';
import { parseOwnerRepoSlug } from './repo-slug.js';

describe('parseOwnerRepoSlug', () => {
  test('accepts owner/repo', () => {
    expect(parseOwnerRepoSlug('grafana/grafana')).toBe('grafana/grafana');
  });

  test('lowercases the slug', () => {
    expect(parseOwnerRepoSlug('Grafana/Grafana')).toBe('grafana/grafana');
  });

  test('allows dots and dashes', () => {
    expect(parseOwnerRepoSlug('ggml-org/llama.cpp')).toBe('ggml-org/llama.cpp');
  });

  test('rejects non-string inputs (route handlers must not crash)', () => {
    expect(parseOwnerRepoSlug(undefined)).toBeNull();
    expect(parseOwnerRepoSlug(null)).toBeNull();
    expect(parseOwnerRepoSlug(42)).toBeNull();
    expect(parseOwnerRepoSlug({})).toBeNull();
    expect(parseOwnerRepoSlug([])).toBeNull();
    expect(parseOwnerRepoSlug(true)).toBeNull();
  });

  test('rejects empty strings', () => {
    expect(parseOwnerRepoSlug('')).toBeNull();
    expect(parseOwnerRepoSlug('   ')).toBeNull();
  });

  test('trims surrounding whitespace around a valid slug', () => {
    expect(parseOwnerRepoSlug('  grafana/grafana  ')).toBe('grafana/grafana');
  });

  test('rejects URLs and path prefixes', () => {
    expect(parseOwnerRepoSlug('https://github.com/owner/repo')).toBeNull();
    expect(parseOwnerRepoSlug('/owner/repo')).toBeNull();
    expect(parseOwnerRepoSlug('owner/repo/')).toBeNull();
  });

  test('rejects triple segment (e.g. github.com/owner/repo unstripped)', () => {
    expect(parseOwnerRepoSlug('github.com/owner/repo')).toBeNull();
  });

  test('rejects non-ASCII and special characters', () => {
    expect(parseOwnerRepoSlug('owner!/repo')).toBeNull();
    expect(parseOwnerRepoSlug('owner/repo@ref')).toBeNull();
    expect(parseOwnerRepoSlug('owñer/repo')).toBeNull();
  });

  test('rejects wrong segment count', () => {
    expect(parseOwnerRepoSlug('foo')).toBeNull();
    expect(parseOwnerRepoSlug('a/b/c')).toBeNull();
  });

  test('rejects missing segments', () => {
    expect(parseOwnerRepoSlug('owner/')).toBeNull();
    expect(parseOwnerRepoSlug('/repo')).toBeNull();
  });

  test('rejects whitespace inside segments', () => {
    expect(parseOwnerRepoSlug('own er/repo')).toBeNull();
  });
});
