/**
 * One tick of the sentinel's guard, as a pure function: run every duty in a fixed order,
 * threading the state, then route the decisions (RFC §2-§3). The service (PR 2 of #4239) only
 * gathers facts, calls this, persists the state, appends the log lines, and, for live duties
 * from P1 on, carries out the routed actions.
 */
import { backstopTick } from './backstop-tick.js';
import { compaction } from './compaction.js';
import { crashRecovery } from './crash-recovery.js';
import { routeDecisions, type RouteResult } from './escalation-router.js';
import { expiry } from './expiry.js';
import { progress } from './progress.js';
import type { Duty, DutyDecision, SentinelFacts, SentinelState } from './types.js';
import { workerEvents } from './worker-events.js';

/** Crash recovery first: a terminal lead makes the live-lead duties no-ops. */
export const DUTY_ORDER: readonly Duty[] = [crashRecovery, backstopTick, workerEvents, compaction, progress, expiry];

export function runGuardTick(facts: SentinelFacts, state: SentinelState, nowMs: number): RouteResult {
  let current = state;
  const decisions: DutyDecision[] = [];
  for (const duty of DUTY_ORDER) {
    const { decision, state: next } = duty(facts, current, nowMs);
    decisions.push(decision);
    current = next;
  }
  return routeDecisions({ decisions, facts, state: current, nowMs });
}
