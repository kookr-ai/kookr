import { describe, expect, test } from 'vitest';
import {
  EXIT_CODES,
  type LaneConfig,
  type LaneDeps,
  executeLane,
  extractPrNumber,
  isFullCommitSha,
  isSuiteInfraFailure,
  parseArgs,
  planTargets,
} from './independent-verification-lane.js';
import type {
  IncidentReport,
  MergedCommit,
  SuiteRunResult,
  VerificationTarget,
} from '../src/core/independent-verification-lane.js';

function baseConfig(overrides: Partial<LaneConfig> = {}): LaneConfig {
  return {
    cadence: 'rolling-sweep',
    repo: 'kookr-ai/kookr',
    repoUrl: 'https://github.com/kookr-ai/kookr.git',
    suite: 'pnpm test',
    sweepLimit: 5,
    stopOnFirstRed: true,
    dryRun: false,
    labels: ['incident'],
    json: false,
    ...overrides,
  };
}

interface FakeState {
  processed: string[];
  merged: MergedCommit[];
  runResults: Record<string, SuiteRunResult>;
  existingIncidents: Set<string>;
  filed: IncidentReport[];
  ensuredLabels: string[];
  logs: string[];
}

function fakeDeps(state: FakeState): LaneDeps {
  return {
    loadProcessed: () => [...state.processed],
    saveProcessed: (shas) => {
      state.processed = shas;
    },
    listMergedCommits: (limit) => state.merged.slice(0, limit),
    runSuite: (t: VerificationTarget) =>
      state.runResults[t.sha] ?? {
        status: 'green',
        exitCode: 0,
        suite: 'pnpm test',
      },
    incidentExists: (key) => state.existingIncidents.has(key),
    ensureIncidentLabel: (l) => state.ensuredLabels.push(l),
    fileIncident: (r) => {
      state.filed.push(r);
      return 9000 + state.filed.length;
    },
    log: (m) => state.logs.push(m),
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    processed: [],
    merged: [],
    runResults: {},
    existingIncidents: new Set(),
    filed: [],
    ensuredLabels: [],
    logs: [],
    ...overrides,
  };
}

const SHA_A = 'aaaaaaaaaaaa1111aaaaaaaaaaaa1111aaaaaaaa';
const SHA_B = 'bbbbbbbbbbbb2222bbbbbbbbbbbb2222bbbbbbbb';
const SHA_C = 'cccccccccccc3333cccccccccccc3333cccccccc';

describe('extractPrNumber', () => {
  test('pulls trailing (#N) from a squash subject', () => {
    expect(extractPrNumber('fix(merge): handle null rollup (#1850)')).toBe(1850);
    expect(extractPrNumber('feat: nested (#12) then (#1846)')).toBe(1846);
    expect(extractPrNumber('no pr here')).toBeUndefined();
    expect(extractPrNumber(undefined)).toBeUndefined();
  });
});

describe('isFullCommitSha', () => {
  test('accepts a full 40-char hex SHA, rejects short/garbage', () => {
    expect(isFullCommitSha(SHA_A)).toBe(true);
    expect(isFullCommitSha(SHA_A.toUpperCase())).toBe(true);
    expect(isFullCommitSha('abcdef01')).toBe(false); // short → git fetch-by-SHA fails
    expect(isFullCommitSha(`${SHA_A}0`)).toBe(false); // too long
    expect(isFullCommitSha('z'.repeat(40))).toBe(false); // non-hex
    expect(isFullCommitSha(undefined)).toBe(false);
  });
});

describe('isSuiteInfraFailure', () => {
  test('spawn error, signal kill, and 127 are infra; a real test failure is not', () => {
    expect(isSuiteInfraFailure(1, new Error('boom'))).toBe(true); // could not spawn sh
    expect(isSuiteInfraFailure(null, undefined)).toBe(true); // killed by signal
    expect(isSuiteInfraFailure(127, undefined)).toBe(true); // command not found
    expect(isSuiteInfraFailure(1, undefined)).toBe(false); // genuine red
    expect(isSuiteInfraFailure(0, undefined)).toBe(false); // green
  });
});

