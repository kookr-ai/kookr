import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { ClientMessageSchema, summarizeZodIssues } from './client-message-schema.js';
import { CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES, MAX_BATCH_ABORT_TASKS, type ClientMessage } from './messages.js';
import { TELEMETRY_EVENT_TYPES } from './telemetry.js';

describe('summarizeZodIssues', () => {
  test('returns a placeholder when the error has no issues', () => {
    const fakeError = { issues: [] } as unknown as z.ZodError;
    expect(summarizeZodIssues(fakeError)).toBe('validation failed');
  });

  test('renders a single issue with its dotted path and message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'launch', prompt: 'x', cwd: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error);
      expect(summary).toContain('cwd');
    }
  });

  test('labels root-level issues as "(root)"', () => {
    const result = ClientMessageSchema.safeParse('not an object');
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error);
      expect(summary).toContain('(root)');
    }
  });

  test('caps output at five issues', () => {
    const manyIssues = Array.from({ length: 12 }, (_, i) => ({
      code: 'custom',
      path: [`field${i}`],
      message: `msg${i}`,
    }));
    const fakeError = { issues: manyIssues } as unknown as z.ZodError;
    const summary = summarizeZodIssues(fakeError);
    // Expect only msg0..msg4 to appear; msg5 onward trimmed.
    expect(summary).toContain('msg0');
    expect(summary).toContain('msg4');
    expect(summary).not.toContain('msg5');
  });

  test('joins nested paths with dots', () => {
    const fakeError = {
      issues: [{ code: 'custom', path: ['config', 'dailyPrLimit'], message: 'expected number' }],
    } as unknown as z.ZodError;
    expect(summarizeZodIssues(fakeError)).toContain('config.dailyPrLimit');
  });

  test('includes the rejected value from payload context when Zod omits it from the message', () => {
    const payload = { type: 'doesNotExist', foo: 'bar' };
    const result = ClientMessageSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error, payload);
      expect(summary).toContain('type');
      expect(summary).toContain('doesNotExist');
    }
  });

  test('does not confuse a rejected value with an allowed value substring', () => {
    const payload = {
      type: 'telemetry',
      events: [{ type: 'tab', timestamp: '2026-05-24T10:00:00.000Z', sessionId: 's1', platform: 'linux' }],
    };
    const result = ClientMessageSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeZodIssues(result.error, payload);
      expect(summary).toContain('events.0.type');
      expect(summary).toMatch(/received ['"`]tab['"`]/);
    }
  });
});

