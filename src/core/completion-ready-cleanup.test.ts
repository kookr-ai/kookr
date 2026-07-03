import { describe, expect, test } from 'vitest';
import { TaskStore } from './tasks.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  classifyCompletionReadyClosePolicy,
  listStaleCompletionReadyTasks,
} from './completion-ready-cleanup.js';

function startTask(store: TaskStore, id: string): void {
  store.addSession(id, {
    tmuxSession: `kookr-${id}`,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
  });
}

describe('classifyCompletionReadyClosePolicy', () => {
  test('allows auto-close for opted-in tasks', () => {
    expect(classifyCompletionReadyClosePolicy({ autoCloseOnSignal: true })).toEqual({ canAutoClose: true });
  });

  test('requires manual action when auto-close is not enabled', () => {
    expect(classifyCompletionReadyClosePolicy({})).toEqual({
      canAutoClose: false,
      manualActionRequiredReason: 'auto_close_not_enabled',
    });
  });

  test('explicit auto-close wins over the default ask-first launch stamp', () => {
    expect(classifyCompletionReadyClosePolicy({
      autoCloseOnSignal: true,
      deliveryAuthorization: 'ask-first',
    })).toEqual({ canAutoClose: true });
  });

  test('ask-first tasks without auto-close require delivery review before completion', () => {
    expect(classifyCompletionReadyClosePolicy({
      deliveryAuthorization: 'ask-first',
    })).toEqual({
      canAutoClose: false,
      manualActionRequiredReason: 'delivery_authorization_required',
    });
  });
});

describe('listStaleCompletionReadyTasks', () => {
  test('returns in-progress completion-ready tasks older than the threshold oldest first', () => {
    const store = new TaskStore();
    const fresh = store.createTask({ prompt: 'Fresh', cwd: '/repo' });
    const stale = store.createTask({ prompt: 'Stale', cwd: '/repo' });
    const older = store.createTask({ prompt: 'Older', cwd: '/repo', deliveryAuthorization: 'ask-first' });
    const completed = store.createTask({ prompt: 'Completed', cwd: '/repo' });
    for (const task of [fresh, stale, older, completed]) startTask(store, task.id);
    store.completeTask(completed.id);

    store.setPendingSignal(fresh.id, { kind: 'completion_ready', raisedAt: '2026-06-20T23:30:00.000Z' });
    store.setPendingSignal(stale.id, { kind: 'completion_ready', raisedAt: '2026-06-20T01:00:00.000Z' });
    store.setPendingSignal(older.id, { kind: 'completion_ready', raisedAt: '2026-06-20T00:30:00.000Z' });
    store.setPendingSignal(completed.id, { kind: 'completion_ready', raisedAt: '2026-06-20T00:15:00.000Z' });

    const entries = listStaleCompletionReadyTasks(store.listTasks(), {
      now: new Date('2026-06-21T00:00:00.000Z'),
      thresholdMs: DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
    });

    expect(entries.map((entry) => entry.task.name ?? entry.task.prompt)).toEqual(['Older', 'Stale']);
    expect(entries[0]).toMatchObject({
      canAutoClose: false,
      manualActionRequiredReason: 'delivery_authorization_required',
      ageMs: 23.5 * 60 * 60 * 1000,
    });
    expect(entries[1]).toMatchObject({
      canAutoClose: false,
      manualActionRequiredReason: 'auto_close_not_enabled',
      ageMs: 23 * 60 * 60 * 1000,
    });
  });

  test('omits invalid signal timestamps', () => {
    const store = new TaskStore();
    const task = store.createTask({ prompt: 'Invalid timestamp', cwd: '/repo' });
    startTask(store, task.id);
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: 'not-a-date' });

    expect(listStaleCompletionReadyTasks(store.listTasks(), {
      now: new Date('2026-06-21T00:00:00.000Z'),
      thresholdMs: 0,
    })).toEqual([]);
  });

  test('does not surface future signal timestamps as stale', () => {
    const store = new TaskStore();
    const task = store.createTask({ prompt: 'Clock skew', cwd: '/repo' });
    startTask(store, task.id);
    store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-21T01:00:00.000Z' });

    expect(listStaleCompletionReadyTasks(store.listTasks(), {
      now: new Date('2026-06-21T00:00:00.000Z'),
      thresholdMs: 0,
    })).toEqual([]);
  });
});
