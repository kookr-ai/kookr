import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCrossProjectSweep, type CrossProjectSweepDeps } from './cross-project-cleanup-sweep.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import type { ProjectConfigStore, ProjectConfig } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';

const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) {
    delete env[name];
  }
  return execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function withoutNestedGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const name of NESTED_GIT_ENV_VARS) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function makeConfigStore(configs: ProjectConfig[]): ProjectConfigStore {
  return {
    getAllConfigs: () => configs,
    getConfig: (p: string) => configs.find((c) => c.project === p),
    setConfig: () => { throw new Error('not used'); },
    removeConfig: () => false,
    load: async () => {},
    save: async () => {},
  } as unknown as ProjectConfigStore;
}

describe('runCrossProjectSweep real git integration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes an actually merged worktree and deletes its branch', async () => withoutNestedGitEnv(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-sweep-real-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    const worktreePath = join(root, 'repo-feature');
    mkdirSync(repoPath);

    git(repoPath, 'init', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'kookr-test@example.com');
    git(repoPath, 'config', 'user.name', 'Kookr Test');
    writeFileSync(join(repoPath, 'README.md'), 'hello\n');
    git(repoPath, 'add', 'README.md');
    git(repoPath, 'commit', '-m', 'initial');
    git(repoPath, 'worktree', 'add', '-b', 'feature/merged', worktreePath, 'main');

    const projectId = `local/${basename(repoPath)}`;
    const deps: CrossProjectSweepDeps = {
      cleanupDeps: {
        attemptRepository: new WorkspaceAttemptRepository(),
        policyResolver: new RepoPolicyResolver(),
        leaseService: new WorktreeLeaseService(),
      },
      projectConfigStore: makeConfigStore([{ project: projectId }]),
      taskStore: { getAllTasks: () => [] } as unknown as TaskStore,
      resolveRepoPath: async () => repoPath,
      lockDir: join(root, 'locks'),
      perProjectTimeoutMs: 10_000,
    };

    const outcome = await runCrossProjectSweep(deps);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    expect(outcome.result.projects).toHaveLength(1);
    const [project] = outcome.result.projects;
    expect(project.kind).toBe('ok');
    if (project.kind !== 'ok') return;

    expect(project.summaries).toEqual([expect.objectContaining({
      branch: 'feature/merged',
      disposition: 'completed',
      pathRemoved: true,
      branchRemoved: true,
    })]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(() => git(repoPath, 'rev-parse', '--verify', 'refs/heads/feature/merged')).toThrow();
  }), 10_000);
});
