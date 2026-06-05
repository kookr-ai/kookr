import { describe, test, expect, beforeEach } from 'vitest';
import type { AgentEvent, Anomaly } from './types.js';
import { detectAnomalies, prioritizeAnomalies } from './anomaly-detector.js';
import {
  getDetectionStats,
  resetDetectionStats,
  recordFalsePositive,
  recordSuppression,
  recordSubagentOrphans,
  recordSubagentTtlEviction,
} from './detection-stats.js';
import {
  eventSequence,
  resetAnomalyDetectorBuilderIds,
} from './__fixtures__/anomaly-detector-builders.js';

let toolUseCounter = 0;
function makeToolUse(sessionId: string, toolName: string, toolInput?: unknown, toolUseId?: string): AgentEvent {
  return { type: 'tool_use', sessionId, toolName, toolInput, toolUseId: toolUseId ?? `toolu_${++toolUseCounter}` };
}

function makeStop(sessionId: string, lastMessage = ''): AgentEvent {
  return { type: 'stop', sessionId, lastMessage };
}

function makePermissionRequest(sessionId: string, toolName: string): AgentEvent {
  return { type: 'permission_request', sessionId, toolName };
}

function makeError(sessionId: string, message: string): AgentEvent {
  return { type: 'error', sessionId, message };
}

function makeToolResult(sessionId: string, toolName: string, toolUseId?: string): AgentEvent {
  return { type: 'tool_result', sessionId, toolName, toolUseId };
}

function makeSubagentStop(sessionId: string, agentId = 'subagent-1'): AgentEvent {
  return { type: 'subagent_stop', sessionId, agentId, agentType: 'test-agent', lastMessage: 'subagent done' };
}

