import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { buildBugReportBundle, toBugReportAgentSnapshot } from './bug-report-bundle.js';

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    events: [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'echo secret' } },
    ],
    anomaly: {
      agentId: 'agent-1',
      type: 'api_error',
      severity: 'critical',
      explanation: 'Failed in /home/alice/customer-secret/repo at https://github.com/acme/private-repo/issues/1 with token ghp_123456789012345678901234',
      detectedAt: new Date('2026-05-24T10:00:00Z'),
    },
    taskId: 'task-1',
    taskStatus: 'inProgress',
    cwd: '/home/alice/customer-secret/repo-name',
    description: 'private prompt',
    activityMeta: {
      totalEventsSeen: 1,
      parentEventCount: 1,
      childEventCount: 0,
      foreignEventCount: 0,
      unknownParentageCount: 0,
      malformedRecordCount: 0,
      droppedRecordCount: 0,
      duplicateRecordCount: 0,
    },
    playbookParameterValues: { target: 'private target' },
    tokenUsage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    },
    ...overrides,
  };
}

describe('bug report bundle', () => {
  test('projects selected agent through an allowlisted DTO', () => {
    const snapshot = toBugReportAgentSnapshot(agent());

    expect(snapshot).toMatchObject({
      agentId: 'agent-1',
      taskId: 'task-1',
      cwd: { present: true, kind: 'home' },
      git: { branchPresent: false, commitPresent: false },
      tokenUsage: { totalTokens: 10, totalCostUsd: 0.5 },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('events');
    expect(serialized).not.toContain('toolInput');
    expect(serialized).not.toContain('activityMeta');
    expect(serialized).not.toContain('playbookParameterValues');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).not.toContain('customer-secret');
    expect(serialized).not.toContain('ghp_123456789012345678901234');
  });

  test('redacts project identity, paths, prompts, alerts, notes, and secrets by default', () => {
    const { bundle, serialized } = buildBugReportBundle({
      agents: [agent()],
      selectedAgentId: 'agent-1',
      selectedProject: '/home/alice/customer-secret/repo-name',
      buildInfo: {
        version: 'dev',
        commitHash: 'abc123',
        branch: 'customer-secret-incident',
        buildTimestamp: '2026-05-24T09:00:00.000Z',
      },
      serverStartedAt: null,
      note: 'Saw this in /tmp/customer-secret and https://github.com/acme/private-repo/issues/1?token=secret with Authorization: Bearer abcdefghijklmnop',
      alerts: [{
        id: 'alert-1',
        recordedAt: '2026-05-24T10:00:00.000Z',
        agentId: 'agent-1',
        severity: 'error',
        summaryCategory: 'malformed_websocket',
        details: 'Rejected value /home/alice/customer-secret/repo-name ghp_123456789012345678901234',
      }],
      wireObservations: [{
        direction: 'inbound',
        receivedAt: '2026-05-24T10:00:00.000Z',
        sequence: 1,
        type: 'alert',
        parseOk: true,
        byteLength: 10,
        fieldNames: ['type', 'details'],
        shortPreview: 'customer-secret ghp_123456789012345678901234',
        truncated: false,
      }],
      debugTimeline: [{
        sequence: 7,
        t: '2026-05-24T10:00:00.000Z',
        kind: 'websocket',
        summary: 'received secret token ghp_123456789012345678901234 in /home/alice/customer-secret',
        tags: ['websocket', 'agent-1', 'prompt'],
        payload: {
          authorization: 'Bearer abcdefghijklmnop',
          input: 'proprietary design notes',
          prompt: 'launch proprietary repo analysis',
          state: { taskName: 'secret task name' },
          identifiers: { agentId: 'agent-1' },
          fieldNames: ['type', 'input', 'prompt', 'state'],
          byteLength: 123,
          parseOk: true,
          type: 'respond',
          direction: 'outbound',
          nested: { path: '/home/alice/customer-secret/repo-name' },
        },
      }, {
        sequence: 8,
        t: '2026-05-24T10:00:01.000Z',
        kind: 'websocket',
        summary: 'untrusted inbound prompt',
        tags: ['prompt'],
        payload: {
          type: 'prompt',
          fieldNames: ['type', 'prompt'],
          byteLength: 12,
          parseOk: true,
          direction: 'inbound',
        },
      }, {
        sequence: 9,
        t: '2026-05-24T10:00:02.000Z',
        kind: 'store',
        summary: 'store mutation: input, prompt, taskName',
        tags: ['store', 'input', 'prompt', 'taskName'],
        payload: {
          changedKeys: ['input', 'prompt', 'taskName'],
          agentCountBefore: 1,
          agentCountAfter: 1,
        },
      }],
      now: new Date('2026-05-24T10:00:00.000Z'),
      location: { hostname: 'localhost', protocol: 'http:', pathname: '/tenant/acme/private-repo' },
      navigatorInfo: { userAgent: 'Mozilla/5.0 Chrome/123', platform: 'MacIntel', language: 'en-US' },
      viewport: { width: 1440, height: 900 },
    });

    expect(bundle.selection.selectedProjectPresent).toBe(true);
    expect(serialized).not.toContain('selectedProjectHash');
    expect(serialized).not.toContain('customer-secret');
    expect(serialized).not.toContain('repo-name');
    expect(serialized).not.toContain('acme');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('customer-secret-incident');
    expect(serialized).not.toContain('/tenant/acme/private-repo');
    expect(bundle.source.branch).toBe('[redacted branch]');
    expect(bundle.source.location.route).toBe('[redacted route]');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('Rejected value');
    expect(serialized).not.toContain('ghp_123456789012345678901234');
    expect(serialized).not.toContain('Bearer abcdefghijklmnop');
    expect(serialized).not.toContain('proprietary design notes');
    expect(serialized).not.toContain('launch proprietary repo analysis');
    expect(serialized).not.toContain('secret task name');
    expect(serialized).not.toContain('"input"');
    expect(serialized).not.toContain('"prompt"');
    expect(serialized).not.toContain('"state"');
    expect(serialized).toContain('"fieldCount": 4');
    expect(serialized).toContain('"fieldCount": 2');
    expect(serialized).toContain('"changedKeyCount": 3');
    expect(serialized).toContain('"type": "unknown"');
    expect(serialized).toContain('"agentId": "agent-1"');
    expect(bundle.debugTimeline).toHaveLength(3);
    expect(bundle.source.versionUnavailableReason).toBeUndefined();
  });

  test('records capture diagnostics when a section projection fails closed', () => {
    const brokenAgent = agent();
    Object.defineProperty(brokenAgent, 'tokenUsage', {
      get() {
        throw new Error('token usage unavailable');
      },
    });

    const { bundle } = buildBugReportBundle({
      agents: [brokenAgent],
      selectedAgentId: 'agent-1',
      selectedProject: null,
      buildInfo: null,
      serverStartedAt: null,
      alerts: [],
      wireObservations: [],
      now: new Date('2026-05-24T10:00:00.000Z'),
    });

    expect(bundle.selectedAgent).toBeNull();
    expect(bundle.captureDiagnostics.omittedSections).toContain('selectedAgent');
    expect(bundle.captureDiagnostics.failures[0]).toMatchObject({
      section: 'selectedAgent',
      message: 'token usage unavailable',
    });
  });

  test('truncates oversized bundles deterministically', () => {
    const hugeFieldNames = Array.from({ length: 80_000 }, (_, index) => `field-${index}`);
    const { bundle, serialized } = buildBugReportBundle({
      agents: [],
      selectedAgentId: null,
      selectedProject: null,
      buildInfo: null,
      serverStartedAt: null,
      alerts: [{
        id: 'alert-1',
        recordedAt: '2026-05-24T10:00:00.000Z',
        agentId: 'agent-1',
        severity: 'error',
        summary: 'Malformed WebSocket message',
        summaryCategory: 'malformed_websocket',
      }],
      wireObservations: [{
        direction: 'inbound',
        receivedAt: '2026-05-24T10:00:00.000Z',
        sequence: 1,
        type: 'snapshot',
        parseOk: true,
        byteLength: 1_500_000,
        fieldNames: hugeFieldNames,
        truncated: true,
      }],
      now: new Date('2026-05-24T10:00:00.000Z'),
    });

    expect(bundle.captureDiagnostics.truncationApplied).toBe(true);
    expect(bundle.wireObservations).toEqual([]);
    expect(bundle.alerts).toHaveLength(1);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(bundle.captureDiagnostics.sizeLimitBytes);
  });
});
