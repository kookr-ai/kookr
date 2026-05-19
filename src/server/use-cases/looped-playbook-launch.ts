import { detectStandalonePlugin, type CoexistenceResult } from '../../core/ralph-plugin-coexistence.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import type { RalphLoopRequest, RalphLoopService } from '../ralph-loop-service.js';
import { canonicalizeCwd, type LaunchOpts, type LaunchResult } from '../launch-service.js';
import { MAX_ACTIVE_TASKS } from '../config.js';
import {
  preparePlaybookLaunchWithMetadata,
  type PreparePlaybookLaunchInput,
  type PreparedPlaybookLaunch,
} from './playbook-launch.js';

const inFlightLoopedPlaybooks = new Set<string>();
const ACTIVE_TASK_STATUSES = new Set(['open', 'pending', 'inProgress']);
const ACTIVE_RALPH_STATUSES = new Set(['running', 'paused']);

export class LoopedPlaybookLaunchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 | 500 = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LoopedPlaybookLaunchError';
  }
}

export interface LaunchLoopedPlaybookDeps {
  taskStore: TaskStore;
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  ralphLoopService: RalphLoopService;
  cleanupFailedTask?: (taskId: string) => Promise<void>;
  getMaxActiveTasks?: () => number;
}

export interface LaunchLoopedPlaybookInput extends PreparePlaybookLaunchInput {
  launchSource?: 'cli' | 'ui' | 'api';
}

export interface ReplaceLoopedPlaybookDeps extends LaunchLoopedPlaybookDeps {
  /**
   * Cancels the runtime + loop attached to the replaced task. Called once,
   * synchronously, before the new launch begins. Must terminate the dtach
   * session and flip `task.status = 'cancelled'`. The replace flow aborts
   * with HTTP 500 if this throws — partial state is worse than the user
   * retrying.
   */
  cancelReplacedTask: (taskId: string) => Promise<void>;
  /**
   * Best-effort audit hook called after the new task has launched
   * successfully. Failure is logged but does not fail the request.
   */
  writeReplaceAudit?: (info: {
    replacedTaskId: string;
    newTaskId: string;
    oldIteration: number;
    playbookPath: string;
    cwd: string;
    source: 'cli' | 'ui' | 'api';
  }) => Promise<void>;
}

export interface ReplaceLoopedPlaybookInput extends LaunchLoopedPlaybookInput {
  /** The task whose loop is being replaced. Must match the supplied key. */
  replacedTaskId: string;
}

export interface ReplaceLoopedPlaybookResult {
  result: LaunchResult;
  replacedTaskId: string;
  oldIteration: number;
}

export async function launchLoopedPlaybook(
  deps: LaunchLoopedPlaybookDeps,
  input: LaunchLoopedPlaybookInput,
): Promise<LaunchResult> {
  const prepared = await preparePlaybookLaunchWithMetadata(input);
  validateLoopablePlaybook(prepared);

  const key = loopedPlaybookKey(prepared);
  if (inFlightLoopedPlaybooks.has(key)) {
    throw new LoopedPlaybookLaunchError('matching looped playbook launch is already in progress', 409);
  }

  inFlightLoopedPlaybooks.add(key);
  try {
    const duplicate = findActiveLoopedPlaybook(deps.taskStore, key);
    if (duplicate) {
      throw new LoopedPlaybookLaunchError(
        `matching looped playbook task already exists: ${duplicate.id}`,
        409,
        {
          taskId: duplicate.id,
          conflictKind: 'duplicate_active_loop',
          ralphLoop: duplicate.ralphLoop
            ? {
                status: duplicate.ralphLoop.status,
                currentIteration: duplicate.ralphLoop.currentIteration,
                lastIterationStartedAt: duplicate.ralphLoop.lastIterationStartedAt,
              }
            : null,
        },
      );
    }

    const coexistence = await detectStandalonePlugin(prepared.launchOpts.cwd);
    if (coexistence.detected) {
      throw new LoopedPlaybookLaunchError(
        'standalone ralph-wiggum plugin detected — would double-fire on Stop',
        409,
        standalonePluginConflictDetails(coexistence),
      );
    }

    const maxActiveTasks = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
    if (deps.taskStore.getActiveCount() >= maxActiveTasks) {
      throw new LoopedPlaybookLaunchError(
        'cannot start looped playbook while the task queue is full; wait for an active task to finish and try again',
        409,
      );
    }

    const effectiveLoop = prepared.playbook.effectiveLoop;
    if (!effectiveLoop) {
      throw new LoopedPlaybookLaunchError('playbook does not have valid loop defaults', 400);
    }
    const loopPrompt = buildLoopedPlaybookRuntimePrompt(
      prepared.launchOpts.prompt,
      effectiveLoop.iterationCap,
    );
    const result = await deps.launchTask({
      ...prepared.launchOpts,
      prompt: loopPrompt,
      disableDedup: true,
      launchSource: input.launchSource,
      // PR4: inject RALPH_VERDICT_FILE on iteration 0 so the agent's first
      // launch can write a verdict. Subsequent iterations get this via
      // launchFreshRuntime's extraEnv. Without this, iteration 0 silently
      // misses the verdict channel and the engine treats it as legacy
      // `continued`. Applies to BOTH launch and replace flows in this file.
      ralphVerdictEnv: true,
    });
    if (result.queued) {
      await deps.cleanupFailedTask?.(result.task.id);
      throw new LoopedPlaybookLaunchError(
        'cannot start looped playbook while the task queue is full; wait for an active task to finish and try again',
        409,
      );
    }

    try {
      await deps.ralphLoopService.startLoop(result.task, buildPlaybookRalphLoopRequest(prepared, loopPrompt));
    } catch (err) {
      if (result.task.ralphLoop) {
        deps.taskStore.setRalphLoopStatus(result.task.id, 'failed');
      }
      await deps.cleanupFailedTask?.(result.task.id);
      throw err;
    }

    return result;
  } finally {
    inFlightLoopedPlaybooks.delete(key);
  }
}

