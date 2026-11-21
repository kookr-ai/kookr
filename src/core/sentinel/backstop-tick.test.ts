import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { BACKSTOP_TICK_LINE, backstopTick } from './backstop-tick.js';
import { UNKNOWN } from './types.js';

describe('backstopTick', () => {
  it('does nothing while the lead showed a sign of life in the last 25 min', () => {
    const r = backstopTick(sentinelFacts({ transcript: { lastAssistantAtMs: at(10) } }), sentinelState(), at(34));
    expect(r.decision.decision).toBe('alive');
    expect(r.decision.effects).toEqual([]);
  });

  it('a screen change counts as a sign of life (a long tool call writes no transcript entry)', () => {
    const facts = sentinelFacts({ transcript: { lastAssistantAtMs: at(0) }, lead: { lastScreenChangeAtMs: at(20) } });
    expect(backstopTick(facts, sentinelState(), at(40)).decision.decision).toBe('alive');
  });

  it('types the tick after 25 min of silence and records it', () => {
    const r = backstopTick(sentinelFacts(), sentinelState(), at(25));
    expect(r.decision.decision).toBe('tick-due');
    expect(r.decision.effects).toEqual([{ kind: 'type-line', trigger: 'backstop-tick', text: BACKSTOP_TICK_LINE }]);
    expect(r.state.backstop.lastTickAtMs).toBe(at(25));
  });

  it('waits 15 min after the tick, then asks the operator; it never closes the lead itself', () => {
    const s = sentinelState({ backstop: { lastTickAtMs: at(25) } });
    expect(backstopTick(sentinelFacts(), s, at(39)).decision.decision).toBe('awaiting-response');
    const r = backstopTick(sentinelFacts(), s, at(40));
    expect(r.decision.decision).toBe('unresponsive');
    const [ask] = r.decision.effects;
    expect(ask).toMatchObject({ kind: 'ask', trigger: 'unresponsive', dedupKey: `unresponsive:lead-1:${at(0)}`, allowFreeText: true });
    expect(ask.kind === 'ask' && ask.question).toContain('Lead LFM3 lead unresponsive for 40 min (last sign of life 10:00)');
    expect(ask.kind === 'ask' && ask.options.map((o) => o.id)).toEqual(['close-reopen', 'leave-it']);
    expect(r.decision.effects.some((e) => e.kind === 'reopen')).toBe(false);
  });

  it('a live descendant process is named in the ask, with a Keep waiting option', () => {
    const facts = sentinelFacts({ lead: { descendants: [{ pid: 4242, command: 'python eval.py', startedAtMs: at(-7) }] } });
    const r = backstopTick(facts, sentinelState({ backstop: { lastTickAtMs: at(25) } }), at(40));
    const [ask] = r.decision.effects;
    expect(ask.kind === 'ask' && ask.question).toContain('python eval.py (pid 4242) has been running for 47 min');
    expect(ask.kind === 'ask' && ask.question).toContain('Close it and reopen kills it');
    expect(ask.kind === 'ask' && ask.options.map((o) => o.id)).toEqual(['close-reopen', 'keep-waiting', 'leave-it']);
  });

  it('a sign of life after the tick resets the episode', () => {
    const facts = sentinelFacts({ transcript: { lastAssistantAtMs: at(30) } });
    const r = backstopTick(facts, sentinelState({ backstop: { lastTickAtMs: at(25) } }), at(45));
    expect(r.decision.decision).toBe('alive');
  });

  it('unknown facts never read as alive: it counts from the sentinel start (R3)', () => {
    const facts = sentinelFacts({ transcript: { lastAssistantAtMs: UNKNOWN }, lead: { lastScreenChangeAtMs: UNKNOWN, descendants: UNKNOWN } });
    const r = backstopTick(facts, sentinelState(), at(26));
    expect(r.decision.decision).toBe('tick-due');
    expect(r.decision.reason).toContain('sign of life unknown');
    const ask = backstopTick(facts, r.state, at(41)).decision.effects[0];
    expect(ask.kind === 'ask' && ask.question).toContain('no sign of life seen since the sentinel started at 10:00');
    expect(ask.kind === 'ask' && ask.question).not.toContain('last sign of life');
    expect(ask.kind === 'ask' && ask.question).toContain('live processes are unknown');
  });

  it('a terminal lead is left to crash recovery', () => {
    const r = backstopTick(sentinelFacts({ lead: { live: false } }), sentinelState(), at(60));
    expect(r.decision.decision).toBe('not-live');
    expect(r.decision.effects).toEqual([]);
  });
});
