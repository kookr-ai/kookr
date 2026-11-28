/**
 * Wire contract for managing named Claude accounts from the dashboard
 * (follow-up to #4236; see docs/reference/claude-accounts.md).
 *
 * The registry lives in `~/.kookr/claude-accounts.json`. Tokens are
 * write-only over this API: a request may carry one, a response never does.
 */

/** One account as the dashboard sees it. Never carries the token. */
export interface ClaudeAccountView {
  /** `host` (the host's own `claude login`) or a registered account name. */
  name: string;
  /** Operator-chosen display label, for example the account's email address. */
  label?: string;
  /** True for the account new tasks launch on when they name none. */
  isDefault: boolean;
  /** Last four characters of the token; absent for `host`. */
  tokenHint?: string;
  /** ISO time the account was added or its token last replaced; absent for `host`. */
  addedAt?: string;
}

/** `GET /api/claude-accounts`, and the body of every successful mutation. */
export interface ClaudeAccountsResponse {
  /** `host` first, then registered accounts in name order. */
  accounts: ClaudeAccountView[];
  /** Name of the default account (`host` when none is set). */
  default: string;
}

/** `POST /api/claude-accounts`: add an account, or replace its token and label. */
export interface AddClaudeAccountRequest {
  name: string;
  /** The bare token or the whole output of `claude setup-token`. */
  token: string;
  label?: string;
  makeDefault?: boolean;
}

/** `PUT /api/claude-accounts/default`. */
export interface SetDefaultClaudeAccountRequest {
  name: string;
}

/**
 * Result of one tiny `claude -p` request on an account.
 * - `ok`: the account answered.
 * - `usage_limited`: it authenticated but is out of plan quota.
 * - `auth_failed`: the token was refused (expired, revoked, mistyped).
 * - `error`: anything else (CLI missing, timeout, network).
 */
export type ClaudeAccountTestOutcome = 'ok' | 'usage_limited' | 'auth_failed' | 'error';

/**
 * One usage window as the probe's `rate_limit_event` reported it, in the units
 * of the host's `QuotaWindow` so the same bars can render it.
 */
export interface ClaudeAccountQuotaWindow {
  /** Percent of the window used, 0-100. */
  utilization: number;
  /** ISO time the window resets. */
  resetsAt: string;
  /** Claude Code's status for the window: `allowed`, `allowed_warning` (close to the limit) or `rejected`. */
  status?: string;
}

/** The account's plan usage at test time. A window Claude Code did not report is absent. */
export interface ClaudeAccountQuota {
  fiveHour?: ClaudeAccountQuotaWindow;
  sevenDay?: ClaudeAccountQuotaWindow;
}

/** `POST /api/claude-accounts/:name/test`. */
export interface ClaudeAccountTestResponse {
  name: string;
  outcome: ClaudeAccountTestOutcome;
  /** One human-readable line, secret-free, at most 300 characters. */
  message: string;
  /** ISO time the test finished. */
  testedAt: string;
  /** Usage measured by this test; absent when Claude Code reported none. */
  quota?: ClaudeAccountQuota;
}

/** Error body of a refused accounts request. */
export interface ClaudeAccountsErrorResponse {
  error: string;
  code:
    | 'invalid_name'
    | 'reserved_name'
    | 'invalid_token'
    | 'invalid_label'
    | 'unknown_account'
    | 'malformed_registry'
    | 'invalid_body';
}
