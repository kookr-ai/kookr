import { beforeEach, describe, expect, test, vi } from 'vitest';
import { OPERATOR_ASK_RESOLVED_VISIBLE_MS, type OperatorAskView } from '../../shared/contracts/asks.js';
import { ClientMessageSchema } from '../../shared/contracts/client-message-schema.js';
import {
  ASK_REPLY_TIMEOUT_MS,
  __resetOperatorAsksForTests,
  buildAnswerAskMessage,
  dismissOperatorAsk,
  getOperatorAsksSnapshot,
  handleOperatorAskResult,
  handleOperatorAsks,
  markAskSubmitting,
  onAskAnnounced,
  askClockOffsetMs,
  onAskClosed,
  visibleOperatorAsks,
} from './operator-asks.js';

const NOW = 2_000_000_000_000;

function ask(over: Partial<OperatorAskView> = {}): OperatorAskView {
  return {
    id: 'a1b2c3d4e5f6', taskId: 't1', question: 'Ship it?', options: ['Yes', 'No'], allowText: true,
    state: 'pending', createdAt: NOW - 1000, expiresAt: NOW + 60_000, ...over,
  };
}
const answeredOnTelegram = (over: Partial<OperatorAskView> = {}): OperatorAskView => ask({
  state: 'answered', resolution: 'answered', answeredVia: 'telegram', resolvedAt: NOW,
  answer: { kind: 'option', index: 0, label: 'Yes' }, ...over,
});

