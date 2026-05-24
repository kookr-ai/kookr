import type { WebSocket } from 'ws';
import type { TaskStore } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Monitor } from '../core/monitor.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import type { BuildInfo } from '../core/build-info.js';
import type { GitHubStateStore } from '../core/github-state-store.js';
import type { LedgerAnalytics } from '../core/ledger-analytics.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { ProjectSidebarStore } from '../core/project-sidebar-store.js';
import type { SkillDiscoveryStateHolder } from '../core/skill-tracked-repo-discovery.js';
import type { PrLessonsStateHolder } from '../core/pr-lessons-discovery.js';
import type { AchievementWatcher } from './achievement-watcher.js';
import type { ServerMessage, ClientMessage, QuotaStatus, SystemResourceStatus } from '../shared/protocol.js';
import { ClientMessageSchema, summarizeZodIssues } from '../shared/contracts/client-message-schema.js';
import { MessageRouter } from './ws.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type { AgentLifecycleDeps } from './agent-lifecycle.js';
import type { CircuitBreakerRegistry } from '../core/circuit-breaker.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { AgentSelection, AvailableAgentType } from '../core/agent-types.js';
import type { ScheduleService } from './schedule-service.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import type { AgentActivityMeta } from '../core/types.js';
import type { CoordinatorAuditTailProvider } from './coordinator/detectors.js';
import type { CoordinatorSuppressionReader } from './coordinator/suppression-store.js';
import type { WorkspaceAttemptRepository } from '../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../core/worktree-lease-service.js';
import { createSnapshotMessage, getProjectSummaries } from './use-cases/get-snapshot.js';

export interface WsConnectionDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapter: AgentAdapter;
  adapterRegistry?: AdapterRegistry;
  interactionLog: DeferredInteractionLogWriter;
  telemetryLog: DeferredTelemetryLogWriter;
  buildInfo: BuildInfo;
  serverStartedAt: string;
  serverCwd: string;
  sttUrl?: string;
  ttsUrl?: string;
  abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void;
  lifecycleExtras: {
    hookWatcher: { stop(tmuxName: string): void };
    watchdog: { unregisterAgent(agentId: string): void };
    shadowRegistry?: { unregisterAgent(agentId: string): void };
    tokenTracker?: { unregister(transcriptPath: string): void };
  };
  agentLifecycleDeps: AgentLifecycleDeps;
  broadcastToAll: (msg: ServerMessage) => void;
  broadcastProjectSummaries: () => void;
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  githubStateStore: GitHubStateStore;
  ledgerAnalytics: LedgerAnalytics;
  projectConfigStore: ProjectConfigStore;
  projectSidebarStore?: ProjectSidebarStore;
  skillDiscoveryState?: SkillDiscoveryStateHolder;
  prLessonsState?: PrLessonsStateHolder;
  getRegistryActiveProjects?: () => string[];
  achievementWatcher: AchievementWatcher;
  getQuotaStatus?: () => QuotaStatus | null;
  circuitBreakerRegistry?: CircuitBreakerRegistry;
  /** Live getter for max concurrent tasks. */
  getMaxActiveTasks?: () => number;
  suppressionTracker?: SnoozeSuppressionTracker;
  availableAgentTypes?: AvailableAgentType[];
  defaultAgentType?: AgentSelection;
  getDefaultAgentType?: () => AgentSelection;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  coordinatorAuditTailProvider?: CoordinatorAuditTailProvider;
  coordinatorSuppressions?: CoordinatorSuppressionReader;
  scheduleService?: ScheduleService;
  ralphLoopService: RalphLoopService;
  /** Get latest self-diagnostic status (for initial connection burst). */
  getDiagnosticStatus?: () => { report: import('../core/self-diagnostic.js').DiagnosticReport | null; lastError: string | null };
  /** Get latest server-host resource status for the initial connection burst. */
  getLatestResourceStatus?: () => SystemResourceStatus | null;
  /** Workspace services (Phase 1a). */
  workspaceEnabled?: boolean;
  attemptRepository?: WorkspaceAttemptRepository;
  policyResolver?: RepoPolicyResolver;
  leaseService?: WorktreeLeaseService;
  serverProjectId?: string;
  /** Wired by createKookrServer so ws.ts can trigger a predelete snapshot. */
  takePredeleteSnapshot?: () => Promise<void>;
}

