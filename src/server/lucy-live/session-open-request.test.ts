/**
 * "Show me" by voice (#3929): while a question is waiting, Lucy opens its link or the asking task in
 * the browser, and says what the browser reported (opened, blocked, nothing to open).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LucyLiveServerMessage } from '../../shared/contracts/lucy-live.js';
import {
  OPEN_LINK_BLOCKED, OPEN_LINK_OPENED, OPEN_NOTHING_WAITING, OPEN_NO_LINK, OPEN_NO_REPLY, OPEN_TASK_OPENED, OPEN_TASK_UNAVAILABLE,
  type OpenOutcome, type VoiceOpenableAsk,
} from '../../core/lucy-live/open-intent.js';
import type { AnswerMatch, VoiceAskChoice } from '../../core/lucy-live/voice-answer.js';
import { LucyLiveSession, OPEN_REPLY_TIMEOUT_MS, type EarsTurnPort, type LucyLivePorts } from './session.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeEars implements EarsTurnPort {
  private resolveText!: (t: string) => void;
  private readonly text = new Promise<string>((r) => { this.resolveText = r; });
  append(): void {}
  finish(): Promise<string> { return this.text; }
  abort(): void {}
  say(t: string): void { this.resolveText(t); }
}

const MOCKUPS = 'https://claude.ai/artifact/abc-123';
const WITH_LINK: VoiceOpenableAsk = { askId: 'a1', taskId: 't1', links: [{ url: MOCKUPS, label: 'Open mockups' }, { url: 'https://github.com/o/r/pull/7', label: 'Open the PR draft' }] };
const NO_LINK: VoiceOpenableAsk = { askId: 'a2', taskId: 't2', links: [] };
const CHOICE: VoiceAskChoice = { askId: 'a1', question: 'Which variant?', options: ['A', 'B'] };

interface H {
  session: LucyLiveSession;
  sent: LucyLiveServerMessage[];
  said: () => string[];
  opens: () => Array<Extract<LucyLiveServerMessage, { type: 'open' }>>;
  modelCalls: string[];
  matchCalls: string[];
  ears: FakeEars[];
}

/** `browser`: what the browser answers to an `open` request; null: it never answers. */
function harness(opts: { asks?: VoiceOpenableAsk[]; browser?: OpenOutcome | null; openable?: boolean } = {}): H {
  const h = { sent: [], modelCalls: [], matchCalls: [], ears: [] } as unknown as H;
  const browser = opts.browser === undefined ? 'opened' : opts.browser;
  const ports: LucyLivePorts = {
    send: (m) => {
      h.sent.push(m);
      if (m.type === 'open' && browser !== null) {
        queueMicrotask(() => h.session.handleMessage({ type: 'open_result', requestId: m.requestId, outcome: browser }));
      }
    },
    openEars: () => { const e = new FakeEars(); h.ears.push(e); return e; },
    transcribeDraft: () => new Promise(() => {}),
    streamAnswer: (req) => {
      h.modelCalls.push(req.user);
      return (async function* () { yield 'Model answer.'; })();
    },
    synthesize: async (text) => ({ wavBase64: `wav:${text}`, durationMs: 100 }),
    buildBriefing: () => 'BRIEFING',
    pendingAsks: () => [CHOICE],
    matchAnswer: async (req) => { h.matchCalls.push(req.transcript); return { kind: 'none' } as AnswerMatch; },
    answerAsk: async () => ({ ok: true }),
    ...(opts.openable === false ? {} : { openableAsks: () => opts.asks ?? [WITH_LINK] }),
    now: () => 1000,
    warn: () => {},
    recordTurn: () => {},
  };
  h.session = new LucyLiveSession(ports);
  h.said = () => h.sent.filter((m) => m.type === 'sentence').map((m) => (m.type === 'sentence' ? m.text : ''));
  h.opens = () => h.sent.filter((m): m is Extract<LucyLiveServerMessage, { type: 'open' }> => m.type === 'open');
  return h;
}

async function operatorSays(h: H, text: string, id: string, settle: () => Promise<void> = async () => { for (let i = 0; i < 10; i += 1) await tick(); }): Promise<void> {
  h.session.handleMessage({ type: 'speech_start', turnId: id });
  const ears = h.ears[h.ears.length - 1];
  h.session.handleAudio(Buffer.alloc(3200));
  h.session.handleMessage({ type: 'speech_end', turnId: id });
  ears.say(text);
  await settle();
}

