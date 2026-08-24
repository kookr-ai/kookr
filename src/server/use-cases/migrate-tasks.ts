/**
 * Cross-agent task migration use-case (RFC: rfc-cross-agent-task-migration).
 *
 * Continues interrupted tasks under a DIFFERENT, user-chosen agent by creating
 * a linked continuation task through the ordinary launch path (so it inherits
 * backpressure, dedup, and effort/model validation for free) with a
 * reconstructed continuation brief. It never mutates the source task's
 * `agentType` — the source is kept as an immutable historical record and linked
 * to its successor — so cost/outcome ledgers stay truthful and the operation is
 * reversible. Single, id-batch, and all(-from-agent) scopes; optional
 * "set as default"; per-worktree de-duplication so a batch never launches two
 * continuations into one shared checkout at once.
 */

import { existsSync } from 'node:fs';
import type { AgentType } from '../../shared/contracts/agent-types.js';
import { isValidLaunchPin } from '../../shared/contracts/agent-types.js';
import type { AgentSubstitutionHop } from '../../shared/contracts/task.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import { isTerminalStatus } from '../../core/task-status.js';
import {
  classifyMigration,
  isMigratableStatus,
  type MigrationProbe,
  type NotMigratableReason,
} from '../../core/migration/migratability.js';
import {
  buildContinuationBrief,
  readWorktreeState,
  type WorktreeState,
} from '../../core/migration/continuation-brief.js';
import { gitIn } from '../../core/git-helpers.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import {
  EffortValidationError,
  ModelValidationError,
  PendingQueueFullError,
  SpawnBurstLimitError,
} from '../launch-service.js';

export type MigrateOutcome = 'migrated' | 'queued' | 'blocked';

export type MigrateBlockReason =
  | NotMigratableReason
  | 'worktree_contended'
  | 'queue_full'
  | 'spawn_burst'
  | 'launch_failed'
  | 'invalid_launch_pin'
  | 'migration_in_progress'
  | 'not_found';

export interface MigrateTaskResult {
  taskId: string;
  outcome: MigrateOutcome;
  reason?: MigrateBlockReason;
  newTaskId?: string;
  worktreeShared?: boolean;
}

export type MigrateScope =
  | { kind: 'ids'; taskIds: string[] }
  | { kind: 'all'; fromAgent?: AgentType; includeCancelled?: boolean };

export interface MigrateTasksRequest {
  scope: MigrateScope;
  targetAgent: AgentType;
  effort?: string;
  model?: string;
  setAsDefault?: boolean;
  /** Restrict to tasks whose checkout is a dedicated worktree (not shared). */
  onlyIsolated?: boolean;
}

export interface MigrateTasksResult {
  targetAgent: AgentType;
  defaultUpdated: boolean;
  defaultUpdateReason?: string;
  results: MigrateTaskResult[];
}

export interface MigrateTasksDeps {
  taskStore: TaskStore;
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  /** Agent types that are registered AND launchable right now. */
  availableAgentTypes: () => AgentType[];
  /** Live backend liveness probe (NOT the persisted read-model). */
  hasLiveSession: (task: Task) => boolean | Promise<boolean>;
  /** Quiesce an inProgress task with a dead session before continuing it. */
  terminateTask?: (taskId: string) => Promise<void>;
  /** Persist the target as the new default agent (validated + audited + broadcast). */
  setDefaultAgent?: (agent: AgentType) => Promise<{ updated: boolean; reason?: string }>;
  logAudit?: (event: Record<string, unknown>) => void;
  /** Test seams. */
  cwdExists?: (cwd: string) => boolean;
  isGitRepo?: (cwd: string) => Promise<boolean>;
  readWorktree?: (cwd: string, shared: boolean) => Promise<WorktreeState>;
}

/** In-process guard against concurrent double-migrate of the same task. */
const inFlight = new Set<string>();

function newestSession(task: Task): Task['sessions'][number] | undefined {
  return task.sessions.length ? task.sessions[task.sessions.length - 1] : undefined;
}

function taskCwd(task: Task): string | undefined {
  return task.cwd || newestSession(task)?.cwd;
}

async function defaultIsGitRepo(cwd: string): Promise<boolean> {
  return (await gitIn(cwd, 'rev-parse', '--is-inside-work-tree')) === 'true';
}

