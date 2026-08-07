import { describe, it, expect } from 'vitest';
import {
  ReapWarningCoordinator,
  MAX_REAP_VETOES,
  REAP_VETO_EXTENSION_MS,
  MAX_PRESENCE_HOLD_MS,
  clampReapGraceSeconds,
  MIN_REAP_GRACE_SECONDS,
  MAX_REAP_GRACE_SECONDS,
} from './reap-warning-coordinator.js';

const GRACE = 120_000;
const base = (over: Partial<Parameters<ReapWarningCoordinator['advance']>[0]> = {}) => ({
  taskId: 't1',
  agentId: 'sess-1',
  silentForMs: 3 * 60 * 60_000,
  now: 1_000_000,
  graceMs: GRACE,
  present: false,
  ...over,
});

describe('ReapWarningCoordinator.advance', () => {
  it('warns on first eligible sight and sets a deadline at now + graceMs', () => {
    const c = new ReapWarningCoordinator();
    const r = c.advance(base());
    expect(r.action).toBe('warn');
    expect(r.warning.deadlineAt).toBe(1_000_000 + GRACE);
    expect(r.warning.keptAliveCount).toBe(0);
    expect(c.activeWarningCount()).toBe(1);
  });

  it('waits while the deadline is in the future', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    const r = c.advance(base({ now: 1_000_000 + GRACE - 1 }));
    expect(r.action).toBe('wait');
    expect(c.activeWarningCount()).toBe(1);
  });

  it('reaps once the deadline passes and drops the warning', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    const r = c.advance(base({ now: 1_000_000 + GRACE }));
    expect(r.action).toBe('reap');
    expect(c.activeWarningCount()).toBe(0);
    expect(c.getWarning('t1')).toBeUndefined();
  });

  it('refreshes silentForMs but keeps warnedAt/deadline stable across waits', () => {
    const c = new ReapWarningCoordinator();
    const first = c.advance(base());
    const warnedAt = first.warning.warnedAt;
    const r = c.advance(base({ now: 1_000_050, silentForMs: 999 }));
    expect(r.warning.warnedAt).toBe(warnedAt);
    expect(r.warning.deadlineAt).toBe(1_000_000 + GRACE);
    expect(r.warning.silentForMs).toBe(999);
  });
});

describe('presence auto-hold', () => {
  it('pushes the deadline forward while present, bounded by the ceiling', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    // 5 minutes later, present: deadline should move to now + grace
    const now = 1_000_000 + 5 * 60_000;
    c.applyPresence('t1', true, now, GRACE);
    const w = c.getWarning('t1')!;
    expect(w.deadlineAt).toBe(now + GRACE);
    expect(w.heldByPresence).toBe(true);
  });

  it('never pushes past warnedAt + MAX_PRESENCE_HOLD_MS', () => {
    const c = new ReapWarningCoordinator();
    const warn = c.advance(base());
    const ceiling = warn.warning.warnedAt + MAX_PRESENCE_HOLD_MS;
    // Near the ceiling, present: deadline clamps to the ceiling, not now+grace.
    const now = ceiling - 10_000;
    c.applyPresence('t1', true, now, GRACE);
    expect(c.getWarning('t1')!.deadlineAt).toBe(ceiling);
  });

  it('stops holding once past the ceiling, letting the task reap', () => {
    const c = new ReapWarningCoordinator();
    const warn = c.advance(base());
    const past = warn.warning.warnedAt + MAX_PRESENCE_HOLD_MS + 1;
    c.applyPresence('t1', true, past, GRACE);
    const w = c.getWarning('t1')!;
    expect(w.heldByPresence).toBe(false);
    // deadline was never pushed past the initial grace window here
    const r = c.advance(base({ now: past, present: true }));
    expect(r.action).toBe('reap');
  });

  it('releases the hold flag when presence is lost', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base({ present: true }));
    expect(c.getWarning('t1')!.heldByPresence).toBe(true);
    c.applyPresence('t1', false, 1_000_100, GRACE);
    expect(c.getWarning('t1')!.heldByPresence).toBe(false);
  });

  it('advance applies presence before the reap check (present task is not reaped at the boundary)', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    // exactly at the original deadline, but present → should wait, not reap
    const r = c.advance(base({ now: 1_000_000 + GRACE, present: true }));
    expect(r.action).toBe('wait');
  });

  it('is a no-op when no warning exists', () => {
    const c = new ReapWarningCoordinator();
    expect(() => c.applyPresence('nope', true, 1, GRACE)).not.toThrow();
    expect(c.getWarning('nope')).toBeUndefined();
  });
});

