import { describe, expect, it } from 'vitest';
import type { LucyLiveServerMessage } from '../../shared/contracts/lucy-live.js';
import {
  DRAFT_INTERVAL_BYTES,
  LucyLiveSession,
  type ChatTurn,
  type EarsTurnPort,
  type LiveTurnRecord,
  type LucyLivePorts,
} from './session.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeEars implements EarsTurnPort {
  appended: Buffer[] = [];
  aborted = false;
  result = deferred<string>();
  constructor() { this.result.promise.catch(() => {}); }
  append(pcm: Buffer): void { this.appended.push(pcm); }
  finish(): Promise<string> { return this.result.promise; }
  abort(): void { this.aborted = true; this.result.reject(new Error('aborted')); }
}

/** An answer the test feeds piece by piece; ends when `end()` is called or the signal aborts. */
class FakeBrain {
  calls: Array<{ system: string; history: readonly ChatTurn[]; user: string; signal: AbortSignal }> = [];
  private queue: Array<string | Error | null> = [];
  private wake: (() => void) | null = null;
  feed(delta: string): void { this.queue.push(delta); this.wake?.(); }
  end(): void { this.queue.push(null); this.wake?.(); }
  fail(err: Error): void { this.queue.push(err); this.wake?.(); }
  stream = (req: { system: string; history: readonly ChatTurn[]; user: string; signal: AbortSignal }): AsyncIterable<string> => {
    this.calls.push(req);
    const self = this;
    return (async function* () {
      for (;;) {
        if (req.signal.aborted) throw new Error('aborted');
        const next = self.queue.shift();
        if (next === undefined) {
          await new Promise<void>((r) => {
            self.wake = r;
            req.signal.addEventListener('abort', () => r(), { once: true });
          });
          continue;
        }
        if (next === null) return;
        if (next instanceof Error) throw next;
        yield next;
      }
    })();
  };
}

interface Harness {
  session: LucyLiveSession;
  sent: LucyLiveServerMessage[];
  ears: FakeEars[];
  brain: FakeBrain;
  records: LiveTurnRecord[];
  synth: Array<{ text: string; signal: AbortSignal; d: ReturnType<typeof deferred<{ wavBase64: string; durationMs: number }>> }>;
  drafts: Array<{ pcm: Buffer; signal: AbortSignal; d: ReturnType<typeof deferred<string>> }>;
  clock: { t: number };
  autoSynth: boolean;
}

function harness(opts: { autoSynth?: boolean } = {}): Harness {
  const h = {
    sent: [] as LucyLiveServerMessage[], ears: [] as FakeEars[], brain: new FakeBrain(), records: [] as LiveTurnRecord[],
    synth: [] as Harness['synth'], drafts: [] as Harness['drafts'], clock: { t: 1000 }, autoSynth: opts.autoSynth ?? true,
  } as Harness;
  const ports: LucyLivePorts = {
    send: (m) => h.sent.push(m),
    openEars: () => { const e = new FakeEars(); h.ears.push(e); return e; },
    transcribeDraft: (pcm, _lang, signal) => { const d = deferred<string>(); h.drafts.push({ pcm, signal, d }); return d.promise; },
    streamAnswer: (req) => h.brain.stream(req),
    synthesize: (text, signal) => {
      const d = deferred<{ wavBase64: string; durationMs: number }>();
      d.promise.catch(() => {});
      h.synth.push({ text, signal, d });
      signal.addEventListener('abort', () => d.reject(new Error('aborted')), { once: true });
      if (h.autoSynth) d.resolve({ wavBase64: `wav:${text}`, durationMs: 100 });
      return d.promise;
    },
    buildBriefing: () => 'BRIEFING',
    now: () => h.clock.t,
    warn: () => {},
    recordTurn: (r) => h.records.push(r),
  };
  h.session = new LucyLiveSession(ports);
  return h;
}

const types = (h: Harness): string[] => h.sent.map((m) => (m.type === 'state' ? `state:${m.state}` : m.type === 'turn_done' ? `done:${m.end}` : m.type));

async function speak(h: Harness, turnId = 't1', transcript = 'Which tasks need me?'): Promise<FakeEars> {
  h.session.handleMessage({ type: 'speech_start', turnId });
  const ears = h.ears[h.ears.length - 1];
  h.session.handleAudio(Buffer.alloc(3200));
  h.session.handleMessage({ type: 'speech_end', turnId });
  ears.result.resolve(transcript);
  await tick();
  return ears;
}

