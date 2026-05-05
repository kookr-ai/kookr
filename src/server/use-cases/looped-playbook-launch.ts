import { detectStandalonePlugin } from '../../core/ralph-plugin-coexistence.js';
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

export async function launchLoopedPlaybook(
  deps: LaunchLoopedPlaybookDeps,
  input: LaunchLoopedPlaybookInput,
): Promise<LaunchResult> {
  const prepared = await preparePlaybookLaunchWithMetadata(input);
  validateLoopablePlaybook(prepared);

  const coexistence = await detectStandalonePlugin(prepared.launchOpts.cwd);
  if (coexistence.detected) {
    throw new LoopedPlaybookLaunchError(
      'standalone ralph-wiggum plugin detected — would double-fire on Stop',
      409,
      {
        matchedFiles: coexistence.matchedFiles,
        reasons: coexistence.reasons,
      },
    );
  }

  const key = loopedPlaybookKey(prepared);
  if (inFlightLoopedPlaybooks.has(key)) {
    throw new LoopedPlaybookLaunchError('matching looped playbook launch is already in progress', 409);
  }

  inFlightLoopedPlaybooks.add(key);
  try {
    const maxActiveTasks = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
    if (deps.taskStore.getActiveCount() >= maxActiveTasks) {
      throw new LoopedPlaybookLaunchError(
        'cannot start looped playbook while the task queue is full; wait for an active task to finish and try again',
        409,
      );
    }

    const duplicate = findActiveLoopedPlaybook(deps.taskStore, key);
    if (duplicate) {
      throw new LoopedPlaybookLaunchError(
        `matching looped playbook task already exists: ${duplicate.id}`,
        409,
        { taskId: duplicate.id },
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
        result.task.ralphLoop.status = 'failed';
        result.task.updatedAt = new Date();
      }
      await deps.cleanupFailedTask?.(result.task.id);
      throw err;
    }

    return result;
  } finally {
    inFlightLoopedPlaybooks.delete(key);
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
