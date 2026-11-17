import { describe, expect, it } from 'vitest';

import {
  TEST_ORPHAN_MIN_AGE_MS,
  TEST_RUN_ID_ENV,
  classifyTestProcessOwnership,
  currentTestRunId,
  isPidAlive,
  mintTestRunId,
  ownerPidOfTestRunId,
  testRunIdFromEnviron,
  testRunIdFromPath,
} from './test-run-identity.js';

describe('run id parsing', () => {
  it('embeds the owner pid', () => {
    const id = mintTestRunId(4242, 'abcdef');
    expect(id).toBe('4242-abcdef');
    expect(ownerPidOfTestRunId(id)).toBe(4242);
    expect(ownerPidOfTestRunId('nope')).toBeNull();
  });

  it('reads the id from an environment, ignoring malformed values', () => {
    expect(testRunIdFromEnviron({ [TEST_RUN_ID_ENV]: '1-abcdef' })).toBe('1-abcdef');
    expect(testRunIdFromEnviron({ [TEST_RUN_ID_ENV]: 'x' })).toBeNull();
    expect(testRunIdFromEnviron({})).toBeNull();
    expect(testRunIdFromEnviron(null)).toBeNull();
  });

  it('reads the id from a kvr-<id> path segment only', () => {
    expect(testRunIdFromPath('dtach -n /tmp/kvr-12-abcdef/tsc-x/s.sock -E sh')).toBe('12-abcdef');
    expect(testRunIdFromPath('rm -rf /tmp/kvr-12-abcdef')).toBe('12-abcdef');
    expect(testRunIdFromPath('dtach -n /tmp/kvr-12-abcdefg/s.sock')).toBeNull();
    expect(testRunIdFromPath('dtach -n /tmp/xkvr-12-abcdef/s.sock')).toBeNull();
    expect(testRunIdFromPath('dtach -n /tmp/tsc-x/s.sock')).toBeNull();
    expect(testRunIdFromPath('/tmp/kvr-1-aaaaaa/x/kvr-2-bbbbbb/s.sock')).toBe('2-bbbbbb');
  });
});

describe('currentTestRunId', () => {
  it('reads the run id the teardowns default to from the environment', () => {
    expect(currentTestRunId({ [TEST_RUN_ID_ENV]: '7-abcdef' })).toBe('7-abcdef');
    expect(currentTestRunId({ [TEST_RUN_ID_ENV]: 'not-an-id' })).toBeNull();
    expect(currentTestRunId({})).toBeNull();
  });
});

describe('classifyTestProcessOwnership', () => {
  const now = 10 * TEST_ORPHAN_MIN_AGE_MS;
  const old = now - TEST_ORPHAN_MIN_AGE_MS;
  const young = now - 1;
  const alive = (pid: number) => pid !== 2;
  const verdict = (ownerRunId: string | null, startTimeMs: number | null, currentRunId: string | null = '1-aaaaaa') =>
    classifyTestProcessOwnership({ ownerRunId, currentRunId, startTimeMs, now, isPidAlive: alive });

  it('reaps the current run at any age', () => {
    expect(verdict('1-aaaaaa', young)).toBe('current-run');
    expect(verdict('1-aaaaaa', null)).toBe('current-run');
  });

  it('keeps a run whose owner is alive, however old', () => {
    expect(verdict('3-bbbbbb', old)).toBe('keep');
  });

  it('reaps an old process whose owner is gone or that has no run id', () => {
    expect(verdict('2-bbbbbb', old)).toBe('orphan');
    expect(verdict(null, old)).toBe('orphan');
    expect(verdict(null, old, null)).toBe('orphan');
  });

  it('keeps a young or unknown-age process that the current run does not own', () => {
    expect(verdict('2-bbbbbb', young)).toBe('keep');
    expect(verdict(null, young)).toBe('keep');
    expect(verdict(null, null)).toBe('keep');
  });
});

describe('isPidAlive', () => {
  it('is true for this process and false for a pid that cannot exist', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(2 ** 22 + 1)).toBe(false);
  });
});
