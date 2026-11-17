import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LucyLiveServerMessage } from '../../shared/contracts/lucy-live.js';
import { VOICE_ANSWER_CONFIRM_WINDOW_MS, type AnswerMatch, type VoiceAskChoice } from '../../core/lucy-live/voice-answer.js';
import {
  ANNOUNCE_GAP_MS,
  CONFIRM_SPEECH_FRAMES,
  LucyLiveSession,
  MAX_QUEUED_ASKS,
  PROPOSAL_RECHECK_MS,
  UNPROMPTED_ASK_NOTE,
  type ChatTurn,
  type EarsTurnPort,
  type LucyLivePorts,
  type VadTurnPort,
} from './session.js';

/** Lets every pending promise and zero-delay timer run, without moving the clock. */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0); };

class FakeEars implements EarsTurnPort {
  private resolveText!: (t: string) => void;
  private readonly text = new Promise<string>((r) => { this.resolveText = r; });
  append(): void {}
  finish(): Promise<string> { return this.text; }
  abort(): void { this.resolveText(''); }
  say(t: string): void { this.resolveText(t); }
}

class FakeVad implements VadTurnPort {
  script: number[][] = [];
  push(): Promise<number[]> { return Promise.resolve(this.script.shift() ?? []); }
}

const QUESTION = 'The task Cleanup needs your input. When should I run it? You can answer: run it now, or run it tonight.';
const CHOICE: VoiceAskChoice = { askId: 'a1', taskName: 'Cleanup', question: 'When should I run it?', options: ['run it now', 'run it tonight'] };

interface H {
  session: LucyLiveSession;
  sent: LucyLiveServerMessage[];
  ears: FakeEars[];
  vads: FakeVad[];
  /** Waiting questions and the sentence that reads each one out; delete one to close it. */
  asks: Map<string, string>;
  histories: Array<readonly ChatTurn[]>;
  noted: Array<[string, string]>;
  clock: { t: number };
  /** When set, synthesis waits for it: lets a test act before her first sentence is sent. */
  hold: { gate: Promise<void> | null; after: number; perCall?: Array<Promise<void> | undefined> };
  synthSignals: AbortSignal[];
  match: { next: AnswerMatch };
  /** `overlapsAudio` of each request the model was asked to answer. */
  overlaps: boolean[];
  /** What `launchPendingUntil` returns: a launch proposal waiting for its answer until then. */
  launchUntil: number | undefined;
  /** How many times the session asked for it. */
  launchChecks: number;
}

function harness(opts: { vad?: boolean; voiceAnswers?: boolean; noAskSpeech?: boolean } = {}): H {
  const h = {
    sent: [], ears: [], vads: [], asks: new Map([['a1', QUESTION]]), histories: [], noted: [], clock: { t: 10_000 },
    hold: { gate: null, after: 0 }, synthSignals: [], match: { next: { kind: 'none' } }, overlaps: [], launchUntil: undefined, launchChecks: 0,
  } as unknown as H;
  const ports: LucyLivePorts = {
    send: (m) => h.sent.push(m),
    openEars: () => { const e = new FakeEars(); h.ears.push(e); return e; },
    ...(opts.vad ? { openVad: () => { const v = new FakeVad(); h.vads.push(v); return v; } } : {}),
    transcribeDraft: () => new Promise(() => {}),
    streamAnswer: (req) => {
      h.histories.push(req.history);
      h.overlaps.push(req.overlapsAudio);
      return (async function* () { yield 'Status answer.'; })();
    },
    synthesize: async (text, signal) => {
      h.synthSignals.push(signal);
      const own = h.hold.perCall?.[h.synthSignals.length - 1];
      if (own) await own;
      if (h.hold.gate && h.synthSignals.length > h.hold.after) await h.hold.gate;
      if (signal.aborted) throw new Error('aborted');
      return { wavBase64: `wav:${text}`, durationMs: 1000 };
    },
    buildBriefing: () => 'BRIEFING',
    ...(opts.noAskSpeech ? {} : { askSpeech: (askId: string) => h.asks.get(askId) }),
    noteUnprompted: (note, said) => h.noted.push([note, said]),
    launchPendingUntil: () => { h.launchChecks += 1; return h.launchUntil; },
    ...(opts.voiceAnswers ? {
      pendingAsks: () => [CHOICE],
      matchAnswer: async () => h.match.next,
      answerAsk: async () => ({ ok: true as const }),
    } : {}),
    now: () => h.clock.t,
    warn: () => {},
    recordTurn: () => {},
  };
  h.session = new LucyLiveSession(ports);
  return h;
}

