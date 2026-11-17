import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

const mocks = vi.hoisted(() => ({
  openEarsTurn: vi.fn(),
  transcribeOnce: vi.fn(),
  streamBasetenChat: vi.fn(),
  synthesize: vi.fn(),
}));
vi.mock('../../adapters/lucy-live/ears-client.js', () => ({ openEarsTurn: mocks.openEarsTurn, transcribeOnce: mocks.transcribeOnce }));
// Keep the real BasetenStreamError: the service tells a refused request (HTTP 400) by its class.
vi.mock('../../adapters/llm/baseten-stream.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../adapters/llm/baseten-stream.js')>(),
  streamBasetenChat: mocks.streamBasetenChat,
}));
vi.mock('../../adapters/tts-client.js', () => ({ synthesize: mocks.synthesize }));

import { createLucyLive, type LucyLiveDeps } from './create-lucy-live.js';
import { BasetenStreamError } from '../../adapters/llm/baseten-stream.js';
import type { LucyLiveConfig } from './config.js';
import type { LucyInteractionLog, LucyLiveTurnRecordInput } from '../lucy-interaction-log.js';
import type { SileroVad } from '../../adapters/lucy-live/silero-vad.js';
import type { LucyOperatorService } from '../lucy-operator/service.js';
import type { LucyTurnEvent, LucyTurnRequest } from '../../shared/contracts/lucy-turn.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';

