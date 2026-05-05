import type { Monitor } from '../core/monitor.js';
import type { TaskStore } from '../core/tasks.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { AgentEvent } from '../core/types.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { shouldOfferAssist, extractQuickActions } from '../core/response-assist.js';
import { generateSuggestedResponses } from '../core/response-suggest.js';
import { extractPermissionActions } from '../core/permission-actions.js';
import { isPermissionRequestEvent } from '../core/types.js';
import type { LlmClient } from '../core/llm-client.js';
import type { AutonomyOrchestrator } from './autonomy-orchestrator.js';
import type { DeferredTelemetryLogWriter } from '../core/telemetry.js';
import {
  generateSuggestionId, getActiveSuggestionId,
  startLifecycle, resolveLifecycle,
} from '../core/suggestion-telemetry.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { CheckpointCycler } from '../core/checkpoint-cycler.js';
import { isCycleDisabled } from '../core/checkpoint-cycler.js';

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
  autonomyOrchestrator?: AutonomyOrchestrator;
  telemetryLog?: DeferredTelemetryLogWriter;
  /** Optional v5 checkpoint cycler — advances state on Stop events. */
  checkpointCycler?: CheckpointCycler;
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

  const handleEvent = (tmuxName: string, event: AgentEvent) => {
    // Register transcript for token tracking when session starts
    if (event.type === 'session_start' && event.transcriptPath) {
      const task = taskStore.findTaskBySession(tmuxName);
      if (task) {
        tokenTracker.register(event.transcriptPath, task.id);
      } else {
        pendingTranscriptRegistrations.set(tmuxName, event.transcriptPath);
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

    // Persist lastEventAt in session metadata for watchdog restart recovery
    const ownerTask = taskStore.findTaskBySession(tmuxName);
    if (ownerTask) {
      const session = ownerTask.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) session.lastEventAt = Date.now();
    }
    const snapshot = monitor.getSnapshot();
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));

    // Auto-proceed: delegate scheduling decision to orchestrator
    deps.autonomyOrchestrator?.scheduleIfNeeded(tmuxName);

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
          broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
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
