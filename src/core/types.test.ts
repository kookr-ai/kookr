import { describe, test, expect } from 'vitest';
import type {
  AgentEvent,
} from './types.js';

// Type guard functions
import {
  isToolUseEvent,
  isToolResultEvent,
  isStopEvent,
  isSessionStartEvent,
  isPermissionRequestEvent,
  isErrorEvent,
} from './types.js';

describe('Core Types', () => {
  describe('AgentEvent discriminated union', () => {
    test('narrows on type field using isToolUseEvent', () => {
      const event: AgentEvent = {
        type: 'tool_use',
        sessionId: 'sess-1',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      };
      expect(isToolUseEvent(event)).toBe(true);
      if (isToolUseEvent(event)) {
        expect(event.toolName).toBe('Bash');
        expect(event.toolInput).toEqual({ command: 'ls' });
      }
    });

    test('narrows on type field using isStopEvent', () => {
      const event: AgentEvent = {
        type: 'stop',
        sessionId: 'sess-1',
        lastMessage: 'Done editing the file.',
      };
      expect(isStopEvent(event)).toBe(true);
      if (isStopEvent(event)) {
        expect(event.lastMessage).toBe('Done editing the file.');
      }
    });

    test('isToolUseEvent returns false for non-tool_use events', () => {
      const event: AgentEvent = {
        type: 'stop',
        sessionId: 'sess-1',
        lastMessage: 'done',
      };
      expect(isToolUseEvent(event)).toBe(false);
    });

    test('isSessionStartEvent narrows correctly', () => {
      const event: AgentEvent = {
        type: 'session_start',
        sessionId: 'sess-1',
        transcriptPath: '/path/to/transcript.jsonl',
        model: 'claude-sonnet-4-20250514',
      };
      expect(isSessionStartEvent(event)).toBe(true);
      if (isSessionStartEvent(event)) {
        expect(event.transcriptPath).toBe('/path/to/transcript.jsonl');
        expect(event.model).toBe('claude-sonnet-4-20250514');
      }
    });

    test('isPermissionRequestEvent narrows correctly', () => {
      const event: AgentEvent = {
        type: 'permission_request',
        sessionId: 'sess-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf /' },
      };
      expect(isPermissionRequestEvent(event)).toBe(true);
      if (isPermissionRequestEvent(event)) {
        expect(event.toolName).toBe('Bash');
      }
    });

    test('isToolResultEvent narrows correctly', () => {
      const event: AgentEvent = {
        type: 'tool_result',
        sessionId: 'sess-1',
        toolName: 'Bash',
        toolResponse: { output: 'hello' },
      };
      expect(isToolResultEvent(event)).toBe(true);
      if (isToolResultEvent(event)) {
        expect(event.toolName).toBe('Bash');
        expect(event.toolResponse).toEqual({ output: 'hello' });
      }
    });

    test('isErrorEvent narrows correctly', () => {
      const event: AgentEvent = {
        type: 'error',
        sessionId: 'sess-1',
        message: 'Something went wrong',
      };
      expect(isErrorEvent(event)).toBe(true);
      if (isErrorEvent(event)) {
        expect(event.message).toBe('Something went wrong');
      }
    });
  });

  // Tautological tests removed (2026-03-27 audit):
  // - AgentStatus exhaustive switch: tested its own local switch, not implementation code
  // - TaskStatus exhaustive coverage: same — switch lived in the test
  // - HookEventName union: hardcoded array asserted against itself
  // - Anomaly 'has required fields': literal object asserted on its own fields
  // - Anomaly 'supports all anomaly types': array length matched its own construction
  // - Anomaly 'supports all severity levels': same pattern
  // These provided false confidence. TypeScript enforces the type constraints at compile time.
});
