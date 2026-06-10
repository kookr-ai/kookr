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
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from './launch-service.js';
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
import type { Actor } from './auth.js';
import type { Scope } from './viewer-data-policy.js';
import type { SnapshotMessage } from '../shared/contracts/messages.js';
import type { SocketRegistrar } from './viewer-connection-registry.js';
import type { DashboardSelectionController } from './dashboard-selection-controller.js';
import type { TerminalInputCoordinator } from './terminal-input-coordinator.js';
import type { UserInputDeliveryService } from './user-input-delivery-service.js';

/**
 * Application-level inbound WS message types a viewer (read-only actor) is
 * permitted to send. Positive allow-list — **default-deny by construction**:
 * any `ClientMessage` type NOT in this set, including unknown/future types, is
 * rejected for a viewer with no state change. A newly added mutation variant is
 * therefore denied to viewers without touching the gate.
 *
 * Currently **empty**: the only candidates named by the RFC (heartbeat / ping)
 * are WebSocket *protocol-level* frames handled by the `ws` library's own
 * `ping`/`pong` events, not `ClientMessage` variants delivered to
 * `ws.on('message')`. No application `ClientMessage` is side-effect-free enough
 * for a read-only viewer to send, so viewers send nothing through this handler.
 * Add a type here only if a genuinely read-only viewer message variant is
 * introduced.
 */
export const ALLOWED_VIEWER_INBOUND: ReadonlySet<ClientMessage['type']> = new Set<ClientMessage['type']>();

/**
 * WS read-only inbound gate (#806). Owners have full access; viewers are
 * restricted to the {@link ALLOWED_VIEWER_INBOUND} positive allow-list. Pure so
 * the gate logic is unit-testable independent of the socket wiring.
 *
 * @returns `true` if `msgType` may proceed for `actor`, `false` if it must be
 *   rejected (with no state change) by the caller.
 */
export function isAllowedViewerInbound(actor: Actor, msgType: ClientMessage['type']): boolean {
  if (actor.kind === 'owner') return true;
  return ALLOWED_VIEWER_INBOUND.has(msgType);
}

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
    watchdog: { unregisterAgent(agentId: string): void; recordInputReceived?(agentId: string): void };
    shadowRegistry?: { unregisterAgent(agentId: string): void };
    tokenTracker?: { unregister(transcriptPath: string): void };
  };
  agentLifecycleDeps: AgentLifecycleDeps;
  broadcastToAll: (msg: ServerMessage) => void;
  broadcastProjectSummaries: () => void;
  launchTask: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
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
  /** Persistent store for user-flagged supervisor FP/FN cases (offline analysis). */
  supervisorFeedbackCaseStore?: import('./supervisor-feedback-case-store.js').SupervisorFeedbackCaseStore;
  selectionController?: DashboardSelectionController;
  terminalInputCoordinator?: TerminalInputCoordinator;
  /** Where task feedback bundles are written. */
  feedbackDir?: string;
  /** Where anytime task snapshot reflection bundles are written. */
  taskSnapshotDir?: string;
  /** Where task-reflection worktrees are created. */
  reflectWorktreesDir?: string;
  /** Where hook JSONLs live. */
  hooksDir?: string;
  userInputDeliveries?: UserInputDeliveryService;
  /**
   * Single owner of WS scope filtering (#809). When a **viewer** connects, the
   * initial-connection burst is served entirely from this factory
   * (`buildScopedSnapshot(actor.scope)`) instead of `router.handleConnect()` —
   * the same choke point the tick-path broadcaster uses — so a viewer never
   * receives the unfiltered `all` snapshot. Owners are unaffected. Optional so
   * lightweight test wirings can omit it; a viewer connecting without it
   * fails closed (no snapshot served).
   */
  buildScopedSnapshot?: (scope: Scope) => SnapshotMessage;
}

/**
 * Handle a new WebSocket client connection: create a per-client MessageRouter,
 * send initial state, and wire up message/close handlers.
 */
