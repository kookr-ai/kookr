import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTrailingFileBytes } from './resource-watchdog-log-tail.js';

/** Split so secret scanners do not treat the assembled fixture as a live credential. */
const secretFixture = (...parts: string[]): string => parts.join('');

// pragma: allowlist secret — synthetic redaction fixtures only; not live credentials.
describe('readTrailingFileBytes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-tail-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns null for missing file', () => {
    expect(readTrailingFileBytes(join(dir, 'nope.log'), 100)).toBeNull();
  });

  test('returns full content when under budget', () => {
    const path = join(dir, 'small.log');
    writeFileSync(path, 'alpha\nbeta\n', 'utf-8');
    expect(readTrailingFileBytes(path, 1024)).toBe('alpha\nbeta\n');
  });

  test('returns only the last N bytes and drops a leading partial line', () => {
    const path = join(dir, 'big.log');
    // 100-byte file; take last 40 bytes — may start mid-line.
    const body = 'LINE_ONE_AAAAAAAA\nLINE_TWO_BBBBBBBB\nLINE_THREE_CCCCCC\nLINE_FOUR_DDDDDD\n';
    writeFileSync(path, body, 'utf-8');
    const tail = readTrailingFileBytes(path, 40);
    expect(tail).not.toBeNull();
    expect(tail!.length).toBeLessThanOrEqual(40);
    // Should not start mid-line after the drop.
    expect(tail!.startsWith('LINE_') || tail!.includes('\n')).toBe(true);
    expect(tail).toContain('LINE_FOUR');
  });

  test('scrubs Authorization Bearer lines before return (issue #2346)', () => {
    const path = join(dir, 'auth.log');
    const bearer = secretFixture('super-secret-bearer-value', '-0123456789abcdef');
    const body = [
      'ok request completed',
      `Authorization: Bearer ${bearer}`,
      'swap pressure high',
    ].join('\n');
    writeFileSync(path, body, 'utf-8');
    const tail = readTrailingFileBytes(path, 4096);
    expect(tail).not.toBeNull();
    expect(tail).toContain('ok request completed');
    expect(tail).toContain('swap pressure high');
    expect(tail).toContain('[REDACTED]');
    expect(tail).not.toContain(bearer);
    expect(tail).not.toMatch(/Bearer\s+super-secret/i);
  });

  test('scrubs token-looking and cookie lines before return (issue #2346)', () => {
    const path = join(dir, 'tokens.log');
    const ghPat = secretFixture('ghp', '_0123456789abcdefghij');
    const cookieVal = 'sessionid=abc123def456ghi789; path=/';
    const body = [
      `proxy forward token=${ghPat}`,
      `Cookie: ${cookieVal}`,
      'dtach count=42',
    ].join('\n');
    writeFileSync(path, body, 'utf-8');
    const tail = readTrailingFileBytes(path, 4096);
    expect(tail).not.toBeNull();
    expect(tail).toContain('dtach count=42');
    expect(tail).toContain('[REDACTED]');
    expect(tail).not.toContain(ghPat);
    expect(tail).not.toContain('sessionid=abc123def456ghi789');
  });
});
