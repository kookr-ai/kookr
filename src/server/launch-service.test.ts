import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { checkSubmission, launchTask, type LaunchServiceDeps } from './launch-service.js';

// Minimal stubs for adapter and lifecycle deps
function makeDeps(taskStore: TaskStore): LaunchServiceDeps {
  const claudeAdapter = {
    agentType: 'claude-code',
    launch: vi.fn().mockResolvedValue('tmux-claude'),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn(),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
  } as any;
  const codexAdapter = {
    agentType: 'codex-cli',
    launch: vi.fn().mockResolvedValue('tmux-codex'),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn(),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
  } as any;
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(claudeAdapter);
  adapterRegistry.register(codexAdapter);
  return {
    taskStore,
    adapterRegistry,
    lifecycleDeps: {
      monitor: { registerAgent: vi.fn() } as any,
      watchdog: { registerAgent: vi.fn() } as any,
      hookWatcher: { watch: vi.fn() } as any,
      githubScanner: { scanTask: vi.fn(), isActive: vi.fn().mockReturnValue(false), processTaskPrompt: vi.fn() } as any,
      autoNameTask: vi.fn(),
    } as any,
  };
}

function git(cwd: string, ...args: string[]) {
  // Strip GIT_DIR/GIT_WORK_TREE so tests aren't polluted when run from a
  // git hook (e.g. pre-push), which sets GIT_DIR in the environment.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd, stdio: 'pipe', env });
}

async function initGitRepo(dir: string) {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'branch', '-M', 'main');
}

