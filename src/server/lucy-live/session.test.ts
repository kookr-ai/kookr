import { describe, expect, it, vi } from 'vitest';
import type { LucyLiveServerMessage } from '../../shared/contracts/lucy-live.js';
import {
  CANDIDATE_MAX_FRAMES,
  DRAFT_INTERVAL_BYTES,
  LucyLiveSession,
  type ChatTurn,
  type EarsTurnPort,
  type LiveTurnRecord,
  type LucyLivePorts,
  type VadTurnPort,
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

/** Silero stand-in: each pushed chunk is scored with the next scripted batch of probabilities (none left: no frames). */
class FakeVad implements VadTurnPort {
  pushed: Buffer[] = [];
  script: Array<number[] | Error> = [];
  push(pcm: Buffer): Promise<number[]> {
    this.pushed.push(pcm);
    const next = this.script.shift() ?? [];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
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
  vads: FakeVad[];
}

function harness(opts: { autoSynth?: boolean; vad?: boolean; streamAnswer?: LucyLivePorts['streamAnswer'] } = {}): Harness {
  const h = {
    vads: [] as FakeVad[],
    sent: [] as LucyLiveServerMessage[], ears: [] as FakeEars[], brain: new FakeBrain(), records: [] as LiveTurnRecord[],
    synth: [] as Harness['synth'], drafts: [] as Harness['drafts'], clock: { t: 1000 }, autoSynth: opts.autoSynth ?? true,
  } as Harness;
  const ports: LucyLivePorts = {
    send: (m) => h.sent.push(m),
    openEars: () => { const e = new FakeEars(); h.ears.push(e); return e; },
    openVad: opts.vad ? () => { const v = new FakeVad(); h.vads.push(v); return v; } : undefined,
    transcribeDraft: (pcm, _lang, signal) => { const d = deferred<string>(); h.drafts.push({ pcm, signal, d }); return d.promise; },
    streamAnswer: (req) => (opts.streamAnswer ? opts.streamAnswer(req) : h.brain.stream(req)),
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

  it('a barge_in while thinking leaves the turn for the speech_start that follows', async () => {
    const h = harness();
    await speak(h);
    h.session.handleMessage({ type: 'barge_in' });
    await tick();
    expect(h.brain.calls[0].signal.aborted).toBe(false);
    expect(h.records).toHaveLength(0);
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

  it('a new speech_start while thinking continues the request instead of dropping it', async () => {
    const h = harness();
    await speak(h);
    const signal = h.brain.calls[0].signal;
    h.session.handleMessage({ type: 'speech_start', turnId: 't2' });
    expect(types(h).slice(-3)).toEqual(['state:thinking', 'done:interrupted', 'state:listening']);
    expect(signal.aborted).toBe(true);
    expect(h.session.acceptingAudio).toBe(true);
    expect(h.records[0]).toMatchObject({ turnId: 't1', end: 'interrupted', transcript: 'Which tasks need me?', sentences: 0 });
    expect(h.records[0].reason).toMatch(/continued/);
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

  describe('Silero confirmation', () => {
    const SPEECH = [0.9, 0.9, 0.9];
    const NOISE = [0.05, 0.1, 0.04];

    /** Lucy is mid-answer: the first sentence is sent and the model stream is still open. */
    async function answeringHarness(): Promise<Harness> {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 'q1' });
      h.vads[0].script.push([0.95]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 'q1' });
      h.ears[0].result.resolve('Which tasks need me?');
      await tick();
      h.brain.feed('First part. ');
      await tick(); await tick();
      expect(h.sent.filter((m) => m.type === 'sentence')).toHaveLength(1);
      return h;
    }

    it('a candidate with speech is confirmed: speech_confirmed, then the answer is interrupted and the buffered audio goes to a new turn', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      const audio = Buffer.alloc(3200, 1);
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2' });
      expect(h.sent).toEqual([]); // nothing yet: the answer is untouched
      expect(h.ears).toHaveLength(1);
      expect(h.session.acceptingAudio).toBe(true);
      h.vads[1].script.push(SPEECH);
      h.session.handleAudio(audio);
      await tick();
      expect(types(h)).toEqual(['speech_confirmed', 'done:interrupted', 'state:listening']);
      expect(h.sent[0]).toEqual({ type: 'speech_confirmed', turnId: 'q2' });
      expect(h.ears[0].aborted).toBe(true);
      expect(h.ears).toHaveLength(2);
      expect(h.ears[1].appended).toEqual([audio]);
      // The promoted turn goes on like any other turn.
      h.session.handleAudio(Buffer.alloc(320));
      expect(h.ears[1].appended).toHaveLength(2);
      h.session.handleMessage({ type: 'speech_end', turnId: 'q2' });
      h.ears[1].result.resolve('Stop that.');
      await tick();
      expect(h.brain.calls).toHaveLength(2);
      expect(h.brain.calls[1].history.at(-1)?.content).toContain('(interrupted)');
      expect(h.sent.some((m) => m.type === 'transcript' && m.turnId === 'q2' && m.final)).toBe(true);
    });

    it('a rejected candidate leaves the answer and its history alone', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'noise' });
      h.vads[1].script.push(NOISE);
      h.session.handleAudio(Buffer.alloc(3200));
      await tick();
      expect(h.sent).toEqual([]); // still undecided
      h.session.handleMessage({ type: 'speech_end', turnId: 'noise' });
      expect(h.sent).toEqual([{ type: 'speech_rejected', turnId: 'noise' }]);
      expect(h.session.acceptingAudio).toBe(false);
      // The answer carries on: more sentences flow and the turn completes as answered.
      h.brain.feed('Second part.');
      h.brain.end();
      await tick(); await tick();
      expect(types(h)).toEqual(['speech_rejected', 'sentence', 'done:answered', 'state:idle']);
      expect(h.ears).toHaveLength(1);
      h.session.handleMessage({ type: 'played', turnId: 'q1', seq: 0, complete: true });
      h.session.handleMessage({ type: 'played', turnId: 'q1', seq: 1, complete: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 'q3' });
      h.vads[h.vads.length - 1].script.push([0.9]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 'q3' });
      h.ears[h.ears.length - 1].result.resolve('And now?');
      await tick();
      expect(h.brain.calls[1].history).toEqual([
        { role: 'user', content: 'Which tasks need me?' },
        { role: 'assistant', content: 'First part. Second part.' },
      ]);
    });

    it('speech_cancel also rejects a candidate', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'click' });
      h.session.handleMessage({ type: 'speech_cancel', turnId: 'click' });
      expect(h.sent).toEqual([{ type: 'speech_rejected', turnId: 'click' }]);
    });

    it('rejects by itself after CANDIDATE_MAX_FRAMES frames without confirmation', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'drone' });
      h.vads[1].script.push(new Array(CANDIDATE_MAX_FRAMES - 1).fill(0.2), [0.2]);
      h.session.handleAudio(Buffer.alloc(100));
      await tick();
      expect(h.sent).toEqual([]);
      h.session.handleAudio(Buffer.alloc(100));
      await tick();
      expect(h.sent).toEqual([{ type: 'speech_rejected', turnId: 'drone' }]);
      // Later audio of the same sound is ignored.
      h.session.handleAudio(Buffer.alloc(100));
      expect(h.vads[1].pushed).toHaveLength(2);
    });

    it('does not confirm on scattered frames below the speech count', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'x' });
      h.vads[1].script.push([0.9, 0.1, 0.9, 0.1]);
      h.session.handleAudio(Buffer.alloc(100));
      await tick();
      expect(h.sent).toEqual([]);
    });

    it('still sends a sentence that arrives while a candidate is pending', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'maybe' });
      h.brain.feed('Next bit. ');
      await tick(); await tick();
      expect(h.sent.filter((m) => m.type === 'sentence')).toHaveLength(1);
    });

    it('treats a candidate as confirmed when Silero fails', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2' });
      h.vads[1].script.push(new Error('wasm died'));
      h.session.handleAudio(Buffer.alloc(100));
      await tick();
      expect(types(h)).toEqual(['speech_confirmed', 'done:interrupted', 'state:listening']);
    });

    it('a candidate while the browser still plays a finished answer is confirmed with no turn to interrupt', async () => {
      const h = await answeringHarness();
      h.brain.end();
      await tick(); await tick();
      expect(types(h).at(-2)).toBe('done:answered');
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2', lucyAudible: true });
      h.vads[1].script.push(SPEECH);
      h.session.handleAudio(Buffer.alloc(3200));
      await tick();
      expect(types(h)).toEqual(['speech_confirmed', 'state:listening']);
      expect(h.ears).toHaveLength(2);
    });

    it('an explicit barge_in promotes a pending candidate: the answer stops and the operator\'s words are kept', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2' });
      h.session.handleAudio(Buffer.alloc(3200)); // held by the candidate
      h.session.handleMessage({ type: 'barge_in' });
      expect(h.session.acceptingAudio).toBe(true);
      expect(types(h)).toEqual(['speech_confirmed', 'done:interrupted', 'state:listening']);
      expect(h.ears).toHaveLength(2);
      expect(h.ears[1].appended).toHaveLength(1); // the buffered audio went to the recogniser
      h.session.handleAudio(Buffer.alloc(3200)); // and later audio under the same turn id still counts
      h.session.handleMessage({ type: 'speech_end', turnId: 'q2' });
      h.ears[1].result.resolve('Actually, stop');
      await tick();
      expect(h.sent.some((m) => m.type === 'transcript' && m.turnId === 'q2' && m.final && m.text === 'Actually, stop')).toBe(true);
    });

    it('decides "candidate" from lucyAudible when the browser sends it', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      // Browser says she is not audible: interrupt at once even though the server is mid-answer.
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2', lucyAudible: false });
      expect(types(h)).toEqual(['done:interrupted', 'state:listening']);
      expect(h.sent.some((m) => m.type === 'speech_confirmed' || m.type === 'speech_rejected')).toBe(false);
    });

    it('a rejected noise while the question is still being transcribed keeps the question', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 'q1' });
      h.vads[0].script.push([0.9, 0.9]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 'q1' }); // transcribing; recogniser not answered yet
      await tick();
      h.sent.length = 0;
      // The browser counts "question not answered yet" as busy, so the noise comes as a candidate.
      h.session.handleMessage({ type: 'speech_start', turnId: 'noise', lucyAudible: true });
      h.vads[1].script.push(NOISE);
      h.session.handleAudio(Buffer.alloc(3200));
      await tick();
      h.session.handleMessage({ type: 'speech_end', turnId: 'noise' });
      expect(h.sent).toEqual([{ type: 'speech_rejected', turnId: 'noise' }]);
      // The original question is then transcribed and answered.
      h.ears[0].result.resolve('Which tasks need me?');
      await tick();
      h.brain.feed('Nothing needs you.');
      h.brain.end();
      await tick(); await tick();
      expect(types(h)).toContain('done:answered');
      expect(types(h)).not.toContain('done:interrupted');
    });

    it('falls back to the server view of the answer when an old client omits lucyAudible', async () => {
      const h = await answeringHarness();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2' });
      expect(h.sent).toEqual([]); // candidate: still undecided
      expect(h.session.acceptingAudio).toBe(true);
    });

    it('a turn with no speech frame ends empty without calling the recogniser or the model', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      const finish = vi.spyOn(h.ears[0], 'finish');
      h.vads[0].script.push([0.02, 0.1, 0.3]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      await tick(); await tick();
      expect(finish).not.toHaveBeenCalled();
      expect(h.brain.calls).toHaveLength(0);
      expect(h.ears[0].aborted).toBe(true);
      expect(types(h)).toEqual(['state:listening', 'state:transcribing', 'done:empty', 'state:idle']);
      expect(h.records[0]).toMatchObject({ end: 'empty' });
    });

    it('a normal turn with speech opens the ears at once and answers as before', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      expect(h.ears).toHaveLength(1);
      h.vads[0].script.push([0.1, 0.8]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      h.ears[0].result.resolve('Hello there');
      await tick();
      h.brain.feed('Hi.');
      h.brain.end();
      await tick(); await tick();
      expect(types(h)).toContain('done:answered');
    });

    it('does not preview a draft while Silero has heard no speech', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      h.vads[0].script.push([0.01]);
      h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES));
      await tick();
      h.vads[0].script.push([0.01]);
      h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES));
      expect(h.drafts).toHaveLength(0);
    });

    it('trusts the turn when Silero fails mid-turn', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      h.vads[0].script.push(new Error('boom'));
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      h.ears[0].result.resolve('Hello');
      await tick();
      expect(h.sent.some((m) => m.type === 'transcript' && m.final)).toBe(true);
    });

    it('without Silero a speech_start while Lucy answers interrupts at once, and there is no pre-filter', async () => {
      const h = harness();
      await speak(h, 'q1');
      h.brain.feed('First part. ');
      await tick(); await tick();
      h.sent.length = 0;
      h.session.handleMessage({ type: 'speech_start', turnId: 'q2', lucyAudible: true });
      expect(types(h)).toEqual(['done:interrupted', 'state:listening']);
      expect(h.sent.some((m) => m.type === 'speech_confirmed' || m.type === 'speech_rejected')).toBe(false);
      h.session.handleMessage({ type: 'speech_end', turnId: 'q2' });
      h.ears[1].result.resolve('Yes');
      await tick();
      expect(h.sent.some((m) => m.type === 'transcript' && m.final)).toBe(true);
    });
  });

  describe('a request spoken with pauses', () => {
    /** Start a part and send audio, without ending it. */
    const begin = (h: Harness, id: string): FakeEars => {
      h.session.handleMessage({ type: 'speech_start', turnId: id });
      h.session.handleAudio(Buffer.alloc(3200));
      return h.ears[h.ears.length - 1];
    };
    const finalTexts = (h: Harness): string[] => h.sent.flatMap((m) => (m.type === 'transcript' && m.final ? [m.text] : []));

    it('joins a second part spoken before the recogniser replied, and answers once', async () => {
      const h = harness();
      const first = begin(h, 't1');
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      const second = begin(h, 't2'); // the pause was shorter than the recogniser's reply
      first.result.resolve('Look into the failing build.');
      second.result.resolve('Then fix it.');
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      await tick(); await tick();
      expect(h.brain.calls).toHaveLength(1);
      expect(h.brain.calls[0].user).toBe('Look into the failing build. Then fix it.');
      expect(finalTexts(h)).toEqual(['Look into the failing build. Then fix it.']);
      expect(first.aborted).toBe(false);
      h.brain.feed('On it.'); h.brain.end();
      await tick(); await tick();
      expect(h.sent.filter((m) => m.type === 'turn_done').map((m) => m.type === 'turn_done' ? [m.turnId, m.end] : [])).toEqual([['t1', 'interrupted'], ['t2', 'answered']]);
      expect(h.records.find((r) => r.turnId === 't1')).toMatchObject({ end: 'interrupted', transcript: 'Look into the failing build.' });
    });

    it('joins a second part spoken while the model is thinking about the first', async () => {
      const h = harness();
      await speak(h, 't1', 'Check the build.');
      const second = begin(h, 't2');
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      second.result.resolve('And fix it.');
      await tick(); await tick();
      expect(h.brain.calls).toHaveLength(2);
      expect(h.brain.calls[1].user).toBe('Check the build. And fix it.');
      expect(h.brain.calls[1].history).toEqual([]); // the abandoned first part is not remembered as an exchange
    });

    it('shows the whole request growing in drafts', async () => {
      const h = harness();
      await speak(h, 't1', 'Check the build.');
      h.session.handleMessage({ type: 'speech_start', turnId: 't2' });
      await tick();
      expect(h.sent.filter((m) => m.type === 'transcript' && m.turnId === 't2')).toEqual([
        { type: 'transcript', turnId: 't2', text: 'Check the build.', final: false },
      ]);
      h.session.handleAudio(Buffer.alloc(DRAFT_INTERVAL_BYTES));
      h.drafts[0].d.resolve('and fix it');
      await tick();
      expect(h.sent.at(-1)).toEqual({ type: 'transcript', turnId: 't2', text: 'Check the build. and fix it', final: false });
    });

    it('joins three parts in a row', async () => {
      const h = harness();
      const e1 = begin(h, 't1');
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      const e2 = begin(h, 't2');
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      const e3 = begin(h, 't3');
      h.session.handleMessage({ type: 'speech_end', turnId: 't3' });
      e3.result.resolve('three');
      e1.result.resolve('one');
      e2.result.resolve('two');
      await tick(); await tick();
      expect(h.brain.calls).toHaveLength(1);
      expect(h.brain.calls[0].user).toBe('one two three');
      expect(h.records.filter((r) => r.end === 'interrupted').map((r) => r.transcript)).toEqual(expect.arrayContaining(['one', 'two']));
    });

    it('treats a part cut at the length cap as the first of several', async () => {
      const h = harness();
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      for (let i = 0; i < 40; i++) h.session.handleAudio(Buffer.alloc(32000));
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' }); // the browser cuts at 30 s
      const e2 = begin(h, 't2');
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      h.ears[0].result.resolve('a very long beginning');
      e2.result.resolve('and the end');
      await tick(); await tick();
      expect(h.brain.calls[0].user).toBe('a very long beginning and the end');
    });

    it('answers the earlier parts alone when the new sound turns out not to be speech', async () => {
      const h = harness();
      await speak(h, 't1', 'Check the build.');
      h.session.handleMessage({ type: 'speech_start', turnId: 't2' });
      h.session.handleMessage({ type: 'speech_cancel', turnId: 't2' });
      await tick(); await tick();
      expect(h.brain.calls).toHaveLength(2);
      expect(h.brain.calls[1].user).toBe('Check the build.');
    });

    it('does not lose an older exchange from history when a thinking turn is retired', async () => {
      const h = harness();
      for (let i = 1; i <= 8; i++) {
        await speak(h, `h${i}`, `question number ${i}`);
        h.brain.feed('An answer.'); h.brain.end();
        await tick(); await tick();
      }
      await speak(h, 'a', 'the first half');
      const e = begin(h, 'b');
      h.session.handleMessage({ type: 'speech_end', turnId: 'b' });
      e.result.resolve('the second half');
      await tick(); await tick();
      const history = h.brain.calls.at(-1)!.history;
      expect(history).toHaveLength(16);
      expect(history[0].content).toBe('question number 1');
    });

    it('still interrupts her once she has started speaking', async () => {
      const h = harness();
      await speak(h, 't1', 'Check the build.');
      h.brain.feed('First sentence. ');
      await tick(); await tick();
      expect(types(h)).toContain('state:speaking');
      h.session.handleMessage({ type: 'speech_start', turnId: 't2' });
      expect(h.records.at(-1)).toMatchObject({ turnId: 't1', end: 'interrupted' });
      expect(h.records.at(-1)?.reason).toBeUndefined();
      const e2 = h.ears[h.ears.length - 1];
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      e2.result.resolve('Never mind.');
      await tick(); await tick();
      expect(h.brain.calls.at(-1)?.user).toBe('Never mind.'); // not joined to the first request
    });

    it('with Silero, a confirmed candidate while thinking continues the request; while speaking it interrupts', async () => {
      const h = harness({ vad: true });
      h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
      h.vads[0].script.push([0.9, 0.9, 0.9]);
      h.session.handleAudio(Buffer.alloc(3200));
      h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
      h.ears[0].result.resolve('Check the build.');
      await tick(); await tick();
      h.session.handleMessage({ type: 'speech_start', turnId: 't2', lucyAudible: true });
      h.vads[1].script.push([0.9, 0.9, 0.9]);
      h.session.handleAudio(Buffer.alloc(3200));
      await tick();
      expect(h.sent.some((m) => m.type === 'speech_confirmed')).toBe(true);
      expect(h.records[0]).toMatchObject({ turnId: 't1', transcript: 'Check the build.', end: 'interrupted' });
      expect(h.records[0].reason).toMatch(/continued/);
      h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
      h.ears[1].result.resolve('Then fix it.');
      await tick(); await tick();
      expect(h.brain.calls.at(-1)?.user).toBe('Check the build. Then fix it.');
    });
  });

  it('hands the brain the server time the operator began speaking', async () => {
    const seen: number[] = [];
    const h = harness({ streamAnswer: async function* (req) { seen.push(req.speechStartedAt); yield 'Okay.'; } });
    h.clock.t = 5000;
    await speak(h);
    expect(seen).toEqual([5000]);
  });

  it('ends a turn as empty, not as an error, when the brain chose to stay quiet', async () => {
    const h = harness({ streamAnswer: async function* (req) { req.stayQuiet(); } });
    await speak(h);
    expect(types(h)).toContain('done:empty');
    expect(types(h)).not.toContain('done:error');
    expect(h.sent.some((m) => m.type === 'sentence')).toBe(false);
  });

  it('a brain that says nothing without asking to stay quiet is still an error', async () => {
    const h = harness({ streamAnswer: async function* () { /* nothing */ } });
    await speak(h);
    expect(types(h)).toContain('done:error');
  });
});
