import { describe, expect, test } from 'vitest';
import { ASK_LIMITS, type CreateSystemAskInput } from '../../shared/contracts/asks.js';
import {
  INTERRUPTED_CHOICE_LABELS,
  INTERRUPTED_TASKS_SYSTEM,
  buildInterruptedTasksQuestion,
  createInterruptedTasksAskPort,
  interruptedChoiceFromAsk,
} from './interrupted-tasks-ask.js';
import type { InterruptedBatch } from './interrupted-tasks-service.js';

const NOW = 1_000_000;

function batch(tasks: InterruptedBatch['tasks'], deadlineInMin = 10): InterruptedBatch {
  return { id: 'b1', source: 'restart', createdAt: NOW, deadlineAt: NOW + deadlineInMin * 60_000, state: 'pending', tasks };
}

describe('buildInterruptedTasksQuestion', () => {
  test('offers Resume and Leave stopped when every task can continue its conversation', () => {
    const q = buildInterruptedTasksQuestion(batch([{ taskId: 'a', name: 'Fix the parser', mode: 'resume' }]), NOW);
    expect(q.question).toBe('Kookr restarted and found 1 interrupted task. Resume it?');
    expect(q.options).toEqual(['Resume', 'Leave stopped']);
    expect(q.context).toContain('• Fix the parser: continues its conversation');
    expect(q.context).toContain('With no answer in 10 min, the 1 task with a conversation resume.');
  });

  test('adds the restart option, and says what happens to each task, when some cannot resume', () => {
    const q = buildInterruptedTasksQuestion(batch([
      { taskId: 'a', name: 'A', mode: 'resume' },
      { taskId: 'b', name: 'B', mode: 'fresh', reason: 'no conversation id' },
    ]), NOW);
    expect(q.question).toBe('Kookr restarted and found 2 interrupted tasks. Resume them?');
    expect(q.options).toEqual(['Resume', 'Resume + restart the rest', 'Leave stopped']);
    expect(q.context).toContain('• B: no conversation to resume (no conversation id), restarts from its prompt only on "Resume + restart the rest"');
  });

  test('says nothing restarts at the deadline when no task can resume', () => {
    const q = buildInterruptedTasksQuestion(batch([{ taskId: 'b', name: 'B', mode: 'fresh' }]), NOW);
    expect(q.context).toContain('With no answer in 10 min, nothing is restarted.');
  });

  test('keeps the context within the ask limit for a large batch', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ taskId: `t${i}`, name: `A fairly long task title number ${i}`, mode: 'resume' as const }));
    const q = buildInterruptedTasksQuestion(batch(many), NOW);
    expect(q.context.length).toBeLessThanOrEqual(ASK_LIMITS.maxContextChars);
    expect(q.context).toMatch(/… and \d+ more/);
    expect(q.context).toContain('With no answer in 10 min');
  });

  test('every option label fits the ask limit', () => {
    for (const label of Object.values(INTERRUPTED_CHOICE_LABELS)) expect(label.length).toBeLessThanOrEqual(ASK_LIMITS.maxLabelChars);
  });
});

describe('createInterruptedTasksAskPort', () => {
  test('raises a system ask that expires with the batch and allows no free text', async () => {
    const calls: CreateSystemAskInput[] = [];
    const port = createInterruptedTasksAskPort({
      createSystem: async (input) => {
        calls.push(input);
        return { ok: true, ask: { id: 'x1' } as never, deduped: false, redacted: [] };
      },
      cancel: async () => undefined,
    }, () => NOW);
    expect(await port.raise(batch([{ taskId: 'a', name: 'A', mode: 'resume' }], 7))).toEqual({ askId: 'x1' });
    expect(calls[0]).toMatchObject({ system: INTERRUPTED_TASKS_SYSTEM, allowText: false, timeoutSec: 7 * 60 });
  });

  test('reports why the question could not be raised', async () => {
    const port = createInterruptedTasksAskPort({
      createSystem: async () => ({ ok: false, error: { code: 'not_configured' } }),
      cancel: async () => undefined,
    }, () => NOW);
    expect(await port.raise(batch([{ taskId: 'a', name: 'A', mode: 'resume' }]))).toEqual({ error: 'not_configured' });
  });
});

describe('interruptedChoiceFromAsk', () => {
  test('maps an answered option of our ask to its choice', () => {
    for (const [choice, label] of Object.entries(INTERRUPTED_CHOICE_LABELS)) {
      expect(interruptedChoiceFromAsk({ system: INTERRUPTED_TASKS_SYSTEM, state: 'answered', answer: { kind: 'option', index: 0, label } }))
        .toBe(choice);
    }
  });

  test('ignores other systems, task asks, and asks that were not answered', () => {
    const answer = { kind: 'option' as const, index: 0, label: 'Resume' };
    expect(interruptedChoiceFromAsk({ system: 'other', state: 'answered', answer })).toBeUndefined();
    expect(interruptedChoiceFromAsk({ state: 'answered', answer })).toBeUndefined();
    expect(interruptedChoiceFromAsk({ system: INTERRUPTED_TASKS_SYSTEM, state: 'expired' })).toBeUndefined();
  });
});
