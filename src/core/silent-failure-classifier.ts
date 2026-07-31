import type { AgentEvent } from './agent-events.js';
import type { TaskProvenanceKind } from '../shared/contracts/task.js';

/**
 * Silent-failure integrity classifier (issue #1712).
 *
 * A scheduled task that dies on a provider error *before its first tool call*
 * used to be recorded `status=completed`: the agent emitted a single Stop whose
 * final message was literally the provider error string, made zero tool calls,
 * produced nothing, and the completion path happily stamped it done. On
 * 2026-07-30 one such misclassified `529 Overloaded` failure ("Lucy Twice-Daily
 * Repository Idea Scout", task `dae17e59`) drained the primary work lane and
 * starved the pipeline for ~5h — the failure was invisible because it wore a
 * `completed` badge.
 *
 * This module is the root-cause guard: a terminal turn that made **zero tool
 * calls** and whose **final assistant message matches a provider-error pattern**
 * is never a completion. It is a `provider_transient` failure, and for
 * schedule-provenance tasks it is eligible for a bounded auto-retry.
 *
 * Everything here is pure — detection + retry policy only. The completion path
 * (`TaskLifecycleCommands`) owns the side effects (terminate, audit, retry
 * spawn, operator alert).
 */

/**
 * Provider-transient failure class. The only class today; typed as a union so
 * new silent-failure shapes (e.g. context-window aborts) can be added later
 * without widening call sites that already switch on it.
 */
export type TaskFailureClass = 'provider_transient';

/**
 * Max bounded auto-retries for a schedule-provenance provider-transient
 * failure. The proposal (#1712) caps at 2 attempts; after the 2nd retry also
 * fails, no further retries fire and one operator alert is emitted.
 */
export const MAX_PROVIDER_TRANSIENT_RETRIES = 2;

/**
 * Default backoff before a retry fire. The incident recovered on its own only
 * once the next 8h cron came around; a ~10-15 min bounded retry closes that gap
 * without hammering an already-overloaded provider.
 */
export const PROVIDER_TRANSIENT_RETRY_DELAY_MS = 12 * 60 * 1000;

/**
 * Patterns that mark a final assistant message as a provider/transport error
 * rather than real work. Deliberately anchored to the *shapes* the incident and
 * the proposal name — `API Error`, HTTP 429/5xx (503/529 etc.), `Overloaded`,
 * `rate limit` — not to arbitrary occurrences of the word "error", so a message
 * that merely *discusses* an error does not match.
 */
const PROVIDER_ERROR_PATTERNS: readonly RegExp[] = [
  /\bAPI Error\b/i,
  /\bOverloaded\b/i,
  /\brate[\s_-]?limit(?:ed|ing)?\b/i,
  // HTTP status codes providers surface on transient failure: 429 + any 5xx
  // (500-599, which covers Anthropic's 529 "Overloaded"). Bounded to a 3-digit
  // token so a year like "2026" or a byte count never trips it.
  /(?<!\d)(?:429|5\d{2})(?!\d)/,
  /\b(?:overloaded_error|rate_limit_error|api_error|internal_server_error)\b/i,
];

/** Whether `message` matches any provider-transient error pattern. */
export function matchesProviderError(message: string | undefined | null): boolean {
  if (!message) return false;
  return PROVIDER_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Count tool calls in an event window. `tool_use` is the single authoritative
 * "the agent did something" marker — a `tool_error` (e.g. an interrupted call)
 * still proves the agent reached the tool boundary, so it counts too. A run
 * with ≥1 of either did real work and is never reclassified, even if its final
 * message mentions an error (the proposal's explicit no-false-positive rule).
 */
export function countToolCalls(events: readonly AgentEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === 'tool_use' || event.type === 'tool_error') count += 1;
  }
  return count;
}

/**
 * Extract the agent's final message from an event window — the last
 * message-bearing terminal event, scanned from the end. This is the text the
 * completion digest surfaces as its lead bullet; when the turn died on a
 * provider error it *is* the error string.
 */
export function extractFinalMessage(events: readonly AgentEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    switch (event.type) {
      case 'stop':
      case 'subagent_stop':
        if (event.lastMessage) return event.lastMessage;
        break;
      case 'stop_failure':
        // A Stop hook that itself failed carries both the last message and the
        // hook error; prefer the message, fall back to the error text.
        if (event.lastMessage) return event.lastMessage;
        if (event.error) return event.error;
        break;
      case 'error':
        if (event.message) return event.message;
        break;
      default:
        break;
    }
  }
  return undefined;
}

export interface SilentFailureInput {
  /** The task's terminal event window (all sessions). */
  events: readonly AgentEvent[];
  /**
   * Explicit final message override. When omitted it is extracted from
   * `events`. Callers that already derived the digest lead can pass it here.
   */
  finalMessage?: string;
}

/**
 * Whether the event window includes a `session_start`, i.e. we are looking at
 * the session from its very beginning. The monitor keeps only a bounded tail
 * (default 50 events), so on a long, chatty run the early `tool_use` events can
 * age out of the window — a zero-`tool_use` count over a *truncated* window is
 * NOT evidence the run did no work. Requiring the `session_start` to still be
 * in-window makes the zero-tool-call count authoritative and keeps the AC3
 * no-false-positive guarantee robust: a truncated long run (session_start aged
 * out) is never reclassified, only a session we can see start-to-stop.
 */
function hasWholeSessionEvidence(events: readonly AgentEvent[]): boolean {
  return events.some((event) => event.type === 'session_start');
}

