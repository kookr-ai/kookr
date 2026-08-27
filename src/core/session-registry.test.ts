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

  test('addSession refuses terminal tasks without mutation', () => {
    for (const status of ['terminated', 'completed', 'cancelled'] as const) {
      host = new FakeHost();
      registry = new SessionRegistry(host);
      host.put(makeTask({ id: 't1', status }));
      expect(() => registry.addSession('t1', makeSession('kookr-late'))).toThrow(
        /Cannot attach session to terminal task/,
      );
      expect(host.getTask('t1')!.sessions).toHaveLength(0);
      expect(host.getTask('t1')!.status).toBe(status);
      expect(host.attached).toEqual([]);
      expect(host.dirty.has('t1')).toBe(false);
    }
  });

  test('addSession throws for unknown task', () => {
    expect(() => registry.addSession('missing', makeSession('kookr-a'))).toThrow(
      'Task not found: missing',
    );
  });

  test('addSession refuses a session id already recorded as aborted', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.recordAbandonedLaunchSession('t1', makeSession('kookr-abandoned'));
    expect(() => registry.addSession('t1', makeSession('kookr-abandoned'))).toThrow(
      /Cannot attach aborted session kookr-abandoned/,
    );
    expect(host.getTask('t1')!.sessions).toHaveLength(1);
    expect(host.getTask('t1')!.sessions[0]!.lastStatus).toBe('aborted');
    expect(host.attached).toEqual([]);
  });

  test('addSession refuses a duplicate live session id', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-live'));
    expect(() => registry.addSession('t1', makeSession('kookr-live'))).toThrow(
      /Session kookr-live is already attached/,
    );
    expect(host.getTask('t1')!.sessions).toHaveLength(1);
  });

  test('addSession logs duplicate not-known-dead sessions but still attaches', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    registry.addSession('t1', makeSession('kookr-b'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('duplicate-session attach on t1'));
    expect(host.getTask('t1')!.sessions.map((s) => s.tmuxSession)).toEqual(['kookr-a', 'kookr-b']);
    err.mockRestore();
  });

  test('addSession stays quiet for Ralph iteration relaunches and still attaches', () => {
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
    expect(host.getTask('t1')!.sessions.map((s) => s.tmuxSession)).toEqual([
      'kookr-iter-1',
      'kookr-iter-2',
    ]);
    expect(host.dirty.has('t1')).toBe(true);
    expect(host.attached).toEqual(['t1', 't1']);
    err.mockRestore();
  });

  test('addSession stays quiet over crash-recovered siblings and still attaches', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-old', { crashRecovered: true }));
    registry.addSession('t1', makeSession('kookr-new'));
    expect(err).not.toHaveBeenCalled();
    expect(host.getTask('t1')!.sessions.map((s) => s.tmuxSession)).toEqual([
      'kookr-old',
      'kookr-new',
    ]);
    err.mockRestore();
  });

  test('addSession stays quiet over completed/aborted siblings and still attaches', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-done'));
    registry.updateSession('t1', 'kookr-done', { lastStatus: 'completed' });
    registry.addSession('t1', makeSession('kookr-aborted'));
    registry.updateSession('t1', 'kookr-aborted', { lastStatus: 'aborted' });
    registry.addSession('t1', makeSession('kookr-live'));
    expect(err).not.toHaveBeenCalled();
    expect(host.getTask('t1')!.sessions.map((s) => s.tmuxSession)).toEqual([
      'kookr-done',
      'kookr-aborted',
      'kookr-live',
    ]);
    err.mockRestore();
  });

  test('updateSession patches fields and returns a clone', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    host.dirty.clear();
    const updated = registry.updateSession('t1', 'kookr-a', {
      lastStatus: 'running',
      claudeSessionId: 'sess-1',
    });
    expect(updated.sessions[0]!.lastStatus).toBe('running');
    expect(updated.sessions[0]!.claudeSessionId).toBe('sess-1');
    expect(host.getTask('t1')!.sessions[0]!.lastStatus).toBe('running');
    // Returned object is a clone — mutating it must not touch the live task.
    updated.sessions[0]!.claudeSessionId = 'mutated';
    expect(host.getTask('t1')!.sessions[0]!.claudeSessionId).toBe('sess-1');
    expect(host.dirty.has('t1')).toBe(true);
  });

  test('updateSession throws for missing task or session', () => {
    expect(() => registry.updateSession('missing', 'kookr-a', {})).toThrow('Task not found');
    host.put(makeTask({ id: 't1' }));
    expect(() => registry.updateSession('t1', 'nope', {})).toThrow('Session not found');
  });

  test('recordChildSession is first-write-wins per child id', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    host.dirty.clear();
    registry.recordChildSession('t1', 'kookr-a', 'child-1', {
      firstSeenAt: '2024-01-01T00:00:00.000Z',
      reason: 'subagent_hook',
    });
    expect(host.dirty.has('t1')).toBe(true);
    host.dirty.clear();
    registry.recordChildSession('t1', 'kookr-a', 'child-1', {
      firstSeenAt: '2024-06-01T00:00:00.000Z',
      reason: 'unknown',
      transcriptPath: '/later.jsonl',
    });
    // Second write is a no-op — must not mark dirty again.
    expect(host.dirty.has('t1')).toBe(false);
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
    host.dirty.clear();
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
    expect(host.dirty.has('t1')).toBe(true);

    // Null/false coerce to undefined on branch/isWorktree as well.
    registry.updateSessionGitInfo('t1', 'kookr-a', {
      branch: null,
      commit: null,
      isWorktree: false,
      isDetached: false,
    });
    const s2 = host.getTask('t1')!.sessions[0]!;
    expect(s2.gitBranch).toBeUndefined();
    expect(s2.gitCommit).toBeUndefined();
    expect(s2.gitIsWorktree).toBeUndefined();
  });

  test('updateSessionWorktreeHealth stamps health and observedAt', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    host.dirty.clear();
    registry.updateSessionWorktreeHealth('t1', 'kookr-a', 'stale', { registryStale: true });
    const s = host.getTask('t1')!.sessions[0]!;
    expect(s.worktreeHealth).toBe('stale');
    expect(s.worktreeRegistryStale).toBe(true);
    expect(s.worktreeHealthObservedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(host.dirty.has('t1')).toBe(true);
  });

  test('updateSessionCwd updates cwd only', () => {
    host.put(makeTask({ id: 't1', status: 'inProgress' }));
    registry.addSession('t1', makeSession('kookr-a'));
    host.dirty.clear();
    registry.updateSessionCwd('t1', 'kookr-a', '/new/cwd');
    expect(host.getTask('t1')!.sessions[0]!.cwd).toBe('/new/cwd');
    expect(host.dirty.has('t1')).toBe(true);
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
