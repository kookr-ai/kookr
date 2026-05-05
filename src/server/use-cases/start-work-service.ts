/**
 * StartWorkService — thin application wrapper around the existing
 * launch/playbook path for a selected project.
 *
 * V1 Start Work is intentionally thin. It reuses existing launch behavior
 * and only adds project selection, guided framing, and attempt recording.
 */

import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';

export interface StartWorkDeps {
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  attemptRepository: WorkspaceAttemptRepository;
}

export interface StartWorkInput {
  projectId: string;
  /** Repository root path (inferred from selected project). */
  cwd: string;
  /** Task prompt or playbook choice. */
  prompt: string;
  /** Optional issue URL / issue number as extra context. */
  issueRef?: string;
  /** Playbook ID if launching via playbook. */
  playbookId?: string;
}

export interface StartWorkResult {
  launchResult: LaunchResult;
  attemptId: string;
  handoffId: string;
}

/**
 * Launch work for a project via the workspace. This is a thin wrapper
 * that records the attempt and handoff, then delegates to the existing
 * launch path.
 */
export async function startWork(
  deps: StartWorkDeps,
  input: StartWorkInput,
): Promise<StartWorkResult> {
  const { launchTask, attemptRepository } = deps;

  // Build the effective prompt
  let effectivePrompt = input.prompt;
  if (input.issueRef) {
    effectivePrompt = `${input.prompt}\n\nRelated issue: ${input.issueRef}`;
  }

  // Record preflight attempt
  const attempt = attemptRepository.createAttempt({
    type: 'preflight',
    projectId: input.projectId,
    reasonCode: 'start_work',
    source: 'workspace_ui',
    evidenceSummary: `Launching work: ${input.prompt.slice(0, 100)}`,
    correlatedTaskId: undefined,
  });

  try {
    // Delegate to existing launch path
    const launchResult = await launchTask({
      prompt: effectivePrompt,
      cwd: input.cwd,
      playbookId: input.playbookId,
    });

    // Record handoff
    const handoff = attemptRepository.recordHandoff({
      projectId: input.projectId,
      taskId: launchResult.task.id,
      prompt: effectivePrompt,
      playbookId: input.playbookId,
    });

    // Complete the attempt
    attemptRepository.passAttempt(
      attempt.attemptId,
      `Task ${launchResult.task.id} launched${launchResult.queued ? ' (queued)' : ''}`,
    );

    return {
      launchResult,
      attemptId: attempt.attemptId,
      handoffId: handoff.handoffId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    attemptRepository.blockAttempt(attempt.attemptId, `Launch failed: ${message}`);
    throw err;
  }
}