/**
 * Cancel the loop attached to `replacedTaskId` and launch a fresh one with
 * the supplied playbook+cwd+params. The in-flight key is held across both
 * steps so concurrent replace/launch calls for the same key serialize.
 *
 * Failure modes:
 *  - `replacedTaskId` not found / terminal / no ralphLoop → 400 / 404.
 *  - Key built from input does not match key built from stored task →
 *    400 (`replacedTaskId_key_mismatch`). Catches the user-edited-a-param
 *    case where the dialog is stale relative to the form.
 *  - `cancelReplacedTask` throws → 500 (`lifecycle_cancel_failed`); no
 *    launch attempted (avoids two agents in the same cwd).
 *  - Concurrent replace already in flight for this key → 409
 *    (`replace_already_in_progress`).
 */
export async function replaceLoopedPlaybook(
  deps: ReplaceLoopedPlaybookDeps,
  input: ReplaceLoopedPlaybookInput,
): Promise<ReplaceLoopedPlaybookResult> {
  const oldTask = deps.taskStore.getTask(input.replacedTaskId);
  if (!oldTask) {
    throw new LoopedPlaybookLaunchError(
      `replacedTaskId not found: ${input.replacedTaskId}`,
      400,
      { code: 'replacedTaskId_not_found', replacedTaskId: input.replacedTaskId },
    );
  }
  if (!oldTask.ralphLoop) {
    throw new LoopedPlaybookLaunchError(
      `task ${input.replacedTaskId} has no Ralph loop attached`,
      400,
      { code: 'replacedTaskId_no_loop', replacedTaskId: input.replacedTaskId },
    );
  }
  if (oldTask.status === 'completed' || oldTask.status === 'cancelled' || oldTask.status === 'terminated') {
    throw new LoopedPlaybookLaunchError(
      `task ${input.replacedTaskId} is in terminal status (${oldTask.status}); nothing to replace`,
      400,
      { code: 'replacedTaskId_terminal', replacedTaskId: input.replacedTaskId, status: oldTask.status },
    );
  }

  const prepared = await preparePlaybookLaunchWithMetadata(input);
  validateLoopablePlaybook(prepared);

  const inputKey = loopedPlaybookKey(prepared);
  const storedKey = loopedPlaybookKeyForTask(oldTask);
  if (storedKey !== inputKey) {
    throw new LoopedPlaybookLaunchError(
      'replacedTaskId does not match the supplied playbook+cwd+parameters',
      400,
      { code: 'replacedTaskId_key_mismatch', replacedTaskId: input.replacedTaskId },
    );
  }

  if (inFlightLoopedPlaybooks.has(inputKey)) {
    throw new LoopedPlaybookLaunchError(
      'matching looped playbook launch is already in progress',
      409,
      { code: 'replace_already_in_progress' },
    );
  }

  inFlightLoopedPlaybooks.add(inputKey);
  const oldIteration = oldTask.ralphLoop.currentIteration;

  try {
    // Detect the standalone ralph-wiggum plugin in the cwd. The launch path
    // does this too (line 53). The replace path is the exact moment the
    // user re-enters a possibly-misconfigured cwd, so the same guard
    // applies — a coexistence we missed on launch would now double-fire on
    // every Stop after the new loop launches.
    const coexistence = await detectStandalonePlugin(prepared.launchOpts.cwd);
    if (coexistence.detected) {
      throw new LoopedPlaybookLaunchError(
        'standalone ralph-wiggum plugin detected — would double-fire on Stop',
        409,
        standalonePluginConflictDetails(coexistence),
      );
    }

    // Flip loop.status='cancelled' BEFORE killing the runtime. Otherwise a
    // buffered Stop event from the dying session reaches the cycler with
    // loop.status still 'running' and the cycler spawns iteration N+1
    // against a doomed session. Mirrors the precedent in
    // src/server/ws-handlers/lifecycle-handler.ts. cancelLoop is idempotent.
    deps.ralphLoopService.cancelLoop(oldTask);

    // Cancel the old runtime synchronously. If this throws, abort —
    // launching a new agent over a half-killed runtime risks two agents
    // writing the same cwd.
    try {
      await deps.cancelReplacedTask(input.replacedTaskId);
    } catch (err) {
      throw new LoopedPlaybookLaunchError(
        `lifecycle cancel failed for replaced task ${input.replacedTaskId}: ${err instanceof Error ? err.message : String(err)}`,
        500,
        { code: 'lifecycle_cancel_failed', replacedTaskId: input.replacedTaskId },
      );
    }

    const effectiveLoop = prepared.playbook.effectiveLoop;
    if (!effectiveLoop) {
      throw new LoopedPlaybookLaunchError('playbook does not have valid loop defaults', 400);
    }
    const loopPrompt = buildLoopedPlaybookRuntimePrompt(prepared.launchOpts.prompt, effectiveLoop.iterationCap);

    const maxActiveTasks = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
    if (deps.taskStore.getActiveCount() >= maxActiveTasks) {
      throw new LoopedPlaybookLaunchError(
        'cannot start looped playbook while the task queue is full; wait for an active task to finish and try again',
        409,
      );
    }

    const result = await deps.launchTask({
      ...prepared.launchOpts,
      prompt: loopPrompt,
      disableDedup: true,
      launchSource: input.launchSource,
      // PR4: inject RALPH_VERDICT_FILE on iteration 0 so the agent's first
      // launch can write a verdict. Subsequent iterations get this via
      // launchFreshRuntime's extraEnv. Without this, iteration 0 silently
      // misses the verdict channel and the engine treats it as legacy
      // `continued`. Applies to BOTH launch and replace flows in this file.
      ralphVerdictEnv: true,
    });
    if (result.queued) {
      await deps.cleanupFailedTask?.(result.task.id);
      throw new LoopedPlaybookLaunchError(
        'cannot start looped playbook while the task queue is full; wait for an active task to finish and try again',
        409,
      );
    }

    try {
      await deps.ralphLoopService.startLoop(result.task, buildPlaybookRalphLoopRequest(prepared, loopPrompt));
    } catch (err) {
      if (result.task.ralphLoop) {
        deps.taskStore.setRalphLoopStatus(result.task.id, 'failed');
      }
      await deps.cleanupFailedTask?.(result.task.id);
      throw err;
    }

    if (deps.writeReplaceAudit) {
      try {
        await deps.writeReplaceAudit({
          replacedTaskId: input.replacedTaskId,
          newTaskId: result.task.id,
          oldIteration,
          playbookPath: input.playbookPath,
          cwd: prepared.launchOpts.cwd,
          source: input.launchSource ?? 'api',
        });
      } catch (err) {
        console.warn(
          `[ralph-replace] audit write failed for replacedTaskId=${input.replacedTaskId}:`,
          err,
        );
      }
    }

    return { result, replacedTaskId: input.replacedTaskId, oldIteration };
  } finally {
    inFlightLoopedPlaybooks.delete(inputKey);
  }
}

