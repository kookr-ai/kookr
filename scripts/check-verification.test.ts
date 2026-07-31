import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  classifyCheckRuns,
  classifyRun,
  neverExecutedReason,
  NEVER_EXECUTED_ANNOTATION_PATTERN,
  EXIT_CODES,
  CLASSIFICATIONS,
} from './check-verification.mjs';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'check-verification');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), 'utf8'));
}

describe('classifyCheckRuns — recorded gh JSON fixtures', () => {
  it('classifies the real 2026-07-30 lucy #1843 billing outage as never-executed', () => {
    const result = classifyCheckRuns(loadFixture('lucy-1843-billing-failed.check-runs.json'));
    expect(result.classification).toBe(CLASSIFICATIONS.NEVER_EXECUTED);
    expect(result.mergeSafe).toBe(false);
    expect(result.counts.neverExecuted).toBe(3);
    expect(result.counts.executedRed).toBe(0);
    // Every billing-blocked run is caught by its annotation, including the one
    // that "ran" for 10s where a pure duration heuristic would have failed.
    expect(result.runs.every((r) => r.verdict === 'never-executed')).toBe(true);
    expect(result.runs.every((r) => r.reason === 'billing-annotation')).toBe(true);
  });

  it('classifies the real lucy #1844 billing outage as never-executed', () => {
    const result = classifyCheckRuns(loadFixture('lucy-1844-billing-failed.check-runs.json'));
    expect(result.classification).toBe(CLASSIFICATIONS.NEVER_EXECUTED);
    expect(result.counts.neverExecuted).toBe(3);
  });

  it('classifies a genuine executed test failure as executed-red (never merge)', () => {
    const result = classifyCheckRuns(loadFixture('kookr-genuine-executed-failure.check-runs.json'));
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    expect(result.mergeSafe).toBe(false);
    expect(result.counts.executedRed).toBe(1);
    const macos = result.runs.find((r) => r.name === 'macos');
    expect(macos?.verdict).toBe('executed-red');
    // The green siblings and the skipped `portability` run are all non-blocking
    // (2 success + 1 stt-tests success + 1 skipped = 4).
    expect(result.counts.passed).toBe(4);
  });

  it('classifies an all-green run as executed-green (safe to merge)', () => {
    const result = classifyCheckRuns(loadFixture('lucy-green.check-runs.json'));
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_GREEN);
    expect(result.mergeSafe).toBe(true);
    expect(result.counts.passed).toBe(3);
  });
});

