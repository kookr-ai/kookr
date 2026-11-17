/**
 * Shared test-suite dtach hygiene (issue #1738).
 *
 * dtach masters are spawned via `setsid` and survive the vitest worker process.
 * Per-file afterEach helpers that call `reapDtachReferencing(tmpDir)` fix the
 * known call sites, but any future test that forgets that convention leaks a
 * resident master + agent under `/tmp/tsc-*` (or similar mkdtemp prefixes)
 * indefinitely — the same class of leak production reaping fixes, but for the
 * test suite itself.
 *
 * This module is the single source of truth for:
 * 1. Dir-scoped reaping used by individual test afterEach hooks.
 * 2. Suite-wide classification of "this is a test-suite dtach, not prod" so
 *    the vitest globalSetup reaper (`test/dtach-master-reaper.global.ts`) can
 *    sweep stragglers without touching `/tmp/kookr-dtach/` production sockets.
 *    That sweep is scoped to the run that started the processes, plus true
 *    orphans selected by age (issue #4109, `test-run-identity.ts`).
 *
 * Linux-only (`/proc`); degrades to a no-op elsewhere.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { readProcessEnviron } from '../adapters/proc-process-lister.js';
import { killProcessTree, readProcessStartTimeMs } from '../adapters/process-tree.js';
import {
  classifyTestProcessOwnership,
  currentTestRunId,
  testRunIdFromEnviron,
  testRunIdFromPath,
} from './test-run-identity.js';

/**
 * mkdtemp prefixes used by dtach-spawning tests. Matched as path segments so
 * `/tmp/tsc-abc` and `/var/folders/.../T/ldb-test-xyz` both hit. Prefixes in use:
 * - `src/server/terminal-input-coordinator.test.ts` (`tsc-`)
 * - `src/adapters/local-dtach-backend.test.ts` (`ldb-mac-sim-`; `ldb-test-` is
 *   only for checkouts older than kookr-ai/kookr#3825)
 * - `src/server/session-reaper-dtach-integration.test.ts` (`kookr-session-reaper-it-`)
 *
 * These markers only identify dtach sessions that carry no run id, which the
 * global teardown reaps once they are older than the orphan age threshold
 * (issue #4109). A session that carries a run id is reaped by its own run's
 * teardown whatever its prefix. Do NOT add `local-dtach-backend.test.ts`'s
 * session prefix (`ldb-case-`) here: before #4109 every teardown on the host
 * killed every match, including live sessions of other runs, which made that
 * file flake under load (#3825). A guard test in that file still fails if a
 * marker here starts matching its prefix.
 */
export const TEST_DTACH_DIR_MARKERS = [
  '/tsc-',
  '/ldb-test-',
  '/ldb-mac-sim-',
  '/kookr-session-reaper-it-',
] as const;

/** Production instance socket root — never reap masters under this path. */
const PROD_DTACH_MARKER = '/kookr-dtach/';

/**
 * A `dtach` executable followed by a mode flag (`dtach -n …`, `/x/dtach -a …`),
 * so a process that only mentions dtach in a path or a file name is not taken
 * for a session.
 */
const DTACH_INVOCATION = /(?:^|[\s/])dtach\s+-[A-Za-z]\b/;

export interface CmdlinePid {
  pid: number;
  cmdline: string;
}

/**
 * True when a process cmdline is a dtach master/attacher whose socket path
 * lives under a known test mkdtemp prefix, and is not a production Kookr
 * instance socket under `/tmp/kookr-dtach/`.
 */
export function isTestSuiteDtachCmdline(cmdline: string): boolean {
  if (!cmdline.includes('dtach')) return false;
  if (cmdline.includes(PROD_DTACH_MARKER)) return false;
  return TEST_DTACH_DIR_MARKERS.some((marker) => cmdline.includes(marker));
}

/**
 * Snapshot every `/proc/<pid>/cmdline` as `{pid, cmdline}`. Empty when `/proc`
 * is unavailable (macOS / sandbox). Injected into pure finders for unit tests.
 */
export function listProcCmdlines(): CmdlinePid[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  const out: CmdlinePid[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8').replace(/\0/g, ' ');
      if (!cmdline) continue;
      out.push({ pid: Number(name), cmdline });
    } catch {
      // process exited between readdir and read — skip
    }
  }
  return out;
}

