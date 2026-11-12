import { beforeEach, describe, expect, test } from 'vitest';
import type { LucyTurnEvent } from '../../shared/contracts/lucy-turn.js';
import { boardTask, fakeSource, scriptedModel, type ScriptedStep } from '../../core/lucy-operator/__fixtures__/scripted.js';
import { getLucyOperatorDiagnosticsSnapshot, resetLucyOperatorDiagnosticsForTest } from '../../core/lucy-operator/diagnostics.js';
import { LucyModelError } from '../../core/lucy-operator/model-port.js';
import type { LucyInteractionLog, LucyOperatorTurnRecordInput } from '../lucy-interaction-log.js';
import { CONVERSATION_TTL_MS, createLucyOperator, MAX_HISTORY_MESSAGES } from './service.js';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function setup(steps: ScriptedStep[]) {
  const model = scriptedModel(steps);
  const records: LucyOperatorTurnRecordInput[] = [];
  const log: LucyInteractionLog = {
    recordSaid: () => {},
    recordLiveTurn: () => {},
    recordOperatorTurn: (record) => { records.push(record); },
    recordUi: () => {},
    flush: async () => {},
  };
  let clock = 1_000_000;
  const service = createLucyOperator({
    model: model.port,
    modelName: 'test/model',
    source: fakeSource({ tasks: [boardTask({ id: 'aaaa1111', name: 'Bake-off report' })] }),
    log,
    now: () => clock,
    warn: () => {},
  });
  return { service, model, records, advance: (ms: number) => { clock += ms; } };
}

async function drain(events: AsyncIterable<LucyTurnEvent>): Promise<LucyTurnEvent[]> {
  const out: LucyTurnEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => resetLucyOperatorDiagnosticsForTest());

