import { describe, expect, test } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import type { AgentEvent } from '../../shared/contracts/agent-events.js';
import { createInteractiveDenyProcessor } from './interactive-deny-processor.js';

const FIXED_NOW = new Date('2026-07-28T00:00:00.000Z');

function makeStoreWithSession(opts: { unattended: boolean }): { store: TaskStore; taskId: string; tmux: string } {
  const store = new TaskStore();
  const task = store.createTask({ prompt: 'Autonomous work', cwd: '/repo', unattended: opts.unattended });
  const tmux = 'kookr-deny01';
  store.addSession(task.id, {
    tmuxSession: tmux,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: FIXED_NOW,
  });
  return { store, taskId: task.id, tmux };
}

function toolUse(toolName: string): AgentEvent {
  return { type: 'tool_use', sessionId: 'sess-1', toolName };
}

describe('interactive-deny-processor', () => {
  test('flags an unattended task operator-needed when it attempts an interactive tool', () => {
    const { store, taskId, tmux } = makeStoreWithSession({ unattended: true });
    const processor = createInteractiveDenyProcessor({ taskStore: store, now: () => FIXED_NOW });

    processor.process({ tmuxName: tmux, event: toolUse('AskUserQuestion') });

    const task = store.getTask(taskId)!;
    expect(task.operatorNeeded).toEqual({
      reason: 'interactive_tool_denied',
      toolName: 'AskUserQuestion',
      detectedAt: FIXED_NOW,
      message: expect.stringContaining('AskUserQuestion'),
    });
  });

  test('does not flag attended tasks', () => {
    const { store, taskId, tmux } = makeStoreWithSession({ unattended: false });
    const processor = createInteractiveDenyProcessor({ taskStore: store, now: () => FIXED_NOW });

    processor.process({ tmuxName: tmux, event: toolUse('AskUserQuestion') });

    expect(store.getTask(taskId)!.operatorNeeded).toBeUndefined();
  });

  test('ignores non-interactive tools on unattended tasks', () => {
    const { store, taskId, tmux } = makeStoreWithSession({ unattended: true });
    const processor = createInteractiveDenyProcessor({ taskStore: store, now: () => FIXED_NOW });

    processor.process({ tmuxName: tmux, event: toolUse('Bash') });

    expect(store.getTask(taskId)!.operatorNeeded).toBeUndefined();
  });

  test('is first-write-wins: a second denied call keeps the original marker and logs once', () => {
    const { store, taskId, tmux } = makeStoreWithSession({ unattended: true });
    const logs: string[] = [];
    let tick = 0;
    const processor = createInteractiveDenyProcessor({
      taskStore: store,
      now: () => new Date(FIXED_NOW.getTime() + tick++ * 1000),
      log: (line) => logs.push(line),
    });

    processor.process({ tmuxName: tmux, event: toolUse('AskUserQuestion') });
    processor.process({ tmuxName: tmux, event: toolUse('AskUserQuestion') });

    expect(store.getTask(taskId)!.operatorNeeded?.detectedAt).toEqual(FIXED_NOW);
    expect(logs).toHaveLength(1);
  });

  test('no-ops when no task owns the session', () => {
    const store = new TaskStore();
    const processor = createInteractiveDenyProcessor({ taskStore: store, now: () => FIXED_NOW });

    expect(() =>
      processor.process({ tmuxName: 'kookr-unknown', event: toolUse('AskUserQuestion') }),
    ).not.toThrow();
  });
});
