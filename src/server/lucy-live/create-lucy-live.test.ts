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
vi.mock('../../adapters/llm/baseten-stream.js', () => ({ streamBasetenChat: mocks.streamBasetenChat }));
vi.mock('../../adapters/tts-client.js', () => ({ synthesize: mocks.synthesize }));

import { createLucyLive } from './create-lucy-live.js';
import type { LucyLiveConfig } from './config.js';
import type { LucyInteractionLog, LucyLiveTurnRecordInput } from '../lucy-interaction-log.js';
import type { SileroVad } from '../../adapters/lucy-live/silero-vad.js';

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

function setup(opts: { vad?: SileroVad | null } = {}) {
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
  const service = createLucyLive({
    config: CONFIG,
    vad: opts.vad,
    getTasks: () => [],
    getVoice: () => 'af_test',
    log,
    warn: () => {},
    now: () => 1000,
  });
  const ws = new FakeSocket();
  service.handleConnection(ws as unknown as WebSocket, {} as never);
  return { ws, records, ears };
}

async function runTurn(ws: FakeSocket): Promise<void> {
  ws.json({ type: 'hello', language: 'en' });
  ws.json({ type: 'speech_start', turnId: 't1' });
  ws.audio(3200);
  ws.json({ type: 'speech_end', turnId: 't1' });
  await tick(); await tick(); await tick();
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
});
