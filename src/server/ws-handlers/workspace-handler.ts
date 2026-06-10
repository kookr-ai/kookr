import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { TaskStore } from '../../core/tasks.js';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from '../launch-service.js';
import { getWorkspaceView } from '../use-cases/contribution-workspace-query.js';
import { resolveWorkspaceContext } from '../use-cases/workspace-context.js';
import { cleanupSafeWorkspaceCandidates, cleanupWorkspaceCandidate } from '../use-cases/workspace-cleanup-service.js';
import { launchWorkspaceCleanupDiagnostic } from '../use-cases/workspace-cleanup-diagnostic-service.js';
import { getCleanupCandidateDetail } from '../use-cases/workspace-cleanup-detail-query.js';

/**
 * Narrow dependency bag for workspace-family messages.
 *
 * Workspace services (Phase 1a) are all optional — when they're not wired,
 * the handler replies with `error: 'Workspace is not available'` and
 * continues. That's why every workspace collaborator is `?`.
 */
export interface WorkspaceHandlerDeps {
  send: (msg: ServerMessage) => void;
  taskStore: TaskStore;
  serverCwd: string;
  serverProjectId?: string;
  projectConfigStore?: ProjectConfigStore;
  workspaceEnabled?: boolean;
  attemptRepository?: WorkspaceAttemptRepository;
  policyResolver?: RepoPolicyResolver;
  leaseService?: WorktreeLeaseService;
  launchTask?: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
}

type WorkspaceMessage = Extract<ClientMessage, { type: `workspace:${string}` }>;

/** Empty placeholder view used when workspace services are unavailable. */
function unavailableView(projectId: string) {
  return {
    projectId,
    displayName: projectId,
    policy: 'unknown_policy' as const,
    candidates: [],
    recentAttempts: [],
    activeLeases: [],
  };
}

/**
 * Handles `workspace:*` client messages.
 *
 * Each case follows the same shape: guard on feature availability, resolve
 * the repo context, call the underlying use-case, and either broadcast an
 * updated view or send an error-tagged view. Extracted verbatim from the
 * MessageRouter.
 */
export class WorkspaceHandler {
  constructor(private readonly deps: WorkspaceHandlerDeps) {}

  async handle(msg: WorkspaceMessage): Promise<void> {
    switch (msg.type) {
      case 'workspace:getView': {
        if (!this.deps.workspaceEnabled || !this.deps.policyResolver || !this.deps.leaseService || !this.deps.attemptRepository) {
          this.deps.send({
            type: 'workspaceView',
            view: unavailableView(msg.projectId),
            error: 'Workspace is not available',
          });
          return;
        }
        try {
          const context = await resolveWorkspaceContext(msg.projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore: this.deps.projectConfigStore,
          });
          const view = await getWorkspaceView(msg.projectId, context.repoPath, {
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
            attemptRepository: this.deps.attemptRepository,
          });
          this.deps.send({ type: 'workspaceView', view });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.send({
            type: 'workspaceView',
            view: unavailableView(msg.projectId),
            error: message,
          });
        }
        return;
      }

      case 'workspace:getCleanupDetail': {
        if (!this.deps.workspaceEnabled || !this.deps.policyResolver || !this.deps.leaseService) {
          this.deps.send({
            type: 'workspaceCleanupDetail',
            worktreePath: msg.worktreePath,
            error: 'Workspace is not available',
          });
          return;
        }
        try {
          const context = await resolveWorkspaceContext(msg.projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore: this.deps.projectConfigStore,
          });
          const detail = await getCleanupCandidateDetail({
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
          }, {
            projectId: msg.projectId,
            repoPath: context.repoPath,
            worktreePath: msg.worktreePath,
          });
          this.deps.send({
            type: 'workspaceCleanupDetail',
            worktreePath: msg.worktreePath,
            detail,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.deps.send({
            type: 'workspaceCleanupDetail',
            worktreePath: msg.worktreePath,
            error: message,
          });
        }
        return;
      }

      case 'workspace:runCleanupDiagnostic': {
        if (!this.deps.workspaceEnabled || !this.deps.attemptRepository || !this.deps.policyResolver || !this.deps.leaseService || !this.deps.launchTask) {
          this.deps.send({
            type: 'workspaceView',
            view: unavailableView(msg.projectId),
            error: 'Workspace is not available',
          });
          return;
        }
        try {
          const context = await resolveWorkspaceContext(msg.projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore: this.deps.projectConfigStore,
          });
          const result = await launchWorkspaceCleanupDiagnostic({
            attemptRepository: this.deps.attemptRepository,
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
            launchTask: this.deps.launchTask,
          }, {
            projectId: msg.projectId,
            repoPath: context.repoPath,
            worktreePath: msg.worktreePath,
            reviewFingerprint: msg.reviewFingerprint,
          });
          const view = await getWorkspaceView(msg.projectId, context.repoPath, {
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
            attemptRepository: this.deps.attemptRepository,
          });
          this.deps.send({ type: 'workspaceView', view, diagnosticLaunch: result.launch });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.sendViewWithError(msg.projectId, message);
        }
        return;
      }

      case 'workspace:cleanupCandidate': {
        if (!this.deps.workspaceEnabled || !this.deps.attemptRepository || !this.deps.policyResolver || !this.deps.leaseService) {
          this.deps.send({
            type: 'workspaceView',
            view: unavailableView(msg.projectId),
            error: 'Workspace is not available',
          });
          return;
        }
        try {
          const context = await resolveWorkspaceContext(msg.projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore: this.deps.projectConfigStore,
          });
          const result = await cleanupWorkspaceCandidate({
            attemptRepository: this.deps.attemptRepository,
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
          }, {
            projectId: msg.projectId,
            repoPath: context.repoPath,
            worktreePath: msg.worktreePath,
            branch: msg.branch,
            deleteBranch: msg.deleteBranch,
            riskAccepted: msg.riskAccepted,
            discardDirtyState: msg.discardDirtyState,
            reviewFingerprint: msg.reviewFingerprint,
          });
          const view = await getWorkspaceView(msg.projectId, context.repoPath, {
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
            attemptRepository: this.deps.attemptRepository,
          });
          this.deps.send({ type: 'workspaceView', view, cleanupResult: result.summary });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.sendViewWithError(msg.projectId, message);
        }
        return;
      }