/**
 * Advisory: is this checkout shared / not a dedicated per-task worktree? Counts
 * only LIVE (non-terminal) peer tasks toward "shared", excluding the candidate
 * itself, so a dedicated worktree reused across a chain of now-completed tasks
 * is not spuriously flagged (which would make `--only-isolated` over-exclude it).
 * A non-worktree checkout is still treated as shared for brief honesty.
 */
function computeWorktreeShared(task: Task, cwd: string, liveCwdCounts: Map<string, number>): boolean {
  const liveHere = liveCwdCounts.get(cwd) ?? 0;
  const selfCounted = isTerminalStatus(task.status) ? 0 : 1;
  const sharedByOthers = liveHere - selfCounted > 0;
  const dedicatedWorktree = newestSession(task)?.gitIsWorktree === true;
  return sharedByOthers || !dedicatedWorktree;
}

function successorIsLive(task: Task, store: TaskStore): boolean {
  if (!task.migratedToTaskId) return false;
  const successor = store.getTask(task.migratedToTaskId);
  return !!successor && !isTerminalStatus(successor.status);
}

interface Candidate {
  task: Task;
  cwd: string;
  worktreeShared: boolean;
}

/**
 * Cheap, I/O-free pre-gate mirroring the non-filesystem checks of
 * {@link classifyMigration} in the same priority order. Lets the caller reject
 * the bulk of the store (completed/open/pending/ralph/same-agent/already-
 * migrated/unavailable-target) WITHOUT running any git subprocess or backend
 * liveness probe. This matters because `GET /api/tasks/migratable` runs over the
 * whole store and the dialog refetches it on every filter change — the expensive
 * probes must never fan out across hundreds of terminal tasks on the request
 * path (issue #1553 "never scan on the request path").
 */
function cheapBlockReason(
  task: Task,
  ctx: { allowCancelled: boolean; targetAvailable: boolean; targetAgent: AgentType; store: TaskStore },
): NotMigratableReason | null {
  if (!isMigratableStatus(task, ctx.allowCancelled)) return 'status_not_migratable';
  if (task.ralphLoop) return 'workflow_owner_unsupported';
  if (successorIsLive(task, ctx.store)) return 'already_migrated';
  if (ctx.targetAgent === task.agentType) return 'same_agent_use_restore';
  if (!ctx.targetAvailable) return 'target_agent_unavailable';
  return null;
}

/**
 * Build the migratability probe for one task/target pair (does the I/O the pure
 * classifier depends on). Only called for tasks that already passed
 * {@link cheapBlockReason}, so the git/liveness probes never run for the
 * rejected bulk. `targetAvailable` is passed in (hoisted, computed once).
 */
async function buildProbe(
  deps: MigrateTasksDeps,
  task: Task,
  targetAgent: AgentType,
  targetAvailable: boolean,
  liveCwdCounts: Map<string, number>,
  includeCancelled: boolean,
): Promise<{ probe: MigrationProbe; cwd?: string }> {
  const cwd = taskCwd(task);
  const cwdExists = deps.cwdExists ?? existsSync;
  const isGitRepo = deps.isGitRepo ?? defaultIsGitRepo;
  const hasCwd = !!cwd;
  const exists = hasCwd ? cwdExists(cwd!) : false;
  const gitUsable = exists ? await isGitRepo(cwd!) : false;
  const worktreeShared = hasCwd ? computeWorktreeShared(task, cwd!, liveCwdCounts) : true;
  const probe: MigrationProbe = {
    targetAgent,
    targetAvailable,
    hasCwd,
    cwdExists: exists,
    gitUsable,
    liveSession: await deps.hasLiveSession(task),
    forkEligibleSameAgent: targetAgent === task.agentType,
    alreadyMigrated: successorIsLive(task, deps.taskStore),
    worktreeShared,
    allowCancelled: includeCancelled,
  };
  return { probe, ...(cwd ? { cwd } : {}) };
}

