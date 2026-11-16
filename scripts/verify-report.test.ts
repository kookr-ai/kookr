// scripts/verify.sh report file (KOOKR_VERIFY_REPORT_FILE, issue #3995) and the
// helper that writes it, scripts/verify-report.mjs. The verify.sh cases run the
// real script with `pnpm` as a stub on PATH: each `pnpm <args>` exits with the
// status FAIL_<script> asks for (default 0), and `pnpm test` copies a prepared
// Vitest run summary where test/rerun-gate.reporter.mjs would write it. git runs
// only in a mkdtemp repository.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';
import { buildVerifyReport, failedTestFiles } from './verify-report.mjs';

const VERIFY = join(resolve(dirname(fileURLToPath(import.meta.url))), 'verify.sh');
const ENV_BASE = { ...gitExecEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const summaryOf = (cwd: string, failed: string[], extra: Record<string, unknown> = {}) => ({
  reason: 'failed',
  unhandledErrors: 0,
  modules: [
    ...failed.map((f) => ({ file: join(cwd, f), state: 'failed' })),
    { file: join(cwd, 'src/fine.test.ts'), state: 'passed' },
  ],
  ...extra,
});

describe('buildVerifyReport', () => {
  const steps = (lines: string[][]) => lines.map((l) => l.join('\t')).join('\n');

  it('names each step that started and never passed, with its lane and command', () => {
    const report = buildVerifyReport({
      exitCode: 1,
      head: 'abc',
      steps: steps([
        ['start', 'build_server_lane', 'Type-checking server', 'pnpm build:server'],
        ['pass', 'build_server_lane', 'Type-checking server', 'pnpm build:server'],
        ['start', 'static_checks', 'Checking for import cycles', 'pnpm check:cycles'],
        ['start', 'hooks_lane', 'Running hook regression tests', 'pnpm test:hooks'],
      ]),
    });
    expect(report).toEqual({
      version: 1,
      head: 'abc',
      status: 'failed',
      exitCode: 1,
      failures: [
        { lane: 'static_checks', step: 'Checking for import cycles', command: 'pnpm check:cycles' },
        { lane: 'hooks_lane', step: 'Running hook regression tests', command: 'pnpm test:hooks' },
      ],
    });
  });

  it('reports no failure on a green run, whatever the steps file says', () => {
    const report = buildVerifyReport({ exitCode: 0, steps: 'start\tunit_lane\tRunning tests\tunit_tests\n' });
    expect(report.status).toBe('passed');
    expect(report.failures).toEqual([]);
  });

  it('leaves failures empty when a red run failed outside any step', () => {
    const report = buildVerifyReport({ exitCode: 1, steps: '' });
    expect(report).toMatchObject({ status: 'failed', failures: [] });
  });

  it('adds every failing test file to the unit lane, relative to the repository', () => {
    const report = buildVerifyReport({
      exitCode: 1,
      cwd: '/repo',
      steps: 'start\tunit_lane\tRunning tests\tunit_tests\n',
      unitSummary: summaryOf('/repo', ['src/z.test.ts', 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts']),
    });
    expect(report.failures).toEqual([{
      lane: 'unit_lane',
      step: 'Running tests',
      command: 'unit_tests',
      testFiles: ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts', 'src/e.test.ts', 'src/z.test.ts'],
    }]);
  });
});

describe('failedTestFiles', () => {
  it('returns null when the summary cannot name every failing file', () => {
    expect(failedTestFiles(null, '/r')).toBeNull();
    expect(failedTestFiles(summaryOf('/r', ['src/a.test.ts'], { unhandledErrors: 1 }), '/r')).toBeNull();
    expect(failedTestFiles(summaryOf('/r', ['src/a.test.ts'], { reason: 'interrupted' }), '/r')).toBeNull();
    expect(failedTestFiles(summaryOf('/r', []), '/r')).toBeNull();
    const crashed = summaryOf('/r', ['src/a.test.ts']);
    crashed.modules.push({ file: '/r/src/crashed.test.ts', state: 'pending' });
    expect(failedTestFiles(crashed, '/r')).toBeNull();
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'verify-report-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  const git = (args: string[]) => spawnSync('git', args, { cwd: repo, env: ENV_BASE, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const summaryFile = join(root, 'summary.json');
  writeFileSync(join(bin, 'pnpm'), [
    '#!/usr/bin/env bash',
    'if [ "$1" = test ] && [ -n "${VITEST_RERUN_SUMMARY_FILE:-}" ] && [ -f "$SUMMARY_SRC" ]; then',
    '  cp "$SUMMARY_SRC" "$VITEST_RERUN_SUMMARY_FILE"',
    'fi',
    'var="FAIL_$(printf %s "$1" | tr -c "A-Za-z0-9\\n" _)"',
    'exit "${!var:-0}"',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'pnpm'), 0o755);
  const reportFile = join(root, 'out', 'verify-abc.report.json');
  mkdirSync(dirname(reportFile));
  const run = (env: Record<string, string>, failed: string[] = [], extra: Record<string, unknown> = {}) => {
    writeFileSync(summaryFile, JSON.stringify(summaryOf(repo, failed, extra)));
    const r = spawnSync('bash', [VERIFY], {
      cwd: repo, encoding: 'utf8',
      // Clear what a parent run (the pre-push hook, the train) may have set.
      env: {
        ...ENV_BASE, KOOKR_VERIFY_FLAKY_RERUN: '', VITEST_RERUN_SUMMARY_FILE: '',
        KOOKR_VERIFY_REPORT_FILE: reportFile, SUMMARY_SRC: summaryFile,
        PATH: `${bin}:${process.env.PATH ?? ''}`, ...env,
      },
    });
    const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
    return { status: r.status, out: `${r.stdout}${r.stderr}`, report };
  };
  return { run, head, reportFile };
}

describe('verify.sh report file (KOOKR_VERIFY_REPORT_FILE)', () => {
  it('writes a passed report with the checked head on a green run', () => {
    const s = setup();
    const r = s.run({});
    expect(r.status, r.out).toBe(0);
    expect(r.report).toEqual({ version: 1, head: s.head, status: 'passed', exitCode: 0, failures: [] });
  });

  it('names the failing static check of a sequential run', () => {
    const s = setup();
    const r = s.run({ FAIL_check_cycles: '3' });
    expect(r.status).toBe(3);
    expect(r.report).toMatchObject({
      status: 'failed',
      exitCode: 3,
      failures: [{ lane: 'static_checks', step: 'Checking for import cycles', command: 'pnpm check:cycles' }],
    });
  });

  it('names the smoke lane when the local-only smoke gate fails', () => {
    const s = setup();
    const r = s.run({ FAIL_test_smoke: '1' });
    expect(r.status).toBe(1);
    expect(r.report.failures).toEqual([{ lane: 'smoke_lane', step: 'Running local-only smoke gates', command: 'pnpm test:smoke' }]);
  });

  it('lists the unit lane\'s failing test files in a plain run', () => {
    const s = setup();
    const r = s.run({ FAIL_test: '1' }, ['src/core/broken.test.ts']);
    expect(r.status).toBe(1);
    expect(r.report.failures).toEqual([{
      lane: 'unit_lane', step: 'Running tests', command: 'unit_tests', testFiles: ['src/core/broken.test.ts'],
    }]);
  });

  it('names every lane that failed when the train runs lanes at the same time', () => {
    const s = setup();
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `src/${n}.test.ts`); // too many to re-run
    const r = s.run({ KOOKR_VERIFY_FLAKY_RERUN: '1', FAIL_test: '1', FAIL_test_hooks: '1' }, files);
    expect(r.status).not.toBe(0);
    const lanes = (r.report.failures as Array<{ lane: string }>).map((f) => f.lane).sort();
    expect(lanes).toEqual(['hooks_lane', 'unit_lane']);
    const unit = (r.report.failures as Array<{ lane: string; testFiles?: string[] }>).find((f) => f.lane === 'unit_lane');
    expect(unit?.testFiles).toEqual(files);
  });

  it('leaves out the test files when the run reported an unhandled error', () => {
    const s = setup();
    const r = s.run({ KOOKR_VERIFY_FLAKY_RERUN: '1', FAIL_test: '1' }, ['src/a.test.ts'], { unhandledErrors: 1 });
    expect(r.status).not.toBe(0);
    expect(r.report.failures).toEqual([{ lane: 'unit_lane', step: 'Running tests', command: 'unit_tests' }]);
  });

  it('replaces a stale report from an earlier run', () => {
    const s = setup();
    writeFileSync(s.reportFile, JSON.stringify({ status: 'failed', failures: [{ lane: 'old' }] }));
    const r = s.run({});
    expect(r.report.status).toBe('passed');
  });

  it('writes nothing when the variable is unset', () => {
    const s = setup();
    const r = s.run({ KOOKR_VERIFY_REPORT_FILE: '', FAIL_check_cycles: '1' });
    expect(r.status).toBe(1);
    expect(r.report).toBeNull();
  });
});
