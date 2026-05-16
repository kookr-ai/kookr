import { beforeEach, describe, expect, test, vi } from 'vitest';
import { _resetLifecycles } from '../../core/suggestion-telemetry.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { createResponseAssistProcessor } from './response-assist-processor.js';

function needsInputState(): AgentState {
  return {
    agentId: 'agent-1',
    taskName: 'Task prompt',
    cwd: '/repo',
    anomaly: {
      agentId: 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date(),
      subType: 'stop',
    },
    events: [{ type: 'stop', sessionId: 's1', lastMessage: 'Shall I continue?' }],
  };
}

describe('ResponseAssistProcessor', () => {
  beforeEach(() => {
    _resetLifecycles();
  });

  test('broadcasts quick-action-only suggestions when no LLM client is configured', () => {
    const broadcastToAll = vi.fn();
    const processor = createResponseAssistProcessor({
      getAgentState: vi.fn().mockReturnValue(needsInputState()),
      llmClient: null,
      broadcastToAll,
    });

    processor.process({
      tmuxName: 'agent-1',
      event: { type: 'stop', sessionId: 's1', lastMessage: 'Shall I continue?' },
      agentState: needsInputState(),
    });

    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
      type: 'suggestion',
      agentId: 'agent-1',
      suggestions: [],
      quickActions: [
        { label: 'Continue', value: 'yes, continue', shortcut: 'c' },
        { label: 'Stop here', value: 'no, stop here', shortcut: 's' },
      ],
    }));
  });

  test('abortPendingSuggestion clears active suggestions', () => {
    const broadcastToAll = vi.fn();
    const processor = createResponseAssistProcessor({
      getAgentState: vi.fn(),
      llmClient: null,
      broadcastToAll,
    });

    processor.abortPendingSuggestion('agent-1');

    expect(broadcastToAll).toHaveBeenCalledWith({
      type: 'suggestion',
      agentId: 'agent-1',
      suggestionId: '',
      suggestions: [],
      quickActions: [],
    });
  });
});
