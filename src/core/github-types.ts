// --- GitHub Reference Types ---

export interface GitHubReference {
  type: 'pr' | 'issue';
  owner: string;
  repo: string;
  number: number;
  url: string;
  detectedAt: Date;
  detectedFrom: string; // agentId / tmuxSession name
  taskId: string;
}

// --- GitHub PR State ---

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
export type GitHubPRMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

export interface GitHubPRState {
  ref: GitHubReference;
  title: string;
  status: GitHubPRStatus;
  mergeable: GitHubPRMergeable;
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

// --- GitHub Issue State ---

export interface GitHubIssueState {
  ref: GitHubReference;
  title: string;
  status: 'open' | 'closed';
  author: string;
  labels: string[];
  commentCount: number;
  lastFetchedAt: Date;
}

// --- State Change Events ---

export type GitHubStateChange =
  | { type: 'new_comment'; ref: GitHubReference; comment: { author: string; body: string; path?: string } }
  | { type: 'ci_failed'; ref: GitHubReference; check: { name: string; conclusion: string } }
  | { type: 'ci_passed'; ref: GitHubReference }
  | { type: 'review_requested_changes'; ref: GitHubReference; reviewer: string }
  | { type: 'review_approved'; ref: GitHubReference; reviewer: string }
  | { type: 'pr_merged'; ref: GitHubReference }
  | { type: 'pr_closed'; ref: GitHubReference }
  | { type: 'pr_conflicting'; ref: GitHubReference }
  | { type: 'new_unresolved_thread'; ref: GitHubReference; thread: { author: string; body: string; path?: string } };

// --- Fetcher Interface (implemented by adapters) ---

export interface GitHubFetcher {
  isAvailable(): Promise<boolean>;
  inferOwnerRepo(cwd: string): Promise<{ owner: string; repo: string } | null>;
  fetchPRState(ref: GitHubReference): Promise<GitHubPRState | null>;
  fetchIssueState(ref: GitHubReference): Promise<GitHubIssueState | null>;
  fetchStates?(refs: GitHubReference[]): Promise<GitHubFetchBatchResult>;
}

export interface GitHubRateLimit {
  kind: 'rate-limited';
  retryAfterMs: number;
  message: string;
}

export interface GitHubFetchBatchResult {
  prs: GitHubPRState[];
  issues: GitHubIssueState[];
  rateLimit?: GitHubRateLimit;
}

export interface GitHubRepoHealthFetchSuccess<TRepoHealth> {
  repoHealth: Map<string, TRepoHealth>;
  rateLimit?: GitHubRateLimit;
}

export type GitHubRepoHealthFetchResult<TRepoHealth> =
  | Map<string, TRepoHealth>
  | GitHubRepoHealthFetchSuccess<TRepoHealth>
  | null
  | GitHubRateLimit;

// --- Scanner Config ---

export interface GitHubScannerConfig {
  enabled: boolean;
  referenceExtractionIntervalMs: number;
  stateFetchIntervalMs: number;
  useHaikuExtraction: boolean;
  maxPRsPerTask: number;
  maxIssuesPerTask: number;
  maxScannedPromptCacheEntries: number;
  maxOwnerRepoCacheEntries: number;
}

export const DEFAULT_GITHUB_SCANNER_CONFIG: GitHubScannerConfig = {
  enabled: true,
  referenceExtractionIntervalMs: 60_000, // 1 min
  stateFetchIntervalMs: 60_000,          // 1 min
  useHaikuExtraction: false,             // Phase 1: regex only
  maxPRsPerTask: 10,
  maxIssuesPerTask: 20,
  maxScannedPromptCacheEntries: 5_000,
  maxOwnerRepoCacheEntries: 1_000,
};

// --- Aggregate state per task (for API/WebSocket) ---

export interface TaskGitHubState {
  taskId: string;
  prs: GitHubPRState[];
  issues: GitHubIssueState[];
  lastScanAt: Date | null;
  changes: GitHubStateChange[]; // recent unacknowledged changes
}
