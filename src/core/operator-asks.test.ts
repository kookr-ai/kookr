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

  it('caps the list', () => {
    const many = Array.from({ length: OPERATOR_ASK_MAX_LISTED + 5 }, (_, i) => ask({ id: `ask-${i}`, createdAt: NOW - i }));
    const list = listOperatorAsks(many, NOW, names);
    expect(list).toHaveLength(OPERATOR_ASK_MAX_LISTED);
    expect(list[0].id).toBe('ask-0');
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
  });

  it('does not read a secret or a path out loud', () => {
    const spoken = buildAskSpeech(ask({
      question: 'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 from /srv/app/data/asks/secret?',
    }), undefined);
    expect(spoken).not.toContain('sk-ant-api03');
    expect(spoken).not.toContain('/srv/app');
  });
});
