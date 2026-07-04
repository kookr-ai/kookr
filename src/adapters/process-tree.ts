/**
 * Process-tree reaping.
 *
 * Kookr spawns each agent as `setsid -f dtach -n <sock> -E <agent> …`. dtach
 * forks the agent into its OWN session (it calls `setsid()` so it can own the
 * pty), so the agent process (`claude` / `codex`) ends up in a different
 * session/process group than the dtach master — it is only linked to the
 * master by the parent/child edge.
 *
 * That has a sharp consequence: killing the dtach master pid alone does NOT
 * take the agent down. `claude`/`codex` (and the node runtime under them)
 * ignore the SIGHUP that the closing pty would deliver, so the agent is
 * reparented to init and survives indefinitely — the leak in kookr-ai/kookr#784
 * (agent procs observed alive 2 days after their task reached a terminal
 * state). The fix is to reap the master together with its whole descendant
 * tree.
 *
 * The descendant set is snapshotted from `/proc` BEFORE any signal is sent, so
 * children that reparent to init the instant their parent dies are still in the
 * kill list. On platforms without `/proc` (macOS) the snapshot degrades to just
 * the root pid — no worse than the previous master-only behavior.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** Default grace period between the SIGTERM sweep and the SIGKILL sweep. */
const DEFAULT_GRACE_MS = 10_000;

/**
 * Split the whitespace-separated fields of a `/proc/<pid>/stat` line that
 * follow the `comm` field. `comm` is wrapped in parens and can itself contain
 * spaces and parens, so we split only the remainder after the FINAL ')'. The
 * returned array is 0-indexed from `state` (stat field 3), i.e.
 * `fields[0]` = state, `fields[1]` = ppid, `fields[19]` = starttime. Returns
 * `null` when the line has no ')' (unparseable).
 */
function parseProcStatFields(stat: string): string[] | null {
  const rparen = stat.lastIndexOf(')');
  if (rparen < 0) return null;
  return stat.slice(rparen + 2).split(' ');
}

/**
 * Read `/proc` once and return a pid → ppid map. Returns an empty map on any
 * platform where `/proc` is unavailable (e.g. macOS) so callers degrade to
 * single-pid behavior rather than throwing.
 */
function readProcParentMap(): Map<number, number> {
  const map = new Map<number, number>();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return map; // no /proc — non-Linux or sandboxed.
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const fields = parseProcStatFields(stat);
      if (!fields) continue;
      const ppid = Number(fields[1]);
      if (Number.isInteger(ppid)) map.set(pid, ppid);
    } catch {
      // Process exited between readdir and read — skip it.
    }
  }
  return map;
}

/**
 * `USER_HZ` — the unit of the `starttime` field in `/proc/<pid>/stat`. This is
 * fixed at 100 on every mainstream Linux architecture (x86, x86_64, arm,
 * arm64) and, crucially, is DECOUPLED from the kernel's `CONFIG_HZ` timer rate:
 * the kernel always exports clock-tick counts to userspace in `USER_HZ` units
 * regardless of its internal tick rate. Hardcoding 100 is therefore correct
 * without a `sysconf(_SC_CLK_TCK)` call (which Node does not expose).
 */
const USER_HZ = 100;

/** Read the system boot time (ms since epoch) from `/proc/stat` `btime`. */
function readLinuxBootTimeMs(): number | null {
  try {
    const stat = readFileSync('/proc/stat', 'utf-8');
    const match = stat.match(/^btime\s+(\d+)/m);
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** macOS start-time via `ps -o lstart=`, which prints a parseable wall clock. */
function readDarwinStartTimeMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    if (!out) return null;
    const ms = Date.parse(out);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null; // no such pid, or ps unavailable.
  }
}

/**
 * Best-effort OS process start time as wall-clock ms since epoch, or `null`
 * when it cannot be determined (unsupported platform, process gone,
 * unparseable stat, unknown boot time, or an implausible result).
 *
 * Linux: `boot time + starttime_ticks / USER_HZ` from `/proc`. macOS:
 * `ps -o lstart=`. The value is deliberately coarse (`btime` is whole-second
 * granularity), so callers must treat sub-second differences as noise.
 *
 * Used to distinguish an original PID holder from an unrelated live process
 * that merely reused a recycled PID: the reused process necessarily started
 * AFTER the recorded event, whereas the original started before it.
 */
export function readProcessStartTimeMs(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'darwin') return readDarwinStartTimeMs(pid);
  if (process.platform !== 'linux') return null;

  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return null; // process gone or /proc unavailable.
  }
  const fields = parseProcStatFields(stat);
  if (!fields) return null;
  const starttimeTicks = Number(fields[19]); // stat field 22.
  if (!Number.isFinite(starttimeTicks) || starttimeTicks < 0) return null;
  const bootMs = readLinuxBootTimeMs();
  if (bootMs === null) return null;

  const startMs = Math.floor(bootMs + (starttimeTicks / USER_HZ) * 1000);
  // Defensive: a process cannot have started in the future. If the arithmetic
  // says otherwise (bad btime / unexpected USER_HZ), report "unknown" so
  // callers degrade to their fallback instead of a false PID-recycle verdict.
  if (startMs > Date.now() + 60_000) return null;
  return startMs;
}

/**
 * Return `rootPid` plus every transitive descendant, snapshotted from `/proc`.
 * The root is always included (first element). On a platform without `/proc`
 * the result is just `[rootPid]`.
 */
export function collectProcessTree(rootPid: number): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  const parent = readProcParentMap();
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parent) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue; // guards against a corrupt ppid cycle
    seen.add(pid);
    out.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return out;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone, or not ours — nothing to do.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface KillProcessTreeOptions {
  /** Time to wait after SIGTERM before escalating to SIGKILL. Default 10 s. */
  graceMs?: number;
}

/**
 * Force-terminate `rootPid` and all of its descendants: SIGTERM the whole
 * snapshotted tree, wait up to `graceMs` for it to drain, then SIGKILL any
 * survivors.
 *
 * Used to reap a dtach master together with the agent process it hosts — the
 * agent lives in its own session/process group, so signalling the master alone
 * leaks it (kookr-ai/kookr#784).
 *
 * Refuses to act on pids ≤ 1 so a corrupt/unset pid can never escalate into
 * "kill init" or a stray negative-pid process-group signal.
 *
 * Known limitations (both narrow, and no worse than the prior master-only
 * kill): the tree is snapshotted once, so a process the agent forks AFTER the
 * snapshot but before it dies is not in the kill list; and a snapshotted pid
 * that exits during the grace window could in principle be recycled before the
 * SIGKILL sweep. Re-deriving the tree after SIGTERM does not help — once the
 * root (dtach master) dies its children reparent to init and are no longer its
 * descendants — so the snapshot-before-signal approach is the pragmatic choice
 * for the reported leak (master + the agent and its children that exist at
 * terminal-state time).
 */
export async function killProcessTree(
  rootPid: number,
  options: KillProcessTreeOptions = {},
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const pids = collectProcessTree(rootPid);
  if (pids.length === 0) return;

  for (const pid of pids) signal(pid, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pids.some(isAlive)) return;
    await sleep(250);
  }

  for (const pid of pids) {
    if (isAlive(pid)) signal(pid, 'SIGKILL');
  }
}
