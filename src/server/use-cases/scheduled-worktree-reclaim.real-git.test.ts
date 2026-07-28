import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runScheduledWorktreeReclaim,
  type ScheduledReclaimDeps,
} from './scheduled-worktree-reclaim.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { PROTECTED_MARKER } from '../../shared/contracts/worktree-protection.js';
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
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
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

interface Fixture {
  repoPath: string;
  projectId: string;
  paths: Record<string, string>;
  deps: ScheduledReclaimDeps;
  auditRows: Array<Record<string, unknown>>;
}

/**
 * Build a repo with one worktree per classification / exclude case so a single
 * reclaim pass exercises every branch of the decision tree.
 */
function setupFixture(root: string): Fixture {
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'kookr-test@example.com');
  git(repoPath, 'config', 'user.name', 'Kookr Test');
  writeFileSync(join(repoPath, 'README.md'), 'hello\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '-m', 'initial');

  const paths: Record<string, string> = {
    merged: join(root, 'repo-merged'),
    dirty: join(root, 'repo-dirty'),
    ahead: join(root, 'repo-ahead'),
    prod: join(root, 'kookr-prod'),
    marked: join(root, 'repo-pr-host'),
    protectedBranch: join(root, 'repo-develop'),
  };

  // Safe (merged): branch at main tip, clean.
  git(repoPath, 'worktree', 'add', '-b', 'feature/merged', paths.merged, 'main');

  // Dirty: uncommitted change → classification `dirty`.
  git(repoPath, 'worktree', 'add', '-b', 'feature/dirty', paths.dirty, 'main');
  writeFileSync(join(paths.dirty, 'scratch.txt'), 'wip\n');

  // Ahead (open-PR style): a local-only commit → classification `unique_commits`.
  git(repoPath, 'worktree', 'add', '-b', 'feature/ahead', paths.ahead, 'main');
  writeFileSync(join(paths.ahead, 'feature.txt'), 'work\n');
  git(paths.ahead, 'add', 'feature.txt');
  git(paths.ahead, 'commit', '-m', 'ahead commit');

  // Hard exclude — kookr-prod: merged content, but the legacy prod basename.
  git(repoPath, 'worktree', 'add', '-b', 'feature/prod', paths.prod, 'main');

  // Hard exclude — PR-hosting worktree pinned by the `.kookr-protected` marker.
  git(repoPath, 'worktree', 'add', '-b', 'feature/pr-host', paths.marked, 'main');
  writeFileSync(join(paths.marked, PROTECTED_MARKER), 'hosting open PR #123\n');

  // Hard exclude — protected branch (`develop`), merged content otherwise.
  git(repoPath, 'worktree', 'add', '-b', 'develop', paths.protectedBranch, 'main');

  const projectId = `local/${basename(repoPath)}`;
  const auditRows: Array<Record<string, unknown>> = [];
  const deps: ScheduledReclaimDeps = {
    cleanupDeps: {
      attemptRepository: new WorkspaceAttemptRepository(),
      policyResolver: new RepoPolicyResolver(),
      leaseService: new WorktreeLeaseService(),
    },
    projectConfigStore: makeConfigStore([{ project: projectId } as ProjectConfig]),
    taskStore: { getAllTasks: () => [] } as unknown as TaskStore,
    resolveRepoPath: async () => repoPath,
    fetchBeforeClassify: false,
    appendAudit: async (_path, row) => { auditRows.push(row); },
  };

  return { repoPath, projectId, paths, deps, auditRows };
}

function actionFor(result: { worktrees: Array<{ worktreePath: string; action: string; excludeReason?: string }> }, path: string) {
  return result.worktrees.find((w) => w.worktreePath === path);
}

describe('runScheduledWorktreeReclaim (real git)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('dry-run lists safe candidates without removing anything', async () => withoutNestedGitEnv(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-reclaim-dry-'));
    roots.push(root);
    const fx = setupFixture(root);

    const result = await runScheduledWorktreeReclaim(fx.deps, { dryRun: true, runId: 'dry-1' });

    expect(actionFor(result, fx.paths.merged)?.action).toBe('would_remove');
    expect(result.wouldRemoveCount).toBe(1);
    expect(result.removedCount).toBe(0);

    // Nothing is touched in dry-run.
    for (const path of Object.values(fx.paths)) {
      expect(existsSync(path)).toBe(true);
    }

    // Every considered worktree produced an audit row + a run-summary row.
    const considered = fx.auditRows.filter((r) => r.event === 'worktree_reclaim_considered');
    expect(considered.length).toBe(result.consideredCount);
    expect(considered.every((r) => typeof r.classification === 'string' && typeof r.action === 'string')).toBe(true);
    expect(fx.auditRows.some((r) => r.event === 'worktree_reclaim_run' && r.dryRun === true)).toBe(true);
  }), 20_000);

  it('live run removes the safe path and KEEPS its branch', async () => withoutNestedGitEnv(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-reclaim-live-'));
    roots.push(root);
    const fx = setupFixture(root);

    const result = await runScheduledWorktreeReclaim(fx.deps, { dryRun: false, runId: 'live-1' });

    expect(actionFor(result, fx.paths.merged)?.action).toBe('removed');
    expect(result.removedCount).toBe(1);
    expect(existsSync(fx.paths.merged)).toBe(false);
    // Branch is KEPT (remove-path/keep-branch).
    expect(() => git(fx.repoPath, 'rev-parse', '--verify', 'refs/heads/feature/merged')).not.toThrow();
  }), 20_000);

  it('never removes dirty or classification-ambiguous worktrees', async () => withoutNestedGitEnv(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-reclaim-unsafe-'));
    roots.push(root);
    const fx = setupFixture(root);

    const result = await runScheduledWorktreeReclaim(fx.deps, { dryRun: false, runId: 'unsafe-1' });

    expect(actionFor(result, fx.paths.dirty)?.action).toBe('skipped_unsafe');
    expect(actionFor(result, fx.paths.ahead)?.action).toBe('skipped_unsafe');
    expect(existsSync(fx.paths.dirty)).toBe(true);
    expect(existsSync(fx.paths.ahead)).toBe(true);
  }), 20_000);

  it('hard-excludes kookr-prod, .kookr-protected (PR-hosting), and protected branches', async () => withoutNestedGitEnv(async () => {
    const root = mkdtempSync(join(tmpdir(), 'kookr-reclaim-excl-'));
    roots.push(root);
    const fx = setupFixture(root);

    const result = await runScheduledWorktreeReclaim(fx.deps, { dryRun: false, runId: 'excl-1' });

    const prod = actionFor(result, fx.paths.prod);
    expect(prod?.action).toBe('skipped_excluded');
    expect(prod?.excludeReason).toBe('kookr_prod');

    const marked = actionFor(result, fx.paths.marked);
    expect(marked?.action).toBe('skipped_excluded');
    expect(marked?.excludeReason).toBe('protected_marker');

    const dev = actionFor(result, fx.paths.protectedBranch);
    expect(dev?.action).toBe('skipped_excluded');
    expect(dev?.excludeReason).toBe('protected_branch');

    // All three excluded paths survive.
    expect(existsSync(fx.paths.prod)).toBe(true);
    expect(existsSync(fx.paths.marked)).toBe(true);
    expect(existsSync(fx.paths.protectedBranch)).toBe(true);
  }), 20_000);
});
