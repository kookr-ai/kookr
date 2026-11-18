import { describe, expect, it } from 'vitest';
import { OPERATOR_ASK_MAX_LISTED, OPERATOR_ASK_RESOLVED_VISIBLE_MS, type AskRecord } from '../shared/contracts/asks.js';
import type { TaskStatus } from '../shared/contracts/task-status.js';
import {
  MAX_ASK_SPEECH_QUESTION_WORDS,
  MAX_ASK_SPEECH_WORDS,
  askTaskName,
  buildAskSpeech,
  listOperatorAsks,
  toOperatorAskView,
} from './operator-asks.js';

const NOW = 2_000_000_000_000;

function ask(over: Partial<AskRecord> = {}): AskRecord {
  return {
    id: 'a1b2c3d4e5f6', taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - 60_000, expiresAt: NOW + 60_000, nonce: 'secret-nonce',
    delivery: { chatId: 42, messageId: 7 },
    ...over,
  };
}

const names = (id: string): string | undefined => (id === 't1' ? 'Fix login' : undefined);
// t1 is still running, t-done has finished, and any other id is a task that no longer exists.
const statuses = (id: string): TaskStatus | undefined => (id === 't1' ? 'inProgress' : id === 't-done' ? 'completed' : undefined);

describe('toOperatorAskView', () => {
  it('keeps what the panel shows and drops the nonce and the Telegram coordinates', () => {
    const view = toOperatorAskView(ask({ context: 'Background', idempotencyKey: 'k' }), names, statuses);
    expect(view).toEqual({
      id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', taskEnded: false, question: 'Ship it?', context: 'Background',
      options: ['Yes', 'No'], allowText: true, state: 'pending', createdAt: NOW - 60_000, expiresAt: NOW + 60_000,
    });
    expect(JSON.stringify(view)).not.toMatch(/nonce|delivery|chatId|idempotency/);
  });

  it.each([
    ['a running task', 't1', false],
    ['a finished task', 't-done', true],
    ['a task that no longer exists', 'gone', true],
  ])('marks whether the task that asked has ended: %s', (_label, taskId, ended) => {
    expect(toOperatorAskView(ask({ taskId }), names, statuses).taskEnded).toBe(ended);
  });

  it.each(['open', 'pending', 'inProgress', 'completed', 'terminated', 'cancelled'] as const)(
    'reads the %s status the way isTerminalStatus does',
    (status) => {
      const ended = status === 'completed' || status === 'terminated' || status === 'cancelled';
      expect(toOperatorAskView(ask(), names, () => status).taskEnded).toBe(ended);
    },
  );

  it('carries the links the card shows as buttons (#3929)', () => {
    const links = [{ url: 'https://claude.ai/artifact/abc', label: 'Open mockups' }, { url: 'https://github.com/o/r/pull/1' }];
    expect(toOperatorAskView(ask({ links }), names, statuses).links).toEqual(links);
    expect(toOperatorAskView(ask({ links: [] }), names, statuses)).not.toHaveProperty('links');
  });

  it('carries the answer and the channel it came from', () => {
    const view = toOperatorAskView(ask({
      state: 'answered', resolution: 'answered', answeredVia: 'telegram', answeredBy: 99, resolvedAt: NOW - 5,
      answer: { kind: 'option', index: 0, label: 'Yes' },
    }), names, statuses);
    expect(view).toMatchObject({ state: 'answered', answeredVia: 'telegram', resolvedAt: NOW - 5, answer: { label: 'Yes' } });
    expect(view).not.toHaveProperty('answeredBy');
  });

  it('leaves the task name out when the title is missing, too long or unreadable', () => {
    expect(toOperatorAskView(ask({ taskId: 'unknown' }), names, statuses)).not.toHaveProperty('taskName');
    expect(askTaskName('Fix the login page')).toBe('Fix the login page');
    expect(askTaskName(undefined)).toBeUndefined();
    expect(askTaskName('word '.repeat(40))).toBeUndefined();
  });
});

