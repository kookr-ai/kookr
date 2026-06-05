import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import { ClientMessageSchema, summarizeZodIssues } from './client-message-schema.js';
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
      expect(summary).toContain('"tab"');
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
