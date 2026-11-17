import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { endTestRun, setup, startTestRun, teardown } from './test-run-id.global.js';
import {
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

describe('setup / teardown across Vitest projects', () => {
  let saved: { id: string | undefined; tmp: string | undefined };

  beforeEach(() => {
    saved = { id: process.env[TEST_RUN_ID_ENV], tmp: process.env.TMPDIR };
  });

  afterEach(() => {
    // A failed assertion can leave the shared run open; close it so its run
    // temp dir is deleted.
    while ((globalThis as Record<symbol, unknown>)[Symbol.for('kookr.test-run-id.global')]) teardown();
    for (const [key, value] of [[TEST_RUN_ID_ENV, saved.id], ['TMPDIR', saved.tmp]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    expect(process.env.TMPDIR).toBe(saved.tmp);
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
