import { describe, expect, test } from 'vitest';
import { ServerMessageSchema } from './server-message-schema.js';
import { SERVER_MESSAGE_TYPES, type ServerMessage } from './messages.js';

function serverMessageCase<T extends ServerMessage>(message: T): T {
  return message;
}

const resourceStatus = {
  source: { kind: 'server-host' },
  sampledAt: '2026-06-10T12:00:00.000Z',
  sampleGapMs: 1000,
  timerDriftMs: 3,
  host: {
    cpuUsagePercent: 12,
    memoryUsedPercent: 50,
    memoryFreeBytes: 1024,
    memoryTotalBytes: 2048,
    dataDirectory: {
      path: '/tmp/kookr-data',
      diskFreeBytes: 1024,
      diskTotalBytes: 2048,
      diskFreePercent: 50,
      diskFreeInodes: 500,
      diskTotalInodes: 1_000,
    },
  },
  server: {
    eventLoopDelayP95Ms: 4,
    processRssBytes: 100,
    processHeapUsedBytes: 50,
    processHeapTotalBytes: 80,
  },
  unavailable: [],
};

const workspaceView = {
  projectId: 'github.com/acme/project',
  displayName: 'acme/project',
  policy: 'known_policy',
  repoPath: '/tmp/project',
  candidates: [],
  recentAttempts: [],
  activeLeases: [],
};

