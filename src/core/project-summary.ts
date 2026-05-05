import type { AgentState } from './monitor.js';
import type { LedgerAnalytics } from './ledger-analytics.js';
import type { ProjectConfig, ProjectConfigStore } from './project-config-store.js';
import type { PrLessonsStateHolder } from './pr-lessons-discovery.js';
import { projectDisplayName, projectColorIndex } from './project-identity.js';

export interface TaskSummary {
  taskId: string;
  name?: string;
  status: string;
  startedAt?: string;
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
  openPrs: number;
  lastContribution?: string; // ISO date of most recent PR
  recentTasks: TaskSummary[];
  notes?: string;
  /** True when the user explicitly opted in via the "Track OSS repository" form. */
  tracked?: boolean;
  prLessonsProcessed?: number;
  prLessonsDistillations?: number;
  prLessonsRawLines?: number;
}

export interface ProjectSummaryDeps {
  agents: AgentState[];
  ledgerAnalytics: LedgerAnalytics;
  configStore: ProjectConfigStore;
  /** Project IDs discovered from skill recon reports (read-only). */
  skillTrackedProjects?: string[];
  prLessonsHolder?: PrLessonsStateHolder;
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
  const { agents, ledgerAnalytics, configStore, skillTrackedProjects, prLessonsHolder } = deps;

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