describe('classifyCheckRuns — structural edge cases', () => {
  it('reports none-required when the head SHA has no check runs', () => {
    const result = classifyCheckRuns({ total_count: 0, check_runs: [] });
    expect(result.classification).toBe(CLASSIFICATIONS.NONE_REQUIRED);
    expect(result.mergeSafe).toBe(true);
  });

  it('accepts a bare check-runs array as well as the API envelope', () => {
    const bare = (loadFixture('lucy-green.check-runs.json') as { check_runs: unknown[] }).check_runs;
    expect(classifyCheckRuns(bare).classification).toBe(CLASSIFICATIONS.EXECUTED_GREEN);
  });

  it('treats a still-running check as pending, outranking never-executed', () => {
    const result = classifyCheckRuns([
      { name: 'billing', status: 'completed', conclusion: 'failure', started_at: null },
      { name: 'slow', status: 'in_progress', conclusion: null },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.PENDING);
  });

  it('lets a real red outrank a pending sibling (executedRed checked before pending)', () => {
    const result = classifyCheckRuns([
      { name: 'slow', status: 'in_progress', conclusion: null },
      {
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-30T10:00:00Z',
        completed_at: '2026-07-30T10:02:00Z',
        annotations: [{ message: 'AssertionError: expected 1 to be 2' }],
      },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
  });

  it('classifies a lone null-started_at failure as never-executed end-to-end', () => {
    const result = classifyCheckRuns([
      { name: 'undispatched', status: 'completed', conclusion: 'failure', started_at: null },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.NEVER_EXECUTED);
    expect(result.runs[0].reason).toBe('no-start');
  });

  it('keeps a failure that merely omits started_at as executed-red (not no-start)', () => {
    // A converted commit status / third-party check reports a real failure with
    // no started_at field at all — absent must not be waived like explicit null.
    const result = classifyCheckRuns([
      { name: 'legacy-status', status: 'completed', conclusion: 'failure', annotations: [] },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
  });

  it('lets a real red outrank a never-executed sibling', () => {
    const result = classifyCheckRuns([
      {
        name: 'billing',
        status: 'completed',
        conclusion: 'failure',
        annotations: [{ message: 'The job was not started because recent account payments have failed' }],
      },
      {
        name: 'unit',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-30T10:00:00Z',
        completed_at: '2026-07-30T10:02:00Z',
        annotations: [{ message: 'AssertionError: expected 1 to be 2' }],
      },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
  });

  it('treats cancelled/stale as unresolved rather than red or green', () => {
    const result = classifyCheckRuns([
      { name: 'ok', status: 'completed', conclusion: 'success' },
      { name: 'aborted', status: 'completed', conclusion: 'cancelled' },
    ]);
    expect(result.classification).toBe(CLASSIFICATIONS.PENDING);
  });
});

describe('classifyRun — verdict details', () => {
  it('marks a fast failure with zero steps as never-executed', () => {
    const run = {
      name: 'quick',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-07-30T10:00:00Z',
      completed_at: '2026-07-30T10:00:05Z',
      steps: [],
    };
    const { verdict, reason } = classifyRun(run);
    expect(verdict).toBe('never-executed');
    expect(reason).toBe('no-steps-fast');
  });

  it('keeps a zero-steps but SLOW failure as executed-red (duration guard)', () => {
    // The no-steps-fast heuristic is a conjunction: zero steps AND < 15s. A
    // genuine failure that recorded zero steps but ran long must stay red.
    const run = {
      name: 'slow-zero-steps',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-07-30T10:00:00Z',
      completed_at: '2026-07-30T10:00:40Z',
      steps: [],
    };
    expect(classifyRun(run).verdict).toBe('executed-red');
  });

  it('keeps a startup_failure as executed-red even with a null started_at', () => {
    // A workflow that failed to start up is a real defect, not a billing waiver.
    const run = { name: 'bad-yaml', status: 'completed', conclusion: 'startup_failure', started_at: null };
    expect(classifyRun(run).verdict).toBe('executed-red');
    expect(neverExecutedReason(run)).toBeNull();
  });

  it('keeps a fast genuine failure (steps ran) as executed-red', () => {
    const run = {
      name: 'quick-real',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-07-30T10:00:00Z',
      completed_at: '2026-07-30T10:00:05Z',
      steps: [{ name: 'run tests', conclusion: 'failure' }],
      annotations: [{ message: 'Error: 1 test failed' }],
    };
    expect(classifyRun(run).verdict).toBe('executed-red');
  });

  it('does not misread an absent-steps fast failure as never-executed', () => {
    // No `steps` array at all → the zero-steps heuristic must not fire.
    const run = {
      name: 'no-steps-info',
      status: 'completed',
      conclusion: 'failure',
      started_at: '2026-07-30T10:00:00Z',
      completed_at: '2026-07-30T10:00:03Z',
    };
    expect(classifyRun(run).verdict).toBe('executed-red');
  });

  it('marks a null started_at failure as never-executed', () => {
    expect(neverExecutedReason({ conclusion: 'failure', started_at: null })).toBe('no-start');
  });
});

describe('NEVER_EXECUTED_ANNOTATION_PATTERN', () => {
  it('matches the real billing annotation message', () => {
    expect(
      NEVER_EXECUTED_ANNOTATION_PATTERN.test(
        "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings",
      ),
    ).toBe(true);
  });

  it('does not match a genuine assertion failure message', () => {
    expect(
      NEVER_EXECUTED_ANNOTATION_PATTERN.test("AssertionError: expected undefined to be 'skipped_unsafe'"),
    ).toBe(false);
  });
});

describe('EXIT_CODES', () => {
  it('maps each classification to its merge-gating exit code', () => {
    expect(EXIT_CODES['executed-green']).toBe(0);
    expect(EXIT_CODES['none-required']).toBe(0);
    expect(EXIT_CODES['never-executed']).toBe(10);
    expect(EXIT_CODES['executed-red']).toBe(20);
    expect(EXIT_CODES.pending).toBe(30);
  });
});
