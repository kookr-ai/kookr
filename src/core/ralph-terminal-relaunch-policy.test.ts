import { describe, it, expect } from 'vitest';
import type { RalphIterationExitReason } from '../shared/contracts/ralph-iteration-log.js';
import {
  classifyTerminalExit,
  escalationDetail,
  type TerminalRelaunchDisposition,
} from './ralph-terminal-relaunch-policy.js';

describe('classifyTerminalExit', () => {
  // A total Record keyed by RalphIterationExitReason: the compiler requires
  // every union member, so adding a 17th exit reason without deciding its
  // disposition breaks this test's build instead of silently defaulting to
  // 'stop'. This makes the mapping self-guarding, not reviewer-guarded.
  const expected: Record<RalphIterationExitReason, TerminalRelaunchDisposition> = {
    // Capped / stalled → relaunch-eligible.
    iteration_cap: 'relaunch',
    target_stalled: 'relaunch',
    all_targets_stalled: 'relaunch',
    // Budget exhausted → escalate to a human.
    cost_cap: 'escalate',
    iteration_cost_cap: 'escalate',
    // Clean success / convergence → stop.
    predicate_satisfied: 'stop',
    zero_diff_convergence: 'stop',
    // User-driven stops → stop.
    cancelled: 'stop',
    paused: 'stop',
    replaced_by_user: 'stop',
    // Failure modes owned elsewhere → stop.
    kookr_crash: 'stop',
    session_dead: 'stop',
    first_hook_miss: 'stop',
    predicate_error: 'stop',
    // Non-terminal-in-practice / forward-compat → stop.
    predicate_timeout: 'stop',
    continued: 'stop',
    unknown: 'stop',
  };

  for (const [reason, disposition] of Object.entries(expected) as Array<
    [RalphIterationExitReason, TerminalRelaunchDisposition]
  >) {
    it(`maps ${reason} → ${disposition}`, () => {
      expect(classifyTerminalExit(reason).disposition).toBe(disposition);
    });
  }

  it('tags budget-exhaustion escalations with a reason', () => {
    expect(classifyTerminalExit('cost_cap')).toEqual({
      disposition: 'escalate',
      escalationReason: 'budget_exhausted',
    });
    expect(classifyTerminalExit('iteration_cost_cap').escalationReason).toBe('budget_exhausted');
  });

  it('does not attach an escalation reason to relaunch/stop dispositions', () => {
    expect(classifyTerminalExit('iteration_cap').escalationReason).toBeUndefined();
    expect(classifyTerminalExit('predicate_satisfied').escalationReason).toBeUndefined();
  });
});

describe('escalationDetail', () => {
  it('distinguishes cumulative vs per-iteration cost caps', () => {
    expect(escalationDetail('budget_exhausted', 'cost_cap')).toMatch(/cumulative cost cap/i);
    expect(escalationDetail('budget_exhausted', 'iteration_cost_cap')).toMatch(/per-iteration cost cap/i);
  });

  it('explains relaunch exhaustion and names the last exit reason', () => {
    const detail = escalationDetail('relaunch_exhausted', 'target_stalled');
    expect(detail).toMatch(/relaunched/i);
    expect(detail).toMatch(/target_stalled/);
  });
});
