/**
 * Supervisor remote-action surface (issue #1526 Phase B / FM12, FM16). REST
 * contract shapes for the mutating task-lifecycle endpoints a supervising
 * agent (or any non-dashboard caller — CLI, a chat bot like Lucy) uses to
 * inspect and unblock a wedged Kookr instance: `POST /api/tasks/:id/complete`,
 * `POST /api/tasks/abort`, and `POST /api/tasks/completion-ready/ack-all`.
 * See docs/reference/api.md ("Supervisor Surface") for the full reference.
 */

/**
 * Optional caller-identity header accepted on every mutating task route.
 * Absent → the server records the actor as {@link UNATTRIBUTED_ACTOR_ID}
 * rather than rejecting the request (backward compatible) and logs one
 * deprecation-style warning per source per process boot. Example values:
 * `lucy-supervisor`, `dashboard`, `agent:<taskId>`, `cli`.
 */
export const SUPERVISOR_ACTOR_HEADER = 'x-kookr-actor';

/** Recorded actor id when a mutating request carries no {@link SUPERVISOR_ACTOR_HEADER}. */
export const UNATTRIBUTED_ACTOR_ID = 'unattributed';

/**
 * Standard bearer-auth header, checked against `KOOKR_SUPERVISOR_TOKEN` when
 * that env var is set. Applies only to the supervisor verbs documented in
 * docs/reference/api.md ("Supervisor Surface") — GETs are always open.
 */
export const SUPERVISOR_AUTH_HEADER = 'authorization';

export interface AckAllCompletionReadyRequestBody {
  /** Complete every stale entry regardless of auto-close policy. Default false. */
  force?: boolean;
}

export type AckAllCompletionReadyOutcome =
  | 'completed'
  | 'already_terminal'
  | 'partial_ralph_completion'
  | 'invalid'
  | 'not_found'
  | 'failed';

export interface AckAllCompletionReadyTaskResult {
  taskId: string;
  outcome: AckAllCompletionReadyOutcome;
  status?: string;
  error?: string;
}

export interface AckAllCompletionReadySummary {
  /** Stale completion_ready entries matched under the current filter (canAutoClose-only, or all-stale under force). */
  matched: number;
  completed: number;
  already_terminal: number;
  partial_ralph_completion: number;
  invalid: number;
  not_found: number;
  failed: number;
}

export interface AckAllCompletionReadyResponse {
  force: boolean;
  results: AckAllCompletionReadyTaskResult[];
  summary: AckAllCompletionReadySummary;
}