/** Count LIVE (non-terminal) tasks per cwd — the ones that could actually contend. */
function countLiveCwds(tasks: Task[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (isTerminalStatus(t.status)) continue;
    const cwd = taskCwd(t);
    if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  return counts;
}

/**
 * Resolve the migratable candidate set for a target (used by both the migrate
 * action and the `GET /api/tasks/migratable` preview).
 */
export async function resolveMigratable(
  deps: MigrateTasksDeps,
  targetAgent: AgentType,
  opts: { fromAgent?: AgentType; includeCancelled?: boolean; onlyIsolated?: boolean; taskIds?: string[] } = {},
): Promise<{ eligible: Candidate[]; blocked: MigrateTaskResult[] }> {
  const all = deps.taskStore.getAllTasks();
  const liveCwdCounts = countLiveCwds(all);
  // Hoisted once — not recomputed per task (correctness review #1).
  const targetAvailable = deps.availableAgentTypes().includes(targetAgent);
  const allowCancelled = opts.includeCancelled ?? false;
  const pool = opts.taskIds
    ? opts.taskIds.map((id) => deps.taskStore.getTask(id)).filter((t): t is Task => !!t)
    : all.filter((t) => (opts.fromAgent ? t.agentType === opts.fromAgent : true));

  const eligible: Candidate[] = [];
  const blocked: MigrateTaskResult[] = [];
  // Report ids the caller asked for but that don't exist.
  if (opts.taskIds) {
    const found = new Set(pool.map((t) => t.id));
    for (const id of opts.taskIds) {
      if (!found.has(id)) blocked.push({ taskId: id, outcome: 'blocked', reason: 'not_found' });
    }
  }

  for (const task of pool) {
    // Cheap gate first: reject completed/open/pending/ralph/same-agent/etc.
    // with zero git or liveness I/O, so the request path never fans subprocesses
    // across the terminal-task bulk.
    const cheap = cheapBlockReason(task, { allowCancelled, targetAvailable, targetAgent, store: deps.taskStore });
    if (cheap) {
      blocked.push({ taskId: task.id, outcome: 'blocked', reason: cheap });
      continue;
    }
    // Survivor → now the (bounded) I/O probe is worth running.
    const { probe, cwd } = await buildProbe(deps, task, targetAgent, targetAvailable, liveCwdCounts, allowCancelled);
    const verdict = classifyMigration(task, probe);
    if (!verdict.migratable) {
      blocked.push({ taskId: task.id, outcome: 'blocked', reason: verdict.reason, worktreeShared: verdict.worktreeShared });
      continue;
    }
    if (opts.onlyIsolated && verdict.worktreeShared) {
      blocked.push({ taskId: task.id, outcome: 'blocked', reason: 'worktree_contended', worktreeShared: true });
      continue;
    }
    eligible.push({ task, cwd: cwd!, worktreeShared: verdict.worktreeShared });
  }

  // Per-worktree de-duplication: at most one migration per checkout per call.
  const seenCwd = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of [...eligible].sort((a, b) => b.task.updatedAt.getTime() - a.task.updatedAt.getTime())) {
    if (seenCwd.has(c.cwd)) {
      blocked.push({ taskId: c.task.id, outcome: 'blocked', reason: 'worktree_contended', worktreeShared: c.worktreeShared });
      continue;
    }
    seenCwd.add(c.cwd);
    deduped.push(c);
  }
  return { eligible: deduped, blocked };
}