/** Move both the session's clock and the timers. */
async function advance(h: H, ms: number): Promise<void> {
  h.clock.t += ms;
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

async function operatorSays(h: H, text: string, id: string, lucyAudible?: boolean): Promise<void> {
  h.session.handleMessage({ type: 'speech_start', turnId: id, ...(lucyAudible === undefined ? {} : { lucyAudible }) });
  const ears = h.ears[h.ears.length - 1];
  h.session.handleAudio(Buffer.alloc(3200));
  h.session.handleMessage({ type: 'speech_end', turnId: id });
  ears.say(text);
  await flush();
}

const turnStarts = (h: H) => h.sent.filter((m): m is Extract<LucyLiveServerMessage, { type: 'turn_start' }> => m.type === 'turn_start');
const sentences = (h: H) => h.sent.filter((m): m is Extract<LucyLiveServerMessage, { type: 'sentence' }> => m.type === 'sentence');
const doneOf = (h: H, turnId: string) => h.sent.find((m) => m.type === 'turn_done' && m.turnId === turnId) as Extract<LucyLiveServerMessage, { type: 'turn_done' }> | undefined;

describe('LucyLiveSession: a task question read out unprompted (#3711)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('says a waiting question at once when she is idle, as a server-started turn, without opening the recogniser', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const [start] = turnStarts(h);
    expect(start).toMatchObject({ type: 'turn_start', askId: 'a1' });
    expect(h.ears).toHaveLength(0);
    expect(sentences(h).map((s) => s.turnId)).toEqual(Array(sentences(h).length).fill(start.turnId));
    expect(sentences(h).map((s) => s.text).join(' ')).toBe(QUESTION);
    expect(doneOf(h, start.turnId)?.end).toBe('answered');
    const states = h.sent.filter((m) => m.type === 'state').map((m) => (m.type === 'state' ? m.state : ''));
    expect(states).toEqual(['thinking', 'speaking', 'idle']);
  });

  it('waits for the operator turn and her answer to finish, and for her voice to fall silent', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    expect(turnStarts(h)).toHaveLength(0); // the operator is speaking
    h.session.handleAudio(Buffer.alloc(3200));
    h.session.handleMessage({ type: 'speech_end', turnId: 't1' });
    h.ears[0].say('Which tasks need me?');
    await flush();
    expect(doneOf(h, 't1')?.end).toBe('answered');
    expect(turnStarts(h)).toHaveLength(0); // her answer (1 s of audio) is still playing
    await advance(h, 1000 + ANNOUNCE_GAP_MS - 10);
    expect(turnStarts(h)).toHaveLength(0);
    await advance(h, 20);
    expect(turnStarts(h)).toHaveLength(1);
    // The answer's sentence went out before the question's.
    expect(sentences(h)[0].turnId).toBe('t1');
  });

  it('waits while a candidate interruption is being checked, and says it once the candidate is rejected', async () => {
    const h = harness({ vad: true });
    h.session.handleMessage({ type: 'speech_start', turnId: 'c1', lucyAudible: true });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    expect(turnStarts(h)).toHaveLength(0);
    h.session.handleMessage({ type: 'speech_end', turnId: 'c1' }); // ended before Silero heard speech
    await flush();
    expect(h.sent.some((m) => m.type === 'speech_rejected')).toBe(true);
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('with Silero, speech that began before her first sentence holds the question back even if a sentence slips out during the check', async () => {
    const h = harness({ vad: true });
    let release!: () => void;
    const never = new Promise<void>(() => {});
    // Her first sentence waits for the test; the others never come, so she is still mid-question.
    h.hold.perCall = [new Promise<void>((r) => { release = r; }), never, never];
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const first = turnStarts(h)[0].turnId;
    // The browser is preparing the question (state thinking), so the operator's voice is a candidate.
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1', lucyAudible: true });
    release();
    await flush();
    expect(sentences(h)).toHaveLength(1); // a sentence went out while Silero was checking
    h.hold.perCall = undefined;
    h.vads[0].script.push(Array(CONFIRM_SPEECH_FRAMES).fill(0.9));
    h.session.handleAudio(Buffer.alloc(3200));
    await flush();
    expect(doneOf(h, first)).toMatchObject({ end: 'interrupted', reason: expect.stringMatching(/^postponed/) });
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[h.ears.length - 1].say('What is new?');
    await flush(); // her answer to the operator goes out first
    expect(turnStarts(h)).toHaveLength(1);
    await advance(h, 20_000);
    const starts = turnStarts(h);
    expect(starts).toHaveLength(2);
    expect(starts[1].askId).toBe('a1');
  });

  it('a question queued during a listening turn is said once that turn is withdrawn as a misfire', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 't1' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    expect(turnStarts(h)).toHaveLength(0);
    h.session.handleMessage({ type: 'speech_cancel', turnId: 't1' });
    await flush();
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('talking over it ducks then stops her as for an answer, and the cut-off question enters the history', async () => {
    const h = harness({ vad: true });
    h.hold.gate = new Promise<void>(() => {});
    h.hold.after = 1; // the first sentence goes out, the rest wait: she is mid-question
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const turnId = turnStarts(h)[0].turnId;
    expect(sentences(h)).toHaveLength(1);
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1', lucyAudible: true });
    expect(doneOf(h, turnId)).toBeUndefined(); // only a candidate: she carries on, ducked by the browser
    h.vads[0].script.push(Array(CONFIRM_SPEECH_FRAMES).fill(0.9));
    h.session.handleAudio(Buffer.alloc(3200));
    await flush();
    expect(h.sent.some((m) => m.type === 'speech_confirmed' && m.turnId === 'op1')).toBe(true);
    expect(doneOf(h, turnId)?.end).toBe('interrupted');
    expect(h.synthSignals.at(-1)?.aborted).toBe(true);
    // The browser reports the first sentence as cut short; then the operator's turn reaches the model.
    h.session.handleMessage({ type: 'played', turnId, seq: 0, complete: false });
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[h.ears.length - 1].say('Say that again');
    await flush();
    const heard = `${sentences(h)[0].text} (interrupted)`;
    expect(h.histories.at(-1)).toEqual([
      { role: 'user', content: UNPROMPTED_ASK_NOTE },
      { role: 'assistant', content: heard },
    ]);
    expect(h.noted).toEqual([[UNPROMPTED_ASK_NOTE, heard]]);
    // An interrupted question is not said again.
    await advance(h, 20_000);
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('speech that begins before her first sentence holds the question back, does not join the request, and says it afterwards', async () => {
    const h = harness();
    let release!: () => void;
    h.hold.gate = new Promise<void>((r) => { release = r; });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const first = turnStarts(h)[0].turnId;
    // The browser had not heard of it yet: no lucyAudible.
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' });
    expect(doneOf(h, first)).toMatchObject({ end: 'interrupted', reason: expect.stringContaining('postponed') });
    expect(h.synthSignals[0].aborted).toBe(true);
    h.hold.gate = null;
    release();
    h.session.handleAudio(Buffer.alloc(3200));
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[0].say('What is running?');
    await flush();
    expect(h.sent.find((m) => m.type === 'transcript' && m.final)).toMatchObject({ text: 'What is running?' });
    expect(h.histories[0]).toEqual([]); // nothing of the unsaid question
    expect(sentences(h).filter((s) => s.turnId === first)).toHaveLength(0);
    await advance(h, 1000 + ANNOUNCE_GAP_MS);
    const again = turnStarts(h);
    expect(again).toHaveLength(2);
    expect(again[1]).toMatchObject({ askId: 'a1' });
    expect(again[1].turnId).not.toBe(first);
    expect(sentences(h).filter((s) => s.turnId === again[1].turnId).map((s) => s.text).join(' ')).toBe(QUESTION);
  });

  it('with Silero, speech the browser did not mark as over her voice is the operator speaking first, not a candidate', async () => {
    const h = harness({ vad: true });
    h.hold.gate = new Promise<void>(() => {});
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' });
    expect(h.sent.some((m) => m.type === 'speech_confirmed' || m.type === 'speech_rejected')).toBe(false);
    expect(h.session.acceptingAudio).toBe(true);
    expect(h.sent.filter((m) => m.type === 'state').at(-1)).toEqual({ type: 'state', state: 'listening' });
  });

  it('a question closed before she began is not said; one closed meanwhile on the server is skipped', async () => {
    const h = harness();
    h.asks.set('a2', 'Second question.');
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    h.session.handleMessage({ type: 'drop_ask', askId: 'a1' });
    await flush();
    expect(turnStarts(h)).toHaveLength(0);
    h.asks.delete('a2'); // answered on Telegram before she got to it
    h.session.handleMessage({ type: 'say_ask', askId: 'a2' });
    await flush();
    expect(turnStarts(h)).toHaveLength(0);
    expect(h.sent).toEqual([]);
  });

  it('a question closed while she reads it stops her', async () => {
    const h = harness();
    h.hold.gate = new Promise<void>(() => {});
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const turnId = turnStarts(h)[0].turnId;
    h.session.handleMessage({ type: 'drop_ask', askId: 'a1' });
    expect(doneOf(h, turnId)).toMatchObject({ end: 'interrupted', reason: expect.stringContaining('closed') });
    expect(h.synthSignals[0].aborted).toBe(true);
    expect(h.noted).toEqual([]);
  });

  it('questions are said one at a time in the order asked, each once', async () => {
    const h = harness();
    h.asks.set('a2', 'Second question.');
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a2' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    expect(turnStarts(h).map((s) => s.askId)).toEqual(['a1']);
    await advance(h, 10_000);
    expect(turnStarts(h).map((s) => s.askId)).toEqual(['a1', 'a2']);
    await advance(h, 10_000);
    expect(turnStarts(h)).toHaveLength(2);
  });

  it('a question she said and the browser played enters the history the model sees next, marked as unprompted', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const turnId = turnStarts(h)[0].turnId;
    for (const s of sentences(h)) h.session.handleMessage({ type: 'played', turnId, seq: s.seq, complete: true });
    await advance(h, 20_000);
    await operatorSays(h, 'What did it ask?', 'op1');
    expect(h.histories[0]).toEqual([
      { role: 'user', content: UNPROMPTED_ASK_NOTE },
      { role: 'assistant', content: QUESTION },
    ]);
    expect(h.noted).toEqual([[UNPROMPTED_ASK_NOTE, QUESTION]]);
  });

  it('a question the browser never reported playing is left out of the history', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    await advance(h, 20_000);
    await operatorSays(h, 'Anything new?', 'op1');
    expect(h.histories[0]).toEqual([]);
    expect(h.noted).toEqual([]); // nor is the operator conversation told of it (#4015)
  });

  it('a read-back waiting for its yes keeps the floor until its window closes', async () => {
    const h = harness({ voiceAnswers: true });
    h.match.next = { kind: 'choice', askId: 'a1', optionIndex: 1 };
    await operatorSays(h, 'run it tonight', 'op1');
    expect(sentences(h).map((s) => s.text).join(' ')).toContain('Shall I send that?');
    // Every fake sentence lasts 1 s, and the window for the yes opens when the last one ends.
    const readBackMs = sentences(h).length * 1000;
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await advance(h, readBackMs + ANNOUNCE_GAP_MS + 100);
    expect(turnStarts(h)).toHaveLength(0);
    await advance(h, VOICE_ANSWER_CONFIRM_WINDOW_MS - ANNOUNCE_GAP_MS - 200);
    expect(turnStarts(h)).toHaveLength(0);
    await advance(h, 200);
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('close() forgets the queue', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    h.session.close();
    await advance(h, 30_000);
    expect(turnStarts(h)).toHaveLength(0);
  });
});

describe('LucyLiveSession: what of a question the operator heard (#4015)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A gate that holds synthesis after the first `after` calls until released. */
  const gate = (h: H, after: number): (() => void) => {
    let release!: () => void;
    h.hold.gate = new Promise<void>((r) => { release = r; });
    h.hold.after = after;
    return () => { h.hold.gate = null; release(); };
  };

  it('the operator conversation is told only what the browser played, once the next answer is asked for', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const turnId = turnStarts(h)[0].turnId;
    const said = sentences(h);
    expect(said.length).toBeGreaterThanOrEqual(3);
    expect(doneOf(h, turnId)?.end).toBe('answered'); // every sentence was sent
    expect(h.noted).toEqual([]); // not yet: the browser has not said what it played
    // The operator cuts in during the second sentence: the choices were never heard.
    h.session.handleMessage({ type: 'played', turnId, seq: 0, complete: true });
    h.session.handleMessage({ type: 'played', turnId, seq: 1, complete: false });
    await operatorSays(h, 'Wait, what?', 'op1', true);
    const heard = `${said[0].text} ${said[1].text} (interrupted)`;
    expect(h.noted).toEqual([[UNPROMPTED_ASK_NOTE, heard]]);
    expect(h.histories[0]).toEqual([
      { role: 'user', content: UNPROMPTED_ASK_NOTE },
      { role: 'assistant', content: heard },
    ]);
    // Told once.
    await advance(h, 5000);
    await operatorSays(h, 'And now?', 'op2');
    expect(h.noted).toHaveLength(1);
  });

  it('a question the browser ignored because the operator had begun to speak is said again, and never noted (turn_start race)', async () => {
    const h = harness();
    const release = gate(h, 1); // sentence 0 goes out before the server sees the operator's speech_start
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const first = turnStarts(h)[0].turnId;
    expect(sentences(h)).toHaveLength(1);
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' });
    expect(doneOf(h, first)?.end).toBe('interrupted');
    // The browser had ignored its turn_start and says so.
    h.session.handleMessage({ type: 'turn_unplayed', turnIds: [first] });
    release();
    h.session.handleAudio(Buffer.alloc(3200));
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[0].say('What is running?');
    await flush();
    expect(h.histories[0]).toEqual([]);
    expect(h.noted).toEqual([]);
    // Her voice was never heard, so the operator's words did not begin over it.
    expect(h.overlaps[0]).toBe(false);
    await advance(h, 1000 + ANNOUNCE_GAP_MS);
    const again = turnStarts(h);
    expect(again.map((t) => t.askId)).toEqual(['a1', 'a1']);
    expect(sentences(h).filter((m) => m.turnId === again[1].turnId).map((m) => m.text).join(' ')).toBe(QUESTION);
  });

  it('a question still being sent that the browser reports unplayed is postponed, whatever was sent of it', async () => {
    const h = harness();
    const release = gate(h, 1);
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const first = turnStarts(h)[0].turnId;
    expect(sentences(h)).toHaveLength(1);
    h.session.handleMessage({ type: 'turn_unplayed', turnIds: [first] });
    expect(doneOf(h, first)).toMatchObject({ end: 'interrupted', reason: expect.stringContaining('postponed') });
    expect(h.synthSignals[0].aborted).toBe(true);
    release();
    await advance(h, ANNOUNCE_GAP_MS);
    expect(turnStarts(h).map((t) => t.askId)).toEqual(['a1', 'a1']);
  });

  it('questions held in the browser and lost to an interruption are said again, in the order asked', async () => {
    const h = harness({ vad: true });
    h.asks.set('a2', 'Second question.');
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    h.session.handleMessage({ type: 'say_ask', askId: 'a2' });
    await flush();
    await advance(h, 10_000);
    const [q1, q2] = turnStarts(h).map((t) => t.turnId);
    expect(doneOf(h, q1)?.end).toBe('answered');
    expect(doneOf(h, q2)?.end).toBe('answered');
    // The browser held both behind other audio; the operator cut in, and it dropped them unplayed.
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1', lucyAudible: true });
    h.vads[0].script.push(Array(CONFIRM_SPEECH_FRAMES).fill(0.9));
    h.session.handleAudio(Buffer.alloc(3200));
    await flush();
    expect(h.sent.some((m) => m.type === 'speech_confirmed' && m.turnId === 'op1')).toBe(true);
    h.session.handleMessage({ type: 'turn_unplayed', turnIds: [q1, q2] });
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[h.ears.length - 1].say('What now?');
    await flush();
    expect(h.histories[0]).toEqual([]);
    expect(h.noted).toEqual([]);
    await advance(h, 10_000);
    await advance(h, 10_000);
    expect(turnStarts(h).map((t) => t.askId)).toEqual(['a1', 'a2', 'a1', 'a2']);
  });

  it('an ended question and the one still being sent go back ahead of the questions still waiting, in order', async () => {
    const h = harness();
    h.asks.set('a2', 'Second question. It has two parts.');
    h.asks.set('a3', 'Third question.');
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const q1 = turnStarts(h)[0].turnId;
    expect(doneOf(h, q1)?.end).toBe('answered');
    const release = gate(h, h.synthSignals.length + 1); // q2's first sentence goes out, the rest wait
    h.session.handleMessage({ type: 'say_ask', askId: 'a2' });
    await advance(h, 10_000);
    const q2 = turnStarts(h)[1].turnId;
    expect(doneOf(h, q2)).toBeUndefined(); // still being sent
    h.session.handleMessage({ type: 'say_ask', askId: 'a3' });
    // The browser held both behind other audio and lost them: q1 had ended on the server, q2 had not.
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' });
    h.session.handleMessage({ type: 'turn_unplayed', turnIds: [q1, q2] });
    release();
    h.session.handleAudio(Buffer.alloc(3200));
    h.session.handleMessage({ type: 'speech_end', turnId: 'op1' });
    h.ears[0].say('What now?');
    await flush();
    for (let i = 0; i < 4; i += 1) await advance(h, 10_000);
    expect(turnStarts(h).map((t) => t.askId)).toEqual(['a1', 'a2', 'a1', 'a2', 'a3']);
  });

  it('a turn_unplayed for a question the browser reported playing is ignored', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await flush();
    const turnId = turnStarts(h)[0].turnId;
    h.session.handleMessage({ type: 'played', turnId, seq: 0, complete: true });
    h.session.handleMessage({ type: 'turn_unplayed', turnIds: [turnId, 'op-unknown'] });
    await advance(h, 20_000);
    expect(turnStarts(h)).toHaveLength(1);
    await operatorSays(h, 'Hm?', 'op1');
    expect(h.noted).toHaveLength(1);
  });

  it('a question waits while a launch proposal waits for its answer, and goes as soon as it is settled', async () => {
    const h = harness();
    h.launchUntil = h.clock.t + 60_000;
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await advance(h, 5000);
    expect(turnStarts(h)).toHaveLength(0);
    // It looks again about once a PROPOSAL_RECHECK_MS, not in a busy loop.
    expect(h.launchChecks).toBeLessThanOrEqual(2 * (5000 / PROPOSAL_RECHECK_MS) + 2);
    h.launchUntil = undefined; // settled from its card: nothing tells the session
    await advance(h, PROPOSAL_RECHECK_MS);
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('a launch proposal whose window has passed no longer holds a question back', async () => {
    const h = harness();
    h.launchUntil = h.clock.t + 2500;
    h.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    await advance(h, 2000);
    expect(turnStarts(h)).toHaveLength(0);
    await advance(h, 1000);
    expect(turnStarts(h)).toHaveLength(1);
  });

  it('a question the server will not keep goes back to the browser', async () => {
    const h = harness();
    h.session.handleMessage({ type: 'speech_start', turnId: 'op1' }); // nothing is said meanwhile
    for (let i = 0; i < MAX_QUEUED_ASKS; i += 1) h.session.handleMessage({ type: 'say_ask', askId: `q${i}` });
    expect(h.sent.filter((m) => m.type === 'ask_refused')).toEqual([]);
    h.session.handleMessage({ type: 'say_ask', askId: 'one-too-many' });
    expect(h.sent.filter((m) => m.type === 'ask_refused')).toEqual([{ type: 'ask_refused', askId: 'one-too-many' }]);
    const plain = harness({ noAskSpeech: true });
    plain.session.handleMessage({ type: 'say_ask', askId: 'a1' });
    expect(plain.sent).toEqual([{ type: 'ask_refused', askId: 'a1' }]);
  });
});
