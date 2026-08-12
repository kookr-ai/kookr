import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContinuationBrief, readWorktreeState, type WorktreeState } from './continuation-brief.js';
import { gitExecEnv } from '../git-helpers.js';
import type { Task } from '../task-read-model.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    prompt: 'raw prompt with launch context',
    userPrompt: 'Add a --json flag to the export command',
    cwd: '/repo',
    criteria: 'export --json prints valid JSON',
    agentType: 'grok-build',
    status: 'terminated',
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

const cleanTree: WorktreeState = { isGitRepo: true, uncommitted: [], shared: false };

describe('buildContinuationBrief', () => {
  test('leads with intent (userPrompt), names both agents, and includes criteria', () => {
    const brief = buildContinuationBrief({ task: task(), targetAgent: 'claude-code', worktree: cleanTree });
    expect(brief).toContain('you are Claude Code');
    expect(brief).toContain('Grok Build');
    expect(brief).toContain('Add a --json flag to the export command');
    expect(brief).toContain('export --json prints valid JSON');
  });

  test('prefers userPrompt over the raw prompt', () => {
    const brief = buildContinuationBrief({ task: task(), targetAgent: 'claude-code', worktree: cleanTree });
    expect(brief).not.toContain('raw prompt with launch context');
  });

  test('falls back to prompt when userPrompt absent', () => {
    const brief = buildContinuationBrief({
      task: task({ userPrompt: undefined }),
      targetAgent: 'claude-code',
      worktree: cleanTree,
    });
    expect(brief).toContain('raw prompt with launch context');
  });

  test('never presents commit history as the previous agent\'s work', () => {
    const brief = buildContinuationBrief({
      task: task(),
      targetAgent: 'claude-code',
      worktree: { isGitRepo: true, uncommitted: ['M src/a.ts'], shared: true },
    });
    // honest: no fabricated commit attribution
    expect(brief).not.toMatch(/commits?.*(from|by) the (interrupted|previous)/i);
  });

  test('labels a shared checkout honestly', () => {
    const brief = buildContinuationBrief({
      task: task(),
      targetAgent: 'claude-code',
      worktree: { isGitRepo: true, uncommitted: ['M src/a.ts'], shared: true },
    });
    expect(brief).toMatch(/shared checkout/i);
    expect(brief).toContain('M src/a.ts');
  });

  test('a dedicated (non-shared) checkout omits the shared caveat', () => {
    const brief = buildContinuationBrief({
      task: task(),
      targetAgent: 'codex-cli',
      worktree: { isGitRepo: true, uncommitted: ['M src/a.ts'], shared: false },
    });
    expect(brief).not.toMatch(/shared checkout/i);
    expect(brief).toContain('you are Codex CLI');
  });

  test('includes the completion digest when present', () => {
    const brief = buildContinuationBrief({
      task: task({
        completionDigest: {
          bullets: ['Added the flag parser', 'Wrote a failing test'],
          filesChanged: ['src/export.ts'],
          testSummary: '1 failing',
        },
      }),
      targetAgent: 'claude-code',
      worktree: cleanTree,
    });
    expect(brief).toContain('Added the flag parser');
    expect(brief).toContain('1 failing');
  });

  test('degrades gracefully when not a git repo', () => {
    const brief = buildContinuationBrief({
      task: task(),
      targetAgent: 'claude-code',
      worktree: { isGitRepo: false, uncommitted: [], shared: false },
    });
    expect(brief).toMatch(/not a clean git checkout/i);
  });
});

describe('readWorktreeState (real git)', () => {
  // gitExecEnv() strips the inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/…
  // (NESTED_GIT_ENV_VARS) that a git HOOK exports — without this, `git commit`
  // in a temp dir would be redirected onto the REAL worktree during the
  // pre-push hook's test run. Identity via ENV only (never `git config`, which
  // for a linked worktree writes to the shared repo config); global/system
  // config nulled. This helper cannot touch or leak into the real repo.
  const GIT_ENV = {
    ...gitExecEnv(),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-wt-'));
    const opts = { cwd: dir, env: GIT_ENV, stdio: 'ignore' as const };
    execFileSync('git', ['init', '-q'], opts);
    writeFileSync(join(dir, 'a.txt'), 'x');
    execFileSync('git', ['add', '.'], opts);
    execFileSync('git', ['commit', '-qm', 'init'], opts);
    return dir;
  }

  test('reports a clean repo with a branch', async () => {
    const st = await readWorktreeState(repo(), false);
    expect(st.isGitRepo).toBe(true);
    expect(st.uncommitted).toEqual([]);
    expect(typeof st.branch).toBe('string');
  });

  test('lists uncommitted changes and caps them at 40 lines', async () => {
    const dir = repo();
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.txt`), String(i));
    const st = await readWorktreeState(dir, true);
    expect(st.isGitRepo).toBe(true);
    expect(st.uncommitted.length).toBe(40); // MAX_UNCOMMITTED_LINES cap
    expect(st.shared).toBe(true);
  });

  test('degrades to isGitRepo:false outside a repo', async () => {
    const st = await readWorktreeState(mkdtempSync(join(tmpdir(), 'kookr-nonrepo-')), false);
    expect(st.isGitRepo).toBe(false);
    expect(st.uncommitted).toEqual([]);
  });
});