describe('createLucyOperator', () => {
  test('remembers the exchange: the next turn of the same conversation sends it, another conversation does not', async () => {
    const { service, model } = setup([{ text: 'It is waiting for your review.' }, { text: 'Yes.' }, { text: 'Hello.' }]);

    await drain(service.runTurn({ text: 'Is the report done?', conversationId: 'c1' }));
    await drain(service.runTurn({ text: 'Really?', conversationId: 'c1' }));
    await drain(service.runTurn({ text: 'Hi', conversationId: 'c2' }));

    expect(model.requests[1]!.messages.slice(1)).toEqual([
      { role: 'user', content: 'Is the report done?' },
      { role: 'assistant', content: 'It is waiting for your review.' },
      { role: 'user', content: 'Really?' },
    ]);
    expect(model.requests[2]!.messages.slice(1)).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  test('what a look-up returned is never remembered', async () => {
    const { service, model } = setup([{ calls: [{ name: 'read_board' }] }, { text: 'One task.' }, { text: 'Still one.' }]);
    await drain(service.runTurn({ text: 'How many?', conversationId: 'c1' }));
    await drain(service.runTurn({ text: 'And now?', conversationId: 'c1' }));
    expect(model.requests[2]!.messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('history is capped at ten exchanges', async () => {
    const { service, model } = setup(Array.from({ length: 13 }, (_, i) => ({ text: `answer ${i}` })));
    for (let i = 0; i < 13; i++) await drain(service.runTurn({ text: `question ${i}`, conversationId: 'c1' }));
    const history = model.requests[12]!.messages.slice(1, -1);
    expect(history).toHaveLength(MAX_HISTORY_MESSAGES);
    expect(history[0]).toEqual({ role: 'user', content: 'question 2' });
  });

  test('a conversation left silent for two hours starts afresh', async () => {
    const { service, model, advance } = setup([{ text: 'First.' }, { text: 'Second.' }]);
    await drain(service.runTurn({ text: 'one', conversationId: 'c1' }));
    advance(CONVERSATION_TTL_MS + 1);
    await drain(service.runTurn({ text: 'two', conversationId: 'c1' }));
    expect(model.requests[1]!.messages.slice(1)).toEqual([{ role: 'user', content: 'two' }]);
  });

  test('a turn that produced no reply is not remembered', async () => {
    const { service, model } = setup([{ fail: new LucyModelError('network', 'down') }, { text: 'Back.' }]);
    await drain(service.runTurn({ text: 'lost', conversationId: 'c1' }));
    await drain(service.runTurn({ text: 'again', conversationId: 'c1' }));
    expect(model.requests[1]!.messages.slice(1)).toEqual([{ role: 'user', content: 'again' }]);
  });

  test('the conversation is busy while a turn runs and free again after it ends', async () => {
    const { service } = setup([{ text: 'Hi.' }]);
    const turn = service.runTurn({ text: 'hi', conversationId: 'c1' });
    expect(service.isBusy('c1')).toBe(false); // nothing has started yet
    await turn.next();
    expect(service.isBusy('c1')).toBe(true);
    expect(service.isBusy('c2')).toBe(false);
    await drain(turn);
    expect(service.isBusy('c1')).toBe(false);
  });

  test('a second turn that slipped past the busy check ends at once and calls no model', async () => {
    const { service, model } = setup([{ text: 'Hi.' }]);
    const first = service.runTurn({ text: 'hi', conversationId: 'c1' });
    await first.next();
    const second = await drain(service.runTurn({ text: 'hi again', conversationId: 'c1' }));
    expect(second).toEqual([expect.objectContaining({ type: 'done', end: 'error', reason: 'Another turn of this conversation is still running.' })]);
    await drain(first);
    expect(model.requests).toHaveLength(1);
    expect(service.isBusy('c1')).toBe(false);
  });

  test.each([
    ['the model fails', [{ fail: new LucyModelError('http', 'boom', 500) }] as ScriptedStep[]],
    ['a cap is reached', [{ calls: [{ name: 'read_board' }], usage: { inputTokens: 50_000 } }] as ScriptedStep[]],
  ])('the conversation is released when %s', async (_label, steps) => {
    const { service } = setup(steps);
    await drain(service.runTurn({ text: 'hi', conversationId: 'c1' }));
    expect(service.isBusy('c1')).toBe(false);
  });

  test('a caller that stops reading releases the conversation, aborts nothing it should not, and the turn is recorded as aborted', async () => {
    const { service, records } = setup([{ text: ['Let me ', 'think'], calls: [{ name: 'read_board' }] }, { text: 'never read' }]);
    const turn = service.runTurn({ text: 'hi', conversationId: 'c1' });
    expect((await turn.next()).value).toEqual({ type: 'text', delta: 'Let me ' });
    await turn.return();

    expect(service.isBusy('c1')).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ end: 'aborted', asked: 'hi', answer: 'Let me ' });
    expect(getLucyOperatorDiagnosticsSnapshot().byEnd).toEqual({ aborted: 1 });
  });

  test('a caller that leaves right after the closing event still gets the real figures recorded', async () => {
    const { service, records } = setup([{ text: 'Hi.', usage: { inputTokens: 700, outputTokens: 5, costUsd: 0.0001 }, provider: 'Cohere' }]);
    const turn = service.runTurn({ text: 'hi', conversationId: 'c1' });
    // Read up to and including `done`, then walk away without draining the generator.
    for (;;) {
      const next = await turn.next();
      if (next.done || next.value.type === 'done') break;
    }
    await turn.return();
    expect(records[0]).toMatchObject({ end: 'answered', steps: 1, inputTokens: 700, costUsd: 0.0001, provider: 'Cohere' });
  });

  test('an aborted request releases the conversation', async () => {
    const { service } = setup([{ hang: true }]);
    const gone = new AbortController();
    const turn = drain(service.runTurn({ text: 'hi', conversationId: 'c1' }, gone.signal));
    setTimeout(() => gone.abort(), 5);
    const events = await turn;
    expect(events.at(-1)).toMatchObject({ type: 'done', end: 'aborted' });
    expect(service.isBusy('c1')).toBe(false);
  });

  test('records each turn: what was asked, what she said, the tool names, timings, tokens and cost', async () => {
    const { service, records } = setup([
      { calls: [{ name: 'read_task', args: { task: 'aaaa' } }], usage: { inputTokens: 1000, outputTokens: 30, costUsd: 0.0002 } },
      { text: 'It is waiting for your review.', usage: { inputTokens: 1400, outputTokens: 12, costUsd: 0.0001 }, provider: 'Cohere' },
    ]);
    await drain(service.runTurn({ text: 'Is the report done?', conversationId: 'conv-7' }));

    expect(records).toEqual([
      {
        conversationId: 'conv-7',
        end: 'answered',
        asked: 'Is the report done?',
        answer: 'It is waiting for your review.',
        tools: ['read_task'],
        model: 'test/model',
        provider: 'Cohere',
        steps: 2,
        firstTextMs: 0,
        totalMs: 0,
        inputTokens: 2400,
        outputTokens: 42,
        costUsd: 0.0003,
        askedWords: 4,
        answerWords: 6,
      },
    ]);
  });

  test('secrets are hidden in the record, in the question and in the answer', async () => {
    const { service, records } = setup([{ text: `The token is ${SECRET}.` }]);
    await drain(service.runTurn({ text: `Is ${SECRET} still valid?`, conversationId: 'c1' }));
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(records[0]!.asked).toContain('[redacted]');
    expect(records[0]!.answer).toContain('[redacted]');
  });

  test('counts turns apart from the helper model: by ending, with model calls, tokens and cost', async () => {
    const { service } = setup([
      { text: 'One.', usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0002 } },
      { fail: new LucyModelError('network', 'down') },
    ]);
    await drain(service.runTurn({ text: 'a', conversationId: 'c1' }));
    await drain(service.runTurn({ text: 'b', conversationId: 'c1' }));

    expect(getLucyOperatorDiagnosticsSnapshot(123)).toEqual({
      schemaVersion: 'lucy-operator-diagnostics.v1',
      generatedAt: 123,
      turns: 2,
      byEnd: { answered: 1, error: 1 },
      modelCalls: 2,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.0002,
      turnsWithCost: 1,
      averageTurnMs: 0,
      maxTurnMs: 0,
      averageFirstTextMs: 0,
    });
  });
});