describe('operator asks store', () => {
  beforeEach(() => __resetOperatorAsksForTests());

  test('remembers how far the server clock is from the browser clock, and ignores a list without it', () => {
    expect(askClockOffsetMs()).toBe(0);
    handleOperatorAsks([], undefined, Date.now() + 3_600_000);
    expect(Math.abs(askClockOffsetMs() - 3_600_000)).toBeLessThan(1000);
    handleOperatorAsks([]);
    expect(Math.abs(askClockOffsetMs() - 3_600_000)).toBeLessThan(1000);
  });

  test('holds the list the server sent, newest state wins', () => {
    handleOperatorAsks([ask()]);
    expect(getOperatorAsksSnapshot().asks.map((a) => a.state)).toEqual(['pending']);
    handleOperatorAsks([answeredOnTelegram()]);
    expect(getOperatorAsksSnapshot().asks[0]).toMatchObject({ state: 'answered', answeredVia: 'telegram' });
    handleOperatorAsks([]);
    expect(getOperatorAsksSnapshot().asks).toEqual([]);
  });

  test('announces a question only on the message that created it', () => {
    const announced = vi.fn();
    onAskAnnounced(announced);
    handleOperatorAsks([ask()]); // a reload or reconnect: listed, not announced
    expect(announced).not.toHaveBeenCalled();
    handleOperatorAsks([ask({ id: 'bbbbbbbbbbbb' }), ask()], 'bbbbbbbbbbbb');
    expect(announced).toHaveBeenCalledOnce();
    expect(announced.mock.calls[0][0]).toMatchObject({ id: 'bbbbbbbbbbbb' });
  });

  test('does not announce a question that is already closed or not in the list', () => {
    const announced = vi.fn();
    onAskAnnounced(announced);
    handleOperatorAsks([answeredOnTelegram()], 'a1b2c3d4e5f6');
    handleOperatorAsks([ask()], 'ffffffffffff');
    expect(announced).not.toHaveBeenCalled();
  });

  test('tells listeners when a pending question closes, once', () => {
    const closed = vi.fn();
    onAskClosed(closed);
    handleOperatorAsks([ask()]);
    handleOperatorAsks([answeredOnTelegram()]);
    handleOperatorAsks([answeredOnTelegram()]);
    expect(closed).toHaveBeenCalledOnce();
    expect(closed.mock.calls[0][0]).toMatchObject({ answeredVia: 'telegram' });
  });

  test('tracks an answer on its way and clears it when the server accepts', () => {
    handleOperatorAsks([ask()]);
    markAskSubmitting('a1b2c3d4e5f6', true);
    expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toEqual({ status: 'sending' });
    handleOperatorAskResult('a1b2c3d4e5f6', true);
    expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toBeUndefined();
  });

  test('explains a refusal in plain words, and an answer that could not be sent', () => {
    handleOperatorAsks([ask()]);
    handleOperatorAskResult('a1b2c3d4e5f6', false, 'text_not_allowed');
    expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toEqual({ status: 'refused', message: 'This question only accepts the buttons.' });
    handleOperatorAskResult('a1b2c3d4e5f6', false, 'something-new');
    expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toEqual({ status: 'refused', message: 'The answer was refused.' });
    markAskSubmitting('a1b2c3d4e5f6', false);
    expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toMatchObject({ status: 'refused', message: expect.stringContaining('Not connected') });
  });

  test('an answer nobody confirmed stops "sending" after a while, so the operator can try again', () => {
    vi.useFakeTimers();
    try {
      handleOperatorAsks([ask()]);
      markAskSubmitting('a1b2c3d4e5f6', true);
      // Later pushes still list it as pending: the answer never arrived.
      handleOperatorAsks([ask()]);
      vi.advanceTimersByTime(ASK_REPLY_TIMEOUT_MS - 1);
      expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toEqual({ status: 'sending' });
      vi.advanceTimersByTime(1);
      expect(getOperatorAsksSnapshot().submit['a1b2c3d4e5f6']).toEqual({ status: 'refused', message: 'Kookr did not confirm your answer. Try again.' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a confirmed answer is not turned into a refusal by the timer', () => {
    vi.useFakeTimers();
    try {
      handleOperatorAsks([ask()]);
      markAskSubmitting('a1b2c3d4e5f6', true);
      handleOperatorAskResult('a1b2c3d4e5f6', true);
      vi.advanceTimersByTime(ASK_REPLY_TIMEOUT_MS * 2);
      expect(getOperatorAsksSnapshot().submit).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  test('drops a stale notice once the card itself shows the outcome', () => {
    handleOperatorAsks([ask()]);
    handleOperatorAskResult('a1b2c3d4e5f6', false, 'already_answered');
    handleOperatorAsks([answeredOnTelegram()]);
    expect(getOperatorAsksSnapshot().submit).toEqual({});
  });

  test('the answer message carries the choice, including the first button, and is one the server accepts', () => {
    const first = buildAnswerAskMessage('a1b2c3d4e5f6', { optionIndex: 0 });
    expect(first).toEqual({ type: 'answerAsk', askId: 'a1b2c3d4e5f6', optionIndex: 0 });
    expect(ClientMessageSchema.safeParse(first).success).toBe(true);
    const typed = buildAnswerAskMessage('a1b2c3d4e5f6', { text: 'do both' });
    expect(typed).toEqual({ type: 'answerAsk', askId: 'a1b2c3d4e5f6', text: 'do both' });
    expect(ClientMessageSchema.safeParse(typed).success).toBe(true);
  });

  test('a notice for a question that left the list is dropped with it', () => {
    handleOperatorAsks([ask()]);
    handleOperatorAskResult('a1b2c3d4e5f6', false, 'bad_option');
    handleOperatorAsks([]);
    expect(getOperatorAsksSnapshot().submit).toEqual({});
  });

  test('lets the operator dismiss a closed question but never a pending one', () => {
    handleOperatorAsks([ask({ id: 'bbbbbbbbbbbb' }), answeredOnTelegram()]);
    dismissOperatorAsk('bbbbbbbbbbbb');
    dismissOperatorAsk('a1b2c3d4e5f6');
    expect(getOperatorAsksSnapshot().asks.map((a) => a.id)).toEqual(['bbbbbbbbbbbb']);
    // It stays dismissed on the next push that still lists it.
    handleOperatorAsks([ask({ id: 'bbbbbbbbbbbb' }), answeredOnTelegram()]);
    expect(getOperatorAsksSnapshot().asks.map((a) => a.id)).toEqual(['bbbbbbbbbbbb']);
  });

  test('shows closed questions only for the visible window', () => {
    const list = [
      ask({ id: 'pending-old', expiresAt: NOW + 1 }),
      answeredOnTelegram({ id: 'fresh', resolvedAt: NOW - 1000 }),
      answeredOnTelegram({ id: 'stale', resolvedAt: NOW - OPERATOR_ASK_RESOLVED_VISIBLE_MS - 1 }),
      ask({ id: 'expired-no-resolvedAt', state: 'expired', expiresAt: NOW - 1000 }),
    ];
    expect(visibleOperatorAsks(list, NOW).map((a) => a.id)).toEqual(['pending-old', 'fresh', 'expired-no-resolvedAt']);
  });
});