describe('listOperatorAsks', () => {
  it('lists pending asks and recently closed ones, newest first', () => {
    const list = listOperatorAsks([
      ask({ id: 'old-pending', createdAt: NOW - 3_600_000 }),
      ask({ id: 'just-answered', state: 'answered', resolvedAt: NOW - 1_000, createdAt: NOW - 30_000 }),
      ask({ id: 'long-answered', state: 'answered', resolvedAt: NOW - OPERATOR_ASK_RESOLVED_VISIBLE_MS - 1 }),
      ask({ id: 'newest', createdAt: NOW - 1_000 }),
    ], NOW, names, statuses);
    expect(list.map((a) => a.id)).toEqual(['newest', 'just-answered', 'old-pending']);
  });

  it('falls back to answeredAt, then expiresAt, for records written before resolvedAt existed', () => {
    const list = listOperatorAsks([
      ask({ id: 'answered-old-format', state: 'answered', answeredAt: NOW - 2_000 }),
      ask({ id: 'expired-old-format', state: 'expired', expiresAt: NOW - 3_000 }),
      ask({ id: 'expired-long-ago', state: 'expired', expiresAt: NOW - OPERATOR_ASK_RESOLVED_VISIBLE_MS - 1 }),
    ], NOW, names, statuses);
    expect(list.map((a) => a.id).sort()).toEqual(['answered-old-format', 'expired-old-format']);
  });

  it('never lists a question that was not sent', () => {
    const list = listOperatorAsks([
      ask({ id: 'unsent', delivery: undefined }),
      ask({ id: 'failed', state: 'cancelled', resolution: 'delivery_failed', resolvedAt: NOW }),
    ], NOW, names, statuses);
    expect(list).toEqual([]);
  });

  it('caps the closed questions but never drops a pending one', () => {
    const closedNewer = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 5 }, (_, i) => ask({
      id: `closed-${i}`, state: 'answered', resolvedAt: NOW - i, createdAt: NOW - 1000 - i,
    }));
    const list = listOperatorAsks([ask({ id: 'old-pending', createdAt: NOW - 9 * 60_000 }), ...closedNewer], NOW, names, statuses);
    expect(list).toHaveLength(OPERATOR_ASK_MAX_LISTED + 1);
    expect(list.map((a) => a.id)).toContain('old-pending');
    expect(list[0].id).toBe('closed-0');
    expect(list.at(-1)?.id).toBe('old-pending');
  });

  it('keeps a question answered a moment ago in the list however many are waiting or were asked later', () => {
    const waiting = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 2 }, (_, i) => ask({ id: `pending-${i}`, createdAt: NOW - i }));
    const olderClosed = Array.from({ length: OPERATOR_ASK_MAX_LISTED }, (_, i) => ask({
      id: `closed-${i}`, state: 'answered', resolvedAt: NOW - 60_000 - i, createdAt: NOW - 100 - i,
    }));
    // Asked long ago, answered just now: the newest outcome, though the oldest question.
    const justAnswered = ask({ id: 'just-answered', state: 'answered', resolvedAt: NOW - 10, createdAt: NOW - 20 * 60_000 });
    const ids = listOperatorAsks([...waiting, ...olderClosed, justAnswered], NOW, names, statuses).map((a) => a.id);
    expect(ids).toContain('just-answered');
    expect(ids.filter((id) => id.startsWith('pending-'))).toHaveLength(OPERATOR_ASK_MAX_LISTED + 2);
    expect(ids.filter((id) => !id.startsWith('pending-'))).toHaveLength(OPERATOR_ASK_MAX_LISTED);
  });

  it('lists every pending question even beyond the cap', () => {
    const many = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 1 }, (_, i) => ask({ id: `pending-${i}`, createdAt: NOW - i }));
    const list = listOperatorAsks(many, NOW, names, statuses);
    expect(list.map((a) => a.id)).toEqual(many.map((a) => a.id));
  });

  it('always states when a closed question closed, and does not list an old cancellation as recent', () => {
    const list = listOperatorAsks([
      ask({ id: 'answered-old-format', state: 'answered', answeredAt: NOW - 2_000 }),
      // Written before resolvedAt existed: cancelled 17 hours ago, with a 24-hour timeout still in the future.
      ask({ id: 'cancelled-old-format', state: 'cancelled', resolution: 'cancelled', createdAt: NOW - 17 * 3_600_000, expiresAt: NOW + 7 * 3_600_000 }),
    ], NOW, names, statuses);
    expect(list.map((a) => a.id)).toEqual(['answered-old-format']);
    expect(list[0].resolvedAt).toBe(NOW - 2_000);
  });

  it('carries whether the answer reached the task', () => {
    const [view] = listOperatorAsks([ask({ state: 'answered', resolvedAt: NOW, taskDelivery: 'failed' })], NOW, names, statuses);
    expect(view.taskDelivery).toBe('failed');
  });
});

