// Tests test/shared-worker-reset.setup.ts (issue #4080), the setup file of the
// `shared` Vitest project, where one worker runs many files in turn.
//
// A test inside the `shared` project cannot see what the reset did between
// two files, so this runs a child `vitest run` on the fixtures in
// test/fixtures/shared-worker-reset/: one worker, no isolation, the real reset
// file as setup. Files 1 and 3 leak timer globals, Date, env keys, module
// state and the working directory (3 also deletes it); files 2 and 4 check
// each leak is gone. A second run without the reset shows the leaks reach the
// next file when nothing undoes them, so the first run cannot pass vacuously.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..');
const FIXTURE_CONFIG = join(REPO_ROOT, 'test/fixtures/shared-worker-reset/vitest.config.mts');
const VITEST_BIN = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
const CHILD_TIMEOUT_MS = 90_000;

const VICTIM_TESTS = [
  'timer globals and Date are the real ones',
  'process.env is back to what it was',
  'the working directory is back to what it was',
  'project modules are loaded fresh',
];

interface JsonReport {
  testResults: { name: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
}

interface ChildRun {
  status: number | null;
  output: string;
  report: JsonReport;
  log: { pid: string; file: string }[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runFixtures(options: { withReset: boolean; files?: string[] }): ChildRun {
  const work = mkdtempSync(join(tmpdir(), 'kookr-swr-test-'));
  tempDirs.push(work);
  const liveDir = mkdtempSync(join(work, 'live-'));
  const logPath = join(work, 'fixture.log');
  const reportPath = join(work, 'report.json');

  // Drop the parent run's VITEST_* variables (worker ids, the pre-push gate's
  // rerun summary file) so the child behaves as a fresh top-level run.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && key !== 'TEST' && key !== 'NODE_ENV') env[key] = value;
  }
  Object.assign(env, {
    SWR_LOG: logPath,
    SWR_LIVE_DIR: liveDir,
    SWR_START_CWD: REPO_ROOT,
    SWR_CACHE_DIR: join(work, 'cache'),
    SWR_CHANGED: 'original',
    SWR_DELETED: 'present',
    SWR_WITHOUT_RESET: options.withReset ? '0' : '1',
  });
  delete env.SWR_ADDED;

  const result = spawnSync(
    process.execPath,
    [VITEST_BIN, 'run', '--config', FIXTURE_CONFIG, '--reporter=json', `--outputFile=${reportPath}`, ...(options.files ?? [])],
    { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: CHILD_TIMEOUT_MS },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  let report: JsonReport;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as JsonReport;
  } catch (err) {
    throw new Error(`child vitest wrote no JSON report (exit ${result.status}):\n${output}`, { cause: err });
  }
  const log = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, file] = line.split(' ');
      return { pid, file };
    });
  return { status: result.status, output, report, log };
}

function testStatuses(report: JsonReport, fileSuffix: string): Record<string, string> {
  const file = report.testResults.find((r) => r.name.endsWith(fileSuffix));
  if (!file) throw new Error(`no results for ${fileSuffix} in the child report`);
  return Object.fromEntries(file.assertionResults.map((a) => [a.title, a.status]));
}

const allPassed = Object.fromEntries(VICTIM_TESTS.map((title) => [title, 'passed']));

describe('shared-worker reset (test/shared-worker-reset.setup.ts)', () => {
  it(
    'undoes every leak before the next file runs in the same worker',
    () => {
      const run = runFixtures({ withReset: true });

      // All four files ran, in name order, in one process: otherwise a fresh
      // worker per file would make the victims pass on their own.
      expect(run.log.map((entry) => entry.file)).toEqual([
        '1-leak-into-live-dir.fixture.ts',
        '2-victim.fixture.ts',
        '3-leak-into-deleted-dir.fixture.ts',
        '4-victim.fixture.ts',
      ]);
      expect(new Set(run.log.map((entry) => entry.pid)).size).toBe(1);

      // 2-victim follows a file that ended in a live directory, 4-victim one
      // that ended in a deleted directory (the branch where cwd() throws).
      expect(testStatuses(run.report, '2-victim.fixture.ts')).toEqual(allPassed);
      expect(testStatuses(run.report, '4-victim.fixture.ts')).toEqual(allPassed);
      expect(run.status, run.output).toBe(0);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );

  it(
    'without the reset, the same leaks reach the next file',
    () => {
      // Only files 1 and 2: without the reset the deleted directory of file 3
      // would stay the worker's cwd, which tells nothing more.
      const run = runFixtures({
        withReset: false,
        files: ['1-leak-into-live-dir.fixture.ts', '2-victim.fixture.ts'],
      });

      expect(new Set(run.log.map((entry) => entry.pid)).size).toBe(1);
      expect(testStatuses(run.report, '2-victim.fixture.ts')).toEqual(
        Object.fromEntries(VICTIM_TESTS.map((title) => [title, 'failed'])),
      );
      expect(run.status).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 10_000,
  );
});
