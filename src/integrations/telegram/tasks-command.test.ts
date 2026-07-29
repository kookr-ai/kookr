import { describe, it, expect } from 'vitest';
import {
  describeBlocker,
  formatTasksReply,
  isTasksCommand,
  TASKS_REPLY_MAX_CHARS,
  TASKS_REPLY_MAX_ROWS,
  type TaskSummaryRow,
} from './tasks-command.js';

describe('isTasksCommand', () => {
  it('matches /tasks and the @botname suffix', () => {
    expect(isTasksCommand('/tasks')).toBe(true);
    expect(isTasksCommand('/tasks ')).toBe(true);
    expect(isTasksCommand('/tasks@kookr_core_bot')).toBe(true);
  });

  it('does not match other commands or arguments', () => {
    expect(isTasksCommand('/task fix it')).toBe(false);
    expect(isTasksCommand('/tasks foo')).toBe(false);
    expect(isTasksCommand('/agent status')).toBe(false);
    expect(isTasksCommand('tasks')).toBe(false);
  });
});

describe('describeBlocker', () => {
  it('prefers stuckReason over pendingSignal and blocked_by', () => {
    const row: TaskSummaryRow = {
      id: 'a',
      status: 'inProgress',
      stuckReason: 'permission_blocked',
      pendingSignal: { kind: 'completion-ready' },
      blocked_by: [{ taskId: 'other' }],
    };
    expect(describeBlocker(row)).toBe('blocked on permission');
  });

  it('falls back to pendingSignal when no stuckReason', () => {
    expect(
      describeBlocker({ id: 'a', status: 'inProgress', pendingSignal: { kind: 'completion-ready' } }),
    ).toBe('signal: completion-ready');
  });

  it('falls back to blocked_by edges, shortening ids', () => {
    expect(
      describeBlocker({ id: 'a', status: 'open', blocked_by: [{ taskId: 'abcdef123456' }, 'zzz'] }),
    ).toBe('blocked by abcdef12, zzz');
  });

  it('returns null for a plain running task', () => {
    expect(describeBlocker({ id: 'a', status: 'inProgress' })).toBeNull();
  });
});

describe('formatTasksReply', () => {
  it('enumerates active task ids/names and each blocker severity', () => {
    const rows: TaskSummaryRow[] = [
      { id: 'aaaaaaaa1111', name: 'Fix login', status: 'inProgress', stuckReason: 'permission_blocked' },
      { id: 'bbbbbbbb2222', name: 'Migrate db', status: 'inProgress', pendingSignal: { kind: 'completion-ready' } },
      { id: 'cccccccc3333', name: 'Queued work', status: 'pending' },
      { id: 'dddddddd4444', name: 'Old done task', status: 'completed' },
    ];
    const reply = formatTasksReply(rows);

    // Active count excludes the completed task.
    expect(reply).toContain('Active tasks (3):');
    // Task ids (shortened) and names are enumerated.
    expect(reply).toContain('aaaaaaaa');
    expect(reply).toContain('Fix login');
    expect(reply).toContain('bbbbbbbb');
    expect(reply).toContain('Migrate db');
    expect(reply).toContain('cccccccc');
    // Blocker severities surface per row.
    expect(reply).toContain('blocked on permission');
    expect(reply).toContain('signal: completion-ready');
    // The terminal task is not listed.
    expect(reply).not.toContain('Old done task');
  });

  it('returns a clear message when there are no active tasks', () => {
    expect(formatTasksReply([])).toBe('No active tasks.');
    expect(formatTasksReply([{ id: 'x', status: 'completed' }])).toBe('No active tasks.');
  });

  it('caps the row count with an overflow line', () => {
    const rows: TaskSummaryRow[] = Array.from({ length: TASKS_REPLY_MAX_ROWS + 5 }, (_, i) => ({
      id: `id${i}`,
      name: `task ${i}`,
      status: 'inProgress',
    }));
    const reply = formatTasksReply(rows);
    expect(reply).toContain(`Active tasks (${TASKS_REPLY_MAX_ROWS + 5}):`);
    expect(reply).toContain('and 5 more');
  });

  it('runs the reply through the secret redactor', () => {
    // Harmless credential-marker key that trips the redactor without resembling
    // a live provider token (avoids the PR secret scanner).
    const rows: TaskSummaryRow[] = [
      { id: 'aaaa1111', name: 'leaked password=hunter2', status: 'inProgress' },
    ];
    const reply = formatTasksReply(rows);
    expect(reply).toContain('redacted');
    expect(reply).not.toContain('hunter2');
  });

  it('hard-truncates an over-long reply', () => {
    const rows: TaskSummaryRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `id${i}`,
      name: 'x'.repeat(500),
      status: 'inProgress',
    }));
    const reply = formatTasksReply(rows);
    expect(reply.length).toBeLessThanOrEqual(TASKS_REPLY_MAX_CHARS);
  });
});
