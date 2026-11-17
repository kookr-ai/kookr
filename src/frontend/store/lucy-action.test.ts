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
import { __resetLucyConversationForTests, getConversationEntries } from './lucy-conversation.js';

const card: LucyActionProposalView = {
  id: 'a1', kind: 'reply', taskId: 't1', taskName: 'Billing migration', title: 'Reply to Billing migration', text: 'Rebase on main.',
  asked: 'tell it to rebase', readBack: 'I will type that.', expiresAt: 2_000_000,
};
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

beforeEach(() => {
  __resetLucyActionForTests();
  __resetLucyConversationForTests();
});

const thread = () => getConversationEntries().map((entry) => [entry.id, entry.text, 'started' in entry ? entry.started : null, 'taskId' in entry ? entry.taskId ?? null : null]);

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
    // Still within its time (the fixture's own expiresAt is long past, which would end the card after a failed press).
    const live = { ...card, expiresAt: Date.now() + 60_000 };
    handleLucyAction({ conversationId: 'c1', proposal: live });
    await confirmLucyAction(vi.fn(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch);
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: live, sending: false, error: 'Lucy could not do that. Try again.' });
    await confirmLucyAction(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: live, sending: false, error: 'Lucy could not be reached. Try again.' });
  });

  test('an expiry that fires while a press is in flight does nothing; the server answer then closes the card', async () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    let answer: (response: Response) => void = () => undefined;
    const pending = vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })) as unknown as typeof fetch;
    const press = confirmLucyAction(pending);
    expect(getLucyActionSnapshot().sending).toBe(true);
    expireLucyAction('a1');
    expect(getLucyActionSnapshot()).toMatchObject({ proposal: card, sending: true });
    expect(thread()).toEqual([]);
    answer(new Response(JSON.stringify({ outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' }), { status: 200 }));
    await press;
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: Sent', true, 't1']]);
  });

  test('a press that fails after the card is due ends it as timed out', async () => {
    handleLucyAction({ conversationId: 'c1', proposal: { ...card, expiresAt: Date.now() - 1 } });
    await confirmLucyAction(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(getLucyActionSnapshot().proposal).toBeNull();
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: That request timed out', false, 't1']]);
  });

  test('the server outcome for a card this tab already timed out replaces the local timed out line', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    expireLucyAction('a1');
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: That request timed out', false, 't1']]);
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: Sent', true, 't1']]);
    // Told again, it stays one line.
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    expect(thread()).toHaveLength(1);
  });

  test('the server saying expired for a card this tab timed out keeps the one line', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    expireLucyAction('a1');
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'expired', proposalId: 'a1' } });
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: That request timed out', false, 't1']]);
  });

  test('two tabs writing the outcome for one proposal produce one thread entry', () => {
    handleLucyAction({ conversationId: 'c1', proposal: card });
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    // The same card shown again and answered again, as another tab's copy of the broadcast would do.
    handleLucyAction({ conversationId: 'c1', proposal: card });
    handleLucyAction({ conversationId: 'c1', outcome: { outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 't1' } });
    expect(thread()).toEqual([['action-a1', 'Reply to Billing migration: Sent', true, 't1']]);
  });
});
