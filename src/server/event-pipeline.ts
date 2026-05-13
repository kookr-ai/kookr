import type { Monitor } from '../core/monitor.js';
import type { HookIngestion } from './hook-ingestion.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { AgentEvent, EventMeta } from '../core/types.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { shouldOfferAssist, extractQuickActions } from '../core/response-assist.js';
import { generateSuggestedResponses } from '../core/response-suggest.js';
import { extractPermissionActions } from '../core/permission-actions.js';
import { isPermissionRequestEvent } from '../core/types.js';
import type { LlmClient } from '../core/llm-client.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import {
  generateSuggestionId, getActiveSuggestionId,
  startLifecycle, resolveLifecycle,
} from '../core/suggestion-telemetry.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { CheckpointCycler } from '../core/checkpoint-cycler.js';
import { isCycleDisabled } from '../core/checkpoint-cycler.js';
import type { RalphCycler } from '../core/ralph-cycler.js';
import type { RalphLoopService } from './ralph-loop-service.js';

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
}

/**
 * Compact tool-input renderer for the R16 block-alert message body. Aims for
 * ~60 chars max and never includes anything that could itself be a credential
 * (the integration's send path also redacts; this is just for log-friendly
 * shape).
 */
function formatToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object') {
    // Common Claude Code shapes: {command: "..."}, {file_path: "..."}, {url: "..."}.
    const obj = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url']) {
      const v = obj[key];
      if (typeof v === 'string') return v.slice(0, 60);
    }
  }
  return '';
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

  // Track in-flight AI suggestion API calls so they can be cancelled on user input
  const pendingSuggestions = new Map<string, AbortController>();

  /** Cancel any in-flight suggestion generation for this agent and clear stale suggestions. */
  function abortPendingSuggestion(agentId: string, outcome: 'used' | 'cleared' = 'cleared'): void {
    // Extract suggestionId BEFORE resolving — resolveLifecycle may clear the map entry
    const suggestionId = getActiveSuggestionId(agentId) ?? '';
    resolveLifecycle(agentId, outcome, telemetryLog);
    const ac = pendingSuggestions.get(agentId);
    if (ac) {
      ac.abort();
      pendingSuggestions.delete(agentId);
    }
    broadcastToAll({ type: 'suggestion', agentId, suggestionId, suggestions: [], quickActions: [] });
  }

  // Pending transcript registrations: if session_start arrives before the task
  // is findable (race between hook event and task creation), retry on next event.
  const pendingTranscriptRegistrations = new Map<string, string>();

  const handleEvent = (tmuxName: string, event: AgentEvent, meta: EventMeta) => {
    // Token tracking runs for ALL parentages: a cross-session child writing to
    // the same Kookr hook file still has tokens that should roll up to the
    // parent task. The token tracker is path-keyed, so a child SessionStart
    // with a distinct transcriptPath registers a separate transcript that
    // findTaskBySession associates with the parent task. See
    // rfc-activity-log-reliability §3.
    if (event.type === 'session_start' && event.transcriptPath) {
      const task = taskStore.findTaskBySession(tmuxName);
      if (task) {
        tokenTracker.register(event.transcriptPath, task.id);
      } else {
        pendingTranscriptRegistrations.set(tmuxName, event.transcriptPath);
      }
    }

    // Register subagent transcripts so their tokens are summed into the parent
    // task (rfc-cost-comparison-panel.md R13). `tokenTracker.register` is
    // idempotent on path — calling it a second time with the same path is a
    // no-op, so multiple SubagentStop events for the same isSidechain
    // transcript do not double-count.
    if (event.type === 'subagent_stop' && event.agentTranscriptPath) {
      const parentTask = taskStore.findTaskBySession(tmuxName);
      if (parentTask) {
        tokenTracker.register(event.agentTranscriptPath, parentTask.id);
      }
    }

    // Retry pending registration on any subsequent event
    if (pendingTranscriptRegistrations.has(tmuxName)) {
      const task = taskStore.findTaskBySession(tmuxName);
      if (task) {
        tokenTracker.register(pendingTranscriptRegistrations.get(tmuxName)!, task.id);
        pendingTranscriptRegistrations.delete(tmuxName);
      }
    }

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
      abortPendingSuggestion(tmuxName);
    }

    // R16 block-alert (rfc-remote-chat-trigger §7): fire onPermissionBlocked
    // exactly once per entry into permission_blocked state. The integration
    // routes the alert to the originating chat if the task is remote-spawned.
    // Non-remote tasks: integration's lookup misses → no-op.
    const isPermissionBlocked = postState?.anomaly?.type === 'permission_blocked';
    const wasPermissionBlocked = preState?.anomaly?.type === 'permission_blocked';
    if (!wasPermissionBlocked && isPermissionBlocked && deps.onPermissionBlocked) {
      const ownerTaskForAlert = taskStore.findTaskBySession(tmuxName);
      if (ownerTaskForAlert) {
        const permEvent = [...(postState!.events)].reverse().find(isPermissionRequestEvent);
        const promptText = permEvent
          ? `${permEvent.toolName}(${formatToolInput(permEvent.toolInput)})`
          : 'permission required';
        try {
          deps.onPermissionBlocked(ownerTaskForAlert.id, promptText);
        } catch (err) {
          // Never let a faulty integration callback escape the pipeline.
          console.warn('[event-pipeline] onPermissionBlocked threw:', err);
        }
      }
    }

    // Persist lastEventAt in session metadata for watchdog restart recovery
    const ownerTask = taskStore.findTaskBySession(tmuxName);
    if (ownerTask) {
      const session = ownerTask.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) session.lastEventAt = Date.now();
    }
    const snapshot = monitor.getSnapshot();
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: deps.hookIngestion }));

    // On stop/stop_failure events, immediately scan transcript for updated spending
    if (event.type === 'stop' || event.type === 'stop_failure') {
      const stopTask = taskStore.findTaskBySession(tmuxName);
      if (stopTask) {
        tokenTracker.scanTask(stopTask.id).then((changed) => {
          if (!changed) return;
          const usage = tokenTracker.getUsage(stopTask.id);
          if (usage) {
            taskStore.updateTokenUsage(stopTask.id, usage);
          }
          // Notify watchdog of token activity (mirrors lifecycle-timers.ts:76-80)
          for (const session of stopTask.sessions) {
            if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
              watchdog.recordTokenActivity(session.tmuxSession);
            }
          }
          broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: deps.hookIngestion }));
        }).catch(() => { /* scan failure is non-critical — fallback poll will catch it */ });
      }

      // v5 checkpoint cycle: advance state machine on Stop. The cycler returns
      // an action when it wants to send /compact (after the agent has finished
      // its checkpoint-write turn). Actions are dispatched via
      // `adapter.sendInput` so that per-adapter input semantics (Codex CLI's
      // bracketed-paste handling, etc.) are honoured. Fail-open on send
      // errors — checkpointing never breaks the agent.
      if (deps.checkpointCycler && !isCycleDisabled()) {
        const action = deps.checkpointCycler.onStop(tmuxName);
        if (action.kind === 'send_input' || action.kind === 'send_user_message') {
          const text = action.text;
          deps.adapter.sendInput(action.tmuxName, text).catch((err) => {
            console.error('[checkpoint-cycler] sendInput failed on Stop:', err);
          });
        }
      }

      // Ralph iteration cycle: runtime Stop handling belongs to the same
      // ownership service used by route attach/resume catch-up.
      if (stopTask?.ralphLoop?.status === 'completed') {
        deps.ralphLoopService.finalizeCompletedLoopStop(stopTask, tmuxName, event)
          .then((changed) => {
            if (changed) broadcastToAll(createSnapshotMessage({ monitor, serverCwd, activityMetaProvider: deps.hookIngestion }));
          })
          .catch((err) => {
            console.error('[ralph-loop-service] finalizeCompletedLoopStop failed:', err);
          });
      } else if (stopTask?.ralphLoop?.status === 'running' && deps.ralphCycler) {
        deps.ralphLoopService.handleStopEvent(stopTask, tmuxName, event, {
          cumulativeCostUsd: tokenTracker.getUsage(stopTask.id)?.costUsd ?? null,
        })
          .catch((err) => {
            console.error('[ralph-loop-service] handleStopEvent failed:', err);
          });
      }
    }

    // Smart Response Assist: generate quick actions + AI suggestion when agent needs input
    const agentState = snapshot.find((s) => s.agentId === tmuxName);
    if (agentState?.anomaly?.type === 'needs_input') {
      const events = agentState.events.map((e) => ({
        type: e.type,
        toolName: 'toolName' in e ? (e as { toolName: string }).toolName : undefined,
        toolInput: 'toolInput' in e ? (e as { toolInput: unknown }).toolInput : undefined,
      }));
      if (shouldOfferAssist(agentState.anomaly.type, events)) {
        // Extract last message for quick actions
        const lastMessage = (event.type === 'stop' || event.type === 'stop_failure') ? event.lastMessage : '';
        const quickActions = extractQuickActions(lastMessage);

        // Fire-and-forget: generate AI suggestions
        if (llmClient && lastMessage) {
          // Cancel any previous in-flight suggestion for this agent
          const prev = pendingSuggestions.get(tmuxName);
          if (prev) prev.abort();
          const ac = new AbortController();
          pendingSuggestions.set(tmuxName, ac);

          // Gather context
          const recentToolCalls = agentState.events
            .filter((e): e is Extract<typeof e, { type: 'tool_use' }> => e.type === 'tool_use')
            .slice(-5)
            .map((e) => e.toolName);

          generateSuggestedResponses(llmClient, {
            lastAssistantMessage: lastMessage,
            taskPrompt: agentState.taskName,
            cwd: agentState.cwd,
            recentToolCalls,
          }, ac.signal)
            .then((suggestions) => {
              pendingSuggestions.delete(tmuxName);
              // Only broadcast if agent is still waiting for input (guard against race)
              const currentState = monitor.getSnapshot().find(s => s.agentId === tmuxName);
              if (currentState?.anomaly?.type !== 'needs_input') return;
              const suggestionId = generateSuggestionId();
              startLifecycle(tmuxName, suggestionId, telemetryLog);
              broadcastToAll({
                type: 'suggestion',
                agentId: tmuxName,
                suggestionId,
                suggestions,
                quickActions,
              });
            })
            .catch(() => {
              pendingSuggestions.delete(tmuxName);
              // Only send quick actions if agent is still waiting (don't send stale data)
              const currentState = monitor.getSnapshot().find(s => s.agentId === tmuxName);
              if (currentState?.anomaly?.type !== 'needs_input') return;
              const suggestionId = generateSuggestionId();
              startLifecycle(tmuxName, suggestionId, telemetryLog);
              broadcastToAll({
                type: 'suggestion',
                agentId: tmuxName,
                suggestionId,
                suggestions: [],
                quickActions,
              });
            });
        } else {
          // No API key or no message — send quick actions only
          const suggestionId = generateSuggestionId();
          startLifecycle(tmuxName, suggestionId, telemetryLog);
          broadcastToAll({
            type: 'suggestion',
            agentId: tmuxName,
            suggestionId,
            suggestions: [],
            quickActions,
          });
        }
      }
    }

    // Permission Quick Actions: extract permission buttons when agent is permission_blocked
    if (agentState?.anomaly?.type === 'permission_blocked') {
      const permEvent = [...agentState.events].reverse().find(isPermissionRequestEvent);
      if (permEvent) {
        adapter.captureDisplay(tmuxName)
          .then((pane) => {
            // Guard: still permission_blocked? (agent may have moved on during capture)
            const current = monitor.getSnapshot().find(s => s.agentId === tmuxName);
            if (current?.anomaly?.type !== 'permission_blocked') return;
            const quickActions = extractPermissionActions(permEvent.toolName, permEvent.toolInput, pane);
            broadcastToAll({
              type: 'suggestion',
              agentId: tmuxName,
              suggestions: [],
              quickActions,
            });
          })
          .catch(() => {
            // Capture failure is non-critical — user falls back to terminal
          });
      }
    }

    // Feed events to GitHub scanner for immediate reference extraction
    if (githubScanner.isActive()) {
      const ghTask = taskStore.findTaskBySession(tmuxName);
      if (ghTask && ghTask.status === 'inProgress') {
        void githubScanner.processEventsImmediate(tmuxName, [event], ghTask.id);
      }
    }
  };

  // Wire adapter events to the shared event handler
  adapter.onEvent(handleEvent);

  return { abortPendingSuggestion };
}
