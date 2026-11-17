import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { endTestRun, setup, startTestRun, sweepDeadRunTmpDirs, teardown } from './test-run-id.global.js';
import {
  TEST_ORPHAN_MIN_AGE_MS,
  TEST_RUN_ID_ENV,
  TEST_RUN_TMPDIR_PREFIX,
  isTestRunId,
  ownerPidOfTestRunId,
  testRunIdFromPath,
} from '../src/test-utils/test-run-identity.js';

describe('startTestRun / endTestRun', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'run-id-setup-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('publishes a fresh run id owned by this process and a run temp dir that names it', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/original' };
    const state = startTestRun(env, { platform: 'linux', baseTmpDir: base });

    expect(isTestRunId(env[TEST_RUN_ID_ENV])).toBe(true);
    expect(ownerPidOfTestRunId(state.runId)).toBe(process.pid);
    expect(env.TMPDIR).toBe(join(base, `${TEST_RUN_TMPDIR_PREFIX}${state.runId}`));
    expect(existsSync(env.TMPDIR!)).toBe(true);
    expect(testRunIdFromPath(`dtach -n ${env.TMPDIR}/tsc-x/s.sock -E sh`)).toBe(state.runId);

    writeFileSync(join(env.TMPDIR!, 'leftover'), 'x');
    const runDir = env.TMPDIR!;
    endTestRun(env, state);
    expect(env).toEqual({ TMPDIR: '/original' });
    expect(existsSync(runDir)).toBe(false);
  });

  it('mints a new id even when the environment already carries one (nested run)', () => {
    const env: NodeJS.ProcessEnv = {};
    const outer = startTestRun(env, { platform: 'linux', baseTmpDir: base, runId: `${process.pid}-aaaaaa` });
    const inner = startTestRun(env, { platform: 'linux', runId: `${process.pid}-bbbbbb` });

    expect(env[TEST_RUN_ID_ENV]).toBe(inner.runId);
    // The nested run dir sits beside the parent's, not inside it.
    expect(dirname(inner.runTmpDir!)).toBe(base);

    endTestRun(env, inner);
    expect(env[TEST_RUN_ID_ENV]).toBe(outer.runId);
    expect(env.TMPDIR).toBe(outer.runTmpDir);
    endTestRun(env, outer);
    expect(env).toEqual({});
  });

  it('two runs get different ids', () => {
    const a = startTestRun({}, { platform: 'darwin' });
    const b = startTestRun({}, { platform: 'darwin' });
    expect(a.runId).not.toBe(b.runId);
  });

  it('leaves TMPDIR alone off Linux', () => {
    const env: NodeJS.ProcessEnv = { TMPDIR: '/var/folders/x/T' };
    const state = startTestRun(env, { platform: 'darwin' });
    expect(state.runTmpDir).toBeNull();
    expect(env.TMPDIR).toBe('/var/folders/x/T');
    expect(env[TEST_RUN_ID_ENV]).toBe(state.runId);
    endTestRun(env, state);
    expect(env).toEqual({ TMPDIR: '/var/folders/x/T' });
  });
});

