import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { progress } from './progress.js';
import { UNKNOWN, type ChildFact } from './types.js';

const delivered = (id: string, min: number): ChildFact => ({ taskId: id, name: id, startedAtMs: at(0), ended: { atMs: at(min), status: 'completed', source: 'completion_ready', delivered: true } });
const reclaimed = (id: string, min: number): ChildFact => ({ taskId: id, name: id, startedAtMs: at(0), ended: { atMs: at(min), status: 'terminated', source: 'hung-suspect-ttl', delivered: false } });
const started = (id: string, min: number): ChildFact => ({ taskId: id, name: id, startedAtMs: at(min) });

describe('progress', () => {
  it('a delivered result resets the clock', () => {
    const first = progress(sentinelFacts(), sentinelState(), at(1));
    const r = progress(sentinelFacts({ children: [delivered('w1', 80)] }), first.state, at(81));
    expect(r.decision.decision).toBe('moved');
    expect(r.state.progress.changedAtMs).toBe(at(81));
  });

  it('worker churn (starts, reclaims) is not progress', () => {
    let s = progress(sentinelFacts(), sentinelState(), at(1)).state;
    s = progress(sentinelFacts({ children: [started('w1', 30), reclaimed('w2', 60)] }), s, at(61)).state;
    const r = progress(sentinelFacts({ children: [started('w1', 30), reclaimed('w2', 60), started('w3', 70)] }), s, at(90));
    expect(r.decision.decision).toBe('stall-notice');
  });

  it('90 min unchanged tells the lead once, then 30 min later asks the operator', () => {
    const notice = progress(sentinelFacts(), sentinelState(), at(90));
    expect(notice.decision.decision).toBe('stall-notice');
    const [line] = notice.decision.effects;
    expect(line.kind === 'type-line' && line.text).toContain('[kookr sentinel] no progress for 90 min');
    expect(progress(sentinelFacts(), notice.state, at(100)).decision.decision).toBe('stall-noticed');
    const ask = progress(sentinelFacts(), notice.state, at(120));
    expect(ask.decision.decision).toBe('stall-ask');
    expect(ask.decision.effects[0]).toMatchObject({ kind: 'ask', trigger: 'no-progress', dedupKey: `no-progress:lead-1:${at(0)}` });
    const ids = ask.decision.effects[0].kind === 'ask' ? ask.decision.effects[0].options.map((o) => o.id) : [];
    expect(ids).toEqual(['send-facts', 'nudge', 'snooze-3h']);
  });

  it('holds the ask for 30 min after an operator message', () => {
    const s = sentinelState({ progress: { fingerprint: '', changedAtMs: at(0), noticeAtMs: at(90) } });
    const r = progress(sentinelFacts({ operator: { lastOperatorInputAtMs: at(110) } }), s, at(120));
    expect(r.decision.decision).toBe('ask-held-operator-active');
  });

  it('a live declared job explains the stall until 30 min past its expected end', () => {
    const job = { pid: 99, alive: true, expectedEndAtMs: at(200) };
    expect(progress(sentinelFacts({ handoff: { declaredJobs: [job] } }), sentinelState(), at(150)).decision.decision).toBe('explained-declared-job');
    expect(progress(sentinelFacts({ handoff: { declaredJobs: [job] } }), sentinelState(), at(231)).decision.decision).toBe('stall-notice');
    expect(progress(sentinelFacts({ handoff: { declaredJobs: [{ ...job, alive: false }] } }), sentinelState(), at(150)).decision.decision).toBe('stall-notice');
  });

  it('WAITING ON OPERATOR explains the stall and reminds the operator at most every 4 h', () => {
    const facts = sentinelFacts({ transcript: { markers: [{ kind: 'WAITING ON OPERATOR', atMs: at(95), detail: 'approve #12' }] } });
    const r = progress(facts, sentinelState(), at(100));
    expect(r.decision.decision).toBe('explained-waiting-on-operator');
    expect(r.decision.effects[0]).toMatchObject({ kind: 'alert', dedupKey: `waiting-on-operator:lead-1:${at(95)}:0` });
    const later = progress(facts, sentinelState(), at(95 + 4 * 60));
    expect(later.decision.effects[0]).toMatchObject({ dedupKey: `waiting-on-operator:lead-1:${at(95)}:1` });
  });

  it('unknown workers are "no change observed", never movement (R3)', () => {
    const r = progress(sentinelFacts({ children: UNKNOWN }), sentinelState(), at(90));
    expect(r.decision.decision).toBe('stall-notice');
    expect(r.decision.reason).toContain('workers unknown');
  });
});
