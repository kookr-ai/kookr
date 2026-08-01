import { describe, expect, test, vi, beforeEach } from 'vitest';
import { SessionRegistry, type SessionRegistryHost } from './session-registry.js';
import type { Task } from './task-read-model.js';
import type { SessionInfo } from './session-read-model.js';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  const now = new Date();
  return {
    prompt: 'p',
    cwd: '/cwd',
    agentType: 'claude-code',
    status: 'open',
    sessions: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSession(tmuxSession: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmuxSession,
    agentType: 'claude-code',
    cwd: '/cwd',
    createdAt: new Date(),
    ...extra,
  };
}

class FakeHost implements SessionRegistryHost {
  tasks = new Map<string, Task>();
  dirty = new Set<string>();
  attached: string[] = [];

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  markTaskDirty(taskId: string): void {
    this.dirty.add(taskId);
  }

  onSessionAttached(taskId: string): void {
    this.attached.push(taskId);
  }

  put(task: Task): Task {
    this.tasks.set(task.id, task);
    return task;
  }
}

describe('SessionRegistry', () => {
  let host: FakeHost;
  let registry: SessionRegistry;

  beforeEach(() => {
    host = new FakeHost();
    registry = new SessionRegistry(host);
  });

  test('addSession attaches a cloned session and promotes open → inProgress', () => {
    const task = host.put(makeTask({ id: 't1', status: 'open' }));
    const createdAt = new Date('2024-01-01T00:00:00.000Z');
    const returned = registry.addSession('t1', makeSession('kookr-a', { createdAt }));

    expect(returned.sessions).toHaveLength(1);
    expect(returned.sessions[0]!.tmuxSession).toBe('kookr-a');
    expect(returned.status).toBe('inProgress');
    expect(task.status).toBe('inProgress');
    expect(task.sessions[0]!.tmuxSession).toBe('kookr-a');
    // Returned object is a clone — mutating it must not touch the live task.
    returned.sessions[0]!.cwd = '/mutated';
    expect(task.sessions[0]!.cwd).toBe('/cwd');
    expect(host.dirty.has('t1')).toBe(true);
    expect(host.attached).toEqual(['t1']);
  });

  test('addSession promotes pending → inProgress', () => {
    host.put(makeTask({ id: 't1', status: 'pending' }));
    registry.addSession('t1', makeSession('kookr-a'));
    expect(host.getTask('t1')!.status).toBe('inProgress');
  });

  test('addSession refuses terminal tasks', () => {
    host.put(makeTask({ id: 't1', status: 'terminated' }));
    expect(() => registry.addSession('t1', makeSession('kookr-late'))).toThrow(
      /Cannot attach session to terminal task/,
    );
    expect(host.attached).toEqual([]);
    expect(host.dirty.has('t1')).toBe(false);
  });

  test('addSession throws for unknown task', () => {
    expect(() => registry.addSession('missing', makeSession('kookr-a'))).toThrow(
      'Task not found: missing',
    );
  });

  test('addSession logs duplicate not-known-dead sessions', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.addSession('t1', makeSession('kookr-b'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('duplicate-session attach on t1'));
    err.mockRestore();
  });

  test('addSession stays quiet for Ralph iteration relaunches', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.put(makeTask({
      id: 't1',
      status: 'inProgress',
      ralphLoop: {
        prompt: 'p',
        iterationCap: 5,
        currentIteration: 0,
        status: 'running',
        lastIterationStartedAt: 0,
        cumulativeIterations: 0,
      },
    }));
    registry.addSession('t1', makeSession('kookr-iter-1'));
    registry.addSession('t1', makeSession('kookr-iter-2'));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  test('updateSession patches fields and returns a clone', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    const updated = registry.updateSession('t1', 'kookr-a', {
      lastStatus: 'running',
      claudeSessionId: 'sess-1',
    });
    expect(updated.sessions[0]!.lastStatus).toBe('running');
    expect(updated.sessions[0]!.claudeSessionId).toBe('sess-1');
    expect(host.getTask('t1')!.sessions[0]!.lastStatus).toBe('running');
  });

  test('updateSession throws for missing task or session', () => {
    expect(() => registry.updateSession('missing', 'kookr-a', {})).toThrow('Task not found');
    host.put(makeTask({ id: 't1' }));
    expect(() => registry.updateSession('t1', 'nope', {})).toThrow('Session not found');
  });

  test('recordChildSession is first-write-wins per child id', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.recordChildSession('t1', 'kookr-a', 'child-1', {
      firstSeenAt: '2024-01-01T00:00:00.000Z',
      reason: 'subagent_hook',
    });
    registry.recordChildSession('t1', 'kookr-a', 'child-1', {
      firstSeenAt: '2024-06-01T00:00:00.000Z',
      reason: 'unknown',
      transcriptPath: '/later.jsonl',
    });
    const kids = host.getTask('t1')!.sessions[0]!.childSessionIds!;
    expect(kids['child-1']).toEqual({
      firstSeenAt: '2024-01-01T00:00:00.000Z',
      reason: 'subagent_hook',
    });
  });

  test('recordChildSession no-ops for unknown task or session', () => {
    registry.recordChildSession('missing', 'kookr-a', 'c', {
      firstSeenAt: 't',
      reason: 'unknown',
    });
    host.put(makeTask({ id: 't1' }));
    registry.recordChildSession('t1', 'nope', 'c', {
      firstSeenAt: 't',
      reason: 'unknown',
    });
    expect(host.dirty.size).toBe(0);
  });

  test('updateSessionGitInfo writes git fields', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.updateSessionGitInfo('t1', 'kookr-a', {
      branch: 'feat/x',
      commit: 'abc123',
      gitDir: '/repo/.git/worktrees/x',
      isWorktree: true,
      isDetached: false,
    });
    const s = host.getTask('t1')!.sessions[0]!;
    expect(s.gitBranch).toBe('feat/x');
    expect(s.gitCommit).toBe('abc123');
    expect(s.gitDir).toBe('/repo/.git/worktrees/x');
    expect(s.gitIsWorktree).toBe(true);
    expect(s.gitIsDetached).toBeUndefined();
  });

  test('updateSessionWorktreeHealth stamps health and observedAt', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.updateSessionWorktreeHealth('t1', 'kookr-a', 'stale', { registryStale: true });
    const s = host.getTask('t1')!.sessions[0]!;
    expect(s.worktreeHealth).toBe('stale');
    expect(s.worktreeRegistryStale).toBe(true);
    expect(s.worktreeHealthObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('updateSessionCwd updates cwd only', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.updateSessionCwd('t1', 'kookr-a', '/new/cwd');
    expect(host.getTask('t1')!.sessions[0]!.cwd).toBe('/new/cwd');
  });

  test('git/cwd/health mutators no-op for unknown task or session', () => {
    registry.updateSessionGitInfo('missing', 'kookr-a', {
      branch: null,
      commit: null,
      isWorktree: false,
      isDetached: false,
    });
    registry.updateSessionCwd('missing', 'kookr-a', '/x');
    registry.updateSessionWorktreeHealth('missing', 'kookr-a', 'ok');
    host.put(makeTask({ id: 't1' }));
    registry.updateSessionGitInfo('t1', 'nope', {
      branch: null,
      commit: null,
      isWorktree: false,
      isDetached: false,
    });
    registry.updateSessionCwd('t1', 'nope', '/x');
    registry.updateSessionWorktreeHealth('t1', 'nope', 'ok');
    expect(host.dirty.size).toBe(0);
  });
});
