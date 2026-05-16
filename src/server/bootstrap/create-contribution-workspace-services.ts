import { join } from 'node:path';

import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { TaskStore } from '../../core/tasks.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { getProjectId } from '../../core/project-identity.js';

export interface ContributionWorkspaceServicesDeps {
  kookrDir: string;
  serverCwd: string;
  taskStore: TaskStore;
  log?: (message: string) => void;
}

export interface ContributionWorkspaceServices {
  leaseService: WorktreeLeaseService;
  serverProjectId: string;
  policyResolver: RepoPolicyResolver;
  attemptRepository: WorkspaceAttemptRepository;
}

export async function createContributionWorkspaceServices(
  deps: ContributionWorkspaceServicesDeps,
): Promise<ContributionWorkspaceServices> {
  const leaseService = new WorktreeLeaseService();
  const serverProjectId = await getProjectId(deps.serverCwd);
  const policyResolver = new RepoPolicyResolver({ serverProjectId });
  const attemptRepository = new WorkspaceAttemptRepository(join(deps.kookrDir, 'workspace-attempts.json'));

  const leaseReconciliation = leaseService.reconcileFromTaskStore(deps.taskStore);
  if (leaseReconciliation.backfilled > 0 || leaseReconciliation.released > 0) {
    (deps.log ?? console.log)(
      `[workspace] Lease reconciliation: backfilled=${leaseReconciliation.backfilled} released=${leaseReconciliation.released}`,
    );
  }

  return {
    leaseService,
    serverProjectId,
    policyResolver,
    attemptRepository,
  };
}