const serverMessageCases = [
  serverMessageCase({
    type: 'snapshot',
    agents: [],
    serverCwd: '/tmp/project',
    drainStatus: { accepting: false, draining: true, since: '2026-05-29T12:00:00.000Z' },
  }),
  serverMessageCase({ type: 'update', agentId: 'agent-1', state: { agentId: 'agent-1', events: [], anomaly: null } }),
  serverMessageCase({ type: 'alert', agentId: 'agent-1', summary: 'Needs input', details: 'Prompt is waiting', severity: 'warning' }),
  serverMessageCase({ type: 'githubUpdate', taskId: 'task-1', prs: [], issues: [], changes: [] }),
  serverMessageCase({
    type: 'playbooks',
    cwd: '/tmp/project',
    playbooks: [{
      id: 'repair.md',
      scope: 'project',
      name: 'Repair',
      description: 'Repair issue',
      parameters: [],
      checklist: [],
      tags: [],
      body: 'Fix it',
      sourceCwd: '/tmp/project',
    }],
    capabilities: { kb: 'available', 'evolution-config': 'absent' },
  }),
  serverMessageCase({
    type: 'suggestion',
    agentId: 'agent-1',
    suggestionId: 'suggestion-1',
    suggestions: ['continue'],
    quickActions: [{ label: 'Continue', value: 'continue', shortcut: 'c' }],
  }),
  serverMessageCase({ type: 'projectSummaries', projects: [] }),
  serverMessageCase({ type: 'coordinator.snapshot', coordinator: { outputs: [], chips: [], findings: [], chains: {} } }),
  serverMessageCase({ type: 'dashboardSelection', selectedTaskId: 'task-1', selectedSessionId: 'session-1', selectionVersion: 1 }),
  serverMessageCase({
    type: 'emptyEnterDecision',
    decision: {
      intentId: 'intent-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      action: 'send_enter',
      reason: 'ready',
      selectionVersion: 1,
    },
  }),
  serverMessageCase({ type: 'contributionWarning', project: 'github.com/acme/project', message: 'limit approaching', severity: 'approaching' }),
  serverMessageCase({
    type: 'achievement:unlocked',
    id: 'first-task',
    name: 'First Task',
    emoji: '*',
    description: 'Completed one task',
    unlockedAt: '2026-06-10T12:00:00.000Z',
  }),
  serverMessageCase({ type: 'achievement:reset:ack', success: true }),
  serverMessageCase({
    type: 'quotaStatus',
    quota: {
      fiveHour: { utilization: 0.1, resetsAt: '2026-06-11T00:00:00.000Z' },
      sevenDay: null,
      updatedAt: 1790000000000,
    },
  }),
  serverMessageCase({ type: 'resourceStatus', status: resourceStatus }),
  serverMessageCase({ type: 'circuitBreakerStatus', breakers: [] }),
  serverMessageCase({
    type: 'schedules',
    schedules: [],
    revision: 1,
    status: {
      timezone: 'UTC',
      catchUpMode: 'auto',
      catchUpEnabled: true,
      schedulerHealthy: true,
    },
  }),
  serverMessageCase({ type: 'scheduleFired', scheduleId: 'schedule-1', taskId: 'task-1' }),
  serverMessageCase({ type: 'workspaceView', view: workspaceView }),
  serverMessageCase({ type: 'workspaceCleanupDetail', worktreePath: '/tmp/worktree' }),
  serverMessageCase({
    type: 'worktreeCleanupVerdicts',
    taskId: 'task-1',
    verdicts: [{
      worktreePath: '/tmp/worktree',
      worktreeName: 'worktree',
      branch: 'feat/x',
      removable: false,
      blocker: 'uncommitted-changes',
      evidence: { dirty: { modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 2 }, aheadCount: 3 },
      checkedAt: '2026-06-10T12:00:00.000Z',
    }],
  }),
  serverMessageCase({
    type: 'workspaceSweepProgress',
    runId: 'run-1',
    startedAt: '2026-06-10T12:00:00.000Z',
    index: 1,
    total: 2,
    projectId: 'github.com/acme/project',
    status: 'running',
    counts: { done: 0, skipped: 0, failed: 0 },
  }),
  serverMessageCase({
    type: 'workspaceBulkRemoveProgress',
    runId: 'bulk-1',
    index: 1,
    total: 3,
    projectId: 'github.com/acme/project',
    worktreePath: '/tmp/wt',
    status: 'done',
    result: {
      branch: 'feat/x',
      disposition: 'path_removed_branch_retained',
      pathRemoved: true,
      branchRemoved: false,
      retainedReason: 'user_requested_keep_branch',
    },
  }),
  serverMessageCase({
    type: 'workspaceSweepComplete',
    runId: 'run-1',
    startedAt: '2026-06-10T12:00:00.000Z',
    finishedAt: '2026-06-10T12:00:01.000Z',
    projects: [{ kind: 'skipped', projectId: 'github.com/acme/project', reason: 'repo_path_unresolved' }],
  }),
  serverMessageCase({ type: 'workspaceSweepBusy', holderPid: 1234, heldSince: '2026-06-10T12:00:00.000Z' }),
  serverMessageCase({
    type: 'workspaceSweepReport',
    runId: 'run-1',
    report: {
      runId: 'run-1',
      generatedAt: '2026-06-10T12:00:01.000Z',
      thresholdDays: 14,
      rows: [{
        projectId: 'github.com/acme/project',
        worktreePath: '/tmp/wt',
        branch: 'feat/x',
        classification: 'merged',
        reasonCode: 'cleanup_requested',
        bucket: 'removed',
        footprintBytes: null,
        lastTouchedMs: null,
        reason: 'removed path; deleted branch',
        disposition: 'completed',
      }],
      buckets: {
        removed: { count: 1, footprintBytesUpperBound: 0, unknownFootprintCount: 1 },
        removal_failed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        probably_safe: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        needs_call: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        blocked: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
      },
      notAnalyzed: [],
      reconstructedFromLedger: true,
    },
  }),
  serverMessageCase({ type: 'diagnosticReport', report: { timestamp: 1790000000000, findings: [] } }),
  serverMessageCase({
    type: 'ossAttempts',
    store: {
      attempts: [],
      registryActiveRepos: ['owner/repo'],
      lastRefreshAt: null,
      lastRefreshIssueCheckErrors: [],
    },
    refreshStatus: { inProgress: false, lastError: null },
  }),
  serverMessageCase({
    type: 'wsBackpressureNotice',
    kind: 'loadShedActive',
    eventLoopDelayP95Ms: 1800,
  }),
  serverMessageCase({
    type: 'deployLifecycle',
    phase: 'starting',
  }),
  // Delta envelope (#1754, Stage 1) — ships dark, but part of the wire contract.
  serverMessageCase({
    type: 'delta',
    epoch: '2026-08-01T00:00:00.000Z',
    seq: 42,
    agents: { upserts: [], removed: [] },
    taskRelations: [],
    aggregates: { totalSpendUsd: 5 },
  }),
] as const;