export function buildPlaybookRalphLoopRequest(
  prepared: PreparedPlaybookLaunch,
  prompt = prepared.launchOpts.prompt,
): RalphLoopRequest {
  const effectiveLoop = prepared.playbook.effectiveLoop;
  if (!effectiveLoop) {
    throw new LoopedPlaybookLaunchError('playbook does not have valid loop defaults', 400);
  }

  return {
    prompt,
    iterationCap: effectiveLoop.iterationCap,
    ...(effectiveLoop.stopPredicate !== undefined
      ? { stopPredicate: effectiveLoop.stopPredicate }
      : {}),
    ...(effectiveLoop.zeroDiffConsecutiveIterations !== undefined
      ? {
          zeroDiffConvergence: {
            consecutiveIterations: effectiveLoop.zeroDiffConsecutiveIterations,
          },
        }
      : {}),
    ...(effectiveLoop.costCapUsd !== undefined ? { costCapUsd: effectiveLoop.costCapUsd } : {}),
  };
}

function buildLoopedPlaybookRuntimePrompt(prompt: string, iterationCap: number): string {
  return [
    '<kookr_ralph_loop_runtime>',
    `This playbook is running inside a Kookr Ralph loop with an iteration cap of ${iterationCap}.`,
    'This runtime is one loop iteration, not the whole loop.',
    'At the start, read the durable state required by the playbook.',
    'If the durable state is already terminal, only perform the terminal acknowledgement/completion step and stop.',
    'Otherwise, complete at most one missing phase or one small unit of work, persist progress, then stop.',
    'Do not continue into a second phase or second unit of work in this runtime.',
    'Only call the Kookr Ralph completion endpoint after the playbook terminal criteria are satisfied.',
    '</kookr_ralph_loop_runtime>',
    '',
    prompt,
  ].join('\n');
}

