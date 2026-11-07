import { describe, expect, test, vi } from 'vitest';

import type { AgentEvent } from '../core/agent-events.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { Task } from '../core/tasks.js';
import { createTelegramTaskBridge, type TelegramTaskBridgeDeps } from './telegram-task-bridge.js';

const SESSION = 'tmux-abc';
// Stable across the broker's re-read (a fresh detectedAt each call would trip
// the anti-stale detection-mismatch guard — which is correct behavior).
const STABLE_ANOMALY = permissionAnomaly();

function liveTask(id = 'task-1'): Task {
  return {
    sessions: [{ tmuxSession: SESSION, lastStatus: 'running', crashRecovered: false }],
  } as unknown as Task;
}

function permissionAnomaly(): Anomaly {
  return {
    agentId: SESSION,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'tool wants to run',
    detectedAt: new Date(), // recent — inside the approval TTL (anti-stale guard)
  } as Anomaly;
}

function permissionRequestEvent(): AgentEvent {
  return { type: 'permission_request', sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'git push' } } as AgentEvent;
}

function makeDeps(over: Partial<TelegramTaskBridgeDeps> = {}): {
  deps: TelegramTaskBridgeDeps;
  sendKeystroke: ReturnType<typeof vi.fn>;
  submitMessage: ReturnType<typeof vi.fn>;
  respondAndAdvance: ReturnType<typeof vi.fn>;
} {
  const sendKeystroke = vi.fn(async () => undefined);
  const submitMessage = vi.fn(async () => ({}));
  const respondAndAdvance = vi.fn(() => null);
  const deps: TelegramTaskBridgeDeps = {
    taskStore: { getTask: vi.fn(() => liveTask()) } as unknown as TelegramTaskBridgeDeps['taskStore'],
    monitor: {
      isPermissionBlocked: vi.fn(() => true),
      markInputReceived: vi.fn(() => true),
      getAgentEvents: vi.fn(() => [permissionRequestEvent()]),
    } as unknown as TelegramTaskBridgeDeps['monitor'],
    queue: {
      getAnomaly: vi.fn(() => STABLE_ANOMALY),
      respondAndAdvance,
    } as unknown as TelegramTaskBridgeDeps['queue'],
    adapter: { sendKeystroke } as unknown as TelegramTaskBridgeDeps['adapter'],
    submitMessage,
    ...over,
  };
  return { deps, sendKeystroke, submitMessage, respondAndAdvance };
}

describe('sendText', () => {
  test('delivers free text to the live session as directReply', async () => {
    const { deps, submitMessage } = makeDeps();
    const bridge = createTelegramTaskBridge(deps);
    const res = await bridge.sendText('task-1', '  do X instead  ');
    expect(res.ok).toBe(true);
    expect(submitMessage).toHaveBeenCalledWith(SESSION, 'do X instead', 'directReply');
  });

  test('rejects an empty message', async () => {
    const { deps, submitMessage } = makeDeps();
    const res = await createTelegramTaskBridge(deps).sendText('task-1', '   ');
    expect(res.ok).toBe(false);
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test('fails gracefully when there is no live session', async () => {
    const { deps } = makeDeps({
      taskStore: { getTask: vi.fn(() => undefined) } as unknown as TelegramTaskBridgeDeps['taskStore'],
    });
    const res = await createTelegramTaskBridge(deps).sendText('gone', 'hi');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no live session/);
  });
});

describe('approvePermission', () => {
  test('approves the current prompt with keystroke 1 and advances the queue', async () => {
    const { deps, sendKeystroke, respondAndAdvance } = makeDeps();
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1');
    expect(res.ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1');
    expect(respondAndAdvance).toHaveBeenCalledWith(SESSION);
  });

  test('refuses when the task is no longer permission-blocked', async () => {
    const { deps, sendKeystroke } = makeDeps({
      monitor: {
        isPermissionBlocked: vi.fn(() => false),
        markInputReceived: vi.fn(() => true),
        getAgentEvents: vi.fn(() => []),
      } as unknown as TelegramTaskBridgeDeps['monitor'],
    });
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1');
    expect(res.ok).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
  });
});
