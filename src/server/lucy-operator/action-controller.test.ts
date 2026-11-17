import { describe, expect, test } from 'vitest';
import { AgentInputRefusedError } from '../../core/choice-dialog-guard.js';
import { ACTION_PROPOSAL_TTL_MS } from '../../core/lucy-operator/action-proposal.js';
import type { LucyActionRequest } from '../../core/lucy-operator/action-tool.js';
import { ECHO_TAIL_MS } from '../../core/lucy-operator/launch-proposal.js';
import type { AnswerResult, DashboardAnswerInput, OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyActionRecordInput } from '../lucy-interaction-log.js';
import {
  createLucyActionController,
  type LucyActionAuditRow,
  type LucyActionBroadcast,
  type LucyActionTask,
  type LucyCloseResult,
} from './action-controller.js';

const START = 1_000_000;

const running = (overrides: Partial<LucyActionTask> = {}): LucyActionTask => ({
  id: 'task-1', name: 'Billing migration', project: 'kookr', status: 'inProgress', saysFinished: false, liveSessionId: 'kookr-s1', ...overrides,
});
const finished = (overrides: Partial<LucyActionTask> = {}): LucyActionTask => running({ saysFinished: true, ...overrides });
const ask = (overrides: Partial<OperatorAskView> = {}): OperatorAskView => ({
  id: 'ask000000001', taskId: 'task-1', taskName: 'Billing migration', taskEnded: false,
  question: 'Which database should the migration use?', options: ['Postgres', 'SQLite'], allowText: false,
  state: 'pending', createdAt: START - 60_000, expiresAt: START + 30 * 60_000, ...overrides,
});

const ANSWER: LucyActionRequest = { kind: 'answer', askId: 'ask000000001', optionIndex: 0 };
const FREE_ANSWER: LucyActionRequest = { kind: 'answer', askId: 'ask000000001' };
const REPLY: LucyActionRequest = { kind: 'reply', taskId: 'task-1' };
const CLOSE: LucyActionRequest = { kind: 'close', taskId: 'task-1' };

function setup(options: {
  task?: LucyActionTask | null;
  asks?: OperatorAskView[];
  /** What the writer returns; default a clear reply text. */
  writer?: string;
  writerFails?: boolean;
  answer?: AnswerResult;
  reply?: 'refused' | 'fails';
  close?: LucyCloseResult;
  without?: Array<'answerAsk' | 'sendReply' | 'closeTask'>;
} = {}) {
  let clock = START;
  let ids = 0;
  let task: LucyActionTask | undefined = options.task === null ? undefined : options.task ?? running();
  let asks: OperatorAskView[] = options.asks ?? [ask()];
  const writerCalls: Array<{ system: string; operatorWords: readonly string[] }> = [];
  const answers: DashboardAnswerInput[] = [];
  const replies: Array<{ sessionId: string; text: string }> = [];
  const closes: string[] = [];
  const audits: LucyActionAuditRow[] = [];
  const logs: LucyActionRecordInput[] = [];
  const messages: LucyActionBroadcast[] = [];
  let launchCardsDropped = 0;
  const off = new Set(options.without ?? []);
  const controller = createLucyActionController({
    getTask: (taskId) => (task && task.id === taskId ? task : undefined),
    getAsks: () => asks,
    writeText: async (request) => {
      writerCalls.push({ system: request.system, operatorWords: request.operatorWords });
      if (options.writerFails) throw new Error('provider said sk-or-v1-secretsecretsecret');
      return options.writer ?? '{"text":"Rebase on main and run the tests again."}';
    },
    ...(off.has('answerAsk') ? {} : {
      answerAsk: async (input: DashboardAnswerInput) => {
        answers.push(input);
        return options.answer ?? ({ ok: true, ask: {} } as unknown as AnswerResult);
      },
    }),
    ...(off.has('sendReply') ? {} : {
      sendReply: async (sessionId: string, text: string) => {
        if (options.reply === 'refused') throw new AgentInputRefusedError(sessionId);
        if (options.reply === 'fails') throw new Error('tmux: no such session /home/jean/secret');
        replies.push({ sessionId, text });
      },
    }),
    ...(off.has('closeTask') ? {} : {
      closeTask: async (taskId: string) => { closes.push(taskId); return options.close ?? { ok: true }; },
    }),
    audit: (row) => { audits.push(row); },
    emit: (message) => messages.push(message),
    onHeld: () => { launchCardsDropped += 1; },
    log: { recordSaid: () => {}, recordLiveTurn: () => {}, recordUi: () => {}, flush: async () => {}, recordAction: (r) => { logs.push(r); } },
    now: () => clock,
    newId: () => `a${++ids}`,
    warn: () => {},
  });
  return {
    controller, writerCalls, answers, replies, closes, audits, logs, messages,
    launchCardsDropped: () => launchCardsDropped,
    setTask: (next: LucyActionTask | undefined) => { task = next; },
    setAsks: (next: OperatorAskView[]) => { asks = next; },
    advance: (ms: number) => { clock += ms; },
    propose: (request: LucyActionRequest, words: readonly string[] = ['tell the billing task to rebase on main and rerun the tests'], conversationId = 'c1') =>
      controller.propose({ conversationId, request, operatorWords: words }),
  };
}