export function loopedPlaybookKey(prepared: PreparedPlaybookLaunch): string {
  return stableLoopedPlaybookKey({
    playbookId: prepared.playbook.id,
    cwd: prepared.launchOpts.cwd,
    parameterValues: prepared.launchOpts.playbookParameterValues ?? {},
  });
}

/**
 * Derive the duplicate-detection key from a stored task. Used by the replace
 * endpoint to confirm that the user-supplied `replacedTaskId` matches the
 * playbook+cwd+params the user is about to launch with — guards against a
 * stale dialog where the user has edited a parameter since the 409 fired.
 */
export function loopedPlaybookKeyForTask(task: Task): string | null {
  if (!task.playbookId) return null;
  return stableLoopedPlaybookKey({
    playbookId: task.playbookId,
    cwd: task.cwd,
    parameterValues: task.playbookParameterValues ?? {},
  });
}

function validateLoopablePlaybook(prepared: PreparedPlaybookLaunch): void {
  const { playbook } = prepared;
  if (!playbook.tags.includes('loopable')) {
    throw new LoopedPlaybookLaunchError(
      `Playbook "${playbook.name}" is not tagged loopable; run it normally or add loopable metadata after reviewing loop safety.`,
      400,
    );
  }
  if (playbook.loopValidationError) {
    throw new LoopedPlaybookLaunchError(playbook.loopValidationError, 400);
  }
  if (!playbook.effectiveLoop) {
    throw new LoopedPlaybookLaunchError('playbook does not have valid loop defaults', 400);
  }
}

function standalonePluginConflictDetails(coexistence: CoexistenceResult): Record<string, unknown> {
  return {
    conflictKind: 'standalone_ralph_plugin',
    code: 'standalone_ralph_plugin_detected',
    matchedFiles: coexistence.matchedFiles,
    reasons: coexistence.reasons,
  };
}

function findActiveLoopedPlaybook(taskStore: TaskStore, key: string): Task | undefined {
  for (const task of taskStore.listTasks()) {
    if (!ACTIVE_TASK_STATUSES.has(task.status)) continue;
    if (!task.ralphLoop || !ACTIVE_RALPH_STATUSES.has(task.ralphLoop.status)) continue;
    if (!task.playbookId) continue;
    const candidateKey = stableLoopedPlaybookKey({
      playbookId: task.playbookId,
      cwd: task.cwd,
      parameterValues: task.playbookParameterValues ?? {},
    });
    if (candidateKey === key) return task;
  }
  return undefined;
}

function stableLoopedPlaybookKey(input: {
  playbookId: string;
  cwd: string;
  parameterValues: Record<string, string>;
}): string {
  return JSON.stringify({
    playbookId: input.playbookId,
    cwd: canonicalizeCwd(input.cwd),
    parameterValues: Object.fromEntries(
      Object.entries(input.parameterValues).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}
