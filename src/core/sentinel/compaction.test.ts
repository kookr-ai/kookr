import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { compactCommand, compaction } from './compaction.js';
import { UNKNOWN, type SentinelState } from './types.js';

const big = { transcript: { contextTokens: 312_000 } };
const requested = (min: number, over: Partial<SentinelState['compaction']> = {}) =>
  sentinelState({ compaction: { failures: 0, requestedAtMs: at(min), ...over } });

describe('compaction: request', () => {
  it('below 300k does nothing', () => {
    expect(compaction(sentinelFacts(), sentinelState(), at(5)).decision.decision).toBe('below-threshold');
  });

  it('at 300k with a quiet operator, asks the lead for a handoff', () => {
    const r = compaction(sentinelFacts({ ...big, operator: { lastOperatorInputAtMs: at(-30) } }), sentinelState(), at(0));
    expect(r.decision.decision).toBe('handoff-requested');
    const [line] = r.decision.effects;
    expect(line.kind === 'type-line' && line.text).toContain('context 312k. When nothing needs you for the next 5 min, write /runs/lead/handoff.md');
    expect(r.state.compaction.requestedAtMs).toBe(at(0));
  });

  it('waits for 20 min of operator quiet', () => {
    const r = compaction(sentinelFacts({ ...big, operator: { lastOperatorInputAtMs: at(-10) } }), sentinelState(), at(0));
    expect(r.decision.decision).toBe('blocked-operator-active');
  });

  it('unknown operator activity is not quiet, and an unknown context requests nothing (R3)', () => {
    const blocked = compaction(sentinelFacts({ ...big, operator: { lastOperatorInputAtMs: UNKNOWN } }), sentinelState(), at(0));
    expect(blocked.decision).toMatchObject({ decision: 'blocked-operator-unknown', effects: [] });
    expect(blocked.decision.reason).toContain('compaction blocked: operator activity unknown');
    expect(compaction(sentinelFacts({ transcript: { contextTokens: UNKNOWN } }), sentinelState(), at(0)).decision.decision).toBe('context-unknown');
  });
});

describe('compaction: send (R2)', () => {
  const handoff = { handoffMtimeMs: at(3), fleetStateMtimeMs: at(3) };

  it('sends /compact after an assistant HANDOFF READY dated after the request, with both files newer', () => {
    const facts = sentinelFacts({ ...big, transcript: { contextTokens: 312_000, markers: [{ kind: 'HANDOFF READY', atMs: at(4) }] }, handoff });
    const r = compaction(facts, requested(0), at(5));
    expect(r.decision.decision).toBe('compact-sent');
    expect(r.decision.effects).toEqual([{ kind: 'type-line', trigger: 'compact', text: compactCommand('/runs/lead') }]);
    expect(r.state.compaction.sentAtMs).toBe(at(5));
  });

  it('a HANDOFF READY from before the request never sends', () => {
    const facts = sentinelFacts({ transcript: { markers: [{ kind: 'HANDOFF READY', atMs: at(-1) }] }, handoff });
    expect(compaction(facts, requested(0), at(5)).decision.decision).toBe('awaiting-handoff');
  });

  it('stale or missing handoff files never send', () => {
    const facts = sentinelFacts({ transcript: { markers: [{ kind: 'HANDOFF READY', atMs: at(4) }] }, handoff: { handoffMtimeMs: at(3), fleetStateMtimeMs: at(-60) } });
    expect(compaction(facts, requested(0), at(5)).decision.decision).toBe('ready-files-stale');
    const missing = sentinelFacts({ transcript: { markers: [{ kind: 'HANDOFF READY', atMs: at(4) }] }, handoff: { handoffMtimeMs: UNKNOWN, fleetStateMtimeMs: null } });
    expect(compaction(missing, requested(0), at(5)).decision.decision).toBe('ready-files-stale');
  });

  it('HANDOFF LATER defers the next request by 1 h', () => {
    const r = compaction(sentinelFacts({ ...big, transcript: { contextTokens: 312_000, markers: [{ kind: 'HANDOFF LATER', atMs: at(2) }] } }), requested(0), at(3));
    expect(r.decision.decision).toBe('handoff-later');
    expect(r.state.compaction).toMatchObject({ requestedAtMs: undefined, deferredUntilMs: at(62) });
    expect(compaction(sentinelFacts(big), r.state, at(30)).decision.decision).toBe('deferred');
    expect(compaction(sentinelFacts(big), r.state, at(62)).decision.decision).toBe('handoff-requested');
  });

  it('no HANDOFF READY within 1 h clears the request and counts a failure', () => {
    const r = compaction(sentinelFacts(big), requested(0), at(60));
    expect(r.decision.decision).toBe('ready-timeout');
    expect(r.state.compaction).toMatchObject({ requestedAtMs: undefined, failures: 1 });
    expect(r.decision.effects).toEqual([]);
  });
});

describe('compaction: confirm', () => {
  it('a compact_boundary before the send does not confirm; one after it does', () => {
    const s = sentinelState({ compaction: { failures: 0, requestedAtMs: at(0), sentAtMs: at(5) } });
    const before = compaction(sentinelFacts({ transcript: { compactBoundariesAtMs: [at(-30)] } }), s, at(6));
    expect(before.decision.decision).toBe('awaiting-boundary');
    const after = compaction(sentinelFacts({ transcript: { compactBoundariesAtMs: [at(-30), at(5.3)] } }), s, at(6));
    expect(after.decision.decision).toBe('confirmed');
    expect(after.state.compaction).toEqual({ failures: 0, lastSentAtMs: at(5), requestedAtMs: undefined, sentAtMs: undefined, over850kSinceMs: undefined });
  });

  it('no boundary within 15 min clears the field; the second failure in a row alerts', () => {
    const s = sentinelState({ compaction: { failures: 1, requestedAtMs: at(0), sentAtMs: at(5) } });
    const r = compaction(sentinelFacts({ transcript: { compactBoundariesAtMs: UNKNOWN } }), s, at(20));
    expect(r.decision.decision).toBe('confirm-timeout');
    expect(r.state.compaction).toMatchObject({ sentAtMs: undefined, failures: 2 });
    expect(r.decision.effects[0]).toMatchObject({ kind: 'alert', trigger: 'compaction-failed' });
  });
});

describe('compaction: 850k escalation', () => {
  it('asks the operator when nothing was sent for 2 h, even while the request is blocked', () => {
    const facts = sentinelFacts({ transcript: { contextTokens: 860_000 }, operator: { lastOperatorInputAtMs: UNKNOWN } });
    const early = compaction(facts, sentinelState(), at(60));
    expect(early.decision.effects).toEqual([]);
    expect(early.state.compaction.over850kSinceMs).toBe(at(60));
    const r = compaction(facts, early.state, at(120));
    expect(r.decision.decision).toBe('blocked-operator-unknown');
    expect(r.decision.effects[0]).toMatchObject({ kind: 'ask', trigger: 'compact-now', dedupKey: `compact-now:lead-1:${at(60)}` });
  });
});
