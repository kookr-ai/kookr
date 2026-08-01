import { describe, expect, test } from 'vitest';
import { TaskStore } from '../tasks.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  classifyCompletionReadyClosePolicy,
  isActiveRalphLoop,
  listStaleCompletionReadyTasks,
  selectAutoClosableCompletionReadyTasks,
} from './completion-ready-cleanup.js';
import type { RalphLoopState } from '../task-read-model.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

function startTask(store: TaskStore, id: string): void {
  store.addSession(id, {
    tmuxSession: `kookr-${id}`,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
  });
}

function ralphLoop(status: RalphLoopState['status']): RalphLoopState {
  return {
    prompt: 'Loop',
    iterationCap: 3,
    currentIteration: 1,
    status,
    lastIterationStartedAt: Date.parse('2026-06-20T00:00:00.000Z'),
    cumulativeIterations: 1,
  };
}

function setRalphStatus(store: TaskStore, id: string, status: RalphLoopState['status']): void {
  store.getTaskForMutation(id)!.ralphLoop = ralphLoop(status);
}

/** A completion-ready, opted-in (auto-closable) in-progress task, `minsAgo` old. */
function addAutoClosableTask(store: TaskStore, prompt: string, minsAgo: number): string {
  const task = store.createTask({ prompt, cwd: '/repo', autoCloseOnSignal: true });
  startTask(store, task.id);
  const raisedAt = new Date(Date.parse('2026-06-21T00:00:00.000Z') - minsAgo * 60 * 1000).toISOString();
  store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt });
  return task.id;
}

const NOW = new Date('2026-06-21T00:00:00.000Z');

