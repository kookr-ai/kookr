/**
 * Cross-project worktree sweep.
 *
 * Iterates every known project and delegates safe cleanup to the existing
 * `cleanupSafeWorkspaceCandidates()` per-project path. The sweep's safe
 * set is narrower than the per-project panel's — it uses `canSweepRemove`
 * (merged only), which excludes `patch_equivalent` because the classifier
 * has a confirmed false-positive on squash-merge + revert.
 *
 * See docs/rfc/rfc-cross-project-worktree-sweep.md.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import { canSweepRemove } from '../../core/workspace-cleanup-policy.js';
import type { CleanupResultSummary } from '../../core/workspace-types.js';
import {
  cleanupSafeWorkspaceCandidates,
  type WorkspaceCleanupDeps,
} from './workspace-cleanup-service.js';

const execFile = promisify(execFileCb);

const PER_PROJECT_TIMEOUT_MS = 60_000;
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min

export interface CrossProjectSweepDeps {
  cleanupDeps: WorkspaceCleanupDeps;
  projectConfigStore: ProjectConfigStore;
  taskStore: TaskStore;
  /** Pre-bound `(projectId) => Promise<repoPath>` — caller binds once. */
  resolveRepoPath: (projectId: string) => Promise<string>;
  now?: () => Date;
  /** Injectable for tests. */
  lockDir?: string;
  perProjectTimeoutMs?: number;
}

export type ProjectSweepResult =
  | { kind: 'ok'; projectId: string; summaries: CleanupResultSummary[]; elapsedMs: number }
  | { kind: 'skipped'; projectId: string; reason: 'repo_path_unresolved' }
  | { kind: 'failed'; projectId: string; code: 'timeout' | 'error'; message: string; elapsedMs: number };

export interface CrossProjectSweepResult {
  runId: string;
  startedAt: string;
  finishedAt: string;
  projects: ProjectSweepResult[];
}

export type SweepOutcome =
  | { kind: 'completed'; result: CrossProjectSweepResult }
  | { kind: 'busy'; holderPid: number; heldSince: string };

/**
 * Union configStore and taskStore projects, deduped, deterministically ordered.
 * Exported for isolated testing.
 */
export function enumerateSweepProjects(
  configStore: ProjectConfigStore,
  taskStore: TaskStore,
): string[] {
  const seen = new Set<string>();
  for (const config of configStore.getAllConfigs()) {
    if (config.project) seen.add(config.project);
  }
  for (const task of taskStore.getAllTasks()) {
    const projectId = task.projectId;
    if (typeof projectId === 'string' && projectId.length > 0) {
      seen.add(projectId);
    }
  }
  return Array.from(seen).sort();
}

/**
 * Run the cross-project sweep. Returns either the completed result or a
 * `busy` marker if another process already holds the sweep lock.
 */
export async function runCrossProjectSweep(
  deps: CrossProjectSweepDeps,
): Promise<SweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const lockDir = deps.lockDir ?? join(homedir(), '.kookr');
  const timeoutMs = deps.perProjectTimeoutMs ?? PER_PROJECT_TIMEOUT_MS;

  const lockAttempt = acquireSweepLock({ lockDir, now, ttlMs: LOCK_TTL_MS });
  if (lockAttempt.kind === 'busy') {
    return { kind: 'busy', holderPid: lockAttempt.holderPid, heldSince: lockAttempt.heldSince };
  }

  const runId = randomUUID();
  const startedAt = now().toISOString();
  const projects: ProjectSweepResult[] = [];

  try {
    const projectIds = enumerateSweepProjects(deps.projectConfigStore, deps.taskStore);

    for (const projectId of projectIds) {
      projects.push(await sweepOneProject(projectId, deps, runId, timeoutMs));
    }
  } finally {
    lockAttempt.release();
  }

  return {
    kind: 'completed',
    result: {
      runId,
      startedAt,
      finishedAt: now().toISOString(),
      projects,
    },
  };
}

