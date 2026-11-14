import { describe, expect, it } from 'vitest';
import type { LucyLiveServerMessage } from '../../shared/contracts/lucy-live.js';
import { VOICE_ANSWER_CONFIRM_WINDOW_MS, type AnswerMatch, type VoiceAskChoice } from '../../core/lucy-live/voice-answer.js';
import { LucyLiveSession, type EarsTurnPort, type LucyLivePorts } from './session.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeEars implements EarsTurnPort {
  private resolveText!: (t: string) => void;
  private readonly text = new Promise<string>((r) => { this.resolveText = r; });
  append(): void {}
  finish(): Promise<string> { return this.text; }
  abort(): void {}
  say(t: string): void { this.resolveText(t); }
}

const ASK: VoiceAskChoice = { askId: 'a1', taskName: 'Cleanup', question: 'When should I run it?', options: ['run it now', 'run it tonight', 'skip it'] };
const ASK2: VoiceAskChoice = { askId: 'a2', taskName: 'Deploy', question: 'Which region?', options: ['eu', 'us'] };

interface H {
  session: LucyLiveSession;
  sent: LucyLiveServerMessage[];
  said: () => string[];
  answers: Array<[string, number]>;
  modelCalls: string[];
  matchCalls: string[];
  clock: { t: number };
  pending: { asks: VoiceAskChoice[] };
  match: { next: AnswerMatch | Error };
  answerResult: { value: { ok: true } | { ok: false; reason?: string } };
  ears: FakeEars[];
  /** When set, the next synthesis waits for it: lets a test stop her between two sentences. */
  hold: { gate: Promise<void> | null };
}

function harness(): H {
  const h = {
    sent: [], answers: [], modelCalls: [], matchCalls: [], clock: { t: 1000 }, pending: { asks: [ASK] },
    match: { next: { kind: 'none' } }, answerResult: { value: { ok: true } }, ears: [], hold: { gate: null },
  } as unknown as H;
  const ports: LucyLivePorts = {
    send: (m) => h.sent.push(m),
    openEars: () => { const e = new FakeEars(); h.ears.push(e); return e; },
    transcribeDraft: () => new Promise(() => {}),
    streamAnswer: (req) => {
      h.modelCalls.push(req.user);
      return (async function* () { yield 'Status answer.'; })();
    },
    synthesize: async (text) => {
      if (text.startsWith('Shall') && h.hold.gate) await h.hold.gate;
      return { wavBase64: `wav:${text}`, durationMs: 100 };
    },
    buildBriefing: () => 'BRIEFING',
    pendingAsks: () => h.pending.asks,
    matchAnswer: async (req) => {
      h.matchCalls.push(req.transcript);
      if (h.match.next instanceof Error) throw h.match.next;
      return h.match.next;
    },
    answerAsk: async (askId, optionIndex) => { h.answers.push([askId, optionIndex]); return h.answerResult.value; },
    now: () => h.clock.t,
    warn: () => {},
    recordTurn: () => {},
  };
  h.session = new LucyLiveSession(ports);
  h.said = () => h.sent.filter((m) => m.type === 'sentence').map((m) => (m.type === 'sentence' ? m.text : ''));
  return h;
}

async function operatorSays(h: H, text: string, id: string): Promise<void> {
  h.session.handleMessage({ type: 'speech_start', turnId: id });
  const ears = h.ears[h.ears.length - 1];
  h.session.handleAudio(Buffer.alloc(3200));
  h.session.handleMessage({ type: 'speech_end', turnId: id });
  ears.say(text);
  for (let i = 0; i < 8; i += 1) await tick();
}

/** Propose "run it tonight", let her finish speaking, and return once she is quiet. */
async function proposeTonight(h: H): Promise<void> {
  h.match.next = { kind: 'choice', askId: 'a1', optionIndex: 1 };
  await operatorSays(h, 'run it tonight', 't1');
  expect(h.said().join(' ')).toBe('You want: run it tonight. Shall I send that?');
  h.clock.t += 5000; // her voice has ended
}