/** Nothing reached a task or a question. */
function nothingDone(t: ReturnType<typeof setup>): void {
  expect(t.answers).toEqual([]);
  expect(t.replies).toEqual([]);
  expect(t.closes).toEqual([]);
}

describe('propose an answer', () => {
  test('a listed choice becomes a held card that names the task, the question and the choice; nothing is sent', async () => {
    const t = setup();
    const result = await t.propose(ANSWER, ['answer the billing question with postgres']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal).toEqual({
      id: 'a1', kind: 'answer', taskId: 'task-1', taskName: 'Billing migration', title: 'Answer Billing migration',
      askId: 'ask000000001', question: 'Which database should the migration use?', answer: { kind: 'option', index: 0, label: 'Postgres' },
      asked: 'answer the billing question with postgres', expiresAt: START + ACTION_PROPOSAL_TTL_MS,
      readBack: 'I will give the choice "Postgres" as your answer to the question from "Billing migration". Say go to send.',
    });
    expect(result.say).toBe(result.proposal.readBack);
    nothingDone(t);
    // A choice needs no text, so no writer is called.
    expect(t.writerCalls).toEqual([]);
    expect(t.controller.pending('c1')?.id).toBe('a1');
    expect(t.messages).toEqual([{ type: 'lucy_action', conversationId: 'c1', proposal: result.proposal }]);
    expect(t.logs).toEqual([expect.objectContaining({ event: 'proposed', action: 'answer', proposalId: 'a1', taskId: 'task-1', askId: 'ask000000001', choice: 'option:0' })]);
  });

  test('a choice the question does not have is refused with a question, and no card is made', async () => {
    const t = setup();
    const result = await t.propose({ kind: 'answer', askId: 'ask000000001', optionIndex: 5 });
    expect(result).toMatchObject({ ok: false, say: 'That question does not have that choice. Which one do you want?' });
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.messages).toEqual([]);
  });

  test.each([
    ['already answered', ask({ state: 'answered' })],
    ['expired by the clock', ask({ expiresAt: START - 1 })],
  ])('a question that is %s gets no card', async (_label, record) => {
    const t = setup({ asks: [record] });
    expect(await t.propose(ANSWER)).toMatchObject({ ok: false, say: 'That question is not waiting any more.' });
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('an unknown question id gets no card', async () => {
    const t = setup();
    expect(await t.propose({ kind: 'answer', askId: 'nope', optionIndex: 0 })).toMatchObject({ ok: false, why: 'question not waiting' });
  });

  test('the operator\'s own words answer a question that takes free text, written by the writer from those words alone', async () => {
    const t = setup({ asks: [ask({ allowText: true })], writer: '{"text":"Use the staging database."}' });
    const result = await t.propose(FREE_ANSWER, ['what is waiting?', 'answer the billing question: use the staging database']);
    expect(result).toMatchObject({ ok: true, proposal: { kind: 'answer', answer: { kind: 'text', text: 'Use the staging database.' } } });
    expect(t.writerCalls).toHaveLength(1);
    expect(t.writerCalls[0]!.operatorWords).toEqual(['what is waiting?', 'answer the billing question: use the staging database']);
    // The writer is told nothing about the question, its choices or the task.
    expect(t.writerCalls[0]!.system).not.toMatch(/Postgres|SQLite|Billing|Which database/);
  });

  test('free text for a question that takes choices only is refused', async () => {
    const t = setup();
    expect(await t.propose(FREE_ANSWER)).toMatchObject({ ok: false, say: 'That question takes one of its choices only. Which one do you want?' });
    expect(t.writerCalls).toEqual([]);
  });

  test('when the writer cannot tell what the answer is, she asks instead of making a card', async () => {
    const t = setup({ asks: [ask({ allowText: true })], writer: '{"ambiguous":"What should I answer?"}' });
    expect(await t.propose(FREE_ANSWER, ['answer that question'])).toMatchObject({ ok: false, say: 'What should I answer?' });
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('a question whose task is gone can still be answered, and the card names it from the question', async () => {
    const t = setup({ task: null });
    const result = await t.propose(ANSWER);
    expect(result).toMatchObject({ ok: true, proposal: { taskName: 'Billing migration', title: 'Answer Billing migration' } });
  });

  test('with no ask service she says so', async () => {
    const t = setup({ without: ['answerAsk'] });
    expect(await t.propose(ANSWER)).toMatchObject({ ok: false, say: 'Answering questions is not available on this server.' });
  });
});

describe('propose a reply', () => {
  test('the card carries the whole text that will be typed, written from the operator\'s words', async () => {
    const t = setup();
    const result = await t.propose(REPLY);
    expect(result).toMatchObject({
      ok: true,
      proposal: { kind: 'reply', taskId: 'task-1', title: 'Reply to Billing migration', text: 'Rebase on main and run the tests again.' },
      say: 'I will type "Rebase on main and run the tests again" into "Billing migration". Say go to send.',
    });
    nothingDone(t);
    expect(t.writerCalls[0]!.operatorWords).toEqual(['tell the billing task to rebase on main and rerun the tests']);
    expect(t.writerCalls[0]!.system).not.toContain('Billing');
  });

  test('a key in the operator\'s words does not reach the writer', async () => {
    const t = setup();
    await t.propose(REPLY, ['tell it my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789']);
    expect(JSON.stringify(t.writerCalls)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  test.each([
    ['an unclear request', '{"ambiguous":"What should I tell it?"}', 'What should I tell it?'],
    ['an unreadable draft', 'Sure! Here is the message: rebase', 'I could not make that out. Could you say it again?'],
    ['a draft with extra fields', '{"text":"x","task":"other"}', 'I could not make that out. Could you say it again?'],
    ['an empty text', '{"text":"   "}', 'What should I tell it?'],
    ['a text that is too long to send whole', JSON.stringify({ text: 'x'.repeat(1501) }), 'What should I tell it?'],
  ])('%s gets a question and no card', async (_label, writer, say) => {
    const t = setup({ writer });
    expect(await t.propose(REPLY)).toMatchObject({ ok: false, say });
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('a writer failure is reported without the provider\'s words', async () => {
    const t = setup({ writerFails: true });
    const result = await t.propose(REPLY);
    expect(result).toMatchObject({ ok: false, say: 'I could not prepare that just now. Please try again.' });
    expect(JSON.stringify(result)).not.toContain('sk-or');
  });

  test('line breaks and control characters never reach the text that is typed', async () => {
    const t = setup({ writer: JSON.stringify({ text: 'Rebase on main.\nrm -rf /\u0007 then stop' }) });
    const result = await t.propose(REPLY);
    expect(result).toMatchObject({ ok: true, proposal: { text: 'Rebase on main. rm -rf / then stop' } });
  });

  test.each([
    ['has ended', running({ status: 'completed', liveSessionId: undefined })],
    ['has no live session', running({ liveSessionId: undefined })],
  ])('a task that %s gets no card and no writer call', async (_label, task) => {
    const t = setup({ task });
    expect(await t.propose(REPLY)).toMatchObject({ ok: false, say: '"Billing migration" is not running, so there is nothing to type a reply into.' });
    expect(t.writerCalls).toEqual([]);
  });

  test('a task that no longer exists gets no card', async () => {
    const t = setup({ task: null });
    expect(await t.propose(REPLY)).toMatchObject({ ok: false, say: 'I cannot find that task any more.' });
  });
});

describe('propose a close', () => {
  test('a task that says it is finished gets a card; nothing is closed', async () => {
    const t = setup({ task: finished() });
    const result = await t.propose(CLOSE, ['close the billing task']);
    expect(result).toMatchObject({
      ok: true,
      proposal: { kind: 'close', taskId: 'task-1', title: 'Close Billing migration', asked: 'close the billing task' },
      say: 'I will close "Billing migration", which says it is finished. Say go to close the task.',
    });
    nothingDone(t);
    expect(t.writerCalls).toEqual([]);
  });

  test.each([
    ['is still working', running(), '"Billing migration" is still working: it has not said it is finished, so I will not close it.'],
    ['stopped without saying it finished', running({ status: 'terminated', liveSessionId: undefined }), '"Billing migration" stopped without saying it was finished, so I will not close it.'],
    ['is already closed', finished({ status: 'completed' }), '"Billing migration" is already closed.'],
    ['has not started', finished({ status: 'pending' }), '"Billing migration" has not started yet, so there is nothing to close.'],
    ['is a loop', finished({ loop: true }), '"Billing migration" runs as a loop, and I cannot close a loop.'],
  ])('a task that %s gets a sentence saying so, and no card', async (_label, task, say) => {
    const t = setup({ task });
    expect(await t.propose(CLOSE)).toMatchObject({ ok: false, say });
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('a task with no name is described, not named', async () => {
    const t = setup({ task: finished({ name: undefined }) });
    expect(await t.propose(CLOSE)).toMatchObject({ ok: true, proposal: { title: 'Close an unnamed task in kookr' }, say: 'I will close an unnamed task in kookr, which says it is finished. Say go to close the task.' });
  });
});

describe('confirm', () => {
  test('a click sends the chosen choice once, through the audited answer entry point', async () => {
    const t = setup();
    await t.propose(ANSWER);
    const outcome = await t.controller.confirm('c1', 'a1', 'click');
    expect(outcome).toEqual({ outcome: 'done', proposalId: 'a1', kind: 'answer', taskId: 'task-1' });
    expect(t.answers).toEqual([{ askId: 'ask000000001', optionIndex: 0 }]);
    expect(t.audits).toEqual([{ action: 'answer', proposalId: 'a1', via: 'click', taskId: 'task-1', askId: 'ask000000001', choice: 'option:0', outcome: 'done' }]);
    expect(t.messages.at(-1)).toEqual({ type: 'lucy_action', conversationId: 'c1', outcome });
    // Used once: a second click finds nothing.
    expect(await t.controller.confirm('c1', 'a1', 'click')).toEqual({ outcome: 'unknown', proposalId: 'a1' });
    expect(t.answers).toHaveLength(1);
  });

  test('a free-text answer is sent as the text on the card', async () => {
    const t = setup({ asks: [ask({ allowText: true })], writer: '{"text":"Use the staging database."}' });
    await t.propose(FREE_ANSWER);
    await t.controller.confirm('c1', 'a1', 'click');
    expect(t.answers).toEqual([{ askId: 'ask000000001', text: 'Use the staging database.' }]);
    // The audit row says a text was sent, never the text.
    expect(t.audits).toEqual([expect.objectContaining({ choice: 'text', outcome: 'done' })]);
    expect(JSON.stringify(t.audits)).not.toContain('staging');
  });

  test('an answer recorded for a task that has ended says it was not typed', async () => {
    const t = setup({ answer: { ok: true, ask: {}, notTyped: 'The task had ended, so it was not typed into it.' } as unknown as AnswerResult });
    await t.propose(ANSWER);
    const handled = await t.controller.handleReply('c1', 'go');
    expect(handled).toMatchObject({ handled: true, say: 'Answer recorded. The task had ended, so it was not typed into it.' });
  });

  test('a click types the reply into the session the card was made for', async () => {
    const t = setup();
    await t.propose(REPLY);
    const outcome = await t.controller.confirm('c1', 'a1', 'click');
    expect(outcome).toEqual({ outcome: 'done', proposalId: 'a1', kind: 'reply', taskId: 'task-1' });
    expect(t.replies).toEqual([{ sessionId: 'kookr-s1', text: 'Rebase on main and run the tests again.' }]);
    expect(t.audits).toEqual([{ action: 'reply', proposalId: 'a1', via: 'click', taskId: 'task-1', outcome: 'done' }]);
    expect(t.logs.at(-1)).toMatchObject({ event: 'done', action: 'reply', via: 'click', text: 'Rebase on main and run the tests again.' });
  });

  test('a click closes the task', async () => {
    const t = setup({ task: finished() });
    await t.propose(CLOSE);
    expect(await t.controller.confirm('c1', 'a1', 'click')).toEqual({ outcome: 'done', proposalId: 'a1', kind: 'close', taskId: 'task-1' });
    expect(t.closes).toEqual(['task-1']);
    expect(t.audits).toEqual([{ action: 'close', proposalId: 'a1', via: 'click', taskId: 'task-1', outcome: 'done' }]);
  });

  test.each(['go', 'Go.', 'yes', 'send it', 'do it'])('the whole sentence "%s", typed, confirms', async (word) => {
    const t = setup();
    await t.propose(REPLY);
    const handled = await t.controller.handleReply('c1', word, { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, say: 'Sent.', outcome: { outcome: 'done' } });
    expect(t.replies).toHaveLength(1);
    expect(t.logs.at(-1)).toMatchObject({ event: 'done', via: 'typed' });
  });

  test('a spoken "go" after the read-back has ended confirms', async () => {
    const t = setup({ task: finished() });
    await t.propose(CLOSE);
    t.advance(20_000);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: START + 19_000 });
    expect(handled).toMatchObject({ handled: true, say: 'Closed.' });
    expect(t.closes).toEqual(['task-1']);
    expect(t.logs.at(-1)).toMatchObject({ via: 'spoken' });
  });

  test('"launch it" belongs to a launch card: here it drops the card instead of confirming', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(await t.controller.handleReply('c1', 'launch it')).toEqual({ handled: false });
    nothingDone(t);
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('"go and also delete the logs" is not a confirmation: it drops the card and is a new request', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(await t.controller.handleReply('c1', 'go and also delete the logs')).toEqual({ handled: false });
    nothingDone(t);
    expect(t.messages.at(-1)).toEqual({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'declined', proposalId: 'a1' } });
  });

  test('"go" from another conversation confirms the one card on screen', async () => {
    const t = setup();
    await t.propose(REPLY, undefined, 'typed-1');
    const handled = await t.controller.handleReply('live-2', 'go');
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'done' } });
    expect(t.replies).toHaveLength(1);
  });

  test('"go" with nothing pending is not handled', async () => {
    const t = setup();
    expect(await t.controller.handleReply('c1', 'go')).toEqual({ handled: false });
  });
});

describe('the echo rule (shared with the launch card)', () => {
  test('spoken words the browser saw start during the read-back are ignored: nothing sent, the card stays', async () => {
    const t = setup();
    await t.propose(REPLY);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', overlapsReadBack: true });
    expect(handled).toEqual({ handled: true, say: '', ignored: true });
    nothingDone(t);
    expect(t.controller.pending('c1')?.id).toBe('a1');
    expect(t.logs.at(-1)).toMatchObject({ event: 'ignored', reason: 'began during the read-back' });
  });

  test('spoken words that began before her estimated read-back ended are ignored too', async () => {
    const t = setup();
    await t.propose(REPLY);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: START + 500 });
    expect(handled).toMatchObject({ handled: true, ignored: true });
    nothingDone(t);
  });

  test('her voice running longer than estimated moves the guard', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.controller.noteSpeaking('c1', START + 30_000);
    t.advance(31_000);
    // Began right at the reported end: still inside the tail in which an echo can arrive.
    expect(await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: START + 30_000 + ECHO_TAIL_MS - 1 })).toMatchObject({ ignored: true });
    nothingDone(t);
    expect(await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: START + 30_000 + ECHO_TAIL_MS })).toMatchObject({ handled: true, outcome: { outcome: 'done' } });
  });

  test('a spoken "no" during the read-back is still heard', async () => {
    const t = setup();
    await t.propose(REPLY);
    const handled = await t.controller.handleReply('c1', 'cancel', { input: 'voice', overlapsReadBack: true });
    expect(handled).toMatchObject({ handled: true, say: 'Okay, I will not do it.', outcome: { outcome: 'declined' } });
    nothingDone(t);
  });

  test('a typed "go" is never taken for an echo', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(await t.controller.handleReply('c1', 'go', { input: 'typed', overlapsReadBack: true })).toMatchObject({ outcome: { outcome: 'done' } });
  });
});