describe('listOperatorAsks task state', () => {
  it('marks each listed question, keeping the newest-first order', () => {
    const list = listOperatorAsks([
      ask({ id: 'done', taskId: 't-done', createdAt: NOW - 1_000 }),
      ask({ id: 'running', taskId: 't1', createdAt: NOW - 2_000 }),
    ], NOW, names, statuses);
    expect(list.map((a) => [a.id, a.taskEnded])).toEqual([['done', true], ['running', false]]);
  });
});

describe('buildAskSpeech', () => {
  const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

  it('is capped at 25 words, of which at most 18 are the question', () => {
    expect(MAX_ASK_SPEECH_WORDS).toBe(25);
    expect(MAX_ASK_SPEECH_QUESTION_WORDS).toBe(18);
  });

  it('says who asks and what about in one sentence, and that the choices are on her card', () => {
    expect(buildAskSpeech(ask({ question: 'Run the table rename on production now?', options: ['Yes', 'No', 'Later'] }), 'Billing migration'))
      .toBe('The task Billing migration needs your input: Run the table rename on production now? Three choices are on my card.');
  });

  it('never reads the choices out', () => {
    const spoken = buildAskSpeech(ask({ options: ['Deploy to Frankfurt', 'Deploy to Dublin'] }), 'Fix login');
    expect(spoken).toBe('The task Fix login needs your input: Ship it? Two choices are on my card.');
    expect(spoken).not.toMatch(/Frankfurt|Dublin/);
  });

  it('uses a generic opener without a task name and ends an unpunctuated question', () => {
    expect(buildAskSpeech(ask({ question: 'Pick a region' }), undefined))
      .toBe('A task needs your input: Pick a region. Two choices are on my card.');
  });

  it('counts the choices in words, and says where to answer when there is only a text box', () => {
    expect(buildAskSpeech(ask({ options: ['A', 'B', 'C', 'D'] }), undefined)).toMatch(/Four choices are on my card\.$/);
    expect(buildAskSpeech(ask({ options: ['A'] }), undefined)).toMatch(/One choice is on my card\.$/);
    expect(buildAskSpeech(ask({ options: [] }), undefined)).toBe('A task needs your input: Ship it? You can answer on my card.');
  });

  it('never reads the background context', () => {
    const spoken = buildAskSpeech(ask({ context: 'See /srv/app/src/server/index.ts line 4268' }), 'Fix login');
    expect(spoken).not.toContain('index');
    expect(spoken).toBe('The task Fix login needs your input: Ship it? Two choices are on my card.');
  });

  it('does not read a secret or a path out loud', () => {
    const spoken = buildAskSpeech(ask({
      question: 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 from /srv/app/data/asks/secret?',
    }), undefined);
    expect(spoken).not.toContain('sk-ant-api03');
    expect(spoken).not.toContain('/srv/app');
    // The rest of the sentence survives the redaction.
    expect(spoken).toMatch(/^A task needs your input: Use the key/);
    expect(spoken).toMatch(/Two choices are on my card\.$/);
  });

  it('keeps the sentences of a long question that fit, and says the rest is on the card', () => {
    const spoken = buildAskSpeech(ask({
      question: 'The rename is ready. It touches the two billing tables and the nightly report that reads them, so it needs a quiet hour. Run it now?',
      options: ['Now', 'Tonight', 'Never'],
    }), 'Fix login');
    expect(spoken).toBe('The task Fix login needs your input: The rename is ready. The rest and three choices are on my card.');
  });

  it('does not take a dot inside a number, a host name or an abbreviation for the end of a sentence', () => {
    // Each of these is too long to read whole, so it is cut; the start of the question must survive.
    expect(buildAskSpeech(ask({ question: 'We are at version 2.1 now and the changelog is long. Ship it?' }), 'Fix login'))
      .toBe('The task Fix login needs your input: We are at version 2.1 now and the changelog… The rest and two choices are on my card.');
    expect(buildAskSpeech(ask({ question: 'There are options e.g. skip the backup or run the backup first and then migrate everything tonight. Which one?' }), 'Fix login'))
      .toBe('The task Fix login needs your input: There are options e.g. skip the backup or run… The rest and two choices are on my card.');
    expect(buildAskSpeech(ask({ question: 'Deploy api.example.com now or wait until the certificate for the other host has been renewed by the ops team later this week?' }), 'Fix login'))
      .toMatch(/^The task Fix login needs your input: Deploy api\.example\.com now or wait until/);
    // Short enough to read whole: untouched.
    expect(buildAskSpeech(ask({ question: 'Is v2.1 ok?' }), 'Fix login')).toBe('The task Fix login needs your input: Is v2.1 ok? Two choices are on my card.');
  });

  it('cuts a long single sentence between two words', () => {
    const spoken = buildAskSpeech(ask({
      question: 'Should I rebase the branch onto staging before pushing and then open the pull request against staging or keep it against main?',
    }), 'Fix login');
    expect(spoken).toBe('The task Fix login needs your input: Should I rebase the branch onto staging before pushing… The rest and two choices are on my card.');
    expect(wordCount(spoken)).toBe(MAX_ASK_SPEECH_WORDS);
  });

  it('reads at most 18 words of the question, even when nobody is named', () => {
    const question = `${Array.from({ length: 30 }, (_unused, i) => `word${'abcdefghijklmnopqrstuvwxyzabcd'[i]}`).join(' ')}?`;
    const spoken = buildAskSpeech(ask({ question }), undefined);
    const read = spoken.slice('A task needs your input: '.length, spoken.indexOf('…'));
    expect(wordCount(read)).toBeLessThanOrEqual(MAX_ASK_SPEECH_QUESTION_WORDS);
    expect(wordCount(spoken)).toBeLessThanOrEqual(MAX_ASK_SPEECH_WORDS);
  });

  it.each([
    ['a short name', 'Fix login'],
    ['a name of six words', 'Move the billing tables to Postgres'],
    ['no name', undefined],
  ])('never goes over 25 words, whatever the length of the question and the choices: %s', (_label, name) => {
    const long = 'Please decide whether the migration should run now on production or later tonight after the backup has finished and the nightly report is done';
    for (const question of [long, `${long}. ${long}?`, 'Short one. Another short one. ' + long]) {
      for (const options of [['Yes', 'No'], ['A very long first choice that would take seconds to read', 'B', 'C', 'D']]) {
        const spoken = buildAskSpeech(ask({ question, options }), name);
        expect(wordCount(spoken)).toBeLessThanOrEqual(MAX_ASK_SPEECH_WORDS);
        expect(spoken).toMatch(/on my card\.$/);
        expect(spoken).not.toContain('very long first choice');
      }
    }
  });
});

describe('Kookr\'s own questions (issue #4215)', () => {
  const systemAsk = () => ask({ taskId: 'system:interrupted-tasks', system: 'interrupted-tasks', question: 'Resume 2 interrupted tasks?' });

  it('are never shown as the question of an ended task, and carry the system name', () => {
    const view = toOperatorAskView(systemAsk(), names, statuses);
    expect(view.taskEnded).toBe(false);
    expect(view.system).toBe('interrupted-tasks');
    expect(view.taskName).toBeUndefined();
  });

  it('Lucy says Kookr asks, not a task', () => {
    expect(buildAskSpeech(systemAsk(), undefined)).toMatch(/^Kookr needs your input: Resume 2 interrupted tasks\?/);
  });
});
