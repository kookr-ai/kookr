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
  budgetWarnUsd?: number;
  /**
   * Accumulated agent spend for this project in USD, summed from each of the
   * project's agents' `tokenUsage.costUsd`. Surfaced next to `budgetWarnUsd` for
   * at-a-glance context. Note `budgetWarnUsd` is a *per-task* threshold, so this
   * project-wide total is a reference figure, not the value the per-task budget
   * alert compares against. Omitted when the project has no agents with a
   * recorded cost.
   */
  costUsd?: number;
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
