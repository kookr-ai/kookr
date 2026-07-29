import type { Monitor } from '../../core/monitor.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { BuildInfo } from '../../core/build-info.js';
import { computeProjectSummaries } from '../../core/project-summary.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { AvailableAgentType, AgentSelection } from '../../core/agent-types.js';
import type { ProjectSummary, ProjectRepoHealth } from '../../core/project-summary.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { DrainStatusSnapshot, SnapshotMessage, WorkspaceSweepProgressSnapshot } from '../../shared/contracts/messages.js';
import type { CollaborationCapabilities, SpeechCapability } from '../../shared/contracts/speech.js';
import {
  projectAgentFieldsForClient,
  projectEventForClient,
  projectTerminalAgentFieldsForClient,
} from '../event-projection.js';
import type { AgentActivityMeta } from '../../core/types.js';
import { buildGithubTaskOverlay } from './github-task-overlay.js';
import type { FindingEvidenceAuditRecord } from '../../shared/contracts/anomalies.js';
import type { PendingAgentSignal } from '../../shared/contracts/agent-signal.js';
import { deriveStuckReason } from '../../core/stuck-reason.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import { buildCoordinatorSnapshotState, type CoordinatorAuditTailProvider, type CoordinatorTask } from '../coordinator/detectors.js';
import type { CoordinatorSuppressionReader } from '../coordinator/suppression-store.js';
import { buildRelationProjection, deriveEffectiveAttentionSeverity } from './build-relation-projection.js';
import type { TaskRelation } from '../../shared/contracts/task-relations.js';
import type { PromptStatus } from '../../shared/contracts/terminal-input.js';
import {
  buildSnapshotProjection,
  SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
} from './snapshot-projection.js';
import { isTerminalStatus } from '../../core/task-status.js';
import {
  projectUserInputDeliveryForClient,
  type UserInputDeliverySnapshot,
} from '../../shared/contracts/user-input-delivery.js';
import { isProjectInScope, type Scope } from '../viewer-data-policy.js';

export interface SnapshotQueryDeps {
  monitor: Pick<Monitor, 'getSnapshot'> & Partial<Pick<Monitor, 'getTaskSnapshot'>>;
  /** Optional provider of per-Kookr-session activity counters. Wires
   *  {@link AgentState.activityMeta} on each snapshot so the activity panel
   *  can disclose partial-window state and child / malformed counts. */
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  terminalInputSnapshots?: {
    getSnapshot(sessionId: string): {
      sessionId: string;
      inputStateEpoch: string;
      readinessVersion: number;
      prompt: PromptStatus;
    } | null;
  };
  /**
   * Optional accessor for a task's pending agent → user signal (RFC:
   * rfc-agent-signal-surface). When wired, {@link getSnapshotAgentsForClient}
   * joins the signal onto each agent's client-facing state as `pendingSignal`.
   * Bound to {@link TaskStore.getPendingSignal}. {@link createSnapshotMessage}
   * defaults it from `relationTaskStore` so the common snapshot path carries
   * signals without per-call-site wiring.
   */
  pendingSignalProvider?: { getPendingSignal(taskId: string): PendingAgentSignal | undefined };
  userInputDeliveryProvider?: {
    getSnapshot(sessionId: string): UserInputDeliverySnapshot[];
  };
  /**
   * Viewer scope filter (RFC: rfc-shared-view-readonly.md §"Outbound scope
   * filtering", #809). Additive and default-`all`: omitted (or `all`) means no
   * filtering, so every existing owner/debug caller is unchanged. A `projects`
   * scope restricts the projected agents to those whose `projectId` is in scope
   * — **unassigned agents (no `projectId`) are hidden** from a `projects` viewer
   * (default-deny scrub-list) and shown only to `all`. The single owner of WS
   * scope filtering ({@link buildScopedSnapshot}, wired at bootstrap) threads
   * this through {@link createSnapshotMessage}/{@link getProjectSummaries}.
   */
  scope?: Scope;
  /** Injectable clock (tests). Drives the aged-terminal-task snapshot cutoff. */
  now?: () => Date;
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
  bypassAllPermissions?: boolean;
  sweepRunning?: boolean;
  sweepProgress?: WorkspaceSweepProgressSnapshot;
  lastSweepRunId?: string;
  drainStatus?: DrainStatusSnapshot;
  /** Live getter for the configured concurrency cap (settings.maxActiveTasks). */
  getMaxActiveTasks?: () => number;
  coordinator?: {
    taskStore: Pick<TaskStore, 'listTasks'>;
    auditTailProvider?: CoordinatorAuditTailProvider;
    suppressions?: CoordinatorSuppressionReader;
  };
  /**
   * Task-relation graph source for the snapshot's `taskRelations` projection
   * and per-agent `childRollup` (#601). When omitted the snapshot ships
   * without relation data — existing consumers continue working unchanged
   * because the new fields are all optional.
   *
   * `getTask` is optional (production passes the full TaskStore): when
   * present it supplies the child-status fallback for rollups over aged
   * terminal children that the C2 payload diet excludes from the snapshot.
   */
  relationTaskStore?: Pick<TaskStore, 'listRelations' | 'getPendingSignal'> & Partial<Pick<TaskStore, 'getTask'>>;
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
  /**
   * Verified open/closed state per reference, bound to
   * `GitHubStateStore.isRefOpen`. When supplied, the tied-counts overlay only
   * counts refs GitHub has confirmed open — see
   * {@link BuildGithubTaskOverlayInput.getRefOpenState}.
   */
  getGithubRefOpenState?: (ref: GitHubReference) => boolean | undefined;
}