const SECRET = 'sk-1234567890abcdefghijklmnop';
const CONFIG: LucyLiveConfig = {
  earsUrl: 'ws://ears',
  ttsUrl: 'http://tts',
  brain: { apiKey: 'k', model: 'm', baseUrl: 'http://brain' },
};

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  json(message: object): void { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  audio(bytes: number): void { this.emit('message', Buffer.alloc(bytes), true); }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function setup(opts: { vad?: SileroVad | null; getOperator?: () => LucyOperatorService | undefined; extraDeps?: Partial<LucyLiveDeps> } = {}) {
  const records: LucyLiveTurnRecordInput[] = [];
  const log: LucyInteractionLog = {
    recordSaid: () => {}, recordUi: () => {}, flush: async () => {},
    recordLiveTurn: (r) => { records.push(r); },
  };
  const ears = { append: vi.fn(), finish: vi.fn(async () => `my key is ${SECRET} ok`), abort: vi.fn() };
  mocks.openEarsTurn.mockReturnValue(ears);
  mocks.transcribeOnce.mockResolvedValue('');
  mocks.synthesize.mockResolvedValue({ audioBase64: 'V0FW', durationMs: 321, generationTimeMs: 1 });
  mocks.streamBasetenChat.mockImplementation(async function* () { yield 'Two tasks are running. '; });
  const warnings: string[] = [];
  const service = createLucyLive({
    config: CONFIG,
    vad: opts.vad,
    getTasks: () => [],
    getVoice: () => 'af_test',
    getOperator: opts.getOperator,
    log,
    warn: (m) => { warnings.push(m); },
    now: () => 1000,
    ...opts.extraDeps,
  });
  const connect = (): FakeSocket => {
    const socket = new FakeSocket();
    service.handleConnection(socket as unknown as WebSocket, {} as never);
    return socket;
  };
  const ws = connect();
  return { ws, records, ears, warnings, connect };
}

async function runTurn(ws: FakeSocket, turnId = 't1'): Promise<void> {
  ws.json({ type: 'hello', language: 'en' });
  ws.json({ type: 'speech_start', turnId });
  ws.audio(3200);
  ws.json({ type: 'speech_end', turnId });
  await tick(); await tick(); await tick();
}

/** The reasoning setting each call to the helper model asked for, in order. */
function reasoningEfforts(): unknown[] {
  return mocks.streamBasetenChat.mock.calls.map((c) => (c[1] as { reasoningEffort?: unknown }).reasoningEffort);
}

describe('createLucyLive', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('logs the transcript with secrets redacted and never the raw token', async () => {
    const { ws, records } = setup();
    await runTurn(ws);
    expect(records).toHaveLength(1);
    expect(records[0].transcript).not.toContain(SECRET);
    expect(records[0]).toMatchObject({ turnId: 't1', language: 'en', end: 'answered', voice: 'af_test', sentences: 1 });
    expect(records[0].answer).toBe('Two tasks are running.');
    expect(records[0].transcriptWords).toBeGreaterThan(0);
  });

  describe('a model that refuses the reasoning setting (#3666)', () => {
    const refused = (): BasetenStreamError => new BasetenStreamError('http', 'Baseten returned HTTP 400: reasoning_effort is not supported', 400);

    it('asks again without the setting, answers, and leaves it out of later turns on any connection', async () => {
      const { ws, warnings, connect } = setup();
      mocks.streamBasetenChat.mockImplementation(async function* (_c: unknown, req: { reasoningEffort?: unknown }) {
        if (req.reasoningEffort !== null) throw refused();
        yield 'Two tasks are running. ';
      });
      await runTurn(ws);
      expect(reasoningEfforts()).toEqual(['none', null]);
      expect(ws.sent.some((m) => m.type === 'sentence')).toBe(true);
      expect(ws.sent.find((m) => m.type === 'turn_done')).toMatchObject({ end: 'answered' });
      await runTurn(connect());
      expect(reasoningEfforts()).toEqual(['none', null, null]);
      expect(warnings.filter((w) => w.includes('reasoning'))).toHaveLength(1);
    });

    it('a 400 that the retry does not cure keeps the setting for the next turn', async () => {
      const { ws } = setup();
      mocks.streamBasetenChat.mockImplementation(async function* () { throw refused(); });
      await runTurn(ws);
      expect(ws.sent.find((m) => m.type === 'turn_done')).toMatchObject({ end: 'error' });
      await runTurn(ws, 't2');
      expect(reasoningEfforts()).toEqual(['none', null, 'none', null]);
    });

    it('any other failure is not retried', async () => {
      const { ws } = setup();
      mocks.streamBasetenChat.mockImplementation(async function* () { throw new BasetenStreamError('http', 'Baseten returned HTTP 500: down', 500); });
      await runTurn(ws);
      expect(reasoningEfforts()).toEqual(['none']);
    });
  });

  it('redacts secrets in a failed turn\'s reason, in the panel and in the log (#3666)', async () => {
    const { ws, records } = setup();
    mocks.streamBasetenChat.mockImplementation(async function* () {
      throw new BasetenStreamError('http', `Baseten returned HTTP 500: {"echo":"${SECRET}"}`, 500);
    });
    await runTurn(ws);
    const done = ws.sent.find((m) => m.type === 'turn_done') as { end: string; reason?: string };
    expect(done.end).toBe('error');
    expect(done.reason).toContain('HTTP 500');
    expect(done.reason).not.toContain(SECRET);
    expect(records[0].reason).toContain('HTTP 500');
    expect(records[0].reason).not.toContain(SECRET);
  });

  it('sends system, then history, then the user message to the model', async () => {
    const { ws } = setup();
    await runTurn(ws);
    const request = mocks.streamBasetenChat.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    expect(request.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(request.messages[1].content).toContain('my key is');
    // The second turn carries the first exchange between the system prompt and the new question.
    ws.json({ type: 'speech_start', turnId: 't2' });
    ws.audio(3200);
    ws.json({ type: 'speech_end', turnId: 't2' });
    await tick(); await tick(); await tick();
    const second = mocks.streamBasetenChat.mock.calls[1][1] as { messages: Array<{ role: string }> };
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('puts what waits on the operator and the train state at the top of the status the helper model reads (#3927)', async () => {
    const { ws } = setup({
      extraDeps: {
        getNeedsOperator: () => [{ name: 'Fix login', project: 'kookr', attention: { kind: 'permission_blocked', tool: 'Bash', sinceMs: 1000 - 12 * 60_000 } }],
        getTrainHealth: () => ({ running: true, halted: { reason: 'base-red', at: new Date(1000 - 20 * 60_000).toISOString() }, pendingSince: null, alerting: false }),
      },
    });
    await runTurn(ws);
    const request = mocks.streamBasetenChat.mock.calls[0][1] as { messages: Array<{ role: string; content: string }> };
    const status = request.messages[0].content.split('Task status (current):\n')[1]!;
    expect(status.split('\n')[0]).toMatch(/^Needs the operator: 1 task/);
    expect(status).toContain('- "Fix login" in project kookr: waiting for permission to use Bash, for 12 minutes');
    expect(status).toContain('Integration train: halted for 20 minutes because main itself fails the full test suite');
  });

  it('maps the speech service audioBase64 to the sentence wavBase64 and passes the chosen voice', async () => {
    const { ws } = setup();
    await runTurn(ws);
    expect(mocks.synthesize).toHaveBeenCalledWith(expect.objectContaining({ ttsUrl: 'http://tts', voice: 'af_test', text: 'Two tasks are running.' }));
    expect(ws.sent.find((m) => m.type === 'sentence')).toMatchObject({ turnId: 't1', seq: 0, wavBase64: 'V0FW', durationMs: 321 });
  });

  it('opens the recogniser at the configured url and language', async () => {
    const { ws } = setup();
    ws.json({ type: 'hello', language: 'fr' });
    ws.json({ type: 'speech_start', turnId: 't1' });
    expect(mocks.openEarsTurn).toHaveBeenCalledWith({ url: 'ws://ears', language: 'fr' });
  });

  it('without Silero a new speech_start while she answers interrupts at once (no openVad port)', async () => {
    const { ws } = setup({ vad: null });
    mocks.streamBasetenChat.mockImplementation(async function* (_c: unknown, req: { signal: AbortSignal }) {
      yield 'Working on it. ';
      await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    ws.json({ type: 'hello', language: 'en' });
    ws.json({ type: 'speech_start', turnId: 't1' });
    ws.audio(3200);
    ws.json({ type: 'speech_end', turnId: 't1' });
    await tick(); await tick(); await tick();
    ws.sent.length = 0;
    ws.json({ type: 'speech_start', turnId: 't2', lucyAudible: true });
    expect(ws.sent.map((m) => m.type)).toEqual(['turn_done', 'state']);
    expect(ws.sent[0]).toMatchObject({ type: 'turn_done', turnId: 't1', end: 'interrupted' });
    expect(ws.sent.some((m) => m.type === 'speech_confirmed' || m.type === 'speech_rejected')).toBe(false);
  });

  it('with Silero it opens one detector per stretch of audio', () => {
    const openTurn = vi.fn(() => ({ push: vi.fn(async () => []) }));
    const { ws } = setup({ vad: { openTurn } as unknown as SileroVad });
    ws.json({ type: 'hello', language: 'en' });
    ws.json({ type: 'speech_start', turnId: 't1' });
    expect(openTurn).toHaveBeenCalledTimes(1);
  });

  describe('with launching switched on (issue #3676)', () => {
    function operator(events: LucyTurnEvent[]): { service: LucyOperatorService; requests: Array<{ request: LucyTurnRequest; context: unknown }>; noted: number[] } {
      const requests: Array<{ request: LucyTurnRequest; context: unknown }> = [];
      const noted: number[] = [];
      const service = {
        // Talk goes to the operator conversation only while launching is on (`launch` present); what it
        // tells about her voice and a closed socket goes to the service, which passes it to every card holder.
        launch: {},
        noteSpeaking: (_conversationId: string, until: number) => { noted.push(until); },
        closeConversation: () => {},
        isBusy: () => false,
        atCapacity: () => false,
        runTurn: async function* (request: LucyTurnRequest, _signal?: AbortSignal, context?: unknown) {
          requests.push({ request, context });
          for (const event of events) yield event;
        },
      } as unknown as LucyOperatorService;
      return { service, requests, noted };
    }
    const done = (end: string, reason?: string): LucyTurnEvent => ({ type: 'done', end, ...(reason ? { reason } : {}), firstTextMs: null, totalMs: 1, steps: 0, inputTokens: 0, outputTokens: 0, costUsd: null } as LucyTurnEvent);

    it('answers the spoken request with the operator conversation, not the helper model', async () => {
      const { service, requests } = operator([{ type: 'text', delta: 'I will launch an investigation in kookr: why it stops. ' }, { type: 'text', delta: 'Say go to start.' }, done('answered')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      expect(mocks.streamBasetenChat).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.request).toMatchObject({ input: 'voice', text: expect.stringContaining('my key is') });
      // The conversation id is stable across the connection's turns, so a later "go" finds the proposal.
      expect(requests[0]!.request.conversationId).toMatch(/^live-/);
      expect(requests[0]!.context).toEqual({ speechStartedAt: 1000 });
      expect(ws.sent.filter((m) => m.type === 'sentence').map((m) => m.text)).toEqual(['I will launch an investigation in kookr: why it stops.', 'Say go to start.']);
    });

    it('tells the operator service how long her voice is audible, so the cancel window starts after the read-back', async () => {
      const { service, noted } = operator([{ type: 'text', delta: 'I will launch it. ' }, { type: 'text', delta: 'Say go to start.' }, done('answered')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      // Two sentences of 321 ms each, played back to back from the server clock (fixed at 1000 here).
      expect(noted).toEqual([1321, 1642]);
    });

    it('marks speech that began while her voice was audible, so the controller can ignore her own echo', async () => {
      const { service, requests } = operator([{ type: 'text', delta: 'Okay. ' }, done('answered')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      expect(requests[0]!.request.overlapsReadBack).toBeUndefined();
      // The clock is frozen, so the second request begins "while she is still audible".
      ws.json({ type: 'speech_start', turnId: 't2' });
      ws.audio(3200);
      ws.json({ type: 'speech_end', turnId: 't2' });
      await tick(); await tick(); await tick();
      expect(requests[1]!.request.overlapsReadBack).toBe(true);
    });

    it('closing the socket drops that conversation\'s pending proposal', async () => {
      const closed: string[] = [];
      const { service, requests } = operator([{ type: 'text', delta: 'Okay. ' }, done('answered')]);
      (service as unknown as Record<string, unknown>).closeConversation = (id: string) => { closed.push(id); };
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      ws.emit('close');
      expect(closed).toEqual([requests[0]!.request.conversationId]);
    });

    it('uses the same conversation for the next spoken turn', async () => {
      const { service, requests } = operator([{ type: 'text', delta: 'Okay. ' }, done('answered')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      ws.json({ type: 'speech_start', turnId: 't2' });
      ws.audio(3200);
      ws.json({ type: 'speech_end', turnId: 't2' });
      await tick(); await tick(); await tick();
      expect(requests[1]!.request.conversationId).toBe(requests[0]!.request.conversationId);
    });

    it('speech that could be her own voice makes no answer and no error', async () => {
      const { service } = operator([done('ignored')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      expect(ws.sent.some((m) => m.type === 'sentence')).toBe(false);
      expect(ws.sent.find((m) => m.type === 'turn_done')).toMatchObject({ end: 'empty' });
    });

    it('a failed operator turn is reported as an error turn', async () => {
      const { service } = operator([done('error', 'The model provider could not be reached.')]);
      const { ws } = setup({ getOperator: () => service });
      await runTurn(ws);
      expect(ws.sent.find((m) => m.type === 'turn_done')).toMatchObject({ end: 'error' });
    });

    it('a task question she reads out is remembered in the same operator conversation; a closed one is not read (#3711)', async () => {
      const { service, requests } = operator([{ type: 'text', delta: 'Okay. ' }, done('answered')]);
      const remembered: Array<[string, string, string]> = [];
      (service as unknown as Record<string, unknown>).rememberSaid = (id: string, note: string, said: string) => { remembered.push([id, note, said]); };
      const ask = (id: string, state: string) => ({ id, state, taskName: 'Cleanup', question: 'When should I run it?', options: ['now', 'tonight'], allowText: false }) as unknown as OperatorAskView;
      const { ws } = setup({ getOperator: () => service, extraDeps: { getAsks: () => [ask('a1', 'pending'), ask('a2', 'answered')] } });
      ws.json({ type: 'hello', language: 'en' });
      ws.json({ type: 'say_ask', askId: 'a2' });
      await tick(); await tick();
      expect(ws.sent.some((m) => m.type === 'turn_start')).toBe(false);
      ws.json({ type: 'say_ask', askId: 'a1' });
      await tick(); await tick(); await tick();
      expect(ws.sent.find((m) => m.type === 'turn_start')).toMatchObject({ askId: 'a1' });
      const sentences = ws.sent.filter((m) => m.type === 'sentence');
      const said = sentences.map((m) => m.text).join(' ');
      expect(said).toBe('The task Cleanup needs your input: When should I run it? Two choices are on my card.');
      // What she said is noted as the browser reports hearing it, just before the next answer (#4015).
      expect(remembered).toHaveLength(0);
      for (const s of sentences) ws.json({ type: 'played', turnId: s.turnId, seq: s.seq, complete: true });
      await runTurn(ws, 't2');
      expect(remembered).toHaveLength(1);
      expect(remembered[0]![2]).toBe(said);
      expect(requests[0]!.request.conversationId).toBe(remembered[0]![0]);
    });

    it('a task question waits while a launch proposal from any conversation waits for its answer (#4015)', async () => {
      const { service } = operator([done('answered')]);
      let proposal: { expiresAt: number; launchesAt?: number } | undefined = { expiresAt: 61_000 }; // the clock reads 1000
      const pendingCalls: unknown[][] = [];
      (service as unknown as { launch: Record<string, unknown> }).launch.pending = (...args: unknown[]) => { pendingCalls.push(args); return proposal; };
      const ask = { id: 'a1', state: 'pending', taskName: 'Cleanup', question: 'When should I run it?', options: ['now', 'tonight'], allowText: false } as unknown as OperatorAskView;
      const { ws } = setup({ getOperator: () => service, extraDeps: { getAsks: () => [ask] } });
      ws.json({ type: 'hello', language: 'en' });
      ws.json({ type: 'say_ask', askId: 'a1' });
      await tick(); await tick();
      expect(ws.sent.some((m) => m.type === 'turn_start')).toBe(false);
      // Asked without a conversation id: a "yes" answers the one proposal on screen, whichever conversation made it.
      expect(pendingCalls.length).toBeGreaterThan(0);
      expect(pendingCalls.every((args) => args.length === 0)).toBe(true);
      // A hands-off launch whose start time has passed no longer waits for an answer, even before it expires.
      proposal = { expiresAt: 61_000, launchesAt: 900 };
      ws.json({ type: 'speech_start', turnId: 'blip' });
      ws.json({ type: 'speech_cancel', turnId: 'blip' }); // something ends: the question looks again
      await tick(); await tick(); await tick();
      expect(ws.sent.find((m) => m.type === 'turn_start')).toMatchObject({ askId: 'a1' });
    });

    it('a task question waits while an answer, reply or close card from any conversation waits for its "yes"', async () => {
      // Her other cards are confirmed like a launch: by a "yes" from any conversation. Read out meanwhile, a
      // question would have its "yes" close a task or send a reply.
      const { service } = operator([done('answered')]);
      let card: { expiresAt: number } | undefined = { expiresAt: 31_000 }; // the clock reads 1000
      const pendingCalls: unknown[][] = [];
      (service as unknown as { launch: Record<string, unknown> }).launch.pending = () => undefined;
      (service as unknown as { actions: Record<string, unknown> }).actions = { pending: (...args: unknown[]) => { pendingCalls.push(args); return card; } };
      const ask = { id: 'a1', state: 'pending', taskName: 'Cleanup', question: 'When should I run it?', options: ['now', 'tonight'], allowText: false } as unknown as OperatorAskView;
      const { ws } = setup({ getOperator: () => service, extraDeps: { getAsks: () => [ask] } });
      ws.json({ type: 'hello', language: 'en' });
      ws.json({ type: 'say_ask', askId: 'a1' });
      await tick(); await tick();
      expect(ws.sent.some((m) => m.type === 'turn_start')).toBe(false);
      // Asked without a conversation id: the one card on screen, whichever conversation made it.
      expect(pendingCalls.length).toBeGreaterThan(0);
      expect(pendingCalls.every((args) => args.length === 0)).toBe(true);
      // The card is settled (confirmed, declined or replaced): the question is read.
      card = undefined;
      ws.json({ type: 'speech_start', turnId: 'blip' });
      ws.json({ type: 'speech_cancel', turnId: 'blip' }); // something ends: the question looks again
      await tick(); await tick(); await tick();
      expect(ws.sent.find((m) => m.type === 'turn_start')).toMatchObject({ askId: 'a1' });
    });

    it('with both kinds of card reported waiting, the question waits for the later of the two', async () => {
      const { service } = operator([done('answered')]);
      let launchesAt = 900; // a hands-off launch already past its start: it no longer waits (the clock reads 1000)
      (service as unknown as { launch: Record<string, unknown> }).launch.pending = () => ({ expiresAt: 61_000, launchesAt });
      (service as unknown as { actions: Record<string, unknown> }).actions = { pending: () => ({ expiresAt: 31_000 }) };
      const ask = { id: 'a1', state: 'pending', taskName: 'Cleanup', question: 'When should I run it?', options: ['now', 'tonight'], allowText: false } as unknown as OperatorAskView;
      const { ws } = setup({ getOperator: () => service, extraDeps: { getAsks: () => [ask] } });
      ws.json({ type: 'hello', language: 'en' });
      ws.json({ type: 'say_ask', askId: 'a1' });
      await tick(); await tick();
      expect(ws.sent.some((m) => m.type === 'turn_start')).toBe(false); // the action card still waits
      launchesAt = 500;
      (service as unknown as { actions: Record<string, unknown> }).actions = { pending: () => undefined };
      ws.json({ type: 'speech_start', turnId: 'blip' });
      ws.json({ type: 'speech_cancel', turnId: 'blip' });
      await tick(); await tick(); await tick();
      expect(ws.sent.find((m) => m.type === 'turn_start')).toMatchObject({ askId: 'a1' });
    });

    it('with an operator service that cannot launch, the helper model still answers', async () => {
      const { ws } = setup({ getOperator: () => ({ launch: undefined } as unknown as LucyOperatorService) });
      await runTurn(ws);
      expect(mocks.streamBasetenChat).toHaveBeenCalledTimes(1);
    });
  });
});
