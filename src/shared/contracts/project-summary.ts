export interface TaskSummary {
  taskId: string;
  name?: string;
  status: string;
  startedAt?: string;
}

export interface PendingReviewPr {
  number: number;
  title: string;
  url: string;
}

export interface ProjectRepoHealth {
  openIssues: number;
  openPullRequests: number;
  pendingReviewPrs: PendingReviewPr[];
  repoUrl: string;
  lastFetchedAt: string;
}

export interface ProjectGithubLink {
  kind: 'issue' | 'pr';
  number: number;
  taskId: string;
  taskName?: string;
}

export interface ProjectSummary {
  project: string;
  displayName: string;
  color: number;
  activeAgents: number;
  stalledAgents?: number;
  findingCount: number;
  todayPrCount: number;
  weekPrCount: number;
  dailyLimit?: number;
  /**
   * Contribution attempts currently in Kookr's `pr_open` state. This is scoped
   * to Kookr agent attempts; repo-wide open PRs live at `repoHealth.openPullRequests`.
   */
  openContributionAttempts: number;
  lastContribution?: string;
  recentTasks: TaskSummary[];
  notes?: string;
  tracked: boolean;
  prLessonsProcessed?: number;
  prLessonsDistillations?: number;
  prLessonsRawLines?: number;
  localPath?: string;
  repoHealth?: ProjectRepoHealth;
  openIssuesTiedToActiveTasks?: number;
  openPrsTiedToActiveTasks?: number;
  activeTaskGithubLinks?: ProjectGithubLink[];
}
