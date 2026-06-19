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
 * kill list. On platforms without `/proc` (macOS/BSD) the snapshot is taken from
 * a single `ps` call instead; it degrades to just the root pid only if neither
 * `/proc` nor `ps` is available.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

/** Default grace period between the SIGTERM sweep and the SIGKILL sweep. */
const DEFAULT_GRACE_MS = 10_000;

/**
 * Read `/proc` once and return a pid → ppid map. Falls back to a single `ps`
 * call on platforms without `/proc` (e.g. macOS) so the tree reap still works
 * there; returns an empty map only if neither source is available.
 */
function readProcParentMap(): Map<number, number> {
  const map = new Map<number, number>();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return readPsParentMap(); // no /proc — fall back to `ps` (macOS/BSD).
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      // /proc/<pid>/stat: "<pid> (<comm>) <state> <ppid> …". `comm` can contain
      // spaces and parens, so parse the fields AFTER the final ')'.
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const rparen = stat.lastIndexOf(')');
      if (rparen < 0) continue;
      const fields = stat.slice(rparen + 2).split(' ');
      // fields[0] = state, fields[1] = ppid
      const ppid = Number(fields[1]);
      if (Number.isInteger(ppid)) map.set(pid, ppid);
    } catch {
      // Process exited between readdir and read — skip it.
    }
  }
  return map;
}

/**
 * macOS/BSD fallback for `readProcParentMap`: a single `ps -axo pid=,ppid=`
 * yields the whole pid → ppid table without spawning a process per pid. Returns
 * an empty map if `ps` is unavailable, degrading callers to single-pid reap.
 */
function readPsParentMap(): Map<number, number> {
  const map = new Map<number, number>();
  let out: string;
  try {
    out = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' });
  } catch {
    return map; // no `ps` — degrade to single-pid behavior.
  }
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) map.set(pid, ppid);
  }
  return map;
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
