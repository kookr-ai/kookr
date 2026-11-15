import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_TEST_TIMEOUT_MS, SERIAL_TEST_FILES, vitestTestTimeoutMs } from './vitest-serial-files.mjs';

describe('SERIAL_TEST_FILES (#3794)', () => {
  it('names only test files that exist, so a rename cannot put one back into the parallel run', () => {
    expect(SERIAL_TEST_FILES.filter((f) => !existsSync(f))).toEqual([]);
    expect(SERIAL_TEST_FILES.every((f) => /\.test\.tsx?$/.test(f))).toBe(true);
  });

  it('lists each file once', () => {
    expect(new Set(SERIAL_TEST_FILES).size).toBe(SERIAL_TEST_FILES.length);
  });
});

describe('vitestTestTimeoutMs', () => {
  it('keeps 15 s when the variable is unset, empty or not a positive integer', () => {
    for (const raw of [undefined, '', ' ', '0', '-5', '2.5', '1e5', '60s', 'abc', '99999999999999999999']) {
      expect(vitestTestTimeoutMs(raw)).toBe(DEFAULT_TEST_TIMEOUT_MS);
    }
    expect(DEFAULT_TEST_TIMEOUT_MS).toBe(15_000);
  });

  it('accepts a positive integer, with surrounding whitespace', () => {
    expect(vitestTestTimeoutMs('60000')).toBe(60_000);
    expect(vitestTestTimeoutMs(' 30000\n')).toBe(30_000);
  });
});
