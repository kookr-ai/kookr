import { join } from 'node:path';

import type { AdapterRegistry } from '../../adapters/agent-adapter.js';
import { AVAILABLE_AGENT_TYPES, type AgentSelection } from '../../core/agent-types.js';
import { ACHIEVEMENT_BY_ID } from '../../core/achievement-catalog.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { LedgerAnalytics } from '../../core/ledger-analytics.js';
import type { AgentState, Monitor } from '../../core/monitor.js';
import type { PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import type { ProjectConfigStore } from '../../core/project-config-store.js';
import type { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { MAX_TRACKED_REPOS, type ProjectRepoHealth } from '../../core/project-summary.js';
import type { SkillDiscoveryStateHolder } from '../../core/skill-tracked-repo-discovery.js';
import type { TaskStore } from '../../core/tasks.js';
import type { DrainStatusSnapshot, ServerMessage, SnapshotMessage } from '../../shared/contracts/messages.js';
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
import { SnapshotStreamSequencer, stampSnapshotPosition, type StreamPosition } from '../snapshot-stream-sequencer.js';
import { buildDeltaFromSnapshots, readWsDeltaEnabledFromEnv } from '../snapshot-delta.js';
import type { SnapshotPayloadSizeObservation } from '../snapshot-payload-size-policy.js';
import type { Scope } from '../viewer-data-policy.js';
import type { IsActorAllowedTerminalSession } from '../terminal-scope.js';
import { WebSocketLoadShedGate, type WebSocketLoadShedConfig } from '../websocket-load-shed.js';

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
  getDrainStatus?: () => DrainStatusSnapshot;
  /** Automation kill-switch / SAFE MODE (issue #1710). */
  getSafeModeStatus?: () => import('../../shared/contracts/messages.js').SafeModeStatusSnapshot;
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
  buildScopedSnapshot?: (scope: Scope, baseClientAgents?: AgentState[]) => SnapshotMessage;
  /**
   * Compute the full-fleet client-projected base once per broadcast flush so
   * every distinct viewer scope reuses it instead of re-running the fleet
   * projection (#1398). Threaded straight into the broadcaster; optional so
   * lightweight/test wirings without it keep the pre-#1398 per-scope recompute.
   */
  computeSnapshotBaseAgents?: () => AgentState[];
  /**
   * Outbound snapshot payload guard (#832). Production uses conservative MiB
   * defaults; tests can lower the thresholds to exercise warn/drop behavior.
   */
  snapshotPayloadWarnBytes?: number;
  snapshotPayloadMaxBytes?: number;
  observeSnapshotPayloadSize?: (observation: SnapshotPayloadSizeObservation) => void;
  /**
   * Consecutive broadcasts a socket may sit above the soft bufferedAmount
   * threshold before it is disconnected outright (#1725). Omitted keeps the
   * `ViewerAwareBroadcaster` default.
   */
  backpressureDisconnectAfterSkips?: number;
  /**
   * Dead-socket ping/pong liveness reaping on the registry's existing
   * revocation-sweep tick (#1725). Omitted keeps the registry default (on).
   */
  livenessSweepEnabled?: boolean;
  /**
   * Event-loop-delay load-shed gate config (#1725). Only constructed (and
   * wired into the broadcaster) when provided — lightweight/test wirings that
   * omit it get the pre-#1725 behavior (snapshots always fully fan out).
   */
  loadShedConfig?: WebSocketLoadShedConfig;
  /**
   * Delta-protocol stream epoch (issue #1754, Stage 1). When provided
   * (production wires `serverStartedAt`), every emitted `snapshot` is stamped
   * with a monotonic `(epoch, seq)` so clients can detect an epoch change / seq
   * gap and re-base via the resync escape hatch. Omitted by lightweight/test
   * wirings, which then emit snapshots byte-identical to pre-#1754.
   */
  serverEpoch?: string;
  /**
   * Stage 2 delta emission (issue #1754). When true AND `serverEpoch` is wired,
   * steady-state `broadcastToAll(snapshot)` fans out a coalesced `delta` after
   * the first full-snapshot baseline rather than re-sending the full fleet.
   * Connect / resync / soft-backpressure re-base still use full snapshots.
   * Defaults to {@link readWsDeltaEnabledFromEnv} (`KOOKR_WS_DELTA`, default on).
   * Pass `false` in tests that assert pre-Stage-2 snapshot-only fan-out.
   */
  enableWsDelta?: boolean;
}

export interface RealtimeServices {
  /** Sole owner of the dashboard + terminal socket pools (replaces the bare `clients` set). */
  registry: ViewerConnectionRegistry;
  achievementWatcher: AchievementWatcher;
  broadcastToAll: (msg: ServerMessage) => void;
  broadcastProjectSummaries: () => void;
  broadcastOssAttempts: () => void;
  getWsBroadcastCount: () => number;
  /**
   * Current delta-protocol stream position `(epoch, seq)` for re-base frames
   * (connect-time snapshot, resync reply). `undefined` when no `serverEpoch`
   * was wired (Stage-1 sequencing disabled). Does NOT advance `seq` — the
   * per-flush advance happens inside `broadcastToAll`.
   */
  getStreamPosition: () => StreamPosition | undefined;
  setScheduleStore: (store: ScheduleStore) => void;
  setSnapshotAchievementsReady: (ready: boolean) => void;
  setProjectSummaryGitHubDeps: (deps: ProjectSummaryGitHubDeps) => void;
  setCoordinatorAuditTailProvider: (provider: CoordinatorAuditTailProvider) => void;
  /**
   * Feed one sampled event-loop delay p95 (ms) into the load-shed gate
   * (#1725). Wired to `ResourceStatusService`'s `onEventLoopDelaySample` at
   * bootstrap so the gate reuses the SAME measurement as the #1590 admission
   * guard. A no-op when `loadShedConfig` was not provided.
   */
  noteEventLoopDelaySample: (delayMs: number | null) => void;
  /**
   * Whether the #1725 WS load-shed gate is currently engaged (issue #2409).
   * Threaded into the event-pipeline coalesced flush (`getLoadShedActive`) so an
   * active shed skips the `createSnapshotMessage` rebuild — the broadcaster
   * discards snapshots built while the gate is active. Always `false` when no
   * `loadShedConfig` was wired (the gate is then absent).
   */
  isLoadShedActive: () => boolean;
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
    ...(deps.livenessSweepEnabled !== undefined ? { livenessSweepEnabled: deps.livenessSweepEnabled } : {}),
  });
  // #1725: only constructed when a config was provided, so lightweight/test
  // wirings that omit `loadShedConfig` keep pre-#1725 behavior (snapshots
  // always fully fan out; `noteEventLoopDelaySample` below is then a no-op).
  const loadShedGate = deps.loadShedConfig ? new WebSocketLoadShedGate(deps.loadShedConfig) : undefined;
  // #1754 Stage 1: only constructed when an epoch was wired, so lightweight/test
  // wirings that omit `serverEpoch` emit snapshots byte-identical to pre-#1754
  // (no `(epoch, seq)` stamping; `getStreamPosition` below then returns undefined).
  const sequencer = deps.serverEpoch ? new SnapshotStreamSequencer(deps.serverEpoch) : undefined;
  // #1754 Stage 2: delta emission requires the sequencer (epoch/seq identity).
  // Without a sequencer we stay on full-snapshot fan-out regardless of the flag.
  const enableWsDelta = (deps.enableWsDelta ?? readWsDeltaEnabledFromEnv()) && !!sequencer;
  /** Last fully-enriched snapshot that was stamped and fanned out (delta baseline). */
  let lastBroadcastSnapshot: SnapshotMessage | undefined;
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
    ...(deps.computeSnapshotBaseAgents ? { computeSnapshotBaseAgents: deps.computeSnapshotBaseAgents } : {}),
    snapshotPayloadSizePolicy: {
      warnBytes: deps.snapshotPayloadWarnBytes ?? DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS.warnBytes,
      maxBytes: deps.snapshotPayloadMaxBytes ?? DEFAULT_SNAPSHOT_PAYLOAD_SIZE_LIMITS.maxBytes,
      ...(deps.observeSnapshotPayloadSize ? { observe: deps.observeSnapshotPayloadSize } : {}),
    },
    ...(deps.backpressureDisconnectAfterSkips !== undefined
      ? { backpressureDisconnectAfterSkips: deps.backpressureDisconnectAfterSkips }
      : {}),
    ...(loadShedGate ? { loadShedGate } : {}),
  });
  let achievementWatcher: AchievementWatcher;
  let wsBroadcastCount = 0;
  let scheduleStore: ScheduleStore | null = null;
  let snapshotAchievementsReady = false;
  let projectSummaryGitHubDeps: ProjectSummaryGitHubDeps | null = null;
  let coordinatorAuditTailProvider = deps.coordinatorAuditTailProvider;

  function broadcastToAll(msg: ServerMessage): void {
    wsBroadcastCount++;
    // #1725 review finding (R6): the load-shed gate in `broadcaster.broadcast`
    // only skips the serialize-and-fan-out half of a shed snapshot — but this
    // enrichment block (coordinator-state build, achievement checks, spend
    // lookup) runs unconditionally BEFORE that gate is ever consulted.
    // Skipping it here too means shed mode actually sheds the snapshot's
    // construction cost, not just its transport cost — the broadcaster
    // discards `msg`'s content entirely while shedding, so none of this
    // enrichment is wasted work avoided, it's wasted work avoided for real.
    if (msg.type === 'snapshot' && !loadShedGate?.isActive) {
      // Non-cloning view, shared by the achievement check and the coordinator
      // build below (issue #1749): both only read-and-derive synchronously, and
      // two full-store `listTasks()` deep clones per snapshot flush was the
      // allocation amplifier behind the 4 GB heap-limit OOMs.
      const tasks = deps.taskStore.viewTasks();
      if (snapshotAchievementsReady && achievementWatcher && scheduleStore) {
        try {
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
            { tasks: buildCoordinatorDetectorTasks(tasks, snapshotAgentsForCoordinator(msg)) },
            coordinatorAuditTailProvider?.getCoordinatorAuditTail() ?? [],
            deps.coordinatorSuppressions ? { suppressions: deps.coordinatorSuppressions } : {},
        ),
        totalSpendUsd: deps.taskStore.getLifetimeSpendUsd(),
        ...(deps.bypassAllPermissions ? { bypassAllPermissions: true } : {}),
        ...(deps.getDrainStatus ? { drainStatus: deps.getDrainStatus() } : {}),
        ...(deps.getSafeModeStatus ? { safeMode: deps.getSafeModeStatus() } : {}),
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
    // #1754 Stage 1: stamp the monotonic `(epoch, seq)` on the outgoing snapshot
    // so clients can re-base. Advance ONCE per flush that actually fans out —
    // skipped while load-shed is active (no snapshot is emitted then, so the seq
    // must not jump for a frame no one receives). The broadcaster propagates the
    // same `(epoch, seq)` onto every per-scope snapshot it builds for this flush.
    if (msg.type === 'snapshot' && sequencer && !loadShedGate?.isActive) {
      msg = stampSnapshotPosition(msg, sequencer.advance());
      // #1754 Stage 2: after the first stamped baseline, convert the hot path
      // to a coalesced delta. The full snapshot is still passed for per-socket
      // needsSnapshot re-base and as the new baseline. Load-shed skips both
      // advance and baseline update above, so recovery resumes with a snapshot.
      if (enableWsDelta && lastBroadcastSnapshot) {
        const previous = lastBroadcastSnapshot;
        lastBroadcastSnapshot = msg;
        const { delta } = buildDeltaFromSnapshots(previous, msg);
        broadcaster.broadcastDelta(delta, msg, previous.agents);
        return;
      }
      lastBroadcastSnapshot = msg;
    } else if (msg.type === 'snapshot' && !loadShedGate?.isActive) {
      // No sequencer: still remember the baseline so enabling the flag later in
      // the same process is a no-op until restart (sequencer is fixed at boot).
      lastBroadcastSnapshot = msg;
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
    getStreamPosition: () => sequencer?.current(),
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
    noteEventLoopDelaySample: (delayMs) => {
      loadShedGate?.noteSample(delayMs);
    },
    isLoadShedActive: () => loadShedGate?.isActive ?? false,
  };
}
