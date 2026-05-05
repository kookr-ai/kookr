import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { resolveWorkspaceContext } from '../use-cases/workspace-context.js';
import { runCrossProjectSweep } from '../use-cases/cross-project-cleanup-sweep.js';

/**
 * Routes the `workspace:sweep` client message.
 *
 * Kept separate from workspace-handler.ts because sweep is a long-running
 * cross-project command with a distinct interaction model (single trigger
 * → one completion response) — lumping it into the per-project handler
 * muddied the request/response contract there.
 */
export interface SweepHandlerDeps {
  send: (msg: ServerMessage) => void;
  taskStore: TaskStore;
  serverCwd: string;
  serverProjectId?: string;
  workspaceEnabled?: boolean;
  projectConfigStore?: ProjectConfigStore;
  attemptRepository?: WorkspaceAttemptRepository;
  policyResolver?: RepoPolicyResolver;
  leaseService?: WorktreeLeaseService;
}

export class SweepHandler {
  constructor(private readonly deps: SweepHandlerDeps) {}

  async handle(): Promise<void> {
    if (
      !this.deps.workspaceEnabled
      || !this.deps.projectConfigStore
      || !this.deps.attemptRepository
      || !this.deps.policyResolver
      || !this.deps.leaseService
    ) {
      this.deps.send({
        type: 'workspaceSweepComplete',
        runId: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        projects: [],
      });
      return;
    }

    try {
      const outcome = await runCrossProjectSweep({
        cleanupDeps: {
          policyResolver: this.deps.policyResolver,
          leaseService: this.deps.leaseService,
          attemptRepository: this.deps.attemptRepository,
        },
        projectConfigStore: this.deps.projectConfigStore,
        taskStore: this.deps.taskStore,
        resolveRepoPath: async (projectId) => {
          const context = await resolveWorkspaceContext(projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
          });
          return context.repoPath;
        },
      });

      if (outcome.kind === 'busy') {
        this.deps.send({
          type: 'workspaceSweepBusy',
          holderPid: outcome.holderPid,
          heldSince: outcome.heldSince,
        });
        return;
      }

      this.deps.send({
        type: 'workspaceSweepComplete',
        runId: outcome.result.runId,
        startedAt: outcome.result.startedAt,
        finishedAt: outcome.result.finishedAt,
        projects: outcome.result.projects,
      });
    } catch (err) {
      // Defensive: sweep should not throw to the caller, but if it does we
      // still want to surface the failure instead of crashing the handler.
      this.deps.send({
        type: 'workspaceSweepComplete',
        runId: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        projects: [{
          kind: 'failed',
          projectId: '',
          code: 'error',
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        }],
      });
    }
  }
}
