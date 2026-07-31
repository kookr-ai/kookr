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
 *
 * Linux-only (`/proc`); degrades to a no-op elsewhere.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { killProcessTree } from '../adapters/process-tree.js';

/**
 * mkdtemp prefixes used by dtach-spawning tests. Matched as path segments so
 * `/tmp/tsc-abc` and `/var/folders/.../T/ldb-test-xyz` both hit. Keep this list
 * in sync with the prefixes in:
 * - `src/server/terminal-input-coordinator.test.ts` (`tsc-`)
 * - `src/adapters/local-dtach-backend.test.ts` (`ldb-test-`, `ldb-mac-sim-`)
 * - `src/server/session-reaper-dtach-integration.test.ts` (`kookr-session-reaper-it-`)
 */
export const TEST_DTACH_DIR_MARKERS = [
  '/tsc-',
  '/ldb-test-',
  '/ldb-mac-sim-',
  '/kookr-session-reaper-it-',
] as const;

/** Production instance socket root — never reap masters under this path. */
const PROD_DTACH_MARKER = '/kookr-dtach/';

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

/**
 * Pids of lingering test-suite dtach masters/attachers (any known test socket
 * prefix). Used by the suite-wide globalSetup reaper as a safety net for
 * files that forgot a per-dir afterEach, or for mid-run crashes.
 */
export function findLingeringTestDtachPids(
  list: () => Iterable<CmdlinePid> = listProcCmdlines,
): number[] {
  const targets: number[] = [];
  for (const { pid, cmdline } of list()) {
    if (isTestSuiteDtachCmdline(cmdline)) targets.push(pid);
  }
  return targets;
}

/**
 * Reap every lingering test-suite dtach process. Returns the pids targeted
 * (whether or not they were still alive after the kill). Best-effort: never
 * throws on individual kill failures.
 */
export async function reapLingeringTestDtachMasters(
  options: { graceMs?: number; list?: () => Iterable<CmdlinePid> } = {},
): Promise<number[]> {
  const targets = findLingeringTestDtachPids(options.list ?? listProcCmdlines);
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
