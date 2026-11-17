import { describe, expect, it } from 'vitest';
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import type { OperatorAttentionKind } from './attention.js';
import {
  MAX_OPERATOR_BRIEFING_CHIPS,
  MAX_OPERATOR_BRIEFING_WORDS,
  RECENTLY_ENDED_MS,
  buildOperatorBriefing,
  sayableTaskName,
  type OperatorBriefingTask,
} from './operator-briefing.js';

const NOW = 2_000_000_000_000;

function task(id: string, name: string | undefined, attention?: OperatorAttentionKind, status: TaskStatus = 'inProgress'): OperatorBriefingTask {
  return { id, ...(name !== undefined ? { name } : {}), status, ...(attention ? { attention } : {}) };
}

function ask(id: string, taskId: string, taskName: string | undefined, over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id, taskId, ...(taskName !== undefined ? { taskName } : {}), question: 'Run the rename in /srv/app now?', options: ['Yes', 'No'],
    allowText: false, state: 'pending', createdAt: NOW - 60_000, expiresAt: NOW + 60_000, taskEnded: false, ...over,
  };
}

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

describe('buildOperatorBriefing: what needs the operator comes first', () => {
  it('leads with the questions and names the one that closes first, then the rest, then who is working', () => {
    const briefing = buildOperatorBriefing({
      tasks: [
        task('t1', 'Billing migration'), task('t2', 'Fix login'), task('t3', 'Search index'),
        task('t4', 'Docs link audit', 'wants_review'),
        task('t5', 'Deploy fix', 'permission_blocked'), task('t6', 'Cache warmup', 'permission_blocked'),
        task('w1', 'A'), task('w2', 'B'), task('w3', 'C'), task('w4', 'D'),
      ],
      asks: [ask('a1', 't2', 'Fix login', { expiresAt: NOW + 9_000 }), ask('a2', 't1', 'Billing migration', { expiresAt: NOW + 5_000 }), ask('a3', 't3', 'Search index', { expiresAt: NOW + 7_000 })],
    }, NOW);
    expect(briefing.text).toBe(
      'Three tasks are stopped on a question; Billing migration\'s closes first. Two others are waiting for a permission. '
      + 'Docs link audit says it is finished and wants your review. Four more are working.',
    );
    expect(briefing.chips).toEqual(['Walk me through the questions', 'What should I do first?', 'What wants my review?']);
  });

  it('names a single task in each group and says why it waits', () => {
    const briefing = buildOperatorBriefing({
      tasks: [
        task('t1', 'Billing migration', 'asked_question'), task('t2', 'Fix login', 'permission_blocked'),
        task('t3', 'Search index', 'needs_input'), task('t4', 'Docs link audit', 'wants_review'),
        task('t5', 'Cache warmup', 'stale_agent'), task('w1', 'A'),
      ],
    }, NOW);
    expect(briefing.text).toBe(
      'Billing migration is stopped on a question. Fix login is waiting for a permission. Search index stopped and needs your input. '
      + 'Cache warmup has gone quiet. Docs link audit says it is finished and wants your review. One more is working.',
    );
  });

  it.each([
    ['hook_disconnected', 'Cache warmup has lost contact with Kookr. Nothing else is running.'],
    ['repeated_error', 'Cache warmup keeps hitting the same error. Nothing else is running.'],
    ['merge_conflict', 'Cache warmup has a merge conflict. Nothing else is running.'],
    ['budget_exceeded', 'Cache warmup went over its budget. Nothing else is running.'],
  ] as const)('says in plain words what is wrong with a task in trouble: %s', (kind, text) => {
    expect(buildOperatorBriefing({ tasks: [task('t5', 'Cache warmup', kind)] }, NOW).text).toBe(text);
  });

  it('counts a task with a question once, even when a finding is also raised on it', () => {
    const briefing = buildOperatorBriefing({
      tasks: [task('t1', 'Billing migration', 'needs_input')],
      asks: [ask('a1', 't1', 'Billing migration'), ask('a2', 't1', 'Billing migration')],
    }, NOW);
    expect(briefing.text).toBe('Billing migration is stopped on a question. Nothing else is running.');
  });

  it('does not count a task that has ended, whatever finding is still raised on it', () => {
    const briefing = buildOperatorBriefing({ tasks: [task('t1', 'Billing migration', 'stale_agent', 'terminated'), task('w1', 'A')] }, NOW);
    expect(briefing.text).toBe('All clear: nothing needs you. One task is working.');
  });
});

