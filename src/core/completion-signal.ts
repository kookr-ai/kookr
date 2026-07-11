import { createHash } from 'node:crypto';
import type { AgentEvent, TaskStatus } from './types.js';
import { deriveTurnStateDetails } from './turn-state.js';
import { isTerminalStatus } from './task-status.js';
import type { LatestCompletionSignal } from '../shared/contracts/completion-signal.js';
import type { DeliveryAuthorization } from '../shared/contracts/task.js';

export interface CompletionSignalInput {
  taskId: string;
  agentId: string;
  taskStatus?: TaskStatus;
  events: AgentEvent[];
}

export function deriveLatestCompletionSignal(input: CompletionSignalInput): LatestCompletionSignal | undefined {
  if (input.taskStatus !== 'inProgress') return undefined;

  const details = deriveTurnStateDetails(input.events);
  if (details.turnState !== 'completed_turn') return undefined;
  const stop = details.effectiveEvent;
  if (stop?.type !== 'stop') return undefined;

  const normalizedMessage = normalizeFinalMessage(stop.lastMessage);
  if (!normalizedMessage) return undefined;

  const lastMessageHash = sha256Short(normalizedMessage);
  const turnBoundaryId = stop.turnId ?? findTurnBoundaryId(input.events, details.effectiveEventIndex);
  const stopEventId = `stop:${stop.eventSeq ?? details.effectiveEventIndex}`;
  const id = sha256Short([
    input.taskId,
    input.agentId,
    turnBoundaryId,
    stopEventId,
    lastMessageHash,
  ].join('\u001f'));

  return {
    id,
  };
}

/**
 * What the Stop-hook completion policy decided to do about an in-progress task
 * that just ended a turn (issue #1324).
 *
 *  - `auto_signal`  — policy is unambiguous; raise `completion-ready` for the
 *                     agent (it does not have to run the CLI itself).
 *  - `remediate`    — completion is plausible but not certain; inject ONE
 *                     concise reminder, deduped per task state so the same
 *                     feedback is never repeated on successive Stop attempts.
 *  - `skip`         — do nothing (already signaled, delivery-blocked, turn not
 *                     cleanly complete, or the one remediation already fired).
 */
export type CompletionSignalAction = 'auto_signal' | 'remediate' | 'skip';

/** Machine-readable reason recorded for observability (why auto-signal was accepted/refused). */
export type CompletionSignalReason =
  | 'already_signaled'
  | 'delivery_blocked'
  | 'terminal_status'
  | 'not_in_progress'
  | 'unknown_task'
  | 'turn_incomplete'
  | 'auto_signal_authorized'
  | 'remediation_needed'
  | 'remediation_already_delivered';

export interface CompletionSignalEvaluationInput {
  taskId: string;
  agentId: string;
  /** Persisted task lifecycle status. */
  status?: TaskStatus;
  /** Kind of any pending agent → user signal already raised for the task. */
  pendingSignalKind?: string;
  /** Delivery policy resolved at launch. Absent means the task is not delivery-gated. */
  deliveryAuthorization?: DeliveryAuthorization;
  /**
   * Whether the task's authorized delivery requirements are already satisfied.
   * Only consulted for `ask-first` tasks (`pre-authorized` never gates). Left
   * undefined it is treated as NOT satisfied — the fail-safe that keeps a
   * delivery-gated task from being marked ready before delivery happens.
   */
  deliverySatisfied?: boolean;
  /** Event window used to derive clean-turn completion evidence. */
  events: AgentEvent[];
  /**
   * Fingerprint of the last remediation already delivered for this task, if
   * any. When it equals the current state fingerprint the reminder is
   * suppressed — at most one remediation per task state.
   */
  lastRemediationFingerprint?: string;
}

export interface CompletionSignalDecision {
  action: CompletionSignalAction;
  reason: CompletionSignalReason;
  /** Human-readable justification, recorded so operators can see why we (didn't) auto-signal. */
  detail: string;
  /** Completion-evidence signal id; present whenever a clean completed turn was observed. */
  signalId?: string;
  /**
   * Deterministic fingerprint of the task state behind a `remediate` decision.
   * Callers persist it and pass it back as `lastRemediationFingerprint` so the
   * same reminder is not injected again until the task state changes. Present
   * only for `remediate`.
   */
  stateFingerprint?: string;
}

/**
 * Decide, for a task that just reached the Stop hook, whether Kookr should
 * auto-raise `completion-ready`, inject a one-time remediation, or stay silent
 * (issue #1324). Pure and idempotent: the same state yields the same decision,
 * so re-running it on repeated Stop attempts never produces new noise.
 *
 * Distinct from #1058, which governs what happens AFTER a task already has a
 * `completion_ready` pending signal. Here that case short-circuits to `skip`.
 */
