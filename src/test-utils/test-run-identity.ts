/**
 * Which Vitest run owns a leftover test process (issue #4109).
 *
 * Several agents run the test suite on one host at the same time. Each run's
 * global teardown sweeps leftover test relays and dtach masters. Before this
 * module, the sweep selected them by a host-wide fingerprint, so the run that
 * finished first killed processes another run was still using.
 *
 * Now each run gets an id when it starts (`test/test-run-id.global.ts`):
 * - The id is stored in the {@link TEST_RUN_ID_ENV} environment variable of the
 *   Vitest main process. Workers and every process they spawn inherit it, so it
 *   shows up in `/proc/<pid>/environ`.
 * - On Linux the run also gets its own temp directory, `<tmp>/kvr-<id>/`, and
 *   `TMPDIR` points at it. Socket paths built from `os.tmpdir()` then carry the
 *   id in the command line, which identifies a dtach master even when it was
 *   spawned with a replaced (non-inherited) environment.
 *
 * A teardown reaps a process in two cases:
 * - It belongs to the current run.
 * - It is a true orphan: older than {@link TEST_ORPHAN_MIN_AGE_MS}, and either
 *   it carries no run id at all, or the Vitest process that owns its run id
 *   has exited. The id embeds that process's pid for this check.
 *
 * A process owned by another run whose Vitest process is still alive is never
 * touched, however old it is.
 *
 * This file only decides. The reapers list processes and send the signals.
 */
import { randomBytes } from 'node:crypto';

/**
 * Environment variable carrying the run id. Deliberately not `KOOKR_`-prefixed:
 * `test/setup-env.ts` deletes every non-allowlisted `KOOKR_*` key in each
 * worker, which would strip the id before tests spawn anything.
 */
export const TEST_RUN_ID_ENV = 'VITEST_KOOKR_RUN_ID';

/** Basename prefix of a run's temp directory: `<tmp>/kvr-<run id>`. */
export const TEST_RUN_TMPDIR_PREFIX = 'kvr-';

/**
 * Minimum age before a test process that no live run owns is reaped as an
 * orphan. Longer than any realistic full-suite run on a loaded host, so a
 * process from a run that predates run ids (an older checkout on the same
 * host, still in progress) is not killed under it.
 */
export const TEST_ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/** `<owner pid>-<6 hex chars>`. */
const RUN_ID_PATTERN = /^(\d+)-[0-9a-f]{6}$/;

/** A run-id directory segment anywhere in a command line or path. */
const RUN_DIR_SEGMENT = new RegExp(`/${TEST_RUN_TMPDIR_PREFIX}(\\d+-[0-9a-f]{6})(?=/|\\s|$)`, 'g');

/** Mint a fresh run id owned by `ownerPid` (the Vitest main process). */
export function mintTestRunId(
  ownerPid: number = process.pid,
  random: string = randomBytes(3).toString('hex'),
): string {
  return `${ownerPid}-${random}`;
}

/** True when `id` has the shape {@link mintTestRunId} produces. */
export function isTestRunId(id: string | null | undefined): id is string {
  return typeof id === 'string' && RUN_ID_PATTERN.test(id);
}

/** Pid of the Vitest main process that owns `runId`, or null when malformed. */
export function ownerPidOfTestRunId(runId: string): number | null {
  const match = RUN_ID_PATTERN.exec(runId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** The run id a process inherited, or null when it carries none. */
export function testRunIdFromEnviron(env: Record<string, string> | null): string | null {
  const id = env?.[TEST_RUN_ID_ENV];
  return isTestRunId(id) ? id : null;
}

/**
 * The run id named by a `/kvr-<id>/` segment in `text`, or null. When there are
 * several, the last one (the innermost directory) names the owner.
 */
export function testRunIdFromPath(text: string): string | null {
  let id: string | null = null;
  for (const match of text.matchAll(RUN_DIR_SEGMENT)) id = match[1] ?? id;
  return id;
}

/**
 * True when `pid` exists. `EPERM` means it exists under another user. A
 * recycled pid also reads as alive, which errs towards not reaping.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type TestProcessVerdict = 'current-run' | 'orphan' | 'keep';

export interface TestProcessOwnershipInput {
  /** Run id the process carries (environ or socket path), or null. */
  ownerRunId: string | null;
  /** Run id of the teardown that is deciding, or null when it has none. */
  currentRunId: string | null;
  /** Process start time (ms since epoch), or null when unknown. */
  startTimeMs: number | null;
  now: number;
  isPidAlive?: (pid: number) => boolean;
  minOrphanAgeMs?: number;
}

/**
 * Decide whether a teardown may reap one test process. The caller has already
 * established that the process is a test relay or a test dtach session.
 *
 * An unknown start time never counts as old, so it can only be reaped as
 * belonging to the current run.
 */
export function classifyTestProcessOwnership(input: TestProcessOwnershipInput): TestProcessVerdict {
  const { ownerRunId, currentRunId, startTimeMs, now } = input;
  if (ownerRunId !== null && ownerRunId === currentRunId) return 'current-run';

  if (ownerRunId !== null) {
    const ownerPid = ownerPidOfTestRunId(ownerRunId);
    const alive = input.isPidAlive ?? isPidAlive;
    if (ownerPid === null || alive(ownerPid)) return 'keep';
  }

  if (startTimeMs === null) return 'keep';
  const minAge = input.minOrphanAgeMs ?? TEST_ORPHAN_MIN_AGE_MS;
  return now - startTimeMs >= minAge ? 'orphan' : 'keep';
}

/** Run id of the current Vitest run, read from `env`, or null. */
export function currentTestRunId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env[TEST_RUN_ID_ENV];
  return isTestRunId(id) ? id : null;
}
