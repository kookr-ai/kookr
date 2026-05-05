import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import type { AgentEvent, Anomaly } from '../core/types.js';
import type { ServerMessage } from '../shared/protocol.js';
import { AutoProceedService } from './auto-proceed.js';

// These match the internal constants in auto-proceed.ts
const MAX_RETRIES = 2;
const DEFAULT_DELAY_MS = 180_000;

// Minimal fake adapter that records sendInput calls
function createFakeAdapter() {
  const inputs: Array<{ agentId: string; text: string }> = [];
  let captureThrows = false;
  return {
    agentType: 'test' as const,
    inputs,
    setCaptureThrows(v: boolean) { captureThrows = v; },
    async launch() { return 'test-session'; },
    async sendInput(agentId: string, text: string) { inputs.push({ agentId, text }); },
    async sendKeystroke() {},
    async stop() {},
    async captureDisplay(agentId: string) {
      if (captureThrows) throw new Error('session dead');
      return `display for ${agentId}`;
    },
    onEvent() {},
    onRefreshNeeded() {},
    injectHookEvent() {},
  };
}

describe('AutoProceedService', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let adapter: ReturnType<typeof createFakeAdapter>;
  let service: AutoProceedService;
  let broadcasts: ServerMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    adapter = createFakeAdapter();
    broadcasts = [];

    service = new AutoProceedService({
      taskStore,
      monitor,
      queue,
      adapter,
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test',
    });
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
  });

  /** Helper: create an autonomous task with a stop-type needs_input anomaly */
  function setupAutonomousTask(agentId = 'agent-1') {
    const task = taskStore.createTask({ prompt: 'test', cwd: '/test', autonomy: 'autonomous' });
    taskStore.addSession(task.id, {
      tmuxSession: agentId,
      agentType: 'claude-code',
      cwd: '/test',
      createdAt: new Date(),
    });
    monitor.registerAgent(agentId);
    // Simulate stop event → needs_input anomaly with subType: 'stop'
    monitor.processEvents(agentId, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Done with this step' },
    ]);
    return task;
  }

  // --- Timer lifecycle ---

  test('schedule() sets timer and proceedAt', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);

    expect(service.hasTimer('agent-1')).toBe(true);
    expect(service.getActiveProceedAt('agent-1')).toBeDefined();
  });

  test('schedule() is idempotent — replaces existing timer', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);
    const first = service.getActiveProceedAt('agent-1');

    vi.advanceTimersByTime(1000);
    service.schedule('agent-1', 5000);
    const second = service.getActiveProceedAt('agent-1');

    expect(service.hasTimer('agent-1')).toBe(true);
    // New proceedAt should be later than the first
    expect(new Date(second!).getTime()).toBeGreaterThan(new Date(first!).getTime());
  });

  test('cancel() clears timer and proceedAt', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);

    const cancelled = service.cancel('agent-1');
    expect(cancelled).toBe(true);
    expect(service.hasTimer('agent-1')).toBe(false);
    expect(service.getActiveProceedAt('agent-1')).toBeUndefined();
  });

  test('cancel() returns false if no timer exists', () => {
    expect(service.cancel('no-such-agent')).toBe(false);
  });

  test('cancel() broadcasts snapshot to clear countdown', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);
    broadcasts.length = 0;

    service.cancel('agent-1');
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts[0].type).toBe('snapshot');
  });

  test('cancelAllForTask() cancels all agent timers for a task', () => {
    const task = taskStore.createTask({ prompt: 'test', cwd: '/test', autonomy: 'autonomous' });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-a',
      agentType: 'claude-code',
      cwd: '/test',
      createdAt: new Date(),
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-b',
      agentType: 'claude-code',
      cwd: '/test',
      createdAt: new Date(),
    });
    monitor.registerAgent('agent-a');
    monitor.registerAgent('agent-b');
    monitor.processEvents('agent-a', [{ type: 'stop', sessionId: 's1', lastMessage: 'Step done' }]);
    monitor.processEvents('agent-b', [{ type: 'stop', sessionId: 's2', lastMessage: 'Step done' }]);

    service.schedule('agent-a', 5000);
    service.schedule('agent-b', 5000);

    service.cancelAllForTask(task.id, 'level_change');

    expect(service.hasTimer('agent-a')).toBe(false);
    expect(service.hasTimer('agent-b')).toBe(false);
  });

  // --- fire() behavior ---

  test('fire() sends "yes" after delay', async () => {
    setupAutonomousTask();
    service.schedule('agent-1', 1000);

    vi.advanceTimersByTime(1000);
    // Allow async fire() to complete
    await vi.runAllTimersAsync();

    expect(adapter.inputs).toHaveLength(1);
    expect(adapter.inputs[0]).toEqual({ agentId: 'agent-1', text: 'yes' });
  });

  test('fire() clears anomaly via markInputReceived + respondAndAdvance', async () => {
    setupAutonomousTask();
    service.schedule('agent-1', 1000);

    // Verify active queue entry exists before fire
    const allBefore = queue.getAll();
    expect(allBefore.some(e => e.agentId === 'agent-1')).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);

    // After fire, the active queue should no longer have the entry
    const allAfter = queue.getAll();
    expect(allAfter.some(e => e.agentId === 'agent-1')).toBe(false);
  });

  test('fire() increments autoProceedRetries on task', async () => {
    const task = setupAutonomousTask();
    expect(task.autoProceedRetries).toBeUndefined();

    service.schedule('agent-1', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(task.autoProceedRetries).toBe(1);
  });

  test('fire() skips if task is no longer autonomous', async () => {
    const task = setupAutonomousTask();
    service.schedule('agent-1', 1000);

    // Change to supervised before timer fires
    task.autonomy = 'supervised';

    await vi.advanceTimersByTimeAsync(1000);

    expect(adapter.inputs).toHaveLength(0);
  });

  test('fire() skips if anomaly is no longer needs_input', async () => {
    setupAutonomousTask();
    service.schedule('agent-1', 1000);

    // Clear the anomaly by injecting an input_received event
    monitor.markInputReceived('agent-1');

    await vi.advanceTimersByTimeAsync(1000);

    expect(adapter.inputs).toHaveLength(0);
  });

  test('fire() skips if session is dead', async () => {
    setupAutonomousTask();
    service.schedule('agent-1', 1000);
    adapter.setCaptureThrows(true);

    await vi.advanceTimersByTimeAsync(1000);

    expect(adapter.inputs).toHaveLength(0);
  });

  // --- Race guard ---

  test('isFiring() returns true during fire execution', async () => {
    setupAutonomousTask();
    let wasFiring = false;

    // Replace sendInput with a slow one that checks isFiring
    const originalSendInput = adapter.sendInput.bind(adapter);
    adapter.sendInput = async (agentId: string, text: string) => {
      wasFiring = service.isFiring(agentId);
      await originalSendInput(agentId, text);
    };

    service.schedule('agent-1', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(wasFiring).toBe(true);
    // After fire completes, isFiring should be false
    expect(service.isFiring('agent-1')).toBe(false);
  });

  // --- Retry exhaustion ---

  test('schedule() refuses when retries >= MAX_RETRIES', () => {
    const task = setupAutonomousTask();
    task.autoProceedRetries = MAX_RETRIES;

    service.schedule('agent-1', 1000);

    expect(service.hasTimer('agent-1')).toBe(false);
  });

  test('fire() escalates to supervised when retries exhausted', async () => {
    const task = setupAutonomousTask();
    task.autoProceedRetries = MAX_RETRIES;

    // Manually trigger fire by scheduling with lower count then bumping
    task.autoProceedRetries = MAX_RETRIES - 1;
    service.schedule('agent-1', 1000);

    // Now set retries to max before fire happens
    task.autoProceedRetries = MAX_RETRIES;

    await vi.advanceTimersByTimeAsync(1000);

    // Should have escalated: task is now supervised
    expect(task.autonomy).toBe('supervised');
    expect(adapter.inputs).toHaveLength(0);
  });

  test('escalation sets task autonomy to supervised', async () => {
    const task = setupAutonomousTask();

    // Fire twice to exhaust retries (MAX_RETRIES = 2)
    for (let i = 0; i < MAX_RETRIES; i++) {
      // Re-create the stop event so anomaly is re-detected
      monitor.processEvents('agent-1', [
        { type: 'stop', sessionId: 's1', lastMessage: 'Step done' },
      ]);
      service.schedule('agent-1', 1000);
      await vi.advanceTimersByTimeAsync(1000);
    }

    // After MAX_RETRIES fires, the next schedule should refuse
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Step done' },
    ]);
    service.schedule('agent-1', 1000);
    expect(service.hasTimer('agent-1')).toBe(false);
  });

  // --- sendInput failure ---

  test('fire() handles sendInput failure gracefully', async () => {
    const task = setupAutonomousTask();

    // Make sendInput throw
    adapter.sendInput = async () => { throw new Error('terminal send failed'); };

    service.schedule('agent-1', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    // Should have incremented retries even on failure
    expect(task.autoProceedRetries).toBe(1);
  });

  // --- Default delay ---

  test('schedule() uses task autoProceedDelayMs if set', () => {
    const task = setupAutonomousTask();
    task.autoProceedDelayMs = 60_000;

    service.schedule('agent-1');
    const proceedAt = service.getActiveProceedAt('agent-1')!;
    const delay = new Date(proceedAt).getTime() - Date.now();

    expect(delay).toBeCloseTo(60_000, -2); // within ~100ms
  });

  test('schedule() falls back to DEFAULT_DELAY_MS', () => {
    setupAutonomousTask();

    service.schedule('agent-1');
    const proceedAt = service.getActiveProceedAt('agent-1')!;
    const delay = new Date(proceedAt).getTime() - Date.now();

    expect(delay).toBeCloseTo(DEFAULT_DELAY_MS, -2);
  });

  // --- dispose ---

  test('dispose() clears all timers', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);

    service.dispose();

    expect(service.hasTimer('agent-1')).toBe(false);
    expect(service.getActiveProceedAt('agent-1')).toBeUndefined();
  });

  // --- Snapshot enrichment ---

  test('getAllProceedAt() returns active timestamps', () => {
    setupAutonomousTask();
    service.schedule('agent-1', 5000);

    const map = service.getAllProceedAt();
    expect(map.size).toBe(1);
    expect(map.has('agent-1')).toBe(true);
  });

  // --- User-attached guard ---

  test('fire() reschedules when user is attached to terminal session', async () => {
    // Recreate service with hasAttachedClients returning true
    service.dispose();
    service = new AutoProceedService({
      taskStore,
      monitor,
      queue,
      adapter,
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test',
      hasAttachedClients: () => true,
    });

    setupAutonomousTask();
    service.schedule('agent-1', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    // Should NOT have sent input — user is attached
    expect(adapter.inputs).toHaveLength(0);
    // Should have rescheduled (timer still active)
    expect(service.hasTimer('agent-1')).toBe(true);
  });

  test('fire() proceeds when no clients attached', async () => {
    // Recreate service with hasAttachedClients returning false
    service.dispose();
    service = new AutoProceedService({
      taskStore,
      monitor,
      queue,
      adapter,
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test',
      hasAttachedClients: () => false,
    });

    setupAutonomousTask();
    service.schedule('agent-1', 1000);
    await vi.advanceTimersByTimeAsync(1000);

    // Should have sent "yes"
    expect(adapter.inputs).toHaveLength(1);
    expect(adapter.inputs[0]).toEqual({ agentId: 'agent-1', text: 'yes' });
  });
});