describe('Anomaly Detector', () => {
  const agentId = 'agent-1';

  beforeEach(() => {
    resetDetectionStats();
    resetAnomalyDetectorBuilderIds();
    toolUseCounter = 0;
  });

  describe('needs_input detection (F2.1)', () => {
    test('Stop event produces needs_input anomaly', () => {
      const events = eventSequence()
        .toolUse('Bash', undefined, 'toolu_1')
        .toolResult('Bash', undefined, 'toolu_1')
        .stop('I need your help to decide.')
        .build();

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.agentId).toBe(agentId);
      expect(anomaly!.explanation).toContain('I need your help to decide.');
    });

    test('Stop followed by new activity produces no anomaly', () => {
      const events: AgentEvent[] = [
        makeStop('s1', 'Done for now.'),
        makeToolUse('s1', 'Bash'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });

    test('Stop followed by SubagentStop and idle notification still produces needs_input', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash'),
        makeToolResult('s1', 'Bash'),
        makeStop('s1', 'PR opened. Nothing to do until review.'),
        makeSubagentStop('s1'),
        { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.subType).toBe('stop');
      expect(anomaly!.explanation).toContain('PR opened');
    });
  });

  describe('permission_blocked detection (F2.4)', () => {
    test('PermissionRequest event produces permission_blocked anomaly', () => {
      const events: AgentEvent[] = [
        makePermissionRequest('s1', 'Bash'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('permission_blocked');
      expect(anomaly!.explanation).toBe('Agent is blocked on permission for tool: Bash');
    });

    test('PermissionRequest followed by tool_result produces no anomaly', () => {
      const events: AgentEvent[] = [
        makePermissionRequest('s1', 'Bash'),
        makeToolResult('s1', 'Bash'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });
  });

  describe('repeated same-tool calls (no anomaly expected)', () => {
    test('same tool many times does NOT produce anomaly (normal exploration)', () => {
      const events: AgentEvent[] = Array.from({ length: 20 }, () =>
        makeToolUse('s1', 'Read', { file_path: '/some/file.ts' }),
      );

      const anomaly = detectAnomalies(events, agentId);
      // No anomaly — repeated same-tool is normal (e.g. reading many files)
      expect(anomaly).toBeNull();
    });
  });

  describe('repeated_error detection (F2.3)', () => {
    test('same error 3 times produces repeated_error', () => {
      const events = eventSequence().error('TypeError: x is not a function', 3).build();

      const anomaly = detectAnomalies(events, agentId, { repeatedErrorThreshold: 3 });
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('repeated_error');
      expect(anomaly!.count).toBe(3);
    });

    test('different errors produce no anomaly', () => {
      const events: AgentEvent[] = [
        makeError('s1', 'Error A'),
        makeError('s1', 'Error B'),
        makeError('s1', 'Error C'),
      ];

      const anomaly = detectAnomalies(events, agentId, { repeatedErrorThreshold: 3 });
      expect(anomaly).toBeNull();
    });
  });

  describe('AskUserQuestion detection', () => {
    test('AskUserQuestion tool_use produces needs_input with warning severity', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Read'),
        makeToolResult('s1', 'Read'),
        makeToolUse('s1', 'AskUserQuestion'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.severity).toBe('warning');
      expect(anomaly!.explanation).toContain('AskUserQuestion');
    });

    test('pending AskUserQuestion with trailing PermissionRequest + Notification is needs_input, not permission_blocked', () => {
      // Real Claude Code hook ordering while the user is still at the choice
      // menu: PreToolUse(AskUserQuestion) → PermissionRequest(AskUserQuestion) →
      // Notification(permission_prompt). Without the AskUserQuestion guard in
      // detectPermissionBlocked, this short-circuited to `permission_blocked`
      // ("blocked on permission for tool: AskUserQuestion") and the agent showed
      // as "working" instead of "Needs Input". See incident task 64f2e614.
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash'),
        makeToolResult('s1', 'Bash'),
        makeToolUse('s1', 'AskUserQuestion'),
        makePermissionRequest('s1', 'AskUserQuestion'),
        { type: 'notification', sessionId: 's1', notificationType: 'permission_prompt', message: '' },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.severity).toBe('warning');
      expect(anomaly!.explanation).toContain('AskUserQuestion');
    });

    test('a genuine tool-permission block (non-AskUserQuestion) still reads as permission_blocked', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash'),
        makePermissionRequest('s1', 'Bash'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('permission_blocked');
    });

    test('AskUserQuestion followed by tool_result clears anomaly', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'AskUserQuestion'),
        makeToolResult('s1', 'AskUserQuestion'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });

    test('AskUserQuestion followed by input_received clears anomaly', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'AskUserQuestion'),
        { type: 'input_received', sessionId: 's1' },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });

    test('Stop followed by input_received clears needs_input', () => {
      const events: AgentEvent[] = [
        makeStop('s1', 'Waiting for your input'),
        { type: 'input_received', sessionId: 's1' },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });
  });

  describe('stop event suppresses false positives', () => {
    test('stop after many same-tool calls produces needs_input', () => {
      const events: AgentEvent[] = [
        ...Array.from({ length: 6 }, () => makeToolUse('s1', 'Bash')),
        makeStop('s1', 'All done.'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.severity).toBe('info');
    });

    test('stop after permission_request produces needs_input, not permission_blocked', () => {
      const events: AgentEvent[] = [
        makePermissionRequest('s1', 'Bash'),
        makeStop('s1', 'User declined, what now?'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
    });

    test('stop after repeated errors produces needs_input, not repeated_error', () => {
      const events: AgentEvent[] = [
        makeError('s1', 'TypeError: x is not a function'),
        makeError('s1', 'TypeError: x is not a function'),
        makeError('s1', 'TypeError: x is not a function'),
        makeStop('s1', 'I keep getting an error.'),
      ];

      const anomaly = detectAnomalies(events, agentId, { repeatedErrorThreshold: 3 });
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
    });
  });

  describe('detection telemetry', () => {
    test('detectAnomalies is pure telemetry-wise', () => {
      const events: AgentEvent[] = [makeStop('s1', 'Waiting')];
      detectAnomalies(events, agentId);
      const stats = getDetectionStats();
      expect(stats.checks.needs_input).toBe(0);
      expect(stats.fires.needs_input).toBe(0);
    });

    test('resetDetectionStats clears all counters', () => {
      recordFalsePositive('needs_input');
      resetDetectionStats();
      const stats = getDetectionStats();
      expect(stats.checks.needs_input).toBe(0);
      expect(stats.fires.needs_input).toBe(0);
      expect(stats.falsePositives.needs_input).toBe(0);
    });
  });

  describe('merge_conflict detection', () => {
    test('CONFLICT in Bash git tool_result triggers merge_conflict anomaly', () => {
      const events = eventSequence().bashResult(
        'git merge feature',
        `Merging branch 'feature' into main\nCONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.`,
        'toolu_1',
      ).build();

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('merge_conflict');
      expect(anomaly!.severity).toBe('warning');
      expect(anomaly!.explanation).toContain('src/index.ts');
    });

    test('multiple conflicting files are listed', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash', { command: 'git merge feature' }, 'toolu_1'),
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          toolResponse: `CONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (content): Merge conflict in src/b.ts\nAutomatic merge failed; fix conflicts and then commit the result.`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.explanation).toContain('src/a.ts');
      expect(anomaly!.explanation).toContain('src/b.ts');
    });

    test('Automatic merge failed without file names still triggers', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash', { command: 'git merge feature' }, 'toolu_1'),
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          toolResponse: `Automatic merge failed; fix conflicts and then commit the result.`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('merge_conflict');
    });

    test('rebase conflict triggers detection', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash', { command: 'git rebase main' }, 'toolu_1'),
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          toolResponse: `CONFLICT (content): Merge conflict in package.json\nFailed to merge in the changes`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('merge_conflict');
      expect(anomaly!.explanation).toContain('package.json');
    });

    test('word "conflict" in non-git context does not trigger', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolResponse: `There is a conflict between the two design approaches discussed in the RFC.`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      // Should not trigger — the word "conflict" alone is not a git conflict pattern
      expect(anomaly).toBeNull();
    });

    test('no tool_result events means no merge_conflict', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash'),
        makeToolUse('s1', 'Read'),
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });

    test('stop event after merge conflict returns needs_input not merge_conflict', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash', { command: 'git merge feature' }, 'toolu_1'),
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          toolResponse: `CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.`,
        },
        makeStop('s1', 'I encountered a merge conflict.'),
      ];

      // Stop event takes priority — agent is waiting for input
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
    });

    test('Read tool_result containing detector source text does not trigger merge_conflict', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Read',
          toolResponse: `const MERGE_CONFLICT_PATTERNS = [
  /CONFLICT \\(content\\): Merge conflict in (.+)/,
  /Automatic merge failed; fix conflicts and then commit/,
];`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });

    test('Bash grep output containing detector source text does not trigger merge_conflict', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Bash', { command: 'rg "CONFLICT" src/core/anomaly-detector.ts' }, 'toolu_1'),
        {
          type: 'tool_result',
          sessionId: 's1',
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          toolResponse: `CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result.`,
        },
      ];

      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });
  });

  describe('api_error detection (StopFailure)', () => {
    test('billing_error produces critical api_error anomaly', () => {
      const events: AgentEvent[] = [
        { type: 'stop_failure', sessionId: 's1', error: 'billing_error', lastMessage: 'Credit balance is too low' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('api_error');
      expect(anomaly!.severity).toBe('critical');
      expect(anomaly!.explanation).toContain('billing_error');
    });

    test('rate_limit produces warning api_error anomaly', () => {
      const events: AgentEvent[] = [
        { type: 'stop_failure', sessionId: 's1', error: 'rate_limit', lastMessage: 'Rate limited' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('api_error');
      expect(anomaly!.severity).toBe('warning');
    });

    test('authentication_failed produces critical api_error anomaly', () => {
      const events: AgentEvent[] = [
        { type: 'stop_failure', sessionId: 's1', error: 'authentication_failed', lastMessage: '' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly!.severity).toBe('critical');
    });

    test('server_error produces warning api_error anomaly', () => {
      const events: AgentEvent[] = [
        { type: 'stop_failure', sessionId: 's1', error: 'server_error', lastMessage: '' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly!.severity).toBe('warning');
    });

  });

  describe('notification(idle_prompt) preserves needs_input', () => {
    test('idle_prompt after stop preserves needs_input anomaly', () => {
      const events: AgentEvent[] = [
        makeStop('s1', 'I finished the task'),
        { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'Claude is waiting for your input' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('needs_input');
      expect(anomaly!.subType).toBe('stop');
      expect(anomaly!.explanation).toContain('I finished the task');
    });

    test('non-idle notification type does not trigger needs_input', () => {
      const events: AgentEvent[] = [
        makeToolUse('s1', 'Read'),
        { type: 'notification', sessionId: 's1', notificationType: 'auth_success', message: 'Authenticated' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      // auth_success notification should not be treated as idle
      expect(anomaly?.type).not.toBe('needs_input');
    });

    test('non-idle notification does not clear permission_blocked', () => {
      const events: AgentEvent[] = [
        makePermissionRequest('s1', 'Bash'),
        { type: 'notification', sessionId: 's1', notificationType: 'auth_success', message: 'Authenticated' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      // notification should be transparent — permission_blocked should persist
      expect(anomaly).not.toBeNull();
      expect(anomaly!.type).toBe('permission_blocked');
    });
  });

  describe('user_prompt clears anomalies', () => {
    test('user_prompt as last event returns null (agent active)', () => {
      const events: AgentEvent[] = [
        makeStop('s1', 'Done'),
        { type: 'user_prompt', sessionId: 's1', prompt: 'continue' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });
  });

  describe('session_end clears anomalies', () => {
    test('session_end as last event returns null', () => {
      const events: AgentEvent[] = [
        makeStop('s1', 'Done'),
        { type: 'session_end', sessionId: 's1', reason: 'prompt_input_exit' },
      ];
      const anomaly = detectAnomalies(events, agentId);
      expect(anomaly).toBeNull();
    });
  });

  describe('prioritization (F2.8)', () => {
    test('multiple anomalies sorted by severity', () => {
      const anomalies: Anomaly[] = [
        {
          agentId: 'a1',
          type: 'needs_input',
          severity: 'info',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
        {
          agentId: 'a2',
          type: 'api_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
          count: 6,
        },
        {
          agentId: 'a3',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'Blocked',
          detectedAt: new Date(),
        },
      ];

      const sorted = prioritizeAnomalies(anomalies);
      expect(sorted[0].type).toBe('api_error');
      expect(sorted[1].type).toBe('permission_blocked');
      expect(sorted[2].type).toBe('needs_input');
    });

    test('empty array returns empty', () => {
      expect(prioritizeAnomalies([])).toEqual([]);
    });
  });

  describe('recordFalsePositive', () => {
    test('increments falsePositives counter for the given type', () => {
      recordFalsePositive('merge_conflict');
      recordFalsePositive('merge_conflict');
      recordFalsePositive('repeated_error');
      const stats = getDetectionStats();
      expect(stats.falsePositives.merge_conflict).toBe(2);
      expect(stats.falsePositives.repeated_error).toBe(1);
      expect(stats.falsePositives.needs_input).toBe(0);
    });

    test('resetDetectionStats clears falsePositives', () => {
      recordFalsePositive('merge_conflict');
      resetDetectionStats();
      const stats = getDetectionStats();
      expect(stats.falsePositives.merge_conflict).toBe(0);
    });

    test('falsePositives included in getDetectionStats snapshot', () => {
      const stats = getDetectionStats();
      expect(stats).toHaveProperty('falsePositives');
      expect(typeof stats.falsePositives.merge_conflict).toBe('number');
    });
  });

  describe('subagent suppression telemetry (rfc-subagent-aware-needs-input)', () => {
    test('recordSuppression increments per-type counter', () => {
      recordSuppression('needs_input');
      recordSuppression('needs_input');
      recordSuppression('permission_blocked');
      const stats = getDetectionStats();
      expect(stats.suppressed.needs_input).toBe(2);
      expect(stats.suppressed.permission_blocked).toBe(1);
      expect(stats.suppressed.repeated_error).toBe(0);
    });

    test('recordSubagentOrphans accumulates orphan and session counts independently', () => {
      recordSubagentOrphans(3, 1);   // one session leaked 3 subagents
      recordSubagentOrphans(1, 1);   // another session leaked 1
      const stats = getDetectionStats();
      expect(stats.subagentOrphans).toBe(4);
      expect(stats.subagentSessionsWithOrphans).toBe(2);
    });

    test('recordSubagentTtlEviction increments by count', () => {
      recordSubagentTtlEviction(2);
      recordSubagentTtlEviction(5);
      expect(getDetectionStats().subagentTtlEvictions).toBe(7);
    });

    test('resetDetectionStats clears all new counters', () => {
      recordSuppression('needs_input');
      recordSubagentOrphans(2, 1);
      recordSubagentTtlEviction(1);
      resetDetectionStats();
      const stats = getDetectionStats();
      expect(stats.suppressed.needs_input).toBe(0);
      expect(stats.subagentOrphans).toBe(0);
      expect(stats.subagentSessionsWithOrphans).toBe(0);
      expect(stats.subagentTtlEvictions).toBe(0);
    });

    test('all four new fields are observable through the recording functions', () => {
      // Live-counter assertion: deleting any record function breaks this test
      recordSuppression('needs_input');
      recordSubagentOrphans(2, 1);
      recordSubagentTtlEviction(3);
      const stats = getDetectionStats();
      expect(stats.suppressed.needs_input).toBe(1);
      expect(stats.subagentOrphans).toBe(2);
      expect(stats.subagentSessionsWithOrphans).toBe(1);
      expect(stats.subagentTtlEvictions).toBe(3);
    });
  });
});
