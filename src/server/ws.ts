import type { AgentActivityMeta, Anomaly } from '../core/types.js';
import type { TaskStore } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Monitor } from '../core/monitor.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import type { BuildInfo } from '../core/build-info.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import type { ServerMessage, ClientMessage } from '../shared/contracts/messages.js';
import {
  type LifecycleDeps,
  promotePendingTasks,
} from './agent-lifecycle.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type { CircuitBreakerRegistry } from '../core/circuit-breaker.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { AgentSelection, AvailableAgentType } from '../core/agent-types.js';
import type { ScheduleService } from './schedule-service.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import { createSnapshotMessage, getSnapshotAgentsForClient } from './use-cases/get-snapshot.js';
import { PlaybookHandler } from './ws-handlers/playbook-handler.js';
import { ConfigHandler } from './ws-handlers/config-handler.js';
import { ReflectionHandler } from './ws-handlers/reflection-handler.js';
import { AnomalyHandler } from './ws-handlers/anomaly-handler.js';
import { LifecycleHandler } from './ws-handlers/lifecycle-handler.js';
import { WorkspaceHandler } from './ws-handlers/workspace-handler.js';
import { SweepHandler } from './ws-handlers/sweep-handler.js';
import { isSweepInProgress } from './use-cases/cross-project-cleanup-sweep.js';
import type { WorkspaceAttemptRepository } from '../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../core/worktree-lease-service.js';
import type { CoordinatorAuditTailProvider } from './coordinator/detectors.js';
import type { CoordinatorSuppressionReader } from './coordinator/suppression-store.js';

export interface MessageRouterDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  adapter: AgentAdapter;
  adapterRegistry?: AdapterRegistry;
  send: (msg: ServerMessage) => void;
  serverCwd?: string;
  interactionLog?: DeferredInteractionLogWriter;
  buildInfo?: BuildInfo;
  serverStartedAt?: string;
  onRespond?: (agentId: string, outcome?: 'used' | 'cleared') => void;
  telemetryLog?: DeferredTelemetryLogWriter;
  lifecycleExtras?: {
    hookWatcher?: { stop(tmuxName: string): void };
    watchdog?: { unregisterAgent(agentId: string): void; recordInputReceived?(agentId: string): void };
    shadowRegistry?: { unregisterAgent(agentId: string): void };
    tokenTracker?: { unregister(transcriptPath: string): void };
  };
  sttUrl?: string;
  ttsUrl?: string;
  agentLifecycleDeps?: import('./agent-lifecycle.js').AgentLifecycleDeps;
  broadcastToAll?: (msg: ServerMessage) => void;
  launchTask?: (opts: LaunchOpts) => Promise<LaunchResult>;
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
  /** Workspace services (Phase 1a). */
  workspaceEnabled?: boolean;
  attemptRepository?: WorkspaceAttemptRepository;
  policyResolver?: RepoPolicyResolver;
  leaseService?: WorktreeLeaseService;
  serverProjectId?: string;
  /**
   * Take an on-disk snapshot of tasks.json before a destructive operation.
   * Wired from lifecycle-timers so ws.ts stays independent of filesystem paths.
   * Failures are already swallowed inside the persistence layer; callers may
   * `await` this without handling errors.
   */
  takePredeleteSnapshot?: () => Promise<void>;
  /** Project config persistence for `setProjectConfig` messages. */
  projectConfigStore?: ProjectConfigStore;
  /** Rebroadcasts `projectSummaries` to all clients after config changes. */
  broadcastProjectSummaries?: () => void;
  /**
   * Persistent JSONL log of user-flagged supervisor false-positive / missed-finding
   * cases. Optional — when omitted, FP/FN feedback still flows through the interaction
   * log and stats counters but no rich case snapshot is persisted for offline review.
   */
  supervisorFeedbackCaseStore?: import('./supervisor-feedback-case-store.js').SupervisorFeedbackCaseStore;
}

export class MessageRouter {
  private readonly deps: MessageRouterDeps;
  /** Set after each launch/launchPlaybook/relaunch — true if the submission was a duplicate. */
  private _lastLaunchDuplicate = false;

  private playbookHandler: PlaybookHandler;
  private configHandler: ConfigHandler;
  private reflectionHandler: ReflectionHandler;
  private anomalyHandler: AnomalyHandler;
  private lifecycleHandler: LifecycleHandler;
  private workspaceHandler: WorkspaceHandler;
  private sweepHandler: SweepHandler;

