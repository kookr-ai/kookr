import type { AgentState } from './monitor.js';
import type { LedgerAnalytics } from './ledger-analytics.js';
import type { ProjectConfig, ProjectConfigStore } from './project-config-store.js';
import type { PrLessonsStateHolder } from './pr-lessons-discovery.js';
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
  findingCount: number;
  todayPrCount: number;
  weekPrCount: number;
  dailyLimit?: number;
  /**
   * Open PRs *authored by Kookr agents* for this project — from the contribution ledger.
   * Distinct from `repoHealth.openPullRequests` (repo-wide).
   * Rendered in the drawer with the label "Agent PRs".
   */
  openPrs: number;
  lastContribution?: string; // ISO date of most recent PR
  recentTasks: TaskSummary[];
  notes?: string;
  /** True when the user explicitly opted in via the "Track OSS repository" form. */
  tracked?: boolean;
  prLessonsProcessed?: number;
  prLessonsDistillations?: number;
  prLessonsRawLines?: number;
  /**
   * Absolute local checkout path, mirrored from ProjectConfig.localPath. Used
   * by the launch dialog to pre-fill the cwd field when "Run playbook…" is
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
   * Count of distinct open issues in this repo currently referenced by an
   * `inProgress`, non-snoozed Kookr task. Computed live per snapshot from the
   * agents + GitHub state stores. Absent when no active task touches the repo.
   */
  openIssuesTiedToActiveTasks?: number;
  /**
   * Count of distinct open PRs in this repo currently referenced by an
   * `inProgress`, non-snoozed Kookr task. Same semantics as above.
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
   */
  githubTaskOverlay?: ReadonlyMap<string, {
    tiedOpenIssueNumbers: Set<number>;
    tiedOpenPrNumbers: Set<number>;
    links: ProjectGithubLink[];
  }>;
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
  if (config.notes !== undefined && config.notes.trim() !== '') return true;
  return false;
}

/**
 * Compute project summaries from current agent state and contribution data.
 * Groups agents by projectId, computes aggregate stats per project.
 */
export function computeProjectSummaries(deps: ProjectSummaryDeps): ProjectSummary[] {
  const { agents, ledgerAnalytics, configStore, skillTrackedProjects, registryActiveProjects, sidebarProjects, prLessonsHolder, repoHealthCache, githubTaskOverlay } = deps;

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

  for (const [projectId, agentList] of projectAgents) {
    const config = configStore.getConfig(projectId);
    const todayCount = ledgerAnalytics.getTodayCount(projectId);
    const weekCount = ledgerAnalytics.getWeekCount(projectId);
    const attempts = ledgerAnalytics.getAttemptsByProject(projectId);
    const openPrs = attempts.filter((a) => a.state === 'pr_open').length;
    const lastContrib = attempts.length > 0
      ? attempts.reduce((a, b) => a.createdAt > b.createdAt ? a : b).createdAt
      : undefined;

    const activeAgents = agentList.filter(
      (a) => a.taskStatus === 'inProgress' && !a.snoozedUntil,
    ).length;

    const findingCount = agentList.filter(
      (a) => a.anomaly !== null && !a.snoozedUntil && a.taskStatus !== 'pending',
    ).length;

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
      findingCount,
      todayPrCount: todayCount,
      weekPrCount: weekCount,
      dailyLimit: effectiveLimit ?? config?.dailyPrLimit,
      openPrs,
      lastContribution: lastContrib,
      recentTasks,
      notes: config?.notes,
      tracked: config?.tracked === true ? true : undefined,
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
