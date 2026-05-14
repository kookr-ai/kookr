import { describe, expect, test } from 'vitest';
import {
  isPermissionRequestEvent as isPermissionRequestEventFromAgentEvents,
  isToolUseEvent as isToolUseEventFromAgentEvents,
} from './agent-events.js';
import {
  isPermissionRequestEvent as isPermissionRequestEventFromTypes,
  isToolUseEvent as isToolUseEventFromTypes,
} from './types.js';
import {
  isActiveStatus as isActiveStatusFromTaskStatus,
  isTerminalStatus as isTerminalStatusFromTaskStatus,
} from './task-status.js';
import {
  isActiveStatus as isActiveStatusFromTasks,
  isTerminalStatus as isTerminalStatusFromTasks,
} from './tasks.js';
import type { AgentEvent } from './agent-events.js';
import type { Anomaly } from './anomaly-types.js';
import type { HookEventBase } from './hook-events.js';
import type { SessionInfo } from './session-read-model.js';
import type { Task } from './task-read-model.js';
import type { TokenUsage } from './usage-types.js';
import type {
  AgentEvent as LegacyAgentEvent,
  Anomaly as LegacyAnomaly,
  HookEventBase as LegacyHookEventBase,
  TokenUsage as LegacyTokenUsage,
} from './types.js';
import type {
  SessionInfo as LegacySessionInfo,
  Task as LegacyTask,
} from './tasks.js';

describe('core type modules', () => {
  test('legacy event exports delegate to the narrow agent event module', () => {
    expect(isToolUseEventFromTypes).toBe(isToolUseEventFromAgentEvents);
    expect(isPermissionRequestEventFromTypes).toBe(isPermissionRequestEventFromAgentEvents);

    const event: LegacyAgentEvent = {
      type: 'tool_use',
      sessionId: 'session-1',
      toolName: 'Bash',
    };
    const acceptsNarrowEvent = (value: AgentEvent) => value;

    expect(isToolUseEventFromTypes(acceptsNarrowEvent(event))).toBe(true);
  });

  test('legacy task status exports delegate to the narrow task status module', () => {
    expect(isTerminalStatusFromTasks).toBe(isTerminalStatusFromTaskStatus);
    expect(isActiveStatusFromTasks).toBe(isActiveStatusFromTaskStatus);
    expect(isTerminalStatusFromTasks('completed')).toBe(true);
    expect(isActiveStatusFromTasks('inProgress')).toBe(true);
  });

  test('legacy task and session types remain assignment-compatible with read models', () => {
    const session: LegacySessionInfo = {
      tmuxSession: 'kookr-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-14T00:00:00.000Z'),
    };
    const task: LegacyTask = {
      id: 'task-1',
      prompt: 'do work',
      cwd: '/repo',
      agentType: 'claude-code',
      status: 'open',
      sessions: [session],
      createdAt: new Date('2026-05-14T00:00:00.000Z'),
      updatedAt: new Date('2026-05-14T00:00:00.000Z'),
    };

    const acceptsNarrowSession = (value: SessionInfo) => value;
    const acceptsNarrowTask = (value: Task) => value;

    expect(acceptsNarrowSession(session).tmuxSession).toBe('kookr-1');
    expect(acceptsNarrowTask(task).id).toBe('task-1');
  });

  test('legacy core types remain assignment-compatible with narrow modules', () => {
    const hookEvent: LegacyHookEventBase = {
      session_id: 'session-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/repo',
      hook_event_name: 'PreToolUse',
    };
    const anomaly: LegacyAnomaly = {
      agentId: 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'Agent asked a question.',
      detectedAt: new Date('2026-05-14T00:00:00.000Z'),
    };
    const usage: LegacyTokenUsage = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.01,
    };

    const acceptsHookEvent = (value: HookEventBase) => value;
    const acceptsAnomaly = (value: Anomaly) => value;
    const acceptsUsage = (value: TokenUsage) => value;

    expect(acceptsHookEvent(hookEvent).hook_event_name).toBe('PreToolUse');
    expect(acceptsAnomaly(anomaly).type).toBe('needs_input');
    expect(acceptsUsage(usage).costUsd).toBe(0.01);
  });
});
