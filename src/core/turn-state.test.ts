import { describe, test, expect } from 'vitest';
import type { AgentEvent } from './types.js';
import { deriveTurnState } from './turn-state.js';

function toolUse(sessionId: string, toolName: string, toolInput?: unknown): AgentEvent {
  return { type: 'tool_use', sessionId, toolName, toolInput };
}

function toolResult(sessionId: string, toolName: string): AgentEvent {
  return { type: 'tool_result', sessionId, toolName };
}

function stop(sessionId: string, lastMessage = 'Done.'): AgentEvent {
  return { type: 'stop', sessionId, lastMessage };
}

describe('deriveTurnState', () => {
  test('empty event window is unknown', () => {
    expect(deriveTurnState([])).toBe('unknown');
  });

  describe('completed_turn (normal Stop, issue #358)', () => {
    test('a Claude session that emits a final answer and Stop is completed_turn', () => {
      const events: AgentEvent[] = [
        { type: 'session_start', sessionId: 'kookr-claude-1' },
        toolUse('kookr-claude-1', 'Bash'),
        toolResult('kookr-claude-1', 'Bash'),
        stop('kookr-claude-1', 'Yes. In a clean headless Chromium run...'),
      ];
      expect(deriveTurnState(events)).toBe('completed_turn');
    });

    test('a Codex session that emits a final answer and Stop is completed_turn', () => {
      // Mirrors incident task aee1d3b3 / session kookr-1bb16ec4: Codex emitted a
      // normal final answer + Stop while the interactive terminal stayed alive.
      const events: AgentEvent[] = [
        { type: 'session_start', sessionId: 'kookr-1bb16ec4' },
        toolUse('kookr-1bb16ec4', 'Bash'),
        toolResult('kookr-1bb16ec4', 'Bash'),
        stop('kookr-1bb16ec4', 'Yes. In a clean headless Chromium run...'),
      ];
      expect(deriveTurnState(events)).toBe('completed_turn');
    });

    test('Stop followed by a trailing SubagentStop overlay stays completed_turn', () => {
      const events: AgentEvent[] = [
        stop('s1', 'PR opened.'),
        { type: 'subagent_stop', sessionId: 's1', agentId: 'sub-1', agentType: 'reviewer', lastMessage: 'ok' },
      ];
      expect(deriveTurnState(events)).toBe('completed_turn');
    });

    test('Stop followed by a trailing idle notification stays completed_turn', () => {
      const events: AgentEvent[] = [
        stop('s1', 'PR opened.'),
        { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'waiting' },
      ];
      expect(deriveTurnState(events)).toBe('completed_turn');
    });
  });

  describe('running (active turn)', () => {
    test('an in-flight tool call is running', () => {
      expect(deriveTurnState([toolUse('s1', 'Bash', { command: 'pnpm test' })])).toBe('running');
    });

    test('a fresh tool_result is running', () => {
      expect(deriveTurnState([toolUse('s1', 'Edit'), toolResult('s1', 'Edit')])).toBe('running');
    });

    test('a tool_error mid-turn is running (the agent works through it)', () => {
      const events: AgentEvent[] = [
        toolUse('s1', 'Bash'),
        { type: 'tool_error', sessionId: 's1', toolName: 'Bash', error: 'exit 1', isInterrupt: false },
      ];
      expect(deriveTurnState(events)).toBe('running');
    });

    test('a user_prompt (follow-up sent) restarts a completed turn as running', () => {
      const events: AgentEvent[] = [
        stop('s1', 'turn one done'),
        { type: 'user_prompt', sessionId: 's1', prompt: 'now do the next thing' },
      ];
      expect(deriveTurnState(events)).toBe('running');
    });
  });

  describe('waiting_for_input (explicit question)', () => {
    test('an unanswered AskUserQuestion is waiting_for_input', () => {
      const events: AgentEvent[] = [
        toolUse('s1', 'Bash'),
        toolUse('s1', 'AskUserQuestion', { question: 'Which approach?' }),
      ];
      expect(deriveTurnState(events)).toBe('waiting_for_input');
    });

    test('an answered AskUserQuestion (tool_result follows) is running again', () => {
      const events: AgentEvent[] = [
        toolUse('s1', 'AskUserQuestion', { question: 'Which approach?' }),
        toolResult('s1', 'AskUserQuestion'),
      ];
      expect(deriveTurnState(events)).toBe('running');
    });

    test('a pending AskUserQuestion with its trailing PermissionRequest + Notification is waiting_for_input', () => {
      // Real Claude Code hook ordering for a multiple-choice question that the
      // user has NOT answered yet (the PostToolUse only fires once they pick an
      // option). Without the AskUserQuestion guard this read as `blocked` and the
      // dashboard showed the agent as "working". See incident task 64f2e614.
      const events: AgentEvent[] = [
        toolUse('s1', 'Bash'),
        toolResult('s1', 'Bash'),
        toolUse('s1', 'AskUserQuestion', { question: 'Local Qwen or OpenRouter?' }),
        { type: 'permission_request', sessionId: 's1', toolName: 'AskUserQuestion' },
        { type: 'notification', sessionId: 's1', notificationType: 'permission_prompt', message: '' },
      ];
      expect(deriveTurnState(events)).toBe('waiting_for_input');
    });
  });

  describe('blocked', () => {
    test('an outstanding permission_request is blocked', () => {
      const events: AgentEvent[] = [{ type: 'permission_request', sessionId: 's1', toolName: 'Bash' }];
      expect(deriveTurnState(events)).toBe('blocked');
    });

    test('a stop_failure (API error killed the turn) is blocked', () => {
      const events: AgentEvent[] = [
        toolUse('s1', 'Bash'),
        { type: 'stop_failure', sessionId: 's1', error: 'overloaded_error', lastMessage: '' },
      ];
      expect(deriveTurnState(events)).toBe('blocked');
    });
  });

  test('session_end is unknown — turn state no longer meaningful', () => {
    const events: AgentEvent[] = [stop('s1', 'bye'), { type: 'session_end', sessionId: 's1', reason: 'exit' }];
    expect(deriveTurnState(events)).toBe('unknown');
  });

  test('a window of only trailing overlays is unknown', () => {
    const events: AgentEvent[] = [
      { type: 'notification', sessionId: 's1', notificationType: 'auth_success', message: 'ok' },
    ];
    expect(deriveTurnState(events)).toBe('unknown');
  });
});
