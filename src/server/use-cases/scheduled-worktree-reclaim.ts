/**
 * Scheduled (unattended) worktree reclaim — issue #1578.
 *
 * Wraps the already-shipped probably-safe bulk reclaim (#1289 / epic #1293) so
 * it can run on a schedule without a human at the keyboard. The three deliberate
 * safety guarantees, in priority order:
 *
 *  1. Classification is the SINGLE source of truth. A worktree is only ever a
 *     removal candidate when {@link canSweepRemove} says so — i.e. its
 *     classification is in `SWEEP_SAFE_CLASSIFICATIONS` (`merged` /
 *     `patch_equivalent`). Nothing dirty, ahead, busy, detached, protected, or
 *     otherwise ambiguous is ever touched. The candidate list is regenerated
 *     FRESH every run via {@link inspectCleanupCandidates} (`git worktree list
 *     --porcelain` + per-worktree `git status` / merge-base classification);
 *     no stale audit snapshot is consulted.
 *
 *  2. Hard excludes run BEFORE classification as belt-and-suspenders: the
 *     production runtime (`kookr-prod`), any `.kookr-protected` worktree (the
 *     marker operators use to pin prod- or PR-hosting worktrees), and worktrees
 *     on a protected branch are excluded up front — even if a future
 *     classification change ever mislabeled them as safe.
 *
 *  3. Remove-path / KEEP-branch. Every live removal routes through
 *     {@link cleanupWorkspaceCandidate} with `deleteBranch: false`, matching the
 *     epic's empirically-validated decision to keep branches (and skip a
 *     pushed-check). The branch is a recovery net; only the on-disk path is
 *     reclaimed.
 *
 * A dry-run mode classifies and reports candidates without removing anything.
 * Every run appends one audit row per worktree considered (classification +
 * action taken) plus a run-summary row to the shared `~/.kookr/audit.jsonl`.
 */

import { randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import { canSweepRemove } from '../../core/workspace-cleanup-policy.js';
import type { CleanupCandidateAssessment } from '../../core/workspace-types.js';
import { appendAuditRow } from '../../core/audit-log.js';
import { gitExecEnv } from '../../core/git-helpers.js';
import { isProtectedBranch } from '../../adapters/worktree-safety.js';
import { isProtectedWorktreePath } from '../../adapters/worktree-marker.js';
import { endsWithProtectedSuffix } from '../../core/worktree-protection.js';
import { inspectCleanupCandidates } from './cleanup-inspector.js';
import {
  cleanupWorkspaceCandidate,
  type WorkspaceCleanupDeps,
} from './workspace-cleanup-service.js';
import { enumerateSweepProjects } from './cross-project-cleanup-sweep.js';

const execFile = promisify(execFileCb);

const FETCH_TIMEOUT_MS = 30_000;
const PRUNE_TIMEOUT_MS = 10_000;

/** Why a worktree was hard-excluded before classification was even consulted. */
export type ReclaimExcludeReason = 'kookr_prod' | 'protected_marker' | 'protected_branch';

/** Outcome recorded for each considered worktree. */
export type ReclaimAction =
  /** Live run removed the path (branch kept). */
  | 'removed'
  /** Dry-run: this path WOULD be removed on a live run. */
  | 'would_remove'
  /** Hard-excluded (prod / protected marker / protected branch). */
  | 'skipped_excluded'
  /** Classification is not in `SWEEP_SAFE_CLASSIFICATIONS` (dirty/ahead/busy/…). */
  | 'skipped_unsafe'
  /** Live run attempted removal but it did not complete. */
  | 'remove_failed';

export interface ReclaimWorktreeAudit {
  projectId: string;
  worktreePath: string;
  branch: string;
  classification: CleanupCandidateAssessment['classification'];
  reasonCode: string;
  action: ReclaimAction;
  excludeReason?: ReclaimExcludeReason;
  /** Present on `remove_failed`. */
  detail?: string;
}

export interface ScheduledReclaimResult {
  runId: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  consideredCount: number;
  removedCount: number;
  wouldRemoveCount: number;
  excludedCount: number;
  unsafeCount: number;
  failedCount: number;
  worktrees: ReclaimWorktreeAudit[];
}

export interface ScheduledReclaimDeps {
  cleanupDeps: WorkspaceCleanupDeps;
  projectConfigStore: ProjectConfigStore;
  taskStore: TaskStore;
  /** Pre-bound `(projectId) => Promise<repoPath>` — caller binds once. */
  resolveRepoPath: (projectId: string) => Promise<string>;
  /** Shared `~/.kookr/audit.jsonl` path. Absent → audit rows are dropped. */
  auditLogPath?: string;
  /** Injectable audit writer (tests); defaults to {@link appendAuditRow}. */
  appendAudit?: (path: string | undefined, row: Record<string, unknown>) => Promise<void>;
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
  now?: () => Date;
  /**
   * Refresh refs before classification so recently merged remote branches are
   * visible to merge-base checks. Best-effort and non-fatal. Default true;
   * disable in tests against remote-less repos to avoid noise.
   */
  fetchBeforeClassify?: boolean;
}

export interface ScheduledReclaimOptions {
  /** When true, classify and report candidates without removing anything. */
  dryRun: boolean;
  /** Injectable for deterministic tests. */
  runId?: string;
}

/**
 * The hard-exclude gate. Runs BEFORE classification so protected worktrees can
 * never be reclaimed even if their classification were ever wrong. Returns the
 * exclude reason, or null when the worktree is eligible for classification.
 *
 * `.kookr-protected` is the single mechanism operators use to pin a worktree
 * out of automated reclaim — it covers the production runtime AND any
 * PR-hosting / preview worktree an operator marks. `kookr-prod` is also matched
 * by its legacy basename so a prod dir missing its marker is still safe.
 */
export function reclaimHardExcludeReason(
  worktreePath: string,
  branch: string | undefined,
): ReclaimExcludeReason | null {
  if (endsWithProtectedSuffix(worktreePath)) return 'kookr_prod';
  if (isProtectedWorktreePath(worktreePath)) return 'protected_marker';
  if (isProtectedBranch(branch)) return 'protected_branch';
  return null;
}

/**
 * Run one scheduled reclaim pass across every known project.
 *
 * Never throws — a per-project or per-worktree failure is recorded and the pass
 * continues, so one bad repo cannot wedge the schedule.
 */
export async function runScheduledWorktreeReclaim(
  deps: ScheduledReclaimDeps,
  options: ScheduledReclaimOptions,
): Promise<ScheduledReclaimResult> {
  const now = deps.now ?? (() => new Date());
  const appendAudit = deps.appendAudit ?? appendAuditRow;
  const fetchBeforeClassify = deps.fetchBeforeClassify ?? true;
  const runId = options.runId ?? randomUUID();
  const startedAt = now().toISOString();
  const worktrees: ReclaimWorktreeAudit[] = [];

  const projectIds = enumerateSweepProjects(deps.projectConfigStore, deps.taskStore);
  deps.logger?.info('worktree_reclaim_start', { runId, dryRun: options.dryRun, projects: projectIds.length });

  for (const projectId of projectIds) {
    let repoPath: string;
    try {
      repoPath = await deps.resolveRepoPath(projectId);
    } catch {
      continue;
    }

    if (fetchBeforeClassify) {
      await execFile('git', ['-C', repoPath, 'fetch', 'origin', '--prune'], { timeout: FETCH_TIMEOUT_MS, env: gitExecEnv() }).catch(() => undefined);
    }
    await execFile('git', ['-C', repoPath, 'worktree', 'prune'], { timeout: PRUNE_TIMEOUT_MS, env: gitExecEnv() }).catch(() => undefined);

    let candidates: CleanupCandidateAssessment[];
    try {
      candidates = await inspectCleanupCandidates(repoPath, projectId, {
        policyResolver: deps.cleanupDeps.policyResolver,
        leaseService: deps.cleanupDeps.leaseService,
      });
    } catch (err) {
      deps.logger?.warn('worktree_reclaim_project_error', {
        runId,
        projectId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const candidate of candidates) {
      const worktreePath = candidate.worktreePath;
      if (!worktreePath) continue;

      const audit = await classifyAndAct(deps, {
        candidate,
        worktreePath,
        projectId,
        repoPath,
        dryRun: options.dryRun,
        runId,
      });
      worktrees.push(audit);
      await appendAudit(deps.auditLogPath, {
        event: 'worktree_reclaim_considered',
        runId,
        dryRun: options.dryRun,
        ts: now().toISOString(),
        projectId,
        worktreePath,
        branch: audit.branch,
        classification: audit.classification,
        reasonCode: audit.reasonCode,
        action: audit.action,
        ...(audit.excludeReason ? { excludeReason: audit.excludeReason } : {}),
        ...(audit.detail ? { detail: audit.detail } : {}),
      });
    }
  }

  const result: ScheduledReclaimResult = {
    runId,
    dryRun: options.dryRun,
    startedAt,
    finishedAt: now().toISOString(),
    consideredCount: worktrees.length,
    removedCount: worktrees.filter((w) => w.action === 'removed').length,
    wouldRemoveCount: worktrees.filter((w) => w.action === 'would_remove').length,
    excludedCount: worktrees.filter((w) => w.action === 'skipped_excluded').length,
    unsafeCount: worktrees.filter((w) => w.action === 'skipped_unsafe').length,
    failedCount: worktrees.filter((w) => w.action === 'remove_failed').length,
    worktrees,
  };

  await appendAudit(deps.auditLogPath, {
    event: 'worktree_reclaim_run',
    runId,
    dryRun: options.dryRun,
    startedAt,
    finishedAt: result.finishedAt,
    considered: result.consideredCount,
    removed: result.removedCount,
    wouldRemove: result.wouldRemoveCount,
    excluded: result.excludedCount,
    unsafe: result.unsafeCount,
    failed: result.failedCount,
  });
  deps.logger?.info('worktree_reclaim_finish', {
    runId,
    dryRun: options.dryRun,
    considered: result.consideredCount,
    removed: result.removedCount,
    wouldRemove: result.wouldRemoveCount,
  });

  return result;
}

interface ClassifyAndActInput {
  candidate: CleanupCandidateAssessment;
  worktreePath: string;
  projectId: string;
  repoPath: string;
  dryRun: boolean;
  runId: string;
}

async function classifyAndAct(
  deps: ScheduledReclaimDeps,
  input: ClassifyAndActInput,
): Promise<ReclaimWorktreeAudit> {
  const { candidate, worktreePath, projectId } = input;
  const base = {
    projectId,
    worktreePath,
    branch: candidate.branch,
    classification: candidate.classification,
    reasonCode: candidate.reasonCode,
  } satisfies Omit<ReclaimWorktreeAudit, 'action'>;

  const excludeReason = reclaimHardExcludeReason(worktreePath, candidate.branch);
  if (excludeReason) {
    return { ...base, action: 'skipped_excluded', excludeReason };
  }

  // Classification is the single source of truth for removability.
  if (!canSweepRemove(candidate)) {
    return { ...base, action: 'skipped_unsafe' };
  }

  if (input.dryRun) {
    return { ...base, action: 'would_remove' };
  }

  try {
    const { summary } = await cleanupWorkspaceCandidate(deps.cleanupDeps, {
      projectId,
      repoPath: input.repoPath,
      worktreePath,
      branch: candidate.branch,
      // Remove-path / KEEP-branch. Hardcoded false — the scheduled reclaim
      // never deletes a branch (issue #1578 / epic #1293 decision).
      deleteBranch: false,
      sweepRunId: input.runId,
    });
    if (summary.pathRemoved) {
      return { ...base, action: 'removed' };
    }
    return { ...base, action: 'remove_failed', detail: summary.disposition };
  } catch (err) {
    return {
      ...base,
      action: 'remove_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
