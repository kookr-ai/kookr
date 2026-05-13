import type { Monitor, AgentState } from '../../core/monitor.js';
import type { BuildInfo } from '../../core/build-info.js';
import { computeProjectSummaries } from '../../core/project-summary.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { AvailableAgentType, AgentType } from '../../core/agent-types.js';
import type { ProjectSummary, ProjectRepoHealth } from '../../core/project-summary.js';
import type { SnapshotMessage } from '../../shared/contracts/messages.js';
import { projectEventForClient } from '../event-projection.js';

export interface SnapshotQueryDeps {
  monitor: Pick<Monitor, 'getSnapshot'>;
}

export interface SnapshotMessageDeps extends SnapshotQueryDeps {
  serverCwd: string;
  buildInfo?: BuildInfo;
  serverStartedAt?: string;
  sttUrl?: string;
  totalSpendUsd?: number;
  achievements?: Record<string, string>;
  achievementCounters?: {
    repeated_error_resolutions: number;
    permission_blocked_resolutions: number;
    merge_conflict_resolutions: number;
    api_error_resolutions: number;
    needs_input_resolutions: number;
    session_start_total: number;
  };
  achievementStreak?: { lastActiveDate: string | null; currentStreak: number };
  availableAgentTypes?: AvailableAgentType[];
  defaultAgentType?: AgentType;
  workspaceEnabled?: boolean;
  sweepRunning?: boolean;
}

export interface ProjectSummaryQueryDeps extends SnapshotQueryDeps {
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  /** Read-only accessor for skill-discovered project IDs. */
  getSkillTrackedProjects?: () => string[];
  /** Read-only accessor for active external repos from ~/.kookr/oss-repos.json. */
  getRegistryActiveProjects?: () => string[];
  /** Read-only accessor for project IDs persisted by the sidebar preference store. */
  getSidebarProjects?: () => string[];
  prLessonsHolder?: PrLessonsStateHolder;
  /** Repo-health snapshot from the GitHub scanner; flowed onto ProjectSummary.repoHealth. */
  repoHealthCache?: ReadonlyMap<string, ProjectRepoHealth>;
}

/**
 * Get agents with events projected for browser transport.
 * toolResponse is omitted; toolInput and lastMessage are capped.
 * Use this for WebSocket snapshot/update broadcasts.
 * See docs/rfc/rfc-snapshot-payload-slimming.md.
 */
export function getSnapshotAgentsForClient(deps: SnapshotQueryDeps): AgentState[] {
  return deps.monitor.getSnapshot().map((agent) => ({
    ...agent,
    events: agent.events.map(projectEventForClient),
  }));
}

/**
 * Get agents with events at full fidelity.
 * Use this for debug endpoints (/api/snapshot, /api/agents/:id) and any
 * server-internal caller that needs the raw toolResponse / toolInput / lastMessage.
 */
export function getSnapshotAgentsRaw(deps: SnapshotQueryDeps): AgentState[] {
  return deps.monitor.getSnapshot();
}

export function createSnapshotMessage(deps: SnapshotMessageDeps): SnapshotMessage {
  return {
    type: 'snapshot',
    agents: getSnapshotAgentsForClient(deps),
    serverCwd: deps.serverCwd,
    ...(deps.buildInfo ? { build: deps.buildInfo } : {}),
    ...(deps.serverStartedAt ? { serverStartedAt: deps.serverStartedAt } : {}),
    ...(deps.sttUrl ? { sttEnabled: true, sttUrl: deps.sttUrl } : {}),
    ...(deps.totalSpendUsd !== undefined ? { totalSpendUsd: deps.totalSpendUsd } : {}),
    ...(deps.achievements ? { achievements: deps.achievements } : {}),
    ...(deps.achievementCounters ? { achievementCounters: deps.achievementCounters } : {}),
    ...(deps.achievementStreak ? { achievementStreak: deps.achievementStreak } : {}),
    ...(deps.availableAgentTypes ? { availableAgentTypes: deps.availableAgentTypes } : {}),
    ...(deps.defaultAgentType ? { defaultAgentType: deps.defaultAgentType } : {}),
    ...(deps.workspaceEnabled ? { workspaceEnabled: true } : {}),
    ...(deps.sweepRunning ? { sweepRunning: true } : {}),
  };
}

export function getProjectSummaries(deps: ProjectSummaryQueryDeps): ProjectSummary[] {
  return computeProjectSummaries({
    agents: getSnapshotAgentsRaw(deps),
    ledgerAnalytics: deps.ledgerAnalytics,
    configStore: deps.projectConfigStore,
    skillTrackedProjects: deps.getSkillTrackedProjects?.(),
    registryActiveProjects: deps.getRegistryActiveProjects?.(),
    sidebarProjects: deps.getSidebarProjects?.(),
    prLessonsHolder: deps.prLessonsHolder,
    repoHealthCache: deps.repoHealthCache,
  });
}