describe('planTargets', () => {
  test('per-merge uses the configured SHA', () => {
    const state = emptyState();
    const targets = planTargets(baseConfig({ cadence: 'per-merge', sha: SHA_A }), fakeDeps(state));
    expect(targets.map((t) => t.sha)).toEqual([SHA_A]);
  });

  test('sweep pulls merged commits and skips processed', () => {
    const state = emptyState({
      merged: [
        { sha: SHA_A, prNumber: 3 },
        { sha: SHA_B, prNumber: 2 },
        { sha: SHA_C, prNumber: 1 },
      ],
      processed: [SHA_B],
    });
    const targets = planTargets(baseConfig(), fakeDeps(state));
    expect(targets.map((t) => t.sha)).toEqual([SHA_A, SHA_C]);
  });
});

describe('executeLane', () => {
  test('all green → exit ok, records processed, files nothing', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }, { sha: SHA_B }],
      runResults: {
        [SHA_A]: { status: 'green', exitCode: 0, suite: 'pnpm test' },
        [SHA_B]: { status: 'green', exitCode: 0, suite: 'pnpm test' },
      },
    });
    const summary = executeLane(baseConfig({ stopOnFirstRed: false }), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.ok);
    expect(summary.green).toBe(2);
    expect(summary.incidentsFiled).toBe(0);
    expect(state.processed.sort()).toEqual([SHA_A, SHA_B].sort());
  });

  test('red → files an incident, exit redFiled, records processed', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A, prNumber: 42, subject: 'bad merge (#42)' }],
      runResults: {
        [SHA_A]: {
          status: 'red',
          exitCode: 1,
          suite: 'pnpm test',
          failedSummary: 'suite exited 1',
          logExcerpt: 'FAIL some.test.ts',
        },
      },
    });
    const summary = executeLane(baseConfig(), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.redFiled);
    expect(summary.red).toBe(1);
    expect(summary.incidentsFiled).toBe(1);
    expect(state.filed).toHaveLength(1);
    expect(state.filed[0].labels).toEqual(['incident']);
    expect(state.filed[0].title).toContain('PR #42');
    expect(state.ensuredLabels).toContain('incident');
    expect(state.processed).toEqual([SHA_A]);
  });

  test('stopOnFirstRed halts the sweep at the first red', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }, { sha: SHA_B }],
      runResults: {
        [SHA_A]: { status: 'red', exitCode: 1, suite: 'pnpm test' },
        [SHA_B]: { status: 'red', exitCode: 1, suite: 'pnpm test' },
      },
    });
    const summary = executeLane(baseConfig({ stopOnFirstRed: true }), fakeDeps(state));
    expect(summary.scanned).toBe(1);
    expect(summary.incidentsFiled).toBe(1);
  });

  test('--all keeps going and files each red', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }, { sha: SHA_B }],
      runResults: {
        [SHA_A]: { status: 'red', exitCode: 1, suite: 'pnpm test' },
        [SHA_B]: { status: 'red', exitCode: 1, suite: 'pnpm test' },
      },
    });
    const summary = executeLane(baseConfig({ stopOnFirstRed: false }), fakeDeps(state));
    expect(summary.scanned).toBe(2);
    expect(summary.incidentsFiled).toBe(2);
  });

  test('duplicate incident is skipped, not re-filed', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }],
      runResults: { [SHA_A]: { status: 'red', exitCode: 1, suite: 'pnpm test' } },
      existingIncidents: new Set(['iv-lane:aaaaaaaaaaaa']),
    });
    const summary = executeLane(baseConfig(), fakeDeps(state));
    expect(summary.incidentsFiled).toBe(0);
    expect(summary.incidentsSkippedDuplicate).toBe(1);
    // A still-open incident keeps the tick red (nonzero) even though nothing
    // new was filed, and the SHA is recorded so it is not re-run.
    expect(summary.exitCode).toBe(EXIT_CODES.redFiled);
    expect(state.filed).toHaveLength(0);
    expect(state.processed).toEqual([SHA_A]);
  });

  test('incident filing failure does NOT record processed → red retries next tick', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }],
      runResults: { [SHA_A]: { status: 'red', exitCode: 1, suite: 'pnpm test' } },
    });
    const deps = fakeDeps(state);
    deps.fileIncident = () => null; // transient gh failure
    const summary = executeLane(baseConfig(), deps);
    expect(summary.red).toBe(1);
    expect(summary.incidentsFiled).toBe(0);
    expect(summary.incidentsFileFailed).toBe(1);
    // Not recorded → un-verified → retried next tick; never silently swallowed.
    expect(state.processed).toEqual([]);
    expect(summary.exitCode).toBe(EXIT_CODES.redFiled);
  });

  test('infra error files nothing and does NOT record processed (retries)', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }],
      runResults: {
        [SHA_A]: { status: 'error', exitCode: 1, suite: 'pnpm test', failedSummary: 'clone failed' },
      },
    });
    const summary = executeLane(baseConfig(), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.infra);
    expect(summary.error).toBe(1);
    expect(state.filed).toHaveLength(0);
    expect(state.processed).toEqual([]);
  });

  test('dry-run reports the plan but runs/records/files nothing', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }],
      runResults: { [SHA_A]: { status: 'red', exitCode: 1, suite: 'pnpm test' } },
    });
    const summary = executeLane(baseConfig({ dryRun: true }), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.ok);
    expect(summary.scanned).toBe(0);
    expect(state.filed).toHaveLength(0);
    expect(state.processed).toEqual([]);
    expect(summary.targets).toEqual([SHA_A]);
  });

  test('red precedence over infra error in mixed sweep', () => {
    const state = emptyState({
      merged: [{ sha: SHA_A }, { sha: SHA_B }],
      runResults: {
        [SHA_A]: { status: 'error', exitCode: 1, suite: 'pnpm test' },
        [SHA_B]: { status: 'red', exitCode: 1, suite: 'pnpm test' },
      },
    });
    const summary = executeLane(baseConfig({ stopOnFirstRed: false }), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.redFiled);
    expect(summary.error).toBe(1);
    expect(summary.red).toBe(1);
  });

  test('nothing to do when all merges already processed', () => {
    const state = emptyState({ merged: [{ sha: SHA_A }], processed: [SHA_A] });
    const summary = executeLane(baseConfig(), fakeDeps(state));
    expect(summary.exitCode).toBe(EXIT_CODES.ok);
    expect(summary.scanned).toBe(0);
  });
});

describe('parseArgs', () => {
  test('per-merge requires a full --sha and infers repo-url', () => {
    const cfg = parseArgs(['--sha', SHA_A, '--repo', 'o/n']);
    expect(cfg.cadence).toBe('per-merge');
    expect(cfg.sha).toBe(SHA_A);
    expect(cfg.repoUrl).toBe('https://github.com/o/n.git');
  });

  test('sweep defaults, clamps limit, honors --all and --suite', () => {
    const cfg = parseArgs(['--sweep', '--repo', 'o/n', '--limit', '999', '--all', '--suite', 'pnpm build && pnpm test']);
    expect(cfg.cadence).toBe('rolling-sweep');
    expect(cfg.sweepLimit).toBe(20);
    expect(cfg.stopOnFirstRed).toBe(false);
    expect(cfg.suite).toBe('pnpm build && pnpm test');
  });

  test('custom labels parse', () => {
    const cfg = parseArgs(['--repo', 'o/n', '--labels', 'incident, p0']);
    expect(cfg.labels).toEqual(['incident', 'p0']);
  });
});