describe('ClientMessageSchema — happy path sanity', () => {
  test('accepts a minimal well-formed launch message', () => {
    const result = ClientMessageSchema.safeParse({ type: 'launch', prompt: 'hi', cwd: '/tmp' });
    expect(result.success).toBe(true);
  });

  test('accepts a launch message with KB dependency declaration', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    expect(result.success).toBe(true);
  });

  test('accepts a launch message with evolution config dependency declaration', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      dependencies: ['evolution-config'],
    });
    expect(result.success).toBe(true);
  });

  test('rejects unsupported launch dependency declarations', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      dependencies: ['postgres'],
    });
    expect(result.success).toBe(false);
  });

  test('accepts a launch message with the round-robin agent selection', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      agentType: 'round-robin',
    });
    expect(result.success).toBe(true);
  });

  test('accepts a relaunch message with the round-robin agent selection', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'relaunch',
      taskId: 't1',
      prompt: 'hi',
      agentType: 'round-robin',
    });
    expect(result.success).toBe(true);
  });

  test('accepts a launch message with the Grok Build agent selection', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      agentType: 'grok-build',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agentType).toBe('grok-build');
  });

  test('accepts a launch message with optional effort and model pins (#2448)', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ effort: 'max', model: 'claude-fable-5' });
    }
  });

  test('rejects empty effort or model strings on launch (omit the field instead)', () => {
    expect(ClientMessageSchema.safeParse({
      type: 'launch', prompt: 'hi', cwd: '/tmp', effort: '',
    }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({
      type: 'launch', prompt: 'hi', cwd: '/tmp', model: '',
    }).success).toBe(false);
  });

  test('accepts a relaunch message with the Grok Build agent selection', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'relaunch',
      taskId: 't1',
      prompt: 'hi',
      agentType: 'grok-build',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agentType).toBe('grok-build');
  });

  test('accepts a playbook launch message with the Grok Build agent selection', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launchPlaybook',
      playbookPath: 'test.md',
      cwd: '/tmp',
      parameterValues: {},
      agentType: 'grok-build',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.agentType).toBe('grok-build');
  });

  test('accepts clearCompleted scoped to a project', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'clearCompleted',
      projectId: 'github.com/acme/project',
      includeTerminated: true,
    });
    expect(result.success).toBe(true);
  });

  test('rejects clearCompleted with a blank project scope', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'clearCompleted',
      projectId: '   ',
    });

    expect(result.success).toBe(false);
  });

  test('rejects an unknown agentType on launch', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launch',
      prompt: 'hi',
      cwd: '/tmp',
      agentType: 'gemini-cli',
    });
    expect(result.success).toBe(false);
  });

  test('accepts legacy playbook launch with only cwd', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launchPlaybook',
      playbookPath: 'test.md',
      cwd: '/catalog-and-target',
      parameterValues: {},
    });
    expect(result.success).toBe(true);
  });

  test('accepts split playbook launch without legacy cwd', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launchPlaybook',
      playbookPath: 'test.md',
      playbookSourceCwd: '/catalog',
      taskTargetCwd: '/target',
      projectId: 'github.com/acme/project',
      parameterValues: {},
    });
    expect(result.success).toBe(true);
  });

  test('rejects playbook launch without legacy or split cwd fields', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launchPlaybook',
      playbookPath: 'test.md',
      parameterValues: {},
    });
    expect(result.success).toBe(false);
  });

  test('rejects partial split playbook launch fields', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'launchPlaybook',
      playbookPath: 'test.md',
      playbookSourceCwd: '/catalog',
      parameterValues: {},
    });
    expect(result.success).toBe(false);
  });

  test('accepts a respond message with all required fields', () => {
    const result = ClientMessageSchema.safeParse({ type: 'respond', agentId: 'a1', input: 'go' });
    expect(result.success).toBe(true);
  });

  test('accepts every shared telemetry event type', () => {
    for (const eventType of TELEMETRY_EVENT_TYPES) {
      const result = ClientMessageSchema.safeParse({
        type: 'telemetry',
        events: [{
          type: eventType,
          timestamp: '2026-05-25T00:00:00.000Z',
          sessionId: 'test-session',
          platform: 'linux',
        }],
      });
      expect(result.success, `event type ${eventType}`).toBe(true);
    }
  });

  test('accepts a permission choice with a bound permission request', () => {
    const permissionRequest = {
      requestId: 'request-1',
      toolName: 'Bash',
      toolInputHash: 'hash-1',
      detectedAt: '2026-05-15T19:00:00.000Z',
      ttlMs: 300000,
    };
    const result = ClientMessageSchema.safeParse({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissionRequest).toEqual(permissionRequest);
    }
  });

  test('rejects a permission choice with a malformed permission request binding', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
      permissionRequest: {
        requestId: 'request-1',
        toolName: 'Bash',
        toolInputHash: 'hash-1',
        detectedAt: '2026-05-15T19:00:00.000Z',
        ttlMs: '300000',
      },
    });
    expect(result.success).toBe(false);
  });

  test('rejects a permission choice without a permission request binding', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'permissionChoice',
      agentId: 'agent-1',
      keystroke: '1',
    });
    expect(result.success).toBe(false);
  });

  test('rejects an unknown type as a discriminator error', () => {
    const result = ClientMessageSchema.safeParse({ type: 'wat' });
    expect(result.success).toBe(false);
  });

  test('accepts task priority updates and rejects invalid priority values', () => {
    expect(ClientMessageSchema.safeParse({
      type: 'setTaskPriority',
      taskId: 'task-1',
      priority: 'high',
    }).success).toBe(true);

    expect(ClientMessageSchema.safeParse({
      type: 'setTaskPriority',
      taskId: 'task-1',
      priority: 'normal',
    }).success).toBe(true);

    expect(ClientMessageSchema.safeParse({
      type: 'setTaskPriority',
      taskId: 'task-1',
      priority: 'low',
    }).success).toBe(false);
  });

  test('accepts findingFeedback without userReason (backwards compat)', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'findingFeedback',
      agentId: 'a',
      anomalyType: 'needs_input',
      explanation: 'x',
      verdict: 'false_positive',
    });
    expect(result.success).toBe(true);
  });

  test('accepts findingFeedback with userReason', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'findingFeedback',
      agentId: 'a',
      anomalyType: 'needs_input',
      explanation: 'x',
      verdict: 'false_positive',
      userReason: 'agent was emitting a report',
    });
    expect(result.success).toBe(true);
  });

  test('accepts missedFinding with required userReason', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'missedFinding',
      agentId: 'a',
      userReason: 'stuck for 10 minutes',
    });
    expect(result.success).toBe(true);
  });

  test('accepts missedFinding with optional suspectedType', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'missedFinding',
      agentId: 'a',
      userReason: 'stuck for 10 minutes',
      suspectedType: 'stale_agent',
    });
    expect(result.success).toBe(true);
  });

  test('rejects missedFinding with empty userReason', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'missedFinding',
      agentId: 'a',
      userReason: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missedFinding with unknown suspectedType', () => {
    const result = ClientMessageSchema.safeParse({
      type: 'missedFinding',
      agentId: 'a',
      userReason: 'r',
      suspectedType: 'not_a_real_anomaly',
    });
    expect(result.success).toBe(false);
  });
});

