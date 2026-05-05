import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import type { CleanupCandidateDetail, CleanupDiagnosticLaunch } from '../../core/workspace-types.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import { getCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

export interface WorkspaceCleanupDiagnosticDeps {
  policyResolver: RepoPolicyResolver;
  leaseService: WorktreeLeaseService;
  attemptRepository: WorkspaceAttemptRepository;
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
}

export interface WorkspaceCleanupDiagnosticInput {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  reviewFingerprint: string;
}

export interface WorkspaceCleanupDiagnosticResult {
  attemptId: string;
  launch: CleanupDiagnosticLaunch;
}

export async function launchWorkspaceCleanupDiagnostic(
  deps: WorkspaceCleanupDiagnosticDeps,
  input: WorkspaceCleanupDiagnosticInput,
): Promise<WorkspaceCleanupDiagnosticResult> {
  const attempt = deps.attemptRepository.createAttempt({
    type: 'diagnostic',
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    reasonCode: 'cleanup_diagnostic_requested',
    source: 'workspace_ui',
    evidenceSummary: `Requested cleanup diagnostic for ${input.worktreePath}`,
    reviewFingerprint: input.reviewFingerprint,
  });

  try {
    const detail = await getCleanupCandidateDetail({
      policyResolver: deps.policyResolver,
      leaseService: deps.leaseService,
    }, {
      projectId: input.projectId,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
    });

    if (!['dirty', 'unique_commits'].includes(detail.classification)) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Cleanup diagnostics are only available for dirty or unique-commit candidates');
      throw new Error('Cleanup diagnostics are only available for dirty or unique-commit candidates');
    }

    if (detail.fingerprint !== input.reviewFingerprint) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Cleanup diagnostic review is stale; refresh candidate detail and review again');
      throw new Error('Cleanup diagnostic review is stale; refresh candidate detail and review again');
    }

    const launchResult = await deps.launchTask({
      cwd: detail.worktreePath,
      prompt: buildCleanupDiagnosticPrompt(detail),
      name: `Cleanup diagnostic: ${detail.branch}`,
      disableDedup: true,
    });

    deps.attemptRepository.updateAttempt(attempt.attemptId, {
      status: 'passed',
      disposition: 'passed',
      finishedAt: new Date().toISOString(),
      evidenceSummary: `Launched cleanup diagnostic task ${launchResult.task.id}${launchResult.queued ? ' (queued)' : ''}`,
      correlatedTaskId: launchResult.task.id,
    });

    return {
      attemptId: attempt.attemptId,
      launch: {
        worktreePath: detail.worktreePath,
        taskId: launchResult.task.id,
        queued: launchResult.queued,
      },
    };
  } catch (err) {
    if (!deps.attemptRepository.getAttempt(attempt.attemptId)?.finishedAt) {
      const message = err instanceof Error ? err.message : String(err);
      deps.attemptRepository.blockAttempt(attempt.attemptId, `Cleanup diagnostic failed: ${message}`);
    }
    throw err;
  }
}

export function buildCleanupDiagnosticPrompt(detail: CleanupCandidateDetail): string {
  const lines = [
    'Analyze this workspace cleanup candidate and give advisory guidance only.',
    'Do not delete branches, remove worktrees, or make any destructive changes.',
    '',
    `Project: ${detail.projectId}`,
    `Worktree path: ${detail.worktreePath}`,
    `Branch: ${detail.branch}`,
    `Classification: ${detail.classification}`,
    `Reason code: ${detail.reasonCode}`,
    `Review fingerprint: ${detail.fingerprint}`,
  ];

  if (detail.commitSummary) {
    lines.push(
      `Ahead count: ${detail.commitSummary.aheadCount}`,
      `Behind count: ${detail.commitSummary.behindCount}`,
    );
    if (detail.commitSummary.lastCommitSha) {
      lines.push(`Last commit: ${detail.commitSummary.lastCommitSha} ${detail.commitSummary.lastCommitSubject ?? ''}`.trim());
    }
  }

  if (detail.dirtySummary) {
    lines.push(
      `Dirty summary: modified=${detail.dirtySummary.modified}, added=${detail.dirtySummary.added}, deleted=${detail.dirtySummary.deleted}, renamed=${detail.dirtySummary.renamed}, untracked=${detail.dirtySummary.untracked}`,
    );
  }

  if (detail.dirtyFilesSample && detail.dirtyFilesSample.length > 0) {
    lines.push(
      'Dirty file sample:',
      ...detail.dirtyFilesSample.slice(0, 10).map((file) => `${file.status} ${file.path}`),
    );
  }

  lines.push(
    '',
    'Respond with:',
    '1. What the classification implies.',
    '2. The main risks of deleting or keeping this worktree.',
    '3. Concrete next steps for the user.',
    '4. Whether more git inspection is recommended before cleanup.',
  );

  return lines.join('\n');
}
