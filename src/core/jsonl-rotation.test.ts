import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { appendJsonlWithRotation } from './jsonl-rotation.js';

describe('appendJsonlWithRotation', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-jsonl-rotation-'));
    logPath = join(tempDir, 'nested', 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates the parent directory and writes the first line', async () => {
    await appendJsonlWithRotation(logPath, 'a\n', { maxBytes: 1024, rotatedGenerations: 2 });

    expect(readFileSync(logPath, 'utf-8')).toBe('a\n');
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test('does not rotate while the file stays under maxBytes', async () => {
    for (let i = 0; i < 5; i++) {
      await appendJsonlWithRotation(logPath, 'x\n', { maxBytes: 1024, rotatedGenerations: 2 });
    }

    expect(readFileSync(logPath, 'utf-8')).toBe('x\nx\nx\nx\nx\n');
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test('rotates to .1 when an append would exceed maxBytes', async () => {
    // maxBytes = 10; each line is 5 bytes ("aaaa\n").
    await appendJsonlWithRotation(logPath, 'aaaa\n', { maxBytes: 10, rotatedGenerations: 2 });
    await appendJsonlWithRotation(logPath, 'bbbb\n', { maxBytes: 10, rotatedGenerations: 2 });
    // File now at 10 bytes; a third append (5 bytes) would exceed 10 → rotate.
    await appendJsonlWithRotation(logPath, 'cccc\n', { maxBytes: 10, rotatedGenerations: 2 });

    expect(readFileSync(logPath, 'utf-8')).toBe('cccc\n');
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('aaaa\nbbbb\n');
  });

  test('shifts generations up and drops anything beyond rotatedGenerations', async () => {
    const opts = { maxBytes: 5, rotatedGenerations: 2 };
    // Each append is 5 bytes and the file is non-empty before every append after
    // the first, so every append after the first rotates.
    await appendJsonlWithRotation(logPath, 'aaaa\n', opts); // current: a
    await appendJsonlWithRotation(logPath, 'bbbb\n', opts); // a→.1, current: b
    await appendJsonlWithRotation(logPath, 'cccc\n', opts); // b→.1 (a→.2), current: c
    await appendJsonlWithRotation(logPath, 'dddd\n', opts); // c→.1 (b→.2, a dropped), current: d

    expect(readFileSync(logPath, 'utf-8')).toBe('dddd\n');
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('cccc\n');
    expect(readFileSync(`${logPath}.2`, 'utf-8')).toBe('bbbb\n');
    expect(existsSync(`${logPath}.3`)).toBe(false);
  });

  test('keeps the main file bounded near maxBytes across many appends', async () => {
    const maxBytes = 200;
    for (let i = 0; i < 500; i++) {
      await appendJsonlWithRotation(logPath, `${'z'.repeat(20)}\n`, { maxBytes, rotatedGenerations: 3 });
    }

    // The live file never exceeds maxBytes plus a single overshooting line.
    expect(statSync(logPath).size).toBeLessThanOrEqual(maxBytes + 21);
    // Only the configured generations survive.
    expect(existsSync(`${logPath}.3`)).toBe(true);
    expect(existsSync(`${logPath}.4`)).toBe(false);
  });

  test('a single oversized line still rotates a non-empty file first', async () => {
    await appendJsonlWithRotation(logPath, 'seed\n', { maxBytes: 4, rotatedGenerations: 1 });
    await appendJsonlWithRotation(logPath, 'this-line-is-way-too-big\n', { maxBytes: 4, rotatedGenerations: 1 });

    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('seed\n');
    expect(readFileSync(logPath, 'utf-8')).toBe('this-line-is-way-too-big\n');
  });

  test('coerces degenerate maxBytes/rotatedGenerations without crashing or leaking a .0', async () => {
    // Fractional/zero inputs are floored and clamped to >= 1 internally; the
    // file still rotates and never spawns a bogus `.0` generation.
    const opts = { maxBytes: 5.9, rotatedGenerations: 0 };
    await appendJsonlWithRotation(logPath, 'aaaa\n', opts);
    await appendJsonlWithRotation(logPath, 'bbbb\n', opts);
    await appendJsonlWithRotation(logPath, 'cccc\n', opts);

    expect(readFileSync(logPath, 'utf-8')).toBe('cccc\n');
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('bbbb\n');
    expect(existsSync(`${logPath}.2`)).toBe(false);
    expect(existsSync(`${logPath}.0`)).toBe(false);

    // A negative cap must not throw and must still rotate a non-empty file.
    await appendJsonlWithRotation(logPath, 'dddd\n', { maxBytes: -100, rotatedGenerations: -3 });
    expect(readFileSync(logPath, 'utf-8')).toBe('dddd\n');
    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('cccc\n');
    expect(existsSync(`${logPath}.0`)).toBe(false);
  });

  test('rotation reuses an existing generation slot without leaking bytes', async () => {
    // Pre-seed a stale .1 to prove rename overwrites rather than appends.
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, 'current\n');
    writeFileSync(`${logPath}.1`, 'stale-old-generation\n');

    await appendJsonlWithRotation(logPath, 'new\n', { maxBytes: 4, rotatedGenerations: 1 });

    expect(readFileSync(`${logPath}.1`, 'utf-8')).toBe('current\n');
    expect(readFileSync(logPath, 'utf-8')).toBe('new\n');
  });
});
