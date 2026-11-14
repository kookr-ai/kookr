/**
 * Pure policy for playbook chains (RFC: docs/rfc/rfc-playbook-chains.md).
 *
 * The server's chain advancer calls these functions on the chain's newest task
 * (the "tip") each sweep. Nothing here does I/O: it validates a launch spec,
 * classifies how an iteration ended, decides what the chain does next, and
 * renders the short notice prepended to each iteration's prompt.
 *
 * Two steps, kept apart on purpose:
 *  1. {@link classifyIteration} turns the tip's task record into an outcome
 *     (still running / stopped by the operator / finished healthy / finished
 *     unhealthy). It only reads what the task lifecycle already recorded.
 *  2. {@link decideChainStep} applies the chain's own policy — bounds, stop
 *     requests, the runaway breaker — to that outcome.
 */

import {
  CHAIN_MAX_DURATION_MINUTES,
  CHAIN_MAX_ITERATIONS_LIMIT,
  CHAIN_TIME_ONLY_SAFETY_CAP,
  type ChainEndReason,
  type ChainSpec,
  type TaskChainState,
} from '../shared/contracts/playbook-chain.js';
import type { TaskStatus } from './types.js';

/** An iteration that finished faster than this counts as unhealthy. */
export const CHAIN_MIN_HEALTHY_ITERATION_MS = 2 * 60_000;
/** This many unhealthy iterations in a row end the chain with `runaway`. */
export const CHAIN_RUNAWAY_STREAK = 3;
/** This many consecutive failed successor launches end the chain with `launch_failed`. */
export const CHAIN_MAX_LAUNCH_FAILURES = 3;

export type ChainSpecValidation =
  | { ok: true; value: ChainSpec }
  | { ok: false; error: string };

/**
 * Validate a launcher-supplied chain spec. At least one bound is required;
 * both may be given, and the first one reached wins.
 */
export function validateChainSpec(raw: unknown): ChainSpecValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'chain must be an object with maxIterations and/or durationMinutes' };
  }
  const { maxIterations, durationMinutes } = raw as Record<string, unknown>;
  const value: ChainSpec = {};
  if (maxIterations !== undefined && maxIterations !== null) {
    if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > CHAIN_MAX_ITERATIONS_LIMIT) {
      return { ok: false, error: `chain.maxIterations must be an integer from 1 to ${CHAIN_MAX_ITERATIONS_LIMIT}` };
    }
    value.maxIterations = maxIterations as number;
  }
  if (durationMinutes !== undefined && durationMinutes !== null) {
    if (!Number.isInteger(durationMinutes) || (durationMinutes as number) < 1 || (durationMinutes as number) > CHAIN_MAX_DURATION_MINUTES) {
      return { ok: false, error: `chain.durationMinutes must be an integer from 1 to ${CHAIN_MAX_DURATION_MINUTES}` };
    }
    value.durationMinutes = durationMinutes as number;
  }
  if (value.maxIterations === undefined && value.durationMinutes === undefined) {
    return { ok: false, error: 'chain needs maxIterations, durationMinutes, or both' };
  }
  return { ok: true, value };
}

/**
 * Chain state for iteration 1. `chainId` is filled in by the caller once the
 * first task exists (it is that task's id); until then it is empty.
 */
export function initialChainState(spec: ChainSpec, now: Date): TaskChainState {
  return {
    chainId: '',
    iteration: 1,
    ...(spec.maxIterations !== undefined ? { maxIterations: spec.maxIterations } : {}),
    ...(spec.durationMinutes !== undefined
      ? { deadlineAt: new Date(now.getTime() + spec.durationMinutes * 60_000).toISOString() }
      : {}),
    startedAt: now.toISOString(),
    unhealthyStreak: 0,
  };
}

/** The fields of a task the chain policy reads. */
export interface ChainTipView {
  status: TaskStatus;
  chain: TaskChainState;
  createdAt: Date | string;
  finishedAt?: Date | string;
  /** Earliest session start, if a session ever started. */
  firstSessionAt?: Date | string;
  /** Number of agent sessions the task ever had; 0 for a task whose launch failed. */
  sessionCount: number;
  terminalReceipt?: { source?: string; reason?: string };
}

export type IterationOutcome =
  /** Not terminal yet. */
  | { kind: 'running' }
  /** The operator cancelled or manually terminated it — the chain ends. */
  | { kind: 'operator_stopped' }
  /**
   * It finished; `healthy` is false for a failed, idle-closed or suspiciously
   * short run. `neverStarted` marks a task whose launch failed before any
   * agent session existed.
   */
  | { kind: 'finished'; healthy: boolean; why?: string; neverStarted?: true };

/**
 * How did the tip's iteration end? Reads only what the task lifecycle already
 * recorded: status and the terminal receipt (who drove the transition and
 * why). Startup recovery has already run by the time the advancer looks at a
 * tip (the advancer is started after it), so a `terminated` task here is one
 * recovery chose not to resume.
 */