export function evaluateCompletionSignal(input: CompletionSignalEvaluationInput): CompletionSignalDecision {
  // 1. Idempotency: a task that already carries a completion-ready signal needs
  //    no further prompting — signaling again would be a no-op.
  if (input.pendingSignalKind === 'completion_ready') {
    return {
      action: 'skip',
      reason: 'already_signaled',
      detail: 'Task already has a pending completion-ready signal; signaling is idempotent.',
    };
  }

  // 2. Require unambiguous clean-turn evidence. deriveLatestCompletionSignal is
  //    the single source of truth: it already gates on inProgress status, a
  //    completed turn (background tasks/crons keep it `running`), and a
  //    non-empty final message.
  const completion = deriveLatestCompletionSignal({
    taskId: input.taskId,
    agentId: input.agentId,
    taskStatus: input.status,
    events: input.events,
  });
  if (!completion) {
    if (input.status && isTerminalStatus(input.status)) {
      return { action: 'skip', reason: 'terminal_status', detail: `Task is ${input.status}; nothing to signal.` };
    }
    if (input.status && input.status !== 'inProgress') {
      return { action: 'skip', reason: 'not_in_progress', detail: `Task is ${input.status}; not a completion candidate.` };
    }
    return {
      action: 'skip',
      reason: 'turn_incomplete',
      detail: 'No clean completed turn observed (still running, waiting, or no final message).',
    };
  }

  // 3. Delivery gating: an `ask-first` task whose delivery is not yet satisfied
  //    must never be auto-marked ready, and prompting it to signal completion
  //    would be premature. Refuse and record why.
  if (isDeliveryBlocked(input)) {
    return {
      action: 'skip',
      reason: 'delivery_blocked',
      detail: 'Delivery-gated task: authorized delivery not yet satisfied; refusing to signal completion.',
      signalId: completion.id,
    };
  }

  // 4. Unambiguous policy → auto-signal. Only affirmatively delivery-authorized
  //    (or delivery-satisfied) tasks qualify: a clean Stop alone is not a
  //    reliable completion proxy for an un-gated task, so those get a reminder
  //    instead (see step 5).
  if (isAutoSignalAuthorized(input)) {
    return {
      action: 'auto_signal',
      reason: 'auto_signal_authorized',
      detail: input.deliveryAuthorization === 'pre-authorized'
        ? 'Delivery pre-authorized and turn completed cleanly; auto-raising completion-ready.'
        : 'Authorized delivery satisfied and turn completed cleanly; auto-raising completion-ready.',
      signalId: completion.id,
    };
  }

  // 5. Ambiguous but plausibly complete → remediate at most once per state.
  const stateFingerprint = remediationFingerprint(input, completion.id);
  if (input.lastRemediationFingerprint === stateFingerprint) {
    return {
      action: 'skip',
      reason: 'remediation_already_delivered',
      detail: 'Completion reminder already delivered for this task state; suppressing repeat.',
      signalId: completion.id,
      stateFingerprint,
    };
  }
  return {
    action: 'remediate',
    reason: 'remediation_needed',
    detail: 'Turn completed cleanly but completion is not unambiguous; injecting a one-time reminder.',
    signalId: completion.id,
    stateFingerprint,
  };
}

function isDeliveryBlocked(input: CompletionSignalEvaluationInput): boolean {
  return input.deliveryAuthorization === 'ask-first' && input.deliverySatisfied !== true;
}

function isAutoSignalAuthorized(input: CompletionSignalEvaluationInput): boolean {
  if (isDeliveryBlocked(input)) return false;
  return input.deliveryAuthorization === 'pre-authorized' || input.deliverySatisfied === true;
}

function remediationFingerprint(input: CompletionSignalEvaluationInput, signalId: string): string {
  // Bind the reminder to the completion evidence (which shifts whenever the
  // agent does more work or opens a new turn) plus the delivery posture, so a
  // genuine state change re-enables one fresh reminder while an unchanged state
  // stays quiet.
  return sha256Short([
    input.taskId,
    signalId,
    input.deliveryAuthorization ?? 'none',
    input.deliverySatisfied === true ? 'delivered' : 'undelivered',
  ].join('\u001f'));
}

function findTurnBoundaryId(events: AgentEvent[], stopIndex: number): string {
  for (let index = stopIndex - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'user_prompt' || event.type === 'input_received') {
      return `${event.type}:${event.eventSeq ?? index}`;
    }
    if (event.type === 'session_start') {
      return `session_start:${event.eventSeq ?? index}`;
    }
  }
  return 'initial-turn';
}

function normalizeFinalMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

function sha256Short(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
