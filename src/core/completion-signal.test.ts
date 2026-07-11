import { describe, expect, test } from 'vitest';
import type { AgentEvent } from './types.js';
import {
  deriveLatestCompletionSignal,
  evaluateCompletionSignal,
  type CompletionSignalEvaluationInput,
} from './completion-signal.js';

function stop(lastMessage = 'Done.', eventSeq = 3): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage, eventSeq };
}

function userPrompt(eventSeq = 2): AgentEvent {
  return { type: 'user_prompt', sessionId: 's1', prompt: 'continue', eventSeq };
}

function signal(events: AgentEvent[]) {
  return deriveLatestCompletionSignal({
    taskId: 'task-1',
    agentId: 'agent-1',
    taskStatus: 'inProgress',
    events,
  });
}

describe('deriveLatestCompletionSignal', () => {
  test('projects a signal for an in-progress completed turn', () => {
    const result = signal([
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 2 },
      stop('Implemented the requested change.', 3),
    ]);

    expect(result?.id).toHaveLength(16);
  });

  test('omits terminal tasks', () => {
    expect(deriveLatestCompletionSignal({
      taskId: 'task-1',
      agentId: 'agent-1',
      taskStatus: 'completed',
      events: [stop()],
    })).toBeUndefined();
  });

  test('omits non-completed turn states', () => {
    expect(signal([{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }])).toBeUndefined();
    expect(signal([{ type: 'permission_request', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }])).toBeUndefined();
    expect(signal([{ type: 'tool_use', sessionId: 's1', toolName: 'AskUserQuestion', eventSeq: 1 }])).toBeUndefined();
  });

  test('omits empty final messages', () => {
    expect(signal([stop('   ', 1)])).toBeUndefined();
  });

  test('trailing overlays do not change the signal identity', () => {
    const base = signal([userPrompt(1), stop('PR opened.', 2)]);
    const withOverlay = signal([
      userPrompt(1),
      stop('PR opened.', 2),
      { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'waiting', eventSeq: 3 },
    ]);

    expect(withOverlay?.id).toBe(base?.id);
  });

  test('snapshot replay of the same Stop event keeps the same id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const duplicate = signal([userPrompt(1), stop('All done.', 2)]);

    expect(duplicate?.id).toBe(first?.id);
  });

  test('a later Stop event with the same final message produces a new id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const laterStop = signal([userPrompt(1), stop('All done.', 2), stop('All done.', 3)]);

    expect(laterStop?.id).not.toBe(first?.id);
  });

  test('a follow-up turn with the same final message produces a new id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const second = signal([userPrompt(1), stop('All done.', 2), userPrompt(3), stop('All done.', 4)]);

    expect(second?.id).not.toBe(first?.id);
  });
});

describe('evaluateCompletionSignal', () => {
  const completedTurn: AgentEvent[] = [userPrompt(1), stop('Implemented and pushed.', 2)];

  function evaluate(overrides: Partial<CompletionSignalEvaluationInput> = {}) {
    return evaluateCompletionSignal({
      taskId: 'task-1',
      agentId: 'agent-1',
      status: 'inProgress',
      events: completedTurn,
      ...overrides,
    });
  }

  test('auto-signals when delivery is pre-authorized and the turn completed cleanly', () => {
    const decision = evaluate({ deliveryAuthorization: 'pre-authorized' });
    expect(decision.action).toBe('auto_signal');
    expect(decision.reason).toBe('auto_signal_authorized');
    expect(decision.signalId).toHaveLength(16);
    expect(decision.detail).toMatch(/auto-raising/i);
  });

  test('auto-signals an ask-first task once its delivery is satisfied', () => {
    const decision = evaluate({ deliveryAuthorization: 'ask-first', deliverySatisfied: true });
    expect(decision.action).toBe('auto_signal');
    expect(decision.reason).toBe('auto_signal_authorized');
  });

  test('remediates once per task state and suppresses the repeat', () => {
    const first = evaluate();
    expect(first.action).toBe('remediate');
    expect(first.reason).toBe('remediation_needed');
    expect(first.stateFingerprint).toBeTruthy();

    // A repeated Stop attempt with no state change replays the same fingerprint.
    const repeat = evaluate({ lastRemediationFingerprint: first.stateFingerprint });
    expect(repeat.action).toBe('skip');
    expect(repeat.reason).toBe('remediation_already_delivered');
    expect(repeat.stateFingerprint).toBe(first.stateFingerprint);
  });

  test('re-enables one reminder after the task state changes', () => {
    const first = evaluate();
    // The agent does more work: a later Stop shifts the completion evidence.
    const afterMoreWork = evaluate({
      events: [userPrompt(1), stop('Implemented and pushed.', 2), userPrompt(3), stop('Addressed review.', 4)],
      lastRemediationFingerprint: first.stateFingerprint,
    });
    expect(afterMoreWork.action).toBe('remediate');
    expect(afterMoreWork.stateFingerprint).not.toBe(first.stateFingerprint);
  });

  test('is idempotent for an already-signaled task', () => {
    const decision = evaluate({ pendingSignalKind: 'completion_ready', deliveryAuthorization: 'pre-authorized' });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('already_signaled');
  });

  test('never auto-signals a delivery-blocked (ask-first, undelivered) task', () => {
    const decision = evaluate({ deliveryAuthorization: 'ask-first' });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('delivery_blocked');
    // An explicit not-satisfied flag is treated the same as the fail-safe default.
    expect(evaluate({ deliveryAuthorization: 'ask-first', deliverySatisfied: false }).reason).toBe('delivery_blocked');
  });

  test('skips when the turn is not cleanly complete', () => {
    const decision = evaluate({ events: [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }] });
    expect(decision.action).toBe('skip');
    expect(decision.reason).toBe('turn_incomplete');
  });

  test('skips terminal and non-in-progress tasks with a recorded reason', () => {
    expect(evaluate({ status: 'completed' })).toMatchObject({ action: 'skip', reason: 'terminal_status' });
    expect(evaluate({ status: 'open' })).toMatchObject({ action: 'skip', reason: 'not_in_progress' });
  });
});
