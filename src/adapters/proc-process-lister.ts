/**
 * Issue #1723 / #1720: real `/proc` reader for the stale-process scanner.
 *
 * Produces a {@link ProcessSnapshot}[] with pid/ppid/cmdline/rss/startTime/cwd
 * by reading `/proc` directly (Linux only). On any platform without `/proc`
 * (macOS, sandbox) it returns an empty list so callers degrade to "nothing to
 * reap / nothing to report" rather than throwing.
 *
 * Kept out of `src/core/orphan-process-scanner.ts` so the classification and
 * reap-selection logic there stays pure and unit-testable.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

import type { ProcessSnapshot } from '../core/orphan-process-scanner.js';

/** Page size in bytes for `/proc/<pid>/statm` RSS (field 2, in pages). */
const PAGE_SIZE_BYTES = 4096;

/**
 * `USER_HZ` — unit of the `starttime` field in `/proc/<pid>/stat`. Fixed at 100
 * on every mainstream Linux arch and decoupled from the kernel's CONFIG_HZ (see
 * the same constant in process-tree.ts).
 */
const USER_HZ = 100;

/**
 * Split the `/proc/<pid>/stat` fields that follow `comm`. `comm` is
 * paren-wrapped and may contain spaces/parens, so we split only after the final
 * ')'; the result is 0-indexed from `state`, so `fields[1]` is the ppid and
 * `fields[19]` is the starttime (stat field 22). Returns null when unparseable.
 */
function parseProcStatFields(stat: string): string[] | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  return stat.slice(rparen + 2).split(' ');
}

/** System boot time (ms since epoch) from `/proc/stat` `btime`, read ONCE. */
function readBootTimeMs(): number | null {
  try {
    const match = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Wall-clock start time (ms) from a pre-parsed stat field set + a boot time read
 * once per scan — avoids re-reading `/proc/stat` per process (issue #1723
 * review). Returns null when the boot time or starttime is unknown/implausible.
 */
function computeStartTimeMs(fields: string[], bootMs: number | null): number | null {
  if (bootMs === null) return null;
  const starttimeTicks = Number(fields[19]); // stat field 22
  if (!Number.isFinite(starttimeTicks) || starttimeTicks < 0) return null;
  const startMs = Math.floor(bootMs + (starttimeTicks / USER_HZ) * 1000);
  return startMs > Date.now() + 60_000 ? null : startMs;
}

/** RSS in bytes from `/proc/<pid>/statm` (field 2 = resident pages). */
function readRssBytes(pid: number): number {
  try {
    const statm = readFileSync(`/proc/${pid}/statm`, 'utf8');
    const residentPages = Number.parseInt(statm.trim().split(' ')[1] ?? '', 10);
    return Number.isFinite(residentPages) ? residentPages * PAGE_SIZE_BYTES : 0;
  } catch {
    return 0;
  }
}

/** Command line from `/proc/<pid>/cmdline` (NUL-separated argv → spaces). */
function readCmdline(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/** Resolved working directory from `/proc/<pid>/cwd`, or null when unreadable. */
function readCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Read `/proc/<pid>/environ` (NUL-separated `KEY=VALUE`) into a map, or null
 * when unreadable (process gone, permission, non-Linux). Used to identify
 * test-suite-spawned relays by their `KOOKR_RELAY_DIE_WITH_PARENT` marker.
 */
export function readProcessEnviron(pid: number): Record<string, string> | null {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const env: Record<string, string> = {};
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq <= 0) continue;
      env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * Read a snapshot of every running process. Empty on non-Linux / no `/proc`.
 * Processes that exit mid-scan are skipped rather than throwing.
 */
export function listProcessSnapshots(): ProcessSnapshot[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return []; // no /proc — non-Linux or sandboxed.
  }
  const bootMs = readBootTimeMs(); // read once per scan, not per process
  const out: ProcessSnapshot[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue; // exited between readdir and read
    }
    const fields = parseProcStatFields(stat);
    if (!fields) continue;
    const ppid = Number.parseInt(fields[1] ?? '', 10);
    if (!Number.isInteger(ppid)) continue;
    const cmdline = readCmdline(pid);
    if (!cmdline) continue; // kernel threads / zombies have empty cmdline
    out.push({
      pid,
      ppid,
      cmdline,
      rssBytes: readRssBytes(pid),
      startTimeMs: computeStartTimeMs(fields, bootMs),
      cwd: readCwd(pid),
    });
  }
  return out;
}
