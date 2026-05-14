export type AttemptState = 'scouted' | 'pr_open' | 'merged' | 'closed';

export type ObservationSource =
  | 'posttool_hook'
  | 'refresh_poll'
  | 'backfill'
  | 'scout_emit'
  | 'ledger';

export interface StateObservation {
  state: AttemptState;
  at: string;
  source: ObservationSource;
  note: string | null;
  url: string | null;
}

export interface ClosingInfo {
  closedAt: string;
  closerLogin: string | null;
  closingComment: string;
}

export interface LinkedIssueState {
  number: number;
  state: 'open' | 'closed';
  closedAt: string | null;
  closingPrNumber: number | null;
  verifiedAt: string;
}

export interface ContributionAttempt {
  id: string;
  repo: string;
  issueNumber: number | null;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prTitle: string | null;
  state: AttemptState;
  history: StateObservation[];
  closing: ClosingInfo | null;
  linkedIssue?: LinkedIssueState | null;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
}

export interface IssueCheckError {
  repo: string;
  prNumber: number;
  message: string;
}
