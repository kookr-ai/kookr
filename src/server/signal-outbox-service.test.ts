import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import {
  appendSignalOutbox,
  buildSignalOutboxEntry,
  readPendingSignals,
} from '../core/signal-outbox.js';
import { SignalOutboxService } from './signal-outbox-service.js';

async function tempSpoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-signal-outbox-svc-'));
}

describe('SignalOutboxService', () => {
  test('drains a spooled completion-ready onto a live task exactly once', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.startTask(task.id);

    const entry = buildSignalOutboxEntry({
      signalId: 'sig-1',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'PR open',
    });
    await appendSignalOutbox(spoolDir, entry);

    const outcomes: Array<{ taskId: string; kind: string }> = [];
    const svc = new SignalOutboxService({
      taskStore: store,
      spoolDir,
      onTaskOutcome: (taskId, outcome) => {
        outcomes.push({ taskId, kind: outcome.kind });
      },
    });

    const first = await svc.tick();
    expect(first.drained.delivered).toBe(1);
    expect(first.drained.remaining).toBe(0);
    expect(store.getPendingSignal(task.id)).toMatchObject({
      kind: 'completion_ready',
      note: 'PR open',
      signalId: 'sig-1',
    });
    expect(outcomes).toEqual([{ taskId: task.id, kind: 'completion_ready' }]);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);

    // Re-append the same signalId (simulates a client that timed out mid-POST
    // and later re-spooled / drain re-ran) — must be a pure no-op.
    await appendSignalOutbox(spoolDir, entry);
    const second = await svc.tick();
    expect(second.drained.delivered).toBe(1);
    expect(second.drained.remaining).toBe(0);
    expect(outcomes).toHaveLength(1); // outcome hook not re-fired
  });

  test('drops permanent failures (unknown / terminal task) and keeps nothing', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Done', '/repo');
    store.startTask(task.id);
    store.completeTask(task.id);

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'dead-task',
      taskId: task.id,
      kind: 'completion_ready',
    }));
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'missing',
      taskId: 'no-such-task',
      kind: 'completion_ready',
    }));

    const svc = new SignalOutboxService({ taskStore: store, spoolDir });
    const result = await svc.tick();
    expect(result.drained.permanentFailed).toBe(2);
    expect(result.drained.remaining).toBe(0);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
  });

  test('offline→online integration: CLI-shaped spool drains after "daemon" is up', async () => {
    // Acceptance criterion #1541: signal against a down daemon, bring daemon
    // up, assert single delivery + empty spool. Modeled without HTTP: the CLI
    // only writes the outbox; the service is what the restarted daemon runs.
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Lucy Daily Progress Report', '/repo');
    store.startTask(task.id);

    // Phase 1 — daemon is down: CLI writes the outbox and exits 0 (no deliver).
    const entry = buildSignalOutboxEntry({
      signalId: 'offline-1',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'report ready',
    });
    await appendSignalOutbox(spoolDir, entry);
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    expect(await readPendingSignals(spoolDir)).toHaveLength(1);

    // Phase 2 — daemon restarts: service boot tick delivers exactly once.
    const broadcasts = vi.fn();
    const svc = new SignalOutboxService({
      taskStore: store,
      spoolDir,
      onDelivered: broadcasts,
    });
    const tick = await svc.tick();
    expect(tick.drained.delivered).toBe(1);
    expect(tick.drained.remaining).toBe(0);
    expect(store.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
    expect(broadcasts).toHaveBeenCalledTimes(1);

    // Phase 3 — a second tick (or a client re-POST with the same signalId)
    // must not re-apply. Capture raisedAt, re-drain, assert unchanged.
    const raisedAt = store.getPendingSignal(task.id)?.raisedAt;
    await appendSignalOutbox(spoolDir, entry);
    const again = await svc.tick();
    expect(again.drained.delivered).toBe(1);
    expect(store.getPendingSignal(task.id)?.raisedAt).toBe(raisedAt);
  });
});