describe('checkSubmission', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('returns undefined when no tasks exist', () => {
    expect(checkSubmission(store, 'fix the bug', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('returns the existing task when an active task has the same prompt and cwd', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp' });
    store.startTask(task.id);
    const found = checkSubmission(store, 'fix the bug', 'claude-code', '/tmp');
    expect(found?.id).toBe(task.id);
  });

  it('returns undefined for a different prompt', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'add the feature', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('blocks on open status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    // Task is 'open' by default
    expect(task.status).toBe('open');
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('blocks on pending status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.pendTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('blocks on inProgress status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('allows re-submission when existing task is completed', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    store.completeTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('allows re-submission when existing task is cancelled', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    store.cancelTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('does not trim whitespace — exact prompt match only', () => {
    store.createTask({ prompt: '  fix  ', cwd: '/tmp' });
    expect(checkSubmission(store, 'fix', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('allows the same prompt for a different agent type', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp', agentType: 'claude-code' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'fix the bug', 'codex-cli', '/tmp')).toBeUndefined();
  });

  it('does not dedup when the cwd differs (same prompt, different repos)', () => {
    const task = store.createTask({ prompt: 'review the diff', cwd: '/tmp/repo-a' });
    store.startTask(task.id);
    expect(
      checkSubmission(store, 'review the diff', 'claude-code', '/tmp/repo-b'),
    ).toBeUndefined();
  });

  it('treats trailing slashes as the same cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dedup-trailing-'));
    try {
      const task = store.createTask({ prompt: 'do it', cwd: dir });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', `${dir}/`)?.id,
      ).toBe(task.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a cwd and its symlink as the same task', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dedup-target-'));
    const link = join(tmpdir(), `dedup-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await symlink(target, link);
      const task = store.createTask({ prompt: 'do it', cwd: target });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', link)?.id,
      ).toBe(task.id);
    } finally {
      await rm(link, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('falls back to path.resolve() when the cwd does not exist', () => {
    // Non-existent absolute path — realpathSync throws, canonicalizeCwd falls
    // back to path.resolve. Both sides fall back the same way, so they match.
    const task = store.createTask({
      prompt: 'do it',
      cwd: '/nonexistent/kookr-test-path/a/..',
    });
    store.startTask(task.id);
    expect(
      checkSubmission(store, 'do it', 'claude-code', '/nonexistent/kookr-test-path')?.id,
    ).toBe(task.id);
  });

  it('on case-insensitive filesystems, dedups case-aliased cwds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dedup-caseAlias-'));
    try {
      const upper = realpathSync(dir);
      // Heuristic: if lowering the case produces a path that realpaths to the
      // same physical directory, we are on a case-insensitive FS (default
      // macOS). Otherwise, skip — the behavior under test only applies there.
      const lower = upper.toLowerCase();
      let caseInsensitive = false;
      try {
        caseInsensitive = realpathSync(lower) === upper;
      } catch {
        caseInsensitive = false;
      }
      if (!caseInsensitive) return; // skip on Linux / case-sensitive volumes
      const task = store.createTask({ prompt: 'do it', cwd: upper });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', lower)?.id,
      ).toBe(task.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('launchTask', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  let repoDir: string;

  beforeEach(async () => {
    store = new TaskStore();
    deps = makeDeps(store);
    repoDir = await mkdtemp(join(tmpdir(), 'launch-task-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates a new task normally', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(result.duplicate).toBeUndefined();
    expect(result.task.prompt).toBe('hello');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('returns duplicate:true for an identical active prompt', async () => {
    // First launch
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(first.duplicate).toBeUndefined();

    // Second launch with same prompt — should be deduplicated
    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    // adapter.launch should only have been called once
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('allows re-launch after completing the original task', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    // Transition: open -> inProgress -> completed
    store.startTask(first.task.id);
    store.completeTask(first.task.id);

    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
  });

  it('allows re-launch after cancelling the original task', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    // Transition: open -> inProgress -> cancelled
    store.startTask(first.task.id);
    store.cancelTask(first.task.id);

    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
  });

  it('does not call adapter.launch on duplicate', async () => {
    await launchTask(deps, { prompt: 'do it', cwd: '/tmp' });
    await launchTask(deps, { prompt: 'do it', cwd: '/tmp' });
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('queued:false on duplicate (existing task, not queued)', async () => {
    const result = await launchTask(deps, { prompt: 'test', cwd: '/tmp' });
    const dup = await launchTask(deps, { prompt: 'test', cwd: '/tmp' });
    expect(dup.queued).toBe(false);
    expect(dup.duplicate).toBe(true);
  });

  it('persists playbookParameterValues on the created task', async () => {
    const result = await launchTask(deps, {
      prompt: 'Analyze owner/repo',
      cwd: '/tmp',
      playbookId: 'analyze.md',
      playbookParameterValues: { repo: 'owner/repo', count: '10' },
    });
    expect(result.task.playbookParameterValues).toEqual({ repo: 'owner/repo', count: '10' });
  });

  it('does not set playbookParameterValues when not provided', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(result.task.playbookParameterValues).toBeUndefined();
  });

  it('launches with the requested adapter type', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli' });
    expect(result.task.agentType).toBe('codex-cli');
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('cleans up task record when adapter.launch throws, allowing retry', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('tmux unsafe permissions'));

    // First launch fails
    await expect(launchTask(deps, { prompt: 'do work', cwd: '/tmp' }))
      .rejects.toThrow('tmux unsafe permissions');

    // Task record should have been deleted
    expect(store.listTasks()).toHaveLength(0);

    // Retry succeeds — not blocked by dedup
    (adapter.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce('tmux-session');
    const result = await launchTask(deps, { prompt: 'do work', cwd: '/tmp' });
    expect(result.duplicate).toBeUndefined();
    expect(result.task.prompt).toBe('do work');
  });

  it('does not deduplicate across agent types', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'claude-code' });
    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli' });
    expect(first.task.id).not.toBe(second.task.id);
    expect(second.duplicate).toBeUndefined();
  });

  it('does not deduplicate when cwd differs — same prompt in two repos creates two tasks', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'launch-repo-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'launch-repo-b-'));
    try {
      const first = await launchTask(deps, { prompt: 'review the diff', cwd: dirA });
      const second = await launchTask(deps, { prompt: 'review the diff', cwd: dirB });
      expect(first.task.id).not.toBe(second.task.id);
      expect(second.duplicate).toBeUndefined();
      expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it('deduplicates when cwd is reached via a symlink to the same directory', async () => {
    const target = await mkdtemp(join(tmpdir(), 'launch-symlink-target-'));
    const link = join(tmpdir(), `launch-symlink-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await symlink(target, link);
      const first = await launchTask(deps, { prompt: 'do it', cwd: target });
      const second = await launchTask(deps, { prompt: 'do it', cwd: link });
      expect(first.task.id).toBe(second.task.id);
      expect(second.duplicate).toBe(true);
    } finally {
      await rm(link, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('records canonicalCwd in the submission_rejected_dedup interaction event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-log-event-'));
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) } as any;
    const depsWithLog = { ...deps, interactionLog };
    try {
      await launchTask(depsWithLog, { prompt: 'do it', cwd: dir });
      await launchTask(depsWithLog, { prompt: 'do it', cwd: dir });
      const dedupCalls = interactionLog.append.mock.calls
        .map((call: [unknown]) => call[0] as { type?: string; canonicalCwd?: string })
        .filter((e) => e.type === 'submission_rejected_dedup');
      expect(dedupCalls).toHaveLength(1);
      expect(dedupCalls[0].canonicalCwd).toBe(realpathSync(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps launchSource into the server log on successful launch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', launchSource: 'cli' });
      const matched = logSpy.mock.calls.some((args) =>
        typeof args[0] === 'string' && args[0].includes('[launch] source=cli'),
      );
      expect(matched).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('defaults launchSource to api when not provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      const matched = logSpy.mock.calls.some((args) =>
        typeof args[0] === 'string' && args[0].includes('[launch] source=api'),
      );
      expect(matched).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('normalizes relative file references before storing and launching the task', async () => {
    await mkdir(join(repoDir, 'docs', 'rfc'), { recursive: true });
    const filePath = join(repoDir, 'docs', 'rfc', 'design.md');
    await writeFile(filePath, '# RFC');

    const result = await launchTask(deps, {
      prompt: 'Read docs/rfc/design.md before coding.',
      cwd: repoDir,
    });

    expect(result.task.prompt).toBe(`Read ${filePath} before coding.`);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      `Read ${filePath} before coding.`,
      repoDir,
    );
  });

  it('deduplicates equivalent relative and absolute file references', async () => {
    await mkdir(join(repoDir, 'docs', 'rfc'), { recursive: true });
    const filePath = join(repoDir, 'docs', 'rfc', 'design.md');
    await writeFile(filePath, '# RFC');

    const first = await launchTask(deps, {
      prompt: 'Read docs/rfc/design.md before coding.',
      cwd: repoDir,
    });
    const second = await launchTask(deps, {
      prompt: `Read ${filePath} before coding.`,
      cwd: repoDir,
    });

    expect(first.task.id).toBe(second.task.id);
    expect(second.duplicate).toBe(true);
  });

  it('prefixes "create a fresh worktree" guidance when launching from a main checkout', async () => {
    await initGitRepo(repoDir);

    const result = await launchTask(deps, {
      prompt: 'Implement the bug fix and update tests.',
      cwd: repoDir,
    });

    expect(result.task.prompt).toContain('You are currently in the main checkout');
    expect(result.task.prompt).toContain(realpathSync(repoDir));
    expect(result.task.prompt).toContain('Do NOT commit in this checkout');
    expect(result.task.prompt).toContain('every Kookr task must make tracked-file changes in a fresh git worktree of its own');
    expect(result.task.prompt).toContain(`git worktree add ../${repoDir.split('/').pop()}-<short-name> -b <feature-branch> HEAD`);
    expect(result.task.prompt).toContain('Implement the bug fix and update tests.');
  });

  it('does not duplicate worktree guidance when the prompt already includes it', async () => {
    await initGitRepo(repoDir);

    const prompt = [
      'Before starting any work, create a git worktree on a feature branch and work inside it.',
      'git worktree add ../repo-feature -b feature/test HEAD',
      'Fix the bug.',
    ].join('\n');

    const result = await launchTask(deps, {
      prompt,
      cwd: repoDir,
    });

    expect(result.task.prompt).toBe(prompt);
  });

  it('prefixes "create a fresh worktree" guidance when launching from an existing worktree', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-feature`;
    git(repoDir, 'worktree', 'add', '-b', 'feature/test', worktreeDir, 'HEAD');

    const result = await launchTask(deps, {
      prompt: 'Implement the bug fix and update tests.',
      cwd: worktreeDir,
    });

    // git rev-parse --show-toplevel returns the realpath, which on macOS
    // differs from the raw mkdtemp path (/var/... vs /private/var/...).
    expect(result.task.prompt).toContain('You are currently in the git worktree');
    expect(result.task.prompt).toContain(realpathSync(worktreeDir));
    expect(result.task.prompt).toContain('feature/test');
    expect(result.task.prompt).toContain(realpathSync(repoDir));
    expect(result.task.prompt).toContain('Do NOT commit in this worktree or in the main checkout');
    expect(result.task.prompt).toContain('every Kookr task must make tracked-file changes in a fresh git worktree of its own');
    expect(result.task.prompt).toContain(`git worktree add ../${repoDir.split('/').pop()}-<short-name> -b <feature-branch> HEAD`);
    expect(result.task.prompt).toContain('Implement the bug fix and update tests.');
  });

  it('labels detached HEAD instead of a branch name in the guidance', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-detached`;
    // Create a worktree at a specific commit (detached HEAD).
    const cleanEnv = { ...process.env };
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: cleanEnv })
      .toString()
      .trim();
    git(repoDir, 'worktree', 'add', '--detach', worktreeDir, sha);

    const result = await launchTask(deps, {
      prompt: 'Read-only audit.',
      cwd: worktreeDir,
    });

    expect(result.task.prompt).toContain('You are currently in the git worktree');
    expect(result.task.prompt).toContain('(detached HEAD)');
    // Make sure we did NOT emit a misleading `on branch \`HEAD\`` phrase.
    expect(result.task.prompt).not.toContain('on branch `HEAD`');
    expect(result.task.prompt).toContain('Read-only audit.');
  });

  it('does not duplicate the guidance when the prompt already says "do not commit in this worktree"', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-feature2`;
    git(repoDir, 'worktree', 'add', '-b', 'feature/test2', worktreeDir, 'HEAD');

    const prompt = 'Do not commit in this worktree. Just inspect the file.';
    const result = await launchTask(deps, {
      prompt,
      cwd: worktreeDir,
    });

    expect(result.task.prompt).toBe(prompt);
  });
});

describe('R19 trust boundary (rfc-remote-chat-trigger §4)', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  const originalAllowCodex = process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;

  beforeEach(() => {
    store = new TaskStore();
    deps = makeDeps(store);
    delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
  });

  afterEach(() => {
    if (originalAllowCodex === undefined) delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
    else process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX = originalAllowCodex;
  });

  it('throws when launchSource=remote-chat-telegram and agentType=codex-cli', async () => {
    await expect(
      launchTask(deps, {
        prompt: 'p',
        cwd: '/tmp',
        launchSource: 'remote-chat-telegram',
        agentType: 'codex-cli',
      }),
    ).rejects.toThrow(/R19/);
  });

  it('R19 throws BEFORE any side effects (no task created, no adapter call)', async () => {
    const claudeLaunch = (deps.adapterRegistry.get('claude-code') as any).launch as ReturnType<typeof vi.fn>;
    const codexLaunch = (deps.adapterRegistry.get('codex-cli') as any).launch as ReturnType<typeof vi.fn>;
    claudeLaunch.mockClear();
    codexLaunch.mockClear();
    await expect(
      launchTask(deps, {
        prompt: 'p',
        cwd: '/tmp',
        launchSource: 'remote-chat-telegram',
        agentType: 'codex-cli',
      }),
    ).rejects.toThrow(/R19/);
    expect(store.listTasks()).toHaveLength(0);
    expect(claudeLaunch).not.toHaveBeenCalled();
    expect(codexLaunch).not.toHaveBeenCalled();
  });

  it('allows launchSource=remote-chat-telegram with agentType=claude-code', async () => {
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'remote-chat-telegram',
      agentType: 'claude-code',
    });
    expect(result.task.agentType).toBe('claude-code');
  });

  it('does not enforce R19 for other launch sources', async () => {
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'api',
      agentType: 'codex-cli',
    });
    expect(result.task.agentType).toBe('codex-cli');
  });

  it('allows remote-chat-telegram codex only when KOOKR_REMOTE_CHAT_ALLOW_CODEX=1', async () => {
    process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX = '1';
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'remote-chat-telegram',
      agentType: 'codex-cli',
    });
    expect(result.task.agentType).toBe('codex-cli');
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledOnce();
  });
});
