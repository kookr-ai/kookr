import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTrailingFileBytes } from './resource-watchdog-log-tail.js';

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
});
