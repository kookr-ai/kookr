import type { Monitor } from '../core/monitor.js';
import type { HookIngestion } from './hook-ingestion.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { AgentEvent, EventMeta } from '../core/types.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { LlmClient } from '../core/llm-client.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { CheckpointCycler } from '../core/checkpoint-cycler.js';
import type { RalphCycler } from '../core/ralph-cycler.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import { createCheckpointStopProcessor } from './event-processors/checkpoint-stop-processor.js';
import { createGitHubEventProcessor } from './event-processors/github-event-processor.js';
import { createPermissionBlockAlertProcessor } from './event-processors/permission-block-alert-processor.js';
import { createPermissionQuickActionsProcessor } from './event-processors/permission-quick-actions-processor.js';
import { createRalphStopProcessor } from './ralph/stop-event-processor.js';
import { createResponseAssistProcessor } from './event-processors/response-assist-processor.js';
import { createSessionActivityProcessor } from './event-processors/session-activity-processor.js';
import { createStopTokenScanProcessor } from './event-processors/stop-token-scan-processor.js';
import { createTokenAccountingProcessor } from './event-processors/token-accounting-processor.js';

export interface EventPipelineDeps {
  adapter: AgentAdapter;
  monitor: Monitor;
  taskStore: TaskStore;
  tokenTracker: TokenTracker;
  watchdog: Watchdog;
  githubScanner: GitHubScannerService;
  llmClient: LlmClient | null;
  serverCwd: string;
  broadcastToAll: (msg: ServerMessage) => void;
  telemetryLog?: DeferredTelemetryLogWriter;
  /** Optional v5 checkpoint cycler — advances state on Stop events. */
  checkpointCycler?: CheckpointCycler;
  /**
   * Optional callback fired when an agent enters the `permission_blocked`
   * anomaly state. Used by the remote-chat integration (R16) to send a
   * Kookr alert to the chat that originated the spawn.
   *
   * The callback receives `(taskId, promptText)` where `promptText` is a
   * human-readable summary of the tool call awaiting approval (e.g.,
   * "Bash(git push origin feat-x)"). The callback MUST NOT throw; the
   * pipeline does not handle errors and a thrown rejection would propagate
   * through the existing fire-and-forget `captureDisplay` chain.
   *
   * See `docs/rfc/rfc-remote-chat-trigger.md` §7 (R16).
   */
  onPermissionBlocked?: (taskId: string, promptText: string) => void;
  /** Optional Ralph iteration cycler — drives the loop state machine on Stop events. */
  ralphCycler?: RalphCycler;
  /** Singleton Ralph loop service shared with routes and startup recovery. */
  ralphLoopService: RalphLoopService;
  /** Provides per-Kookr-session activityMeta for the snapshot. */
  hookIngestion?: HookIngestion;
  /** Optional publisher for refreshing remote task-share projections after local task state changes. */
  taskShareService?: { publishTaskProjectionForTask(taskId: string): void };
}

/**
 * Wire adapter events into the monitor, watchdog, token tracker, smart response assist,
 * and GitHub scanner. Returns a cleanup function to cancel any pending suggestions.
 */
