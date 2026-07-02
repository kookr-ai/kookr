import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IssueClaimRegistry } from '../core/issue-claim-registry.js';
import type { ClaimTaskPort, ClaimTaskView } from '../core/issue-claim-types.js';
import { projectIdFromRepoSpecifier, projectIdToOwnerRepo } from '../core/project-identity.js';
import type { Task, TaskStore } from '../core/tasks.js';
import { IssueClaimsAuditLog, bindAuditSink } from './issue-claims-audit-log.js';

const execFileAsync = promisify(execFile);

/**
 * Wiring glue for the issue-ownership claim registry (RFC:
 * rfc-issue-ownership-lock). Constructed only when KOOKR_ISSUE_CLAIMS is on
 * (R7): when off, no registry exists, so the lifecycle release calls no-op
 * via optional chaining and the routes return 404.
 */

/** Resolve the feature flag once at startup (restart-gated by design, R7). */
export function isIssueClaimsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KOOKR_ISSUE_CLAIMS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

function toClaimTaskView(task: Task): ClaimTaskView {
  // Latest session cwd doubles as the owner's worktree path for the refusal block.
  const lastSessionCwd = [...task.sessions].reverse().find((s) => s.cwd)?.cwd;
  return {
    id: task.id,
    status: task.status,
    ...(task.name !== undefined ? { name: task.name } : {}),
    ...(task.issueClaim !== undefined ? { issueClaim: task.issueClaim } : {}),
    ...(lastSessionCwd !== undefined ? { worktreePath: lastSessionCwd } : {}),
  };
}

export interface IssueClaimServices {
  registry: IssueClaimRegistry;
  auditLog: IssueClaimsAuditLog;
}

export function createIssueClaimServices(opts: {
  taskStore: TaskStore;
  kookrDir: string;
}): IssueClaimServices {
  const auditLog = new IssueClaimsAuditLog({ kookrDir: opts.kookrDir });
  const port: ClaimTaskPort = {
    // Returns ALL task views; the registry itself filters terminal statuses
    // (it also needs terminal views to count ignored fields on rebuild).
    activeTaskViews: () => opts.taskStore.getAllTasks().map(toClaimTaskView),
    getTaskView: (taskId) => {
      const task = opts.taskStore.getTask(taskId);
      return task ? toClaimTaskView(task) : undefined;
    },
    setIssueClaim: (taskId, claim) => opts.taskStore.setIssueClaim(taskId, claim),
    clearIssueClaim: (taskId) => opts.taskStore.clearIssueClaim(taskId),
  };
  const registry = new IssueClaimRegistry(port, bindAuditSink(auditLog));
  return { registry, auditLog };
}

/**
 * gh-backed fork→parent lookup for {@link resolveClaimRepo}'s explicit-repo
 * mismatch check (RFC R20). Only invoked on the rare path where an explicit
 * `--repo` disagrees with the cwd origin — never on the hot no-flag path
 * (R19 defers automatic upstream resolution). Bounded timeout; failures
 * resolve to null, which the caller treats as a fail-closed mismatch.
 * Definitive results (an upstream, or gh's positive "not a fork") are
 * cached per projectId for the process lifetime — fork parentage does not
 * change mid-run; transient gh failures stay uncached.
 */
export function createUpstreamOfResolver(): (projectId: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (projectId: string): Promise<string | null> => {
    if (cache.has(projectId)) return cache.get(projectId) ?? null;
    const ownerRepo = projectIdToOwnerRepo(projectId);
    if (!ownerRepo) {
      cache.set(projectId, null);
      return null;
    }
    let upstream: string | null = null;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['repo', 'view', `${ownerRepo.owner}/${ownerRepo.repo}`, '--json', 'parent'],
        { timeout: 3000 },
      );
      const parent = (JSON.parse(stdout) as { parent?: { owner?: { login?: string }; name?: string } }).parent;
      if (parent?.owner?.login && parent.name) {
        upstream = projectIdFromRepoSpecifier(`${parent.owner.login}/${parent.name}`);
      }
      // Cache only DEFINITIVE answers (an upstream, or gh's positive
      // "not a fork" = null parent). A transient failure below must not
      // permanently fail-close mismatch checks for this repo.
      cache.set(projectId, upstream);
    } catch {
      upstream = null; // gh unavailable / timeout → fail closed at the caller, uncached
    }
    return upstream;
  };
}
