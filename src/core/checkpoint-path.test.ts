import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  resolveAndPrepareCheckpointDir,
} from './checkpoint-path.js';
import {
  slugifyForCheckpointKey,
  repoKeyFor,
} from './checkpoint-key.js';
import {
  buildCheckpointLoadInstruction,
} from './checkpoint-load-instruction.js';
import {
  inspectMemoryWriteCandidates,
  inspectSemanticCheckpoint,
} from './checkpoint-inspection.js';

describe('slugifyForCheckpointKey', () => {
  it('replaces filesystem-unsafe characters in a branch name', () => {
    expect(slugifyForCheckpointKey('feat/issue-310-checkpoint')).toBe('feat-issue-310-checkpoint');
    expect(slugifyForCheckpointKey('user@host:branch')).toBe('user-host-branch');
    expect(slugifyForCheckpointKey('with spaces')).toBe('with-spaces');
    expect(slugifyForCheckpointKey('weird*?chars[here]')).toBe('weird--chars-here-');
  });

  it('collapses runs but does not return empty', () => {
    expect(slugifyForCheckpointKey('a/b/c')).toBe('a-b-c');
  });
});

describe('repoKeyFor (internal)', () => {
  it('produces a slug + 8-char hash suffix', () => {
    const key = repoKeyFor('/workspace/kookr-feat/.git');
    expect(key).toMatch(/^-workspace-kookr-feat-\.git-[0-9a-f]{8}$/);
  });

  it('truncates very long paths but stays unique via the hash', () => {
    const longA = '/' + 'a'.repeat(200) + '/.git';
    const longB = '/' + 'b'.repeat(200) + '/.git';
    const keyA = repoKeyFor(longA);
    const keyB = repoKeyFor(longB);
    expect(keyA.length).toBeLessThanOrEqual(120);
    expect(keyB.length).toBeLessThanOrEqual(120);
    expect(keyA).not.toBe(keyB); // hash distinguishes
  });

  it('is deterministic for the same input', () => {
    const a = repoKeyFor('/some/path/.git');
    const b = repoKeyFor('/some/path/.git');
    expect(a).toBe(b);
  });
});

