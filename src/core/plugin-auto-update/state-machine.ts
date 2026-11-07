/**
 * The auto-update audit state machine (RFC Layer 4 / R6 — "Model the
 * states/transitions explicitly and test them").
 *
 * One evaluation of one plugin walks this machine. Transitions are the only
 * legal state changes; {@link nextAutoUpdateState} rejects any other, so the
 * runner cannot silently skip the verify or rollback step. Pure and
 * dependency-free.
 *
 *   evaluating ──skip(reason)────────────▶ skipped        (terminal)
 *   evaluating ──proceed─────────────────▶ applying
 *   applying   ──apply-ok───────────────▶ verifying
 *   applying   ──apply-error────────────▶ failed          (terminal)
 *   verifying  ──verify-ok──────────────▶ applied         (terminal)
 *   verifying  ──verify-fail────────────▶ rolling-back
 *   rolling-back ──restore-ok───────────▶ rolled-back     (terminal)
 *   rolling-back ──restore-fail─────────▶ rollback-failed (terminal)
 */
import type { AutoUpdateEvalState } from '../../shared/contracts/plugins.js';

/** The non-terminal working states plus the terminal {@link AutoUpdateEvalState}s. */
export type AutoUpdateState = 'evaluating' | 'applying' | 'verifying' | 'rolling-back' | AutoUpdateEvalState;

/** The events that drive the machine. */
export type AutoUpdateEvent =
  | 'skip'
  | 'proceed'
  | 'apply-ok'
  | 'apply-error'
  | 'verify-ok'
  | 'verify-fail'
  | 'restore-ok'
  | 'restore-fail';

/** The terminal (accepting) states — an evaluation ends in exactly one of these. */
export const TERMINAL_AUTO_UPDATE_STATES: ReadonlySet<AutoUpdateState> = new Set<AutoUpdateState>([
  'skipped',
  'applied',
  'failed',
  'verify-failed',
  'rolled-back',
  'rollback-failed',
]);

export function isTerminalAutoUpdateState(state: AutoUpdateState): boolean {
  return TERMINAL_AUTO_UPDATE_STATES.has(state);
}

/**
 * Note the extra intermediate: `verify-fail` lands on `verify-failed` so the
 * audit can record the verify failure distinctly, and the runner then issues
 * `restore-ok`/`restore-fail` from there. `verify-failed` is therefore BOTH a
 * recorded terminal state (when the runner only wants to log the verify failure)
 * AND a legal source for the rollback transitions.
 */
const TRANSITIONS: Readonly<Record<string, AutoUpdateState>> = {
  'evaluating|skip': 'skipped',
  'evaluating|proceed': 'applying',
  'applying|apply-ok': 'verifying',
  'applying|apply-error': 'failed',
  'verifying|verify-ok': 'applied',
  'verifying|verify-fail': 'verify-failed',
  'verify-failed|restore-ok': 'rolled-back',
  'verify-failed|restore-fail': 'rollback-failed',
};

/** Raised when an illegal (state, event) pair is attempted — a bug, never operator input. */
export class IllegalAutoUpdateTransitionError extends Error {
  constructor(
    public readonly state: AutoUpdateState,
    public readonly event: AutoUpdateEvent,
  ) {
    super(`Illegal auto-update transition: ${state} --${event}-->`);
    this.name = 'IllegalAutoUpdateTransitionError';
  }
}

/**
 * The next state for `(state, event)`, or throw {@link
 * IllegalAutoUpdateTransitionError} when the pair is not a legal transition.
 * Pure.
 */
export function nextAutoUpdateState(state: AutoUpdateState, event: AutoUpdateEvent): AutoUpdateState {
  const next = TRANSITIONS[`${state}|${event}`];
  if (next === undefined) throw new IllegalAutoUpdateTransitionError(state, event);
  return next;
}
