import { join } from 'node:path';

import type { AdapterRegistry } from '../../adapters/agent-adapter.js';
import { AVAILABLE_AGENT_TYPES, type AgentSelection } from '../../core/agent-types.js';
import { ACHIEVEMENT_BY_ID } from '../../core/achievement-catalog.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { Monitor } from '../../core/monitor.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { MAX_TRACKED_REPOS, type ProjectRepoHealth } from '../../core/project-summary.js';
import type { SkillDiscoveryStateHolder } from '../../core/skill-tracked-repo-discovery.js';
import type { TaskStore } from '../../core/tasks.js';
import type { ServerMessage, SnapshotMessage } from '../../shared/contracts/messages.js';
import { buildCoordinatorSnapshotState, type CoordinatorAuditTailProvider } from '../coordinator/detectors.js';
import type { CoordinatorSuppressionReader } from '../coordinator/suppression-store.js';
import { AchievementWatcher, loadAchievements } from '../achievement-watcher.js';
import type { ScheduleStore } from '../../core/schedule.js';
import { toOssAttemptsSnapshot } from '../oss-attempts-snapshot.js';
import type { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { buildCoordinatorDetectorTasks, createSnapshotMessage, getProjectSummaries, getSnapshotAgentsForClient } from '../use-cases/get-snapshot.js';
import {
  ViewerConnectionRegistry,
  type GrantLiveness,
  type SweepEviction,
} from '../viewer-connection-registry.js';
import { ViewerAwareBroadcaster } from '../viewer-broadcaster.js';
import type { SnapshotPayloadSizeObservation } from '../snapshot-payload-size-policy.js';
import type { Scope } from '../viewer-data-policy.js';
import type { IsActorAllowedTerminalSession } from '../terminal-scope.js';

const SNAPSHOT_PAYLOAD_WARN_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS = {
  warnBytes: SNAPSHOT_PAYLOAD_WARN_BYTES,
  maxBytes: SNAPSHOT_PAYLOAD_MAX_BYTES,
} as const;

export interface RealtimeServicesDeps {
  kookrDir: string;
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapterRegistry: AdapterRegistry;
  serverCwd: string;
  sttUrl?: string;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  projectSidebarStore: ProjectSidebarStore;
  skillDiscoveryState: SkillDiscoveryStateHolder;
  prLessonsState: PrLessonsStateHolder;
  getRegistryActiveProjects: () => string[];
  getRegistryActiveRepos: () => string[];
  ossAttemptStore: OssAttemptStore;
  getDefaultAgentType: () => AgentSelection;
  bypassAllPermissions?: boolean;
  coordinatorAuditTailProvider?: CoordinatorAuditTailProvider;
  coordinatorSuppressions?: CoordinatorSuppressionReader;
  /**
   * Resolve a viewer grant's liveness for the revocation sweep. Injected when
   * viewers are wired (#806/#808); omitted in Phase 1, where no viewer can
   * connect and the registry default treats every grant as active.
   */
  resolveGrantLiveness?: (grantId: string) => GrantLiveness;
  /** Audit hook fired once per sweep-evicted viewer socket (#808 / R10). */
  onViewerEvicted?: (eviction: SweepEviction) => void;
  /**
   * Terminal scope predicate (#810) handed to the registry sweep so it can drop
   * terminal viewer sockets whose task was reassigned out of scope (RFC F8).
   * Production wires the real checker (`index.ts`); omitted in lightweight test
   * wirings, where the sweep performs no scope re-check.
   */
  isActorAllowedTerminalSession?: IsActorAllowedTerminalSession;
  /**
   * Build the scope-filtered snapshot for a viewer (#809). Production wires the
   * real factory (`index.ts`); when omitted (lightweight test wirings, or any
   * caller that has no viewers) the default stub fails closed if ever invoked
   * rather than leaking the unfiltered `all` snapshot.
   */
  buildScopedSnapshot?: (scope: Scope) => SnapshotMessage;
  /**
   * Outbound snapshot payload guard (#832). Production uses conservative MiB
   * defaults; tests can lower the thresholds to exercise warn/drop behavior.
   */
  snapshotPayloadWarnBytes?: number;
  snapshotPayloadMaxBytes?: number;
  observeSnapshotPayloadSize?: (observation: SnapshotPayloadSizeObservation) => void;
}

export interface RealtimeServices {
  /** Sole owner of the dashboard + terminal socket pools (replaces the bare `clients` set). */
  registry: ViewerConnectionRegistry;
  achievementWatcher: AchievementWatcher;
  broadcastToAll: (msg: ServerMessage) => void;
  broadcastProjectSummaries: () => void;
  broadcastOssAttempts: () => void;
  getWsBroadcastCount: () => number;
  setScheduleStore: (store: ScheduleStore) => void;
  setSnapshotAchievementsReady: (ready: boolean) => void;
  setProjectSummaryGitHubDeps: (deps: ProjectSummaryGitHubDeps) => void;
  setCoordinatorAuditTailProvider: (provider: CoordinatorAuditTailProvider) => void;
}

export interface ProjectSummaryGitHubDeps {
  getRepoHealthSnapshot: () => ReadonlyMap<string, ProjectRepoHealth>;
  getTaskGithubReferences: (taskId: string) => GitHubReference[];
  /** Bound to `GitHubStateStore.isRefOpen` — verified-open gate for tied counts. */
  getGithubRefOpenState: (ref: GitHubReference) => boolean | undefined;
  setTrackedGithubRepos: (repos: string[]) => void;
}

export async function createRealtimeServices(deps: RealtimeServicesDeps): Promise<RealtimeServices> {
  const achievementsFile = join(deps.kookrDir, 'achievements.json');
  const achievementState = await loadAchievements(achievementsFile);
  const registry = new ViewerConnectionRegistry({
    resolveGrantLiveness: deps.resolveGrantLiveness,
    isActorAllowedTerminalSession: deps.isActorAllowedTerminalSession,
    onEvict: deps.onViewerEvicted,
  });
  const broadcaster = new ViewerAwareBroadcaster({
    registry,
    buildScopedSnapshot:
      deps.buildScopedSnapshot ??
      ((scope) => {
        // Fail-closed default for callers that did not wire the real factory
        // (#809 wires it in production via index.ts): error rather than serve the
        // unfiltered `all` snapshot to a scoped viewer.
        throw new Error(
          `[viewer-broadcaster] scoped snapshot for ${scope.kind} scope requested but no buildScopedSnapshot was wired`,
        );
      }),
    snapshotPayloadSizePolicy: {
      warnBytes: deps.snapshotPayloadWarnBytes ?? DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS.warnBytes,
      maxBytes: deps.snapshotPayloadMaxBytes ?? DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS.maxBytes,
      ...(deps.observeSnapshotPayloadSize ? { observe: deps.observeSnapshotPayloadSize } : {}),
    },
  });
  let achievementWatcher: AchievementWatcher;
  let wsBroadcastCount = 0;
  let scheduleStore: ScheduleStore | null = null;
  let snapshotAchievementsReady = false;
  let projectSummaryGitHubDeps: ProjectSummaryGitHubDeps | null = null;
  let coordinatorAuditTailProvider = deps.coordinatorAuditTailProvider;

  function broadcastToAll(msg: ServerMessage): void {
    wsBroadcastCount++;
    if (msg.type === 'snapshot') {
      if (snapshotAchievementsReady && achievementWatcher && scheduleStore) {
        try {
          const tasks = deps.taskStore.listTasks();
          const distinctProjectIds = new Set(
            tasks.map((t) => t.projectId).filter((p): p is string => !!p),
          );
          achievementWatcher.check({
            type: 'snapshot',
            state: {
              scheduleCount: scheduleStore.list().length,
              projectCount: distinctProjectIds.size,
              hasCodexTask: tasks.some((t) => t.agentType === 'codex-cli'),
              hasFeedbackTask: tasks.some((t) => !!t.completionFeedback),
              hasSnoozedFinding: deps.queue.getSnoozed().length > 0,
              hasKookrSubject: tasks.some(
                (t) => /\bkookr\b/i.test(t.name ?? '') || /\bkookr\b/i.test(t.prompt ?? ''),
              ),
              unsnoozedFindingCount: deps.queue.getAll().length,
            },
          });
        } catch (err) {
          console.warn('[achievements] Snapshot state check failed, continuing', err);
        }
      }
      msg = {
        ...msg,
        coordinator: msg.coordinator ?? buildCoordinatorSnapshotState(
            { tasks: buildCoordinatorDetectorTasks(deps.taskStore.listTasks(), snapshotAgentsForCoordinator(msg)) },
            coordinatorAuditTailProvider?.getCoordinatorAuditTail() ?? [],
            deps.coordinatorSuppressions ? { suppressions: deps.coordinatorSuppressions } : {},
        ),
        totalSpendUsd: deps.taskStore.getLifetimeSpendUsd(),
        ...(deps.bypassAllPermissions ? { bypassAllPermissions: true } : {}),
        achievements: achievementWatcher?.getUnlocked(),
        ...(achievementWatcher
          ? {
              achievementCounters: achievementWatcher.getCounters(),
              achievementStreak: achievementWatcher.getStreak(),
            }
          : {}),
      };
      msg = {
        ...msg,
        availableAgentTypes: AVAILABLE_AGENT_TYPES.filter((item) => deps.adapterRegistry.getTypes().includes(item.type)),
        defaultAgentType: deps.getDefaultAgentType(),
      };
    }
    // The registry owns the socket pool; the broadcaster is pure transport over
    // its dashboard-socket snapshot (drops + closes on send failure).
    broadcaster.broadcast(msg);
  }

  function snapshotAgentsForCoordinator(msg: SnapshotMessage): SnapshotMessage['agents'] {
    if (msg.agents.length > 0) return msg.agents;
    return getSnapshotAgentsForClient({ monitor: deps.monitor });
  }

  achievementWatcher = new AchievementWatcher(achievementsFile, achievementState, (unlock) => {
    const def = ACHIEVEMENT_BY_ID.get(unlock.id);
    if (def) {
      broadcastToAll({
        type: 'achievement:unlocked',
        id: unlock.id,
        name: def.name,
        emoji: def.emoji,
        description: def.description,
        unlockedAt: unlock.unlockedAt,
      });
    }
  });

  function broadcastProjectSummaries(): void {
    const projects = getProjectSummaries({
      monitor: deps.monitor,
      ledgerAnalytics: deps.ledgerAnalytics,
      projectConfigStore: deps.projectConfigStore,
      getSidebarProjects: () => deps.projectSidebarStore.getSeedProjects(),
      getSkillTrackedProjects: () => deps.skillDiscoveryState.getProjects(),
      getRegistryActiveProjects: deps.getRegistryActiveProjects,
      prLessonsHolder: deps.prLessonsState,
      ...(projectSummaryGitHubDeps
        ? {
            repoHealthCache: projectSummaryGitHubDeps.getRepoHealthSnapshot(),
            getTaskGithubReferences: projectSummaryGitHubDeps.getTaskGithubReferences,
            getGithubRefOpenState: projectSummaryGitHubDeps.getGithubRefOpenState,
          }
        : {}),
    });
    if (projectSummaryGitHubDeps) {
      projectSummaryGitHubDeps.setTrackedGithubRepos(
        projects.map((s) => s.project).slice(0, MAX_TRACKED_REPOS),
      );
    }
    broadcastToAll({ type: 'projectSummaries', projects });
  }

  function broadcastOssAttempts(): void {
    broadcastToAll({
      type: 'ossAttempts',
      store: toOssAttemptsSnapshot(deps.ossAttemptStore, deps.getRegistryActiveRepos()),
    });
  }

  return {
    registry,
    achievementWatcher,
    broadcastToAll,
    broadcastProjectSummaries,
    broadcastOssAttempts,
    getWsBroadcastCount: () => wsBroadcastCount,
    setScheduleStore: (store) => {
      scheduleStore = store;
    },
    setSnapshotAchievementsReady: (ready) => {
      snapshotAchievementsReady = ready;
    },
    setProjectSummaryGitHubDeps: (githubDeps) => {
      projectSummaryGitHubDeps = githubDeps;
    },
    setCoordinatorAuditTailProvider: (provider) => {
      coordinatorAuditTailProvider = provider;
    },
  };
}
