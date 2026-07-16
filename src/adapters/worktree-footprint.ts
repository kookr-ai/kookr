import { execFile as execFileCb } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitExecEnv } from '../core/git-helpers.js';

const execFile = promisify(execFileCb);

export interface WorktreeFootprint {
  /** on-disk footprint bytes from `du -sk` (× 1024); null when du failed/timed out ("size unknown"). */
  footprintBytes: number | null;
  /** git-index mtime (ms epoch) — the "last touched" staleness signal; null when unreadable. */
  lastTouchedMs: number | null;
}

const DEFAULT_DU_TIMEOUT_MS = 5000;

/**
 * Measure a worktree's on-disk footprint (via `du`) and its git-index mtime
 * (staleness signal), concurrently. Best-effort: never throws — each half
 * independently degrades to null on failure/timeout.
 */
export async function measureWorktreeFootprint(
  worktreePath: string,
  opts?: { duTimeoutMs?: number; signal?: AbortSignal },
): Promise<WorktreeFootprint> {
  const duTimeoutMs = opts?.duTimeoutMs ?? DEFAULT_DU_TIMEOUT_MS;
  const [footprintBytes, lastTouchedMs] = await Promise.all([
    measureFootprint(worktreePath, duTimeoutMs, opts?.signal),
    measureLastTouched(worktreePath, opts?.signal),
  ]);
  return { footprintBytes, lastTouchedMs };
}

async function measureFootprint(
  worktreePath: string,
  duTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  try {
    const arg = worktreePath.startsWith('-') ? `./${worktreePath}` : worktreePath;
    const { stdout } = await execFile('du', ['-s', '-k', '-x', '--', arg], {
      timeout: duTimeoutMs,
      signal,
    });
    const firstToken = stdout.trim().split(/\s+/)[0];
    const kb = Number.parseInt(firstToken, 10);
    if (Number.isNaN(kb)) return null;
    return kb * 1024;
  } catch {
    return null;
  }
}

async function measureLastTouched(
  worktreePath: string,
  signal: AbortSignal | undefined,
): Promise<number | null> {
  try {
    const { stdout } = await execFile('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'index'], {
      env: gitExecEnv(),
      signal,
    });
    const indexPathRaw = stdout.trim();
    const indexPath = resolve(worktreePath, indexPathRaw);
    const stat = statSync(indexPath);
    return Math.round(stat.mtimeMs);
  } catch {
    return null;
  }
}