describe('answering a question by voice', () => {
  it('reads the choice back, and sends exactly one answer after a clear yes', async () => {
    const h = harness();
    await proposeTonight(h);
    expect(h.answers).toEqual([]);
    expect(h.modelCalls).toEqual([]); // the read-back is not written by the streaming model
    await operatorSays(h, 'Yes!', 't2');
    expect(h.answers).toEqual([['a1', 1]]);
    expect(h.said().at(-1)).toBe('Sent: run it tonight.');
    await operatorSays(h, 'yes', 't3');
    expect(h.answers).toHaveLength(1); // a second yes has nothing to confirm
  });

  it.each([
    ['no', 'no'],
    ['an unrelated sentence', 'what is the weather like'],
    ['a yes inside a longer request', 'yes and also delete the logs'],
  ])('%s sends nothing', async (_name, reply) => {
    const h = harness();
    await proposeTonight(h);
    await operatorSays(h, reply, 't2');
    await operatorSays(h, 'yes', 't3'); // the proposal is gone: a later yes is not a confirmation
    expect(h.answers).toEqual([]);
  });

  it('silence (a timed-out window) sends nothing', async () => {
    const h = harness();
    await proposeTonight(h);
    h.clock.t += VOICE_ANSWER_CONFIRM_WINDOW_MS + 1;
    await operatorSays(h, 'yes', 't2');
    expect(h.answers).toEqual([]);
    expect(h.said().join(' ')).toMatch(/timed out/);
  });

  it('a yes that began over her own voice sends nothing', async () => {
    const h = harness();
    h.match.next = { kind: 'choice', askId: 'a1', optionIndex: 1 };
    await operatorSays(h, 'run it tonight', 't1');
    h.clock.t += 50; // her read-back (100 ms) is still audible
    await operatorSays(h, 'yes', 't2');
    expect(h.answers).toEqual([]);
  });

  it('an interrupted read-back cannot be confirmed', async () => {
    const h = harness();
    h.hold.gate = new Promise(() => {}); // her second sentence never finishes: the operator cuts in first
    h.match.next = { kind: 'choice', askId: 'a1', optionIndex: 1 };
    await operatorSays(h, 'run it tonight', 't1');
    expect(h.said()).toEqual(['You want: run it tonight.']);
    h.session.handleMessage({ type: 'barge_in' });
    await tick();
    h.hold.gate = null;
    h.clock.t += 5000;
    await operatorSays(h, 'yes', 't2');
    expect(h.answers).toEqual([]);
  });

  it('refuses when the question was answered elsewhere between read-back and yes', async () => {
    const h = harness();
    await proposeTonight(h);
    h.pending.asks = [];
    await operatorSays(h, 'yes', 't2');
    expect(h.answers).toEqual([]);
    expect(h.said().at(-1)).toMatch(/not waiting any more/);
  });

  it('refuses when the same question now lists different choices', async () => {
    const h = harness();
    await proposeTonight(h);
    h.pending.asks = [{ ...ASK, options: ['run it now', 'skip it'] }];
    await operatorSays(h, 'yes', 't2');
    expect(h.answers).toEqual([]);
  });

  it('a choice outside the lists the session passed is no choice', async () => {
    const h = harness();
    h.match.next = { kind: 'choice', askId: 'a1', optionIndex: 7 };
    await operatorSays(h, 'run it at dawn', 't1');
    expect(h.said()).toEqual(['Status answer.']);
    h.match.next = { kind: 'choice', askId: 'nope', optionIndex: 0 };
    await operatorSays(h, 'run it now', 't2');
    expect(h.answers).toEqual([]);
  });

  it('falls back to an ordinary answer when the mapping call fails or finds nothing', async () => {
    const h = harness();
    h.match.next = new Error('boom');
    await operatorSays(h, 'run it tonight', 't1');
    h.match.next = { kind: 'none' };
    await operatorSays(h, 'how many tasks are running', 't2');
    expect(h.modelCalls).toEqual(['run it tonight', 'how many tasks are running']);
    expect(h.answers).toEqual([]);
  });

  it('with two questions waiting it names the task, or asks which one', async () => {
    const h = harness();
    h.pending.asks = [ASK, ASK2];
    h.match.next = { kind: 'choice', askId: 'a2', optionIndex: 0 };
    await operatorSays(h, 'eu', 't1');
    expect(h.said().join(' ')).toContain('You want: eu for Deploy.');
    h.clock.t += 5000;
    h.match.next = { kind: 'unclear' };
    await operatorSays(h, 'skip', 't2');
    expect(h.said().at(-1)).toMatch(/Which one do you mean\?/);
    expect(h.answers).toEqual([]);
  });

  it('does not call the mapping model when no question is waiting', async () => {
    const h = harness();
    h.pending.asks = [];
    await operatorSays(h, 'run it tonight', 't1');
    expect(h.matchCalls).toEqual([]);
  });

  it('reports a refused answer in words and never claims it was sent', async () => {
    const h = harness();
    h.answerResult.value = { ok: false, reason: 'already_answered' };
    await proposeTonight(h);
    await operatorSays(h, 'yes', 't2');
    expect(h.said().at(-1)).toMatch(/already answered/);
  });
});
