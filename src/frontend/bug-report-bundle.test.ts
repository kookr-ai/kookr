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

  test('TS-HEALTH-008 includes redacted session-health evidence in support capture', () => {
    const snapshot = toBugReportAgentSnapshot(agent({
      sessionHealth: {
        schemaVersion: 'session-health.v1',
        sessionId: 'agent-1',
        generatedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
        restartEpoch: new Date('2026-05-24T09:59:00Z').toISOString(),
        classification: 'terminal-attach-stalled',
        task: { status: 'inProgress', turnState: 'running' },
        signals: {
          pty: { state: 'stale', lastProgressAt: new Date('2026-05-24T09:00:00Z').toISOString(), ageMs: 3_600_000, ringHead: 12 },
          hooks: { state: 'fresh', lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(), ageMs: 30_000 },
          transcript: { state: 'fresh', lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(), ageMs: 30_000, present: true },
        },
        backend: {
          transportState: 'verified',
          attachState: 'alive',
          recoveryInProgress: false,
          attachGeneration: 4,
          reattachCount: 2,
          lastAttachAt: new Date('2026-05-24T09:58:00Z').toISOString(),
        },
        browser: {
          bridgeOpen: false,
          lastOpenAt: null,
          lastReplayAt: null,
          lastLiveByteAt: null,
          freshBytesAfterReplay: false,
          replayedOnly: false,
        },
        progress: {
          lastProgressAt: new Date('2026-05-24T09:59:30Z').toISOString(),
          stallAgeMs: 30_000,
        },
        evidence: ['Transcript path /home/alice/private-transcript.jsonl is redacted before capture'],
        coordinatedStall: {
          id: 'coordinated-stall:one,two',
          rootCause: 'coordinated-terminal-path-stall',
          detectedAt: new Date('2026-05-24T10:00:00Z').toISOString(),
          sessionIds: ['agent-1', 'agent-2'],
          windowMs: 2_000,
          restartEpoch: new Date('2026-05-24T09:59:00Z').toISOString(),
          postRestart: true,
          evidence: ['Shared transcript path /home/alice/private-transcript.jsonl'],
        },
      },
    }));

    expect(snapshot.health).toMatchObject({ classification: 'terminal-attach-stalled' });
    expect(snapshot.health?.evidence).toEqual([
      'Transcript path [redacted path] is redacted before capture',
    ]);
    expect(snapshot.health?.coordinatedStall?.evidence).toEqual([
      'Shared transcript path [redacted path]',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('/home/alice');
    expect(JSON.stringify(snapshot)).not.toContain('private-transcript.jsonl');
    expect(JSON.stringify(snapshot)).not.toContain('masterPid');
    expect(JSON.stringify(snapshot)).not.toContain('agentPid');
    expect(JSON.stringify(snapshot)).not.toContain('identityVerified');
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

  test('includes bounded redacted selection transition diagnostics', () => {
    const { bundle, serialized } = buildBugReportBundle({
      agents: [agent()],
      selectedAgentId: 'agent-1',
      selectedProject: null,
      buildInfo: null,
      serverStartedAt: null,
      alerts: [],
      wireObservations: [],
      selectionDiagnostics: {
        transitions: [{
          at: '2026-05-24T10:00:00.000Z',
          atMs: 1,
          fromTaskId: 'private-task-1',
          toTaskId: 'private-task-2',
          fromSessionId: 'private-session-1',
          toSessionId: 'private-session-2',
          source: 'selectAgent',
          reason: 'manual_select',
          selectedProject: 'github.com/acme/customer-secret-repo',
          autoAdvance: { enabled: false, selectedAgentSource: 'manual', lastTickReason: null },
          dashboardSelectionVersion: 2,
          fromTask: {
            agentId: 'private-agent-1',
            taskId: 'private-task-1',
            sessionId: 'private-session-1',
            status: 'inProgress',
            anomalyType: null,
            anomalySeverity: null,
            priority: 'normal',
            snoozed: false,
            suppressed: false,
            projectId: 'github.com/acme/customer-secret-repo',
            coordinatorChip: false,
          },
          toTask: {
            agentId: 'private-agent-2',
            taskId: 'private-task-2',
            sessionId: 'private-session-2',
            status: 'inProgress',
            anomalyType: 'needs_input',
            anomalySeverity: 'warning',
            priority: 'normal',
            snoozed: false,
            suppressed: false,
            projectId: 'github.com/acme/private-repo',
            coordinatorChip: false,
          },
          routingCandidates: [{
            agentId: 'private-agent-2',
            taskId: 'private-task-2',
            sessionId: 'private-session-2',
            status: 'inProgress',
            anomalyType: 'needs_input',
            anomalySeverity: 'warning',
            priority: 'normal',
            projectId: 'github.com/acme/private-repo',
            coordinatorChip: false,
            originalIndex: 0,
          }],
        }],
        flickerIncidents: [{
          incidentId: `selection-flicker-${'x'.repeat(180)}`,
          pairKey: 'private-session-1|private-session-2',
          taskIds: Array.from({ length: 12 }, (_, index) => `task-${index}-github.com/acme/private-repo`),
          sessionIds: Array.from({ length: 12 }, (_, index) => `agent-${index}-github.com/acme/private-repo`),
          firstAt: '2026-05-24T10:00:00.000Z',
          lastAt: '2026-05-24T10:00:02.000Z',
          switchCount: 3,
          switchesPerSecond: 1.5,
          sourceCounts: Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [`selectAgent-${index}-${'x'.repeat(120)}`, index + 1]),
          ),
          firstTaskStates: { from: null, to: null },
          lastTaskStates: {
            from: null,
            to: {
              agentId: 'agent-2',
            agentId: 'private-agent-2',
            taskId: 'private-task-2',
            sessionId: 'private-session-2',
              status: 'inProgress',
              anomalyType: 'needs_input',
              anomalySeverity: 'warning',
              priority: 'normal',
              snoozed: false,
              suppressed: false,
              projectId: 'github.com/acme/private-repo',
              coordinatorChip: false,
            },
          },
          websocketMessageCounts: Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [`dashboardSelection-${index}-${'y'.repeat(120)}`, index + 1]),
          ),
          droppedTransitionCount: 0,
        }],
      },
      now: new Date('2026-05-24T10:00:00.000Z'),
    });

    expect(bundle.selectionDiagnostics.transitions).toHaveLength(1);
    expect(bundle.selectionDiagnostics.flickerIncidents[0]).toMatchObject({
      switchCount: 3,
    });
    expect(bundle.selectionDiagnostics.flickerIncidents[0].incidentId).toHaveLength(120);
    expect(bundle.selectionDiagnostics.flickerIncidents[0].pairKey).toBe('[redacted pair]');
    expect(bundle.selectionDiagnostics.flickerIncidents[0].taskIds).toHaveLength(8);
    expect(bundle.selectionDiagnostics.flickerIncidents[0].taskIds.every((id) => id === '[redacted id]')).toBe(true);
    expect(bundle.selectionDiagnostics.flickerIncidents[0].sessionIds).toHaveLength(8);
    expect(bundle.selectionDiagnostics.flickerIncidents[0].sessionIds.every((id) => id === '[redacted id]')).toBe(true);
    expect(Object.keys(bundle.selectionDiagnostics.flickerIncidents[0].sourceCounts)).toHaveLength(10);
    expect(Object.keys(bundle.selectionDiagnostics.flickerIncidents[0].sourceCounts).every((key) => key.length <= 80)).toBe(true);
    expect(Object.keys(bundle.selectionDiagnostics.flickerIncidents[0].websocketMessageCounts)).toHaveLength(10);
    expect(Object.keys(bundle.selectionDiagnostics.flickerIncidents[0].websocketMessageCounts).every((key) => key.length <= 80)).toBe(true);
    expect(bundle.selectionDiagnostics.transitions[0].selectedProject).toBe('[redacted project]');
    expect(bundle.selectionDiagnostics.transitions[0].fromTaskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].toTaskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].fromSessionId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].toSessionId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].fromTask?.agentId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].fromTask?.taskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].fromTask?.sessionId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].toTask?.projectId).toBe('[redacted project]');
    expect(bundle.selectionDiagnostics.transitions[0].toTask?.agentId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].toTask?.taskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].toTask?.sessionId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].routingCandidates[0].projectId).toBe('[redacted project]');
    expect(bundle.selectionDiagnostics.transitions[0].routingCandidates[0].agentId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].routingCandidates[0].taskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.transitions[0].routingCandidates[0].sessionId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.flickerIncidents[0].lastTaskStates.to?.projectId).toBe('[redacted project]');
    expect(bundle.selectionDiagnostics.flickerIncidents[0].lastTaskStates.to?.agentId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.flickerIncidents[0].lastTaskStates.to?.taskId).toBe('[redacted id]');
    expect(bundle.selectionDiagnostics.flickerIncidents[0].lastTaskStates.to?.sessionId).toBe('[redacted id]');
    expect(serialized).not.toContain('customer-secret');
    expect(serialized).not.toContain('repo-name');
    expect(serialized).not.toContain('acme');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('private-task');
    expect(serialized).not.toContain('private-session');
    expect(serialized).not.toContain('private-agent');
  });

  test('truncates oversized bundles deterministically', () => {
    const hugeFieldNames = Array.from({ length: 80_000 }, (_, index) => `field-${index}`);
    const selectionTransition = {
      at: '2026-05-24T10:00:00.000Z',
      atMs: 1,
      fromTaskId: 'task-1',
      toTaskId: 'task-2',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      source: 'selectAgent',
      reason: 'manual_select',
      selectedProject: 'github.com/acme/private-repo',
      autoAdvance: { enabled: false, selectedAgentSource: 'manual', lastTickReason: null },
      dashboardSelectionVersion: 2,
      fromTask: null,
      toTask: null,
      routingCandidates: [],
    };
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
      selectionDiagnostics: {
        transitions: Array.from({ length: 105 }, (_, index) => ({ ...selectionTransition, atMs: index })),
        flickerIncidents: Array.from({ length: 25 }, (_, index) => ({
          incidentId: `selection-flicker-${index}`,
          pairKey: 'agent-1|agent-2',
          taskIds: ['task-1', 'task-2'],
          sessionIds: ['agent-1', 'agent-2'],
          firstAt: '2026-05-24T10:00:00.000Z',
          lastAt: '2026-05-24T10:00:02.000Z',
          switchCount: 3,
          switchesPerSecond: 1.5,
          sourceCounts: { selectAgent: 3 },
          firstTaskStates: { from: null, to: null },
          lastTaskStates: { from: null, to: null },
          websocketMessageCounts: { dashboardSelection: 1 },
          droppedTransitionCount: 0,
        })),
      },
      now: new Date('2026-05-24T10:00:00.000Z'),
    });

    expect(bundle.captureDiagnostics.truncationApplied).toBe(true);
    expect(bundle.wireObservations).toEqual([]);
    expect(bundle.selectionDiagnostics.transitions).toEqual([]);
    expect(bundle.selectionDiagnostics.flickerIncidents).toHaveLength(5);
    expect(bundle.captureDiagnostics.warnings.some((warning) => warning.includes('selection transitions'))).toBe(true);
    expect(bundle.alerts).toHaveLength(1);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(bundle.captureDiagnostics.sizeLimitBytes);
  });
});
