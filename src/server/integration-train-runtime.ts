// Shared runtime facts about the integration train (issue #3796): where its
// state lives, whether a pid is really the train, and a read-only status
// snapshot. Used by the train CLI (scripts/integration-train.ts), by the
// server's liveness monitor and by /api/health. See
// docs/reference/integration-train.md.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** `<kookrDir>/integration-train`: the parent of every repository's state directory. */
export function integrationTrainBaseDir(kookrDir: string): string {
  return join(kookrDir, 'integration-train');
}

/** File names inside one state directory. */
export function integrationTrainPaths(dir: string) {
  return {
    state: join(dir, 'state.json'),
    log: join(dir, 'train.log'),
    pid: join(dir, 'train.pid'),
    lock: join(dir, 'train.lock'),
    events: join(dir, 'events.jsonl'),
    /** Arguments of the last `start`, reused by `restart`. */
    startArgs: join(dir, 'start-args.json'),
    /** Outcome of the newest finished cycle. */
    lastCycle: join(dir, 'last-cycle.json'),
    /**
     * Written by the run loop when it starts (pid, checkout HEAD). Its pid
     * proves the running train understands restart requests (issue #3841).
     */
    runInfo: join(dir, 'run-info.json'),
    /** A pending `restart`: the train re-executes itself once its cycle ends. */
    restartRequest: join(dir, 'restart-request.json'),
  };
}

/**
 * Repository key from a remote URL: `owner-name`, lowercased. The ssh and https
 * forms of the same GitHub repository give the same key
 * (`git@github.com:kookr-ai/kookr.git` and `https://github.com/kookr-ai/kookr`
 * are both `kookr-ai-kookr`). Null when the URL has no `owner/name` path.
 */
export function repoKeyFromRemoteUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  // scp-like `user@host:owner/name`, or a URL `scheme://host/.../owner/name`.
  const path = /^[^/:]+@[^/:]+:(.+)$/.exec(trimmed)?.[1] ?? /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(trimmed)?.[1];
  if (!path) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const key = `${parts[parts.length - 2]}-${parts[parts.length - 1]}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return key || null;
}

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Key of the repository checked out at `repoPath`: the `origin` remote's
 * `owner-name`, so every checkout and worktree of the same repository (the
 * production checkout, the train worktree, a developer clone) shares one train
 * state, and two repositories never do. Without a usable `origin`, the key is
 * derived from the git common directory (`local-<hash>`).
 */
export function resolveRepoKey(repoPath: string): string {
  const url = gitOut(repoPath, ['remote', 'get-url', 'origin']);
  const fromUrl = url ? repoKeyFromRemoteUrl(url) : null;
  if (fromUrl) return fromUrl;
  const common = gitOut(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  let base = resolve(common ?? repoPath);
  try { base = realpathSync(base); } catch { /* keep the resolved path */ }
  return `local-${createHash('sha256').update(base).digest('hex').slice(0, 12)}`;
}

/** State directory of the train for one repository. */
export function integrationTrainStateDir(kookrDir: string, repoKey: string): string {
  return join(integrationTrainBaseDir(kookrDir), repoKey);
}

/** Command line of a live process, or null when it is gone or unreadable. */
export function readProcessCommandLine(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    // Gone, or EPERM (owned by another user): not our train either way.
    return null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null;
  } catch {
    try {
      // macOS and other systems without /proc.
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }
}

/**
 * Arguments a live process was started with, or null. Exact on Linux (from
 * /proc, NUL-separated); elsewhere the `ps` command line split on whitespace,
 * which is wrong only for arguments that contain spaces.
 */
export function readProcessArgv(pid: number): string[] | null {
  if (readProcessCommandLine(pid) === null) return null;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((a) => a.length > 0);
  } catch {
    return readProcessCommandLine(pid)?.split(/\s+/).filter(Boolean) ?? null;
  }
}

/** True when the command line is the train's long-running loop (`integration-train.ts run`). */
export function looksLikeTrainCommand(commandLine: string): boolean {
  return /integration-train\.[cm]?[jt]s\s+run(\s|$)/.test(commandLine);
}

/**
 * True only when `pid` is alive AND is the train's run loop. A pid file outlives
 * its process, and the system reuses pids, so a bare "is alive" check could
 * signal an unrelated process.
 */
export function isIntegrationTrainProcess(pid: number, readCommandLine = readProcessCommandLine): boolean {
  const cmd = readCommandLine(pid);
  return cmd !== null && looksLikeTrainCommand(cmd);
}

export function readPidFile(file: string): number | null {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface IntegrationTrainLastCycle {
  at: string;
  outcome: string;
  reason?: string;
  detail?: string;
}

export interface IntegrationTrainStatus {
  stateDir: string;
  running: boolean;
  pid: number | null;
  halted: { reason: string; at: string } | null;
  lastCycle: IntegrationTrainLastCycle | null;
  /** Set while a `restart` waits for the running train's cycle to end (issue #3841). */
  restartPending: { requestedAt: string } | null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Read-only snapshot of one state directory. Never throws. */
export function readIntegrationTrainStatus(
  dir: string,
  isTrain: (pid: number) => boolean = (pid) => isIntegrationTrainProcess(pid),
): IntegrationTrainStatus {
  const p = integrationTrainPaths(dir);
  const pid = readPidFile(p.pid);
  const state = readJson(p.state) as { halted?: { reason?: unknown; at?: unknown } | null } | null;
  const halt = state?.halted;
  const last = readJson(p.lastCycle) as Partial<IntegrationTrainLastCycle> | null;
  const running = pid !== null && isTrain(pid);
  const request = running ? readJson(p.restartRequest) as { requestedAt?: unknown } | null : null;
  return {
    stateDir: dir,
    running,
    pid,
    halted: halt && typeof halt.reason === 'string'
      ? { reason: halt.reason, at: typeof halt.at === 'string' ? halt.at : '' }
      : null,
    lastCycle: last && typeof last.at === 'string' && typeof last.outcome === 'string'
      ? {
        at: last.at,
        outcome: last.outcome,
        ...(typeof last.reason === 'string' ? { reason: last.reason } : {}),
        ...(typeof last.detail === 'string' ? { detail: last.detail } : {}),
      }
      : null,
    restartPending: request && typeof request.requestedAt === 'string' ? { requestedAt: request.requestedAt } : null,
  };
}

/**
 * State directory to read for a repository: the keyed one, or the pre-#3796
 * shared directory while a train that has not been restarted since still uses it.
 */
export function effectiveIntegrationTrainStateDir(kookrDir: string, repoKey: string): string {
  const keyed = integrationTrainStateDir(kookrDir, repoKey);
  if (existsSync(join(keyed, 'state.json')) || existsSync(join(keyed, 'train.pid'))) return keyed;
  const legacy = integrationTrainBaseDir(kookrDir);
  if (existsSync(join(legacy, 'state.json')) || existsSync(join(legacy, 'train.pid'))) return legacy;
  return keyed;
}