export function classifyIteration(tip: ChainTipView): IterationOutcome {
  if (tip.status !== 'completed' && tip.status !== 'cancelled' && tip.status !== 'terminated') {
    return { kind: 'running' };
  }
  if (tip.status !== 'completed' && tip.terminalReceipt?.source === 'user') {
    return { kind: 'operator_stopped' };
  }
  if (tip.sessionCount === 0) {
    return { kind: 'finished', healthy: false, why: 'the iteration never started (launch failed)', neverStarted: true };
  }
  if (tip.status !== 'completed') {
    const reason = tip.terminalReceipt?.reason;
    return { kind: 'finished', healthy: false, why: `iteration ${tip.status}${reason ? ` (${reason})` : ''}` };
  }
  if (tip.chain.closedByIdleBackstop) {
    return { kind: 'finished', healthy: false, why: 'the agent stopped without closing its task' };
  }
  const startMs = toMs(tip.firstSessionAt) ?? toMs(tip.createdAt);
  const endMs = toMs(tip.finishedAt);
  if (startMs !== undefined && endMs !== undefined && endMs - startMs < CHAIN_MIN_HEALTHY_ITERATION_MS) {
    return { kind: 'finished', healthy: false, why: 'iteration finished in under 2 minutes' };
  }
  return { kind: 'finished', healthy: true };
}

export type ChainDecision =
  | { kind: 'wait' }
  | { kind: 'end'; reason: ChainEndReason; detail?: string }
  /** Launch the next iteration with this chain state. */
  | { kind: 'launch'; next: TaskChainState };

/**
 * What should the chain do now that its tip is in this state? Already-ended
 * chains always `wait` (nothing left to do). For a finished iteration the
 * first matching rule wins: stop request, iteration count, deadline, safety
 * cap, runaway breaker, otherwise launch the next iteration.
 */
export function decideChainStep(tip: ChainTipView, now: Date): ChainDecision {
  const chain = tip.chain;
  if (chain.ended) return { kind: 'wait' };
  const outcome = classifyIteration(tip);
  if (outcome.kind === 'running') return { kind: 'wait' };
  if (outcome.kind === 'operator_stopped') {
    return { kind: 'end', reason: 'iteration_cancelled', detail: `iteration ${chain.iteration} was ${tip.status} by the operator` };
  }

  if (chain.stopRequest) {
    return { kind: 'end', reason: 'stopped', ...(chain.stopRequest.reason ? { detail: chain.stopRequest.reason } : {}) };
  }
  if (chain.maxIterations !== undefined && chain.iteration >= chain.maxIterations) {
    return { kind: 'end', reason: 'iterations_reached', detail: `${chain.iteration} of ${chain.maxIterations} iterations ran` };
  }
  if (chain.deadlineAt !== undefined && Date.parse(chain.deadlineAt) <= now.getTime()) {
    return { kind: 'end', reason: 'deadline_reached', detail: `deadline ${chain.deadlineAt} passed after iteration ${chain.iteration}` };
  }
  if (chain.maxIterations === undefined && chain.iteration >= CHAIN_TIME_ONLY_SAFETY_CAP) {
    return { kind: 'end', reason: 'safety_cap', detail: `a time-bounded chain stops after ${CHAIN_TIME_ONLY_SAFETY_CAP} iterations` };
  }
  const unhealthyStreak = outcome.healthy ? 0 : chain.unhealthyStreak + 1;
  if (unhealthyStreak >= CHAIN_RUNAWAY_STREAK) {
    return {
      kind: 'end',
      reason: outcome.kind === 'finished' && outcome.neverStarted ? 'launch_failed' : 'runaway',
      detail: `${unhealthyStreak} unhealthy iterations in a row; last: ${outcome.why ?? 'unhealthy'}`,
    };
  }
  return { kind: 'launch', next: nextIterationState(chain, unhealthyStreak) };
}

/** Bounds copied forward, control fields reset, position advanced. */
function nextIterationState(chain: TaskChainState, unhealthyStreak: number): TaskChainState {
  return {
    chainId: chain.chainId,
    iteration: chain.iteration + 1,
    ...(chain.maxIterations !== undefined ? { maxIterations: chain.maxIterations } : {}),
    ...(chain.deadlineAt !== undefined ? { deadlineAt: chain.deadlineAt } : {}),
    startedAt: chain.startedAt,
    unhealthyStreak,
  };
}

/**
 * Short block prepended to every iteration's prompt. Informational: the chain
 * continues even if the agent ignores it. Its job is to stop an agent from
 * also spawning a successor out of habit, and to tell it how to end the chain
 * when there is no work left.
 */
export function renderChainPreamble(chain: TaskChainState): string {
  const bounds: string[] = [];
  if (chain.maxIterations !== undefined) bounds.push(`of ${chain.maxIterations}`);
  const until = chain.deadlineAt ? ` (runs until ${formatUtc(chain.deadlineAt)})` : '';
  return [
    `## Kookr chain — iteration ${chain.iteration}${bounds.length > 0 ? ` ${bounds.join(' ')}` : ''}${until}`,
    '',
    'This task is one iteration of a Kookr playbook chain. Kookr launches the next',
    'iteration automatically after this task completes. Do NOT spawn a successor',
    'task for this chain yourself, even if the instructions below say to.',
    'Do one iteration of the playbook below, then finish the way you normally do.',
    'If there is no work left, or continuing would cause harm, end the chain with:',
    '  kookr chain stop --reason "<why>"',
  ].join('\n');
}

/** Human label for an end reason, used by the CLI and the dashboard badge. */
export function chainEndReasonLabel(reason: ChainEndReason): string {
  switch (reason) {
    case 'iterations_reached': return 'all iterations ran';
    case 'deadline_reached': return 'deadline reached';
    case 'safety_cap': return 'safety cap reached';
    case 'stopped': return 'stopped';
    case 'iteration_cancelled': return 'iteration cancelled';
    case 'runaway': return 'stopped: iterations kept failing';
    case 'launch_failed': return 'next iteration failed to launch';
  }
}

function toMs(value: Date | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
