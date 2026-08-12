/**
 * Cross-agent task migration — migratability classifier
 * (RFC: rfc-cross-agent-task-migration).
 *
 * Pure logic: given a {@link Task} and a precomputed {@link MigrationProbe}
 * (the I/O — target-agent availability, cwd/git checks, a live backend session
 * probe, fork-eligibility, successor + worktree-sharing lookups — resolved by
 * the caller), decide whether the task can be continued under a different
 * agent, or return a stable blocked reason. Keeping the I/O in the probe keeps
 * this unit-testable and keeps the classifier honest about what it depends on.
 */

import type { AgentType } from '../../shared/contracts/agent-types.js';
import type { Task } from '../task-read-model.js';

/** Stable, machine-readable reasons a task cannot be migrated. */
export type NotMigratableReason =
  | 'status_not_migratable'
  | 'workflow_owner_unsupported'
  | 'already_migrated'
  | 'same_agent_use_restore'
  | 'target_agent_unavailable'
  | 'live_session_exists'
  | 'missing_cwd'
  | 'cwd_gone'
  | 'git_unavailable'
  | 'missing_intent';

/**
 * Precomputed inputs for one task/target pair. The caller resolves every field
 * (filesystem, adapter registry, live backend probe, task store) so the
 * classifier stays pure.
 */
export interface MigrationProbe {
  /** The agent the user wants to continue the work under. */
  targetAgent: AgentType;
  /** True when the target adapter is registered and launchable right now. */
  targetAvailable: boolean;
  /** True when `task.cwd` is set. */
  hasCwd: boolean;
  /** True when `task.cwd` exists on disk. */
  cwdExists: boolean;
  /** True when `task.cwd` is a usable git repository. */
  gitUsable: boolean;
  /** True when the task currently has a live terminal session (live-probed). */
  liveSession: boolean;
  /**
   * True when the target equals the source agent AND a conversation-preserving
   * provider fork is possible — in which case the user should use restore, not
   * migrate. See {@link https} rfc-restore-lost-agent-sessions.
   */
  forkEligibleSameAgent: boolean;
  /** True when this task already has a live successor migration task. */
  alreadyMigrated: boolean;
  /**
   * Advisory: true when `task.cwd` is shared by other tasks or the session is
   * not a dedicated git worktree. Never a hard block — it shapes the brief and
   * is surfaced to the user (RFC §1, consensus-attack fix).
   */
  worktreeShared: boolean;
  /**
   * Whether user-cancelled tasks are eligible in this call. Cancelled work may
   * have been abandoned on purpose, so it requires explicit opt-in.
   */
  allowCancelled: boolean;
}

export interface MigratableResult {
  migratable: boolean;
  reason?: NotMigratableReason;
  /** Advisory flag echoed to callers regardless of the migratable verdict. */
  worktreeShared: boolean;
}

/** Statuses whose work can be continued under a new agent. */
function isMigratableStatus(task: Task, allowCancelled: boolean): boolean {
  switch (task.status) {
    case 'terminated':
      return true;
    case 'inProgress':
      return true; // only when no live session — enforced via probe below
    case 'cancelled':
      return allowCancelled;
    case 'open':
    case 'pending':
    case 'completed':
      return false;
  }
}

/** True when the task carries a reconstructable intent for the continuation brief. */
export function hasReconstructableIntent(task: Task): boolean {
  const intent = task.userPrompt ?? task.prompt;
  return typeof intent === 'string' && intent.trim().length > 0;
}

/**
 * Classify whether `task` can be migrated to `probe.targetAgent`. Reasons are
 * checked in a deterministic priority order so the surfaced blocker is stable.
 */
export function classifyMigration(task: Task, probe: MigrationProbe): MigratableResult {
  const worktreeShared = probe.worktreeShared;
  const blocked = (reason: NotMigratableReason): MigratableResult => ({
    migratable: false,
    reason,
    worktreeShared,
  });

  // 1. Status / workflow ownership.
  if (!isMigratableStatus(task, probe.allowCancelled)) return blocked('status_not_migratable');
  if (task.ralphLoop) return blocked('workflow_owner_unsupported');

  // 2. Already handled.
  if (probe.alreadyMigrated) return blocked('already_migrated');
  if (probe.forkEligibleSameAgent) return blocked('same_agent_use_restore');

  // 3. Target availability.
  if (!probe.targetAvailable) return blocked('target_agent_unavailable');

  // 4. Liveness — never migrate an actually-running task.
  if (probe.liveSession) return blocked('live_session_exists');

  // 5. Local prerequisites.
  if (!probe.hasCwd) return blocked('missing_cwd');
  if (!probe.cwdExists) return blocked('cwd_gone');
  if (!probe.gitUsable) return blocked('git_unavailable');
  if (!hasReconstructableIntent(task)) return blocked('missing_intent');

  return { migratable: true, worktreeShared };
}