function clientMessageCase<T extends ClientMessage>(message: T): T {
  return message;
}

const permissionRequest = {
  requestId: 'request-1',
  toolName: 'Bash',
  toolInputHash: 'hash-1',
  detectedAt: '2026-05-15T19:00:00.000Z',
  ttlMs: 300000,
};

const clientMessageRoundTripCases = [
  clientMessageCase({ type: 'respond', agentId: 'agent-1', input: 'continue' }),
  clientMessageCase({ type: 'respondAll', agentIds: ['agent-1', 'agent-2'], input: 'continue' }),
  clientMessageCase({ type: 'directReply', agentId: 'agent-1', input: 'direct' }),
  clientMessageCase({ type: 'navigate', agentId: 'agent-1' }),
  clientMessageCase({ type: 'getNext' }),
  clientMessageCase({ type: 'selectionChanged', selectedTaskId: 'task-1', selectedSessionId: 'session-1' }),
  clientMessageCase({
    type: 'emptyEnterIntent',
    intentId: 'intent-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    selectionVersion: 1,
    inputStateEpoch: 'epoch-1',
    observedReadinessVersion: 2,
  }),
  clientMessageCase({ type: 'skip', agentId: 'agent-1' }),
  clientMessageCase({ type: 'skipAll', agentIds: ['agent-1', 'agent-2'] }),
  clientMessageCase({ type: 'snooze', agentId: 'agent-1', taskId: 'task-1', durationMs: 60000, reason: 'later', resumeMonitoring: true }),
  clientMessageCase({ type: 'cancelSnooze', agentId: 'agent-1', taskId: 'task-1' }),
  clientMessageCase({ type: 'launch', prompt: 'build it', cwd: '/tmp/project', criteria: 'tests pass', agentType: 'round-robin', dependencies: ['kb', 'evolution-config'], effort: 'max', model: 'claude-fable-5' }),
  clientMessageCase({
    type: 'completeTask',
    taskId: 'task-1',
    feedback: { rating: 'down', note: 'missed tests', downReason: 'agent_behavior' },
    requestReflect: true,
    cleanupWorktree: false,
  }),
  clientMessageCase({ type: 'setTaskFeedback', taskId: 'task-1', feedback: { rating: 'up', note: 'done' } }),
  clientMessageCase({ type: 'requestTaskReflect', taskId: 'task-1', direction: 'up' }),
  clientMessageCase({ type: 'requestTaskSnapshotReflect', taskId: 'task-1', hint: 'liked being asked for e2e tests' }),
  clientMessageCase({ type: 'relaunch', taskId: 'task-1', prompt: 'try again', agentType: 'codex-cli', dependencies: ['kb'] }),
  clientMessageCase({ type: 'cancelTask', taskId: 'task-1' }),
  clientMessageCase({ type: 'batchAbortTasks', taskIds: ['task-1', 'task-2'], reason: 'mass shutdown' }),
  clientMessageCase({ type: 'reopenTask', taskId: 'task-1' }),
  clientMessageCase({ type: 'dismissAgentSignal', taskId: 'task-1' }),
  clientMessageCase({ type: 'keepTaskAlive', taskId: 'task-1' }),
  clientMessageCase({ type: 'deleteTask', taskId: 'task-1' }),
  clientMessageCase({ type: 'renameTask', taskId: 'task-1', name: 'New task name' }),
  clientMessageCase({ type: 'setTaskPriority', taskId: 'task-1', priority: 'high' }),
  clientMessageCase({ type: 'stop', agentId: 'agent-1' }),
  clientMessageCase({ type: 'reflect' }),
  clientMessageCase({ type: 'listPlaybooks', cwd: '/tmp/project' }),
  clientMessageCase({
    type: 'launchPlaybook',
    playbookPath: 'repair.md',
    cwd: '/tmp/project',
    parameterValues: { issue: '837' },
    agentType: 'claude-code',
    scope: 'project',
  }),
  clientMessageCase({
    type: 'launchPlaybook',
    playbookPath: 'repair.md',
    playbookSourceCwd: '/tmp/catalog',
    taskTargetCwd: '/tmp/project',
    projectId: 'github.com/acme/project',
    parameterValues: { issue: '837' },
  }),
  clientMessageCase({
    type: 'telemetry',
    events: [{
      type: TELEMETRY_EVENT_TYPES[0],
      timestamp: '2026-05-25T00:00:00.000Z',
      sessionId: 'session-1',
      platform: 'linux',
    }],
  }),
  clientMessageCase({
    type: 'setProjectConfig',
    project: 'github.com/acme/project',
    config: {
      tracked: true,
      dailyPrLimit: 3,
      budgetWarnUsd: null,
      webhook: { enabled: true, minSeverity: 'warning' },
    },
  }),
  clientMessageCase({ type: 'clearCompleted', includeTerminated: true, projectId: 'github.com/acme/project' }),
  clientMessageCase({ type: 'ackTerminatedTask', taskId: 'task-1' }),
  clientMessageCase({ type: 'achievement:reset' }),
  clientMessageCase({ type: 'achievement:setEnabled', enabled: true }),
  clientMessageCase({ type: 'permissionChoice', agentId: 'agent-1', keystroke: '1', permissionRequest }),
  clientMessageCase({ type: 'rearmCircuitBreaker', name: 'github-refresh' }),
  clientMessageCase({
    type: 'findingFeedback',
    agentId: 'agent-1',
    anomalyType: 'needs_input',
    explanation: 'agent is waiting',
    verdict: 'false_positive',
    userReason: 'expected pause',
  }),
  clientMessageCase({ type: 'missedFinding', agentId: 'agent-1', userReason: 'looped', suspectedType: 'repeated_error' }),
  clientMessageCase({ type: 'workspace:getView', projectId: 'github.com/acme/project' }),
  clientMessageCase({ type: 'workspace:getCleanupDetail', projectId: 'github.com/acme/project', worktreePath: '/tmp/worktree' }),
  clientMessageCase({
    type: 'workspace:cleanupCandidate',
    projectId: 'github.com/acme/project',
    worktreePath: '/tmp/worktree',
    branch: 'fix/example',
    repoPath: '/tmp/project',
    deleteBranch: true,
    riskAccepted: true,
    discardDirtyState: false,
    confirmProtectedBranch: true,
    reviewFingerprint: 'fingerprint-1',
  }),
  clientMessageCase({ type: 'workspace:bulkSafeCleanup', projectId: 'github.com/acme/project' }),
  clientMessageCase({
    type: 'workspace:runCleanupDiagnostic',
    projectId: 'github.com/acme/project',
    worktreePath: '/tmp/worktree',
    reviewFingerprint: 'fingerprint-1',
  }),
  clientMessageCase({ type: 'workspace:sweep' }),
  clientMessageCase({ type: 'workspace:requestSweepReport', runId: 'run-1' }),
  clientMessageCase({
    type: 'workspace:bulkRemoveProbablySafe',
    rows: [{
      projectId: 'github.com/acme/project',
      worktreePath: '/tmp/worktree',
      branch: 'feat/x',
      fingerprint: 'fingerprint-1',
    }],
  }),
  clientMessageCase({ type: 'worktree:inspectCleanup', taskId: 'task-1' }),
  clientMessageCase({ type: 'requestResync', reason: 'seq_gap', haveSeq: 12 }),
] as const;

