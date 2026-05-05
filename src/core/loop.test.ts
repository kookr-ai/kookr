import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AgentEvent } from './types.js';
import { TaskStore } from './tasks.js';
import { AttentionQueue } from './attention-queue.js';
import { Monitor } from './monitor.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { MessageRouter } from '../server/ws.js';
import type { ServerMessage } from '../shared/protocol.js';

/**
 * Integration tests for the full "respond and advance" loop.
 * All core modules wired together, but with fake I/O (FakeTerminalBackend).
 */
describe('The Loop — Integration', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];
    router = new MessageRouter(taskStore, queue, monitor, adapter, (msg) => {
      sentMessages.push(msg);
    });
  });

  test('agent stops -> user responds -> auto-advance to next', async () => {
    // Launch two agents
    const t1 = taskStore.createTask('Fix auth bug', '/cwd1');
    const tmux1 = await adapter.launch(t1.id, 'Fix auth', '/cwd1');

    const t2 = taskStore.createTask('Add pagination', '/cwd2');
    const tmux2 = await adapter.launch(t2.id, 'Add pagination', '/cwd2');

    // Agent 1 stops (needs input)
    monitor.processEvents(tmux1, [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash' },
      { type: 'stop', sessionId: 's1', lastMessage: 'Which auth library should I use?' },
    ]);

    // Agent 2 also stops
    monitor.processEvents(tmux2, [
      { type: 'tool_use', sessionId: 's2', toolName: 'Read' },
      { type: 'stop', sessionId: 's2', lastMessage: 'How many items per page?' },
    ]);

    // Queue should have both agents
    expect(queue.getAll()).toHaveLength(2);

    // User responds to current agent (agent 1) and advances
    const next = queue.respondAndAdvance(tmux1);
    expect(next).not.toBeNull();
    expect(next!.agentId).toBe(tmux2);

    // Send the actual response
    await adapter.sendInput(tmux1, 'Use jsonwebtoken library');
    expect(terminal.getWrittenText(tmux1)).toContain('jsonwebtoken');
  });

  test('3 agents, 2 need attention -> respond to #1 -> advance to #2 -> respond -> all clear', async () => {
    // Launch 3 agents
    const t1 = taskStore.createTask('Task 1', '/cwd');
    const tmux1 = await adapter.launch(t1.id, 'Task 1', '/cwd');

    const t2 = taskStore.createTask('Task 2', '/cwd');
    const tmux2 = await adapter.launch(t2.id, 'Task 2', '/cwd');

    const t3 = taskStore.createTask('Task 3', '/cwd');
    const tmux3 = await adapter.launch(t3.id, 'Task 3', '/cwd');

    // Agent 1: permission blocked (warning)
    monitor.processEvents(tmux1, [
      { type: 'permission_request' as const, sessionId: 's1', toolName: 'Bash' },
    ]);

    // Agent 2: needs input (info)
    monitor.processEvents(tmux2, [
      { type: 'stop', sessionId: 's2', lastMessage: 'Need guidance' },
    ]);

    // Agent 3: working fine
    monitor.processEvents(tmux3, [
      { type: 'tool_use', sessionId: 's3', toolName: 'Read' },
      { type: 'tool_use', sessionId: 's3', toolName: 'Edit' },
    ]);

    // Queue should have 2 agents
    expect(queue.getAll()).toHaveLength(2);

    // First bottleneck should be permission_blocked (warning > info)
    const first = queue.next();
    expect(first!.agentId).toBe(tmux1);
    expect(first!.anomaly.type).toBe('permission_blocked');

    // Respond to #1, advance to #2
    const second = queue.respondAndAdvance(tmux1);
    expect(second).not.toBeNull();
    expect(second!.agentId).toBe(tmux2);
    expect(second!.anomaly.type).toBe('needs_input');

    // Respond to #2
    const third = queue.respondAndAdvance(tmux2);
    expect(third).toBeNull(); // All clear!
    expect(queue.isAllClear()).toBe(true);
  });

  test('skip agent -> advance to next -> skipped agent gets new anomaly -> re-enters queue', () => {
    // Two agents with anomalies
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);
    monitor.processEvents('agent-2', [
      { type: 'stop', sessionId: 's2', lastMessage: 'Also help' },
    ]);

    // Skip agent-1
    queue.skip('agent-1');

    // agent-2 should be next
    expect(queue.next()!.agentId).toBe('agent-2');

    // agent-1 gets a new, more severe anomaly (permission blocked)
    monitor.processEvents('agent-1', [
      { type: 'permission_request' as const, sessionId: 's1', toolName: 'Bash' },
    ]);

    // agent-1 should now be first (warning > info)
    expect(queue.next()!.agentId).toBe('agent-1');
    expect(queue.next()!.anomaly.type).toBe('permission_blocked');
  });

  test('snooze agent for duration -> after duration, agent re-evaluated', () => {
    vi.useFakeTimers();

    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);

    queue.snooze('agent-1', 5000);
    expect(queue.next()).toBeNull();

    vi.advanceTimersByTime(5001);

    // Agent should re-enter after snooze
    expect(queue.next()).not.toBeNull();
    expect(queue.next()!.agentId).toBe('agent-1');
  });

  test('snooze agent -> getSnapshot includes snoozedUntil so frontend can filter', () => {
    vi.useFakeTimers({ now: 1000000 });

    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);

    // Before snooze: snapshot has anomaly, no snoozedUntil
    const before = monitor.getSnapshot();
    const agentBefore = before.find((a) => a.agentId === 'agent-1')!;
    expect(agentBefore.anomaly).not.toBeNull();
    expect(agentBefore.snoozedUntil).toBeUndefined();

    // Snooze for 5 seconds
    queue.snooze('agent-1', 5000);

    // After snooze: snapshot still has anomaly but also snoozedUntil
    const after = monitor.getSnapshot();
    const agentAfter = after.find((a) => a.agentId === 'agent-1')!;
    expect(agentAfter.anomaly).not.toBeNull();
    expect(agentAfter.snoozedUntil).toBe(1000000 + 5000);

    // After snooze expires: snoozedUntil should be gone
    vi.advanceTimersByTime(5001);
    const expired = monitor.getSnapshot();
    const agentExpired = expired.find((a) => a.agentId === 'agent-1')!;
    expect(agentExpired.anomaly).not.toBeNull();
    expect(agentExpired.snoozedUntil).toBeUndefined();
  });

  test('agent completes while snoozed -> stays completed, no re-entry', () => {
    vi.useFakeTimers();

    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);

    queue.snooze('agent-1', 5000);
    queue.purge('agent-1'); // Agent completed while snoozed — purge clears both maps

    vi.advanceTimersByTime(5001);

    // Should NOT re-enter
    expect(queue.next()).toBeNull();
    expect(queue.isAllClear()).toBe(true);
  });
});