describe('buildOperatorBriefing: opinions and the all-clear', () => {
  it('says all clear in one line when nothing needs the operator', () => {
    expect(buildOperatorBriefing({ tasks: [task('w1', 'A'), task('w2', 'B'), task('d1', 'C', undefined, 'completed')] }, NOW).text)
      .toBe('All clear: nothing needs you. Two tasks are working.');
    expect(buildOperatorBriefing({ tasks: [] }, NOW)).toMatchObject({ text: 'All clear: nothing needs you. Nothing is running.', chips: [] });
  });

  it('tells a question from a task that has ended as an opinion wanted, after what is stopped', () => {
    const tasks = [task('t2', 'Fix login', 'permission_blocked'), task('w1', 'A')];
    const asks = [ask('o1', 'gone', undefined, { taskEnded: true }), ask('o2', 'gone-too', 'Old task', { taskEnded: true })];
    expect(buildOperatorBriefing({ tasks, asks }, NOW).text)
      .toBe('Fix login is waiting for a permission. Two finished tasks would like your opinion. One more is working.');
    expect(buildOperatorBriefing({ tasks: [task('w1', 'A')], asks: asks.slice(0, 1) }, NOW).text)
      .toBe('Nothing is stopped waiting for you. One finished task would like your opinion. One task is working.');
  });

  it('ignores questions that are closed', () => {
    const asks = [ask('a1', 't1', 'Fix login', { state: 'answered' }), ask('a2', 't1', 'Fix login', { state: 'expired' })];
    expect(buildOperatorBriefing({ tasks: [task('t1', 'Fix login')], asks }, NOW).text).toBe('All clear: nothing needs you. One task is working.');
  });
});

describe('buildOperatorBriefing: caps', () => {
  const longNames = ['Move the billing tables to Postgres', 'Rewrite the nightly report job today', 'Audit every link in the docs', 'Warm the cache after each deploy', 'Trim the search index on Sundays'];

  it('stays within 45 words and counts what did not fit, most urgent groups kept', () => {
    const briefing = buildOperatorBriefing({
      tasks: [
        task('t1', longNames[0], 'permission_blocked'), task('t2', longNames[1], 'needs_input'), task('t3', longNames[2], 'wants_review'),
        task('t4', longNames[3], 'stale_agent'), task('q1', 'Q one'), task('q2', 'Q two'), task('w1', 'A'),
      ],
      asks: [ask('a1', 'q1', longNames[4], { expiresAt: NOW + 1 }), ask('a2', 'q2', 'Fix login', { expiresAt: NOW + 2 }), ask('o1', 'gone', undefined, { taskEnded: true })],
    }, NOW);
    expect(words(briefing.text)).toBeLessThanOrEqual(MAX_OPERATOR_BRIEFING_WORDS);
    expect(briefing.text).toBe(
      'Two tasks are stopped on a question; Trim the search index on Sundays\'s closes first. Move the billing tables to Postgres is waiting for a permission. '
      + 'Rewrite the nightly report job today stopped and needs your input. Two more need you.',
    );
  });

  it('stays within 45 words for every mix of groups, with long names and large counts', () => {
    const kinds: OperatorAttentionKind[] = ['asked_question', 'permission_blocked', 'needs_input', 'stale_agent', 'wants_review'];
    for (let mask = 0; mask < 1 << kinds.length; mask += 1) {
      for (const perGroup of [1, 2, 14]) {
        const tasks: OperatorBriefingTask[] = [];
        kinds.forEach((kind, k) => {
          if ((mask & (1 << k)) === 0) return;
          for (let i = 0; i < perGroup; i += 1) tasks.push(task(`t${k}-${i}`, longNames[k], kind));
        });
        for (let i = 0; i < 23; i += 1) tasks.push(task(`w${i}`, 'Worker'));
        const asks = [ask('a1', 'q1', longNames[4]), ask('a2', 'q2', longNames[3]), ask('o1', 'gone', undefined, { taskEnded: true })];
        const briefing = buildOperatorBriefing({ tasks, asks }, NOW);
        expect(words(briefing.text)).toBeLessThanOrEqual(MAX_OPERATOR_BRIEFING_WORDS);
        expect(briefing.chips.length).toBeLessThanOrEqual(MAX_OPERATOR_BRIEFING_CHIPS);
      }
    }
  });

  it('offers at most three follow-ups, chosen from what is there', () => {
    expect(buildOperatorBriefing({ tasks: [task('t1', 'Fix login', 'stale_agent'), task('t2', 'Other', 'hook_disconnected')] }, NOW).chips)
      .toEqual(['What should I do first?', 'What went wrong?']);
    expect(buildOperatorBriefing({ tasks: [task('w1', 'A'), { ...task('d1', 'Done', undefined, 'completed'), endedAt: NOW - 60_000 }] }, NOW).chips)
      .toEqual(['What finished while I was away?', 'What is everyone working on?']);
    // A task that ended long ago is not "while I was away".
    expect(buildOperatorBriefing({ tasks: [{ ...task('d1', 'Done', undefined, 'completed'), endedAt: NOW - RECENTLY_ENDED_MS - 1 }] }, NOW).chips).toEqual([]);
    expect(buildOperatorBriefing({ tasks: [], asks: [ask('o1', 'gone', undefined, { taskEnded: true })] }, NOW).chips).toEqual(['Which opinions are wanted?']);
  });
});

