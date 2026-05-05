import { describe, test, expect } from 'vitest';
import { analyzeSession, type FrictionCategory, type ReflectionReport } from './friction-analyzer.js';
import type { InteractionEvent } from './interaction-log.js';

// --- Helpers ---

function makeInput(agentId: string, content: string, timestamp: string): InteractionEvent {
  return { type: 'user_input', agentId, content, timestamp };
}

function makeSkip(agentId: string, anomalyType: 'needs_input' | 'permission_blocked', timestamp: string): InteractionEvent {
  return { type: 'finding_skipped', agentId, anomalyType, timestamp };
}

function makeResolved(
  agentId: string,
  anomalyType: 'needs_input' | 'permission_blocked',
  method: 'input' | 'auto_clear' | 'skip' | 'snooze',
  durationMs: number,
  timestamp: string,
): InteractionEvent {
  return { type: 'finding_resolved', agentId, anomalyType, method, durationMs, timestamp };
}

function makeLaunched(agentId: string, timestamp: string): InteractionEvent {
  return { type: 'agent_launched', agentId, taskPrompt: 'Fix something', timestamp };
}

function makeStopped(agentId: string, timestamp: string): InteractionEvent {
  return { type: 'agent_stopped', agentId, reason: 'completed', timestamp };
}

function makeSnoozed(agentId: string, timestamp: string): InteractionEvent {
  return { type: 'finding_snoozed', agentId, durationMs: 60_000, timestamp };
}

function findByName(report: ReflectionReport, name: string) {
  return report.findings.filter((f) => f.name === name);
}

// --- Tests ---

