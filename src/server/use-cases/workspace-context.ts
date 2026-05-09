import { basename, dirname, resolve } from 'node:path';
import { gitIn } from '../../core/git-helpers.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import { getProjectId } from '../../core/project-identity.js';

interface TaskSessionLike {
  cwd?: string;
}

interface TaskLike {
  projectId?: string;
  cwd: string;
  sessions: TaskSessionLike[];
}

export interface WorkspaceContextDeps {
  taskStore: { getAllTasks(): TaskLike[] };
  serverCwd: string;
  serverProjectId?: string;
  projectConfigStore?: Pick<ProjectConfigStore, 'getConfig'>;
}

export interface WorkspaceContext {
  projectId: string;
  repoPath: string;
}

/**
 * Resolve the authoritative main checkout for a project.
 * For linked worktrees, this prefers git-common-dir so the workspace operates
 * on the shared repository root rather than an arbitrary linked checkout.
 */
export async function resolveWorkspaceContext(
  projectId: string,
  deps: WorkspaceContextDeps,
): Promise<WorkspaceContext> {
  const roots = new Set<string>();

  const localPath = deps.projectConfigStore?.getConfig(projectId)?.localPath;
  if (localPath) {
    await addMatchingRepoRoot(roots, projectId, localPath);
  }

  if (deps.serverProjectId && deps.serverProjectId === projectId) {
    await addMatchingRepoRoot(roots, projectId, deps.serverCwd);
  }

  for (const task of deps.taskStore.getAllTasks()) {
    if (task.projectId !== projectId) continue;

    await addMatchingRepoRoot(roots, projectId, task.cwd);

    for (const session of task.sessions) {
      if (!session.cwd) continue;
      await addMatchingRepoRoot(roots, projectId, session.cwd);
    }
  }

  if (roots.size === 1) {
    return { projectId, repoPath: Array.from(roots)[0] };
  }

  if (roots.size === 0) {
    throw new Error(`Unable to determine repository root for ${projectId}`);
  }

  throw new Error(`Multiple repository roots found for ${projectId}`);
}

async function addMatchingRepoRoot(roots: Set<string>, projectId: string, path: string): Promise<void> {
  const root = await resolveCanonicalRepoRoot(path);
  if (!root) return;

  if (projectId.startsWith('local/')) {
    roots.add(root);
    return;
  }

  const currentProjectId = await getProjectId(root);
  if (currentProjectId === projectId) {
    roots.add(root);
  }
}

async function resolveCanonicalRepoRoot(path: string): Promise<string | null> {
  const commonDir = await gitIn(path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (commonDir) {
    const trimmed = commonDir.trim();
    if (basename(trimmed) === '.git') {
      return resolve(dirname(trimmed));
    }
    return resolve(trimmed);
  }

  const toplevel = await gitIn(path, 'rev-parse', '--show-toplevel');
  return toplevel ? resolve(toplevel) : null;
}
