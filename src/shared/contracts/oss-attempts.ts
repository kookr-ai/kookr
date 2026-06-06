export type AttemptState = 'scouted' | 'pr_open' | 'merged' | 'closed';

export type ObservationSource =
  | 'posttool_hook'
  | 'refresh_poll'
  | 'backfill'
  | 'scout_emit'
  | 'ledger';

export interface StateObservation {
  state: AttemptState;
  at: string; // UTC ISO 8601
  source: ObservationSource;
  note: string | null;
  url: string | null;
}

export interface ClosingInfo {
  closedAt: string;
  closerLogin: string | null;
  closingComment: string; // first 500 chars verbatim
}

/**
 * Verified state of the issue a PR references via `Fixes/Closes/Resolves #N`.
 * Populated by the OSS refresher's `gh api issues/N` path.
 *
 * Distinct from `ContributionAttempt.issueNumber` — that field is what the PR
 * claims and never gets overwritten on body edits, to preserve the
 * (repo, issueNumber) dedup index. `linkedIssue` pairs a possibly different
 * number with a verified live-state observation so the dashboard can flag
 * zombie PRs whose linked issue was already closed by another PR.
 *
 * `verifiedAt` records when the issue-state fetch succeeded, so operators see
 * when the zombie decision was made, not when the PR title last changed.
 */
export interface LinkedIssueState {
  number: number;
  state: 'open' | 'closed';
  closedAt: string | null;
  closingPrNumber: number | null;
  verifiedAt: string;
}

export interface ContributionAttempt {
  id: string; // `${repo}#${prNumber}` or `${repo}#issue-${issueNumber}`
  repo: string; // "owner/repo" — never in ownNamespaces
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prTitle: string | null;
  state: AttemptState; // latest observed state (not monotonic)
  history: StateObservation[];
  closing: ClosingInfo | null;
  /**
   * Optional — present when the refresher has verified the linked issue's
   * state. Absent on records written before this feature shipped; treated as
   * `null` at read sites.
   */
  linkedIssue?: LinkedIssueState | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Originating Kookr task — attached when an attempt is first observed via
   * the contribution ledger (which records the creating `taskId`). Not
   * overwritten by later observations, so provenance survives refresh polls
   * and hook recaptures.
   */
  taskId?: string;
}

export interface IssueCheckError {
  repo: string;
  prNumber: number;
  message: string;
}

export type LedgerAction =
  | 'pr_created'
  | 'pr_allowed'
  | 'pr_blocked_rate_limit'
  | 'pr_blocked_blocked_repo'
  | 'slot_reset';

export interface LedgerEntry {
  timestamp: string; // ISO 8601 UTC
  repo: string; // "owner/repo" (e.g., "grafana/grafana")
  action: LedgerAction;
  prUrl?: string;
  blockReason?: string;
  reason?: string; // For slot_reset
  taskId?: string;
  command?: string;
}
