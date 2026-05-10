import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { buildAgentLaunchContext } from './agent-launch-context.js';

describe('agent-launch-context', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('injects task and API context for child-task workflows', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: child.id,
      cwd: repoDir,
      serverPort: 4801,
    });

    expect(context.env).toEqual({
      KOOKR_TASK_ID: child.id,
      KOOKR_PARENT_TASK_ID: parent.id,
      KOOKR_PORT: '4801',
      KOOKR_API_BASE_URL: 'http://127.0.0.1:4801',
      KOOKR_GIT_COMMON_DIR: join(repoDir, '.git'),
    });
    expect(context.permissionAllowlist).toEqual([
      'Bash(git *)',
      'Bash(curl *KOOKR_API_BASE_URL*api/tasks*)',
      'Bash(curl *http://127.0.0.1:4801/api/tasks*)',
      'Bash(curl *http://localhost:4801/api/tasks*)',
      `Read(//${join(repoDir, '.git').slice(1)}/**)`,
      `Write(//${join(repoDir, '.git').slice(1)}/**)`,
    ]);
  });

  test('maps linked worktrees back to the shared git common dir', async () => {
    const rootDir = makeTempDir();
    const mainGitDir = join(rootDir, 'repo', '.git');
    const worktreeDir = join(rootDir, 'repo-worktree');
    mkdirSync(join(mainGitDir, 'worktrees', 'issue-231'), { recursive: true });
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, '.git'),
      `gitdir: ${join(mainGitDir, 'worktrees', 'issue-231')}\n`,
    );

    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix issue', worktreeDir);
    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: worktreeDir,
    });

    expect(context.env.KOOKR_GIT_COMMON_DIR).toBe(mainGitDir);
    expect(context.permissionAllowlist).toContain(`Write(//${mainGitDir.slice(1)}/**)`);
  });

  test('injects checkpoint dir env var and allowlist entries when provided', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Long task', '/repo');
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));
    const checkpointDir = join(makeTempDir(), 'checkpoints', 'a-1234abcd', 'feat-x');
    mkdirSync(checkpointDir, { recursive: true });

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: repoDir,
      checkpointDir,
    });

    expect(context.env).toEqual({
      KOOKR_TASK_ID: task.id,
      KOOKR_GIT_COMMON_DIR: join(repoDir, '.git'),
      TASK_CHECKPOINT_DIR: checkpointDir,
    });
    expect(context.permissionAllowlist).toEqual([
      'Bash(git *)',
      `Read(//${join(repoDir, '.git').slice(1)}/**)`,
      `Write(//${join(repoDir, '.git').slice(1)}/**)`,
      `Read(//${checkpointDir.slice(1)}/**)`,
      `Write(//${checkpointDir.slice(1)}/**)`,
      `Bash(${checkpointDir}/repro.sh*)`,
    ]);
  });

  test('omits checkpoint env when checkpointDir is not provided', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Plain task', '/repo');
    const repoDir = makeTempDir();
    mkdirSync(join(repoDir, '.git'));

    const context = await buildAgentLaunchContext({
      taskStore,
      taskId: task.id,
      cwd: repoDir,
    });

    expect(context.env.TASK_CHECKPOINT_DIR).toBeUndefined();
    // Guard against regression: also confirm the legacy var name is not set.
    expect(Object.keys(context.env)).not.toContain('KOOKR_CHECKPOINT_DIR');
    const checkpointAllowlistEntries = context.permissionAllowlist.filter((e) =>
      e.includes('checkpoint') || e.includes('repro.sh'),
    );
    expect(checkpointAllowlistEntries).toHaveLength(0);
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-agent-launch-'));
    tempDirs.push(dir);
    return dir;
  }
});
