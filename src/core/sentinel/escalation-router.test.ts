import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { DEDUP_RETENTION_MS, DRY_RUN_TAG, GUARD_LOG_SCHEMA_VERSION, releaseDedupKey, routeDecisions, sentinelAskSystemId } from './escalation-router.js';
import type { DutyDecision } from './types.js';

const ask: DutyDecision = {
  duty: 'expiry',
  decision: 'renew-asked',
  reason: 'expires soon',
  effects: [{ kind: 'ask', trigger: 'renew', question: 'Renew it?', options: [{ id: 'renew-3d', label: 'Renew 3 days' }], allowFreeText: false, dedupKey: 'renew:lead-1:1' }],
};
const nothing: DutyDecision = { duty: 'backstop', decision: 'alive', reason: 'last sign of life 10:00', effects: [] };
const line = (text: string): DutyDecision => ({ duty: 'worker-events', decision: 'report', reason: 'r', effects: [{ kind: 'type-line', trigger: 'worker-events', text }] });

describe('routeDecisions', () => {
  it('in P0 every action is a dry run, and asks carry the header and the DRY RUN tag', () => {
    const r = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: sentinelState(), nowMs: at(1) });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ channel: 'system-ask', dryRun: true, text: `[sentinel · LFM3 lead · renew] Renew it? ${DRY_RUN_TAG}` });
  });

  it('a live duty routes without the tag', () => {
    const r = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: sentinelState({ liveDuties: ['expiry'] }), nowMs: at(1) });
    expect(r.actions[0]).toMatchObject({ dryRun: false, text: '[sentinel · LFM3 lead · renew] Renew it?' });
  });

  it('writes one versioned log line per decision, including "nothing" (R5)', () => {
    const r = routeDecisions({ decisions: [nothing, ask], facts: sentinelFacts(), state: sentinelState(), nowMs: at(1) });
    expect(r.log).toEqual([
      { schemaVersion: GUARD_LOG_SCHEMA_VERSION, at: new Date(at(1)).toISOString(), sentinelId: 'abcdef12-3456-7890-abcd-ef1234567890', leadTaskId: 'lead-1', duty: 'backstop', decision: 'alive', reason: 'last sign of life 10:00', dryRun: true, actions: [] },
      expect.objectContaining({ duty: 'expiry', actions: [expect.objectContaining({ channel: 'system-ask', dedupKey: 'renew:lead-1:1' })] }),
    ]);
  });

  it('dedups a key for 7 days, past the 2-hour ask timeout, and a released key is asked again (R6, R10)', () => {
    const first = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: sentinelState(), nowMs: at(1) });
    expect(first.state.dedup['renew:lead-1:1']).toBe(at(1) + DEDUP_RETENTION_MS);
    const second = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: first.state, nowMs: at(1 + 180) });
    expect(second.actions).toEqual([]);
    expect(second.log[0].actions[0]).toMatchObject({ suppressed: 'dedup' });
    const released = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: releaseDedupKey(first.state, 'renew:lead-1:1'), nowMs: at(2) });
    expect(released.actions).toHaveLength(1);
    const expired = routeDecisions({ decisions: [ask], facts: sentinelFacts(), state: first.state, nowMs: at(1) + DEDUP_RETENTION_MS });
    expect(expired.actions).toHaveLength(1);
  });

  it('after a compact_boundary newer than the last guard line, the next line starts with the re-read reminder, once', () => {
    const facts = sentinelFacts({ transcript: { compactBoundariesAtMs: [at(5)] } });
    const r = routeDecisions({ decisions: [line('[kookr sentinel] worker a ended.'), line('[kookr sentinel] worker b ended.')], facts, state: sentinelState({ lastGuardLineAtMs: at(4) }), nowMs: at(6) });
    expect(r.actions.map((a) => a.text)).toEqual([
      '[kookr sentinel] compacted: re-read /runs/lead/handoff.md first. worker a ended.',
      '[kookr sentinel] worker b ended.',
    ]);
    expect(r.state.lastGuardLineAtMs).toBe(at(6));
    const next = routeDecisions({ decisions: [line('[kookr sentinel] x')], facts, state: r.state, nowMs: at(7) });
    expect(next.actions[0].text).toBe('[kookr sentinel] x');
  });

  it('a boundary from before the sentinel started adds no prefix', () => {
    const facts = sentinelFacts({ transcript: { compactBoundariesAtMs: [at(-30)] } });
    const r = routeDecisions({ decisions: [line('[kookr sentinel] x')], facts, state: sentinelState(), nowMs: at(6) });
    expect(r.actions[0].text).toBe('[kookr sentinel] x');
  });

  it('never prefixes a /compact command', () => {
    const facts = sentinelFacts({ transcript: { compactBoundariesAtMs: [at(5)] } });
    const r = routeDecisions({ decisions: [line('/compact keep it')], facts, state: sentinelState(), nowMs: at(6) });
    expect(r.actions[0].text).toBe('/compact keep it');
  });
});

describe('sentinelAskSystemId', () => {
  it('fits AskService.createSystem ids', () => {
    expect(sentinelAskSystemId('ABCDEF12-3456')).toBe('sentinel-abcdef12');
    expect(sentinelAskSystemId('abcdef12-3456')).toMatch(/^[a-z0-9-]{1,40}$/);
  });
});
