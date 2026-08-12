import type { AgentState } from '../shared/contracts/agent-state.js';
import type { LedgerAnalytics } from './ledger-analytics.js';
import type { ProjectConfig, ProjectConfigStore } from './project-config-store.js';
import type { PrLessonsStateHolder } from './pr-lessons-discovery.js';
import { defaultLocalPathChecker, type LocalPathHealthChecker } from './local-path-health.js';
import { projectDisplayName, projectColorIndex, isSafeGithubProjectId } from './project-identity.js';

export interface TaskSummary {
  taskId: string;
  name?: string;
  status: string;
  startedAt?: string;
}

export interface PendingReviewPr {
  number: number;
  title: string;
  /** Validated to match https://github.com/<owner>/<repo>/pull/<n>. */
  url: string;
}

export interface ProjectRepoHealth {
  openIssues: number;
  openPullRequests: number;
  /** Up to 5 PRs that are open, not draft, and not approved. */
  pendingReviewPrs: PendingReviewPr[];
  /** Validated to start with https://github.com/<owner>/<repo> of this project. */
  repoUrl: string;
  /** ISO string of when this snapshot was fetched. */
  lastFetchedAt: string;
}

export interface ProjectSummary {
  project: string;        // "github.com/grafana/grafana"
  displayName: string;    // "grafana/grafana"
  color: number;          // 0-7 deterministic color
  activeAgents: number;
  /**
   * Active agents in this project that currently have an anomaly. Used by the
   * project sidebar to render healthy/active execution load without overloading
   * PR contribution counts.
   */
  stalledAgents?: number;
  findingCount: number;
  todayPrCount: number;
  weekPrCount: number;
  dailyLimit?: number;
  /** Per-task cost warning threshold in USD. 0 disables budget alerts for this project. */
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
   * Contribution attempts currently in the `pr_open` state in Kookr's OSS
   * attempt ledger. This is scoped to agent attempts, not repo-wide GitHub PRs;
   * use `repoHealth.openPullRequests` for the repository denominator.
   */
  openContributionAttempts: number;
  lastContribution?: string; // ISO date of most recent PR
  recentTasks: TaskSummary[];
  notes?: string;
  /** Whether the user explicitly opted in via the "Track OSS repository" form. */
  tracked: boolean;
  prLessonsProcessed?: number;
  prLessonsDistillations?: number;
  prLessonsRawLines?: number;
  /**
   * Absolute local checkout path, mirrored from ProjectConfig.localPath. Used
   * by the launch dialog to pre-fill the cwd field when "Playbook task" is
   * invoked from the project drawer. Stamped server-side on first task
   * start; absent until then.
   */
  localPath?: string;
  /**
   * Repo-wide GitHub health (issue count, PR count, pending PRs, repo URL).
   * Populated only for `github.com/...` projects in the scanner's tracked set;
   * omitted when unavailable.
   */
  repoHealth?: ProjectRepoHealth;
  /**
   * Count of distinct VERIFIED-open issues in this repo currently referenced
   * by an `inProgress`, non-snoozed Kookr task. Computed live per snapshot
   * from the agents + GitHub state stores; a reference only counts once
   * GitHub has confirmed the issue open (closed/unfetched/nonexistent refs
   * are excluded), so this can never exceed `repoHealth.openIssues` modulo
   * cache staleness. Absent when no active task touches the repo.
   */
  openIssuesTiedToActiveTasks?: number;
  /**
   * Count of distinct VERIFIED-open PRs in this repo currently referenced by
   * an `inProgress`, non-snoozed Kookr task. Same semantics as above.
   */
  openPrsTiedToActiveTasks?: number;
  /**
   * Per-tied-item rows for the drawer tooltip: which task is driving which
   * issue/PR number. Bounded by `activeAgents × refs per task`.
   */
  activeTaskGithubLinks?: ProjectGithubLink[];
}

export interface ProjectGithubLink {
  kind: 'issue' | 'pr';
  number: number;
  taskId: string;
  taskName?: string;
}