describe('Friction Analyzer', () => {
  describe('empty session', () => {
    test('returns empty report for no events', () => {
      const report = analyzeSession([]);
      expect(report.agentCount).toBe(0);
      expect(report.totalInterventions).toBe(0);
      expect(report.findings).toHaveLength(0);
    });
  });

  describe('session summary', () => {
    test('counts agents, interventions, and time range', () => {
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', '2026-03-25T10:00:00Z'),
        makeLaunched('agent-2', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'fix it', '2026-03-25T10:02:00Z'),
        makeInput('agent-2', 'try again', '2026-03-25T10:03:00Z'),
        makeInput('agent-1', 'one more', '2026-03-25T10:04:00Z'),
        makeStopped('agent-1', '2026-03-25T10:05:00Z'),
      ];

      const report = analyzeSession(events);
      expect(report.agentCount).toBe(2);
      expect(report.totalInterventions).toBe(3);
      expect(report.sessionStart).toBe('2026-03-25T10:00:00Z');
      expect(report.sessionEnd).toBe('2026-03-25T10:05:00Z');
    });
  });

  describe('Rule 1: Repeated input', () => {
    test('detects same message sent multiple times to same agent', () => {
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', '2026-03-25T10:00:00Z'),
        makeInput('agent-1', 'run tests', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'run tests', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const repeated = findByName(report, 'Repeated input');
      expect(repeated).toHaveLength(1);
      expect(repeated[0].category).toBe('repeated_correction');
      expect(repeated[0].frequency).toBe(2);
    });

    test('detects same message sent to different agents', () => {
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', '2026-03-25T10:00:00Z'),
        makeLaunched('agent-2', '2026-03-25T10:00:00Z'),
        makeInput('agent-1', 'use strict types', '2026-03-25T10:01:00Z'),
        makeInput('agent-2', 'use strict types', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const repeated = findByName(report, 'Repeated input');
      expect(repeated).toHaveLength(1);
      expect(repeated[0].evidence[0]).toContain('2 agent(s)');
    });

    test('normalizes case and trailing punctuation', () => {
      const events: InteractionEvent[] = [
        makeInput('agent-1', 'Run Tests!', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'run tests', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const repeated = findByName(report, 'Repeated input');
      expect(repeated).toHaveLength(1);
    });

    test('does not flag unique messages', () => {
      const events: InteractionEvent[] = [
        makeInput('agent-1', 'fix the auth bug', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'add error handling', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const repeated = findByName(report, 'Repeated input');
      expect(repeated).toHaveLength(0);
    });
  });

  describe('Rule 2: Intervention without finding', () => {
    test('detects user input before any finding exists for that agent', () => {
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', '2026-03-25T10:00:00Z'),
        // User sends input to agent-1 before any anomaly was detected
        makeInput('agent-1', 'are you stuck?', '2026-03-25T10:01:00Z'),
      ];

      const report = analyzeSession(events);
      const gaps = findByName(report, 'Intervention without finding');
      expect(gaps).toHaveLength(1);
      expect(gaps[0].category).toBe('detection_gap');
    });

    test('does not flag input after a finding exists', () => {
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', '2026-03-25T10:00:00Z'),
        makeResolved('agent-1', 'needs_input', 'input', 5000, '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'try this approach', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const gaps = findByName(report, 'Intervention without finding');
      expect(gaps).toHaveLength(0);
    });
  });

  describe('Rule 3: Rapid skip cycle', () => {
    test('detects 3+ skips within 30 seconds', () => {
      const base = new Date('2026-03-25T10:00:00Z').getTime();
      const events: InteractionEvent[] = [
        makeSkip('agent-1', 'needs_input', new Date(base).toISOString()),
        makeSkip('agent-2', 'needs_input', new Date(base + 5000).toISOString()),
        makeSkip('agent-3', 'needs_input', new Date(base + 10000).toISOString()),
      ];

      const report = analyzeSession(events);
      const rapid = findByName(report, 'Rapid skip cycle');
      expect(rapid).toHaveLength(1);
      expect(rapid[0].category).toBe('workflow_inefficiency');
    });

    test('does not flag skips spread over time', () => {
      const base = new Date('2026-03-25T10:00:00Z').getTime();
      const events: InteractionEvent[] = [
        makeSkip('agent-1', 'needs_input', new Date(base).toISOString()),
        makeSkip('agent-2', 'needs_input', new Date(base + 60_000).toISOString()),
        makeSkip('agent-3', 'needs_input', new Date(base + 120_000).toISOString()),
      ];

      const report = analyzeSession(events);
      const rapid = findByName(report, 'Rapid skip cycle');
      expect(rapid).toHaveLength(0);
    });
  });

  describe('Rule 4: Question-shaped input', () => {
    test('detects multiple question-shaped inputs', () => {
      const events: InteractionEvent[] = [
        makeInput('agent-1', 'Did you run the tests?', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'Are you done yet?', '2026-03-25T10:02:00Z'),
      ];

      const report = analyzeSession(events);
      const questions = findByName(report, 'Question-shaped inputs');
      expect(questions).toHaveLength(1);
      expect(questions[0].category).toBe('reactive_user');
      expect(questions[0].frequency).toBe(2);
    });

    test('does not flag commands that happen to start with question words', () => {
      const events: InteractionEvent[] = [
        makeInput('agent-1', 'Can you fix the auth module?', '2026-03-25T10:01:00Z'),
      ];

      const report = analyzeSession(events, { questionInputThreshold: 2 });
      const questions = findByName(report, 'Question-shaped inputs');
      expect(questions).toHaveLength(0);
    });
  });

  describe('Rule 5: Long resolution time', () => {
    test('detects anomalies that took over 5 minutes to resolve', () => {
      const events: InteractionEvent[] = [
        makeResolved(
          'agent-1',
          'needs_input',
          'input',
          6 * 60_000, // 6 minutes
          '2026-03-25T10:06:00Z',
        ),
      ];

      const report = analyzeSession(events);
      const slow = findByName(report, 'Long resolution time');
      expect(slow).toHaveLength(1);
      expect(slow[0].category).toBe('workflow_inefficiency');
    });

    test('does not flag fast resolutions', () => {
      const events: InteractionEvent[] = [
        makeResolved('agent-1', 'needs_input', 'input', 30_000, '2026-03-25T10:00:30Z'),
      ];

      const report = analyzeSession(events);
      const slow = findByName(report, 'Long resolution time');
      expect(slow).toHaveLength(0);
    });
  });

  describe('Rule 6: Always-skipped anomaly type', () => {
    test('detects anomaly type skipped more than 50% of the time', () => {
      const events: InteractionEvent[] = [
        makeSkip('agent-1', 'permission_blocked', '2026-03-25T10:01:00Z'),
        makeSkip('agent-2', 'permission_blocked', '2026-03-25T10:02:00Z'),
        makeResolved('agent-3', 'permission_blocked', 'input', 5000, '2026-03-25T10:03:00Z'),
      ];

      const report = analyzeSession(events);
      const always = findByName(report, 'Always-skipped anomaly type');
      expect(always).toHaveLength(1);
      expect(always[0].evidence[0]).toContain('permission_blocked');
      expect(always[0].evidence[0]).toContain('2/3');
    });

    test('does not flag anomaly types with low skip ratio', () => {
      const events: InteractionEvent[] = [
        makeSkip('agent-1', 'needs_input', '2026-03-25T10:01:00Z'),
        makeResolved('agent-2', 'needs_input', 'input', 5000, '2026-03-25T10:02:00Z'),
        makeResolved('agent-3', 'needs_input', 'input', 5000, '2026-03-25T10:03:00Z'),
        makeResolved('agent-4', 'needs_input', 'input', 5000, '2026-03-25T10:04:00Z'),
      ];

      const report = analyzeSession(events);
      const always = findByName(report, 'Always-skipped anomaly type');
      expect(always).toHaveLength(0);
    });

    test('requires at least 2 total occurrences', () => {
      const events: InteractionEvent[] = [
        makeSkip('agent-1', 'permission_blocked', '2026-03-25T10:01:00Z'),
      ];

      const report = analyzeSession(events);
      const always = findByName(report, 'Always-skipped anomaly type');
      expect(always).toHaveLength(0);
    });
  });

  describe('combined scenario', () => {
    test('session with multiple friction patterns', () => {
      const base = new Date('2026-03-25T10:00:00Z').getTime();
      const events: InteractionEvent[] = [
        makeLaunched('agent-1', new Date(base).toISOString()),
        makeLaunched('agent-2', new Date(base + 1000).toISOString()),

        // Repeated input (same message to 2 agents)
        makeInput('agent-1', 'run tests', new Date(base + 60_000).toISOString()),
        makeInput('agent-2', 'run tests', new Date(base + 65_000).toISOString()),

        // Question-shaped inputs
        makeInput('agent-1', 'Did you check the logs?', new Date(base + 120_000).toISOString()),
        makeInput('agent-2', 'Are the tests passing?', new Date(base + 125_000).toISOString()),

        // Long resolution
        makeResolved('agent-1', 'needs_input', 'input', 10 * 60_000, new Date(base + 700_000).toISOString()),

        makeStopped('agent-1', new Date(base + 800_000).toISOString()),
        makeStopped('agent-2', new Date(base + 800_000).toISOString()),
      ];

      const report = analyzeSession(events);
      expect(report.agentCount).toBe(2);
      expect(report.findings.length).toBeGreaterThanOrEqual(3);

      const categories = new Set(report.findings.map((f) => f.category));
      expect(categories).toContain('repeated_correction');
      expect(categories).toContain('reactive_user');
      expect(categories).toContain('workflow_inefficiency');
    });
  });

  describe('configuration overrides', () => {
    test('custom thresholds change detection sensitivity', () => {
      const events: InteractionEvent[] = [
        makeInput('agent-1', 'fix it', '2026-03-25T10:01:00Z'),
        makeInput('agent-1', 'fix it', '2026-03-25T10:02:00Z'),
        makeInput('agent-1', 'fix it', '2026-03-25T10:03:00Z'),
      ];

      // With default threshold (2), should detect
      const report1 = analyzeSession(events);
      expect(findByName(report1, 'Repeated input')).toHaveLength(1);

      // With higher threshold (5), should not detect
      const report2 = analyzeSession(events, { repeatedInputThreshold: 5 });
      expect(findByName(report2, 'Repeated input')).toHaveLength(0);
    });
  });
});
