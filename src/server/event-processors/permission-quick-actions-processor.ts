import { extractPermissionActions } from '../../core/permission-actions.js';
import { buildPermissionRequestBinding, latestPermissionRequestEvent } from '../permission-request-binding.js';
import { isPermissionRequestEvent } from '../../core/types.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';

interface DisplayCapture {
  captureDisplay(tmuxName: string): Promise<string>;
}

export interface PermissionQuickActionsProcessorDeps {
  displayCapture: DisplayCapture;
  getAgentState: (agentId: string) => AgentState | undefined;
  broadcastToAll: (msg: ServerMessage) => void;
}

export interface PermissionQuickActionsProcessor {
  process(input: { tmuxName: string; agentState: AgentState | undefined }): void;
}

export function createPermissionQuickActionsProcessor({
  displayCapture,
  getAgentState,
  broadcastToAll,
}: PermissionQuickActionsProcessorDeps): PermissionQuickActionsProcessor {
  return {
    process({ tmuxName, agentState }) {
      // Permission Quick Actions: extract permission buttons when agent is permission_blocked.
      if (agentState?.anomaly?.type !== 'permission_blocked') return;

      const permEvent = [...agentState.events].reverse().find(isPermissionRequestEvent);
      if (!permEvent) return;

      displayCapture.captureDisplay(tmuxName)
        .then((pane) => {
          // Guard: still permission_blocked? (agent may have moved on during capture).
          const current = getAgentState(tmuxName);
          if (current?.anomaly?.type !== 'permission_blocked') return;
          const currentPermEvent = latestPermissionRequestEvent(current.events);
          if (!currentPermEvent) return;
          const permissionRequest = buildPermissionRequestBinding({
            sessionId: tmuxName,
            event: currentPermEvent,
            detectedAt: current.anomaly.detectedAt,
          });
          const quickActions = extractPermissionActions(currentPermEvent.toolName, currentPermEvent.toolInput, pane)
            .map((action) => ({ ...action, permissionRequest }));
          broadcastToAll({
            type: 'suggestion',
            agentId: tmuxName,
            suggestions: [],
            quickActions,
          });
        })
        .catch(() => {
          // Capture failure is non-critical — user falls back to terminal.
        });
    },
  };
}