describe('veto', () => {
  it('rejects a veto when there is no warning (validation)', () => {
    const c = new ReapWarningCoordinator();
    expect(c.veto('t1', 1_000_000)).toEqual({ accepted: false, reason: 'no_warning' });
  });

  it('extends the deadline by REAP_VETO_EXTENSION_MS and increments the count', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    const now = 1_000_050;
    const r = c.veto('t1', now);
    expect(r.accepted).toBe(true);
    const w = c.getWarning('t1')!;
    expect(w.deadlineAt).toBe(now + REAP_VETO_EXTENSION_MS);
    expect(w.keptAliveCount).toBe(1);
    expect(w.heldByPresence).toBe(false);
  });

  it('caps at MAX_REAP_VETOES and then rejects, leaving the warning to reap', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    for (let i = 0; i < MAX_REAP_VETOES; i++) {
      expect(c.veto('t1', 1_000_000 + i).accepted).toBe(true);
    }
    const capped = c.veto('t1', 2_000_000);
    expect(capped).toEqual({ accepted: false, reason: 'cap_reached' });
    // still present (not cleared) so it reaps at the last extended deadline
    expect(c.getWarning('t1')).toBeDefined();
  });

  it('view reports vetoCapReached once the cap is hit', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    for (let i = 0; i < MAX_REAP_VETOES; i++) c.veto('t1', 1_000_000 + i);
    expect(c.view('t1', 2_000_000)!.vetoCapReached).toBe(true);
  });
});

describe('clear / enumeration / view', () => {
  it('clear removes and returns the warning', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    expect(c.clear('t1')?.taskId).toBe('t1');
    expect(c.clear('t1')).toBeUndefined();
  });

  it('warnedTaskIds and clearAll enumerate correctly', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base({ taskId: 'a' }));
    c.advance(base({ taskId: 'b' }));
    expect(new Set(c.warnedTaskIds())).toEqual(new Set(['a', 'b']));
    expect(new Set(c.clearAll())).toEqual(new Set(['a', 'b']));
    expect(c.activeWarningCount()).toBe(0);
  });

  it('view computes remainingMs and never returns negative', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base());
    expect(c.view('t1', 1_000_000)!.remainingMs).toBe(GRACE);
    expect(c.view('t1', 1_000_000 + GRACE + 5_000)!.remainingMs).toBe(0);
    expect(c.view('missing', 1)).toBeUndefined();
  });

  it('snapshotState reports all live warnings', () => {
    const c = new ReapWarningCoordinator();
    c.advance(base({ taskId: 'a' }));
    c.advance(base({ taskId: 'b', present: true }));
    const rows = c.snapshotState(1_000_010);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.taskId === 'b')!.heldByPresence).toBe(true);
  });
});

describe('clampReapGraceSeconds', () => {
  it('clamps below the minimum and above the maximum, and rounds', () => {
    expect(clampReapGraceSeconds(1)).toBe(MIN_REAP_GRACE_SECONDS);
    expect(clampReapGraceSeconds(99_999)).toBe(MAX_REAP_GRACE_SECONDS);
    expect(clampReapGraceSeconds(120.4)).toBe(120);
  });
});