describe('decline and expiry', () => {
  test('"no" drops the card and nothing is done', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(await t.controller.handleReply('c1', 'no')).toMatchObject({ handled: true, say: 'Okay, I will not do it.', outcome: { outcome: 'declined', proposalId: 'a1' } });
    nothingDone(t);
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.audits).toEqual([]);
  });

  test('the decline route drops it; a second decline finds nothing', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(t.controller.decline('c1', 'a1')).toEqual({ outcome: 'declined', proposalId: 'a1' });
    expect(t.controller.decline('c1', 'a1')).toEqual({ outcome: 'unknown', proposalId: 'a1' });
    expect(t.logs.map((l) => l.event)).toEqual(['proposed', 'declined']);
  });

  test('a card can be confirmed for two minutes and not after', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.advance(ACTION_PROPOSAL_TTL_MS - 1);
    expect(t.controller.pending('c1')?.id).toBe('a1');
    t.advance(1);
    expect(await t.controller.confirm('c1', 'a1', 'click')).toEqual({ outcome: 'expired', proposalId: 'a1' });
    nothingDone(t);
    expect(t.messages.at(-1)).toEqual({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'expired', proposalId: 'a1' } });
    expect(t.logs.at(-1)).toMatchObject({ event: 'expired' });
  });

  test('"go" after the card ran out says it timed out and does nothing', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.advance(ACTION_PROPOSAL_TTL_MS + 1);
    expect(await t.controller.handleReply('c1', 'go')).toMatchObject({ handled: true, say: 'That timed out, so I did nothing. Ask me again if you still want it.', outcome: { outcome: 'expired' } });
    nothingDone(t);
  });

  test('the wrong proposal id confirms nothing', async () => {
    const t = setup();
    await t.propose(REPLY);
    expect(await t.controller.confirm('c1', 'someone-elses', 'click')).toEqual({ outcome: 'unknown', proposalId: 'someone-elses' });
    expect(await t.controller.confirm('other-conversation', 'a1', 'click')).toEqual({ outcome: 'unknown', proposalId: 'a1' });
    nothingDone(t);
    expect(t.controller.pending('c1')?.id).toBe('a1');
  });

  test('closing the conversation drops its card', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.controller.closeConversation('c1');
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.messages.at(-1)).toEqual({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'cancelled', proposalId: 'a1' } });
    expect(await t.controller.handleReply('c1', 'go')).toEqual({ handled: false });
  });
});

