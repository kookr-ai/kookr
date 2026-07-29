import { describe, it, expect } from 'vitest';
import {
  describeBlocker,
  formatTasksReply,
  isTasksCommand,
  selectActiveTasks,
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
      blocked_by: ['task:other'],
    };
    expect(describeBlocker(row)).toBe('blocked on permission');
  });

  it.each([
    ['permission_blocked', 'blocked on permission'],
    ['awaiting_completion_ack', 'awaiting completion ack'],
    ['hung_suspect', 'possibly hung'],
    ['waiting_on_input', 'waiting on input'],
    ['some_future_reason', 'blocked (some_future_reason)'],
  ])('maps stuckReason %s to %s', (stuckReason, expected) => {
    expect(describeBlocker({ id: 'a', status: 'inProgress', stuckReason })).toBe(expected);
  });

  it('falls back to pendingSignal when no stuckReason', () => {
    expect(
      describeBlocker({ id: 'a', status: 'inProgress', pendingSignal: { kind: 'completion-ready' } }),
    ).toBe('signal: completion-ready');
  });

  it('falls back to blocked_by edges, stripping the task:/milestone: prefix and shortening ids', () => {
    expect(
      describeBlocker({
        id: 'a',
        status: 'open',
        blocked_by: ['task:abcdef123456', 'milestone:zzz'],
      }),
    ).toBe('blocked by abcdef12, zzz');
  });

  it('returns null for a plain running task', () => {
    expect(describeBlocker({ id: 'a', status: 'inProgress' })).toBeNull();
  });
});

describe('selectActiveTasks', () => {
  const rows: TaskSummaryRow[] = [
    { id: 'a', status: 'inProgress', cwd: '/repo/one' },
    { id: 'b', status: 'pending', cwd: '/repo/two/worktree' },
    { id: 'c', status: 'completed', cwd: '/repo/one' },
    { id: 'd', status: 'inProgress', cwd: '/other/project' },
    { id: 'e', status: 'inProgress' },
  ];

  it('keeps only non-terminal statuses when no scope is given', () => {
    expect(selectActiveTasks(rows).map((r) => r.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('restricts to tasks inside an allowed project directory', () => {
    // /repo/one matches exactly and /repo/two matches its nested worktree,
    // but /other/project and the cwd-less row are excluded.
    const scoped = selectActiveTasks(rows, { allowedCwds: ['/repo/one', '/repo/two'] });
    expect(scoped.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not match a sibling path that merely shares a prefix', () => {
    const scoped = selectActiveTasks(
      [{ id: 'x', status: 'inProgress', cwd: '/repo/oneX' }],
      { allowedCwds: ['/repo/one'] },
    );
    expect(scoped).toEqual([]);
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

  it('renders an open task with no name using the (unnamed) fallback', () => {
    const reply = formatTasksReply([{ id: 'ee551111', status: 'open', name: '   ' }]);
    expect(reply).toContain('ee551111');
    expect(reply).toContain('(unnamed)');
  });

  it('scopes the reply to allowed project directories', () => {
    const rows: TaskSummaryRow[] = [
      { id: 'inscope1', name: 'mine', status: 'inProgress', cwd: '/repo/kookr' },
      { id: 'outscope1', name: 'someone else', status: 'inProgress', cwd: '/repo/secret-project' },
    ];
    const reply = formatTasksReply(rows, { allowedCwds: ['/repo/kookr'] });
    expect(reply).toContain('Active tasks (1):');
    expect(reply).toContain('mine');
    expect(reply).not.toContain('someone else');
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

  it('redacts a credential-shaped name per-row without blanking other rows', () => {
    // Harmless credential-marker key that trips the redactor without resembling
    // a live provider token (avoids the PR secret scanner).
    const rows: TaskSummaryRow[] = [
      { id: 'aaaa1111', name: 'safe task', status: 'inProgress' },
      { id: 'bbbb2222', name: 'leaked password=hunter2', status: 'inProgress' },
    ];
    const reply = formatTasksReply(rows);
    // The credential row is masked...
    expect(reply).toContain('redacted');
    expect(reply).not.toContain('hunter2');
    // ...but the header and the other row survive (whole-body redaction would
    // have collapsed everything to the sentinel).
    expect(reply).toContain('Active tasks (2):');
    expect(reply).toContain('safe task');
  });

  it('redacts a credential-shaped name even when it falls past the truncation point', () => {
    // Fill rows so the credential row lands beyond TASKS_REPLY_MAX_CHARS; per-row
    // redaction runs before truncation, so the token can never survive.
    const rows: TaskSummaryRow[] = [
      ...Array.from({ length: 15 }, (_, i) => ({ id: `pad${i}`, name: 'x'.repeat(300), status: 'inProgress' })),
      { id: 'zzzz9999', name: 'token=hunter2', status: 'inProgress' },
    ];
    const reply = formatTasksReply(rows);
    expect(reply).not.toContain('hunter2');
  });

  it('hard-truncates an over-long reply with a terminal ellipsis', () => {
    const rows: TaskSummaryRow[] = Array.from({ length: 20 }, (_, i) => ({
      id: `id${i}`,
      name: 'x'.repeat(500),
      status: 'inProgress',
    }));
    const reply = formatTasksReply(rows);
    expect(reply.length).toBe(TASKS_REPLY_MAX_CHARS);
    expect(reply.endsWith('…')).toBe(true);
  });
});
