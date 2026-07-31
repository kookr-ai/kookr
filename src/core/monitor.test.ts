import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from './types.js';
import { Monitor, UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS } from './monitor.js';
import { TaskStore } from './tasks.js';
import { AttentionQueue } from './attention-queue.js';
import { getDetectionStats, resetDetectionStats } from './detection-stats.js';
import { classifySessionHealth } from './session-health.js';

function makeToolUse(sessionId: string, toolName: string, toolInput?: unknown, toolUseId?: string): AgentEvent {
  return { type: 'tool_use', sessionId, toolName, toolInput, toolUseId };
}

function makeStop(sessionId: string, lastMessage = ''): AgentEvent {
  return { type: 'stop', sessionId, lastMessage };
}

function makeStopFailure(sessionId: string, error = 'server_error', lastMessage = 'API Error: 529 Overloaded'): AgentEvent {
  return { type: 'stop_failure', sessionId, error, lastMessage };
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

function makeSubagentStart(sessionId: string, agentId = 'subagent-1'): AgentEvent {
  return { type: 'subagent_start', sessionId, agentId, agentType: 'test-agent' };
}

function createTaskForMutation(targetStore: TaskStore, ...args: unknown[]) {
  const created = (targetStore.createTask as (...innerArgs: unknown[]) => { id: string })(...args);
  const task = targetStore.getTaskForMutation(created.id);
  if (!task) throw new Error(`missing task ${created.id}`);
  return task;
}

describe('Monitor', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let originalFindingTranscriptContext: string | undefined;

  beforeEach(() => {
    originalFindingTranscriptContext = process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT;
    delete process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT;
    resetDetectionStats();
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
  });

  afterEach(() => {
    if (originalFindingTranscriptContext === undefined) {
      delete process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT;
    } else {
      process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT = originalFindingTranscriptContext;
    }
  });

  function withTempTranscript(content: string, fn: (path: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-monitor-transcript-'));
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, content, 'utf-8');
    try {
      fn(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('getAgentState returns undefined for unknown agents like getSnapshot().find', () => {
    expect(monitor.getAgentState('missing-agent')).toBeUndefined();
    expect(monitor.getAgentState('missing-agent')).toBe(
      monitor.getSnapshot().find((state) => state.agentId === 'missing-agent'),
    );
  });

  test('projects server-provided session health into live monitor snapshots', () => {
    const health = classifySessionHealth({
      sessionId: 'agent-1',
      now: 100_000,
      restartEpoch: 90_000,
      taskStatus: 'inProgress',
      turnState: 'running',
      pty: { ringHead: 10, lastByteAt: 95_000 },
      hooks: { lastEventAt: 95_000 },
      transcript: { present: true, lastRecordAt: 95_000 },
      backend: {
        socketPresent: true,
        identityVerified: true,
        masterPid: 101,
        agentPid: 202,
        attachChildAlive: true,
        attachGeneration: 1,
        reattachCount: 0,
        lastAttachAt: 94_000,
      },
      browser: {
        bridgeOpen: false,
        lastOpenAt: null,
        lastReplayAt: null,
        lastLiveByteAt: null,
      },
    });
    monitor.registerAgent('agent-1');
    monitor.processEvents('agent-1', [makeToolUse('session-1', 'Read', { file_path: '/tmp/example' }, 'tool-1')]);
    let callbackArgs: { agentId: string; turnState: string } | undefined;
    monitor.setSessionHealthProvider((agentId, turnState) => {
      callbackArgs = { agentId, turnState };
      return health;
    });

    expect(monitor.getAgentState('agent-1')?.sessionHealth).toBe(health);
    expect(callbackArgs?.agentId).toBe('agent-1');
    expect(callbackArgs?.turnState).toBe('running');
  });

  test('getAgentState returns the same live state slice as getSnapshot().find', () => {
    monitor.processEvents('agent-1', [
      makeToolUse('s1', 'Read', { file_path: '/tmp/a' }, 'tool-1'),
      makeToolResult('s1', 'Read', 'tool-1', { content: 'done' }),
      makeStop('s1', 'Waiting for input.'),
    ]);
    monitor.processEvents('agent-2', [
      makeToolUse('s2', 'Bash', { command: 'pnpm test' }, 'tool-2'),
    ]);

    expect(monitor.getAgentState('agent-1')).toEqual(
      monitor.getSnapshot().find((state) => state.agentId === 'agent-1'),
    );
    expect(monitor.getAgentState('agent-2')).toEqual(
      monitor.getSnapshot().find((state) => state.agentId === 'agent-2'),
    );
  });

  test('getAgentState preserves snapshot queue-derived fields for a single agent', () => {
    monitor.processEvents('agent-1', [
      makeToolUse('s1', 'Read', { file_path: '/tmp/a' }, 'tool-1'),
      makeToolResult('s1', 'Read', 'tool-1', { content: 'done' }),
      makeStop('s1', 'Waiting for input.'),
    ]);
    queue.snooze('agent-1', 60_000);

    const state = monitor.getAgentState('agent-1');
    expect(state?.snoozedUntil).toBeGreaterThan(Date.now());
    expect(state).toEqual(
      monitor.getSnapshot().find((snapshotState) => snapshotState.agentId === 'agent-1'),
    );
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

  test('flag-off needs_input finding does not include transcript context', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Please choose an option.' }] },
    });

    withTempTranscript(`${line}\n`, (transcriptPath) => {
      monitor.processEvents('agent-1', [
        { type: 'session_start', sessionId: 's1', transcriptPath },
        makeStop('s1', 'Waiting'),
      ]);

      expect(queue.peek('agent-1')?.transcriptContext).toBeUndefined();
    });
  });

  test('flag-on needs_input finding includes last assistant transcript message', () => {
    process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT = 'true';
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Should I push this branch now?' }] },
    });

    withTempTranscript(`${line}\n`, (transcriptPath) => {
      monitor.processEvents('agent-1', [
        { type: 'session_start', sessionId: 's1', transcriptPath },
        makeStop('s1', 'Waiting'),
      ]);

      const anomaly = queue.peek('agent-1');
      expect(anomaly?.type).toBe('needs_input');
      expect(anomaly?.transcriptContext?.lastAssistantMessage).toEqual({
        excerpt: 'Should I push this branch now?',
        truncated: false,
        readAtOffset: 0,
      });
      expect(monitor.getSnapshot()[0].anomaly?.transcriptContext?.lastAssistantMessage.excerpt)
        .toBe('Should I push this branch now?');
    });
  });

  test('flag-on stale_agent watchdog finding includes last assistant transcript message', () => {
    process.env.KOOKR_FINDING_TRANSCRIPT_CONTEXT = '1';
    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I am stuck waiting for the test command.' }] },
    });

    withTempTranscript(`${line}\n`, (transcriptPath) => {
      monitor.processEvents('agent-1', [
        { type: 'session_start', sessionId: 's1', transcriptPath },
      ]);

      const verdict = {
        status: 'stale_agent' as const,
        anomaly: {
          agentId: 'agent-1',
          type: 'stale_agent' as const,
          severity: 'warning' as const,
          explanation: 'No activity for 2 min',
          detectedAt: new Date('2026-06-11T10:00:00.000Z'),
        },
      };
      // Two consecutive verdicts to clear the silence-finding flicker debounce.
      monitor.applyWatchdogVerdict('agent-1', verdict, { paneCaptureSucceeded: true });
      monitor.applyWatchdogVerdict('agent-1', verdict, { paneCaptureSucceeded: true });

      const anomaly = queue.peek('agent-1');
      expect(anomaly?.type).toBe('stale_agent');
      expect(anomaly?.transcriptContext?.lastAssistantMessage.excerpt)
        .toBe('I am stuck waiting for the test command.');
    });
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

  test('getSnapshot keeps raw live anomaly state without task projection', () => {
    const task = createTaskForMutation(taskStore, { prompt: 'ship it', cwd: '/repo' });
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
    expect(snapshot.filter((state) => state.agentId === 'agent-1')).toHaveLength(1);
    const state = monitor.getSnapshot().find((agent) => agent.agentId === 'agent-1');
    expect(state?.taskId).toBeUndefined();
    expect(state?.anomaly?.type).toBe('needs_input');
  });

  test('getSnapshot lastEventSeq tracks the monotonic event counter across snapshots', () => {
    // The speak-summary consumer compares lastEventSeq before and after TTS
    // playback to detect fresh activity. This test exercises that delta-detection
    // contract by sampling lastEventSeq at two points in time and asserting
    // strict monotonic growth.
    const task = createTaskForMutation(taskStore, { prompt: 'work', cwd: '/repo' });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-seq',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00Z'),
    });
    monitor.registerAgent('agent-seq');

    monitor.processEvents('agent-seq', [makeToolUse('s1', 'Read')]);
    monitor.processEvents('agent-seq', [makeToolUse('s1', 'Bash')]);
    const initialSeq = monitor.getSnapshot()
      .find((agent) => agent.agentId === 'agent-seq')!.lastEventSeq!;
    expect(initialSeq).toBe(2);

    monitor.processEvents('agent-seq', [makeToolUse('s1', 'Edit')]);
    const finalState = monitor.getSnapshot().find((agent) => agent.agentId === 'agent-seq');
    expect(finalState!.lastEventSeq).toBeGreaterThan(initialSeq);
    expect(finalState!.lastEventSeq).toBe(3);
  });

  test('getSnapshot reports lastEventSeq=0 for an agent with no events', () => {
    const task = createTaskForMutation(taskStore, { prompt: 'idle', cwd: '/repo' });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-empty',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00Z'),
    });
    monitor.registerAgent('agent-empty');

    const state = monitor.getSnapshot().find((agent) => agent.agentId === 'agent-empty');
    expect(state).toBeDefined();
    expect(state!.events).toEqual([]);
    expect(state!.lastEventSeq).toBe(0);
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

  test('active finding snapshot includes multi-sample evidence audit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStop('s1', 'Waiting')]);

      vi.setSystemTime(new Date('2026-05-18T10:00:12.000Z'));
      monitor.sampleFindingEvidence('agent-1', 'Claude is waiting for your input');

      const agent = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
      expect(agent?.findingEvidenceAudit?.verdict).toBe('supports_finding');
      expect(agent?.findingEvidenceAudit?.observations).toHaveLength(2);
      expect(agent?.findingEvidenceAudit?.observations[1].paneHash).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('finding evidence audit records transient timing when activity clears finding quickly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T10:00:00.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStop('s1', 'Waiting')]);

      vi.setSystemTime(new Date('2026-05-18T10:00:02.000Z'));
      monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

      const [record] = monitor.getFindingEvidenceAuditRecords();
      expect(record.verdict).toBe('transient_too_fast');
      expect(record.status).toBe('resolved');
      expect(queue.next()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  test('event-derived anomaly keeps stable detectedAt when watchdog also fires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T09:28:08.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStopFailure('s1')]);
      const originalDetectedAt = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!.detectedAt;

      vi.setSystemTime(new Date('2026-05-25T18:34:00.000Z'));
      monitor.applyWatchdogVerdict(
        'agent-1',
        {
          status: 'stale_agent',
          anomaly: {
            agentId: 'agent-1',
            type: 'stale_agent',
            severity: 'warning',
            explanation: 'No activity for 32134s - agent may be stuck or disconnected',
            detectedAt: new Date(),
          },
        },
        { paneCaptureSucceeded: true, paneText: 'Checking for updates' },
      );

      const afterWatchdog = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!;
      expect(afterWatchdog.type).toBe('api_error');
      expect(afterWatchdog.detectedAt).toBe(originalDetectedAt);
      expect(queue.peek('agent-1')?.type).toBe('api_error');

      vi.setSystemTime(new Date('2026-05-25T18:34:05.000Z'));
      const later = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!;
      expect(later.type).toBe('api_error');
      expect(later.detectedAt).toBe(originalDetectedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  test('event-derived anomaly keeps stable detectedAt without active queue entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T09:28:08.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStopFailure('s1')]);
      const originalDetectedAt = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!.detectedAt;

      queue.remove('agent-1');

      vi.setSystemTime(new Date('2026-05-25T09:29:08.000Z'));
      const afterQueueRemoval = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!;
      expect(afterQueueRemoval.type).toBe('api_error');
      expect(afterQueueRemoval.detectedAt).toBe(originalDetectedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  test('event-derived anomaly gets fresh detectedAt after clearing and re-entering', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T09:28:08.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStopFailure('s1')]);
      const firstDetectedAt = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!.detectedAt;

      monitor.markInputReceived('agent-1');
      expect(monitor.getSnapshot().find((state) => state.agentId === 'agent-1')!.anomaly).toBeNull();

      vi.setSystemTime(new Date('2026-05-25T09:30:08.000Z'));
      monitor.processEvents('agent-1', [makeStopFailure('s1')]);
      const secondDetectedAt = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!.detectedAt;

      expect(secondDetectedAt.toISOString()).toBe('2026-05-25T09:30:08.000Z');
      expect(secondDetectedAt.getTime()).toBeGreaterThan(firstDetectedAt.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  test('event-derived anomaly gets fresh detectedAt when fingerprint changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-25T09:28:08.000Z'));
    try {
      monitor.processEvents('agent-1', [makeStopFailure('s1')]);

      vi.setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
      monitor.processEvents('agent-1', [makeStopFailure('s1', 'rate_limit', 'Billing quota exhausted')]);

      const anomaly = monitor.getSnapshot()
        .find((state) => state.agentId === 'agent-1')!
        .anomaly!;
      expect(anomaly.type).toBe('api_error');
      expect(anomaly.explanation).toContain('Billing quota exhausted');
      expect(anomaly.detectedAt.toISOString()).toBe('2026-05-25T10:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
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

  test('getSnapshot does not enrich linked tasks with dashboard metadata', () => {
    const task = createTaskForMutation(taskStore, 'Fix auth token refresh in the login flow', '/workspace/webapp');
    taskStore.setProjectId(task.id, 'github.com/acme/webapp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/workspace/webapp',
      createdAt: new Date('2026-03-24T10:00:00Z'),
    });
    monitor.processEvents('agent-1', [makeToolUse('s1', 'Bash')]);

    const snapshot = monitor.getSnapshot();
    const a1 = snapshot.find((s) => s.agentId === 'agent-1');

    expect(a1).toBeDefined();
    expect(a1!.taskId).toBeUndefined();
    expect(a1!.taskName).toBeUndefined();
    expect(a1!.cwd).toBeUndefined();
    expect(a1!.agentType).toBeUndefined();
    expect(a1!.projectId).toBeUndefined();
    expect(a1!.projectDisplayLabel).toBeUndefined();
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

  describe('turn state in snapshot (issue #358)', () => {
    function linkInteractiveTask(agentType: 'codex-cli' | 'claude-code', tmuxSession: string) {
      const task = createTaskForMutation(taskStore, `Interactive ${agentType} task`, '/repo');
      // addSession transitions the task to 'inProgress'; the interactive
      // terminal process then stays alive for follow-ups.
      taskStore.addSession(task.id, {
        tmuxSession,
        agentType,
        cwd: '/repo',
        createdAt: new Date(),
      });
      return task;
    }

    test('Codex Stop with the terminal still alive => turnState completed_turn, task stays inProgress', () => {
      const task = linkInteractiveTask('codex-cli', 'kookr-1bb16ec4');
      monitor.processEvents('kookr-1bb16ec4', [
        makeToolUse('s1', 'Bash'),
        makeToolResult('s1', 'Bash'),
        makeStop('s1', 'Yes. In a clean headless Chromium run...'),
      ]);

      const agent = monitor.getSnapshot().find((s) => s.agentId === 'kookr-1bb16ec4');
      expect(agent).toBeDefined();
      expect(agent!.turnState).toBe('completed_turn');
      // Lifecycle is unchanged: the task remains open for follow-up.
      expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    });

    test('Claude Stop with the terminal still alive => turnState completed_turn, task stays inProgress', () => {
      linkInteractiveTask('claude-code', 'kookr-claude-1');
      monitor.processEvents('kookr-claude-1', [
        makeToolUse('s1', 'Edit'),
        makeStop('s1', 'All changes applied.'),
      ]);

      const agent = monitor.getSnapshot().find((s) => s.agentId === 'kookr-claude-1');
      expect(agent!.turnState).toBe('completed_turn');
    });

    test('Stop while a background subagent is still running => turnState running, not completed_turn', () => {
      linkInteractiveTask('codex-cli', 'agent-1');
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'bg-1'),
        makeStop('s1', 'parent turn ended while subagent runs'),
      ]);
      const agent = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
      // The parent emitted Stop but real work is ongoing — do not show it as a
      // finished turn. Mirrors the needs_input subagent suppression.
      expect(agent!.turnState).toBe('running');

      // Once the subagent finishes, the turn reads as completed.
      monitor.processEvents('agent-1', [makeSubagentStop('s1', 'bg-1')]);
      const after = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
      expect(after!.turnState).toBe('completed_turn');
    });

    test('TTL-evicted subagent suppresses stale parent Stop until a fresh Stop arrives', () => {
      const dateSpy = vi.spyOn(Date, 'now');
      try {
        linkInteractiveTask('codex-cli', 'agent-1');
        dateSpy.mockReturnValue(1_000_000);
        monitor.processEvents('agent-1', [
          makeSubagentStart('s1', 'bg-1'),
          makeStop('s1', 'same final answer'),
        ]);

        const whileRunning = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
        expect(whileRunning!.turnState).toBe('running');

        dateSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
        const staleAfterTtl = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
        expect(staleAfterTtl!.turnState).toBe('running');
        expect(staleAfterTtl!.anomaly).toBeNull();

        monitor.processEvents('agent-1', [makeStop('s1', 'same final answer')]);
        const freshStop = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
        expect(freshStop!.turnState).toBe('completed_turn');
      } finally {
        dateSpy.mockRestore();
      }
    });

    test('fresh Stop that triggers TTL eviction is not mistaken for the stale parent Stop', () => {
      const dateSpy = vi.spyOn(Date, 'now');
      try {
        linkInteractiveTask('codex-cli', 'agent-1');
        dateSpy.mockReturnValue(1_000_000);
        monitor.processEvents('agent-1', [
          makeSubagentStart('s1', 'bg-1'),
          makeStop('s1', 'same final answer'),
        ]);

        const whileRunning = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
        expect(whileRunning!.turnState).toBe('running');

        dateSpy.mockReturnValue(1_000_000 + 31 * 60 * 1000);
        monitor.processEvents('agent-1', [makeStop('s1', 'same final answer')]);
        const freshStop = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
        expect(freshStop!.turnState).toBe('completed_turn');
      } finally {
        dateSpy.mockRestore();
      }
    });

    test('final Stop with no active background work clears stale subagent suppression', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'phantom-subagent'),
        {
          type: 'stop',
          sessionId: 's1',
          lastMessage: 'Done. Issue is merged and closed.',
          activeBackgroundTaskCount: 0,
          activeSessionCronCount: 0,
        },
        makeSubagentStop('s1', 'cleanup-subagent'),
        {
          type: 'notification',
          sessionId: 's1',
          notificationType: 'idle_prompt',
          message: 'Claude is waiting for your input',
        },
      ]);

      const agent = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
      expect(agent!.turnState).toBe('completed_turn');
      expect(agent!.anomaly?.type).toBe('needs_input');
    });

    test('final Stop with an active session cron keeps subagent suppression', () => {
      monitor.processEvents('agent-1', [
        makeSubagentStart('s1', 'cron-owned-subagent'),
        {
          type: 'stop',
          sessionId: 's1',
          lastMessage: 'Waiting on scheduled work.',
          activeBackgroundTaskCount: 0,
          activeSessionCronCount: 1,
        },
        makeSubagentStop('s1', 'cleanup-subagent'),
        {
          type: 'notification',
          sessionId: 's1',
          notificationType: 'idle_prompt',
          message: 'Claude is waiting for your input',
        },
      ]);

      const agent = monitor.getSnapshot().find((s) => s.agentId === 'agent-1');
      expect(agent!.turnState).toBe('running');
      expect(agent!.anomaly).toBeNull();
    });
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

    test('returns true when permission_request is followed by trailing idle_prompt', () => {
      // Claude Code fires Notification(idle_prompt) ~60s after idle; an agent
      // waiting on a permission prompt is idle. The detector trims the overlay
      // so the finding stays permission_blocked — the gate must too (#1367).
      monitor.processEvents('agent-1', [
        makePermissionRequest('s1', 'Bash'),
        {
          type: 'notification',
          sessionId: 's1',
          notificationType: 'idle_prompt',
          message: 'Claude is waiting for your input',
        },
      ]);
      expect(monitor.getCurrentAnomaly('agent-1')?.type).toBe('permission_blocked');
      expect(monitor.isPermissionBlocked('agent-1')).toBe(true);
    });

    test('returns false for AskUserQuestion permission_request (needs_input, not blocked)', () => {
      // Matches detectPermissionBlocked: AskUserQuestion's own approval prompt
      // is needs_input, not permission_blocked.
      monitor.processEvents('agent-1', [
        makeToolUse('s1', 'AskUserQuestion'),
        makePermissionRequest('s1', 'AskUserQuestion'),
      ]);
      expect(monitor.getCurrentAnomaly('agent-1')?.type).toBe('needs_input');
      expect(monitor.isPermissionBlocked('agent-1')).toBe(false);
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

    test('still lists agent after trailing idle_prompt on permission_request', () => {
      monitor.processEvents('agent-1', [
        makePermissionRequest('s1', 'Bash'),
        {
          type: 'notification',
          sessionId: 's1',
          notificationType: 'idle_prompt',
          message: 'Claude is waiting for your input',
        },
      ]);
      monitor.processEvents('agent-2', [makeToolUse('s2', 'Read')]);

      expect(monitor.getPermissionBlockedAgents()).toEqual(['agent-1']);
    });

    test('excludes AskUserQuestion permission_request', () => {
      monitor.processEvents('agent-1', [
        makeToolUse('s1', 'AskUserQuestion'),
        makePermissionRequest('s1', 'AskUserQuestion'),
      ]);
      expect(monitor.getPermissionBlockedAgents()).toEqual([]);
    });

    test('excludes stopped agents', () => {
      monitor.processEvents('agent-1', [makePermissionRequest('s1', 'Bash')]);
      monitor.unregisterAgent('agent-1');

      expect(monitor.getPermissionBlockedAgents()).toEqual([]);
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
      expect(getDetectionStats().suppressionReasons.needs_input.subagent_running).toBe(1);
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

    test('a stale_agent verdict enqueues after two consecutive ticks (flicker debounce)', () => {
      // First tick: recorded but not surfaced — a single-tick verdict is
      // routinely a hook-lag artifact that flips back to healthy next tick.
      const first = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'stale_agent', anomaly: staleAnomaly },
        { paneCaptureSucceeded: true },
      );
      expect(first).toBe(false);
      expect(queue.peek(agentId)).toBeNull();

      const second = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'stale_agent', anomaly: staleAnomaly },
        { paneCaptureSucceeded: true },
      );
      expect(second).toBe(true);
      expect(queue.peek(agentId)?.type).toBe('stale_agent');
    });

    test('a non-actionable verdict between two stale_agent verdicts resets the debounce', () => {
      monitor.applyWatchdogVerdict(
        agentId,
        { status: 'stale_agent', anomaly: staleAnomaly },
        { paneCaptureSucceeded: true },
      );
      monitor.applyWatchdogVerdict(
        agentId,
        { status: 'healthy' },
        { paneCaptureSucceeded: true },
      );
      const afterReset = monitor.applyWatchdogVerdict(
        agentId,
        { status: 'stale_agent', anomaly: staleAnomaly },
        { paneCaptureSucceeded: true },
      );
      expect(afterReset).toBe(false);
      expect(queue.peek(agentId)).toBeNull();
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

    describe('subagent-aware suppression (rfc-supervisor-stale-agent-false-positives)', () => {
      const hookDisconnectedAnomaly = {
        agentId,
        type: 'hook_disconnected' as const,
        severity: 'warning' as const,
        explanation: 'hook stream dropped',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      };
      const permissionBlockedAnomaly = {
        agentId,
        type: 'permission_blocked' as const,
        severity: 'warning' as const,
        explanation: 'pane shows permission dialog',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      };

      test('stale_agent verdict is suppressed while a background subagent is running', () => {
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)).toBeNull();
        expect(getDetectionStats().suppressed.stale_agent).toBe(1);
        expect(getDetectionStats().suppressionReasons.stale_agent.subagent_running).toBe(1);

        const records = monitor.getFindingEvidenceAuditRecords();
        const suppressed = records.find((r) => r.anomalyType === 'stale_agent' && r.status === 'resolved');
        expect(suppressed?.verdict).toBe('possible_false_positive');
        expect(suppressed?.notes.some((n) => n.includes('subagent_running'))).toBe(true);
      });

      test('hook_disconnected verdict is suppressed while a background subagent is running', () => {
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'hook_disconnected', anomaly: hookDisconnectedAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)).toBeNull();
        expect(getDetectionStats().suppressed.hook_disconnected).toBe(1);
        expect(getDetectionStats().suppressionReasons.hook_disconnected.subagent_running).toBe(1);

        // Audit trail must surface every suppressed actionable verdict, not just stale_agent.
        const records = monitor.getFindingEvidenceAuditRecords();
        const suppressed = records.find((r) => r.anomalyType === 'hook_disconnected' && r.status === 'resolved');
        expect(suppressed?.verdict).toBe('possible_false_positive');
        expect(suppressed?.notes.some((n) => n.includes('subagent_running'))).toBe(true);
      });

      test('permission_blocked verdict is NOT suppressed while a subagent is running', () => {
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'permission_blocked', anomaly: permissionBlockedAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)?.type).toBe('permission_blocked');
      });

      test('suppressed stale_agent retains a previously-queued non-watchdog anomaly', () => {
        // processEvents first — its no-anomaly branch unconditionally clears
        // the queue, so the merge_conflict must land AFTER subagent tracking
        // has been recorded to survive into the watchdog verdict.
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);
        const mergeConflict = {
          agentId,
          type: 'merge_conflict' as const,
          severity: 'warning' as const,
          explanation: 'rebase left CONFLICT markers',
          detectedAt: new Date('2026-04-23T00:00:00Z'),
        };
        queue.enqueue(agentId, mergeConflict);

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)?.type).toBe('merge_conflict');
      });

      test('suppressed stale_agent does NOT purge a queued watchdog-owned entry that is shadowed by an event-derived anomaly', () => {
        // Event-derived permission_blocked survives subagent suppression
        // (not in the suppressible set), so it remains on the queue and
        // is owned by processEvents. The watchdog suppression branch must
        // honor that ownership.
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);
        monitor.processEvents(agentId, [makePermissionRequest('s1', 'Bash')]);
        expect(queue.peek(agentId)?.type).toBe('permission_blocked');

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)?.type).toBe('permission_blocked');
      });

      test('suppressed stale_agent purges a stale watchdog-owned queue entry', () => {
        // Earlier stale_agent finding sat on the queue while the subagent was launching.
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);
        queue.enqueue(agentId, staleAnomaly);

        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );

        expect(changed).toBe(true);
        expect(queue.peek(agentId)).toBeNull();
      });

      test('after subagent_stop, the next persisting stale_agent verdict enqueues normally', () => {
        monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);
        monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );
        expect(queue.peek(agentId)).toBeNull();

        monitor.processEvents(agentId, [makeSubagentStop('s1', 'sub-1')]);

        // Two consecutive verdicts to clear the flicker debounce.
        monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );
        const changed = monitor.applyWatchdogVerdict(
          agentId,
          { status: 'stale_agent', anomaly: staleAnomaly },
          { paneCaptureSucceeded: true },
        );
        expect(changed).toBe(true);
        expect(queue.peek(agentId)?.type).toBe('stale_agent');
      });

      test('after SUBAGENT_TTL eviction, a stuck subagent no longer suppresses stale_agent', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-04-23T00:00:00Z'));
          monitor.processEvents(agentId, [makeSubagentStart('s1', 'sub-1')]);

          // Advance just past SUBAGENT_TTL_MS (30 min) — eviction is lazy on next read.
          vi.setSystemTime(new Date('2026-04-23T00:30:01Z'));

          // Two consecutive verdicts to clear the flicker debounce.
          monitor.applyWatchdogVerdict(
            agentId,
            { status: 'stale_agent', anomaly: staleAnomaly },
            { paneCaptureSucceeded: true },
          );
          const changed = monitor.applyWatchdogVerdict(
            agentId,
            { status: 'stale_agent', anomaly: staleAnomaly },
            { paneCaptureSucceeded: true },
          );
          expect(changed).toBe(true);
          expect(queue.peek(agentId)?.type).toBe('stale_agent');
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('systemic hook-stall correlation guard', () => {
      const hookAnomalyFor = (id: string) => ({
        agentId: id,
        type: 'hook_disconnected' as const,
        severity: 'warning' as const,
        explanation: 'no hook events for 200s but agent is visibly active',
        detectedAt: new Date('2026-04-23T00:00:00Z'),
      });

      /** Apply the same hook_disconnected verdict twice to clear the flicker debounce. */
      const applyHookVerdict = (id: string) => {
        monitor.applyWatchdogVerdict(
          id,
          { status: 'hook_disconnected', anomaly: hookAnomalyFor(id) },
          { paneCaptureSucceeded: true },
        );
        return monitor.applyWatchdogVerdict(
          id,
          { status: 'hook_disconnected', anomaly: hookAnomalyFor(id) },
          { paneCaptureSucceeded: true },
        );
      };

      test('a lone hook_disconnected verdict still enqueues (one agent is not systemic)', () => {
        const changed = applyHookVerdict('agent-a');
        expect(changed).toBe(true);
        expect(queue.peek('agent-a')?.type).toBe('hook_disconnected');
        expect(getDetectionStats().suppressed.hook_disconnected).toBe(0);
        // The watchdog path now records detection telemetry: 2 verdicts
        // checked, 1 finding admitted.
        expect(getDetectionStats().checks.hook_disconnected).toBe(2);
        expect(getDetectionStats().fires.hook_disconnected).toBe(1);
      });

      test('a second agent producing hook_disconnected is read as a systemic stall: suppressed and siblings purged', () => {
        applyHookVerdict('agent-a');
        expect(queue.peek('agent-a')?.type).toBe('hook_disconnected');

        const changed = applyHookVerdict('agent-b');

        expect(changed).toBe(true);
        // The second finding is suppressed (never enqueued)...
        expect(queue.peek('agent-b')).toBeNull();
        // ...and the first agent's finding is purged as part of the same infra event.
        expect(queue.peek('agent-a')).toBeNull();
        expect(getDetectionStats().suppressed.hook_disconnected).toBe(1);
        expect(getDetectionStats().suppressionReasons.hook_disconnected.systemic_hook_stall).toBe(1);

        const records = monitor.getFindingEvidenceAuditRecords();
        const suppressed = records.find(
          (r) => r.agentId === 'agent-b' && r.anomalyType === 'hook_disconnected' && r.status === 'resolved',
        );
        expect(suppressed?.verdict).toBe('possible_false_positive');
        expect(suppressed?.notes.some((n) => n.includes('systemic_hook_stall'))).toBe(true);
      });

      test('the systemic state does not oscillate: continued verdicts keep the queue empty', () => {
        // Regression for the admit→purge limit cycle: the old guard counted
        // *queued* entries, so its own purge reset the signal and the next
        // agent's finding was re-admitted ~1 tick later — a one-second finding
        // (and dashboard chime) rotating across every hook-silent agent.
        applyHookVerdict('agent-a');
        applyHookVerdict('agent-b'); // trips the guard, purges agent-a

        // Several more rounds of verdicts from a rotating set of agents: the
        // verdict-window signal stays ≥2, so nothing is ever re-admitted.
        for (let round = 0; round < 3; round++) {
          for (const id of ['agent-a', 'agent-b', 'agent-c']) {
            monitor.applyWatchdogVerdict(
              id,
              { status: 'hook_disconnected', anomaly: hookAnomalyFor(id) },
              { paneCaptureSucceeded: true },
            );
            expect(queue.peek('agent-a'), `round ${round}`).toBeNull();
            expect(queue.peek('agent-b'), `round ${round}`).toBeNull();
            expect(queue.peek('agent-c'), `round ${round}`).toBeNull();
          }
        }
        expect(getDetectionStats().suppressed.hook_disconnected).toBeGreaterThanOrEqual(8);
      });

      test('systemic suppression holds within the window, then ends after it drains', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date('2026-04-23T00:00:00Z'));
          applyHookVerdict('agent-a');
          applyHookVerdict('agent-b'); // systemic — queue purged
          expect(queue.peek('agent-a')).toBeNull();

          // Still inside the 60s window: agent-b's recent verdict keeps the
          // count at ≥2, so even a lone agent-a verdict stays suppressed. This
          // is the assertion that distinguishes the verdict-window signal from
          // the old queue-counting guard — the old guard saw an empty queue
          // here (the purge emptied it) and re-admitted agent-a.
          vi.setSystemTime(new Date('2026-04-23T00:00:30Z'));
          applyHookVerdict('agent-a');
          expect(queue.peek('agent-a')).toBeNull();

          // Past the window: agent-b's contribution has drained, only agent-a
          // remains under the threshold, so the finding is admitted.
          vi.setSystemTime(new Date('2026-04-23T00:01:31Z'));
          const changed = applyHookVerdict('agent-a');
          expect(changed).toBe(true);
          expect(queue.peek('agent-a')?.type).toBe('hook_disconnected');
        } finally {
          vi.useRealTimers();
        }
      });

      test('a concurrent stale_agent verdict is unaffected by the hook-stall guard', () => {
        applyHookVerdict('agent-a');
        monitor.applyWatchdogVerdict(
          'agent-b',
          { status: 'stale_agent', anomaly: { ...staleAnomaly, agentId: 'agent-b' } },
          { paneCaptureSucceeded: true },
        );
        const changed = monitor.applyWatchdogVerdict(
          'agent-b',
          { status: 'stale_agent', anomaly: { ...staleAnomaly, agentId: 'agent-b' } },
          { paneCaptureSucceeded: true },
        );
        expect(changed).toBe(true);
        expect(queue.peek('agent-b')?.type).toBe('stale_agent');
        expect(queue.peek('agent-a')?.type).toBe('hook_disconnected');
      });
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
      expect(getDetectionStats().suppressed.needs_input).toBe(1);
      expect(getDetectionStats().suppressionReasons.needs_input.snooze_false_positive).toBe(1);
    });
  });

  describe('sweepAgedTerminalAgents (issue #1761)', () => {
    const AGED_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = () => Date.now() - 7 * 24 * 60 * 60 * 1000;

    function makeTaskWithSession(sessionId: string): string {
      const task = taskStore.createTask(`Task for ${sessionId}`, '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: sessionId,
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      return task.id;
    }

    function ageTerminal(taskId: string): void {
      taskStore.completeTask(taskId);
      const live = taskStore.getTaskForMutation(taskId)!;
      const old = new Date(Date.now() - AGED_MS);
      live.updatedAt = old;
      if (live.finishedAt) live.finishedAt = old;
    }

    test('unregisters agents of aged terminal tasks; keeps live, recent-terminal, and unowned agents', () => {
      const agedId = makeTaskWithSession('kookr-aged');
      ageTerminal(agedId);
      const recentId = makeTaskWithSession('kookr-recent');
      taskStore.completeTask(recentId); // terminal but fresh — inside the cutoff
      makeTaskWithSession('kookr-live'); // stays inProgress

      for (const id of ['kookr-aged', 'kookr-recent', 'kookr-live', 'kookr-unowned']) {
        monitor.processEvents(id, [makeToolUse(id, 'Read', { file_path: '/tmp/x' })]);
      }

      const swept = monitor.sweepAgedTerminalAgents(cutoff());
      expect(swept).toBe(1);
      const ids = monitor.getSnapshot().map((s) => s.agentId).sort();
      expect(ids).toEqual(['kookr-live', 'kookr-recent', 'kookr-unowned']);
      // Idempotent: nothing left to sweep.
      expect(monitor.sweepAgedTerminalAgents(cutoff())).toBe(0);
    });

    test('never sweeps an agent whose session is still alive (skipSessionIds)', () => {
      // Task terminal in store but session alive (reaper leak class 2, or a
      // session spared by KOOKR_REAP_ORPHAN_SESSIONS=false): sweeping would
      // permanently darken its monitoring, since stopped agents are never
      // lazily re-created.
      const agedId = makeTaskWithSession('kookr-alive-leak');
      ageTerminal(agedId);
      monitor.processEvents('kookr-alive-leak', [makeToolUse('kookr-alive-leak', 'Read', { file_path: '/tmp/x' })]);

      expect(monitor.sweepAgedTerminalAgents(cutoff(), { skipSessionIds: new Set(['kookr-alive-leak']) })).toBe(0);
      expect(monitor.getSnapshot().map((s) => s.agentId)).toContain('kookr-alive-leak');
      // Once the session dies (no longer in the live set), it sweeps normally.
      expect(monitor.sweepAgedTerminalAgents(cutoff(), { skipSessionIds: new Set() })).toBe(1);
    });

    test('a swept agent no longer inflates the getTaskSnapshot protect set', () => {
      // The #1760 ghost-agent guard keeps any task owning a live agentEvents
      // key — after the sweep, the aged task must actually leave the filtered
      // task snapshot instead of being protected forever.
      const agedId = makeTaskWithSession('kookr-stale');
      ageTerminal(agedId);
      monitor.processEvents('kookr-stale', [makeToolUse('kookr-stale', 'Read', { file_path: '/tmp/x' })]);

      expect(monitor.getTaskSnapshot({ excludeTerminalBeforeMs: cutoff() }).map((t) => t.id)).toContain(agedId);
      monitor.sweepAgedTerminalAgents(cutoff());
      expect(monitor.getTaskSnapshot({ excludeTerminalBeforeMs: cutoff() }).map((t) => t.id)).not.toContain(agedId);
    });
  });

  describe('sweepUnownedDeadAgents (issue #1763)', () => {
    // Bind the test grace window to the exported production constant so a change
    // to the shipped value can't silently diverge from what these tests assert.
    const GRACE_MS = UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS;

    function makeTaskWithSession(sessionId: string): string {
      const task = taskStore.createTask(`Task for ${sessionId}`, '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: sessionId,
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      return task.id;
    }

    test('sweeps every unowned dead agent past the grace period; keeps live and owned', () => {
      // Unowned = no task references the session (e.g. the task was deleted but
      // hook replay re-registered the session). Only dead + grace-elapsed
      // unowned agents are swept. Two dead agents cross the boundary together
      // to prove the sweep returns a true count, not a boolean.
      makeTaskWithSession('kookr-owned'); // owned by a live in-progress task
      const t0 = 1_000_000;
      for (const id of ['kookr-owned', 'kookr-unowned-dead-a', 'kookr-unowned-dead-b', 'kookr-unowned-live']) {
        monitor.processEvents(id, [makeToolUse(id, 'Read', { file_path: '/tmp/x' })]);
      }

      // First observation starts the grace clock; nothing sweeps yet.
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-unowned-live']),
        graceMs: GRACE_MS,
        now: t0,
      })).toBe(0);

      // After the grace period, both dead unowned agents sweep; live + owned stay.
      const swept = monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-unowned-live']),
        graceMs: GRACE_MS,
        now: t0 + GRACE_MS,
      });
      expect(swept).toBe(2);
      const ids = monitor.getSnapshot().map((s) => s.agentId).sort();
      expect(ids).toEqual(['kookr-owned', 'kookr-unowned-live']);
      // Idempotent — nothing left to sweep.
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-unowned-live']),
        graceMs: GRACE_MS,
        now: t0 + 2 * GRACE_MS,
      })).toBe(0);
    });

    test('never sweeps a live unowned session, even long after first observation', () => {
      // A live orphan (e.g. spared by KOOKR_REAP_ORPHAN_SESSIONS=false) must
      // never be darkened while its session lives.
      monitor.processEvents('kookr-live-orphan', [makeToolUse('kookr-live-orphan', 'Read', { file_path: '/tmp/x' })]);
      const t0 = 2_000_000;
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-live-orphan']),
        graceMs: GRACE_MS,
        now: t0,
      })).toBe(0);
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-live-orphan']),
        graceMs: GRACE_MS,
        now: t0 + 100 * GRACE_MS,
      })).toBe(0);
      expect(monitor.getSnapshot().map((s) => s.agentId)).toContain('kookr-live-orphan');
    });

    test('a single transient listSessions() omission of a still-live orphan does not sweep it', () => {
      // Robustness: the grace clock measures *continuous* unowned-AND-dead time.
      // A long-lived unowned live orphan that flickers out of the backend
      // enumeration for one tick must not be darkened — resetting the clock on
      // liveness means one absent snapshot can't bank grace toward the sweep.
      monitor.processEvents('kookr-flaky-orphan', [makeToolUse('kookr-flaky-orphan', 'Read', { file_path: '/tmp/x' })]);
      const t0 = 5_000_000;
      // Live for a long time (well past the grace window).
      for (let i = 0; i <= 5; i++) {
        expect(monitor.sweepUnownedDeadAgents({
          liveSessionIds: new Set(['kookr-flaky-orphan']),
          graceMs: GRACE_MS,
          now: t0 + i * GRACE_MS,
        })).toBe(0);
      }
      // One tick where the backend transiently omits it — clock only just starts.
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(),
        graceMs: GRACE_MS,
        now: t0 + 6 * GRACE_MS,
      })).toBe(0);
      // Back in the live set on the very next tick — clock resets, still alive.
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-flaky-orphan']),
        graceMs: GRACE_MS,
        now: t0 + 7 * GRACE_MS,
      })).toBe(0);
      expect(monitor.getSnapshot().map((s) => s.agentId)).toContain('kookr-flaky-orphan');
      // Only sustained absence across the full grace window sweeps it.
      expect(monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 + 8 * GRACE_MS })).toBe(0);
      expect(monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 + 9 * GRACE_MS })).toBe(1);
    });

    test('a brand-new session registered before its task lands is not swept (grace clock resets on ownership or liveness)', () => {
      // Race: registerAgent creates an empty-window entry before the task's
      // session is added to the store. It must survive until ownership catches up.
      monitor.registerAgent('kookr-racing');
      const t0 = 3_000_000;
      // Observed unowned but still live in the backend — skipped.
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(['kookr-racing']),
        graceMs: GRACE_MS,
        now: t0,
      })).toBe(0);
      // Task registration lands: ownership resets the grace clock.
      makeTaskWithSession('kookr-racing');
      expect(monitor.sweepUnownedDeadAgents({
        liveSessionIds: new Set(),
        graceMs: GRACE_MS,
        now: t0 + 10 * GRACE_MS,
      })).toBe(0);
      expect(monitor.getSnapshot().map((s) => s.agentId)).toContain('kookr-racing');
      // If it later becomes unowned again, the clock starts fresh from that point.
      taskStore.deleteTask(taskStore.findTaskBySession('kookr-racing')!.id);
      expect(monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 + 11 * GRACE_MS })).toBe(0);
      expect(monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 + 12 * GRACE_MS })).toBe(1);
    });

    test('a swept unowned agent is marked stopped and does not resurrect via late events', () => {
      monitor.processEvents('kookr-ghost', [makeToolUse('kookr-ghost', 'Read', { file_path: '/tmp/x' })]);
      const t0 = 4_000_000;
      monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 }); // start clock
      expect(monitor.sweepUnownedDeadAgents({ liveSessionIds: new Set(), graceMs: GRACE_MS, now: t0 + GRACE_MS })).toBe(1);
      expect(monitor.getRetentionMetrics().stoppedAgents).toBe(1);
      // A late hook replay after the sweep is dropped, not re-created.
      monitor.processEvents('kookr-ghost', [makeToolUse('kookr-ghost', 'Read', { file_path: '/tmp/y' })]);
      expect(monitor.getSnapshot().map((s) => s.agentId)).not.toContain('kookr-ghost');
    });
  });

  describe('sweepStaleAgents (combined reaper sweep, issues #1761 + #1763)', () => {
    const AGED_MS = 30 * 24 * 60 * 60 * 1000;
    const GRACE_MS = UNOWNED_MONITOR_AGENT_SWEEP_GRACE_MS;
    // The aged-terminal cutoff is on the real wall-clock axis (ageTerminal
    // stamps real Date.now() timestamps); it is independent of the synthetic
    // `now` used only to drive the unowned grace clock.
    const agedCutoff = () => Date.now() - 7 * 24 * 60 * 60 * 1000;

    function makeTaskWithSession(sessionId: string): string {
      const task = taskStore.createTask(`Task for ${sessionId}`, '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: sessionId,
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });
      return task.id;
    }

    function ageTerminal(taskId: string): void {
      taskStore.completeTask(taskId);
      const live = taskStore.getTaskForMutation(taskId)!;
      const old = new Date(Date.now() - AGED_MS);
      live.updatedAt = old;
      if (live.finishedAt) live.finishedAt = old;
    }

    test('sums both sweeps, forwarding live sessions to each, and each class handles only its own', () => {
      // One aged-terminal agent (#1761 class) and one unowned dead agent
      // (#1763 class) — the combined sweep must clear both and return 2.
      const agedId = makeTaskWithSession('kookr-aged');
      ageTerminal(agedId);
      const t0 = 6_000_000;
      for (const id of ['kookr-aged', 'kookr-unowned', 'kookr-live']) {
        monitor.processEvents(id, [makeToolUse(id, 'Read', { file_path: '/tmp/x' })]);
      }

      // First tick: the unowned agent's grace clock only starts here, so just
      // the aged-terminal agent (no grace) sweeps.
      expect(monitor.sweepStaleAgents({
        liveSessionIds: new Set(['kookr-live']),
        agedTerminalCutoffMs: agedCutoff(),
        unownedGraceMs: GRACE_MS,
        now: t0,
      })).toBe(1);

      // Re-register the aged agent to prove the second tick's count comes from
      // the unowned sweep, then let its grace elapse.
      monitor.registerAgent('kookr-aged');
      monitor.processEvents('kookr-aged', [makeToolUse('kookr-aged', 'Read', { file_path: '/tmp/x' })]);
      const swept = monitor.sweepStaleAgents({
        liveSessionIds: new Set(['kookr-live']),
        agedTerminalCutoffMs: agedCutoff(),
        unownedGraceMs: GRACE_MS,
        now: t0 + GRACE_MS,
      });
      expect(swept).toBe(2); // aged-terminal again + the now-grace-elapsed unowned
      expect(monitor.getSnapshot().map((s) => s.agentId)).toEqual(['kookr-live']);
    });

    test('never sweeps a live session in either class', () => {
      // A live session that is BOTH an aged terminal task's session AND (in a
      // separate agent) an unowned orphan must survive both sweeps.
      const agedId = makeTaskWithSession('kookr-aged-live');
      ageTerminal(agedId);
      const t0 = 7_000_000;
      for (const id of ['kookr-aged-live', 'kookr-unowned-live']) {
        monitor.processEvents(id, [makeToolUse(id, 'Read', { file_path: '/tmp/x' })]);
      }
      const live = new Set(['kookr-aged-live', 'kookr-unowned-live']);
      expect(monitor.sweepStaleAgents({ liveSessionIds: live, agedTerminalCutoffMs: agedCutoff(), unownedGraceMs: GRACE_MS, now: t0 })).toBe(0);
      expect(monitor.sweepStaleAgents({ liveSessionIds: live, agedTerminalCutoffMs: agedCutoff(), unownedGraceMs: GRACE_MS, now: t0 + 100 * GRACE_MS })).toBe(0);
      expect(monitor.getSnapshot().map((s) => s.agentId).sort()).toEqual(['kookr-aged-live', 'kookr-unowned-live']);
    });
  });

  describe('getTaskSnapshot pre-clone age filter (issue #1749 follow-up)', () => {
    const AGED_MS = 30 * 24 * 60 * 60 * 1000;

    function makeAgedTerminalTask(sessionId: string): string {
      const task = taskStore.createTask(`Task for ${sessionId}`, '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: sessionId,
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(Date.now() - AGED_MS),
      });
      taskStore.completeTask(task.id);
      const live = taskStore.getTaskForMutation(task.id)!;
      const old = new Date(Date.now() - AGED_MS);
      live.updatedAt = old;
      if (live.finishedAt) live.finishedAt = old;
      return task.id;
    }

    test('drops aged terminal tasks when a cutoff is passed, keeps them without one', () => {
      const agedId = makeAgedTerminalTask('kookr-cold');
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      expect(monitor.getTaskSnapshot({ excludeTerminalBeforeMs: cutoff }).map((t) => t.id)).not.toContain(agedId);
      expect(monitor.getTaskSnapshot().map((t) => t.id)).toContain(agedId);
    });

    test('ALWAYS keeps a task whose session is live in the monitor, however aged (ghost-agent guard)', () => {
      // A live monitor state whose owning task is missing from the projection's
      // session index leaks as an unattributed ghost agent — the age cutoff
      // must never remove the owner of a live session.
      const agedId = makeAgedTerminalTask('kookr-ghost');
      monitor.processEvents('kookr-ghost', [makeToolUse('kookr-ghost', 'Read', { file_path: '/tmp/x' })]);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const ids = monitor.getTaskSnapshot({ excludeTerminalBeforeMs: cutoff }).map((t) => t.id);
      expect(ids).toContain(agedId);
    });
  });
});
