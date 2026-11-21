import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { RECLAIM_WARNING, workerEvents } from './worker-events.js';
import { UNKNOWN, type ChildFact } from './types.js';

const ended = (id: string, min: number, source: string, delivered = false): ChildFact => ({
  taskId: id, name: id, startedAtMs: at(0), ended: { atMs: at(min), status: 'terminated', source, delivered },
});

describe('workerEvents', () => {
  it('holds an end for a minute to batch, then reports it within 2 min', () => {
    const facts = sentinelFacts({ children: [ended('w1', 10, 'completion_ready', true)] });
    expect(workerEvents(facts, sentinelState(), at(10.5)).decision.decision).toBe('batching');
    const r = workerEvents(facts, sentinelState(), at(11));
    expect(r.decision.decision).toBe('report');
    expect(r.decision.effects).toEqual([{ kind: 'type-line', trigger: 'worker-events', text: '[kookr sentinel] worker w1 ended at 10:10 (completion_ready). Check its job.' }]);
    expect(workerEvents(facts, r.state, at(12)).decision.decision).toBe('none');
  });

  it('batches several ends into one line and warns on a reclaim', () => {
    const facts = sentinelFacts({ children: [ended('w2', 29, 'hung-suspect-ttl'), ended('w1', 26, 'hung-suspect-ttl')] });
    const r = workerEvents(facts, sentinelState(), at(30));
    const [line] = r.decision.effects;
    expect(line.kind === 'type-line' && line.text).toBe(
      `[kookr sentinel] worker w1 ended at 10:26 (hung-suspect-ttl); worker w2 ended at 10:29 (hung-suspect-ttl). Check their jobs. ${RECLAIM_WARNING}`,
    );
  });

  it('two reclaims within 4 h, even across ticks, raise a reclaim-loop alert', () => {
    const first = workerEvents(sentinelFacts({ children: [ended('w1', 10, 'hung-task-reaper')] }), sentinelState(), at(12));
    expect(first.decision.decision).toBe('report');
    const second = workerEvents(sentinelFacts({ children: [ended('w1', 10, 'hung-task-reaper'), ended('w2', 200, 'hung-suspect-ttl')] }), first.state, at(202));
    expect(second.decision.decision).toBe('report-reclaim-loop');
    expect(second.decision.effects[1]).toMatchObject({ kind: 'alert', trigger: 'reclaim-loop', dedupKey: `reclaim-loop:lead-1:${at(10)}` });
  });

  it('reclaims more than 4 h apart are not a loop', () => {
    const first = workerEvents(sentinelFacts({ children: [ended('w1', 10, 'hung-task-reaper')] }), sentinelState(), at(12));
    const second = workerEvents(sentinelFacts({ children: [ended('w1', 10, 'hung-task-reaper'), ended('w2', 300, 'hung-suspect-ttl')] }), first.state, at(302));
    expect(second.decision.decision).toBe('report');
  });

  it('ends from before the sentinel started are not news', () => {
    const r = workerEvents(sentinelFacts({ children: [ended('w0', -5, 'hung-suspect-ttl')] }), sentinelState(), at(1));
    expect(r.decision.decision).toBe('none');
    expect(r.state.workerEvents.reported).toEqual([`w0:${at(-5)}`]);
  });

  it('an unknown end source is shown as the status, without the reclaim warning', () => {
    const child: ChildFact = { taskId: 'w1', name: 'w1', startedAtMs: at(0), ended: { atMs: at(5), status: 'cancelled', source: UNKNOWN, delivered: false } };
    const [line] = workerEvents(sentinelFacts({ children: [child] }), sentinelState(), at(7)).decision.effects;
    expect(line.kind === 'type-line' && line.text).toBe('[kookr sentinel] worker w1 ended at 10:05 (cancelled). Check its job.');
  });

  it('unknown workers report nothing', () => {
    expect(workerEvents(sentinelFacts({ children: UNKNOWN }), sentinelState(), at(5)).decision.decision).toBe('children-unknown');
  });
});