export interface ProjectSummaryDeps {
  agents: AgentState[];
  ledgerAnalytics: LedgerAnalytics;
  configStore: ProjectConfigStore;
  /** Project IDs discovered from skill recon reports (read-only). */
  skillTrackedProjects?: string[];
  /** Project IDs derived from active external repos in ~/.kookr/oss-repos.json. */
  registryActiveProjects?: string[];
  /** Project IDs persisted by the sidebar preference store. */
  sidebarProjects?: string[];
  prLessonsHolder?: PrLessonsStateHolder;
  /** Repo-health cache, keyed by project id. Provided by `GitHubScannerService.getRepoHealthSnapshot()`. */
  repoHealthCache?: ReadonlyMap<string, ProjectRepoHealth>;
  /**
   * Per-project active-task GitHub overlay (tied issue/PR counts and links).
   * Keyed by project id. Caller pre-computes via `buildGithubTaskOverlay`.
   * The element shape is structurally identical to the use-case helper's
   * `GithubTaskOverlay`; this inline type keeps `core/` free of a reverse
   * dependency on `server/use-cases/`.
   */
  githubTaskOverlay?: ReadonlyMap<string, GithubTaskOverlayEntry>;
  /**
   * Existence checker for `local/*` project checkout paths. Defaults to the
   * process-wide {@link defaultLocalPathChecker}; injectable for tests. A
   * `local/*` project whose configured `localPath` is confirmed missing and
   * that has no in-progress task is excluded from the listing — dead test
   * artifacts (e.g. `local/test_launch_*` pointing at deleted /tmp dirs)
   * stop occupying first-class sidebar rows. Config rows are NOT deleted, so
   * recreating the path brings the project back.
   */
  localPathChecker?: Pick<LocalPathHealthChecker, 'isMissing'>;
}

export interface GithubTaskOverlayEntry {
  tiedOpenIssueNumbers: Set<number>;
  tiedOpenPrNumbers: Set<number>;
  links: ProjectGithubLink[];
}

/** Hard cap on the number of repos polled per repo-health tick. */
export const MAX_TRACKED_REPOS = 100;

/**
 * Single source of truth for the set of project ids that should be visible
 * (and, for github.com ids, polled for repo-wide stats). Mirrors the union
 * built in computeProjectSummaries.
 *
 * Returns deduped, lowercase ids. Caller is responsible for filtering to
 * `github.com/` prefix when using the result for the scanner's tracked set.
 */
export function deriveActiveProjectIds(deps: ProjectSummaryDeps): string[] {
  const ids = new Set<string>();
  for (const agent of deps.agents) {
    if (agent.projectId) ids.add(agent.projectId);
  }
  for (const project of deps.ledgerAnalytics.getProjects()) {
    ids.add(project);
  }
  for (const config of deps.configStore.getAllConfigs()) {
    if (configSeedsMembership(config)) ids.add(config.project);
  }
  for (const project of deps.skillTrackedProjects ?? []) ids.add(project);
  for (const project of deps.registryActiveProjects ?? []) ids.add(project);
  for (const project of deps.sidebarProjects ?? []) ids.add(project);
  return [...ids];
}

/**
 * Pick the GitHub project ids the repo-health poller should fetch.
 * Filters to safe github.com ids and caps at MAX_TRACKED_REPOS.
 */
export function deriveTrackedGithubRepos(deps: ProjectSummaryDeps): string[] {
  return deriveActiveProjectIds(deps)
    .filter(isSafeGithubProjectId)
    .slice(0, MAX_TRACKED_REPOS);
}

/**
 * Decide whether a ProjectConfig entry by itself should seed sidebar membership.
 * A bare config row with nothing meaningful set should NOT appear in the sidebar.
 */
export function configSeedsMembership(config: ProjectConfig): boolean {
  if (config.tracked === true) return true;
  if (config.dailyPrLimit !== undefined) return true;
  if (config.weeklyPrLimit !== undefined) return true;
  if (config.budgetWarnUsd !== undefined) return true;
  if (config.notes !== undefined && config.notes.trim() !== '') return true;
  if (config.webhook?.enabled !== undefined || config.webhook?.minSeverity !== undefined) return true;
  return false;
}

