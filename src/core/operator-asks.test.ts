import { describe, expect, it } from 'vitest';
import { OPERATOR_ASK_MAX_LISTED, OPERATOR_ASK_RESOLVED_VISIBLE_MS, type AskRecord } from '../shared/contracts/asks.js';
import { askTaskName, buildAskSpeech, listOperatorAsks, toOperatorAskView } from './operator-asks.js';

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

describe('toOperatorAskView', () => {
  it('keeps what the panel shows and drops the nonce and the Telegram coordinates', () => {
    const view = toOperatorAskView(ask({ context: 'Background', idempotencyKey: 'k' }), names);
    expect(view).toEqual({
      id: 'a1b2c3d4e5f6', taskId: 't1', taskName: 'Fix login', question: 'Ship it?', context: 'Background',
      options: ['Yes', 'No'], allowText: true, state: 'pending', createdAt: NOW - 60_000, expiresAt: NOW + 60_000,
    });
    expect(JSON.stringify(view)).not.toMatch(/nonce|delivery|chatId|idempotency/);
  });

  it('carries the answer and the channel it came from', () => {
    const view = toOperatorAskView(ask({
      state: 'answered', resolution: 'answered', answeredVia: 'telegram', answeredBy: 99, resolvedAt: NOW - 5,
      answer: { kind: 'option', index: 0, label: 'Yes' },
    }), names);
    expect(view).toMatchObject({ state: 'answered', answeredVia: 'telegram', resolvedAt: NOW - 5, answer: { label: 'Yes' } });
    expect(view).not.toHaveProperty('answeredBy');
  });

  it('leaves the task name out when the title is missing, too long or unreadable', () => {
    expect(toOperatorAskView(ask({ taskId: 'unknown' }), names)).not.toHaveProperty('taskName');
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
    ], NOW, names);
    expect(list.map((a) => a.id)).toEqual(['newest', 'just-answered', 'old-pending']);
  });

  it('falls back to answeredAt, then expiresAt, for records written before resolvedAt existed', () => {
    const list = listOperatorAsks([
      ask({ id: 'answered-old-format', state: 'answered', answeredAt: NOW - 2_000 }),
      ask({ id: 'expired-old-format', state: 'expired', expiresAt: NOW - 3_000 }),
      ask({ id: 'expired-long-ago', state: 'expired', expiresAt: NOW - OPERATOR_ASK_RESOLVED_VISIBLE_MS - 1 }),
    ], NOW, names);
    expect(list.map((a) => a.id).sort()).toEqual(['answered-old-format', 'expired-old-format']);
  });

  it('never lists a question that was not sent', () => {
    const list = listOperatorAsks([
      ask({ id: 'unsent', delivery: undefined }),
      ask({ id: 'failed', state: 'cancelled', resolution: 'delivery_failed', resolvedAt: NOW }),
    ], NOW, names);
    expect(list).toEqual([]);
  });

  it('caps the closed questions but never drops a pending one', () => {
    const closedNewer = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 5 }, (_, i) => ask({
      id: `closed-${i}`, state: 'answered', resolvedAt: NOW - i, createdAt: NOW - 1000 - i,
    }));
    const list = listOperatorAsks([ask({ id: 'old-pending', createdAt: NOW - 9 * 60_000 }), ...closedNewer], NOW, names);
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
    const ids = listOperatorAsks([...waiting, ...olderClosed, justAnswered], NOW, names).map((a) => a.id);
    expect(ids).toContain('just-answered');
    expect(ids.filter((id) => id.startsWith('pending-'))).toHaveLength(OPERATOR_ASK_MAX_LISTED + 2);
    expect(ids.filter((id) => !id.startsWith('pending-'))).toHaveLength(OPERATOR_ASK_MAX_LISTED);
  });

  it('lists every pending question even beyond the cap', () => {
    const many = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 1 }, (_, i) => ask({ id: `pending-${i}`, createdAt: NOW - i }));
    const list = listOperatorAsks(many, NOW, names);
    expect(list.map((a) => a.id)).toEqual(many.map((a) => a.id));
  });

  it('always states when a closed question closed, and does not list an old cancellation as recent', () => {
    const list = listOperatorAsks([
      ask({ id: 'answered-old-format', state: 'answered', answeredAt: NOW - 2_000 }),
      // Written before resolvedAt existed: cancelled 17 hours ago, with a 24-hour timeout still in the future.
      ask({ id: 'cancelled-old-format', state: 'cancelled', resolution: 'cancelled', createdAt: NOW - 17 * 3_600_000, expiresAt: NOW + 7 * 3_600_000 }),
    ], NOW, names);
    expect(list.map((a) => a.id)).toEqual(['answered-old-format']);
    expect(list[0].resolvedAt).toBe(NOW - 2_000);
  });

  it('carries whether the answer reached the task', () => {
    const [view] = listOperatorAsks([ask({ state: 'answered', resolvedAt: NOW, taskDelivery: 'failed' })], NOW, names);
    expect(view.taskDelivery).toBe('failed');
  });
});

describe('buildAskSpeech', () => {
  it('says who asks, the question and the choices', () => {
    expect(buildAskSpeech(ask({ options: ['Yes', 'No', 'Later'] }), 'Fix login'))
      .toBe('The task Fix login needs your input. Ship it? You can answer: Yes, No, or Later.');
  });

  it('uses a generic opener without a task name and ends an unpunctuated question', () => {
    expect(buildAskSpeech(ask({ question: 'Pick a region' }), undefined))
      .toBe('A task needs your input. Pick a region. You can answer: Yes or No.');
  });

  it('never reads the background context', () => {
    const spoken = buildAskSpeech(ask({ context: 'See /srv/app/src/server/index.ts line 4268' }), 'Fix login');
    expect(spoken).not.toContain('index');
    expect(spoken).toBe('The task Fix login needs your input. Ship it? You can answer: Yes or No.');
  });

  it('does not read a secret or a path out loud', () => {
    const spoken = buildAskSpeech(ask({
      question: 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 from /srv/app/data/asks/secret?',
    }), undefined);
    expect(spoken).not.toContain('sk-ant-api03');
    expect(spoken).not.toContain('/srv/app');
    // The rest of the sentence survives the redaction.
    expect(spoken).toMatch(/^A task needs your input\. Use the key/);
    expect(spoken).toMatch(/You can answer: Yes or No\.$/);
  });
});
