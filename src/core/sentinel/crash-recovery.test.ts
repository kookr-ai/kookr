import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { LEAD_CONTRACT_LINE, crashRecovery } from './crash-recovery.js';
import { UNKNOWN, type LeadTerminalFact, type SentinelState } from './types.js';

function terminal(over: Partial<LeadTerminalFact>) {
  return sentinelFacts({
    lead: {
      live: false,
      terminal: { status: 'terminated', transitionSource: 'watchdog', reason: 'timeout', terminalAtMs: at(60), disposition: null, ...over },
    },
  });
}

describe('crashRecovery', () => {
  it.each([
    ['hung-suspect-ttl', 'obsolete'],
    ['hung-suspect-ttl', 'needs-human'], // what a reclaim with no confirmed delivery writes
    ['hung-task-reaper', 'needs-human'],
  ] as const)('reopens a lead reclaimed by %s (%s), keyed on the terminal time', (source, kind) => {
    const r = crashRecovery(terminal({ disposition: { source, kind } }), sentinelState(), at(61));
    expect(r.decision.decision).toBe('reopen');
    expect(r.decision.effects).toEqual([{ kind: 'reopen', trigger: 'reopen', idempotencyKey: `reopen:lead-1:${at(60)}`, reason: `reclaimed by ${source}` }]);
    expect(r.state.crashRecovery).toMatchObject({ reopenCount: 1, lastReopenAtMs: at(61), reopenKeys: [`reopen:lead-1:${at(60)}`] });
  });

  it('a watchdog timeout with no ledger entry is a reclaim too', () => {
    expect(crashRecovery(terminal({}), sentinelState(), at(61)).decision.decision).toBe('reopen');
  });

  it('re-issues the same key without spending budget while the reopen is pending', () => {
    const first = crashRecovery(terminal({ disposition: { source: 'hung-suspect-ttl', kind: 'obsolete' } }), sentinelState(), at(61));
    const again = crashRecovery(terminal({ disposition: { source: 'hung-suspect-ttl', kind: 'obsolete' } }), first.state, at(62));
    expect(again.decision.decision).toBe('reopen-pending');
    expect(again.state.crashRecovery.reopenCount).toBe(1);
  });

  it('waits 30 min between reopens, and stops after 3', () => {
    const reclaim = { disposition: { source: 'hung-suspect-ttl', kind: 'obsolete' as const } };
    const cooling = sentinelState({ crashRecovery: { reopenCount: 1, lastReopenAtMs: at(50), reopenKeys: ['reopen:lead-1:1'] } });
    expect(crashRecovery(terminal(reclaim), cooling, at(61)).decision.decision).toBe('reopen-cooldown');
    expect(crashRecovery(terminal(reclaim), cooling, at(80)).decision.decision).toBe('reopen');
    const spent: SentinelState = sentinelState({ crashRecovery: { reopenCount: 3, reopenKeys: [] } });
    const r = crashRecovery(terminal(reclaim), spent, at(200));
    expect(r.decision.decision).toBe('reopen-budget-exhausted');
    expect(r.decision.effects[0]).toMatchObject({ kind: 'alert', severity: 'critical' });
  });

  it('crash-loop protection wins: crash-recovery · needs-human alerts and never reopens', () => {
    const r = crashRecovery(terminal({ transitionSource: 'restart_recovery', reason: 'server_restart', disposition: { source: 'crash-recovery', kind: 'needs-human' } }), sentinelState(), at(61));
    expect(r.decision.decision).toBe('crash-loop-needs-human');
    expect(r.decision.effects.map((e) => e.kind)).toEqual(['alert']);
  });

  it('crash-recovery · respawned types the contract again, with no reopen', () => {
    const r = crashRecovery(terminal({ transitionSource: 'restart_recovery', disposition: { source: 'crash-recovery', kind: 'respawned' } }), sentinelState(), at(61));
    expect(r.decision.decision).toBe('respawned');
    expect(r.decision.effects).toEqual([{ kind: 'type-line', trigger: 'respawned', text: LEAD_CONTRACT_LINE, dedupKey: `respawned:lead-1:${at(60)}` }]);
  });

  it('a provider failure or anything unlisted alerts without a reopen', () => {
    const r = crashRecovery(terminal({ transitionSource: 'task_self', reason: 'provider_failure' }), sentinelState(), at(61));
    expect(r.decision.decision).toBe('no-reopen');
    expect(r.decision.effects.map((e) => e.kind)).toEqual(['alert']);
  });

  it('an unreadable disposition never reopens (R3)', () => {
    const r = crashRecovery(terminal({ disposition: UNKNOWN }), sentinelState(), at(61));
    expect(r.decision.decision).toBe('disposition-unknown');
    expect(r.decision.effects.some((e) => e.kind === 'reopen')).toBe(false);
  });

  it('a completed lead, or one the operator stopped, ends the sentinel with an info alert', () => {
    const done = crashRecovery(terminal({ status: 'completed', transitionSource: 'task_self', reason: 'completed_normal' }), sentinelState(), at(61));
    expect(done.decision.effects.map((e) => e.kind)).toEqual(['alert', 'end-sentinel']);
    const stopped = crashRecovery(terminal({ status: 'cancelled', transitionSource: 'user', reason: 'manual' }), sentinelState(), at(61));
    expect(stopped.decision.decision).toBe('ended-by-operator');
    expect(stopped.decision.effects.map((e) => e.kind)).toEqual(['alert', 'end-sentinel']);
  });

  it('after "Leave it", a reclaim of that episode alerts instead of reopening', () => {
    const s = sentinelState({ crashRecovery: { reopenCount: 0, reopenKeys: [], suppressedAfterMs: at(45) } });
    const r = crashRecovery(terminal({ disposition: { source: 'hung-suspect-ttl', kind: 'needs-human' } }), s, at(61));
    expect(r.decision.decision).toBe('reclaim-after-leave-it');
  });

  it('completion_ready raised while guarded alerts once and keeps the sentinel', () => {
    const facts = sentinelFacts({ lead: { completionReadyAtMs: at(30) } });
    const r = crashRecovery(facts, sentinelState(), at(31));
    expect(r.decision.decision).toBe('completion-ready-alert');
    expect(r.decision.effects.map((e) => e.kind)).toEqual(['alert']);
    expect(crashRecovery(facts, r.state, at(32)).decision.decision).toBe('live');
  });
});
