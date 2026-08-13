import { describe, expect, it } from 'vitest';
import {
  cwdEquivalent,
  expandLaunchPromptPaths,
  findActiveLaunchDuplicate,
  taskMatchesLaunchDuplicate,
  withLaunchTaskCwds,
} from './launch-duplicate.js';

describe('cwdEquivalent', () => {
  it('treats trailing-slash-only differences as equal', () => {
    expect(cwdEquivalent('/repo/x', '/repo/x/')).toBe(true);
    expect(cwdEquivalent('/repo/x///', '/repo/x')).toBe(true);
  });

  it('treats genuinely different paths as unequal', () => {
    expect(cwdEquivalent('/repo/x', '/repo/y')).toBe(false);
    expect(cwdEquivalent('/repo/x', '/repo/xy')).toBe(false);
  });

  it('is false for non-string inputs', () => {
    expect(cwdEquivalent(undefined, '/x')).toBe(false);
    expect(cwdEquivalent('/x', null)).toBe(false);
  });
});

describe('taskMatchesLaunchDuplicate', () => {
  const spawn = { prompt: 'do the thing', cwd: '/repo/x', agentType: 'claude-code' };

  it('matches an active task by userPrompt + cwd', () => {
    const task = {
      id: 't1',
      status: 'inProgress',
      cwd: '/repo/x',
      userPrompt: 'do the thing',
      prompt: 'INJECTED\ndo the thing',
    };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(true);
  });

  it('matches a dashboard snapshot row via description', () => {
    const task = {
      taskId: 't1',
      taskStatus: 'inProgress',
      cwd: '/repo/x',
      agentType: 'claude-code',
      description: 'do the thing',
    };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(true);
  });

  it('matches via prompt-prefix when userPrompt is absent (launch-context injection)', () => {
    const task = {
      id: 't1',
      status: 'open',
      cwd: '/repo/x/',
      prompt: 'do the thing\n\n[launch context]',
    };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(true);
  });

  it('does not match a terminal task', () => {
    const task = { id: 't1', status: 'completed', cwd: '/repo/x', userPrompt: 'do the thing' };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(false);
    expect(taskMatchesLaunchDuplicate({ ...task, status: undefined, taskStatus: 'cancelled' }, spawn)).toBe(false);
    expect(taskMatchesLaunchDuplicate({ ...task, status: 'terminated' }, spawn)).toBe(false);
  });

  it('does not match a different cwd', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/other', userPrompt: 'do the thing' };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(false);
  });

  it('does not match a different prompt', () => {
    const task = { id: 't1', status: 'inProgress', cwd: '/repo/x', userPrompt: 'something else' };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(false);
  });

  it('matches a stored absolute file path against a typed relative prompt', () => {
    const task = {
      id: 't1',
      status: 'inProgress',
      cwd: '/repo/x',
      userPrompt: 'Fix the crash in /repo/x/src/login.ts',
    };
    expect(taskMatchesLaunchDuplicate(task, {
      prompt: 'Fix the crash in src/login.ts',
      cwd: '/repo/x',
      agentType: 'claude-code',
    })).toBe(true);
  });

  it('filters on agentType only when the spawn pinned a concrete agent', () => {
    const task = {
      id: 't1',
      status: 'inProgress',
      cwd: '/repo/x',
      userPrompt: 'do the thing',
      agentType: 'codex-cli',
    };
    expect(taskMatchesLaunchDuplicate(task, spawn)).toBe(false);
    expect(taskMatchesLaunchDuplicate(task, { ...spawn, agentType: null })).toBe(true);
    expect(taskMatchesLaunchDuplicate(task, { ...spawn, agentType: 'round-robin' })).toBe(true);
  });
});

describe('expandLaunchPromptPaths', () => {
  it('joins a relative file token to cwd', () => {
    expect(expandLaunchPromptPaths('Fix src/login.ts please', '/repo/x'))
      .toBe('Fix /repo/x/src/login.ts please');
  });
});

describe('findActiveLaunchDuplicate', () => {
  const matching = {
    taskId: 'live',
    agentId: 'sess-live',
    taskStatus: 'inProgress',
    cwd: '/tmp/work',
    agentType: 'claude-code',
    description: 'Fix the auth bug',
  };
  const other = {
    taskId: 'other',
    agentId: 'sess-other',
    taskStatus: 'inProgress',
    cwd: '/tmp/work',
    agentType: 'claude-code',
    description: 'Unrelated prompt',
  };

  it('returns the first matching active task', () => {
    const found = findActiveLaunchDuplicate([other, matching], {
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
    });
    expect(found?.taskId).toBe('live');
  });

  it('prefers compact launch cwd over a session/worktree snapshot cwd', () => {
    const sessionRow = {
      taskId: 'live',
      taskStatus: 'inProgress',
      cwd: '/tmp/kookr-live-wt',
      agentType: 'claude-code',
      description: 'Fix the auth bug',
    };
    const overlaid = withLaunchTaskCwds([sessionRow], { live: '/tmp/work' });
    expect(findActiveLaunchDuplicate(overlaid, {
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
    })?.taskId).toBe('live');
    expect(findActiveLaunchDuplicate([sessionRow], {
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
    })).toBeUndefined();
  });

  it('returns undefined when the form is incomplete', () => {
    expect(findActiveLaunchDuplicate([matching], { prompt: '  ', cwd: '/tmp/work' })).toBeUndefined();
    expect(findActiveLaunchDuplicate([matching], { prompt: 'Fix the auth bug', cwd: '' })).toBeUndefined();
  });
});