/**
 * Pids of any process whose cmdline contains both `dtach` and `dir` (typically
 * a test's mkdtemp socketDir). Used by per-file afterEach so cleanup is scoped
 * to the sessions that test created.
 */
export function findDtachPidsReferencing(
  dir: string,
  list: () => Iterable<CmdlinePid> = listProcCmdlines,
): number[] {
  if (!dir) return [];
  const targets: number[] = [];
  for (const { pid, cmdline } of list()) {
    if (cmdline.includes('dtach') && cmdline.includes(dir)) targets.push(pid);
  }
  return targets;
}

/**
 * Reap any dtach masters (and the agent/shell children they host) whose
 * command line references `dir`. Mirrors the historical per-file helper in
 * `local-dtach-backend.test.ts` / `session-reaper-dtach-integration.test.ts`.
 */
export async function reapDtachReferencing(
  dir: string,
  options: { graceMs?: number; list?: () => Iterable<CmdlinePid> } = {},
): Promise<number[]> {
  const targets = findDtachPidsReferencing(dir, options.list ?? listProcCmdlines);
  const graceMs = options.graceMs ?? 2_000;
  for (const pid of targets) {
    await killProcessTree(pid, { graceMs });
  }
  return targets;
}

export interface LingeringTestDtachOptions {
  list?: () => Iterable<CmdlinePid>;
  /** Run id of the teardown that is sweeping (default: from `process.env`). */
  runId?: string | null;
  readEnviron?: (pid: number) => Record<string, string> | null;
  readStartTimeMs?: (pid: number) => number | null;
  isPidAlive?: (pid: number) => boolean;
  now?: number;
  minOrphanAgeMs?: number;
  /** Never selected (default: this process). */
  selfPid?: number;
}

/**
 * Pids of lingering test-suite dtach masters/attachers that this teardown may
 * reap (issue #4109): those started by the current run, plus true orphans.
 *
 * A dtach process's run id comes from its environment, or else from a
 * `/kvr-<id>/` segment of its socket path. One carrying no run id is a test
 * process only if its socket path matches a {@link TEST_DTACH_DIR_MARKERS}
 * prefix, and is then reaped only by age. Production sockets under
 * `/tmp/kookr-dtach/` are never selected. See `test-run-identity.ts` for the
 * ownership rules.
 */
export function findLingeringTestDtachPids(options: LingeringTestDtachOptions = {}): number[] {
  const list = options.list ?? listProcCmdlines;
  const readEnviron = options.readEnviron ?? readProcessEnviron;
  const readStartTimeMs = options.readStartTimeMs ?? readProcessStartTimeMs;
  const currentRunId = options.runId === undefined ? currentTestRunId() : options.runId;
  const now = options.now ?? Date.now();
  const selfPid = options.selfPid ?? process.pid;

  const targets: number[] = [];
  for (const { pid, cmdline } of list()) {
    if (pid === selfPid) continue;
    if (!DTACH_INVOCATION.test(cmdline) || cmdline.includes(PROD_DTACH_MARKER)) continue;
    const ownerRunId = testRunIdFromEnviron(readEnviron(pid)) ?? testRunIdFromPath(cmdline);
    if (ownerRunId === null && !isTestSuiteDtachCmdline(cmdline)) continue;
    const verdict = classifyTestProcessOwnership({
      ownerRunId,
      currentRunId,
      startTimeMs: readStartTimeMs(pid),
      now,
      isPidAlive: options.isPidAlive,
      minOrphanAgeMs: options.minOrphanAgeMs,
    });
    if (verdict !== 'keep') targets.push(pid);
  }
  return targets;
}

/**
 * Reap every lingering test-suite dtach process this teardown may reap (see
 * {@link findLingeringTestDtachPids}). Returns the pids targeted (whether or
 * not they were still alive after the kill). Best-effort: never throws on
 * individual kill failures.
 */
export async function reapLingeringTestDtachMasters(
  options: LingeringTestDtachOptions & { graceMs?: number } = {},
): Promise<number[]> {
  const targets = findLingeringTestDtachPids(options);
  const graceMs = options.graceMs ?? 500;
  for (const pid of targets) {
    try {
      await killProcessTree(pid, { graceMs });
    } catch {
      // best-effort: a pid may have exited mid-loop
    }
  }
  return targets;
}