      case 'workspace:bulkSafeCleanup': {
        if (!this.deps.workspaceEnabled || !this.deps.attemptRepository || !this.deps.policyResolver || !this.deps.leaseService) {
          this.deps.send({
            type: 'workspaceView',
            view: unavailableView(msg.projectId),
            error: 'Workspace is not available',
          });
          return;
        }
        try {
          const context = await resolveWorkspaceContext(msg.projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore: this.deps.projectConfigStore,
          });
          const result = await cleanupSafeWorkspaceCandidates({
            attemptRepository: this.deps.attemptRepository,
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
          }, {
            projectId: msg.projectId,
            repoPath: context.repoPath,
          });
          const view = await getWorkspaceView(msg.projectId, context.repoPath, {
            policyResolver: this.deps.policyResolver,
            leaseService: this.deps.leaseService,
            attemptRepository: this.deps.attemptRepository,
          });
          this.deps.send({ type: 'workspaceView', view, cleanupResults: result.summaries });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.sendViewWithError(msg.projectId, message);
        }
        return;
      }
    }
  }

  /**
   * Error path used by three workspace mutations: try to fetch the current
   * workspace view one more time and tag it with `error: message`; if that
   * also fails, fall back to the empty-view placeholder. Factored out of
   * the individual case handlers where it was repeated verbatim.
   */
  private async sendViewWithError(projectId: string, message: string): Promise<void> {
    if (!this.deps.policyResolver || !this.deps.leaseService || !this.deps.attemptRepository) {
      this.deps.send({
        type: 'workspaceView',
        view: unavailableView(projectId),
        error: message,
      });
      return;
    }
    try {
      const context = await resolveWorkspaceContext(projectId, {
        taskStore: this.deps.taskStore,
        serverCwd: this.deps.serverCwd,
        serverProjectId: this.deps.serverProjectId,
        projectConfigStore: this.deps.projectConfigStore,
      });
      const view = await getWorkspaceView(projectId, context.repoPath, {
        policyResolver: this.deps.policyResolver,
        leaseService: this.deps.leaseService,
        attemptRepository: this.deps.attemptRepository,
      });
      this.deps.send({ type: 'workspaceView', view, error: message });
    } catch {
      this.deps.send({
        type: 'workspaceView',
        view: unavailableView(projectId),
        error: message,
      });
    }
  }
}