  constructor(deps: MessageRouterDeps) {
    this.deps = deps;

    this.playbookHandler = new PlaybookHandler({
      send: this.deps.send,
      launchTask: this.deps.launchTask,
    });
    this.configHandler = new ConfigHandler({
      send: this.deps.send,
      interactionLog: this.deps.interactionLog,
      telemetryLog: this.deps.telemetryLog,
      circuitBreakerRegistry: this.deps.circuitBreakerRegistry,
      projectConfigStore: this.deps.projectConfigStore,
      broadcastProjectSummaries: this.deps.broadcastProjectSummaries,
    });
    this.reflectionHandler = new ReflectionHandler({
      send: this.deps.send,
      taskStore: this.deps.taskStore,
      monitor: this.deps.monitor,
      serverCwd: this.serverCwd,
      interactionLog: this.deps.interactionLog,
      launchTask: this.deps.launchTask,
    });
    const recordWatchdogInputReceived = this.deps.lifecycleExtras?.watchdog?.recordInputReceived
      ?.bind(this.deps.lifecycleExtras.watchdog);
    this.anomalyHandler = new AnomalyHandler({
      send: this.deps.send,
      adapter: this.deps.adapter,
      taskStore: this.deps.taskStore,
      monitor: this.deps.monitor,
      watchdog: recordWatchdogInputReceived
        ? { recordInputReceived: recordWatchdogInputReceived }
        : undefined,
      queue: this.deps.queue,
      interactionLog: this.deps.interactionLog,
      suppressionTracker: this.deps.suppressionTracker,
      onRespond: this.deps.onRespond,
      caseLogStore: this.deps.supervisorFeedbackCaseStore,
    });
    this.lifecycleHandler = new LifecycleHandler({
      send: this.deps.send,
      taskStore: this.deps.taskStore,
      monitor: this.deps.monitor,
      queue: this.deps.queue,
      interactionLog: this.deps.interactionLog,
      scheduleService: this.deps.scheduleService,
      ralphLoopService: this.deps.ralphLoopService,
      launchTask: this.deps.launchTask,
      broadcastToAll: this.deps.broadcastToAll,
      activityMetaProvider: this.deps.activityMetaProvider,
      takePredeleteSnapshot: this.deps.takePredeleteSnapshot,
      getLifecycleDeps: () => this.lifecycleDeps,
      tryPromotePending: () => this.tryPromotePending(),
    });
    this.workspaceHandler = new WorkspaceHandler({
      send: this.deps.send,
      taskStore: this.deps.taskStore,
      serverCwd: this.serverCwd,
      serverProjectId: this.deps.serverProjectId,
      projectConfigStore: this.deps.projectConfigStore,
      workspaceEnabled: this.deps.workspaceEnabled,
      attemptRepository: this.deps.attemptRepository,
      policyResolver: this.deps.policyResolver,
      leaseService: this.deps.leaseService,
      launchTask: this.deps.launchTask,
    });
    this.sweepHandler = new SweepHandler({
      send: this.deps.send,
      taskStore: this.deps.taskStore,
      serverCwd: this.serverCwd,
      serverProjectId: this.deps.serverProjectId,
      workspaceEnabled: this.deps.workspaceEnabled,
      projectConfigStore: this.deps.projectConfigStore,
      attemptRepository: this.deps.attemptRepository,
      policyResolver: this.deps.policyResolver,
      leaseService: this.deps.leaseService,
    });
  }

  /** Resolved server cwd with the `process.cwd()` fallback applied. */
  private get serverCwd(): string {
    return this.deps.serverCwd ?? process.cwd();
  }

  /** True if the most recent launch/relaunch was deduplicated. Reset each message. */
  get lastLaunchDuplicate(): boolean {
    return this._lastLaunchDuplicate;
  }

  /** Build full lifecycle deps from router fields + extras. */
  private get lifecycleDeps(): LifecycleDeps {
    return {
      adapter: this.deps.adapter,
      monitor: this.deps.monitor,
      taskStore: this.deps.taskStore,
      queue: this.deps.queue,
      interactionLog: this.deps.interactionLog,
      suppressionTracker: this.deps.suppressionTracker,
      leaseService: this.deps.leaseService,
      attemptRepository: this.deps.attemptRepository,
      ...this.deps.lifecycleExtras,
    };
  }

  /** Called when a new client connects — send initial snapshot. */
  handleConnect(): void {
    this.deps.send(createSnapshotMessage({
      monitor: this.deps.monitor,
      serverCwd: this.serverCwd,
      buildInfo: this.deps.buildInfo,
      serverStartedAt: this.deps.serverStartedAt,
      totalSpendUsd: this.deps.taskStore.getLifetimeSpendUsd(),
      availableAgentTypes: this.deps.availableAgentTypes,
      defaultAgentType: this.deps.getDefaultAgentType?.() ?? this.deps.defaultAgentType,
      sttUrl: this.deps.sttUrl,
      ttsUrl: this.deps.ttsUrl,
      workspaceEnabled: this.deps.workspaceEnabled,
      sweepRunning: isSweepInProgress(),
      activityMetaProvider: this.deps.activityMetaProvider,
      coordinator: {
        taskStore: this.deps.taskStore,
        auditTailProvider: this.deps.coordinatorAuditTailProvider,
        suppressions: this.deps.coordinatorSuppressions,
      },
      getMaxActiveTasks: this.deps.getMaxActiveTasks,
      relationTaskStore: this.deps.taskStore,
    }));
  }

