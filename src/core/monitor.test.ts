import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { AgentEvent } from './types.js';
import { Monitor } from './monitor.js';
import { TaskStore } from './tasks.js';
import { AttentionQueue } from './attention-queue.js';
import { getDetectionStats, resetDetectionStats } from './detection-stats.js';

function makeToolUse(sessionId: string, toolName: string, toolInput?: unknown, toolUseId?: string): AgentEvent {
  return { type: 'tool_use', sessionId, toolName, toolInput, toolUseId };
}

function makeStop(sessionId: string, lastMessage = ''): AgentEvent {
  return { type: 'stop', sessionId, lastMessage };
}

function makePermissionRequest(sessionId: string, toolName: string): AgentEvent {
  return { type: 'permission_request', sessionId, toolName };
}

function makeToolResult(sessionId: string, toolName: string, toolUseId?: string, toolResponse?: unknown): AgentEvent {
  return { type: 'tool_result', sessionId, toolName, toolUseId, toolResponse };
}

function makeSubagentStop(sessionId: string, agentId = 'subagent-1'): AgentEvent {
  return { type: 'subagent_stop', sessionId, agentId, agentType: 'test-agent', lastMessage: 'subagent done' };
}

describe('Monitor', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;

  beforeEach(() => {
    resetDetectionStats();
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
  });

  test('Stop event for agent enters attention queue as needs_input', () => {
    const events: AgentEvent[] = [
      makeToolUse('s1', 'Bash'),
      makeToolResult('s1', 'Bash'),
      makeStop('s1', 'I need help deciding which approach.'),
    ];

    monitor.processEvents('agent-1', events);

    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.agentId).toBe('agent-1');
    expect(next!.anomaly.type).toBe('needs_input');
  });

  test('agent produces activity after Stop - removed from queue', () => {
    // First: agent stops
    monitor.processEvents('agent-1', [
      makeStop('s1', 'Waiting for input'),
    ]);
    expect(queue.next()).not.toBeNull();

    // Then: agent resumes with new activity
    monitor.processEvents('agent-1', [
      makeStop('s1', 'Waiting for input'),
      makeToolUse('s1', 'Bash'),
    ]);
    expect(queue.next()).toBeNull();
  });

  test('Stop followed by SubagentStop and idle notification remains queued as needs_input', () => {
    monitor.processEvents('agent-1', [makeStop('s1', 'PR opened. Nothing to do until review.')]);
    expect(queue.next()!.anomaly.type).toBe('needs_input');

    monitor.processEvents('agent-1', [makeSubagentStop('s1')]);
    expect(queue.next()!.anomaly.type).toBe('needs_input');

    monitor.processEvents('agent-1', [
      { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' },
    ]);
    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.anomaly.type).toBe('needs_input');
    expect(next!.anomaly.explanation).toContain('PR opened');
  });

  test('repeated same-tool calls do not produce anomaly', () => {
    const events = Array.from({ length: 20 }, () =>
      makeToolUse('s1', 'Read'),
    );

    monitor.processEvents('agent-1', events);

    const next = queue.next();
    expect(next).toBeNull();
  });

  test('PermissionRequest event enters queue as permission_blocked', () => {
    monitor.processEvents('agent-1', [
      makePermissionRequest('s1', 'Bash'),
    ]);

    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.anomaly.type).toBe('permission_blocked');
  });

  test('multiple agents - only blocked agent queued', () => {
    // Agent 1: permission blocked
    monitor.processEvents('agent-1', [
      makePermissionRequest('s1', 'Bash'),
    ]);

    // Agent 2: normal activity
    monitor.processEvents('agent-2', [
      makeToolUse('s2', 'Read'),
      makeToolUse('s2', 'Edit'),
      makeToolResult('s2', 'Edit'),
    ]);

    const all = queue.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].agentId).toBe('agent-1');
  });

  test('snoozed agent skipped during poll cycle', () => {
    monitor.processEvents('agent-1', [makeStop('s1', 'Need help')]);
    queue.snooze('agent-1', 60000);

    expect(queue.next()).toBeNull();
  });

  test('getSnapshot excludes stale anomaly state for completed tasks', () => {
    const task = taskStore.createTask({ prompt: 'ship it', cwd: '/repo' });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-08T10:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.completeTask(task.id);

    monitor.processEvents('agent-1', [makeStop('s1', 'done')]);

    const snapshot = monitor.getSnapshot();
    const terminalEntry = snapshot.find((state) => state.taskId === task.id);
    expect(snapshot.filter((state) => state.agentId === 'agent-1')).toHaveLength(1);
    expect(terminalEntry).toBeDefined();
    expect(terminalEntry!.taskStatus).toBe('completed');
    expect(terminalEntry!.anomaly).toBeNull();
  });

  test('getSnapshot hides completed Ralph iteration sessions while keeping live owner visible', () => {
    const task = taskStore.createTask({ prompt: 'loop', cwd: '/repo' });
    task.ralphLoop = {
      prompt: 'again',
      iterationCap: 5,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 2,
      ownerSessionId: 'agent-live',
    };
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-old',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-08T10:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-live',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-08T10:05:00Z'),
    });

    monitor.processEvents('agent-old', [makeStop('s1', 'iteration done')]);
    monitor.registerAgent('agent-live');

    const snapshot = monitor.getSnapshot();
    expect(snapshot.some((state) => state.agentId === 'agent-old')).toBe(false);
    const live = snapshot.find((state) => state.agentId === 'agent-live');
    expect(live).toBeDefined();
    expect(live!.taskId).toBe(task.id);
    expect(live!.anomaly).toBeNull();
    expect(live!.ralphLoop?.ownerSessionId).toBe('agent-live');
  });

  test('processEvents accumulates events across calls', () => {
    // Send events one at a time (as the live server does)
    for (let i = 0; i < 6; i++) {
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
    }
    // Then agent stops
    monitor.processEvents('agent-1', [makeStop('s1', 'Done')]);

    // After accumulated events + stop, needs_input should be detected
    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.anomaly.type).toBe('needs_input');
  });

  test('processEvents records detection telemetry, but getSnapshot does not', () => {
    monitor.processEvents('agent-1', [makeStop('s1', 'Waiting')]);

    const afterWrite = getDetectionStats();
    expect(afterWrite.checks.needs_input).toBe(1);
    expect(afterWrite.fires.needs_input).toBe(1);

    monitor.getSnapshot();
    monitor.getSnapshot();

    const afterReads = getDetectionStats();
    expect(afterReads.checks.needs_input).toBe(1);
    expect(afterReads.fires.needs_input).toBe(1);
  });

  test('unchanged active anomaly does not record repeated fires', () => {
    monitor.processEvents('agent-1', [makeStop('s1', 'Waiting')]);
    monitor.processEvents('agent-1', [
      { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' },
    ]);

    const stats = getDetectionStats();
    expect(stats.checks.needs_input).toBe(2);
    expect(stats.fires.needs_input).toBe(1);
  });

  test('merge_conflict telemetry fires once for the conflicting git result', () => {
    monitor.processEvents('agent-1', [
      makeToolUse('s1', 'Bash', { command: 'git merge feature' }, 'toolu_1'),
      makeToolResult(
        's1',
        'Bash',
        'toolu_1',
        'CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
      ),
    ]);
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Read')]);

    const stats = getDetectionStats();
    expect(stats.fires.merge_conflict).toBe(1);
  });

  test('processEvents caps at window size', () => {
    const smallMonitor = new Monitor(taskStore, queue, undefined, 5);

    // Send 10 events with distinct tool names so we can verify which are kept
    for (let i = 0; i < 10; i++) {
      smallMonitor.processEvents('agent-1', [makeToolUse('s1', `Tool-${i}`)]);
    }

    const snapshot = smallMonitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');
    expect(a1!.events).toHaveLength(5);
    // Implementation keeps the LAST N events (trailing window via slice(-windowSize))
    const toolNames = a1!.events.map((e) => (e as { toolName: string }).toolName);
    expect(toolNames).toEqual(['Tool-5', 'Tool-6', 'Tool-7', 'Tool-8', 'Tool-9']);
  });

  test('processEvents stamps monotonic eventSeq for client activity history merging', () => {
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const events = snapshot.find((s) => s.agentId === 'agent-1')!.events as Array<AgentEvent & { eventSeq?: number }>;
    expect(events.map((event) => event.eventSeq)).toEqual([1, 2]);
  });

  test('permission_blocked then stop downgrades to needs_input in queue', () => {
    // First: agent is blocked
    monitor.processEvents('agent-1', [
      makePermissionRequest('s1', 'Bash'),
    ]);
    expect(queue.next()!.anomaly.type).toBe('permission_blocked');

    // Then: agent stops (completed its turn)
    monitor.processEvents('agent-1', [makeStop('s1', 'Finished.')]);
    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.anomaly.type).toBe('needs_input');
  });

  test('AskUserQuestion tool enters queue as needs_input with warning severity', () => {
    monitor.processEvents('agent-1', [
      makeToolUse('s1', 'AskUserQuestion'),
    ]);

    const next = queue.next();
    expect(next).not.toBeNull();
    expect(next!.anomaly.type).toBe('needs_input');
    expect(next!.anomaly.severity).toBe('warning');
  });

  test('AskUserQuestion followed by tool_result clears anomaly from queue', () => {
    monitor.processEvents('agent-1', [
      makeToolUse('s1', 'AskUserQuestion'),
    ]);
    expect(queue.next()).not.toBeNull();

    monitor.processEvents('agent-1', [
      makeToolResult('s1', 'AskUserQuestion'),
    ]);
    expect(queue.next()).toBeNull();
  });

  test('getSnapshot returns state for all known agents', () => {
    monitor.processEvents('agent-1', [makeStop('s1', 'Need help')]);
    monitor.processEvents('agent-2', [makeToolUse('s2', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    expect(snapshot).toHaveLength(2);

    const a1 = snapshot.find((s) => s.agentId === 'agent-1');
    expect(a1).toBeDefined();
    expect(a1!.anomaly).not.toBeNull();
    expect(a1!.anomaly!.type).toBe('needs_input');
    expect(a1!.anomaly!.severity).toBe('info');

    const a2 = snapshot.find((s) => s.agentId === 'agent-2');
    expect(a2).toBeDefined();
    expect(a2!.anomaly).toBeNull();
  });

  test('getSnapshot falls back to active queue anomalies when no event anomaly exists', () => {
    monitor.registerAgent('agent-1');
    queue.enqueue('agent-1', {
      agentId: 'agent-1',
      type: 'stale_agent',
      severity: 'warning',
      explanation: 'Pane shows shell prompt',
      detectedAt: new Date('2026-04-06T10:00:00Z'),
    });

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1).toBeDefined();
    expect(a1!.anomaly).not.toBeNull();
    expect(a1!.anomaly!.type).toBe('stale_agent');
    expect(a1!.anomaly!.detectedAt.toISOString()).toBe('2026-04-06T10:00:00.000Z');
  });

  test('getSnapshot includes task metadata when task is linked', () => {
    const task = taskStore.createTask('Fix auth token refresh in the login flow', '/home/user/webapp');
    taskStore.setProjectId(task.id, 'github.com/acme/webapp');
    const sessionCreatedAt = new Date('2026-03-24T10:00:00Z');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/home/user/webapp',
      createdAt: sessionCreatedAt,
    });
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1).toBeDefined();
    expect(a1!.taskId).toBe(task.id);
    expect(a1!.taskName).toBe('Fix auth token refresh in the login flow');
    expect(a1!.cwd).toBe('/home/user/webapp');
    expect(a1!.agentType).toBe('claude-code');
    expect(a1!.startedAt).toBe(sessionCreatedAt.toISOString());
    expect(a1!.projectId).toBe('github.com/acme/webapp');
    expect(a1!.projectDisplayLabel).toBe('webapp');
  });

  test('getSnapshot uses projectId for stable display label across worktrees', () => {
    const task = taskStore.createTask('Investigate prod issue', '/path/to/kookr-prod');
    taskStore.setProjectId(task.id, 'github.com/kookr-ai/kookr');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/path/to/kookr-prod',
      createdAt: new Date('2026-03-24T10:00:00Z'),
    });
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1!.projectDisplayLabel).toBe('kookr');
  });

  test('getSnapshot uses task.name over truncated prompt when set', () => {
    const task = taskStore.createTask('Fix auth token refresh in the login flow', '/cwd');
    taskStore.renameTask(task.id, 'Auth fix');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1!.taskName).toBe('Auth fix');
  });

  test('getSnapshot truncates long task prompts for taskName', () => {
    const longPrompt = 'Refactor the authentication middleware to support OAuth2 with PKCE flow and add comprehensive integration tests for all edge cases';
    const task = taskStore.createTask(longPrompt, '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1!.taskName!.length).toBeLessThanOrEqual(63); // 60 + "..."
    expect(a1!.taskName).toMatch(/\.\.\.$/);
  });

  test('getSnapshot returns no metadata when agent has no linked task', () => {
    monitor.processEvents('orphan-agent', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a = snapshot.find((s) => s.agentId === 'orphan-agent');

    expect(a).toBeDefined();
    expect(a!.taskName).toBeUndefined();
    expect(a!.cwd).toBeUndefined();
    expect(a!.agentType).toBeUndefined();
    expect(a!.startedAt).toBeUndefined();
  });

  test('processEvents after unregisterAgent does NOT resurrect agent', () => {
    // Agent is active and in the snapshot
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
    expect(monitor.getSnapshot()).toHaveLength(1);
    expect(monitor.getSnapshot()[0].agentId).toBe('agent-1');

    // Stop the agent
    monitor.unregisterAgent('agent-1');
    expect(monitor.getSnapshot()).toHaveLength(0);

    // Simulate late-arriving hook events (hook watcher race condition)
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Read')]);

    // Agent should NOT reappear in snapshot
    expect(monitor.getSnapshot()).toHaveLength(0);
  });

  test('registerAgent clears stopped state so re-launch works', () => {
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
    monitor.unregisterAgent('agent-1');
    expect(monitor.getSnapshot()).toHaveLength(0);

    // Re-register (e.g. agent relaunched)
    monitor.registerAgent('agent-1');
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    // Now the agent should appear
    expect(monitor.getSnapshot()).toHaveLength(1);
  });

  test('stopped agent does not enter attention queue from late events', () => {
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
    monitor.unregisterAgent('agent-1');

    // Late permission request should NOT enter queue
    monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);

    expect(queue.next()).toBeNull();
    expect(monitor.getSnapshot()).toHaveLength(0);
  });

  describe('markInputReceived', () => {
    test('clears needs_input after stop event', () => {
      monitor.processEvents('agent-1', [makeStop('s1', 'Waiting for input')]);
      expect(queue.next()!.anomaly.type).toBe('needs_input');

      monitor.markInputReceived('agent-1');

      expect(queue.next()).toBeNull();
      const snapshot = monitor.getSnapshot();
      const a1 = snapshot.find((s) => s.agentId === 'agent-1');
      expect(a1!.anomaly).toBeNull();
    });

    test('clears needs_input after Stop followed by SubagentStop bookkeeping', () => {
      monitor.processEvents('agent-1', [
        makeStop('s1', 'Waiting after closeout'),
        makeSubagentStop('s1'),
      ]);
      expect(queue.next()!.anomaly.type).toBe('needs_input');

      expect(monitor.markInputReceived('agent-1')).toBe(true);

      expect(queue.next()).toBeNull();
      const snapshot = monitor.getSnapshot();
      const a1 = snapshot.find((s) => s.agentId === 'agent-1');
      expect(a1!.anomaly).toBeNull();
    });

    test('clears needs_input after AskUserQuestion', () => {
      monitor.processEvents('agent-1', [
        makeToolUse('s1', 'AskUserQuestion'),
      ]);
      expect(queue.next()!.anomaly.type).toBe('needs_input');

      monitor.markInputReceived('agent-1');

      expect(queue.next()).toBeNull();
      const snapshot = monitor.getSnapshot();
      const a1 = snapshot.find((s) => s.agentId === 'agent-1');
      expect(a1!.anomaly).toBeNull();
    });

    test('clears permission_blocked', () => {
      monitor.processEvents('agent-1', [
        makePermissionRequest('s1', 'Bash'),
      ]);
      expect(queue.next()!.anomaly.type).toBe('permission_blocked');

      monitor.markInputReceived('agent-1');

      expect(queue.next()).toBeNull();
    });

    test('is no-op when agent is not in needs_input state', () => {
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
      expect(queue.next()).toBeNull();

      // Should not throw or change state
      monitor.markInputReceived('agent-1');

      expect(queue.next()).toBeNull();
      expect(monitor.getSnapshot()).toHaveLength(1);
    });

    test('is no-op for unknown agent', () => {
      expect(() => monitor.markInputReceived('nonexistent')).not.toThrow();
    });

    test('is no-op for stopped (unregistered) agent', () => {
      monitor.processEvents('agent-1', [makeStop('s1', 'Waiting')]);
      monitor.unregisterAgent('agent-1');

      expect(() => monitor.markInputReceived('agent-1')).not.toThrow();
      expect(queue.next()).toBeNull();
    });

    test('returns true when finding was cleared', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      expect(monitor.markInputReceived('agent-1')).toBe(true);
    });

    test('returns false when agent is not waiting', () => {
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
      expect(monitor.markInputReceived('agent-1')).toBe(false);
    });

    test('returns false for unknown agent', () => {
      expect(monitor.markInputReceived('nonexistent')).toBe(false);
    });
  });

  describe('isPermissionBlocked', () => {
    test('returns true when last event is permission_request', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      expect(monitor.isPermissionBlocked('agent-1')).toBe(true);
    });

    test('returns false when last event is not permission_request', () => {
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
      expect(monitor.isPermissionBlocked('agent-1')).toBe(false);
    });

    test('returns false for unknown agent', () => {
      expect(monitor.isPermissionBlocked('nonexistent')).toBe(false);
    });

    test('returns false after permission is cleared', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      monitor.markInputReceived('agent-1');
      expect(monitor.isPermissionBlocked('agent-1')).toBe(false);
    });
  });

  describe('getPermissionBlockedAgents', () => {
    test('returns empty array when no agents are blocked', () => {
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);
      expect(monitor.getPermissionBlockedAgents()).toEqual([]);
    });

    test('returns only permission-blocked agents', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      monitor.processEvents('agent-2', [makeToolUse('s2', 'Read')]);
      monitor.processEvents('agent-3', [makePermissionRequest('s3', 'Write')]);

      const blocked = monitor.getPermissionBlockedAgents();
      expect(blocked).toHaveLength(2);
      expect(blocked).toContain('agent-1');
      expect(blocked).toContain('agent-3');
    });

    test('excludes stopped agents', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      monitor.unregisterAgent('agent-1');

      expect(monitor.getPermissionBlockedAgents()).toEqual([]);
    });
  });

  describe('getSnapshot synthetic entries', () => {
    test('includes synthetic entry for pending task with no agent', () => {
      const task = taskStore.createTask('Install dependencies', '/home/user/app');
      // open -> pending
      taskStore.pendTask(task.id);

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.agentId === `pending-${task.id}`);

      expect(entry).toBeDefined();
      expect(entry!.taskStatus).toBe('pending');
      expect(entry!.events).toEqual([]);
      expect(entry!.anomaly).toBeNull();
      expect(entry!.taskName).toBe('Install dependencies');
      expect(entry!.cwd).toBe('/home/user/app');
      expect(entry!.taskId).toBe(task.id);
      expect(entry!.description).toBe('Install dependencies');
      expect(entry!.startedAt).toBe(task.createdAt.toISOString());
    });

    test('includes playbookParameterValues in snapshot for playbook tasks', () => {
      const task = taskStore.createTask({
        prompt: 'Analyze owner/repo',
        cwd: '/home/user/app',
        playbookParameterValues: { repo: 'owner/repo', count: '10' },
      });
      // Set playbookId (normally done by launch-service)
      task.playbookId = 'analyze.md';
      taskStore.pendTask(task.id);

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.playbookId).toBe('analyze.md');
      expect(entry!.playbookParameterValues).toEqual({ repo: 'owner/repo', count: '10' });
    });

    test('includes synthetic entry for completed task after agent unregistered', () => {
      const task = taskStore.createTask('Run database migration', '/home/user/app');
      const sessionCreatedAt = new Date('2026-03-30T12:00:00Z');
      // addSession auto-transitions open -> inProgress
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-c1',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: sessionCreatedAt,
      });
      monitor.registerAgent('agent-c1');
      monitor.processEvents('agent-c1', [makeToolUse('s1', 'Bash')]);

      // Complete the task and unregister the agent
      taskStore.completeTask(task.id);
      monitor.unregisterAgent('agent-c1');

      const snapshot = monitor.getSnapshot();
      // Agent was unregistered, so synthetic entry uses last session's tmuxSession
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('agent-c1');
      expect(entry!.taskStatus).toBe('completed');
      expect(entry!.events).toEqual([]);
      expect(entry!.anomaly).toBeNull();
      expect(entry!.taskName).toBe('Run database migration');
      expect(entry!.cwd).toBe('/home/user/app');
      expect(entry!.description).toBe('Run database migration');
    });

    test('completed task synthetic entry normalizes legacy missing worktree health as cleaned_up', () => {
      const task = taskStore.createTask('Ship implementation PR', '/home/user/app');
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-cleaned',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: new Date(),
        worktreeHealth: 'missing',
      });
      taskStore.completeTask(task.id);

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.taskStatus).toBe('completed');
      expect(entry!.worktreeHealth).toBe('cleaned_up');
    });

    test('includes synthetic entry for cancelled task after agent unregistered', () => {
      const task = taskStore.createTask('Deploy staging build', '/home/user/app');
      // addSession auto-transitions open -> inProgress
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-x1',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: new Date(),
      });
      monitor.registerAgent('agent-x1');
      monitor.processEvents('agent-x1', [makeToolUse('s1', 'Read')]);

      // Cancel the task and unregister the agent
      taskStore.cancelTask(task.id);
      monitor.unregisterAgent('agent-x1');

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe('agent-x1');
      expect(entry!.taskStatus).toBe('cancelled');
      expect(entry!.events).toEqual([]);
      expect(entry!.anomaly).toBeNull();
      expect(entry!.taskName).toBe('Deploy staging build');
    });

    test('does NOT duplicate entry when task has both active agent and task record', () => {
      const task = taskStore.createTask('Fix login bug', '/home/user/app');
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-d1',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: new Date(),
      });
      monitor.registerAgent('agent-d1');
      monitor.processEvents('agent-d1', [makeToolUse('s1', 'Edit')]);

      const snapshot = monitor.getSnapshot();
      // Task is inProgress with an active agent — should appear exactly once
      const entries = snapshot.filter((s) => s.taskId === task.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].agentId).toBe('agent-d1');
    });

    test('completed task synthetic entry includes tokenUsage', () => {
      const task = taskStore.createTask('Analyze logs', '/home/user/app');
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-t1',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: new Date(),
      });
      taskStore.updateTokenUsage(task.id, {
        inputTokens: 1500,
        outputTokens: 800,
        cacheRead: 200,
        cacheWrite: 50,
        costUsd: 0.042,
      });
      taskStore.completeTask(task.id);
      // No agent registered in monitor — the synthetic path kicks in

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.tokenUsage).toEqual({
        inputTokens: 1500,
        outputTokens: 800,
        cacheRead: 200,
        cacheWrite: 50,
        costUsd: 0.042,
      });
    });

    test('active agent snapshot enriches description from task prompt', () => {
      const task = taskStore.createTask('Refactor the payment module', '/home/user/app');
      taskStore.addSession(task.id, {
        tmuxSession: 'agent-desc',
        agentType: 'claude-code',
        cwd: '/home/user/app',
        createdAt: new Date(),
      });
      monitor.registerAgent('agent-desc');
      monitor.processEvents('agent-desc', [makeToolUse('s1', 'Bash')]);

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.agentId === 'agent-desc');

      expect(entry).toBeDefined();
      expect(entry!.description).toBe('Refactor the payment module');
    });

    test('cancelled task without sessions uses done-{id} agentId', () => {
      const task = taskStore.createTask('Build docker image', '/home/user/app');
      // open -> inProgress -> cancelled, no sessions
      taskStore.startTask(task.id);
      taskStore.cancelTask(task.id);

      const snapshot = monitor.getSnapshot();
      const entry = snapshot.find((s) => s.taskId === task.id);

      expect(entry).toBeDefined();
      expect(entry!.agentId).toBe(`done-${task.id}`);
      expect(entry!.taskStatus).toBe('cancelled');
    });
  });

  describe('subagent-aware needs_input suppression (rfc-subagent-aware-needs-input)', () => {
    beforeEach(() => {
      resetDetectionStats();
    });

    function makeSubagentStart(sessionId: string, subagentId: string): AgentEvent {
      return { type: 'subagent_start', sessionId, agentId: subagentId, agentType: 'general-purpose' };
    }

    function makeSubagentStop(sessionId: string, subagentId: string): AgentEvent {
      return {
        type: 'subagent_stop',
        sessionId,
        agentId: subagentId,
        agentType: 'general-purpose',
        lastMessage: '',
      };
    }

    test('Stop while a subagent is running suppresses needs_input', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeStop('s1', 'I am waiting for the subagent.'),
      ]);

      expect(queue.next()).toBeNull();
      expect(getDetectionStats().suppressed.needs_input).toBe(1);
    });

    test('after subagent_stop drains the set, the next Stop fires needs_input', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeStop('s1', 'first wait'),
      ]);
      expect(queue.next()).toBeNull();

      monitor.processEvents('agent-1', [
        makeSubagentStop('s1', 'sub-A'),
        makeStop('s1', 'genuine end of task'),
      ]);

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('needs_input');
    });

    test('two outstanding subagents — suppression holds until both clear', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeSubagentStart('s1', 'sub-B'),
        makeStop('s1', 'waiting'),
      ]);
      expect(queue.next()).toBeNull();

      monitor.processEvents('agent-1', [
        makeSubagentStop('s1', 'sub-A'),
        makeStop('s1', 'still one running'),
      ]);
      expect(queue.next()).toBeNull(); // sub-B still outstanding

      monitor.processEvents('agent-1', [
        makeSubagentStop('s1', 'sub-B'),
        makeStop('s1', 'all done'),
      ]);
      const drainedNext = queue.next();
      expect(drainedNext).not.toBeNull();
      expect(drainedNext!.anomaly.type).toBe('needs_input');
    });

    test('in-batch ordering: [subagent_start, stop, subagent_stop] in one batch — stop fires (subagent already drained)', () => {
      // Documents the contract from the RFC's "in-batch event ordering" section:
      // tracking is updated for ALL events before detection runs, so this batch
      // ends with an empty set when detectAnomalies sees the effective trailing
      // Stop. The final SubagentStop is bookkeeping, not the parent state.
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeStop('s1', 'transient stop'),
        makeSubagentStop('s1', 'sub-A'),
      ]);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('needs_input');
    });

    test('suppression counter increments once per Stop, not per snapshot read', () => {
      // Regression guard for the bug where recordSuppression was called from
      // suppressIfSubagentsRunning — getEventAnomaly is invoked per snapshot
      // tick (via getCurrentAnomaly → getSnapshot) and would inflate the count.
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeStop('s1', 'waiting'),
      ]);
      expect(getDetectionStats().suppressed.needs_input).toBe(1);

      // Simulate many snapshot reads — counter must NOT inflate.
      for (let i = 0; i < 10; i++) {
        monitor.getEventAnomaly('agent-1');
        monitor.getCurrentAnomaly('agent-1');
      }
      expect(getDetectionStats().suppressed.needs_input).toBe(1);
    });

    test('subagent_start with empty agentId is a no-op (defensive filter)', () => {
      monitor.processEvents('agent-1', [
        { type: 'subagent_start', sessionId: 's1', agentId: '', agentType: 'general-purpose' },
        makeStop('s1', 'should fire — set should be empty'),
      ]);
      expect(queue.next()).not.toBeNull();
    });

    test('getEventAnomaly applies the same suppression as processEvents (both call sites consistent)', () => {
      // Suppressed case
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeStop('s1', 'waiting'),
      ]);
      expect(monitor.getEventAnomaly('agent-1')).toBeNull();

      // Post-drain case — getEventAnomaly must surface the genuine needs_input
      monitor.processEvents('agent-1', [
        makeSubagentStop('s1', 'sub-A'),
        makeStop('s1', 'really done'),
      ]);
      const anomaly = monitor.getEventAnomaly('agent-1');
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
    });

    test('session_end flushes the set and increments orphan counters when non-empty', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makeSubagentStart('s1', 'sub-B'),
        { type: 'session_end', sessionId: 's1', reason: 'other' },
      ]);

      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(2);
      expect(stats.subagentSessionsWithOrphans).toBe(1);
    });

    test('unregisterAgent flushes the set and increments orphan counters', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
      ]);
      monitor.unregisterAgent('agent-1');

      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(1);
      expect(stats.subagentSessionsWithOrphans).toBe(1);
    });

    test('session_end then unregisterAgent does NOT double-count orphans', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        { type: 'session_end', sessionId: 's1', reason: 'other' },
      ]);
      monitor.unregisterAgent('agent-1');

      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(1);          // counted once
      expect(stats.subagentSessionsWithOrphans).toBe(1);
    });

    test('TTL evicts entries older than 30 minutes; suppression releases', () => {
      const baseNow = 1_000_000;
      const dateSpy = vi.spyOn(Date, 'now');
      try {
        // SubagentStart at baseNow
        dateSpy.mockReturnValue(baseNow);
        monitor.processEvents('agent-1', [
          makeSubagentStart('s1', 'sub-A'),
          makeStop('s1', 'waiting'),
        ]);
        expect(queue.next()).toBeNull();
        expect(getDetectionStats().subagentTtlEvictions).toBe(0);

        // Stop arrives 31 minutes later — TTL should evict and let needs_input fire
        dateSpy.mockReturnValue(baseNow + 31 * 60 * 1000);
        monitor.processEvents('agent-1', [makeStop('s1', 'still waiting')]);

        const next = queue.next();
        expect(next).not.toBeNull();
        expect(next!.anomaly.type).toBe('needs_input');
        expect(getDetectionStats().subagentTtlEvictions).toBe(1);
      } finally {
        dateSpy.mockRestore();
      }
    });

    test('permission_blocked is unaffected by subagent suppression', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'sub-A'),
        makePermissionRequest('s1', 'Bash'),
      ]);

      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('permission_blocked');
    });

    test('Codex-style session that never emits subagent events behaves as today', () => {
      // No subagent_start at all — set stays empty, normal Stop fires needs_input.
      monitor.processEvents('codex-agent', [
        makeToolUse('s1', 'Bash'),
        makeStop('s1', 'done'),
      ]);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('needs_input');
    });

    test('subagent_stop for an unknown agent (no entry in map) is a silent no-op', () => {
      // Realistic on hook-watcher reconnect / replay or session_end then late stop.
      expect(() =>
        monitor.processEvents('agent-1', [makeSubagentStop('s1', 'unknown-id')]),
      ).not.toThrow();
      // Following Stop should fire needs_input — no spurious suppression state.
      monitor.processEvents('agent-1', [makeStop('s1', 'done')]);
      const next = queue.next();
      expect(next).not.toBeNull();
      expect(next!.anomaly.type).toBe('needs_input');
    });
  });

  describe('applyWatchdogVerdict (#367 sub-goal 3)', () => {
    const agentId = 'agent-1';
    const staleAnomaly = {
      agentId,
      type: 'stale_agent' as const,
      severity: 'warning' as const,
      explanation: 'frozen for 60s',
      detectedAt: new Date('2026-04-23T00:00:00Z'),
    };
    const needsInputAnomaly = {
      agentId,
      type: 'needs_input' as const,
      severity: 'info' as const,
      subType: 'stop' as const,
      explanation: 'pane shows input prompt',
      detectedAt: new Date('2026-04-23T00:00:00Z'),
    };

    test('actionable verdict enqueues the anomaly and reports change', () => {
      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'stale_agent', anomaly: staleAnomaly },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(true);
      expect(queue.peek(agentId)?.type).toBe('stale_agent');
    });

    test('non-actionable verdict clears a leftover watchdog-owned stale_agent entry', () => {
      queue.enqueue(agentId, staleAnomaly);
      expect(queue.peek(agentId)).not.toBeNull();

      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(true);
      expect(queue.peek(agentId)).toBeNull();
    });

    test('non-actionable verdict clears a leftover watchdog-owned hook_disconnected entry', () => {
      const hookDisconnectedAnomaly = {
        agentId,
        type: 'hook_disconnected' as const,
        severity: 'warning' as const,
        explanation: 'hook stream dropped',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      };
      queue.enqueue(agentId, hookDisconnectedAnomaly);

      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(true);
      expect(queue.peek(agentId)).toBeNull();
    });

    test('non-actionable verdict on empty queue is a no-op and reports no change', () => {
      expect(queue.peek(agentId)).toBeNull();

      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(false);
      expect(queue.peek(agentId)).toBeNull();
    });

    test('non-actionable verdict does not clear when pane capture failed', () => {
      queue.enqueue(agentId, staleAnomaly);
      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: false },
      );
      expect(changed).toBe(false);
      expect(queue.peek(agentId)?.type).toBe('stale_agent');
    });

    test('non-actionable verdict does not clear budget_exceeded (not a watchdog-owned type)', () => {
      const budget = {
        agentId,
        type: 'budget_exceeded' as const,
        severity: 'warning' as const,
        explanation: 'cost exceeded $5',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      };
      queue.enqueue(agentId, budget);
      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(false);
      expect(queue.peek(agentId)?.type).toBe('budget_exceeded');
    });

    test('non-actionable verdict leaves event-derived anomaly in place', () => {
      // Event-derived needs_input arrives first via processEvents.
      monitor.processEvents(agentId, [makeStop('s1', 'done')]);
      expect(queue.peek(agentId)?.type).toBe('needs_input');

      const changed = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(false);
      expect(queue.peek(agentId)?.type).toBe('needs_input');
    });

    test('suppression tracker prevents enqueue over a pre-populated queue entry', () => {
      // Pre-populate with a different, non-watchdog finding that should NOT be
      // overwritten when the suppression tracker gates the new verdict.
      const existing = {
        agentId,
        type: 'budget_exceeded' as const,
        severity: 'warning' as const,
        explanation: 'cost exceeded $5',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      };
      queue.enqueue(agentId, existing);

      const tracker = {
        isSuppressed: () => false,
        shouldSuppress: vi.fn(() => true),
        recordLivenessSnooze: vi.fn(),
        clear: vi.fn(),
        export: () => undefined,
      } as unknown as ConstructorParameters<typeof Monitor>[4];
      const m = new Monitor(taskStore, queue, undefined, 50, tracker);

      const changed = m.applyWatchdogVerdict(
        agentId,
        { status: 'needs_input', anomaly: needsInputAnomaly },
        { paneCaptureSucceeded: true },
      );
      expect(changed).toBe(true);
      // The tracker must not overwrite the existing entry.
      expect(queue.peek(agentId)?.type).toBe('budget_exceeded');
    });
  });
});
