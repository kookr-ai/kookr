import { describe, test, expect } from 'vitest';
import { buildContinuationBrief, type WorktreeState } from './continuation-brief.js';
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