  /**
   * Handle a client message, catching errors and surfacing them as alerts.
   * This is the safe entry point used by the WebSocket server.
   */
  async handleMessageSafe(msg: ClientMessage): Promise<void> {
    try {
      await this.handleMessage(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.send({
        type: 'alert',
        agentId: '',
        summary: `Error: ${message}`,
        details: '',
        severity: 'critical',
      });
    }
  }

  /**
   * Handle an incoming client message. Throws on error.
   *
   * Each case is a thin delegation to a per-family handler. The grouping
   * (anomaly / lifecycle / config / reflection / playbook / workspace) is
   * stable — when adding a new message, locate the matching handler by
   * responsibility:
   *   - AnomalyHandler — agent-level triage (respond/skip/snooze/permission)
   *   - LifecycleHandler — task lifecycle (launch/stop/complete/delete)
   *   - ConfigHandler — settings and logging side-effects
   *   - ReflectionHandler — session reflection (launches a new task)
   *   - PlaybookHandler — listing and launching playbooks
   *   - WorkspaceHandler — workspace:* Phase 1a messages
   *
   * Launch-family dispatches (launch / relaunch / launchPlaybook) record
   * whether the submission was deduplicated so ws-connection-handler can
   * skip the launchTask achievement check.
   */
  async handleMessage(msg: ClientMessage): Promise<void> {
    this._lastLaunchDuplicate = false;
    const dispatch = (m: ClientMessage) => this.handleMessage(m);
    switch (msg.type) {
      // --- Anomaly triage ---
      case 'respond':
      case 'respondAll':
      case 'directReply':
      case 'skip':
      case 'skipAll':
      case 'snooze':
      case 'cancelSnooze':
      case 'findingFeedback':
      case 'missedFinding':
      case 'permissionChoice':
        await this.anomalyHandler.handle(msg, dispatch);
        return;

      // --- Task lifecycle (launch/relaunch record duplicate flag) ---
      case 'launch':
      case 'relaunch': {
        const { duplicate } = await this.lifecycleHandler.handle(msg);
        if (duplicate) this._lastLaunchDuplicate = true;
        return;
      }
      case 'getNext':
      case 'completeTask':
      case 'cancelTask':
      case 'reopenTask':
      case 'deleteTask':
      case 'renameTask':
      case 'setTaskPriority':
      case 'stop':
      case 'clearCompleted':
      case 'ackTerminatedTask':
        await this.lifecycleHandler.handle(msg);
        return;

      // --- Configuration ---
      case 'setProjectConfig':
      case 'rearmCircuitBreaker':
      case 'telemetry':
      case 'navigate':
        await this.configHandler.handle(msg);
        return;

      // --- Session reflection ---
      case 'reflect':
        await this.reflectionHandler.handle(msg);
        return;

      // --- Playbook discovery & launch (records duplicate flag) ---
      case 'listPlaybooks':
      case 'launchPlaybook': {
        const { duplicate } = await this.playbookHandler.handle(msg);
        if (duplicate) this._lastLaunchDuplicate = true;
        return;
      }

      // --- Workspace (Phase 1a) ---
      case 'workspace:getView':
      case 'workspace:getCleanupDetail':
      case 'workspace:runCleanupDiagnostic':
      case 'workspace:cleanupCandidate':
      case 'workspace:bulkSafeCleanup':
        await this.workspaceHandler.handle(msg);
        return;

      // --- Cross-project sweep ---
      case 'workspace:sweep':
        await this.sweepHandler.handle();
        return;
    }
  }

  /** Promote pending tasks if slots are available. */
  private async tryPromotePending(): Promise<void> {
    if (!this.deps.agentLifecycleDeps || !this.deps.broadcastToAll || !this.deps.adapterRegistry) return;
    await promotePendingTasks({
      taskStore: this.deps.taskStore,
      adapterRegistry: this.deps.adapterRegistry,
      lifecycleDeps: this.deps.agentLifecycleDeps,
      broadcastToAll: this.deps.broadcastToAll,
      serverCwd: this.serverCwd,
      getMaxActiveTasks: this.deps.getMaxActiveTasks,
    });
  }

  /** Broadcast an update for a specific agent. */
  broadcastUpdate(agentId: string): void {
    const snapshot = getSnapshotAgentsForClient({
      monitor: this.deps.monitor,
      activityMetaProvider: this.deps.activityMetaProvider,
    });
    const state = snapshot.find((s) => s.agentId === agentId);
    if (state) {
      this.deps.send({ type: 'update', agentId, state });
    }
  }

  /** Broadcast an alert for an anomaly. */
  broadcastAlert(agentId: string, anomaly: Anomaly): void {
    this.deps.send({
      type: 'alert',
      agentId,
      summary: anomaly.explanation,
      details: `Type: ${anomaly.type}, Count: ${anomaly.count ?? 'N/A'}`,
      severity: anomaly.severity,
    });
  }
}