export function handleWsConnection(
  ws: WebSocket,
  registrar: SocketRegistrar,
  deps: WsConnectionDeps,
  actor: Actor = { kind: 'owner' },
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

  // The registry owns the dashboard pool now — register/unregister instead of
  // mutating a shared set. Phase 1 admits owners only; #806 will pass the
  // resolved viewer actor here once viewer cookies are gated onto `/ws`.
  registrar.register(ws, actor, 'dashboard');
  const connectionId = Math.random().toString(36).slice(2);
  deps.selectionController?.registerConnection(connectionId);

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
    supervisorFeedbackCaseStore: deps.supervisorFeedbackCaseStore,
    feedbackDir: deps.feedbackDir,
    taskSnapshotDir: deps.taskSnapshotDir,
    reflectWorktreesDir: deps.reflectWorktreesDir,
    hooksDir: deps.hooksDir,
    connectionId,
    selectionController: deps.selectionController,
    terminalInputCoordinator: deps.terminalInputCoordinator,
    userInputDeliveries: deps.userInputDeliveries,
  });

  // Initial-connection burst (RFC §"Initial-connection burst (consolidated)").
  // A **viewer** is served entirely from the injected `buildScopedSnapshot`
  // factory — the single owner of WS scope filtering, also used by the tick-path
  // broadcaster — plus its scope-filtered project summaries. Every other initial
  // send below (resource status, whole-world GitHub refs, quota, circuit
  // breakers, diagnostics) is owner-only whole-world data per the scrub-list and
  // is skipped for viewers. Owners keep the exact pre-#809 burst.
  if (actor.kind === 'viewer') {
    sendViewerInitialBurst(ws, actor.scope, deps, {
      monitor, ledgerAnalytics, projectConfigStore,
    });
    wireWsMessageHandlers(ws, registrar, router, actor, deps, connectionId);
    return;
  }

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

  wireWsMessageHandlers(ws, registrar, router, actor, deps, connectionId);
}

/**
 * The viewer initial-connection burst: a scope-filtered snapshot plus
 * scope-filtered project summaries, and nothing else. All whole-world owner-only
 * frames (GitHub refs, quota, circuit breakers, diagnostics, resource status)
 * are omitted by the scrub-list. Fails closed — no snapshot — if the
 * `buildScopedSnapshot` factory was not wired.
 */
function sendViewerInitialBurst(
  ws: WebSocket,
  scope: Scope,
  deps: WsConnectionDeps,
  ctx: { monitor: Monitor; ledgerAnalytics: LedgerAnalytics; projectConfigStore: ProjectConfigStore },
): void {
  if (!deps.buildScopedSnapshot) {
    console.warn('[ws] viewer connected without a buildScopedSnapshot factory; serving no snapshot (fail-closed)');
    return;
  }
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(deps.buildScopedSnapshot(scope)));
  }
  const projects = getProjectSummaries({
    monitor: ctx.monitor,
    ledgerAnalytics: ctx.ledgerAnalytics,
    projectConfigStore: ctx.projectConfigStore,
    getSidebarProjects: () => deps.projectSidebarStore?.getSeedProjects() ?? [],
    getSkillTrackedProjects: () => deps.skillDiscoveryState?.getProjects() ?? [],
    getRegistryActiveProjects: deps.getRegistryActiveProjects,
    prLessonsHolder: deps.prLessonsState,
    scope,
  });
  if (projects.length > 0 && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'projectSummaries', projects }));
  }
}

/** Wire the per-connection `message`/`close` handlers. Shared by the owner and
 *  viewer connection paths so the inbound read-only gate (#806) applies to both. */
function wireWsMessageHandlers(
  ws: WebSocket,
  registrar: SocketRegistrar,
  router: MessageRouter,
  actor: Actor,
  deps: WsConnectionDeps,
  connectionId: string,
): void {
  const {
    taskStore, queue, monitor, serverCwd, sttUrl, ttsUrl,
    broadcastToAll, broadcastProjectSummaries, achievementWatcher,
  } = deps;

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

      // Gate 3 — WS read-only inbound gate (#806). Sits at the very top of the
      // handler (after schema parse, before the inline achievement:* handlers
      // AND before router.handleMessageSafe) so NO mutation path is reachable
      // by a viewer. Owners pass through untouched; viewers are restricted to
      // the positive ALLOWED_VIEWER_INBOUND allow-list. Anything else — every
      // achievement:* / router-routed mutation, and unknown/future types — is
      // rejected with a structured error and no state change.
      if (!isAllowedViewerInbound(actor, msg.type)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'alert',
            agentId: '',
            severity: 'warning',
            summary: 'Read-only session: action not permitted',
            details: `Inbound message type "${msg.type}" is blocked for read-only viewers.`,
          }));
        }
        return;
      }

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
            relationTaskStore: taskStore,
            terminalInputSnapshots: deps.terminalInputCoordinator,
            userInputDeliveryProvider: deps.userInputDeliveries,
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
        relationTaskStore: taskStore,
        terminalInputSnapshots: deps.terminalInputCoordinator,
        userInputDeliveryProvider: deps.userInputDeliveries,
      }));
      broadcastProjectSummaries();
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    registrar.unregister(ws);
    deps.selectionController?.unregisterConnection(connectionId);
  });
}
