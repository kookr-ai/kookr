/**
 * Playbook chains (RFC: docs/rfc/rfc-playbook-chains.md).
 *
 * A playbook chain repeats one playbook launch as a sequence of ordinary
 * tasks: when one iteration's task ends, the Kookr server launches the next
 * one itself, until an iteration count or a deadline is reached. The agent
 * never has to remember to spawn its successor.
 *
 * The state lives on each task of the chain (`Task.chain`). The bounds are
 * copied forward unchanged from one iteration to the next; the control fields
 * (`stopRequest`, `ended`) are only ever written on the chain's newest task
 * (its "tip").
 */

/** Why a chain stopped launching iterations. */
export type ChainEndReason =
  /** The configured iteration count was reached. */
  | 'iterations_reached'
  /** The deadline had passed when an iteration finished. */
  | 'deadline_reached'
  /** A time-bounded chain reached its iteration ceiling ({@link CHAIN_TIME_ONLY_SAFETY_CAP}). */
  | 'safety_cap'
  /** An operator or the running agent asked the chain to stop. */
  | 'stopped'
  /** The operator cancelled or manually stopped the current iteration. */
  | 'iteration_cancelled'
  /** Several iterations in a row failed or finished suspiciously fast. */
  | 'runaway'
  /** The next iteration could not be launched after several attempts. */
  | 'launch_failed';

export const CHAIN_END_REASONS: readonly ChainEndReason[] = [
  'iterations_reached',
  'deadline_reached',
  'safety_cap',
  'stopped',
  'iteration_cancelled',
  'runaway',
  'launch_failed',
];

/** A request to stop the chain once the current iteration finishes. */
export interface ChainStopRequest {
  at: string;
  by: 'operator' | 'agent';
  reason?: string;
}

/** Terminal marker of a chain, written on its last task. */
export interface ChainEnded {
  at: string;
  reason: ChainEndReason;
  detail?: string;
}

export interface TaskChainState {
  /** Id of the first task of the chain; shared by every iteration. */
  chainId: string;
  /** 1-based position of this task in the chain. */
  iteration: number;
  /** Count bound. Absent for a purely time-bounded chain. */
  maxIterations?: number;
  /** ISO time bound, checked only when an iteration finishes. */
  deadlineAt?: string;
  /** ISO time the chain was started (creation of iteration 1). */
  startedAt: string;
  /** Consecutive failed-or-too-short iterations immediately before this one. */
  unhealthyStreak: number;
  /**
   * Set once the next iteration exists. Marks this task as settled even if its
   * successor is later deleted or pruned, so the chain is never relaunched from
   * an iteration that already advanced.
   */
  successorTaskId?: string;
  /**
   * Set when the chain's idle backstop closed this iteration because its agent
   * stopped without closing the task. Counts as an unhealthy iteration.
   */
  closedByIdleBackstop?: true;
  /** Set on the tip when someone asked the chain to stop after this iteration. */
  stopRequest?: ChainStopRequest;
  /** Set on the tip when the chain stopped launching. */
  ended?: ChainEnded;
}

/** What a launcher asks for. At least one bound is required. */
export interface ChainSpec {
  maxIterations?: number;
  durationMinutes?: number;
}

export const CHAIN_MAX_ITERATIONS_LIMIT = 200;
export const CHAIN_MAX_DURATION_MINUTES = 7 * 24 * 60;
/** Iteration ceiling for a chain bounded only by time, so it cannot run forever. */
export const CHAIN_TIME_ONLY_SAFETY_CAP = 50;
