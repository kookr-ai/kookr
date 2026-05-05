import { basename, dirname, resolve } from 'node:path';
import { gitIn } from '../../core/git-helpers.js';

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

  if (deps.serverProjectId && deps.serverProjectId === projectId) {
    const serverRoot = await resolveCanonicalRepoRoot(deps.serverCwd);
    if (serverRoot) {
      roots.add(serverRoot);
    }
  }

  for (const task of deps.taskStore.getAllTasks()) {
    if (task.projectId !== projectId) continue;

    const taskRoot = await resolveCanonicalRepoRoot(task.cwd);
    if (taskRoot) roots.add(taskRoot);

    for (const session of task.sessions) {
      if (!session.cwd) continue;
      const sessionRoot = await resolveCanonicalRepoRoot(session.cwd);
      if (sessionRoot) roots.add(sessionRoot);
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