describe('classifyCompletionReadyClosePolicy', () => {
  test('allows auto-close for opted-in tasks', () => {
    expect(classifyCompletionReadyClosePolicy({ autoCloseOnSignal: true })).toEqual({
      canAutoClose: true,
      closeReason: 'auto_close_on_signal',
    });
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
    })).toEqual({ canAutoClose: true, closeReason: 'auto_close_on_signal' });
  });

  test('ask-first tasks without auto-close require delivery review before completion', () => {
    expect(classifyCompletionReadyClosePolicy({
      deliveryAuthorization: 'ask-first',
    })).toEqual({
      canAutoClose: false,
      manualActionRequiredReason: 'delivery_authorization_required',
    });
  });

  test('young ask-first tasks stay manual even when a TTL is configured', () => {
    expect(classifyCompletionReadyClosePolicy(
      { deliveryAuthorization: 'ask-first' },
      { ageMs: ONE_HOUR_MS, ttlMs: 2 * ONE_HOUR_MS },
    )).toEqual({
      canAutoClose: false,
      manualActionRequiredReason: 'delivery_authorization_required',
    });
  });

  test('old ask-first tasks escalate past the TTL with a distinct close reason', () => {
    expect(classifyCompletionReadyClosePolicy(
      { deliveryAuthorization: 'ask-first' },
      { ageMs: 2 * ONE_HOUR_MS, ttlMs: 2 * ONE_HOUR_MS },
    )).toEqual({ canAutoClose: true, closeReason: 'ttl_escalation' });
  });

  test('TTL escalation applies even without an explicit ask-first stamp', () => {
    expect(classifyCompletionReadyClosePolicy(
      {},
      { ageMs: 3 * ONE_HOUR_MS, ttlMs: 2 * ONE_HOUR_MS },
    )).toEqual({ canAutoClose: true, closeReason: 'ttl_escalation' });
  });

  test('opted-in tasks keep the immediate close reason regardless of TTL', () => {
    expect(classifyCompletionReadyClosePolicy(
      { autoCloseOnSignal: true },
      { ageMs: 0, ttlMs: 2 * ONE_HOUR_MS },
    )).toEqual({ canAutoClose: true, closeReason: 'auto_close_on_signal' });
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

  describe('TTL escalation (issue #1526 Phase A)', () => {
    test('an ask-first task younger than the TTL stays manual', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'Young', cwd: '/repo', deliveryAuthorization: 'ask-first' });
      startTask(store, task.id);
      // 90 minutes old — past the 30m reporting threshold, short of a 2h TTL.
      store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-20T22:30:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000,
        ttlMs: 2 * 60 * 60 * 1000,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        canAutoClose: false,
        manualActionRequiredReason: 'delivery_authorization_required',
      });
      expect(entries[0].closeReason).toBeUndefined();
    });

    test('an ask-first task past the TTL escalates to auto-closable', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'Old', cwd: '/repo', deliveryAuthorization: 'ask-first' });
      startTask(store, task.id);
      store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-20T22:00:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000,
        ttlMs: 2 * 60 * 60 * 1000,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ canAutoClose: true, closeReason: 'ttl_escalation' });
    });

    test('treats the boundary (age === ttlMs) as escalated', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'Boundary', cwd: '/repo', deliveryAuthorization: 'ask-first' });
      startTask(store, task.id);
      store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-20T22:00:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000,
        ttlMs: 2 * 60 * 60 * 1000, // exactly 2h, matches the signal age exactly
      });

      expect(entries[0]).toMatchObject({ canAutoClose: true, closeReason: 'ttl_escalation' });
    });

    test('opted-in tasks are unaffected by TTL — same immediate close reason', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'Opted-in', cwd: '/repo', autoCloseOnSignal: true });
      startTask(store, task.id);
      store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-20T23:29:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000,
        ttlMs: 2 * 60 * 60 * 1000,
      });

      expect(entries[0]).toMatchObject({ canAutoClose: true, closeReason: 'auto_close_on_signal' });
    });

    test('a TTL shorter than the reporting threshold still surfaces and escalates the task', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'Short TTL', cwd: '/repo', deliveryAuthorization: 'ask-first' });
      startTask(store, task.id);
      // 10 minutes old: below the 30m reporting threshold, but past a 5m TTL.
      store.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-20T23:50:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000,
        ttlMs: 5 * 60 * 1000,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ canAutoClose: true, closeReason: 'ttl_escalation' });
    });

    test('a short TTL never shortens the opted-in auto-close delay (issue #1526 Phase A review fix)', () => {
      // ttl=5min < delay=30min. Before the fix, the outer list filter used
      // min(thresholdMs, ttlMs) for EVERY task, so a 10-minute-old opted-in
      // task would sneak past the 5m gate and classify() would close it
      // immediately via autoCloseOnSignal — 20 minutes before its documented
      // 30-minute review window. The two populations must be gated
      // independently: opted-in by its own thresholdMs only; everyone else
      // by whichever of thresholdMs/ttlMs is smaller.
      const store = new TaskStore();
      const optedIn = store.createTask({ prompt: 'Opted-in, too young for its own delay', cwd: '/repo', autoCloseOnSignal: true });
      const askFirst = store.createTask({ prompt: 'Ask-first, past the short TTL', cwd: '/repo', deliveryAuthorization: 'ask-first' });
      startTask(store, optedIn.id);
      startTask(store, askFirst.id);
      // Both signals are 10 minutes old.
      store.setPendingSignal(optedIn.id, { kind: 'completion_ready', raisedAt: '2026-06-20T23:50:00.000Z' });
      store.setPendingSignal(askFirst.id, { kind: 'completion_ready', raisedAt: '2026-06-20T23:50:00.000Z' });

      const entries = listStaleCompletionReadyTasks(store.listTasks(), {
        now: new Date('2026-06-21T00:00:00.000Z'),
        thresholdMs: 30 * 60 * 1000, // autoCloseCompletionReadyDelayMin
        ttlMs: 5 * 60 * 1000, // completionReadyTtlMinutes, deliberately shorter
      });

      // Opted-in: NOT listed at all (10min < its own 30min delay) — not
      // auto-closable, not even surfaced as a stale row yet.
      expect(entries.find((e) => e.task.id === optedIn.id)).toBeUndefined();

      // Ask-first: listed and escalated via the TTL tier (10min >= 5min TTL).
      const askFirstEntry = entries.find((e) => e.task.id === askFirst.id);
      expect(askFirstEntry).toMatchObject({ canAutoClose: true, closeReason: 'ttl_escalation' });
    });
  });
});

