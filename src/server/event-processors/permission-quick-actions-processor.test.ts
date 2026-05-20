import { describe, expect, test, vi } from 'vitest';
import { buildPermissionRequestBinding } from '../../shared/contracts/permission-request-binding.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { createPermissionQuickActionsProcessor } from './permission-quick-actions-processor.js';

function permissionState(): AgentState {
  return {
    agentId: 'agent-1',
    anomaly: {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'permission required',
      detectedAt: new Date(),
    },
    events: [{
      type: 'permission_request',
      sessionId: 's1',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
    }],
  };
}

describe('PermissionQuickActionsProcessor', () => {
  test('captures the pane and broadcasts permission quick actions while still blocked', async () => {
    const broadcasts: unknown[] = [];
    const current = permissionState();
    const permissionRequest = buildPermissionRequestBinding({
      sessionId: 'agent-1',
      event: current.events[0] as Extract<AgentState['events'][number], { type: 'permission_request' }>,
      detectedAt: current.anomaly!.detectedAt,
    });
    const processor = createPermissionQuickActionsProcessor({
      displayCapture: {
        captureDisplay: vi.fn().mockResolvedValue('Do you want to proceed?\n1. Yes\n2. No'),
      },
      getAgentState: vi.fn().mockReturnValue(current),
      broadcastToAll: (msg) => { broadcasts.push(msg); },
    });

    processor.process({ tmuxName: 'agent-1', agentState: permissionState() });

    await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
    expect(broadcasts[0]).toMatchObject({
      type: 'suggestion',
      agentId: 'agent-1',
      suggestions: [],
      quickActions: [
        {
          label: 'Allow: Bash: `git status`',
          keystroke: '1',
          permissionRequest,
        },
        {
          label: 'Deny',
          keystroke: '2',
          permissionRequest,
        },
      ],
    });
  });

  test('drops captured actions if the agent is no longer permission blocked', async () => {
    const broadcastToAll = vi.fn();
    const processor = createPermissionQuickActionsProcessor({
      displayCapture: {
        captureDisplay: vi.fn().mockResolvedValue('Do you want to proceed?\n1. Yes\n2. No'),
      },
      getAgentState: vi.fn().mockReturnValue({ agentId: 'agent-1', anomaly: null, events: [] }),
      broadcastToAll,
    });

    processor.process({ tmuxName: 'agent-1', agentState: permissionState() });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  test('drops captured actions if the active request has already been answered', async () => {
    const broadcastToAll = vi.fn();
    const current = permissionState();
    current.events.push({ type: 'input_received', sessionId: 's1' });
    const processor = createPermissionQuickActionsProcessor({
      displayCapture: {
        captureDisplay: vi.fn().mockResolvedValue('Do you want to proceed?\n1. Yes\n2. No'),
      },
      getAgentState: vi.fn().mockReturnValue(current),
      broadcastToAll,
    });

    processor.process({ tmuxName: 'agent-1', agentState: permissionState() });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(broadcastToAll).not.toHaveBeenCalled();
  });
});
