import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeCleanupVerdict } from '../shared/contracts/worktree-cleanup-verdict.js';

vi.mock('../adapters/git-worktree.js', () => ({
  inspectTaskWorktrees: vi.fn(),
}));

import { inspectTaskWorktrees } from '../adapters/git-worktree.js';
import { TaskStore } from '../core/tasks.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';

const mockInspect = vi.mocked(inspectTaskWorktrees);

afterEach(() => {
  vi.restoreAllMocks();
  mockInspect.mockReset();
});

function dirtyVerdict(overrides: Partial<WorktreeCleanupVerdict> = {}): WorktreeCleanupVerdict {
  return {
    worktreePath: '/wt/feature-branch',
    worktreeName: 'feature-branch',
    branch: 'feat/x',
    removable: false,
    blocker: 'uncommitted-changes',
    evidence: { dirty: { modified: 3, added: 0, deleted: 0, renamed: 0, untracked: 2 } },
    checkedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function taskWithSession(taskStore: TaskStore, prompt: string) {
  const task = taskStore.createTask({ prompt, cwd: '/tmp' });
  taskStore.addSession(task.id, {
    tmuxSession: `kookr-${task.id}`,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: new Date('2026-07-28T00:00:00.000Z'),
  });
  return taskStore.getTask(task.id)!;
}

describe('surfaceDirtyWorktreeOnHeadlessCompletion', () => {
  test('surfaces an audit row and a warning alert when a worktree is dirty', async () => {
    const taskStore = new TaskStore();
    const task = taskWithSession(taskStore, 'Dirty task');
    mockInspect.mockResolvedValue([dirtyVerdict()]);

    const auditDir = await mkdtemp(join(tmpdir(), 'dirty-wt-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    const broadcastToAll = vi.fn();

    const surfaced = await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
      taskStore,
      auditLogPath,
      broadcastToAll,
    });

    expect(surfaced).toBe(true);
    expect(mockInspect).toHaveBeenCalledWith(taskStore, task.id);

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    const alert = broadcastToAll.mock.calls[0]![0];
    expect(alert).toMatchObject({
      type: 'alert',
      severity: 'warning',
      agentId: `kookr-${task.id}`,
    });
    expect(alert.summary).toContain('Completed with dirty worktree');
    // Total dirty count (3 modified + 2 untracked) is surfaced.
    expect(alert.details).toContain('5 uncommitted change(s)');
    expect(alert.details).toContain('feature-branch');

    const rows = (await readFile(auditLogPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.completedWithDirtyWorktree',
      actor: 'system:dirty-worktree-guard',
      taskId: task.id,
      totalDirtyCount: 5,
    });
  });

  test('surfaces nothing when every worktree is clean', async () => {
    const taskStore = new TaskStore();
    const task = taskWithSession(taskStore, 'Clean task');
    mockInspect.mockResolvedValue([
      dirtyVerdict({
        removable: true,
        blocker: undefined,
        evidence: { dirty: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 } },
      }),
    ]);
    const broadcastToAll = vi.fn();

    const surfaced = await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
      taskStore,
      broadcastToAll,
    });

    expect(surfaced).toBe(false);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  test('surfaces nothing when the task owns no worktrees', async () => {
    const taskStore = new TaskStore();
    const task = taskWithSession(taskStore, 'No worktree');
    mockInspect.mockResolvedValue([]);
    const broadcastToAll = vi.fn();

    const surfaced = await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
      taskStore,
      broadcastToAll,
    });

    expect(surfaced).toBe(false);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  test('never throws when inspection fails — completion must not be blocked by the finding', async () => {
    const taskStore = new TaskStore();
    const task = taskWithSession(taskStore, 'Inspection fails');
    mockInspect.mockRejectedValue(new Error('git blew up'));
    const broadcastToAll = vi.fn();

    const surfaced = await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
      taskStore,
      broadcastToAll,
    });

    expect(surfaced).toBe(false);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });
});