async function sweepOneProject(
  projectId: string,
  deps: CrossProjectSweepDeps,
  sweepRunId: string,
  timeoutMs: number,
): Promise<ProjectSweepResult> {
  const startedAt = Date.now();

  let repoPath: string;
  try {
    repoPath = await deps.resolveRepoPath(projectId);
  } catch {
    return { kind: 'skipped', projectId, reason: 'repo_path_unresolved' };
  }

  // Pre-classification prune — converges half-deleted state from prior sweeps/crashes.
  try {
    await execFile('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 10_000 });
  } catch {
    // Non-fatal: classification will still run and worst case some stale entries remain.
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await cleanupSafeWorkspaceCandidates(deps.cleanupDeps, {
      projectId,
      repoPath,
      classificationFilter: canSweepRemove,
      signal: controller.signal,
      sweepRunId,
    });
    return {
      kind: 'ok',
      projectId,
      summaries: result.summaries,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      return { kind: 'failed', projectId, code: 'timeout', message: `Timed out after ${timeoutMs}ms`, elapsedMs };
    }
    return {
      kind: 'failed',
      projectId,
      code: 'error',
      message: err instanceof Error ? err.message : String(err),
      elapsedMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Lock ----------

interface LockAcquired {
  kind: 'acquired';
  release(): void;
}

interface LockBusy {
  kind: 'busy';
  holderPid: number;
  heldSince: string;
}

function acquireSweepLock(opts: {
  lockDir: string;
  now: () => Date;
  ttlMs: number;
}): LockAcquired | LockBusy {
  mkdirSync(opts.lockDir, { recursive: true });
  const lockPath = join(opts.lockDir, 'sweep.lock');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      const payload = JSON.stringify({ pid: process.pid, startedAt: opts.now().toISOString() });
      writeFileSync(fd, payload);
      closeSync(fd);
      return {
        kind: 'acquired',
        release() {
          try {
            unlinkSync(lockPath);
          } catch {
            // best-effort — if another process stole it, nothing useful to do.
          }
        },
      };
    } catch (err) {
      if (!isEExist(err)) throw err;
      if (attempt === 1) {
        // Second attempt also failed — fall through to report busy.
        break;
      }
      if (tryReclaimStaleLock(lockPath, opts.ttlMs)) continue;
      break;
    }
  }

  const holder = readLockHolder(lockPath);
  return { kind: 'busy', holderPid: holder.pid, heldSince: holder.startedAt };
}

function tryReclaimStaleLock(lockPath: string, ttlMs: number): boolean {
  const holder = readLockHolder(lockPath);
  if (holder.pid > 0) {
    try {
      process.kill(holder.pid, 0);
      // Process is alive — lock is held, do not reclaim. mtime-based
      // staleness must NOT override a live PID; a legitimately slow sweep
      // (up to N × per-project timeout) can exceed the TTL while still
      // running. PID is authoritative.
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        // Process is dead — reclaim.
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else already did.
        }
        return true;
      }
      // EPERM — process is alive but not ours. Treat as held.
      return false;
    }
  }
  // Malformed lock file (no readable pid) — fall back to mtime TTL.
  try {
    const stat = statSync(lockPath);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      unlinkSync(lockPath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Process-wide sweep-running check based on the lock file.
 *
 * The lock file is the authoritative signal across all WebSocket clients
 * and co-resident Kookr instances. Using it here keeps the per-connection
 * MessageRouter out of the snapshot-fan-out path.
 */
export function isSweepInProgress(lockDir?: string): boolean {
  const dir = lockDir ?? join(homedir(), '.kookr');
  const lockPath = join(dir, 'sweep.lock');
  const holder = readLockHolder(lockPath);
  if (holder.pid <= 0) return false;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // EPERM — live but not ours. Treat as running.
    return true;
  }
}

function readLockHolder(lockPath: string): { pid: number; startedAt: string } {
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') {
      const pid = typeof (parsed as { pid?: unknown }).pid === 'number'
        ? (parsed as { pid: number }).pid
        : 0;
      const startedAt = typeof (parsed as { startedAt?: unknown }).startedAt === 'string'
        ? (parsed as { startedAt: string }).startedAt
        : '';
      return { pid, startedAt };
    }
  } catch {
    // Missing or malformed lock file
  }
  return { pid: 0, startedAt: '' };
}

function isEExist(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'EEXIST';
}
