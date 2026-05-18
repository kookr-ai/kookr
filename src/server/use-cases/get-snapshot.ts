import type { Monitor, AgentState } from '../../core/monitor.js';
import type { BuildInfo } from '../../core/build-info.js';
import { computeProjectSummaries } from '../../core/project-summary.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { AvailableAgentType, AgentSelection } from '../../core/agent-types.js';
import type { ProjectSummary, ProjectRepoHealth } from '../../core/project-summary.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { SnapshotMessage } from '../../shared/contracts/messages.js';
import type { CollaborationCapabilities, SpeechCapability } from '../../shared/contracts/speech.js';
import { projectEventForClient } from '../event-projection.js';
import type { AgentActivityMeta } from '../../core/types.js';
import { buildGithubTaskOverlay } from './github-task-overlay.js';
import type { FindingEvidenceAuditRecord } from '../../shared/contracts/anomalies.js';

export interface SnapshotQueryDeps {
  monitor: Pick<Monitor, 'getSnapshot'>;
  /** Optional provider of per-Kookr-session activity counters. Wires
   *  {@link AgentState.activityMeta} on each snapshot so the activity panel
   *  can disclose partial-window state and child / malformed counts. */
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
}

export interface SnapshotMessageDeps extends SnapshotQueryDeps {
  serverCwd: string;
  /** Optional remote-session revision. Local-only callers leave this unset. */
  serverRevision?: number;
  buildInfo?: BuildInfo;
  serverStartedAt?: string;
  sttUrl?: string;
  ttsUrl?: string;
  speechCapabilities?: CollaborationCapabilities;
  now?: () => Date;
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
  defaultAgentType?: AgentSelection;
  workspaceEnabled?: boolean;
  sweepRunning?: boolean;
  /** Live getter for the configured concurrency cap (settings.maxActiveTasks). */
  getMaxActiveTasks?: () => number;
}

const LOCAL_NODE_DEVICE_ID = 'local-node';
const LOCAL_NODE_DEVICE_SESSION_ID = 'local-node-ui';
const CAPABILITY_TTL_MS = 5 * 60 * 1000;

export function buildLocalSpeechCapabilities(deps: {
  sttUrl?: string;
  ttsUrl?: string;
  now?: () => Date;
}): CollaborationCapabilities | undefined {
  if (!deps.sttUrl && !deps.ttsUrl) return undefined;
  const now = deps.now?.() ?? new Date();
  const advertisedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + CAPABILITY_TTL_MS).toISOString();
  const capabilities: SpeechCapability[] = [];

  if (deps.sttUrl) {
    capabilities.push({
      kind: 'stt',
      deviceId: LOCAL_NODE_DEVICE_ID,
      deviceSessionId: LOCAL_NODE_DEVICE_SESSION_ID,
      capabilityId: 'local-node-stt',
      displayName: 'Kookr local speech-to-text',
      locality: 'node-local',
      scope: 'local-node-ui-only',
      protocol: 'kookr-stt-ws',
      endpointUrl: deps.sttUrl,
      advertisedAt,
      expiresAt,
      readiness: 'ready',
      privacy: 'local-only',
    });
  }

  if (deps.ttsUrl) {
    capabilities.push({
      kind: 'tts',
      deviceId: LOCAL_NODE_DEVICE_ID,
      deviceSessionId: LOCAL_NODE_DEVICE_SESSION_ID,
      capabilityId: 'local-node-tts',
      displayName: 'Kookr local text-to-speech',
      locality: 'node-local',
      scope: 'local-node-ui-only',
      endpointUrl: deps.ttsUrl,
      advertisedAt,
      expiresAt,
      readiness: 'ready',
      privacy: 'local-only',
    });
  }

  return { capabilitiesByDevice: { [LOCAL_NODE_DEVICE_ID]: capabilities } };
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
  /**
   * Read-only accessor for per-task GitHub references. Bound to
   * `GitHubStateStore.getReferences`; supplied when the scanner is wired.
   * When absent, the overlay is not computed and the `tied*` fields on
   * `ProjectSummary` are omitted.
   */
  getTaskGithubReferences?: (taskId: string) => GitHubReference[];
}

/**
 * Get agents with events projected for browser transport.
 * toolResponse is omitted; toolInput and lastMessage are capped.
 * Use this for WebSocket snapshot/update broadcasts.
 * See docs/rfc/rfc-snapshot-payload-slimming.md.
 */