describe('sweepDeadRunTmpDirs (issue #4123)', () => {
  const OWN = '100-aaaaaa';
  const NOW = Date.now();
  const OLD = (NOW - TEST_ORPHAN_MIN_AGE_MS - 60_000) / 1000;
  const YOUNG = (NOW - TEST_ORPHAN_MIN_AGE_MS + 60_000) / 1000;
  const DEAD_PIDS = new Set([100, 200, 300]);
  const isPidAlive = (pid: number) => !DEAD_PIDS.has(pid);
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'run-id-sweep-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** A run dir with a nested file, aged to `mtimeSec` (after it is populated, which bumps the mtime). */
  function runDir(name: string, mtimeSec: number): string {
    const dir = join(base, name);
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'sock'), 'x');
    utimesSync(dir, mtimeSec, mtimeSec);
    return dir;
  }

  it('removes only an old run dir whose owner has exited', () => {
    const deadOld = runDir('kvr-200-bbbbbb', OLD);
    const deadYoung = runDir('kvr-300-cccccc', YOUNG);
    const aliveOld = runDir('kvr-400-dddddd', OLD);

    const removed = sweepDeadRunTmpDirs(base, { ownRunId: OWN, now: NOW, isPidAlive });

    expect(removed).toEqual([deadOld]);
    expect(existsSync(deadOld)).toBe(false);
    expect(existsSync(deadYoung)).toBe(true);
    expect(existsSync(aliveOld)).toBe(true);
  });

  it('never removes its own run dir, even when it looks dead and old', () => {
    const own = runDir(`kvr-${OWN}`, OLD);
    expect(sweepDeadRunTmpDirs(base, { ownRunId: OWN, now: NOW, isPidAlive: () => false })).toEqual([]);
    expect(existsSync(own)).toBe(true);
  });

  it('leaves entries that are not run dirs alone', () => {
    const notAnId = runDir('kvr-notanid', OLD);
    const unrelated = runDir('200-bbbbbb', OLD);
    const file = join(base, 'kvr-200-eeeeee');
    writeFileSync(file, 'x');
    utimesSync(file, OLD, OLD);

    expect(sweepDeadRunTmpDirs(base, { ownRunId: OWN, now: NOW, isPidAlive: () => false })).toEqual([]);
    expect(readdirSync(base).sort()).toEqual([basename(unrelated), basename(file), basename(notAnId)].sort());
  });

  it('is a no-op on a missing base', () => {
    expect(sweepDeadRunTmpDirs(join(base, 'missing'), { ownRunId: OWN, now: NOW, isPidAlive })).toEqual([]);
  });

  it('runs when a run starts, in the base its run dir goes into', () => {
    const deadOld = runDir('kvr-200-bbbbbb', OLD);
    const aliveOld = runDir('kvr-400-dddddd', OLD);
    const env: NodeJS.ProcessEnv = {};
    const state = startTestRun(env, { platform: 'linux', baseTmpDir: base, sweep: { now: NOW, isPidAlive } });

    expect(existsSync(deadOld)).toBe(false);
    expect(existsSync(aliveOld)).toBe(true);
    expect(dirname(state.runTmpDir!)).toBe(base);
    endTestRun(env, state);
  });
});

describe('setup / teardown across Vitest projects', () => {
  let saved: { id: string | undefined; tmp: string | undefined };
  let base: string;

  beforeEach(() => {
    saved = { id: process.env[TEST_RUN_ID_ENV], tmp: process.env.TMPDIR };
    // setup() creates its run dir beside os.tmpdir() and sweeps that directory;
    // keep both out of the real temp root.
    base = mkdtempSync(join(tmpdir(), 'run-id-setup-'));
    process.env.TMPDIR = base;
  });

  afterEach(() => {
    // A failed assertion can leave the shared run open; close it so its run
    // temp dir is deleted.
    while ((globalThis as Record<symbol, unknown>)[Symbol.for('kookr.test-run-id.global')]) teardown();
    for (const [key, value] of [[TEST_RUN_ID_ENV, saved.id], ['TMPDIR', saved.tmp]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
  });

  it('shares one id between the per-project setups and restores the env at the last teardown', () => {
    setup(); // first project: mints a fresh id, even though the env has one
    const id = process.env[TEST_RUN_ID_ENV];
    expect(id).not.toBe(saved.id);
    setup(); // second project
    expect(process.env[TEST_RUN_ID_ENV]).toBe(id);

    teardown(); // second project's teardown: its reapers still need the id
    expect(process.env[TEST_RUN_ID_ENV]).toBe(id);
    teardown();
    expect(process.env[TEST_RUN_ID_ENV]).toBe(saved.id);
    expect(process.env.TMPDIR).toBe(base);
  });
});

// This file runs under the repo's Vitest config, so the real globalSetup has
// already run in the main process. The id must survive into this worker
// (past test/setup-env.ts, which scrubs KOOKR_* keys) for the processes the
// worker spawns to inherit it.
describe('the real run, seen from a worker', () => {
  it('carries the run id in the environment', () => {
    expect(isTestRunId(process.env[TEST_RUN_ID_ENV])).toBe(true);
  });

  it.runIf(process.platform === 'linux')('uses the run temp dir as os.tmpdir()', () => {
    expect(basename(tmpdir())).toBe(`${TEST_RUN_TMPDIR_PREFIX}${process.env[TEST_RUN_ID_ENV]}`);
  });

  // Every run initializes globalSetup for at least two Vitest projects (this
  // file's and the root), each with its own module instance. They must share
  // one id, so the Vitest process owns exactly one run temp dir.
  it.runIf(process.platform === 'linux')('has one run temp dir per Vitest process', () => {
    const ownerPid = ownerPidOfTestRunId(process.env[TEST_RUN_ID_ENV]!);
    const prefix = `${TEST_RUN_TMPDIR_PREFIX}${ownerPid}-`;
    const runDirs = readdirSync(dirname(tmpdir())).filter((name) => name.startsWith(prefix));
    expect(runDirs).toEqual([basename(tmpdir())]);
  });
});
