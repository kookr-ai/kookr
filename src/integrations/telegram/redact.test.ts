/**
 * Unit tests for the redactCredentials helper used by R16 block-alerts.
 *
 * The helper is conservative: any credential-shape match → replace the entire
 * body with a sentinel. False positives are acceptable; false negatives are
 * the load-bearing concern (round-3 V13).
 */
import { describe, it, expect } from 'vitest';
import { redactCredentials } from './index.js';

describe('redactCredentials', () => {
  it('passes through plain bash commands unchanged', () => {
    expect(redactCredentials('Bash(git push origin feat-x)')).toBe('Bash(git push origin feat-x)');
    expect(redactCredentials('Edit(/tmp/foo.ts)')).toBe('Edit(/tmp/foo.ts)');
  });

  it('redacts PEM private keys', () => {
    const out = redactCredentials('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(out).toMatch(/redacted/);
  });

  it('redacts the password / token / secret / api_key word markers', () => {
    expect(redactCredentials('export MY_PASSWORD=hunter2')).toMatch(/redacted/);
    expect(redactCredentials('export GH_TOKEN=ghp_xyz')).toMatch(/redacted/);
    expect(redactCredentials('aws_secret_access_key=xyz')).toMatch(/redacted/);
    expect(redactCredentials('export api_key=xyz')).toMatch(/redacted/);
    expect(redactCredentials('export api-key=xyz')).toMatch(/redacted/);
    expect(redactCredentials('apikey=xyz')).toMatch(/redacted/);
  });

  it('redacts AWS access keys (AKIA prefix)', () => {
    expect(redactCredentials('Bash(echo AKIAIOSFODNN7EXAMPLE)')).toMatch(/redacted/);
  });

  it('redacts GitHub-style token prefixes', () => {
    expect(redactCredentials('Bash(curl ghp_abcdefghijklmnopqrstuvwxyz0123456789)')).toMatch(/redacted/);
    expect(redactCredentials('export GH=gho_abcdefghijklmnopqrstuvwxyz0123456789')).toMatch(/redacted/);
    expect(redactCredentials('ghs_abcdefghijklmnopqrstuvwxyz0123456789')).toMatch(/redacted/);
  });

  it('redacts Bearer-style auth headers', () => {
    expect(redactCredentials('curl -H "Authorization: Bearer eyJhbGciOi..."')).toMatch(/redacted/);
  });

  it('is case-insensitive', () => {
    expect(redactCredentials('PASSWORD=foo')).toMatch(/redacted/);
    expect(redactCredentials('Token=foo')).toMatch(/redacted/);
  });

  it('replaces the entire body, not just the matching substring', () => {
    const out = redactCredentials('innocent prefix password=foo innocent suffix');
    expect(out).toBe('<prompt redacted; view in dashboard>');
    expect(out).not.toMatch(/innocent/);
  });
});
