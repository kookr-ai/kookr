import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LucyActionProposalView } from '../../shared/contracts/lucy-action.js';
import {
  __resetLucyActionForTests,
  applyLucyActionOutcome,
  confirmLucyAction,
  declineLucyAction,
  dismissLucyActionResult,
  expireLucyAction,
  getLucyActionSnapshot,
  handleLucyAction,
} from './lucy-action.js';

const card: LucyActionProposalView = {
  id: 'a1', kind: 'reply', taskId: 't1', taskName: 'Billing migration', title: 'Reply to Billing migration', text: 'Rebase on main.',
  asked: 'tell it to rebase', readBack: 'I will type that.', expiresAt: 2_000_000,
};
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

beforeEach(() => __resetLucyActionForTests());

describe('the action card store', () => {
  test('a proposal from the socket becomes the card, with the conversation it belongs to', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    expect(getLucyActionSnapshot()).toEqual({ proposal: card, conversationId: 'c1', sending: false, error: null, result: null });
  });

  test('the outcome of the shown proposal closes the card and leaves one line that links to the task', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: null, result: { text: 'Sent', taskId: 't1' } });
    dismissLucyActionResult();
    expect(getLucyActionSnapshot().result).toBeNull();
  });

  test('an outcome for a proposal that is not shown changes nothing', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    applyLucyActionOutcome({ outcome: 'refused', proposalId: 'someone-elses', reason: 'no' });
    expireLucyAction('someone-elses');
    expect(getLucyActionSnapshot().proposal).toBe(card);
  });

  test('confirm and decline post only the conversation and the proposal id', async () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    const confirm = ok({ outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' });
    await confirmLucyAction(confirm);
    expect(vi.mocked(confirm).mock.calls[0]![0]).toBe('/api/lucy/action/confirm');
    expect(JSON.parse(String(vi.mocked(confirm).mock.calls[0]![1]!.body))).toEqual({ conversationId: 'c1', proposalId: 'a1' });
    // The route's own answer closes the card even if the broadcast was lost.
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: null, sending: false, result: { text: 'Sent' } });

    handleLucyAction({ conversationId: 'c1', proposal: { ...card, id: 'a2' } });
    const decline = ok({ outcome: 'declined', proposalId: 'a2' });
    await declineLucyAction(decline);
    expect(vi.mocked(decline).mock.calls[0]![0]).toBe('/api/lucy/action/decline');
    expect(getLucyActionSnapshot().result).toEqual({ text: 'Cancelled', taskId: 't1' });
  });

  test('with no card there is nothing to post', async () => {
    const fetcher = ok({});
    await confirmLucyAction(fetcher);
    await declineLucyAction(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('a refusal by the server, or no server, leaves the card and says the press failed', async () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    await confirmLucyAction(vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch);
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: card, sending: false, error: 'Lucy could not do that. Try again.' });
    await confirmLucyAction(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: card, sending: false, error: 'Lucy could not be reached. Try again.' });
  });
});
