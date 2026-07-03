import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { WorkspaceBulkRemoveRow } from '../../shared/contracts/workspace.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { resolveWorkspaceContext } from '../use-cases/workspace-context.js';
import { runCrossProjectSweep } from '../use-cases/cross-project-cleanup-sweep.js';
import { bulkRemoveProbablySafeCandidates } from '../use-cases/workspace-cleanup-service.js';
import { reconstructRemovedFromLedger } from '../../core/sweep-report.js';

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
  broadcastToAll?: (msg: ServerMessage) => void;
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
    const publish = (msg: ServerMessage): void => {
      (this.deps.broadcastToAll ?? this.deps.send)(msg);
    };

    const missingDeps = this.missingWorkspaceDeps();
    if (missingDeps.length > 0) {
      publish({
        type: 'workspaceSweepComplete',
        runId: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        projects: [{
          kind: 'skipped',
          projectId: '',
          reason: 'workspace_unavailable',
          missingDeps,
        }],
      });
      return;
    }

    const {
      projectConfigStore,
      attemptRepository,
      policyResolver,
      leaseService,
    } = this.deps;
    if (!projectConfigStore || !attemptRepository || !policyResolver || !leaseService) {
      return;
    }

    try {
      const outcome = await runCrossProjectSweep({
        cleanupDeps: {
          policyResolver,
          leaseService,
          attemptRepository,
        },
        projectConfigStore,
        taskStore: this.deps.taskStore,
        onProgress: (progress) => publish({
          type: 'workspaceSweepProgress',
          ...progress,
        }),
        logger: console,
        resolveRepoPath: async (projectId) => {
          const context = await resolveWorkspaceContext(projectId, {
            taskStore: this.deps.taskStore,
            serverCwd: this.deps.serverCwd,
            serverProjectId: this.deps.serverProjectId,
            projectConfigStore,
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

      publish({
        type: 'workspaceSweepComplete',
        runId: outcome.result.runId,
        startedAt: outcome.result.startedAt,
        finishedAt: outcome.result.finishedAt,
        projects: outcome.result.projects,
        report: outcome.result.report,
      });
    } catch (err) {
      // Defensive: sweep should not throw to the caller, but if it does we
      // still want to surface the failure instead of crashing the handler.
      publish({
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

  /**
   * Probably-safe bulk reclaim (RFC PR 3): remove each selected row's path and
   * KEEP its branch. Broadcasts `workspaceBulkRemoveProgress` per selected row
   * so every connected client sees a determinate bar. The repo path is
   * re-resolved per row via the same `resolveWorkspaceContext` the sweep uses;
   * the keep-branch guarantee is enforced structurally by
   * `bulkRemoveProbablySafeCandidates` (no `deleteBranch` param).
   */
  async handleBulkRemove(rows: WorkspaceBulkRemoveRow[]): Promise<void> {
    const publish = (msg: ServerMessage): void => {
      (this.deps.broadcastToAll ?? this.deps.send)(msg);
    };

    const runId = randomUUID();
    // Clients flip an optimistic `bulkRemoveRunning` before sending, cleared
    // only by a terminal progress event (index >= total). Like the sweep's
    // guaranteed `workspaceSweepComplete`, EVERY exit path here must broadcast a
    // terminal event or the initiating UI is stuck on "Removing…" forever. A
    // 0/0 terminal event satisfies the client's `index >= total` completion gate.
    const emitTerminal = (): void => publish({
      type: 'workspaceBulkRemoveProgress',
      runId,
      index: 0,
      total: 0,
      projectId: '',
      worktreePath: '',
      status: 'skipped',
    });

    const { projectConfigStore, attemptRepository, policyResolver, leaseService } = this.deps;
    if (!this.deps.workspaceEnabled || !projectConfigStore || !attemptRepository || !policyResolver || !leaseService) {
      emitTerminal();
      return;
    }
    if (rows.length === 0) {
      emitTerminal();
      return;
    }

    try {
      await bulkRemoveProbablySafeCandidates(
        { policyResolver, leaseService, attemptRepository },
        {
          rows,
          runId,
          resolveRepoPath: async (projectId) => {
            const context = await resolveWorkspaceContext(projectId, {
              taskStore: this.deps.taskStore,
              serverCwd: this.deps.serverCwd,
              serverProjectId: this.deps.serverProjectId,
              projectConfigStore,
            });
            return context.repoPath;
          },
          onProgress: (event) => publish({ type: 'workspaceBulkRemoveProgress', ...event }),
        },
      );
    } catch {
      // Defensive: bulkRemoveProbablySafeCandidates swallows per-row failures, but
      // an unexpected throw (e.g. a broadcast error) must still release the client.
      emitTerminal();
    }
  }

  /**
   * Reconstruct a completed sweep's Removed / removal-failed manifest from the
   * durable attempt ledger (reconnect-after-completion). No server-side report
   * retention — the ledger rows already exist. Unicast to the requester.
   */
  handleReportRequest(runId: string): void {
    const { attemptRepository } = this.deps;
    if (!attemptRepository || !runId) {
      this.deps.send({ type: 'workspaceSweepReport', runId });
      return;
    }
    const attempts = attemptRepository.listBySweepRunId(runId);
    const report = attempts.length > 0
      ? reconstructRemovedFromLedger(attempts, runId, new Date().toISOString())
      : undefined;
    this.deps.send({ type: 'workspaceSweepReport', runId, report });
  }

  private missingWorkspaceDeps(): string[] {
    const missing: string[] = [];
    if (!this.deps.workspaceEnabled) missing.push('workspaceEnabled');
    if (!this.deps.projectConfigStore) missing.push('projectConfigStore');
    if (!this.deps.attemptRepository) missing.push('attemptRepository');
    if (!this.deps.policyResolver) missing.push('policyResolver');
    if (!this.deps.leaseService) missing.push('leaseService');
    return missing;
  }
}
