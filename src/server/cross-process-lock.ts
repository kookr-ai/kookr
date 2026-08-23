import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CrossProcessLockOptions {
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
}

export type CrossProcessLockResult =
  | { kind: 'acquired'; release: () => void }
  | { kind: 'busy'; holderPid?: number; heldSince?: string };

function isLockHolder(value: unknown): value is { pid: number; startedAt: string } {
  if (!value || typeof value !== 'object') return false;
  const row = value as { pid?: unknown; startedAt?: unknown };
  return typeof row.pid === 'number' && Number.isInteger(row.pid) && row.pid > 0
    && typeof row.startedAt === 'string';
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(lockPath: string): { holderPid?: number; heldSince?: string } {
  try {
    const value: unknown = JSON.parse(readFileSync(`${lockPath}/holder.json`, 'utf8'));
    if (!isLockHolder(value)) return {};
    return { holderPid: value.pid, heldSince: value.startedAt };
  } catch {
    return {};
  }
}

/**
 * Acquire a mkdir-backed lock without waiting. A live holder is authoritative;
 * malformed locks fail closed. Dead holders are reclaimed before retrying.
 */
export function tryAcquireCrossProcessLock(
  lockPath: string,
  options: CrossProcessLockOptions = {},
): CrossProcessLockResult {
  mkdirSync(dirname(lockPath), { recursive: true });
  const now = options.now ?? (() => new Date());
  const isAlive = options.isAlive ?? defaultIsAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        `${lockPath}/holder.json`,
        JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }),
        { flag: 'wx' },
      );
      return {
        kind: 'acquired',
        release: () => {
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Best effort. A future caller will reclaim a dead holder.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readHolder(lockPath);
      if (holder.holderPid !== undefined && holder.holderPid !== process.pid && isAlive(holder.holderPid)) {
        return { kind: 'busy', ...holder };
      }
      // A malformed lock is not safe to reclaim. Only a recorded dead pid is.
      if (holder.holderPid === undefined || holder.holderPid === process.pid) {
        return { kind: 'busy', ...holder };
      }
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        return { kind: 'busy', ...holder };
      }
    }
  }
  return { kind: 'busy', ...readHolder(lockPath) };
}

export async function withCrossProcessLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: CrossProcessLockOptions = {},
): Promise<{ kind: 'acquired'; value: T } | { kind: 'busy'; holderPid?: number; heldSince?: string }> {
  const lock = tryAcquireCrossProcessLock(lockPath, options);
  if (lock.kind === 'busy') return lock;
  try {
    return { kind: 'acquired', value: await action() };
  } finally {
    lock.release();
  }
}

/** Test-only helper for asserting that a lock was left behind by a holder. */
export function crossProcessLockExists(lockPath: string): boolean {
  return existsSync(lockPath);
}