describe('isActiveRalphLoop', () => {
  test('running and paused loops are active; completed/failed/absent are not', () => {
    expect(isActiveRalphLoop({ ralphLoop: ralphLoop('running') })).toBe(true);
    expect(isActiveRalphLoop({ ralphLoop: ralphLoop('paused') })).toBe(true);
    expect(isActiveRalphLoop({ ralphLoop: ralphLoop('completed') })).toBe(false);
    expect(isActiveRalphLoop({ ralphLoop: ralphLoop('failed') })).toBe(false);
    expect(isActiveRalphLoop({})).toBe(false);
  });
});

describe('selectAutoClosableCompletionReadyTasks', () => {
  test('keeps only policy-auto-closable entries by default (drops ask-first manual-review)', () => {
    const store = new TaskStore();
    const auto = addAutoClosableTask(store, 'Auto', 90);
    const askFirst = store.createTask({ prompt: 'Ask-first', cwd: '/repo', deliveryAuthorization: 'ask-first' });
    startTask(store, askFirst.id);
    store.setPendingSignal(askFirst.id, { kind: 'completion_ready', raisedAt: '2026-06-20T22:30:00.000Z' });

    const ids = selectAutoClosableCompletionReadyTasks(store.listTasks(), { now: NOW }).map((e) => e.task.id);
    expect(ids).toEqual([auto]);
  });

  test('force:true widens the scope to stale entries that still require manual action', () => {
    const store = new TaskStore();
    const auto = addAutoClosableTask(store, 'Auto', 90);
    const askFirst = store.createTask({ prompt: 'Ask-first', cwd: '/repo', deliveryAuthorization: 'ask-first' });
    startTask(store, askFirst.id);
    store.setPendingSignal(askFirst.id, { kind: 'completion_ready', raisedAt: '2026-06-20T22:30:00.000Z' });

    const entries = selectAutoClosableCompletionReadyTasks(store.listTasks(), { now: NOW, force: true });
    expect(entries.map((e) => e.task.id).sort()).toEqual([auto, askFirst.id].sort());
    // The manual-review entry is still surfaced, tagged as not auto-closable.
    expect(entries.find((e) => e.task.id === askFirst.id)).toMatchObject({ canAutoClose: false });
  });

  test('excludeActiveRalph drops both running AND paused loops (guards the paused branch)', () => {
    const store = new TaskStore();
    const plain = addAutoClosableTask(store, 'Plain', 90);
    const running = addAutoClosableTask(store, 'Running', 90);
    const paused = addAutoClosableTask(store, 'Paused', 90);
    setRalphStatus(store, running, 'running');
    setRalphStatus(store, paused, 'paused');

    const ids = selectAutoClosableCompletionReadyTasks(store.listTasks(), {
      now: NOW,
      excludeActiveRalph: true,
    }).map((e) => e.task.id);
    expect(ids).toEqual([plain]);
  });

  test('without excludeActiveRalph an active-loop task is still returned', () => {
    const store = new TaskStore();
    const running = addAutoClosableTask(store, 'Running', 90);
    setRalphStatus(store, running, 'running');

    const ids = selectAutoClosableCompletionReadyTasks(store.listTasks(), { now: NOW }).map((e) => e.task.id);
    expect(ids).toEqual([running]);
  });

  test('limit caps the batch oldest-first', () => {
    const store = new TaskStore();
    const oldest = addAutoClosableTask(store, 'Oldest', 180);
    const middle = addAutoClosableTask(store, 'Middle', 120);
    addAutoClosableTask(store, 'Newest', 90);

    const ids = selectAutoClosableCompletionReadyTasks(store.listTasks(), { now: NOW, limit: 2 }).map((e) => e.task.id);
    expect(ids).toEqual([oldest, middle]);
  });
});
