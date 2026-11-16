import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptsDir, 'fixtures', 'check-verification');
const CLASSIFIER = join(scriptsDir, 'check-verification.mjs');
const KOOKR_BIN = join(scriptsDir, '..', 'bin', 'kookr.js');

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

// Several attempts of one check on the head SHA (issue #3643). Ids grow with
// creation, so the higher id is the re-run.
describe('classifyCheckRuns — re-runs of the same check', () => {
  const suite = { id: 500 };
  const app = { id: 15368 };
  const failedOnCode = {
    id: 101,
    name: 'unit',
    app,
    check_suite: suite,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-11-10T10:00:00Z',
    completed_at: '2026-11-10T10:03:00Z',
    annotations: [{ message: 'AssertionError: expected 1 to be 2' }],
  };
  const passedRerun = {
    id: 102,
    name: 'unit',
    app,
    check_suite: suite,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-11-10T11:00:00Z',
    completed_at: '2026-11-10T11:03:00Z',
  };
  const billingBlockedRerun = {
    id: 102,
    name: 'unit',
    app,
    check_suite: suite,
    status: 'completed',
    conclusion: 'failure',
    started_at: null,
    completed_at: '2026-11-10T11:00:04Z',
  };
  const runningRerun = {
    id: 102,
    name: 'unit',
    app,
    check_suite: suite,
    status: 'in_progress',
    conclusion: null,
    started_at: '2026-11-10T11:00:00Z',
    completed_at: null,
  };

  it('classifies a stale failure followed by a successful re-run as green', () => {
    const result = classifyCheckRuns({ check_runs: [failedOnCode, passedRerun] });
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_GREEN);
    expect(result.mergeSafe).toBe(true);
    expect(result.runs).toHaveLength(1);
    expect(result.counts.superseded).toBe(1);
  });

  it('decides by creation order (id), not by the order the API lists the runs', () => {
    // The API lists newest first; the earlier failure comes second here.
    expect(classifyCheckRuns([passedRerun, failedOnCode]).classification).toBe(CLASSIFICATIONS.EXECUTED_GREEN);
    // And a failing re-run after a pass is red, whichever order they arrive in.
    const passedFirst = { ...passedRerun, id: 101 };
    const failedLater = { ...failedOnCode, id: 102 };
    expect(classifyCheckRuns([failedLater, passedFirst]).classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    expect(classifyCheckRuns([passedFirst, failedLater]).classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
  });

  it('waits on a re-run that is still running', () => {
    expect(classifyCheckRuns([failedOnCode, runningRerun]).classification).toBe(CLASSIFICATIONS.PENDING);
  });

  it('keeps a check that ran and failed red when its re-run never executed', () => {
    const result = classifyCheckRuns([billingBlockedRerun, failedOnCode]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    expect(result.mergeSafe).toBe(false);
  });

  it('classifies a never-executed attempt followed by a successful re-run as green', () => {
    const blockedFirst = { ...billingBlockedRerun, id: 101, completed_at: '2026-11-10T10:00:04Z' };
    expect(classifyCheckRuns([blockedFirst, passedRerun]).classification).toBe(CLASSIFICATIONS.EXECUTED_GREEN);
  });

  it('keeps a failure red when a later same-named job overlapped it (sibling, not a re-run)', () => {
    // Two jobs of one workflow run sharing a name: the pass started before the
    // failure finished, so it cannot be a re-run of it.
    const sibling = { ...passedRerun, started_at: '2026-11-10T10:00:00Z', completed_at: '2026-11-10T10:01:00Z' };
    const result = classifyCheckRuns([failedOnCode, sibling]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    expect(result.counts.superseded).toBe(0);
    // And the hidden red is not turned into a waivable never-executed either.
    const billingElsewhere = { ...billingBlockedRerun, id: 300, name: 'lint', completed_at: '2026-11-10T10:00:04Z' };
    expect(classifyCheckRuns([failedOnCode, sibling, billingElsewhere]).classification).toBe(
      CLASSIFICATIONS.EXECUTED_RED,
    );
  });

  it('keeps a failure red when its re-run was skipped or neutral', () => {
    for (const conclusion of ['skipped', 'neutral']) {
      const rerun = { ...passedRerun, conclusion };
      expect(classifyCheckRuns([failedOnCode, rerun]).classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    }
  });

  it('does not let a later pass hide a same-named job that is still running', () => {
    const stillRunning = { ...runningRerun, id: 101 };
    const laterPass = { ...passedRerun, id: 102 };
    expect(classifyCheckRuns([stillRunning, laterPass]).classification).toBe(CLASSIFICATIONS.PENDING);
  });

  it('does not let a green in one workflow hide a red of the same name in another', () => {
    const otherWorkflowPass = { ...passedRerun, check_suite: { id: 501 } };
    const result = classifyCheckRuns([failedOnCode, otherWorkflowPass]);
    expect(result.classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
    expect(result.counts.superseded).toBe(0);
  });

  it('never merges runs that have no name', () => {
    const unnamedRed = { ...failedOnCode, name: undefined };
    const unnamedGreen = { ...passedRerun, name: undefined };
    expect(classifyCheckRuns([unnamedRed, unnamedGreen]).classification).toBe(CLASSIFICATIONS.EXECUTED_RED);
  });
});

// `kookr check-verification` (issue #3643): the same classifier, reachable from
// any repository.
describe('kookr check-verification', () => {
  function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
    return spawnSync(process.execPath, [file, ...args], { cwd, env, encoding: 'utf8' });
  }

  it('returns the same exit codes as the script, from a cwd outside the kookr repo', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'kookr-check-verification-'));
    try {
      const pendingFile = join(elsewhere, 'pending.json');
      writeFileSync(pendingFile, JSON.stringify([{ name: 'unit', status: 'in_progress', conclusion: null }]));
      const cases: Array<[string, number]> = [
        [join(fixturesDir, 'lucy-green.check-runs.json'), 0],
        [join(fixturesDir, 'lucy-1843-billing-failed.check-runs.json'), 10],
        [join(fixturesDir, 'kookr-genuine-executed-failure.check-runs.json'), 20],
        [pendingFile, 30],
      ];
      for (const [file, code] of cases) {
        const viaKookr = run(KOOKR_BIN, ['check-verification', '--from-file', file], elsewhere);
        const viaScript = run(CLASSIFIER, ['--from-file', file], elsewhere);
        expect(viaKookr.status).toBe(code);
        expect(viaScript.status).toBe(code);
        expect(viaKookr.stdout).toBe(viaScript.stdout);
      }
      expect(run(KOOKR_BIN, ['check-verification', '--bogus'], elsewhere).status).toBe(1);
      expect(run(KOOKR_BIN, ['check-verification', '--help'], elsewhere).status).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('without --repo, resolves the PR against the caller\'s repository', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'kookr-check-verification-'));
    try {
      const stubDir = join(elsewhere, 'bin');
      spawnSync('mkdir', [stubDir]);
      const runs = {
        total_count: 2,
        check_runs: [
          { id: 2, name: 'unit', status: 'completed', conclusion: 'success', started_at: '2026-11-10T11:00:00Z', completed_at: '2026-11-10T11:03:00Z', output: { annotations_count: 0 } },
          { id: 1, name: 'unit', status: 'completed', conclusion: 'failure', started_at: '2026-11-10T10:00:00Z', completed_at: '2026-11-10T10:03:00Z', output: { annotations_count: 0 } },
        ],
      };
      writeFileSync(join(elsewhere, 'runs.json'), JSON.stringify(runs));
      // A gh stub that logs its cwd and serves the classifier's reads.
      writeFileSync(
        join(stubDir, 'gh'),
        `#!/bin/sh
printf '%s\\n' "$PWD" >> "${elsewhere}/cwd.log"
case "$*" in
  "repo view"*) echo caller/repo ;;
  "api repos/caller/repo/pulls/7 "*) echo 0123456789abcdef0123456789abcdef01234567 ;;
  *check-runs*) cat "${elsewhere}/runs.json" ;;
  *"/status") echo '{"state":"pending","total_count":0,"statuses":[]}' ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
      );
      chmodSync(join(stubDir, 'gh'), 0o755);
      const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ''}` };
      const result = run(KOOKR_BIN, ['check-verification', '7'], elsewhere, env);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('caller/repo #7');
      expect(result.stdout).toContain('EXECUTED-GREEN');
      const cwds = new Set(readFileSync(join(elsewhere, 'cwd.log'), 'utf8').trim().split('\n'));
      expect([...cwds]).toEqual([realpathSync(elsewhere)]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