describe('what changed between the card and the confirmation', () => {
  test('the question was answered elsewhere: nothing is sent, and she says why', async () => {
    const t = setup();
    await t.propose(ANSWER);
    t.setAsks([ask({ state: 'answered' })]);
    const outcome = await t.controller.confirm('c1', 'a1', 'click');
    expect(outcome).toEqual({ outcome: 'refused', proposalId: 'a1', reason: 'That question was already answered, so I did not send anything.' });
    expect(t.answers).toEqual([]);
    expect(t.audits).toEqual([expect.objectContaining({ action: 'answer', outcome: 'refused', reason: outcome.outcome === 'refused' ? outcome.reason : '' })]);
  });

  test('the question is gone or expired: nothing is sent', async () => {
    const gone = setup();
    await gone.propose(ANSWER);
    gone.setAsks([]);
    expect(await gone.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: 'That question is not waiting any more, so I did not send anything.' });
    const expired = setup({ asks: [ask({ expiresAt: START + 10_000 })] });
    await expired.propose(ANSWER);
    expired.advance(10_000);
    expect(await expired.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused' });
    expect(gone.answers).toEqual([]);
    expect(expired.answers).toEqual([]);
  });

  test.each([
    ['its choices were reordered', ask({ options: ['SQLite', 'Postgres'] })],
    ['a choice was reworded', ask({ options: ['Postgres 16', 'SQLite'] })],
    ['the question was reworded', ask({ question: 'Delete the production database?' })],
  ])('the same question id but %s: the card no longer tells the truth, so nothing is sent', async (_label, changed) => {
    const t = setup();
    await t.propose(ANSWER);
    t.setAsks([changed]);
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: 'That question changed since I prepared the answer, so I did not send anything. Ask me again.' });
    expect(t.answers).toEqual([]);
  });

  test('the ask service refusing the answer (first answer wins) is reported, not passed off as sent', async () => {
    const t = setup({ answer: { ok: false, reason: 'already_answered' } });
    await t.propose(ANSWER);
    const handled = await t.controller.handleReply('c1', 'go');
    expect(handled).toMatchObject({ say: 'That question was already answered, so I did not send anything.', outcome: { outcome: 'refused' } });
  });

  test('the task ended before the reply was confirmed: nothing is typed', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.setTask(running({ status: 'completed', liveSessionId: undefined }));
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: '"Billing migration" is not running any more, so I did not send anything.' });
    expect(t.replies).toEqual([]);
  });

  test('the session is gone: nothing is typed', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.setTask(running({ liveSessionId: undefined }));
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: '"Billing migration" is not running any more, so I did not send anything.' });
    expect(t.replies).toEqual([]);
  });

  test('the task was relaunched in a new session: the reply is not typed into a conversation that never saw the context', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.setTask(running({ liveSessionId: 'kookr-s2' }));
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: '"Billing migration" was restarted since I prepared that, so I did not send anything. Ask me again.' });
    expect(t.replies).toEqual([]);
  });

  test('the task was deleted: nothing is done', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.setTask(undefined);
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: 'That task is gone, so I did nothing.' });
  });

  test('the task went back to work before the close was confirmed: it is not closed', async () => {
    const t = setup({ task: finished() });
    await t.propose(CLOSE);
    t.setTask(running());
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: '"Billing migration" is still working: it has not said it is finished, so I will not close it.' });
    expect(t.closes).toEqual([]);
  });

  test('the task was closed by someone else: it is not closed again', async () => {
    const t = setup({ task: finished() });
    await t.propose(CLOSE);
    t.setTask(finished({ status: 'completed' }));
    expect(await t.controller.confirm('c1', 'a1', 'click')).toMatchObject({ outcome: 'refused', reason: '"Billing migration" is already closed.' });
    expect(t.closes).toEqual([]);
  });

  test('a close the server refuses is reported with its reason', async () => {
    const t = setup({ task: finished(), close: { ok: false, reason: 'That task was already closed.' } });
    await t.propose(CLOSE);
    expect(await t.controller.confirm('c1', 'a1', 'click')).toEqual({ outcome: 'refused', proposalId: 'a1', reason: 'That task was already closed.' });
  });
});

