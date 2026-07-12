import { describe, test, expect, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { BackendError } from '../adapters/terminal-backend.js';
import type { TurnState } from '../shared/protocol.js';
import { runPostRestartRecovery, isExpectedWorking } from './post-restart-recovery.js';

function addResumedSession(
  store: TaskStore,
  sessionId: string,
  turnState: TurnState | undefined,
): void {
  const task = store.createTask('do the work', '/tmp/project');
  store.addSession(task.id, {
    tmuxSession: sessionId,
    agentType: 'claude-code',
    cwd: '/tmp/project',
    createdAt: new Date(),
    lastStatus: 'running',
    ...(turnState ? { lastTurnState: turnState } : {}),
  });
}

async function makeAliveSession(backend: FakeTerminalBackend, id: string): Promise<void> {
  await backend.createSession({ id, command: 'claude', args: [] });
}

describe('isExpectedWorking', () => {
  test('only a running turn is expected to be producing output', () => {
    expect(isExpectedWorking('running')).toBe(true);
    expect(isExpectedWorking('completed_turn')).toBe(false);
    expect(isExpectedWorking('waiting_for_input')).toBe(false);
    expect(isExpectedWorking('blocked')).toBe(false);
    expect(isExpectedWorking('unknown')).toBe(false);
    expect(isExpectedWorking(undefined)).toBe(false);
  });
});

describe('runPostRestartRecovery', () => {
  test('classifies a live session and forwards expectWorking=true for a running turn', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-live');
    addResumedSession(store, 'sess-live', 'running');

    const spy = vi.spyOn(backend, 'verifyRecoveredSession');
    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-live'],
      restartEpoch: 1000,
    });

    expect(summary.verified).toHaveLength(1);
    expect(summary.verified[0].classification).toBe('recovered-live');
    expect(summary.verified[0].restartEpoch).toBe(1000);
    expect(summary.live).toBe(1);
    expect(summary.idle + summary.repaired + summary.unverified).toBe(0);
    // A running turn is verified with expectWorking = true, and the epoch forwarded.
    expect(spy).toHaveBeenCalledWith(
      'sess-live',
      expect.objectContaining({ expectWorking: true, restartEpoch: 1000 }),
    );
  });

  test('a completed-turn session with a wedged transport is left idle, not repaired', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-idle');
    backend.setRecoveryWedged('sess-idle', true);
    addResumedSession(store, 'sess-idle', 'completed_turn');

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-idle'],
      restartEpoch: 2000,
    });

    expect(summary.verified[0].classification).toBe('recovered-idle');
    expect(summary.verified[0].repairAttempts).toBe(0);
    expect(summary.idle).toBe(1);
  });

  test('a running session whose transport stays wedged surfaces a distinct unverified finding', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-wedged');
    backend.setRecoveryWedged('sess-wedged', true); // permanent wedge
    addResumedSession(store, 'sess-wedged', 'running');

    const findings: BackendError[] = [];
    backend.onBackendError((e) => findings.push(e));

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-wedged'],
      restartEpoch: 3000,
      maxRepairAttempts: 2,
    });

    expect(summary.verified[0].classification).toBe('recovered-unverified');
    expect(summary.verified[0].failureReason).toBe('no-liveness-after-repair');
    expect(summary.unverified).toBe(1);
    // Distinct, actionable finding — never the watchdog's stale_agent.
    const unverified = findings.filter((f) => f.kind === 'session-recovery-unverified');
    expect(unverified).toHaveLength(1);
    expect(findings.some((f) => f.kind === 'stale_agent')).toBe(false);
  });

  test('a wedged working transport that a repair clears is counted as repaired', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-repair');
    backend.setRecoveryWedged('sess-repair', true, 1); // live again after 1 repair
    addResumedSession(store, 'sess-repair', 'running');

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-repair'],
      restartEpoch: 4000,
      maxRepairAttempts: 3,
    });

    expect(summary.verified[0].classification).toBe('recovered-live');
    expect(summary.verified[0].repairAttempts).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(summary.live).toBe(0);
  });

  test('recovers multiple sessions concurrently; one failure does not block the others', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    for (const id of ['multi-a', 'multi-b', 'multi-wedged', 'multi-throw']) {
      await makeAliveSession(backend, id);
    }
    backend.setRecoveryWedged('multi-wedged', true);
    // A legitimately-quiet idle session: silent transport, not expected working.
    backend.setRecoveryWedged('multi-b', true);
    addResumedSession(store, 'multi-a', 'running');
    addResumedSession(store, 'multi-b', 'completed_turn');
    addResumedSession(store, 'multi-wedged', 'running');
    addResumedSession(store, 'multi-throw', 'running');

    // One session's verification throws outright — must not block the rest.
    const orig = backend.verifyRecoveredSession.bind(backend);
    backend.verifyRecoveredSession = async (id, opts) => {
      if (id === 'multi-throw') throw new Error('verify boom');
      return orig(id, opts);
    };

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['multi-a', 'multi-b', 'multi-wedged', 'multi-throw'],
      restartEpoch: 5000,
      maxRepairAttempts: 1,
    });

    expect(summary.live).toBe(1); // multi-a (running, healthy)
    expect(summary.idle).toBe(1); // multi-b (completed_turn)
    expect(summary.unverified).toBe(1); // multi-wedged
    expect(summary.errors).toEqual([{ sessionId: 'multi-throw', error: 'verify boom' }]);
    // The thrower produced no verified result but the other three completed.
    expect(summary.verified).toHaveLength(3);
  });

  test('normalizes a non-Error rejection into the errors list', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-str-throw');
    addResumedSession(store, 'sess-str-throw', 'running');
    backend.verifyRecoveredSession = async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain string failure';
    };

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-str-throw'],
      restartEpoch: 8000,
    });

    expect(summary.verified).toHaveLength(0);
    expect(summary.errors).toEqual([{ sessionId: 'sess-str-throw', error: 'plain string failure' }]);
  });

  test('bounds fleet-wide verification concurrency', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    const ids = Array.from({ length: 6 }, (_, i) => `bound-${i}`);
    for (const id of ids) {
      await makeAliveSession(backend, id);
      addResumedSession(store, id, 'running');
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const orig = backend.verifyRecoveredSession.bind(backend);
    backend.verifyRecoveredSession = async (id, opts) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try {
        return await orig(id, opts);
      } finally {
        inFlight -= 1;
      }
    };

    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ids,
      restartEpoch: 9000,
      maxConcurrency: 2,
    });

    expect(summary.verified).toHaveLength(6);
    expect(summary.live).toBe(6);
    expect(maxInFlight).toBeLessThanOrEqual(2); // never exceeded the fleet cap
  });

  test('is a no-op when the backend cannot verify recovered sessions', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    // A backend without the optional method (older/other transport).
    const noVerify = Object.assign(
      Object.create(Object.getPrototypeOf(backend)),
      backend,
    );
    noVerify.verifyRecoveredSession = undefined;
    addResumedSession(store, 'sess-x', 'running');

    const summary = await runPostRestartRecovery({
      terminalBackend: noVerify,
      taskStore: store,
      resumedSessions: ['sess-x'],
      restartEpoch: 6000,
    });

    expect(summary.verified).toHaveLength(0);
    expect(summary.live + summary.idle + summary.repaired + summary.unverified).toBe(0);
  });

  test('an unknown session name is treated as not-expected-working', async () => {
    const store = new TaskStore();
    const backend = new FakeTerminalBackend();
    await makeAliveSession(backend, 'sess-orphan');
    backend.setRecoveryWedged('sess-orphan', true);
    // No task registered for this session name → turn state undefined.

    const spy = vi.spyOn(backend, 'verifyRecoveredSession');
    const summary = await runPostRestartRecovery({
      terminalBackend: backend,
      taskStore: store,
      resumedSessions: ['sess-orphan'],
      restartEpoch: 7000,
    });

    expect(spy).toHaveBeenCalledWith('sess-orphan', expect.objectContaining({ expectWorking: false }));
    // Wedged but not-expected-working → idle, no repair.
    expect(summary.verified[0].classification).toBe('recovered-idle');
    expect(summary.idle).toBe(1);
  });
});
