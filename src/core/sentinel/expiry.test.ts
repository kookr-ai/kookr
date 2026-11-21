import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { SENTINEL_ENDED_LINE, expiry } from './expiry.js';

describe('expiry', () => {
  const s = sentinelState({ expiresAtMs: at(600) });

  it('stays active until 1 h before the end', () => {
    expect(expiry(sentinelFacts(), s, at(539)).decision).toMatchObject({ decision: 'active', effects: [] });
  });

  it('asks to renew in the last hour', () => {
    const r = expiry(sentinelFacts(), s, at(540));
    expect(r.decision.decision).toBe('renew-asked');
    expect(r.decision.effects[0]).toMatchObject({ kind: 'ask', trigger: 'renew', dedupKey: `renew:lead-1:${at(600)}` });
  });

  it('on expiry hands keep-alive back to the lead and never mentions completion-ready', () => {
    const r = expiry(sentinelFacts(), s, at(600));
    expect(r.decision.effects).toEqual([
      { kind: 'type-line', trigger: 'expired', text: SENTINEL_ENDED_LINE },
      { kind: 'end-sentinel', trigger: 'expired', reason: 'the sentinel reached its --for limit' },
    ]);
    expect(JSON.stringify(r.decision.effects)).not.toMatch(/completion.ready/i);
  });

  it('does not type into a terminal lead on expiry', () => {
    const r = expiry(sentinelFacts({ lead: { live: false } }), s, at(600));
    expect(r.decision.effects.map((e) => e.kind)).toEqual(['end-sentinel']);
  });
});