export function getSnapshotAgentsForClient(deps: SnapshotQueryDeps): AgentState[] {
  return deps.monitor.getSnapshot().map((agent) => {
    const activityMeta = deps.activityMetaProvider?.getActivityMeta(agent.agentId);
    return {
      ...agent,
      events: agent.events.map(projectEventForClient),
      ...(agent.findingEvidenceAudit
        ? { findingEvidenceAudit: projectFindingEvidenceAuditForClient(agent.findingEvidenceAudit) }
        : {}),
      ...(activityMeta ? { activityMeta } : {}),
    };
  });
}

function projectFindingEvidenceAuditForClient(record: FindingEvidenceAuditRecord): FindingEvidenceAuditRecord {
  return {
    ...record,
    observations: record.observations.map((observation) => ({
      sampledAt: observation.sampledAt,
      ageMs: observation.ageMs,
      source: observation.source,
      anomalyStillPresent: observation.anomalyStillPresent,
      lastEventType: observation.lastEventType,
      eventCount: observation.eventCount,
      ...(observation.lastEventSeq !== undefined ? { lastEventSeq: observation.lastEventSeq } : {}),
      ...(observation.paneHash !== undefined ? { paneHash: observation.paneHash } : {}),
      ...(observation.paneChangedSincePrevious !== undefined
        ? { paneChangedSincePrevious: observation.paneChangedSincePrevious }
        : {}),
    })),
  };
}

/**
 * Get agents with events at full fidelity.
 * Use this for debug endpoints (/api/snapshot, /api/agents/:id) and any
 * server-internal caller that needs the raw toolResponse / toolInput / lastMessage.
 */
export function getSnapshotAgentsRaw(deps: SnapshotQueryDeps): AgentState[] {
  const raw = deps.monitor.getSnapshot();
  // Preserve identity when no provider is wired — callers (and tests) that
  // assert reference equality on the bare monitor snapshot stay green.
  if (!deps.activityMetaProvider) return raw;
  return raw.map((agent) => {
    const activityMeta = deps.activityMetaProvider!.getActivityMeta(agent.agentId);
    return activityMeta ? { ...agent, activityMeta } : agent;
  });
}

export function createSnapshotMessage(deps: SnapshotMessageDeps): SnapshotMessage {
  const speechCapabilities = deps.speechCapabilities ?? buildLocalSpeechCapabilities({
    sttUrl: deps.sttUrl,
    ttsUrl: deps.ttsUrl,
    now: deps.now,
  });
  return {
    type: 'snapshot',
    agents: getSnapshotAgentsForClient(deps),
    serverCwd: deps.serverCwd,
    ...(deps.serverRevision !== undefined ? { serverRevision: deps.serverRevision } : {}),
    ...(deps.buildInfo ? { build: deps.buildInfo } : {}),
    ...(deps.serverStartedAt ? { serverStartedAt: deps.serverStartedAt } : {}),
    ...(deps.sttUrl ? { sttEnabled: true, sttUrl: deps.sttUrl } : {}),
    ...(deps.ttsUrl ? { ttsEnabled: true, ttsUrl: deps.ttsUrl } : {}),
    ...(speechCapabilities ? { speechCapabilities } : {}),
    ...(deps.totalSpendUsd !== undefined ? { totalSpendUsd: deps.totalSpendUsd } : {}),
    ...(deps.achievements ? { achievements: deps.achievements } : {}),
    ...(deps.achievementCounters ? { achievementCounters: deps.achievementCounters } : {}),
    ...(deps.achievementStreak ? { achievementStreak: deps.achievementStreak } : {}),
    ...(deps.availableAgentTypes ? { availableAgentTypes: deps.availableAgentTypes } : {}),
    ...(deps.defaultAgentType ? { defaultAgentType: deps.defaultAgentType } : {}),
    ...(deps.workspaceEnabled ? { workspaceEnabled: true } : {}),
    ...(deps.sweepRunning ? { sweepRunning: true } : {}),
    ...(deps.getMaxActiveTasks ? { maxActiveTasks: deps.getMaxActiveTasks() } : {}),
  };
}

export function getProjectSummaries(deps: ProjectSummaryQueryDeps): ProjectSummary[] {
  const agents = getSnapshotAgentsRaw(deps);
  const githubTaskOverlay = deps.getTaskGithubReferences
    ? buildGithubTaskOverlay({ agents, getTaskGithubReferences: deps.getTaskGithubReferences })
    : undefined;
  return computeProjectSummaries({
    agents,
    ledgerAnalytics: deps.ledgerAnalytics,
    configStore: deps.projectConfigStore,
    skillTrackedProjects: deps.getSkillTrackedProjects?.(),
    registryActiveProjects: deps.getRegistryActiveProjects?.(),
    sidebarProjects: deps.getSidebarProjects?.(),
    prLessonsHolder: deps.prLessonsHolder,
    repoHealthCache: deps.repoHealthCache,
    githubTaskOverlay,
  });
}