const coveredServerMessageTypes = serverMessageCases.map((message) => message.type);

describe('ServerMessageSchema', () => {
  test.each(serverMessageCases)('accepts a representative $type message', (message) => {
    const result = ServerMessageSchema.safeParse(message);
    expect(result.success).toBe(true);
  });

  test('covers every known server message type exactly once', () => {
    expect(new Set(coveredServerMessageTypes)).toEqual(new Set(SERVER_MESSAGE_TYPES));
    expect(new Set(coveredServerMessageTypes).size).toBe(coveredServerMessageTypes.length);
  });

  test('accepts partial playbook capability records', () => {
    const result = ServerMessageSchema.safeParse(serverMessageCase({
      type: 'playbooks',
      cwd: '/tmp/project',
      playbooks: [],
      capabilities: { kb: 'available' },
    }));

    expect(result.success).toBe(true);
  });

  test('accepts legacy resource status messages without inode fields', () => {
    const {
      diskFreeInodes: _diskFreeInodes,
      diskTotalInodes: _diskTotalInodes,
      ...legacyDataDirectory
    } = resourceStatus.host.dataDirectory;
    const legacyResourceStatus = {
      ...resourceStatus,
      host: { ...resourceStatus.host, dataDirectory: legacyDataDirectory },
    };

    expect(ServerMessageSchema.safeParse({
      type: 'resourceStatus',
      status: legacyResourceStatus,
    }).success).toBe(true);
  });

  test('accepts Grok Build in the advertised agent types and default selection', () => {
    const result = ServerMessageSchema.safeParse(serverMessageCase({
      type: 'snapshot',
      agents: [],
      serverCwd: '/tmp/project',
      availableAgentTypes: [{ type: 'grok-build', label: 'Grok Build' }],
      defaultAgentType: 'grok-build',
    }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.availableAgentTypes).toEqual([{ type: 'grok-build', label: 'Grok Build' }]);
      expect(result.data.defaultAgentType).toBe('grok-build');
    }
  });

  test('accepts workspace-unavailable sweep results with missing dependency details', () => {
    const result = ServerMessageSchema.safeParse(serverMessageCase({
      type: 'workspaceSweepComplete',
      runId: '',
      startedAt: '2026-06-10T12:00:00.000Z',
      finishedAt: '2026-06-10T12:00:00.000Z',
      projects: [{ kind: 'skipped', projectId: '', reason: 'workspace_unavailable', missingDeps: ['attemptRepository'] }],
    }));

    expect(result.success).toBe(true);
  });

  test('accepts terminal workspace sweep progress messages with result details', () => {
    const result = ServerMessageSchema.safeParse(serverMessageCase({
      type: 'workspaceSweepProgress',
      runId: 'run-1',
      startedAt: '2026-06-10T12:00:00.000Z',
      index: 1,
      total: 2,
      projectId: 'github.com/acme/project',
      status: 'skipped',
      counts: { done: 0, skipped: 1, failed: 0 },
      result: { kind: 'skipped', projectId: 'github.com/acme/project', reason: 'repo_path_unresolved' },
    }));

    expect(result.success).toBe(true);
  });

  test.each([
    {
      name: 'alert without required details',
      message: {
        type: 'alert',
        agentId: 'agent-1',
        summary: 'Needs input',
        severity: 'warning',
      },
    },
    {
      name: 'quotaStatus with legacy quota fields',
      message: {
        type: 'quotaStatus',
        quota: {
          used: 1,
          limit: 10,
          remaining: 9,
          resetsAt: '2026-06-11T00:00:00.000Z',
        },
      },
    },
    {
      name: 'diagnosticReport without required report fields',
      message: { type: 'diagnosticReport', report: { id: 'report-1' } },
    },
  ])('rejects malformed outbound payloads: $name', ({ message }) => {
    const result = ServerMessageSchema.safeParse(message);
    expect(result.success).toBe(false);
  });

  test('round-trips representative messages through JSON and the schema', () => {
    for (const message of serverMessageCases) {
      const roundTripped = JSON.parse(JSON.stringify(message));
      const result = ServerMessageSchema.safeParse(roundTripped);
      expect(result.success, message.type).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    }
  });
});
