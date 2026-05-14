export interface GitHubReference {
  type: 'pr' | 'issue';
  owner: string;
  repo: string;
  number: number;
  url: string;
  detectedAt: Date;
  detectedFrom: string;
  taskId: string;
}

export interface GitHubReviewer {
  login: string;
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
}

export interface GitHubReviewThread {
  id: string;
  isResolved: boolean;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface GitHubCheck {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'skipped' | null;
}

export type GitHubPRStatus = 'open' | 'closed' | 'merged' | 'draft';

export interface GitHubPRState {
  ref: GitHubReference;
  title: string;
  status: GitHubPRStatus;
  author: string;
  branch: string;
  baseBranch: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  reviewers: GitHubReviewer[];
  unresolvedThreads: GitHubReviewThread[];
  totalComments: number;
  checks: GitHubCheck[];
  lastFetchedAt: Date;
}

export interface GitHubIssueState {
  ref: GitHubReference;
  title: string;
  status: 'open' | 'closed';
  author: string;
  labels: string[];
  commentCount: number;
  lastFetchedAt: Date;
}

export type GitHubStateChange =
  | { type: 'new_comment'; ref: GitHubReference; comment: { author: string; body: string; path?: string } }
  | { type: 'ci_failed'; ref: GitHubReference; check: { name: string; conclusion: string } }
  | { type: 'ci_passed'; ref: GitHubReference }
  | { type: 'review_requested_changes'; ref: GitHubReference; reviewer: string }
  | { type: 'review_approved'; ref: GitHubReference; reviewer: string }
  | { type: 'pr_merged'; ref: GitHubReference }
  | { type: 'pr_closed'; ref: GitHubReference }
  | { type: 'new_unresolved_thread'; ref: GitHubReference; thread: { author: string; body: string; path?: string } };