export function wireEventPipeline(deps: EventPipelineDeps): { abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void } {
  const {
    adapter, monitor, taskStore, tokenTracker, watchdog,
    githubScanner, llmClient, serverCwd, broadcastToAll,
    telemetryLog,
  } = deps;

  const broadcastSnapshot = () => {
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: deps.hookIngestion, relationTaskStore: taskStore }));
  };
  const publishTaskProjection = (taskId: string) => {
    deps.taskShareService?.publishTaskProjectionForTask(taskId);
  };
  const getAgentState = (agentId: string) => monitor.getSnapshot().find(s => s.agentId === agentId);

  const tokenAccountingProcessor = createTokenAccountingProcessor({
    taskLookup: taskStore,
    transcriptRegistry: tokenTracker,
  });
  const permissionBlockAlertProcessor = createPermissionBlockAlertProcessor({
    taskLookup: taskStore,
    onPermissionBlocked: deps.onPermissionBlocked,
  });
  const stopTokenScanProcessor = createStopTokenScanProcessor({
    tokenUsageWriter: taskStore,
    tokenScanner: tokenTracker,
    tokenActivityRecorder: watchdog,
    broadcastSnapshot,
    publishTaskProjection,
  });
  const sessionActivityProcessor = createSessionActivityProcessor({ taskLookup: taskStore });
  const checkpointStopProcessor = createCheckpointStopProcessor({
    inputSender: adapter,
    checkpointCycler: deps.checkpointCycler,
  });
  const ralphStopProcessor = createRalphStopProcessor({
    taskCostReader: tokenTracker,
    runningLoopHandlingEnabled: Boolean(deps.ralphCycler),
    ralphStopHandler: deps.ralphLoopService,
    broadcastSnapshot,
    publishTaskProjection,
  });
  const responseAssistProcessor = createResponseAssistProcessor({
    getAgentState,
    llmClient,
    broadcastToAll,
    telemetryLog,
  });
  const permissionQuickActionsProcessor = createPermissionQuickActionsProcessor({
    displayCapture: adapter,
    getAgentState,
    broadcastToAll,
  });
  const githubEventProcessor = createGitHubEventProcessor({
    githubScanner,
    taskLookup: taskStore,
  });

  const handleEvent = (tmuxName: string, event: AgentEvent, meta: EventMeta) => {
    tokenAccountingProcessor.process({ tmuxName, event });

    // Cross-session child events do not drive parent anomaly detection,
    // watchdog liveness, completion summaries, autonomy decisions, or Ralph /
    // checkpoint cyclers. `unknown` is treated conservatively as parent-ish so
    // events that arrive before the parent SessionStart still flow into
    // anomaly detection — V1 SHALL keep existing detection unless a record is
    // confidently classified as non-parent. See rfc §3.
    if (meta.parentage === 'child' || meta.parentage === 'foreign') return;

    // ⚠ ORDERING CONTRACT: pre-capture must precede processEvents();
    // post-capture must follow it. The anomaly-diff detects any transition
    // away from needs_input (e.g. tool_use, session_start) and clears stale suggestions.
    const preState = monitor.getSnapshot().find(s => s.agentId === tmuxName);
    const wasNeedsInput = preState?.anomaly?.type === 'needs_input';

    monitor.processEvents(tmuxName, [event]);
    watchdog.recordEvents(tmuxName, [event]);

    // Post-event: if anomaly transitioned away from needs_input, clear stale suggestions
    const postState = monitor.getSnapshot().find(s => s.agentId === tmuxName);
    const isNeedsInput = postState?.anomaly?.type === 'needs_input';
    if (wasNeedsInput && !isNeedsInput) {
      console.debug(`[event-pipeline] needs_input cleared for ${tmuxName} by ${event.type}`);
      responseAssistProcessor.abortPendingSuggestion(tmuxName);
    }

    permissionBlockAlertProcessor.process({ tmuxName, preState, postState });

    const ownerTask = taskStore.findTaskBySession(tmuxName);
    sessionActivityProcessor.process(tmuxName);
    const snapshot = monitor.getSnapshot();
    broadcastSnapshot();
    if (ownerTask) publishTaskProjection(ownerTask.id);

    // On stop/stop_failure events, immediately scan transcript for updated spending
    if (event.type === 'stop' || event.type === 'stop_failure') {
      const stopTask = ownerTask ?? undefined;
      stopTokenScanProcessor.process(stopTask);
      checkpointStopProcessor.process(tmuxName);
      ralphStopProcessor.process(stopTask, tmuxName, event);
    }

    const agentState = snapshot.find((s) => s.agentId === tmuxName);
    responseAssistProcessor.process({ tmuxName, event, agentState });
    permissionQuickActionsProcessor.process({ tmuxName, agentState });
    githubEventProcessor.process({ tmuxName, event, postState });
  };

  // Wire adapter events to the shared event handler
  adapter.onEvent(handleEvent);

  return { abortPendingSuggestion: responseAssistProcessor.abortPendingSuggestion };
}