describe('resolveAndPrepareCheckpointDir', () => {
  let tmpRoot: string;
  let kookrDir: string;
  let repoDir: string;
  let gitDir: string;

  // Bulletproof git invocation for the test fixtures. Three layers of defense:
  //
  // 1. **Strip every inherited GIT_* env var.** When this test runs from a
  //    git pre-push hook, the hook process inherits `GIT_DIR`, `GIT_WORK_TREE`,
  //    `GIT_INDEX_FILE`, etc. from git itself. Spreading `...process.env`
  //    would propagate those into the child execSync, and git would then
  //    operate on the parent's git dir REGARDLESS of `cwd` — this was
  //    observed to commit into the worktree's branch during a pre-push.
  // 2. **Pass `--git-dir` and `--work-tree` flags explicitly** on every git
  //    invocation. CLI flags override env vars; env vars override config.
  //    This is the strongest possible scoping: even if step 1 is somehow
  //    bypassed, git is forced to operate on this test's repoDir.
  // 3. **Set `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`** to ignore any host
  //    config (gpg signing, alternate hooks paths, weird user.name).
  function buildCleanGitEnv(): NodeJS.ProcessEnv {
    const cleaned: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('GIT_')) continue;
      cleaned[k] = v;
    }
    return {
      ...cleaned,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
  }

  /**
   * Run a git command with `--git-dir` and `--work-tree` pinned to repoDir.
   * Pinning via CLI flags is bulletproof against any env-var leakage.
   */
  function runGit(args: string): Buffer {
    const cmd = `git --git-dir=${gitDir} --work-tree=${repoDir} ${args}`;
    return execSync(cmd, { cwd: repoDir, env: buildCleanGitEnv(), stdio: 'pipe' });
  }

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'checkpoint-path-test-'));
    kookrDir = join(tmpRoot, '.kookr');
    await mkdir(kookrDir, { recursive: true });
    repoDir = join(tmpRoot, 'repo');
    await mkdir(repoDir);
    gitDir = join(repoDir, '.git');

    // `git init` cannot use --git-dir/--work-tree the same way as other
    // commands (it INTERPRETS them differently), so we set them via env.
    execSync('git init -q -b feat-test-branch', {
      cwd: repoDir,
      env: { ...buildCleanGitEnv(), GIT_DIR: gitDir, GIT_WORK_TREE: repoDir },
      stdio: 'pipe',
    });

    // Verify the fresh repo's toplevel is repoDir, not some stray ancestor.
    // If it isn't, abort loudly — we'd otherwise pollute another git repo.
    const toplevel = runGit('rev-parse --show-toplevel').toString().trim();
    if (toplevel !== repoDir) {
      throw new Error(`test setup error: git toplevel is ${toplevel}, expected ${repoDir}`);
    }

    await writeFile(join(repoDir, 'README.md'), 'hi');
    try {
      runGit('add .');
      runGit('commit -q -m init');
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message: string };
      throw new Error(
        `git commit failed: ${e.message}\nstderr: ${e.stderr?.toString() ?? ''}\nstdout: ${e.stdout?.toString() ?? ''}`,
      );
    }
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when cwd has no git repo', async () => {
    const noGitDir = join(tmpRoot, 'plain');
    await mkdir(noGitDir);
    const result = await resolveAndPrepareCheckpointDir({ cwd: noGitDir, kookrDataDir: kookrDir });
    expect(result).toBeNull();
  });

  it('returns null when kookrDataDir contains shell glob metacharacters', async () => {
    const result = await resolveAndPrepareCheckpointDir({
      cwd: repoDir,
      kookrDataDir: join(tmpRoot, 'unsafe[name]'),
    });
    expect(result).toBeNull();
  });

  it('returns a path and pre-creates the directory on success', async () => {
    const result = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    expect(result).not.toBeNull();
    expect(result!).toMatch(/checkpoints\/.*-[0-9a-f]{8}\/feat-test-branch$/);
    const s = await stat(result!);
    expect(s.isDirectory()).toBe(true);
  });

  it('returns the same path for the same (repo, branch) on repeated calls', async () => {
    const a = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    const b = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('returns different paths for different branches in the same repo', async () => {
    const a = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    runGit('checkout -q -b another-branch');
    const b = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('returns null on detached HEAD (no symbolic branch)', async () => {
    const sha = runGit('rev-parse HEAD').toString().trim();
    runGit(`checkout -q --detach ${sha}`);
    const result = await resolveAndPrepareCheckpointDir({ cwd: repoDir, kookrDataDir: kookrDir });
    expect(result).toBeNull();
  });

  it('resolves the common dir when cwd is a linked worktree (.git is a file pointer)', async () => {
    // Kookr's primary use case: every task runs in a git worktree, so cwd's
    // .git is a FILE containing `gitdir: <main-repo>/.git/worktrees/<name>`.
    // The path resolver must walk two levels up from that gitdir to reach
    // the common dir. A regression in this branch would silently disable
    // checkpointing for every Kookr task.
    //
    // Simulate a linked worktree without invoking `git worktree add` (which
    // creates real refs that aren't worth the complexity here).
    const worktreePath = join(tmpRoot, 'wt');
    const linkedGitDir = join(repoDir, '.git', 'worktrees', 'wt');
    await mkdir(linkedGitDir, { recursive: true });
    await mkdir(worktreePath);
    await writeFile(join(worktreePath, '.git'), `gitdir: ${linkedGitDir}\n`);
    // Give the linked gitdir a HEAD pointing at a branch so readBranchName works.
    await writeFile(join(linkedGitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n');

    const result = await resolveAndPrepareCheckpointDir({ cwd: worktreePath, kookrDataDir: kookrDir });
    expect(result).not.toBeNull();
    // The repo key should derive from the COMMON dir (repoDir/.git), not
    // the linked worktree gitdir.
    expect(result!).toMatch(/checkpoints\/.*\.git-[0-9a-f]{8}\/wt-branch$/);
  });
});

describe('semantic checkpoint resume contract', () => {
  let tmpRoot: string;
  let checkpointDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'semantic-checkpoint-test-'));
    checkpointDir = join(tmpRoot, 'checkpoints', 'repo', 'branch');
    await mkdir(checkpointDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('prefers valid CHECKPOINT.json when present', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Markdown fallback\n');
    await writeFile(
      join(checkpointDir, 'CHECKPOINT.json'),
      JSON.stringify({
        schema_version: 'semantic-checkpoint.v1',
        task_id: 'task-1',
        repo: 'kookr-ai/kookr',
        worktree: '/tmp/kookr-task',
        branch: 'feat/checkpoint-json',
        verdict: 'in_progress',
        decisions: [],
        evidence: [],
        files_changed: [],
        tests_run: [],
        open_risks: [],
        next_actions: [],
        memory_write_candidates: [],
      }),
    );

    await expect(inspectSemanticCheckpoint(checkpointDir)).resolves.toMatchObject({ kind: 'json' });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);
    expect(instruction).toContain('CHECKPOINT.json');
    expect(instruction).toContain('Read $TASK_CHECKPOINT_DIR/CHECKPOINT.json as your very first action');
    expect(instruction).toContain('CHECKPOINT.md remains the human-readable companion');
  });

  it('falls back to CHECKPOINT.md when CHECKPOINT.json is absent', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Existing checkpoint\n');

    await expect(inspectSemanticCheckpoint(checkpointDir)).resolves.toMatchObject({
      kind: 'markdown',
      reason: 'json_missing',
    });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);
    expect(instruction).toContain('CHECKPOINT.json is not present');
    expect(instruction).toContain('Read $TASK_CHECKPOINT_DIR/CHECKPOINT.md as your very first action');
  });

  it('warns and falls back to CHECKPOINT.md when CHECKPOINT.json is invalid', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Existing checkpoint\n');
    await writeFile(join(checkpointDir, 'CHECKPOINT.json'), '{"schema_version":"wrong"}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(inspectSemanticCheckpoint(checkpointDir)).resolves.toMatchObject({
      kind: 'markdown',
      reason: 'json_invalid',
    });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid semantic checkpoint JSON'));
    expect(instruction).toContain('CHECKPOINT.json is invalid');
    expect(instruction).toContain('Warn that CHECKPOINT.json was invalid');
    expect(instruction).toContain('Read $TASK_CHECKPOINT_DIR/CHECKPOINT.md as your very first action');
    warn.mockRestore();
  });

  it('warns and falls back to CHECKPOINT.md when CHECKPOINT.json is malformed', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Existing checkpoint\n');
    await writeFile(join(checkpointDir, 'CHECKPOINT.json'), '{bad json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(inspectSemanticCheckpoint(checkpointDir)).resolves.toMatchObject({
      kind: 'markdown',
      reason: 'json_unreadable',
    });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid semantic checkpoint JSON'));
    expect(instruction).toContain('CHECKPOINT.json is invalid');
    expect(instruction).toContain('Read $TASK_CHECKPOINT_DIR/CHECKPOINT.md as your very first action');
    warn.mockRestore();
  });

  it('preserves valid memory write candidates as review-only checkpoint state', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Existing checkpoint\n');
    await writeFile(
      join(checkpointDir, 'memory_write_candidates.json'),
      JSON.stringify({
        schema_version: 'memory-write-candidates.v1',
        candidates: [
          {
            id: 'candidate-1',
            target: { kind: 'kb', name: 'agent-task-lessons' },
            evidence: [{ note: 'verified repeated behavior' }],
            verifier: { status: 'passed' },
            approval: { status: 'pending' },
            lifecycle: { status: 'proposed', created_at: '2026-05-09T00:00:00.000Z' },
            promotion: { destination: 'agent-task-lessons' },
          },
        ],
      }),
    );

    await expect(inspectMemoryWriteCandidates(checkpointDir)).resolves.toMatchObject({
      kind: 'valid',
    });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);

    expect(instruction).toContain('memory_write_candidates.json');
    expect(instruction).toContain('preserve it across checkpoint/resume');
    expect(instruction).toContain('do not promote candidates into KB, wisdom, or skills automatically');
  });

  it('warns but does not block launch when memory write candidates are malformed', async () => {
    await writeFile(join(checkpointDir, 'CHECKPOINT.md'), '# Existing checkpoint\n');
    await writeFile(join(checkpointDir, 'memory_write_candidates.json'), '{"schema_version":"wrong"}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(inspectMemoryWriteCandidates(checkpointDir)).resolves.toMatchObject({
      kind: 'invalid',
    });
    const instruction = await buildCheckpointLoadInstruction(checkpointDir);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid memory write candidates JSON'));
    expect(instruction).toContain('memory_write_candidates.json is invalid');
    expect(instruction).toContain('Warn that memory_write_candidates.json was invalid');
    expect(instruction).toContain('continue without promoting candidates automatically');
    warn.mockRestore();
  });
});