const coveredClientMessageTypes = clientMessageRoundTripCases.map((message) => message.type);

describe('ClientMessageSchema — JSON round trips', () => {
  test('covers every known client message type', () => {
    expect(new Set(coveredClientMessageTypes)).toEqual(new Set(CLIENT_MESSAGE_TYPES));
    const duplicateTypes = coveredClientMessageTypes.filter((type, index) => coveredClientMessageTypes.indexOf(type) !== index);
    expect(duplicateTypes).toEqual(['launchPlaybook']);
  });

  test.each(clientMessageRoundTripCases)('round-trips $type through the schema', (message) => {
    const parsed = ClientMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const roundTripped = JSON.parse(JSON.stringify(parsed.data));
    const reparsed = ClientMessageSchema.safeParse(roundTripped);
    expect(reparsed.success).toBe(true);
    if (reparsed.success) {
      expect(reparsed.data).toEqual(parsed.data);
    }
  });

  test('rejects a batchAbortTasks batch over the cap', () => {
    const taskIds = Array.from({ length: MAX_BATCH_ABORT_TASKS + 1 }, (_, i) => `task-${i}`);
    expect(ClientMessageSchema.safeParse({ type: 'batchAbortTasks', taskIds }).success).toBe(false);
    // At the cap it is still accepted.
    const atCap = Array.from({ length: MAX_BATCH_ABORT_TASKS }, (_, i) => `task-${i}`);
    expect(ClientMessageSchema.safeParse({ type: 'batchAbortTasks', taskIds: atCap }).success).toBe(true);
  });

  test('rewrites deprecated tmux_unresponsive anomaly type to backend_unreachable', () => {
    const feedback = ClientMessageSchema.safeParse({
      type: 'findingFeedback',
      agentId: 'a1',
      anomalyType: 'tmux_unresponsive',
      explanation: 'backend down',
      verdict: 'false_positive',
    });
    expect(feedback.success).toBe(true);
    if (feedback.success && feedback.data.type === 'findingFeedback') {
      expect(feedback.data.anomalyType).toBe('backend_unreachable');
    }

    const missed = ClientMessageSchema.safeParse({
      type: 'missedFinding',
      agentId: 'a1',
      userReason: 'terminal was dead',
      suspectedType: 'tmux_unresponsive',
    });
    expect(missed.success).toBe(true);
    if (missed.success && missed.data.type === 'missedFinding') {
      expect(missed.data.suspectedType).toBe('backend_unreachable');
    }
  });
});

describe('API reference WebSocket protocol docs', () => {
  test('documents every server and client /ws message type', () => {
    const apiReference = readFileSync(join(process.cwd(), 'docs/reference/api.md'), 'utf8');

    expect(extractDocumentedWsTypes(apiReference, 'Server-to-client messages')).toEqual([...SERVER_MESSAGE_TYPES]);
    expect(extractDocumentedWsTypes(apiReference, 'Client-to-server messages')).toEqual([...CLIENT_MESSAGE_TYPES]);
  });
});

function extractDocumentedWsTypes(markdown: string, heading: string): string[] {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`(?:^|\\n)### ${escapedHeading}\\n([\\s\\S]*?)(?=\\n### |\\n## |$)`));
  expect(match, `missing ${heading} table`).not.toBeNull();
  const section = match?.[1] ?? '';
  return [...section.matchAll(/^\| `([^`]+)` \|/gm)]
    .map((row) => row[1])
    .filter((type) => type !== 'type');
}