describe('LucyLiveSession', () => {
  it('runs a full turn in order and reports timings', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'hello', language: 'fr' });
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleAudio(Buffer.alloc(3200));
    h.clock.t += 500;
    h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
    h.clock.t += 200;
    h.ears[0].result.resolve('Which tasks need me?');
    await tick();
    h.clock.t += 270;
    h.brain.feed('Two tasks. ');
    h.brain.feed('One needs you.');
    h.brain.end();
    await tick(); await tick();

    expect(types(h)).toEqual([
      'ready', 'state:listening', 'state:transcribing', 'transcript', 'state:thinking',
      'state:speaking', 'sentence', 'sentence', 'done:answered', 'state:idle',
    ]);
    const sentences = h.sent.filter((m) => m.type === 'sentence');
    expect(sentences.map((s) => (s.type === 'sentence' ? [s.seq, s.text] : []))).toEqual([[0, 'Two tasks.'], [1, 'One needs you.']]);
    expect(h.brain.calls[0].system).toContain('BRIEFING');
    expect(h.records[0]).toMatchObject({ end: 'answered', language: 'fr', transcript: 'Which tasks need me?', asrMs: 200, sentences: 2 });
    expect(h.records[0].firstAudioMs).toBe(470);
    expect(h.records[0].firstSentenceMs).toBe(470);
  });

  it('keeps sentence order even when a later sentence finishes synthesis first', async () => {
    const h = harness({ autoSynth: false });
    await speak(h);
    h.brain.feed('First one. Second one. ');
    h.brain.end();
    await tick();
    expect(h.synth.map((s) => s.text)).toEqual(['First one.', 'Second one.']);
    h.synth[1].d.resolve({ wavBase64: 'b', durationMs: 1 });
    await tick();
    expect(h.sent.some((m) => m.type === 'sentence')).toBe(false);
    h.synth[0].d.resolve({ wavBase64: 'a', durationMs: 1 });
    await tick(); await tick();
    expect(h.sent.filter((m) => m.type === 'sentence').map((m) => (m.type === 'sentence' ? m.seq : -1))).toEqual([0, 1]);
  });

  it('barge-in during thinking aborts the brain and ends interrupted', async () => {
    const h = harness();
    await speak(h);
    const signal = h.brain.calls[0].signal;
    h.session.handleMessage({ type: 'barge_in' });
    await tick();
    expect(signal.aborted).toBe(true);
    expect(types(h).slice(-2)).toEqual(['done:interrupted', 'state:idle']);
    expect(h.records[0]).toMatchObject({ end: 'interrupted', sentences: 0 });
  });

  it('barge-in during speaking aborts pending speech', async () => {
    const h = harness({ autoSynth: false });
    await speak(h);
    h.brain.feed('One. Two. Three');
    await tick();
    h.synth[0].d.resolve({ wavBase64: 'a', durationMs: 1 });
    await tick();
    expect(types(h)).toContain('state:speaking');
    h.session.handleMessage({ type: 'barge_in' });
    await tick();
    expect(h.synth[1].signal.aborted).toBe(true);
    expect(h.brain.calls[0].signal.aborted).toBe(true);
    expect(h.sent.filter((m) => m.type === 'turn_done')).toEqual([{ type: 'turn_done', turnId: 't1', end: 'interrupted' }]);
    expect(h.sent.filter((m) => m.type === 'sentence')).toHaveLength(1);
  });

  it('a new speech_start while thinking interrupts the old turn then listens', async () => {
    const h = harness();
    await speak(h);
    h.session.handleMessage({ type: 'speech_start', turnId: 't2' });
    expect(types(h).slice(-3)).toEqual(['state:thinking', 'done:interrupted', 'state:listening']);
    expect(h.session.acceptingAudio).toBe(true);
  });

  it('empty or hallucinated transcript ends empty without calling the brain', async () => {
    const h = harness();
    await speak(h, 't1', 'Merci.');
    expect(h.brain.calls).toHaveLength(0);
    expect(types(h).slice(-2)).toEqual(['done:empty', 'state:idle']);
    expect(h.sent.some((m) => m.type === 'transcript')).toBe(false);
  });

  it('an ears failure ends the turn with error and the next turn still works', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
    h.ears[0].result.reject(new Error('socket hang up'));
    await tick();
    const done = h.sent.find((m) => m.type === 'turn_done');
    expect(done).toMatchObject({ end: 'error' });
    expect((done as { reason: string }).reason).toMatch(/speech recogniser/);
    await speak(h, 't2');
    h.brain.feed('Fine.');
    h.brain.end();
    await tick(); await tick();
    expect(h.records.map((r) => r.end)).toEqual(['error', 'answered']);
  });

  it('a brain failure and a mouth failure end with error', async () => {
    const h = harness();
    await speak(h);
    h.brain.fail(new Error('503'));
    await tick(); await tick();
    expect(h.records[0]).toMatchObject({ end: 'error' });
    expect(h.records[0].reason).toMatch(/helper model/);

    const m = harness({ autoSynth: false });
    await speak(m);
    m.brain.feed('Hello there.');
    m.brain.end();
    await tick();
    m.synth[0].d.reject(new Error('tts down'));
    await tick(); await tick();
    expect(m.records[0]).toMatchObject({ end: 'error' });
    expect(m.records[0].reason).toMatch(/speech service/);
  });

  it('a speech failure mid-answer stops the model stream instead of reading it to the end', async () => {
    const h = harness({ autoSynth: false });
    await speak(h);
    h.brain.feed('First sentence. ');
    await tick();
    h.synth[0].d.reject(new Error('tts down'));
    await tick(); await tick();
    // The stream was never ended by the test: only the abort can have finished the turn.
    expect(h.brain.calls[0].signal.aborted).toBe(true);
    expect(h.records[0]).toMatchObject({ end: 'error' });
    expect(h.records[0].reason).toMatch(/speech service/);
  });

  it('speech_cancel discards the turn silently', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleMessage({ type: 'speech_cancel', turnId: 't1' });
    expect(h.ears[0].aborted).toBe(true);
    expect(types(h)).toEqual(['state:listening', 'state:idle']);
    expect(h.records).toHaveLength(0);
  });

  it('uses played sentences for history, marking an interrupted answer', async () => {
    const h = harness();
    await speak(h, 't1', 'First question here');
    h.brain.feed('Alpha one. Beta two. Gamma three.');
    h.brain.end();
    await tick(); await tick();
    h.session.handleMessage({ type: 'played', turnId: 't1', seq: 0, complete: true });
    h.session.handleMessage({ type: 'played', turnId: 't1', seq: 1, complete: false });
    await speak(h, 't2', 'Second question here');
    expect(h.brain.calls[1].history).toEqual([
      { role: 'user', content: 'First question here' },
      { role: 'assistant', content: 'Alpha one. Beta two. (interrupted)' },
    ]);
  });

  it('falls back to sent sentences when no played arrives, and caps history at 8 exchanges', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      await speak(h, `t${i}`, `Question number ${i}`);
      h.brain.feed(`Answer ${i}.`);
      h.brain.end();
      await tick(); await tick();
    }
    await speak(h, 'last', 'One more question');
    const history = h.brain.calls[10].history;
    expect(history).toHaveLength(16);
    expect(history[0]).toEqual({ role: 'user', content: 'Question number 2' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Answer 2.' });
  });

  it('throttles drafts, emits them as non-final, and never lets them delay the final', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES));
    expect(h.drafts).toHaveLength(1);
    h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES)); // draft still in flight: skipped
    expect(h.drafts).toHaveLength(1);
    h.drafts[0].d.resolve('which tasks');
    await tick();
    expect(h.sent.find((m) => m.type === 'transcript')).toEqual({ type: 'transcript', turnId: 't1', text: 'which tasks', final: false });
    h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES));
    expect(h.drafts).toHaveLength(2);
    expect(h.drafts[1].pcm.length).toBe(DRAFT_INTERVAL_BYTES * 3);
    h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
    expect(h.drafts[1].signal.aborted).toBe(true);
    h.drafts[1].d.resolve('which tasks need');
    h.ears[0].result.resolve('Which tasks need me?');
    await tick();
    const transcripts = h.sent.filter((m) => m.type === 'transcript');
    expect(transcripts.map((m) => (m.type === 'transcript' ? [m.text, m.final] : []))).toEqual([['which tasks', false], ['Which tasks need me?', true]]);
  });

  it('cuts audio at the per-turn cap and ignores frames outside a listening turn', () => {
    const h = harness();
    h.session.handleAudio(Buffer.alloc(100));
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    for (let i = 0; i < 40; i++) h.session.handleAudio(Buffer.alloc(32000));
    const total = h.ears[0].appended.reduce((n, b) => n + b.length, 0);
    expect(total).toBe(30 * 32000);
  });

  it('redacts secrets in spoken sentences', async () => {
    const h = harness();
    await speak(h);
    h.brain.feed('The key is sk-abcdefghijklmnopqrstuvwxyz123456 today.');
    h.brain.end();
    await tick(); await tick();
    const s = h.sent.find((m) => m.type === 'sentence');
    expect(JSON.stringify(s)).not.toContain('sk-abcdefghijkl');
  });

  it('close() stops quietly', async () => {
    const h = harness();
    await speak(h);
    const before = h.sent.length;
    h.session.close();
    h.brain.feed('Late words.');
    await tick();
    expect(h.sent.length).toBe(before);
  });
});
