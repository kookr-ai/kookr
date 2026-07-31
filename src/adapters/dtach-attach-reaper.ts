/**
 * Stale `dtach -a` attach-client reaper (issue #1720, leak class 3).
 *
 * `LocalDtachBackend` spawns one persistent internal attach child per session
 * (`dtach -a <sock> -E`, see `local-dtach-stream.ts`) as a DIRECT child of the
 * Kookr node process — it is not detached via `setsid`. When Kookr restarts
 * without a graceful shutdown (crash, OOM-kill), that attach child is
 * reparented to init instead of dying with its parent, and — because it
 * (like the agent processes in `process-tree.ts`) does not react to the
 * closing pty — it can linger indefinitely. The 2026-07-30 follow-up audit
 * found ~12 such attach clients aged 1-8 days, each pointing at a socket
 * whose master (and often the whole dead server generation) was long gone.
 *
 * This is boot-only by design (see `server/session-reaper.ts`): a live
 * server's own attach children are exactly as many as its live sessions, so
 * there is nothing to sweep mid-run; the leak can only accumulate across
 * restarts.
 *
 * Detection is intentionally conservative and scoped: only `dtach -a`
 * processes whose command line references a socket path under THIS Kookr
 * instance's own socket directory (`/tmp/kookr-dtach/<uid>/port-<port>/`) are
 * even considered — a user's own unrelated terminal multiplexer session, or
 * another Kookr instance's port, is never touched. Of those, only ones whose
 * target socket file no longer exists on disk are reaped: a present socket
 * means either a live master (this attach is legitimately in use) or, at
 * worst, an attach racing a socket that is about to be removed by the
 * orphan-session sweep — leaving it alone here is the conservative choice.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { escalateKill, realProcessSignaler, type ProcessSignaler } from './process-signal-escalation.js';

export interface ProcessTableEntry {
  pid: number;
  /** Full command line, whitespace-joined (platform-appropriate best-effort tokenization). */
  command: string;
}

export interface StaleDtachAttacher {
  pid: number;
  sock: string;
}

/**
 * Best-effort extraction of the `-a <sock>` argument from a `dtach -a <sock>
 * -E` command line, restricted to sockets under `instanceDir`. Returns `null`
 * when no such token is present.
 */
function extractInstanceSocketPath(command: string, instanceDir: string): string | null {
  for (const token of command.split(/\s+/)) {
    if (token.startsWith(instanceDir) && token.endsWith('.sock')) return token;
  }
  return null;
}

/**
 * Identify stale `dtach -a` attach-client processes scoped to `instanceDir`
 * whose target socket no longer exists. Pure: takes an already-collected
 * process table and an injected socket-existence check, performs no I/O
 * itself — see {@link reapStaleDtachAttachers} for the acting version.
 */
export function findStaleDtachAttachers(
  instanceDir: string,
  entries: ProcessTableEntry[],
  socketExists: (sock: string) => boolean,
): StaleDtachAttacher[] {
  const out: StaleDtachAttacher[] = [];
  for (const entry of entries) {
    if (!entry.command.includes('dtach')) continue;
    if (!/(^|\s)-a(\s|$)/.test(entry.command)) continue;
    if (!entry.command.includes(instanceDir)) continue;
    const sock = extractInstanceSocketPath(entry.command, instanceDir);
    if (!sock) continue;
    if (socketExists(sock)) continue; // socket still present — a live attach, not stale.
    out.push({ pid: entry.pid, sock });
  }
  return out;
}

export interface ReapStaleDtachAttachersDeps {
  listProcesses: () => ProcessTableEntry[];
  socketExists: (sock: string) => boolean;
  signaler?: ProcessSignaler;
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Find and TERM->grace->KILL every stale `dtach -a` attach client scoped to
 * `instanceDir`. Returns the list of processes that were reaped (empty when
 * none were found). Never throws for an individual signal failure — the
 * injected {@link ProcessSignaler} (default {@link realProcessSignaler})
 * swallows "already gone" errors, matching `process-tree.ts`'s convention.
 */
export async function reapStaleDtachAttachers(
  instanceDir: string,
  deps: ReapStaleDtachAttachersDeps,
): Promise<StaleDtachAttacher[]> {
  const entries = deps.listProcesses();
  const stale = findStaleDtachAttachers(instanceDir, entries, deps.socketExists);
  if (stale.length === 0) return stale;
  await escalateKill(
    stale.map((s) => s.pid),
    { graceMs: deps.graceMs, sleep: deps.sleep, signaler: deps.signaler ?? realProcessSignaler },
  );
  return stale;
}

function readProcCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const command = raw.split('\0').filter(Boolean).join(' ');
    return command.length > 0 ? command : null;
  } catch {
    return null; // process exited between readdir and read, or unreadable — skip.
  }
}

function listLinuxProcesses(): ProcessTableEntry[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return []; // no /proc — non-Linux or sandboxed.
  }
  const out: ProcessTableEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const command = readProcCmdline(Number(name));
    if (command) out.push({ pid: Number(name), command });
  }
  return out;
}

function listDarwinProcesses(): ProcessTableEntry[] {
  try {
    const raw = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8', timeout: 5_000 });
    const out: ProcessTableEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const spaceIdx = trimmed.indexOf(' ');
      if (spaceIdx === -1) continue;
      const pid = Number(trimmed.slice(0, spaceIdx));
      const command = trimmed.slice(spaceIdx + 1).trim();
      if (!Number.isInteger(pid) || !command) continue;
      out.push({ pid, command });
    }
    return out;
  } catch {
    return [];
  }
}

/** Real (non-test) process table listing: `/proc` on Linux, `ps` on macOS. */
export function listRealProcesses(): ProcessTableEntry[] {
  return process.platform === 'darwin' ? listDarwinProcesses() : listLinuxProcesses();
}
