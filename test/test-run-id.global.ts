// Vitest globalSetup: give this test run an id (issue #4109).
//
// Registered FIRST in vitest.config.mts `globalSetup`, so its setup runs before
// the reapers' and its teardown runs after theirs (Vitest tears down in reverse
// order).
//
// The first setup() in a Vitest process always mints a fresh id, even when the
// environment already carries one: a Vitest run started by a test inherits its
// parent's environment, and reusing the parent's id would let the nested run's
// teardown reap the parent's live processes.
//
// The id goes into two places that the processes of this run inherit:
// - `VITEST_KOOKR_RUN_ID` in the main process's environment. Vitest workers
//   are created after globalSetup, so they and everything they spawn inherit it.
// - On Linux, a run temp directory `<tmp>/kvr-<id>/` that `TMPDIR` points at,
//   so `os.tmpdir()`-based socket paths name the run in a dtach command line.
//   Skipped elsewhere: the reapers only run on Linux, and macOS socket paths
//   under /var/folders have no `sun_path` budget to spare.
//
// The relay and dtach reapers read the id through
// `src/test-utils/test-run-identity.ts`. teardown() restores `TMPDIR` and
// deletes the run temp directory, so what tests leave in `os.tmpdir()` no
// longer accumulates in /tmp.
//
// A Vitest process that is killed or crashes never reaches teardown(), so its
// run temp directory would stay forever. The first setup() therefore also
// sweeps sibling run temp directories left by dead runs (issue #4123), with the
// same rule the reapers apply to processes: the owner pid embedded in the id
// has exited AND the directory is older than the orphan threshold. Other test
// runs on the host may be live, so a directory whose owner is alive is never
// touched, and any error leaves the directory in place.

import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  TEST_RUN_ID_ENV,
  TEST_RUN_TMPDIR_PREFIX,
  classifyTestProcessOwnership,
  isTestRunId,
  mintTestRunId,
} from '../src/test-utils/test-run-identity.js';

export interface TestRunState {
  runId: string;
  /** The run temp directory, or null when none was created. */
  runTmpDir: string | null;
  previousRunId: string | undefined;
  previousTmpDir: string | undefined;
}

export interface StartTestRunOptions {
  platform?: NodeJS.Platform;
  /** Directory to create the run temp directory in (default: `env.TMPDIR`, else `os.tmpdir()`). */
  baseTmpDir?: string;
  runId?: string;
  /** Passed to {@link sweepDeadRunTmpDirs}; for tests. */
  sweep?: Omit<SweepDeadRunTmpDirsOptions, 'ownRunId'>;
}

export interface SweepDeadRunTmpDirsOptions {
  /** Run id of the caller. Its directory is never removed. */
  ownRunId: string;
  now?: number;
  isPidAlive?: (pid: number) => boolean;
  /** Default: `TEST_ORPHAN_MIN_AGE_MS`, the reapers' threshold. */
  minAgeMs?: number;
}

/**
 * Remove the run temp directories in `base` that a dead run left behind: the
 * Vitest process named by the id has exited, and the directory has not changed
 * for the orphan threshold. Its modification time is used as its age, which
 * never reads older than the directory really is. A recycled pid reads as
 * alive, which keeps the directory longer. Never throws: a directory another
 * run's sweep removes first, or one that cannot be read or removed, is skipped.
 *
 * Returns the paths it removed.
 */
export function sweepDeadRunTmpDirs(base: string, options: SweepDeadRunTmpDirsOptions): string[] {
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith(TEST_RUN_TMPDIR_PREFIX)) continue;
    const runId = name.slice(TEST_RUN_TMPDIR_PREFIX.length);
    if (!isTestRunId(runId) || runId === options.ownRunId) continue;
    const dir = join(base, name);
    let mtimeMs: number;
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory()) continue;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    const verdict = classifyTestProcessOwnership({
      ownerRunId: runId,
      currentRunId: options.ownRunId,
      startTimeMs: mtimeMs,
      now,
      isPidAlive: options.isPidAlive,
      minOrphanAgeMs: options.minAgeMs,
    });
    if (verdict !== 'orphan') continue;
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // best-effort: never fail setup over another run's leftovers
    }
  }
  return removed;
}

/**
 * Base for a new run temp directory. A nested run's `os.tmpdir()` is its
 * parent's run directory; climb out of it so paths do not grow per level.
 */
function runTmpBase(dir: string): string {
  const name = basename(dir);
  if (name.startsWith(TEST_RUN_TMPDIR_PREFIX) && isTestRunId(name.slice(TEST_RUN_TMPDIR_PREFIX.length))) {
    return dirname(dir);
  }
  return dir;
}

/** Mint a run id and publish it (and, on Linux, the run temp dir) in `env`. */
export function startTestRun(env: NodeJS.ProcessEnv, options: StartTestRunOptions = {}): TestRunState {
  const runId = options.runId ?? mintTestRunId();
  const state: TestRunState = {
    runId,
    runTmpDir: null,
    previousRunId: env[TEST_RUN_ID_ENV],
    previousTmpDir: env.TMPDIR,
  };
  env[TEST_RUN_ID_ENV] = runId;

  if ((options.platform ?? process.platform) === 'linux') {
    const base = runTmpBase(options.baseTmpDir || env.TMPDIR || tmpdir());
    sweepDeadRunTmpDirs(base, { ...options.sweep, ownRunId: runId });
    const dir = join(base, `${TEST_RUN_TMPDIR_PREFIX}${runId}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      state.runTmpDir = dir;
      env.TMPDIR = dir;
    } catch {
      // Keep the default temp dir. The environment id still scopes the reapers.
    }
  }
  return state;
}

function restoreEnvKey(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

/** Undo {@link startTestRun}: restore `env` and delete the run temp dir. */
export function endTestRun(env: NodeJS.ProcessEnv, state: TestRunState): void {
  restoreEnvKey(env, TEST_RUN_ID_ENV, state.previousRunId);
  if (state.runTmpDir === null) return;
  restoreEnvKey(env, 'TMPDIR', state.previousTmpDir);
  try {
    rmSync(state.runTmpDir, { recursive: true, force: true });
  } catch {
    // best-effort: never fail the run over temp cleanup
  }
}

// Vitest runs globalSetup once per project (unit, shared, serial, and the root
// project), each in its own module instance, and tears the projects down in
// reverse order after all tests. One id per Vitest process is shared through
// globalThis: the first setup mints it, the last teardown (after every
// project's reapers) restores the environment. A nested Vitest run is a
// different process, so it still mints its own id.
const SHARED_KEY = Symbol.for('kookr.test-run-id.global');

interface SharedRun {
  state: TestRunState;
  refs: number;
}

type SharedGlobal = typeof globalThis & { [SHARED_KEY]?: SharedRun };

export function setup(): void {
  const g = globalThis as SharedGlobal;
  const shared = g[SHARED_KEY];
  if (shared) {
    shared.refs += 1;
    return;
  }
  g[SHARED_KEY] = { state: startTestRun(process.env), refs: 1 };
}

export function teardown(): void {
  const g = globalThis as SharedGlobal;
  const shared = g[SHARED_KEY];
  if (!shared) return;
  shared.refs -= 1;
  if (shared.refs > 0) return;
  delete g[SHARED_KEY];
  endTestRun(process.env, shared.state);
}