/**
 * Handle a new WebSocket client connection: create a per-client MessageRouter,
 * send initial state, and wire up message/close handlers.
 */
export function handleWsConnection(
  ws: WebSocket,
  clients: Set<WebSocket>,
  deps: WsConnectionDeps,
): void {
  const {
    taskStore, queue, monitor, adapter,
    interactionLog, telemetryLog, buildInfo, serverStartedAt,
    serverCwd, sttUrl, ttsUrl, abortPendingSuggestion,
    lifecycleExtras, agentLifecycleDeps, broadcastToAll,
    broadcastProjectSummaries, launchTask,
    githubStateStore, ledgerAnalytics, projectConfigStore,
    achievementWatcher,
  } = deps;

  clients.add(ws);

  const router = new MessageRouter({
    taskStore, queue, monitor, adapter,
    adapterRegistry: deps.adapterRegistry,
    send: (msg) => {
      if (ws.readyState === 1 /* WebSocket.OPEN */) {
        ws.send(JSON.stringify(msg));
      }
    },
    serverCwd, interactionLog, buildInfo, serverStartedAt,
    onRespond: abortPendingSuggestion, telemetryLog,
    lifecycleExtras, sttUrl, ttsUrl,
    agentLifecycleDeps, broadcastToAll, launchTask,
    circuitBreakerRegistry: deps.circuitBreakerRegistry,
    getMaxActiveTasks: deps.getMaxActiveTasks,
    suppressionTracker: deps.suppressionTracker,
    availableAgentTypes: deps.availableAgentTypes,
    defaultAgentType: deps.defaultAgentType,
    getDefaultAgentType: deps.getDefaultAgentType,
    activityMetaProvider: deps.activityMetaProvider,
    coordinatorAuditTailProvider: deps.coordinatorAuditTailProvider,
    coordinatorSuppressions: deps.coordinatorSuppressions,
    scheduleService: deps.scheduleService,
    ralphLoopService: deps.ralphLoopService,
    workspaceEnabled: deps.workspaceEnabled,
    attemptRepository: deps.attemptRepository,
    policyResolver: deps.policyResolver,
    leaseService: deps.leaseService,
    serverProjectId: deps.serverProjectId,
    takePredeleteSnapshot: deps.takePredeleteSnapshot,
    projectConfigStore,
    broadcastProjectSummaries,
  });

  // Send initial snapshot
  router.handleConnect();

  const latestResourceStatus = deps.getLatestResourceStatus?.();
  if (latestResourceStatus && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'resourceStatus', status: latestResourceStatus }));
  }

  // Send initial GitHub state for all tasks with references
  for (const taskId of githubStateStore.getTaskIdsWithReferences()) {
    const state = githubStateStore.getTaskState(taskId);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes: [],
      }));
    }
  }

  // Send initial project summaries
  {
    const projects = getProjectSummaries({
      monitor,
      ledgerAnalytics,
      projectConfigStore,
      getSidebarProjects: () => deps.projectSidebarStore?.getSeedProjects() ?? [],
      getSkillTrackedProjects: () => deps.skillDiscoveryState?.getProjects() ?? [],
      getRegistryActiveProjects: deps.getRegistryActiveProjects,
      prLessonsHolder: deps.prLessonsState,
      getTaskGithubReferences: (taskId) => githubStateStore.getReferences(taskId),
    });
    if (projects.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'projectSummaries', projects }));
    }
  }

  // Send initial quota status if available
  if (deps.getQuotaStatus) {
    const quota = deps.getQuotaStatus();
    if (quota && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'quotaStatus', quota }));
    }
  }

  // Send initial circuit breaker status
  if (deps.circuitBreakerRegistry) {
    const breakers = deps.circuitBreakerRegistry.getAllSnapshots();
    if (breakers.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'circuitBreakerStatus', breakers }));
    }
  }

  // Send initial self-diagnostic status
  if (deps.getDiagnosticStatus) {
    const status = deps.getDiagnosticStatus();
    if (status.report && status.report.findings.length > 0 && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'diagnosticReport', report: status.report }));
    }
  }

  ws.on('message', async (data) => {
    try {
      const parsed: unknown = JSON.parse(data.toString());
      // Gate 1: reject payloads that aren't objects with a `type` string so we
      // can produce a stable error even when the discriminator itself is bad.
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'alert',
            agentId: '',
            severity: 'critical',
            summary: 'Malformed WebSocket message: missing or non-string `type` field',
            details: '',
          }));
        }
        return;
      }
      // Gate 2: full discriminated-union schema validation. Rejects unknown
      // `type` values and payloads whose fields don't match the union variant.
      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'alert',
            agentId: '',
            severity: 'critical',
            summary: 'Malformed WebSocket message: payload failed schema validation',
            details: summarizeZodIssues(result.error, parsed),
          }));
        }
        return;
      }
      const msg: ClientMessage = result.data;

      // Achievement panel messages — handled before router
      if (msg.type === 'achievement:reset') {
        try {
          await achievementWatcher.reset();
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'achievement:reset:ack', success: true }));
          }
          broadcastToAll(createSnapshotMessage({
            monitor,
            serverCwd,
            sttUrl,
            ttsUrl,
            activityMetaProvider: deps.activityMetaProvider,
            coordinator: {
              taskStore,
              auditTailProvider: deps.coordinatorAuditTailProvider,
              suppressions: deps.coordinatorSuppressions,
            },
            getMaxActiveTasks: deps.getMaxActiveTasks,
          }));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'achievement:reset:ack', success: false, error }));
          }
        }
        return;
      }
      if (msg.type === 'achievement:setEnabled') {
        achievementWatcher.setEnabled(msg.enabled);
        return;
      }

      const isLaunchMsg = msg.type === 'launch' || msg.type === 'launchPlaybook' || msg.type === 'relaunch';
      const isFeedbackMsg = msg.type === 'completeTask' || msg.type === 'setTaskFeedback';

      // Capture pre-response anomaly state for achievement detection.
      // recordResolution needs the active anomaly captured BEFORE the router
      // runs, since respond/directReply paths may clear the queue entry.
      const hadAnomaly = (msg.type === 'respond') ? !!queue.getAnomaly(msg.agentId) : undefined;
      const preActiveAnomaly =
        (msg.type === 'respond' || msg.type === 'directReply')
          ? queue.getActiveAnomaly(msg.agentId)
          : null;
      const respondBody =
        (msg.type === 'respond' || msg.type === 'directReply') ? msg.input : '';

      await router.handleMessageSafe(msg);

      // Achievement checks for client messages (try/catch = structural error boundary)
      // Skip achievement on deduplicated launches — no new task was created
      try {
        if (msg.type === 'respond') {
          achievementWatcher.check({ type: 'client', action: 'respond', hadAnomaly });
          achievementWatcher.recordResolution({
            agentId: msg.agentId,
            body: respondBody,
            activeAnomaly: preActiveAnomaly,
          });
        } else if (msg.type === 'directReply') {
          achievementWatcher.check({ type: 'client', action: 'directReply' });
          achievementWatcher.recordResolution({
            agentId: msg.agentId,
            body: respondBody,
            activeAnomaly: preActiveAnomaly,
          });
        } else if (isLaunchMsg && !router.lastLaunchDuplicate) {
          achievementWatcher.check({ type: 'client', action: 'launchTask' });
        } else if (msg.type === 'snooze') {
          achievementWatcher.check({ type: 'client', action: 'snooze' });
        } else if (isFeedbackMsg) {
          // Skip if completeTask was sent without feedback; setTaskFeedback always carries it.
          const hasFeedback = msg.type === 'setTaskFeedback' || (msg.type === 'completeTask' && !!msg.feedback);
          if (hasFeedback) {
            achievementWatcher.check({ type: 'client', action: 'feedback' });
          }
        } else if (msg.type === 'telemetry') {
          for (const event of msg.events) {
            achievementWatcher.check({ type: 'telemetry', event });
          }
        }
      } catch (err) {
        console.warn('[achievements] Client message check failed, continuing', err);
      }

      // Broadcast state change to all clients
      broadcastToAll(createSnapshotMessage({
        monitor,
        serverCwd,
        sttUrl,
        ttsUrl,
        activityMetaProvider: deps.activityMetaProvider,
        coordinator: {
          taskStore,
          auditTailProvider: deps.coordinatorAuditTailProvider,
          suppressions: deps.coordinatorSuppressions,
        },
        getMaxActiveTasks: deps.getMaxActiveTasks,
      }));
      broadcastProjectSummaries();
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
}
