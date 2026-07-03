/**
 * Cross-project worktree sweep.
 *
 * Iterates every known project and delegates safe cleanup to the existing
 * `cleanupSafeWorkspaceCandidates()` per-project path. The sweep uses the
 * same safe classifications as the per-project panel: strict merged branches
 * and patch-equivalent branches produced by squash merges.
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
import type { WorkspaceSweepProgressSnapshot, WorkspaceSweepProgressStatus } from '../../shared/contracts/messages.js';
import {
  cleanupSafeWorkspaceCandidates,
  type WorkspaceCleanupDeps,
} from './workspace-cleanup-service.js';

const execFile = promisify(execFileCb);

const PER_PROJECT_TIMEOUT_MS = 10 * 60_000;
const LOCK_TTL_MS = 20 * 60 * 1000; // 20 min
const FETCH_TIMEOUT_MS = 30_000;
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

export type SweepProgressEvent = WorkspaceSweepProgressSnapshot & {
  result?: ProjectSweepResult;
};

export interface CrossProjectSweepDeps {
  cleanupDeps: WorkspaceCleanupDeps;
  projectConfigStore: ProjectConfigStore;
  taskStore: TaskStore;
  /** Pre-bound `(projectId) => Promise<repoPath>` — caller binds once. */
  resolveRepoPath: (projectId: string) => Promise<string>;
  /** Called when a project starts or finishes. */
  onProgress?: (progress: SweepProgressEvent) => void;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
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

let sweepProgress: WorkspaceSweepProgressSnapshot | null = null;

export function getSweepProgressSnapshot(): WorkspaceSweepProgressSnapshot | null {
  return sweepProgress ? { ...sweepProgress } : null;
}

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
    deps.logger?.info('workspace_sweep_start', { runId, total: projectIds.length });

    for (let offset = 0; offset < projectIds.length; offset++) {
      const projectId = projectIds[offset]!;
      const index = offset + 1;
      emitSweepProgress(deps, {
        runId,
        startedAt,
        index,
        total: projectIds.length,
        projectId,
        status: 'running',
        counts: countsForResults(projects),
      });
      const result = await sweepOneProject(projectId, deps, runId, timeoutMs);
      projects.push(result);
      emitSweepProgress(deps, {
        runId,
        startedAt,
        index,
        total: projectIds.length,
        projectId,
        status: progressStatusForResult(result),
        counts: countsForResults(projects),
        result,
      });
    }
  } finally {
    lockAttempt.release();
    sweepProgress = null;
  }

  deps.logger?.info('workspace_sweep_finish', { runId, projects: projects.length });

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

  const sweepAttempt = deps.cleanupDeps.attemptRepository.createAttempt({
    type: 'cleanup',
    projectId,
    reasonCode: 'cross_project_sweep',
    source: 'cross_project_sweep',
    evidenceSummary: `Cross-project sweep ${sweepRunId} started for ${projectId}`,
    sweepRunId,
  });

  // Refresh refs before classification so recently merged remote branches are
  // visible to merge-base checks. Then converge half-deleted worktree state
  // from prior sweeps/crashes. Both are non-fatal: the per-candidate
  // classifier still reports visible skipped/blocked reasons where possible.
  await execFile('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], { timeout: FETCH_TIMEOUT_MS, env: gitExecEnv() }).catch(() => undefined);
  await execFile('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: 10_000, env: gitExecEnv() }).catch(() => undefined);

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
    deps.cleanupDeps.attemptRepository.passAttempt(
      sweepAttempt.attemptId,
      `Cross-project sweep completed for ${projectId}; removed ${result.summaries.length} worktree(s)`,
    );
    return {
      kind: 'ok',
      projectId,
      summaries: result.summaries,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    if (controller.signal.aborted) {
      deps.cleanupDeps.attemptRepository.updateAttempt(sweepAttempt.attemptId, {
        status: 'timed_out',
        disposition: 'blocked',
        finishedAt: new Date().toISOString(),
        evidenceSummary: `Cross-project sweep timed out for ${projectId} after ${timeoutMs}ms`,
      });
      deps.logger?.warn('workspace_sweep_project_timeout', { sweepRunId, projectId, timeoutMs });
      return { kind: 'failed', projectId, code: 'timeout', message: `Timed out after ${timeoutMs}ms`, elapsedMs };
    }
    deps.cleanupDeps.attemptRepository.blockAttempt(
      sweepAttempt.attemptId,
      err instanceof Error ? err.message : String(err),
    );
    deps.logger?.warn('workspace_sweep_project_error', {
      sweepRunId,
      projectId,
      message: err instanceof Error ? err.message : String(err),
    });
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

function emitSweepProgress(deps: CrossProjectSweepDeps, event: SweepProgressEvent): void {
  const { result: _result, ...snapshot } = event;
  sweepProgress = snapshot;
  deps.onProgress?.(event);
}

function countsForResults(projects: ProjectSweepResult[]): WorkspaceSweepProgressSnapshot['counts'] {
  return projects.reduce(
    (acc, result) => {
      if (result.kind === 'ok') acc.done += 1;
      if (result.kind === 'skipped') acc.skipped += 1;
      if (result.kind === 'failed') acc.failed += 1;
      return acc;
    },
    { done: 0, skipped: 0, failed: 0 },
  );
}

function progressStatusForResult(result: ProjectSweepResult): Exclude<WorkspaceSweepProgressStatus, 'running'> {
  switch (result.kind) {
    case 'ok':
      return 'done';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
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

function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) {
    delete env[name];
  }
  return env;
}
