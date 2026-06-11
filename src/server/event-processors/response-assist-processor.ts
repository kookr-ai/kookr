import type { LlmClient } from '../../core/llm-client.js';
import { shouldOfferAssist, extractQuickActions } from '../../core/response-assist.js';
import { generateSuggestedResponses } from '../../core/response-suggest.js';
import type { DeferredTelemetryLogWriter } from '../../core/telemetry.js';
import type { AgentEvent } from '../../core/types.js';
import {
  generateSuggestionId, getActiveSuggestionId,
  startLifecycle, resolveLifecycle,
} from '../../core/suggestion-telemetry.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

export interface ResponseAssistProcessorDeps {
  getAgentState: (agentId: string) => AgentState | undefined;
  llmClient: LlmClient | null;
  broadcastToAll: (msg: ServerMessage) => void;
  telemetryLog?: DeferredTelemetryLogWriter;
}

export interface ResponseAssistProcessor {
  abortPendingSuggestion(agentId: string, outcome?: 'used' | 'cleared'): void;
  process(input: { tmuxName: string; event: AgentEvent; agentState: AgentState | undefined }): void;
}

export function createResponseAssistProcessor({
  getAgentState,
  llmClient,
  broadcastToAll,
  telemetryLog,
}: ResponseAssistProcessorDeps): ResponseAssistProcessor {
  // Track in-flight AI suggestion API calls so they can be cancelled on user input.
  const pendingSuggestions = new Map<string, AbortController>();

  /** Cancel any in-flight suggestion generation for this agent and clear stale suggestions. */
  function abortPendingSuggestion(agentId: string, outcome: 'used' | 'cleared' = 'cleared'): void {
    // Extract suggestionId BEFORE resolving — resolveLifecycle may clear the map entry.
    const suggestionId = getActiveSuggestionId(agentId) ?? '';
    resolveLifecycle(agentId, outcome, telemetryLog);
    const ac = pendingSuggestions.get(agentId);
    if (ac) {
      ac.abort();
      pendingSuggestions.delete(agentId);
    }
    broadcastToAll({ type: 'suggestion', agentId, suggestionId, suggestions: [], quickActions: [] });
  }

  function processNeedsInput(tmuxName: string, event: AgentEvent, agentState: AgentState): void {
    const events = agentState.events.map((e) => ({
      type: e.type,
      toolName: 'toolName' in e ? (e as { toolName: string }).toolName : undefined,
      toolInput: 'toolInput' in e ? (e as { toolInput: unknown }).toolInput : undefined,
    }));
    if (!shouldOfferAssist('needs_input', events)) return;

    // Extract last message for quick actions.
    const lastMessage = agentState.anomaly?.transcriptContext?.lastAssistantMessage.excerpt
      ?? ((event.type === 'stop' || event.type === 'stop_failure') ? event.lastMessage : '');
    const quickActions = extractQuickActions(lastMessage);

    // Fire-and-forget: generate AI suggestions.
    if (llmClient && lastMessage) {
      // Cancel any previous in-flight suggestion for this agent.
      const prev = pendingSuggestions.get(tmuxName);
      if (prev) prev.abort();
      const ac = new AbortController();
      pendingSuggestions.set(tmuxName, ac);

      // Gather context.
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
          // Only broadcast if agent is still waiting for input (guard against race).
          const currentState = getAgentState(tmuxName);
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
          // Only send quick actions if agent is still waiting (don't send stale data).
          const currentState = getAgentState(tmuxName);
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
      // No API key or no message — send quick actions only.
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

  return {
    abortPendingSuggestion,
    process({ tmuxName, event, agentState }) {
      // Smart Response Assist: generate quick actions + AI suggestion when agent needs input.
      if (agentState?.anomaly?.type === 'needs_input') {
        processNeedsInput(tmuxName, event, agentState);
      }
    },
  };
}