afterEach(() => { vi.useRealTimers(); });

describe('"show me" by voice while a question is waiting', () => {
  it.each(['show me', 'Open it.', 'show me the artifact', 'Lucy, show me the mockups please', 'montre-moi la maquette'])(
    '"%s" opens the newest question\'s link and says it is open, without the model',
    async (words) => {
      const h = harness();
      await operatorSays(h, words, 't1');
      expect(h.opens()).toEqual([expect.objectContaining({ target: { kind: 'link', url: MOCKUPS } })]);
      expect(h.said().join(' ')).toBe(OPEN_LINK_OPENED);
      expect(h.modelCalls).toEqual([]);
      expect(h.matchCalls).toEqual([]);
    },
  );

  it('opens the link whose label was named', async () => {
    const h = harness();
    await operatorSays(h, 'open the PR draft', 't1');
    expect(h.opens()[0]?.target).toEqual({ kind: 'link', url: 'https://github.com/o/r/pull/7' });
  });

  it('"show me the task" selects the asking task', async () => {
    const h = harness();
    await operatorSays(h, 'show me the task', 't1');
    expect(h.opens()[0]?.target).toEqual({ kind: 'task', taskId: 't1' });
    expect(h.said().join(' ')).toBe(OPEN_TASK_OPENED);
  });

  it('says the browser blocked the tab when it did, instead of claiming it opened', async () => {
    const h = harness({ browser: 'blocked' });
    await operatorSays(h, 'show me', 't1');
    expect(h.said().join(' ')).toBe(OPEN_LINK_BLOCKED);
  });

  it('says the task cannot be shown when the dashboard has no such task', async () => {
    const h = harness({ browser: 'unavailable' });
    await operatorSays(h, 'open the task', 't1');
    expect(h.said().join(' ')).toBe(OPEN_TASK_UNAVAILABLE);
  });

  it('says there is no link when the question has none, and opens nothing', async () => {
    const h = harness({ asks: [NO_LINK] });
    await operatorSays(h, 'show me the mockups', 't1');
    expect(h.opens()).toEqual([]);
    expect(h.said().join(' ')).toBe(OPEN_NO_LINK);
  });

  it('says nothing is waiting when no question is', async () => {
    const h = harness({ asks: [] });
    await operatorSays(h, 'open it', 't1');
    expect(h.opens()).toEqual([]);
    expect(h.said().join(' ')).toBe(OPEN_NOTHING_WAITING);
  });

  it('says it could not open it when the browser never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness({ browser: null });
    await operatorSays(h, 'show me', 't1', async () => {
      await vi.advanceTimersByTimeAsync(10);
      expect(h.opens()).toHaveLength(1);
      expect(h.said()).toEqual([]);
      await vi.advanceTimersByTimeAsync(OPEN_REPLY_TIMEOUT_MS);
    });
    expect(h.said().join(' ')).toBe(OPEN_NO_REPLY);
  });

  it('leaves ordinary words to the model and the answer matcher', async () => {
    const h = harness();
    await operatorSays(h, 'show me the status of the build', 't1');
    expect(h.opens()).toEqual([]);
    expect(h.matchCalls).toEqual(['show me the status of the build']);
    expect(h.modelCalls).toHaveLength(1);
  });

  it('without the port, "show me" goes to the model as before', async () => {
    const h = harness({ openable: false });
    await operatorSays(h, 'show me', 't1');
    expect(h.opens()).toEqual([]);
    expect(h.modelCalls).toHaveLength(1);
  });

  it('never opens anything from words heard over her own voice', async () => {
    const h = harness();
    await operatorSays(h, 'what is waiting', 't1'); // she answers, so her voice is audible for a moment
    h.session.handleMessage({ type: 'speech_start', turnId: 't2', lucyAudible: true });
    const ears = h.ears[h.ears.length - 1];
    h.session.handleAudio(Buffer.alloc(3200));
    h.session.handleMessage({ type: 'speech_end', turnId: 't2' });
    ears.say('open it');
    for (let i = 0; i < 10; i += 1) await tick();
    expect(h.opens()).toEqual([]);
  });
});