/**
 * Compute project summaries from current agent state and contribution data.
 * Groups agents by projectId, computes aggregate stats per project.
 */
export function computeProjectSummaries(deps: ProjectSummaryDeps): ProjectSummary[] {
  const { agents, ledgerAnalytics, configStore, skillTrackedProjects, registryActiveProjects, sidebarProjects, prLessonsHolder, repoHealthCache, githubTaskOverlay } = deps;
  const localPathChecker = deps.localPathChecker ?? defaultLocalPathChecker;

  // Group agents by projectId (derived from task data)
  const projectAgents = new Map<string, AgentState[]>();
  for (const agent of agents) {
    const projectId = agent.projectId;
    if (!projectId) continue;
    const list = projectAgents.get(projectId) ?? [];
    list.push(agent);
    projectAgents.set(projectId, list);
  }

  // Also include projects that have contributions but no active agents
  for (const project of ledgerAnalytics.getProjects()) {
    if (!projectAgents.has(project)) {
      projectAgents.set(project, []);
    }
  }

  // Include config-backed projects only when the config row carries a
  // membership signal (explicit tracking, PR limits, or notes).
  for (const config of configStore.getAllConfigs()) {
    if (!configSeedsMembership(config)) continue;
    if (!projectAgents.has(config.project)) {
      projectAgents.set(config.project, []);
    }
  }

  // Include skill-discovered projects even with no agents or contributions.
  if (skillTrackedProjects) {
    for (const project of skillTrackedProjects) {
      if (!projectAgents.has(project)) {
        projectAgents.set(project, []);
      }
    }
  }

  // Include active registry repos so ~/.kookr/oss-repos.json edits are
  // reflected in the sidebar even before a manual GH refresh creates PR rows.
  if (registryActiveProjects) {
    for (const project of registryActiveProjects) {
      if (!projectAgents.has(project)) {
        projectAgents.set(project, []);
      }
    }
  }

  // Include projects that exist only because the user pinned/reordered/hidden
  // them in the sidebar. This makes the sidebar recoverable after restart even
  // when no active agent or contribution currently mentions the project.
  if (sidebarProjects) {
    for (const project of sidebarProjects) {
      if (!projectAgents.has(project)) {
        projectAgents.set(project, []);
      }
    }
  }

  const summaries: ProjectSummary[] = [];

  // Aggregate the ledger once for the whole fan-out rather than re-scanning
  // (and re-cloning) it per project. These three batch reads collapse the
  // former `2 × projects` ledger clones + `3 × projects` scans into two ledger
  // scans and one non-cloning attempts pass. Keyed by projectId; missing
  // projects resolve to 0 / [] exactly as the per-project methods would.
  const projectIds = [...projectAgents.keys()];
  const todayCounts = ledgerAnalytics.getTodayCountsByProject(projectIds);
  const weekCounts = ledgerAnalytics.getWeekCountsByProject(projectIds);
  const attemptsByProject = ledgerAnalytics.getAttemptsByProjectMap(projectIds);

  for (const [projectId, agentList] of projectAgents) {
    const config = configStore.getConfig(projectId);

    // Hide dead local test artifacts: a `local/*` project whose checkout path
    // is confirmed gone and that has no in-progress task is a stale row, not
    // a project. The existence check is async-cached (never stats inline) and
    // optimistic, so a project only disappears after a real stat. The config
    // row is untouched — this is presentation-level filtering only.
    if (
      projectId.startsWith('local/')
      && config?.localPath
      && localPathChecker.isMissing(config.localPath)
      && !agentList.some((a) => a.taskStatus === 'inProgress')
    ) {
      continue;
    }

    const todayCount = todayCounts.get(projectId) ?? 0;
    const weekCount = weekCounts.get(projectId) ?? 0;
    const attempts = attemptsByProject.get(projectId) ?? [];
    const openContributionAttempts = attempts.filter((a) => a.state === 'pr_open').length;
    const lastContrib = attempts.length > 0
      ? attempts.reduce((a, b) => a.createdAt > b.createdAt ? a : b).createdAt
      : undefined;

    const activeAgents = agentList.filter(
      (a) => a.taskStatus === 'inProgress' && !a.snoozedUntil,
    ).length;

    const stalledAgents = agentList.filter(
      (a) => a.taskStatus === 'inProgress' && a.anomaly !== null && !a.snoozedUntil,
    ).length;

    const findingCount = agentList.filter(
      (a) => a.anomaly !== null && !a.snoozedUntil && a.taskStatus !== 'pending',
    ).length;

    // Accumulated project spend: sum each agent's already-computed cost.
    const costUsd = agentList.reduce((sum, a) => sum + (a.tokenUsage?.costUsd ?? 0), 0);

    const recentTasks: TaskSummary[] = agentList
      .filter((a) => a.taskId)
      .map((a) => ({
        taskId: a.taskId!,
        name: a.taskName,
        status: a.taskStatus ?? 'unknown',
        startedAt: a.startedAt,
      }));

    // Use effective daily limit: manual config > rate-limits.json override > default
    const effectiveLimit = configStore.getEffectiveDailyLimit(projectId);

    // PR lessons state (augment only — does not seed sidebar membership)
    const prLessons = prLessonsHolder?.getForProject(projectId);

    const overlay = githubTaskOverlay?.get(projectId);

    summaries.push({
      project: projectId,
      displayName: projectDisplayName(projectId),
      color: projectColorIndex(projectId),
      activeAgents,
      stalledAgents,
      findingCount,
      todayPrCount: todayCount,
      weekPrCount: weekCount,
      dailyLimit: effectiveLimit ?? config?.dailyPrLimit,
      budgetWarnUsd: config?.budgetWarnUsd,
      costUsd: costUsd > 0 ? costUsd : undefined,
      openContributionAttempts,
      lastContribution: lastContrib,
      recentTasks,
      notes: config?.notes,
      tracked: config?.tracked === true,
      prLessonsProcessed: prLessons?.totalProcessed,
      prLessonsDistillations: prLessons?.distillationCount,
      prLessonsRawLines: prLessons?.rawLearningsLines,
      localPath: config?.localPath,
      repoHealth: repoHealthCache?.get(projectId),
      openIssuesTiedToActiveTasks: overlay ? overlay.tiedOpenIssueNumbers.size : undefined,
      openPrsTiedToActiveTasks: overlay ? overlay.tiedOpenPrNumbers.size : undefined,
      activeTaskGithubLinks: overlay && overlay.links.length > 0 ? overlay.links : undefined,
    });
  }

  // Sort: projects with findings first, then by active agents, then alphabetical
  summaries.sort((a, b) => {
    if (a.findingCount !== b.findingCount) return b.findingCount - a.findingCount;
    if (a.activeAgents !== b.activeAgents) return b.activeAgents - a.activeAgents;
    return a.displayName.localeCompare(b.displayName);
  });

  return summaries;
}

/**
 * Check if a project has exceeded or is approaching its daily PR limit.
 * Returns a warning message or null if within limits.
 */
export function checkContributionLimit(
  projectId: string,
  ledgerAnalytics: LedgerAnalytics,
  configStore: ProjectConfigStore,
): { message: string; severity: 'approaching' | 'exceeded' } | null {
  const dailyLimit = configStore.getEffectiveDailyLimit(projectId);
  if (!dailyLimit) return null;

  const todayCount = ledgerAnalytics.getTodayCount(projectId);
  const displayName = projectDisplayName(projectId);

  if (todayCount >= dailyLimit) {
    return {
      message: `${displayName}: ${todayCount}/${dailyLimit} PRs today (daily limit reached)`,
      severity: 'exceeded',
    };
  }

  if (todayCount >= dailyLimit - 1) {
    return {
      message: `${displayName}: ${todayCount}/${dailyLimit} PRs today (approaching daily limit)`,
      severity: 'approaching',
    };
  }

  return null;
}