describe('a reply the task cannot take', () => {
  test('a task showing a choice prompt refuses typed text: she says so in plain words', async () => {
    const t = setup({ reply: 'refused' });
    await t.propose(REPLY);
    const handled = await t.controller.handleReply('c1', 'go');
    expect(handled).toMatchObject({
      handled: true,
      say: '"Billing migration" is showing a choice prompt, so I did not type anything. Answer that on the task.',
      outcome: { outcome: 'refused' },
    });
    expect(t.audits).toEqual([expect.objectContaining({ action: 'reply', outcome: 'refused' })]);
    // The error's own text (session ids, CLI hints) is never spoken.
    expect(handled.handled && handled.say).not.toMatch(/kookr-s1|kookr peek/);
  });

  test('any other failure is reported without the error text', async () => {
    const t = setup({ reply: 'fails' });
    await t.propose(REPLY);
    const outcome = await t.controller.confirm('c1', 'a1', 'click');
    expect(outcome).toEqual({ outcome: 'refused', proposalId: 'a1', reason: 'Kookr could not type that into the task.' });
    expect(JSON.stringify(t.messages)).not.toContain('secret');
  });
});

describe('one card at a time', () => {
  test('a new card replaces the old one, in this conversation or another, and tells the launch holder to clear its own', async () => {
    const t = setup({ task: finished() });
    await t.propose(REPLY, undefined, 'c1');
    const second = await t.propose(CLOSE, ['close it'], 'c2');
    expect(second.ok).toBe(true);
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.controller.pending('c2')?.id).toBe('a2');
    expect(t.messages).toContainEqual({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'cancelled', proposalId: 'a1' } });
    // Once per card made: the launch controller drops its pending card each time.
    expect(t.launchCardsDropped()).toBe(2);
    // "go" now means the close card, not the reply.
    await t.controller.handleReply('c1', 'go');
    expect(t.replies).toEqual([]);
    expect(t.closes).toEqual(['task-1']);
  });

  test('a request that makes no card leaves the old card alone', async () => {
    const t = setup();
    await t.propose(REPLY);
    await t.propose(CLOSE);
    expect(t.controller.pending('c1')?.id).toBe('a1');
    expect(t.launchCardsDropped()).toBe(1);
  });

  test('a launch card taking the screen drops the action card, which can then not be confirmed', async () => {
    const t = setup();
    await t.propose(REPLY);
    t.controller.dropPending();
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.messages.at(-1)).toEqual({ type: 'lucy_action', conversationId: 'c1', outcome: { outcome: 'cancelled', proposalId: 'a1' } });
    expect(await t.controller.confirm('c1', 'a1', 'click')).toEqual({ outcome: 'unknown', proposalId: 'a1' });
    nothingDone(t);
  });
});

describe('nothing happens by itself', () => {
  test('a held card is never carried out by the passing of time, only dropped', async () => {
    // The controller has no timer and reads no autonomy level: there is no path from a card to an action
    // other than `confirm`. (That a hands-off install still asks is shown end to end in action-turn.test.ts.)
    const t = setup({ task: finished() });
    await t.propose(CLOSE);
    t.advance(60 * 60_000);
    expect(t.controller.pending('c1')).toBeUndefined();
    nothingDone(t);
    expect(t.audits).toEqual([]);
  });
});
