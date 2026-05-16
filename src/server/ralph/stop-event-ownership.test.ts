import { describe, expect, test } from 'vitest';
import { isStopFromMainTaskSession, ralphStopFingerprint } from './stop-event-ownership.js';
import { TaskStore } from '../../core/tasks.js';
import type { AgentEvent } from '../../core/types.js';

describe('isStopFromMainTaskSession', () => {
  test('accepts Stop from the Ralph owner terminal session before runtime metadata arrives', () => {
    // Regression for the iteration-stall bug. Before the fix, a Ralph loop
    // attached at task launch time saw an empty session.claudeSessionId; the
    // old three-ref Stop gate rejected the agent's Stop before the runtime id
    // was backfilled. The gate now keys on the terminal session owner only.
    const store = new TaskStore();
    const task = store.createTask('Looped', '/cwd');
    store.addSession(task.id, {
      tmuxSession: 'kookr-loop',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 0,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 0,
      ownerSessionId: 'kookr-loop',
    };

    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-late',
      transcriptPath: '/late.jsonl',
      turnId: 'turn-1',
      lastMessage: 'done',
    };

    expect(isStopFromMainTaskSession(task, 'kookr-loop', stopEvent)).toBe(true);
  });

  test('rejects Stop from a stale terminal session even when runtime metadata matches', () => {
    const store = new TaskStore();
    const task = store.createTask('Looped', '/cwd');
    store.addSession(task.id, {
      tmuxSession: 'kookr-owner',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    store.addSession(task.id, {
      tmuxSession: 'kookr-stale',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 0,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 0,
      ownerSessionId: 'kookr-owner',
    };
    store.updateSession(task.id, 'kookr-stale', {
      claudeSessionId: 'runtime-late',
      transcriptPath: '/late.jsonl',
    });

    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-late',
      transcriptPath: '/late.jsonl',
      turnId: 'turn-1',
      lastMessage: 'done',
    };

    expect(isStopFromMainTaskSession(task, 'kookr-stale', stopEvent)).toBe(false);
  });
});

describe('ralphStopFingerprint', () => {
  test('uses hook line id so same-message Stops in long turns remain distinct', () => {
    const first: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      hookLineId: '100',
      lastMessage: 'done',
    };
    const second: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      hookLineId: '200',
      lastMessage: 'done',
    };

    expect(ralphStopFingerprint('agent-1', [first], first)).not.toBe(
      ralphStopFingerprint('agent-1', [second], second),
    );
  });

  test('uses turn id when the hook payload provides one', () => {
    const first: AgentEvent = {
      type: 'stop',
      sessionId: 'main-runtime',
      turnId: 'turn-1',
      hookLineId: '100',
      lastMessage: 'done',
    };
    const replay: AgentEvent = {
      ...first,
      hookLineId: '999',
    };

    expect(ralphStopFingerprint('agent-1', [first], first)).toBe(
      ralphStopFingerprint('agent-1', [replay], replay),
    );
  });
});
