import { describe, it, expect } from 'vitest';
import { hashPrompt } from './hash-prompt.js';

describe('hashPrompt', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    const hash = hashPrompt('hello world');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same hash for the same input', () => {
    expect(hashPrompt('fix the bug')).toBe(hashPrompt('fix the bug'));
  });

  it('returns different hashes for different inputs', () => {
    expect(hashPrompt('fix the bug')).not.toBe(hashPrompt('add the feature'));
  });

  it('does not trim whitespace (preserves exact prompt)', () => {
    expect(hashPrompt('  fix  ')).not.toBe(hashPrompt('fix'));
  });
});
