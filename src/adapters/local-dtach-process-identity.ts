/**
 * Process-identity helpers for LocalDtachBackend (pid/socket ownership).
 *
 * Pure-ish functions taking `dtachBinary` (and related params) rather than
 * class instance state. Split from local-dtach-backend.ts (kookr-ai/kookr#1465).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import type { DtachManifestEntry } from './dtach-manifest-store.js';

/**
 * Verify a manifest entry's pid is actually our dtach master, not a
 * recycled pid that happens to be alive. Checks `/proc/<pid>/exe` resolves
 * to the dtach binary AND `/proc/<pid>/cmdline` contains the socket path.
 */
export function verifyEntryOwnership(entry: DtachManifestEntry, dtachBinary: string): boolean {
  const pid = entry.pid > 0 ? entry.pid : findDtachMasterPidSync(entry.sock, dtachBinary);
  return verifyMasterIdentity(pid, entry.sock, dtachBinary);
}

/**
 * Strict identity check for a dtach master `pid` + `sock` on Linux: the pid
 * is alive, its `/proc/<pid>/exe` resolves to a dtach binary, its cmdline
 * references `sock`, and the socket file exists. macOS has no `/proc`, so a
 * `ps` command-line check provides the equivalent identity guard there.
 * Returns false (not throw) when neither identity path can verify the session.
 */
export function verifyMasterIdentity(pid: number, sock: string, dtachBinary: string): boolean {
  if (!existsSync(sock)) return false;
  // A PID is required on every platform; macOS resolves it through `ps`
  // before reaching this check because it has no `/proc`.
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') {
    try {
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return command.includes(sock) && command.includes(dtachBinary);
    } catch {
      return false;
    }
  }

  const procDir = `/proc/${pid}`;
  try {
    const exe = readlinkSync(`${procDir}/exe`);
    const exeBase = exe.split('/').pop() ?? '';
    if (!exeBase.includes('dtach')) return false;
  } catch {
    // /proc unreadable — treat as unverified.
    return false;
  }
  try {
    const cmdline = readFileSync(`${procDir}/cmdline`, 'utf-8').replace(/\0/g, ' ');
    if (!cmdline.includes(sock)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Best-effort resolution of the agent (claude/codex) pid hosted under a dtach
 * master via a `/proc` ppid scan. dtach forks the agent as its direct child
 * (in a new session), so the agent is the process whose PPid is the master.
 * Returns null off Linux or when no such child exists. Reported by
 * `reconnectTransport` so an operator can confirm the agent pid is unchanged.
 */
export function findAgentPidSync(masterPid: number): number | null {
  if (masterPid <= 0) return null;
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return null; // no /proc (non-Linux).
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf-8');
    } catch {
      continue; // exited between readdir and read.
    }
    // `comm` (field 2) is paren-wrapped and may contain spaces/parens; PPid
    // is the field right after the final ')'.
    const rparen = stat.lastIndexOf(')');
    if (rparen < 0) continue;
    const ppid = Number(stat.slice(rparen + 2).split(' ')[1]);
    if (ppid === masterPid) return Number(name);
  }
  return null;
}

export async function findDtachMasterPid(sock: string, dtachBinary: string): Promise<number> {
  try {
    return findDtachMasterPidSync(sock, dtachBinary);
  } catch {
    return -1;
  }
}

/**
 * Resolve the dtach master pid for `sock` via a pure-Node `/proc` scan on
 * Linux and an argv-based `ps` query on macOS.
 *
 * The previous implementation shelled out to a per-pid bash loop over
 * `/proc/<pid>/cmdline` that piped `tr` into `grep`, spawning two
 * processes per pid. On a loaded host (hundreds of processes) that loop blew
 * past its 2 s timeout and returned -1, so the manifest pid was never
 * resolved — which made `killSession` a no-op and left the dtach master AND
 * its agent child resident. That unresolved-pid path was a primary driver of
 * the leak in kookr-ai/kookr#784. Reading the cmdline files directly is
 * allocation-light and spawns nothing, so it stays correct under load.
 *
 * Both the master (`dtach -n <sock> …`) and the read-side attach
 * (`dtach -a <sock> …`) carry the socket in their cmdline, so the master is
 * disambiguated by its `-n` flag; a sock-only match is used as a fallback.
 */
export function findDtachMasterPidSync(sock: string, dtachBinary: string): number {
  if (process.platform !== 'linux') return findDtachMasterPidWithPs(sock, dtachBinary);
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return -1; // defensive fallback; non-Linux uses findDtachMasterPidWithPs.
  }
  let fallback = -1;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf-8');
    } catch {
      continue; // process exited between readdir and read, or unreadable
    }
    if (!cmdline.includes(sock)) continue;
    const tokens = cmdline.split('\0');
    if (tokens.includes('-n')) return Number(name);
    if (fallback < 0) fallback = Number(name);
  }
  return fallback;
}

/** Portable process lookup for macOS, which does not provide `/proc`. */
export function findDtachMasterPidWithPs(sock: string, dtachBinary: string): number {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let fallback = -1;
    for (const line of output.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !match[2].includes(sock) || !match[2].includes(dtachBinary)) continue;
      const pid = Number(match[1]);
      if (/(?:^|\s)-n(?:\s|$)/.test(match[2])) return pid;
      if (fallback < 0) fallback = pid;
    }
    return fallback;
  } catch {
    return -1;
  }
}