/**
 * Get agents with events projected for browser transport.
 * toolResponse is omitted; toolInput and lastMessage are capped.
 * Terminal-status entries are additionally slimmed (bounded `description`,
 * dropped dead-weight fields) and terminal tasks older than
 * {@link SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS} are excluded entirely
 * (issue #1526 Phase C / C2 payload diet) — REST keeps serving them.
 * Use this for WebSocket snapshot/update broadcasts.
 * See docs/rfc/rfc-snapshot-payload-slimming.md.
 */
export function getSnapshotAgentsForClient(deps: SnapshotQueryDeps): AgentState[] {
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  return getProjectedSnapshotAgents(deps, {
    excludeTerminalBeforeMs: nowMs - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
  }).map((agent) => {
    const activityMeta = deps.activityMetaProvider?.getActivityMeta(agent.agentId);
    const terminalSnapshot = agent.taskId
      ? deps.terminalInputSnapshots?.getSnapshot(agent.agentId)
      : null;
    const pendingSignal = agent.taskId && typeof deps.pendingSignalProvider?.getPendingSignal === 'function'
      ? deps.pendingSignalProvider.getPendingSignal(agent.taskId)
      : undefined;
    // stuckReason (issue #1526 Phase B): derived from signals already on the
    // projected agent — no extra watchdog/queue lookup here. `agent.anomaly`
    // already reflects the watchdog's queued verdict (Monitor.getCurrentAnomaly
    // falls back to AttentionQueue.peek), so this stays free — the cost was
    // already paid building the snapshot regardless of this field.
    const stuckReason = agent.taskStatus
      ? deriveStuckReason({ status: agent.taskStatus, pendingSignal, anomalyType: agent.anomaly?.type ?? null })
      : null;
    const userInputDeliveries = deps.userInputDeliveryProvider
      ?.getSnapshot(agent.agentId)
      .map(projectUserInputDeliveryForClient);
    const projected = projectAgentFieldsForClient({
      ...agent,
      events: agent.events.map(projectEventForClient),
      ...(agent.findingEvidenceAudit
        ? { findingEvidenceAudit: projectFindingEvidenceAuditForClient(agent.findingEvidenceAudit) }
        : {}),
      ...(activityMeta ? { activityMeta } : {}),
      ...(pendingSignal ? { pendingSignal } : {}),
      ...(stuckReason ? { stuckReason } : {}),
      ...(userInputDeliveries && userInputDeliveries.length > 0 ? { userInputDeliveries } : {}),
      ...(terminalSnapshot ? {
        terminalInputSnapshot: {
          sessionId: agent.agentId,
          taskId: agent.taskId!,
          inputStateEpoch: terminalSnapshot.inputStateEpoch,
          readinessVersion: terminalSnapshot.readinessVersion,
          promptReady: terminalSnapshot.prompt.kind === 'ready',
        },
      } : {}),
    });
    // Terminal rows carry no live event window and only feed the Completed
    // pane — bound their heavy fields harder (issue #1526 Phase C / C2).
    return agent.taskStatus && isTerminalStatus(agent.taskStatus)
      ? projectTerminalAgentFieldsForClient(projected)
      : projected;
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
  const raw = getProjectedSnapshotAgents(deps);
  // Preserve identity when no provider is wired — callers (and tests) that
  // assert reference equality on the bare monitor snapshot stay green.
  if (!deps.activityMetaProvider) return raw;
  return raw.map((agent) => {
    const activityMeta = deps.activityMetaProvider!.getActivityMeta(agent.agentId);
    return activityMeta ? { ...agent, activityMeta } : agent;
  });
}

function getProjectedSnapshotAgents(
  deps: SnapshotQueryDeps,
  opts: { excludeTerminalBeforeMs?: number } = {},
): AgentState[] {
  const rawMonitorStates = deps.monitor.getSnapshot();
  const taskSnapshot = deps.monitor.getTaskSnapshot?.();
  // Lightweight tests and legacy mocks may provide only raw monitor state.
  // The real server Monitor implements getTaskSnapshot, so production
  // dashboard paths receive task/session projection from this use-case.
  const projected = !taskSnapshot
    ? rawMonitorStates
    : buildSnapshotProjection({
        monitorStates: rawMonitorStates,
        tasks: taskSnapshot,
        ...(opts.excludeTerminalBeforeMs !== undefined
          ? { excludeTerminalBeforeMs: opts.excludeTerminalBeforeMs }
          : {}),
      });
  return filterAgentsToScope(projected, deps.scope);
}

/**
 * Restrict projected agents to a viewer's {@link Scope}. `all` (or undefined)
 * returns the input array **by identity** so non-viewer callers (owners, debug
 * endpoints, reference-equality tests) are byte-for-byte unchanged. A `projects`
 * scope keeps only agents whose `projectId` is in scope; agents with no
 * `projectId` (unassigned) are hidden from a `projects` viewer per the RFC
 * default-deny scrub-list.
 */
function filterAgentsToScope(agents: AgentState[], scope: Scope | undefined): AgentState[] {
  if (!scope || scope.kind === 'all') return agents;
  return agents.filter((agent) => agent.projectId !== undefined && isProjectInScope(scope, agent.projectId));
}

/**
 * A `listRelations`-only view of a relation store whose edges are pre-filtered to
 * the in-scope task set (both endpoints among `inScopeAgents`' task ids). Used by
 * {@link createSnapshotMessage} for a `projects` scope so that every projection
 * derived from the relation graph — the flat `taskRelations` array AND the
 * per-parent `childRollup` counts — references only in-scope tasks. Default-deny:
 * an edge whose endpoint has no in-scope agent/synthetic entry is dropped.
 */
function scopedRelationStore(
  store: Pick<TaskStore, 'listRelations'>,
  inScopeAgents: readonly AgentState[],
): Pick<TaskStore, 'listRelations'> {
  const inScopeTaskIds = new Set(
    inScopeAgents.map((agent) => agent.taskId).filter((id): id is string => id !== undefined),
  );
  return {
    listRelations: (filter) =>
      store
        .listRelations(filter)
        .filter((rel) => inScopeTaskIds.has(rel.sourceTaskId) && inScopeTaskIds.has(rel.targetTaskId)),
  };
}

export function createSnapshotMessage(deps: SnapshotMessageDeps): SnapshotMessage {
  const speechCapabilities = deps.speechCapabilities ?? buildLocalSpeechCapabilities({
    sttUrl: deps.sttUrl,
    ttsUrl: deps.ttsUrl,
    now: deps.now,
  });
  // Default the pending-signal provider from relationTaskStore so the common
  // snapshot path (every caller that already passes relationTaskStore: taskStore)
  // carries agent signals without per-call-site wiring. Explicit
  // pendingSignalProvider still wins for callers that set it.
  const baseAgents = getSnapshotAgentsForClient({
    ...deps,
    pendingSignalProvider: deps.pendingSignalProvider
      ?? (typeof deps.relationTaskStore?.getPendingSignal === 'function' ? deps.relationTaskStore : undefined),
  });

  // For a `projects` viewer, every whole-world sub-projection is omitted by the
  // default-deny scrub-list (RFC §"Outbound scope filtering"). This is enforced
  // HERE — not only by omitting deps at the call site — so `createSnapshotMessage`
  // itself is the single scope authority: a careless caller that passes
  // `coordinator`/`totalSpendUsd`/`speechCapabilities`/etc. alongside a
  // `projects` scope still cannot leak them.
  const projectsScope = deps.scope?.kind === 'projects';

  let taskRelations: TaskRelation[] | undefined;
  let agents = baseAgents;
  if (deps.relationTaskStore) {
    // For a `projects` scope, project the relation graph over a store view whose
    // edges are pre-filtered to in-scope↔in-scope tasks. This scopes BOTH the
    // flat `taskRelations` array AND the per-parent `childRollup` counts (which
    // are derived from `spawned_by` edges) — an out-of-scope child must not leak
    // via a parent's `childCount`. `baseAgents` is already scope-filtered, so its
    // task ids are exactly the in-scope task set (default-deny: an edge whose
    // endpoint has no in-scope agent/synthetic entry is dropped).
    const relationStore = projectsScope
      ? scopedRelationStore(deps.relationTaskStore, baseAgents)
      : deps.relationTaskStore;
    const getTask = deps.relationTaskStore.getTask;
    const projection = buildRelationProjection(relationStore, baseAgents, {
      // Child-status fallback for aged terminal children excluded from the
      // snapshot (C2 payload diet) so parent rollups stay `completed`.
      ...(typeof getTask === 'function'
        ? { getTaskStatus: (taskId: string) => getTask.call(deps.relationTaskStore, taskId)?.status }
        : {}),
    });
    taskRelations = projection.taskRelations;
    if (projection.rollupsByParentTaskId.size > 0) {
      agents = baseAgents.map((agent) => {
        const rollup = agent.taskId ? projection.rollupsByParentTaskId.get(agent.taskId) : undefined;
        if (!rollup) return agent;
        const effectiveSeverity = deriveEffectiveAttentionSeverity(agent.anomaly?.severity, rollup);
        return {
          ...agent,
          childRollup: rollup,
          ...(effectiveSeverity ? { effectiveAttentionSeverity: effectiveSeverity } : {}),
        };
      });
    }
  }

  return {
    type: 'snapshot',
    agents,
    serverCwd: deps.serverCwd,
    ...(deps.serverRevision !== undefined ? { serverRevision: deps.serverRevision } : {}),
    ...(deps.buildInfo ? { build: deps.buildInfo } : {}),
    ...(deps.serverStartedAt ? { serverStartedAt: deps.serverStartedAt } : {}),
    // Speech endpoints, owner-config capabilities (agent types, workspace), and
    // whole-world aggregates/detector-state are all scrubbed for a `projects`
    // viewer (default-deny). A scoped snapshot carries only the in-scope agents,
    // their relations/rollups, and non-sensitive build/version metadata.
    ...(deps.sttUrl && !projectsScope ? { sttEnabled: true, sttUrl: deps.sttUrl } : {}),
    ...(deps.ttsUrl && !projectsScope ? { ttsEnabled: true, ttsUrl: deps.ttsUrl } : {}),
    ...(speechCapabilities && !projectsScope ? { speechCapabilities } : {}),
    ...(deps.totalSpendUsd !== undefined && !projectsScope ? { totalSpendUsd: deps.totalSpendUsd } : {}),
    ...(deps.achievements && !projectsScope ? { achievements: deps.achievements } : {}),
    ...(deps.achievementCounters && !projectsScope ? { achievementCounters: deps.achievementCounters } : {}),
    ...(deps.achievementStreak && !projectsScope ? { achievementStreak: deps.achievementStreak } : {}),
    ...(deps.availableAgentTypes && !projectsScope ? { availableAgentTypes: deps.availableAgentTypes } : {}),
    ...(deps.defaultAgentType && !projectsScope ? { defaultAgentType: deps.defaultAgentType } : {}),
    ...(deps.workspaceEnabled && !projectsScope ? { workspaceEnabled: true } : {}),
    ...(deps.bypassAllPermissions && !projectsScope ? { bypassAllPermissions: true } : {}),
    ...(deps.sweepRunning && !projectsScope ? { sweepRunning: true } : {}),
    ...(deps.sweepProgress && !projectsScope ? { sweepProgress: deps.sweepProgress } : {}),
    ...(deps.lastSweepRunId && !projectsScope ? { lastSweepRunId: deps.lastSweepRunId } : {}),
    ...(deps.drainStatus && !projectsScope ? { drainStatus: deps.drainStatus } : {}),
    ...(deps.getMaxActiveTasks && !projectsScope ? { maxActiveTasks: deps.getMaxActiveTasks() } : {}),
    // Coordinator is whole-world detector state — omitted for a `projects` viewer.
    ...(deps.coordinator && !projectsScope ? {
      coordinator: buildCoordinatorSnapshotState(
        { tasks: buildCoordinatorDetectorTasks(deps.coordinator.taskStore.listTasks(), agents) },
        deps.coordinator.auditTailProvider?.getCoordinatorAuditTail() ?? [],
        {
          ...(deps.now ? { now: deps.now() } : {}),
          ...(deps.coordinator.suppressions ? { suppressions: deps.coordinator.suppressions } : {}),
        },
      ),
    } : {}),
    // Always ship the field (possibly an empty array) when the relation store is
    // wired: clients use the presence of the field as a signal to overwrite their
    // sticky cache. Omitting on empty would leave stale edges visible after a
    // task is deleted, since deletion hard-removes its relations without a
    // `superseded` transition. See PR #601 review notes.
    ...(taskRelations !== undefined ? { taskRelations } : {}),
  };
}

export function buildCoordinatorDetectorTasks(
  tasks: readonly Task[],
  agents: readonly AgentState[],
): CoordinatorTask[] {
  const agentsByTaskId = new Map<string, AgentState>();
  for (const agent of agents) {
    if (!agent.taskId) continue;
    const prior = agentsByTaskId.get(agent.taskId);
    if (!prior || (!prior.anomaly && agent.anomaly)) agentsByTaskId.set(agent.taskId, agent);
  }

  return tasks.map((task) => {
    const agent = agentsByTaskId.get(task.id);
    if (!agent) return task;
    return {
      ...task,
      ...(agent.anomaly ? { anomaly: agent.anomaly } : {}),
      ...(agent.completionDigest && !task.completionDigest ? { completionDigest: agent.completionDigest } : {}),
      ...(agent.completionFeedback && !task.completionFeedback ? { completionFeedback: agent.completionFeedback } : {}),
    };
  });
}

export function getProjectSummaries(deps: ProjectSummaryQueryDeps): ProjectSummary[] {
  const agents = getSnapshotAgentsRaw(deps);
  const githubTaskOverlay = deps.getTaskGithubReferences
    ? buildGithubTaskOverlay({
        agents,
        getTaskGithubReferences: deps.getTaskGithubReferences,
        getRefOpenState: deps.getGithubRefOpenState,
      })
    : undefined;
  const summaries = computeProjectSummaries({
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
  // `agents` is already scope-filtered, but `computeProjectSummaries` also seeds
  // summaries from config/registry/sidebar project lists that are NOT agent-
  // derived, so a `projects` viewer must additionally drop out-of-scope summaries.
  const { scope } = deps;
  if (scope && scope.kind === 'projects') {
    return summaries.filter((summary) => isProjectInScope(scope, summary.project));
  }
  return summaries;
}