/**
 * True iff the terminal shape is a silent provider-error failure: a session we
 * can see from its start (`session_start` in-window) that made **zero** tool
 * calls AND ended on a final message matching a provider-error pattern. This is
 * the exact shape that must never be recorded `completed`.
 */
export function isSilentProviderFailure(input: SilentFailureInput): boolean {
  if (countToolCalls(input.events) > 0) return false;
  if (!hasWholeSessionEvidence(input.events)) return false;
  const finalMessage = input.finalMessage ?? extractFinalMessage(input.events);
  return matchesProviderError(finalMessage);
}

export interface TerminalClassificationInput extends SilentFailureInput {
  /**
   * Launch provenance of the task. Only `schedule`-provenance tasks are
   * eligible for auto-retry — a manual/parent task's operator is present to
   * react, and a schedule fire is the case the incident starved.
   */
  provenanceKind?: TaskProvenanceKind;
  /**
   * How many provider-transient retries this task lineage has already consumed
   * (0 for the original fire, 1 after the first retry, ...). Read from the
   * failing task's `retryAttempt`.
   */
  priorRetryAttempts?: number;
  /** Override the retry cap (tests). Defaults to {@link MAX_PROVIDER_TRANSIENT_RETRIES}. */
  maxRetries?: number;
}

export interface ProviderRetryPlan {
  /** Fire a bounded auto-retry for this failure. */
  schedule: boolean;
  /** 1-based attempt number of the retry being scheduled (only when `schedule`). */
  attempt: number;
  /** Backoff before the retry fires, in ms. */
  delayMs: number;
}

export interface TerminalClassificationPlan {
  /** The terminal shape is a silent provider failure → never `completed`. */
  reclassifyToFailed: boolean;
  /** Failure class stamped on the terminated task (only when reclassified). */
  failureClass?: TaskFailureClass;
  /** The provider-error text that triggered reclassification (audit/detail). */
  matchedMessage?: string;
  /** Tool-call count observed (0 when reclassified; surfaced for audit). */
  toolCallCount: number;
  /** Bounded auto-retry decision. */
  retry: ProviderRetryPlan;
  /**
   * Reclassified, schedule-provenance, but the retry budget is spent → emit a
   * single signal-outbox alert instead of another retry.
   */
  exhausted: boolean;
}

/**
 * Request handed to the injected retry hook when a schedule-provenance
 * provider-transient failure has retry budget left. The hook owns the actual
 * re-launch (backoff timer, task spawn, lineage stamping).
 */
export interface ProviderTransientRetryRequest {
  /** Root of the retry lineage — the ORIGINAL failing task, not an intermediate retry. */
  originalTaskId: string;
  /** The task that just failed (the original fire or a prior retry). */
  failedTaskId: string;
  /** 1-based attempt number of the retry to spawn. */
  attempt: number;
  /** Backoff before the retry fires, in ms. */
  delayMs: number;
  /** Provider-error text that triggered the retry (for the spawned task's context). */
  reason?: string;
}

/**
 * Request handed to the injected alert hook when the retry budget is spent. The
 * hook owns the durable operator alert (signal-outbox entry).
 */
export interface ProviderTransientAlertRequest {
  /** The task whose failure exhausted the retry budget. */
  failedTaskId: string;
  /** Root of the retry lineage. */
  originalTaskId: string;
  /** Total retries consumed before giving up. */
  attempts: number;
  reason?: string;
}

const NO_RETRY: ProviderRetryPlan = { schedule: false, attempt: 0, delayMs: 0 };

/**
 * Classify a terminal turn and, when it is a silent provider failure, decide
 * the bounded-retry / exhaustion policy.
 *
 * - Not a silent provider failure → `{ reclassifyToFailed: false }` (the caller
 *   proceeds with normal completion).
 * - Silent provider failure, schedule provenance, budget remaining → reclassify
 *   + schedule retry `attempt = priorRetryAttempts + 1`.
 * - Silent provider failure, schedule provenance, budget spent → reclassify +
 *   `exhausted` (alert, no retry).
 * - Silent provider failure, non-schedule provenance → reclassify only (an
 *   operator is present; no auto-retry, no alert).
 */
export function planTerminalClassification(
  input: TerminalClassificationInput,
): TerminalClassificationPlan {
  const toolCallCount = countToolCalls(input.events);
  const finalMessage = input.finalMessage ?? extractFinalMessage(input.events);

  if (!isSilentProviderFailure({ events: input.events, finalMessage })) {
    return { reclassifyToFailed: false, toolCallCount, retry: NO_RETRY, exhausted: false };
  }

  const maxRetries = input.maxRetries ?? MAX_PROVIDER_TRANSIENT_RETRIES;
  const priorRetryAttempts = Math.max(0, input.priorRetryAttempts ?? 0);
  const isSchedule = input.provenanceKind === 'schedule';
  const canRetry = isSchedule && priorRetryAttempts < maxRetries;

  return {
    reclassifyToFailed: true,
    failureClass: 'provider_transient',
    matchedMessage: finalMessage,
    toolCallCount,
    retry: canRetry
      ? { schedule: true, attempt: priorRetryAttempts + 1, delayMs: PROVIDER_TRANSIENT_RETRY_DELAY_MS }
      : NO_RETRY,
    // Only a schedule task that has genuinely exhausted its retries alerts; a
    // non-schedule task simply fails without an auto-retry lane to exhaust.
    exhausted: isSchedule && !canRetry,
  };
}