async function migrateOne(
  deps: MigrateTasksDeps,
  candidate: Candidate,
  targetAgent: AgentType,
  effort: string | undefined,
  model: string | undefined,
): Promise<MigrateTaskResult> {
  const { task, cwd, worktreeShared } = candidate;
  if (inFlight.has(task.id)) {
    return { taskId: task.id, outcome: 'blocked', reason: 'migration_in_progress', worktreeShared };
  }
  inFlight.add(task.id);
  try {
    const readWorktree = deps.readWorktree ?? readWorktreeState;
    const worktree = await readWorktree(cwd, worktreeShared);
    const brief = buildContinuationBrief({ task, targetAgent, worktree });
    const hop: AgentSubstitutionHop = { reason: 'task_migrate', from: task.agentType, to: targetAgent };
    if (effort !== undefined && !isValidLaunchPin(effort)) {
      return { taskId: task.id, outcome: 'blocked', reason: 'invalid_launch_pin', worktreeShared };
    }
    if (model !== undefined && !isValidLaunchPin(model)) {
      return { taskId: task.id, outcome: 'blocked', reason: 'invalid_launch_pin', worktreeShared };
    }
    const effectiveEffort = effort;
    const effectiveModel = model;

    // No deterministic idempotency key (correctness review #2): the migrate path
    // deliberately allows RE-continuing a source once its prior continuation has
    // died (`alreadyMigrated` = live-successor only). A fixed
    // `migrate:<src>:<agent>` key would let the 24h idempotency ledger replay the
    // dead successor and report a false `migrated`. Concurrency is covered by the
    // in-process `inFlight` set; a live successor is covered by `alreadyMigrated`.
    const opts: LaunchOpts = {
      prompt: brief,
      cwd,
      criteria: task.criteria,
      agentType: targetAgent,
      name: task.name ? `Continue: ${task.name}` : undefined,
      migratedFromTaskId: task.id,
      priorAgentSubstitutions: [hop],
      launchSource: 'api',
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(effectiveModel ? { model: effectiveModel } : {}),
    };

    let result: LaunchResult;
    try {
      result = await deps.launchTask(opts);
    } catch (err) {
      if (err instanceof PendingQueueFullError) {
        return { taskId: task.id, outcome: 'blocked', reason: 'queue_full', worktreeShared };
      }
      if (err instanceof SpawnBurstLimitError) {
        return { taskId: task.id, outcome: 'blocked', reason: 'spawn_burst', worktreeShared };
      }
      if (err instanceof EffortValidationError || err instanceof ModelValidationError) {
        // A selected pin is explicit user intent; never retry with an implicit
        // default after the target harness rejects it.
        return { taskId: task.id, outcome: 'blocked', reason: 'invalid_launch_pin', worktreeShared };
      }
      return { taskId: task.id, outcome: 'blocked', reason: 'launch_failed', worktreeShared };
    }

    // Quiesce an interrupted-but-not-terminal source ONLY after a continuation
    // actually launched (correctness review #4): a transient queue_full/
    // spawn_burst rejection must not leave the source terminated under a failed,
    // retryable request. The classifier already guaranteed no live session.
    if (task.status === 'inProgress' && deps.terminateTask) {
      await deps.terminateTask(task.id);
    }

    // Link source → successor (source keeps its own agentType/ledgers).
    deps.taskStore.setMigrationLink(task.id, result.task.id);
    deps.logAudit?.({
      type: 'task_migrated',
      taskId: task.id,
      newTaskId: result.task.id,
      fromAgent: task.agentType,
      toAgent: targetAgent,
      queued: result.queued,
      worktreeShared,
    });
    return {
      taskId: task.id,
      outcome: result.queued ? 'queued' : 'migrated',
      newTaskId: result.task.id,
      worktreeShared,
    };
  } catch {
    return { taskId: task.id, outcome: 'blocked', reason: 'launch_failed', worktreeShared };
  } finally {
    inFlight.delete(task.id);
  }
}

/** Migrate one or many interrupted tasks to a different agent. */
export async function migrateTasks(
  deps: MigrateTasksDeps,
  req: MigrateTasksRequest,
): Promise<MigrateTasksResult> {
  const { scope, targetAgent } = req;
  const resolveOpts =
    scope.kind === 'ids'
      ? // Explicitly naming a task id IS the opt-in to continue it, including a
        // user-cancelled one (the caller selected it deliberately). Batch `all`
        // still requires an explicit includeCancelled so a broad sweep does not
        // resurrect abandoned work.
        { taskIds: scope.taskIds, onlyIsolated: req.onlyIsolated, includeCancelled: true }
      : {
          fromAgent: scope.fromAgent,
          includeCancelled: scope.includeCancelled,
          onlyIsolated: req.onlyIsolated,
        };
  const { eligible, blocked } = await resolveMigratable(deps, targetAgent, resolveOpts);

  const results: MigrateTaskResult[] = [...blocked];
  for (const candidate of eligible) {
    results.push(await migrateOne(deps, candidate, targetAgent, req.effort, req.model));
  }

  // "Set as default" only when the target actually launched something.
  let defaultUpdated = false;
  let defaultUpdateReason: string | undefined;
  const anySuccess = results.some((r) => r.outcome === 'migrated' || r.outcome === 'queued');
  if (req.setAsDefault) {
    if (!deps.setDefaultAgent) {
      defaultUpdateReason = 'not_supported';
    } else if (!anySuccess) {
      defaultUpdateReason = 'no_successful_migration';
    } else {
      const res = await deps.setDefaultAgent(targetAgent);
      defaultUpdated = res.updated;
      if (!res.updated) defaultUpdateReason = res.reason ?? 'rejected';
    }
  }

  deps.logAudit?.({
    type: 'task_migrate_batch',
    targetAgent,
    total: results.length,
    migrated: results.filter((r) => r.outcome === 'migrated').length,
    queued: results.filter((r) => r.outcome === 'queued').length,
    blocked: results.filter((r) => r.outcome === 'blocked').length,
    defaultUpdated,
  });

  return {
    targetAgent,
    defaultUpdated,
    ...(defaultUpdateReason ? { defaultUpdateReason } : {}),
    results,
  };
}