describe('buildOperatorBriefing: nothing that should not be written', () => {
  it('never writes an id, a path, a secret or the text of a question', () => {
    const secret = `sk-ant-api03-${'a1b2c3d4e5'.repeat(4)}`;
    const briefing = buildOperatorBriefing({
      tasks: [
        task('task-0f3a9c1e', 'fix /srv/app/src/server/index.ts', 'permission_blocked'),
        task('task-77aa12bb', `use ${secret}`, 'stale_agent'),
        task('task-5d5d5d5d', 'can you check which of the tasks is terminated unexpectedly and tell me why please', 'wants_review'),
        task('task-9e9e9e9e', undefined, 'needs_input'),
      ],
      asks: [ask('ask-1234abcd', 'task-aaaa0000', '/home/op/project')],
    }, NOW);
    expect(briefing.text).toBe(
      'One task is stopped on a question. Another is waiting for a permission. Another stopped and needs your input. '
      + 'Another has gone quiet. Another says it is finished and wants your review. Nothing else is running.',
    );
    for (const hidden of ['task-', 'ask-', '/srv', '/home', 'sk-ant', 'rename', 'index.ts']) {
      expect(`${briefing.text} ${briefing.chips.join(' ')} ${briefing.signature}`).not.toContain(hidden);
    }
  });

  it('names a task only when its title may be said aloud', () => {
    expect(sayableTaskName('Billing migration')).toBe('Billing migration');
    expect(sayableTaskName(undefined)).toBeUndefined();
    expect(sayableTaskName('Untitled task')).toBeUndefined();
    expect(sayableTaskName('fix /srv/app/index.ts')).toBeUndefined();
  });
});

describe('buildOperatorBriefing: signature', () => {
  const base = {
    tasks: [task('t1', 'Billing migration'), task('t2', 'Fix login', 'permission_blocked'), task('w1', 'A')],
    asks: [ask('a1', 't1', 'Billing migration')],
  };
  const signature = (input: Parameters<typeof buildOperatorBriefing>[0], now = NOW): string => buildOperatorBriefing(input, now).signature;

  it('is the same for the same needs, whatever the order, the time, the working tasks and the tasks that ended', () => {
    const later = {
      tasks: [task('w2', 'B'), task('w3', 'C'), task('t2', 'Fix login renamed', 'permission_blocked'), task('t1', 'Billing migration'), { ...task('d1', 'Done', undefined, 'completed'), endedAt: NOW }],
      asks: [...base.asks],
    };
    expect(signature(later, NOW + 3_600_000)).toBe(signature(base));
  });

  it('changes when a task starts or stops waiting, waits for another reason, or asks another question', () => {
    const before = signature(base);
    expect(signature({ ...base, tasks: [...base.tasks, task('t3', 'Search index', 'stale_agent')] })).not.toBe(before);
    expect(signature({ ...base, tasks: base.tasks.filter((t) => t.id !== 't2') })).not.toBe(before);
    expect(signature({ ...base, tasks: base.tasks.map((t) => (t.id === 't2' ? task('t2', 'Fix login', 'needs_input') : t)) })).not.toBe(before);
    expect(signature({ ...base, asks: [ask('a2', 't1', 'Billing migration')] })).not.toBe(before);
    expect(signature({ ...base, asks: [...base.asks, ask('o1', 'gone', undefined, { taskEnded: true })] })).not.toBe(before);
  });

  it('is one value for every all-clear', () => {
    expect(signature({ tasks: [] })).toBe(signature({ tasks: [task('w1', 'A'), task('d1', 'B', undefined, 'completed')] }));
  });
});
