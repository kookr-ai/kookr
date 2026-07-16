import { z } from 'zod';
import { LAUNCH_DEPENDENCIES } from './playbook.js';
import { AGENT_SELECTIONS, AGENT_TYPES } from './agent-types.js';

/**
 * Runtime validators for the ServerMessage discriminated union.
 *
 * ServerMessage is the outbound half of the /ws contract. Nested DTOs such as
 * AgentState, Playbook, and WorkspaceView already have shared TypeScript
 * contracts, so this schema validates the wire envelope and required top-level
 * fields while requiring nested DTOs to be JSON objects.
 */

const agentType = z.enum(AGENT_TYPES);
const agentSelection = z.enum(AGENT_SELECTIONS);
const anomalySeverity = z.enum(['info', 'warning', 'critical']);
const hostCapability = z.enum(['available', 'absent']);
const launchDependency = z.enum(LAUNCH_DEPENDENCIES);

const jsonObject = z.object({}).passthrough();

const quotaWindow = z.object({
  utilization: z.number(),
  resetsAt: z.string(),
});

const quotaStatus = z.object({
  fiveHour: quotaWindow.nullable(),
  sevenDay: quotaWindow.nullable(),
  updatedAt: z.number(),
});

const diagnosticFinding = z.object({
  checkId: z.string(),
  title: z.string(),
  description: z.string(),
  severity: z.enum(['warning', 'critical']),
  observed: z.number(),
  threshold: z.number(),
  scope: z.string(),
});

const diagnosticReport = z.object({
  timestamp: z.number(),
  findings: z.array(diagnosticFinding),
  helperLlm: jsonObject.optional(),
  persistenceHealth: jsonObject.optional(),
});

const achievementCounters = z.object({
  repeated_error_resolutions: z.number(),
  permission_blocked_resolutions: z.number(),
  merge_conflict_resolutions: z.number(),
  api_error_resolutions: z.number(),
  needs_input_resolutions: z.number(),
  session_start_total: z.number(),
});

const availableAgentType = z.object({
  type: agentType,
  label: z.string(),
});

const workspaceSweepProgressStatus = z.enum(['running', 'done', 'failed', 'skipped']);

const workspaceSweepProgressCounts = z.object({
  done: z.number(),
  skipped: z.number(),
  failed: z.number(),
});

const workspaceSweepProgressSnapshot = z.object({
  runId: z.string(),
  startedAt: z.string(),
  index: z.number(),
  total: z.number(),
  projectId: z.string(),
  status: workspaceSweepProgressStatus,
  counts: workspaceSweepProgressCounts,
});

const snapshotMessage = z.object({
  type: z.literal('snapshot'),
  agents: z.array(jsonObject),
  serverCwd: z.string(),
  serverRevision: z.number().optional(),
  build: jsonObject.optional(),
  serverStartedAt: z.string().optional(),
  sttEnabled: z.boolean().optional(),
  sttUrl: z.string().optional(),
  ttsEnabled: z.boolean().optional(),
  ttsUrl: z.string().optional(),
  speechCapabilities: jsonObject.optional(),
  totalSpendUsd: z.number().optional(),
  achievements: z.record(z.string(), z.string()).optional(),
  achievementCounters: achievementCounters.optional(),
  achievementStreak: z.object({
    lastActiveDate: z.string().nullable(),
    currentStreak: z.number(),
  }).optional(),
  availableAgentTypes: z.array(availableAgentType).optional(),
  defaultAgentType: agentSelection.optional(),
  workspaceEnabled: z.boolean().optional(),
  sweepRunning: z.boolean().optional(),
  sweepProgress: workspaceSweepProgressSnapshot.optional(),
  lastSweepRunId: z.string().optional(),
  drainStatus: z.object({
    accepting: z.boolean(),
    draining: z.boolean(),
    since: z.string().optional(),
  }).optional(),
  maxActiveTasks: z.number().optional(),
  coordinator: jsonObject.optional(),
  taskRelations: z.array(jsonObject).optional(),
});

const updateMessage = z.object({
  type: z.literal('update'),
  agentId: z.string(),
  state: jsonObject,
});

const alertMessage = z.object({
  type: z.literal('alert'),
  agentId: z.string(),
  summary: z.string(),
  details: z.string(),
  severity: anomalySeverity,
});

const githubUpdateMessage = z.object({
  type: z.literal('githubUpdate'),
  taskId: z.string(),
  prs: z.array(jsonObject),
  issues: z.array(jsonObject),
  changes: z.array(jsonObject),
});

const playbooksMessage = z.object({
  type: z.literal('playbooks'),
  cwd: z.string(),
  playbooks: z.array(jsonObject),
  capabilities: z.partialRecord(launchDependency, hostCapability).optional(),
});

const quickAction = z.object({
  label: z.string(),
  value: z.string(),
  shortcut: z.string().optional(),
  keystroke: z.string().optional(),
  permissionRequest: jsonObject.optional(),
});

const suggestionMessage = z.object({
  type: z.literal('suggestion'),
  agentId: z.string(),
  suggestionId: z.string().optional(),
  suggestions: z.array(z.string()),
  quickActions: z.array(quickAction),
});

const projectSummariesMessage = z.object({
  type: z.literal('projectSummaries'),
  projects: z.array(jsonObject),
});

const coordinatorSnapshotMessage = z.object({
  type: z.literal('coordinator.snapshot'),
  coordinator: jsonObject,
});

const dashboardSelectionMessage = z.object({
  type: z.literal('dashboardSelection'),
  selectedTaskId: z.string().nullable(),
  selectedSessionId: z.string().nullable(),
  selectionVersion: z.number(),
});

const emptyEnterDecisionMessage = z.object({
  type: z.literal('emptyEnterDecision'),
  decision: jsonObject,
});

const contributionWarningMessage = z.object({
  type: z.literal('contributionWarning'),
  project: z.string(),
  message: z.string(),
  severity: z.enum(['approaching', 'exceeded']),
});

const achievementUnlockedMessage = z.object({
  type: z.literal('achievement:unlocked'),
  id: z.string(),
  name: z.string(),
  emoji: z.string(),
  description: z.string(),
  unlockedAt: z.string(),
});

const achievementResetAckMessage = z.object({
  type: z.literal('achievement:reset:ack'),
  success: z.boolean(),
  error: z.string().optional(),
});

const quotaStatusMessage = z.object({
  type: z.literal('quotaStatus'),
  quota: quotaStatus,
});

const resourceStatusMessage = z.object({
  type: z.literal('resourceStatus'),
  status: z.object({
    source: z.object({ kind: z.literal('server-host') }),
    sampledAt: z.string(),
    sampleGapMs: z.number().nullable(),
    timerDriftMs: z.number().nullable(),
    host: z.object({
      cpuUsagePercent: z.number().nullable(),
      memoryUsedPercent: z.number().nullable(),
      memoryFreeBytes: z.number().nullable(),
      memoryTotalBytes: z.number().nullable(),
      dataDirectory: z.object({
        path: z.string().nullable(),
        diskFreeBytes: z.number().nullable(),
        diskTotalBytes: z.number().nullable(),
        diskFreePercent: z.number().nullable(),
      }),
    }),
    server: z.object({
      eventLoopDelayP95Ms: z.number().nullable(),
      processRssBytes: z.number().nullable(),
      processHeapUsedBytes: z.number().nullable(),
      processHeapTotalBytes: z.number().nullable(),
    }),
    unavailable: z.array(z.enum([
      'cpu_warming_up',
      'cpu_unavailable',
      'cpu_delta_invalid',
      'memory_unavailable',
      'data_directory_disk_unavailable',
      'event_loop_unavailable',
      'sampler_error',
    ])),
  }),
});

const circuitBreakerStatusMessage = z.object({
  type: z.literal('circuitBreakerStatus'),
  breakers: z.array(jsonObject),
});

const schedulesMessage = z.object({
  type: z.literal('schedules'),
  schedules: z.array(jsonObject),
  revision: z.number(),
  status: jsonObject,
});

const scheduleFiredMessage = z.object({
  type: z.literal('scheduleFired'),
  scheduleId: z.string(),
  taskId: z.string(),
});

const workspaceViewMessage = z.object({
  type: z.literal('workspaceView'),
  view: jsonObject,
  error: z.string().optional(),
  cleanupResult: jsonObject.optional(),
  cleanupResults: z.array(jsonObject).optional(),
  diagnosticLaunch: jsonObject.optional(),
});

const workspaceCleanupDetailMessage = z.object({
  type: z.literal('workspaceCleanupDetail'),
  worktreePath: z.string(),
  detail: jsonObject.optional(),
  error: z.string().optional(),
});

const crossProjectSweepProjectResult = z.union([
  z.object({
    kind: z.literal('ok'),
    projectId: z.string(),
    summaries: z.array(jsonObject),
    elapsedMs: z.number(),
  }),
  z.object({
    kind: z.literal('skipped'),
    projectId: z.string(),
    reason: z.literal('repo_path_unresolved'),
  }),
  z.object({
    kind: z.literal('skipped'),
    projectId: z.string(),
    reason: z.literal('workspace_unavailable'),
    missingDeps: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('failed'),
    projectId: z.string(),
    code: z.enum(['timeout', 'error']),
    message: z.string(),
    elapsedMs: z.number(),
  }),
]);

const sweepReportBucket = z.enum([
  'removed',
  'removal_failed',
  'probably_safe',
  'needs_call',
  'blocked',
]);

const sweepReportRow = z.object({
  projectId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  classification: z.string(),
  reasonCode: z.string(),
  bucket: sweepReportBucket,
  footprintBytes: z.number().nullable(),
  lastTouchedMs: z.number().nullable(),
  reason: z.string(),
  disposition: z.string().optional(),
  hasSensitiveIgnored: z.boolean().optional(),
  ignoredSample: z.array(z.string()).optional(),
  fingerprint: z.string().optional(),
});

const sweepReportBucketSummary = z.object({
  count: z.number(),
  footprintBytesUpperBound: z.number(),
  unknownFootprintCount: z.number(),
});

const sweepReport = z.object({
  runId: z.string(),
  generatedAt: z.string(),
  thresholdDays: z.number(),
  rows: z.array(sweepReportRow),
  buckets: z.record(sweepReportBucket, sweepReportBucketSummary),
  notAnalyzed: z.array(z.object({
    projectId: z.string(),
    code: z.enum(['timeout', 'error']),
    notAnalyzedCount: z.number(),
  })),
  reconstructedFromLedger: z.boolean().optional(),
});

const workspaceSweepProgressMessage = workspaceSweepProgressSnapshot.extend({
  type: z.literal('workspaceSweepProgress'),
  result: crossProjectSweepProjectResult.optional(),
});

const workspaceBulkRemoveProgressMessage = z.object({
  type: z.literal('workspaceBulkRemoveProgress'),
  runId: z.string(),
  index: z.number(),
  total: z.number(),
  projectId: z.string(),
  worktreePath: z.string(),
  status: workspaceSweepProgressStatus,
  // Loose object, mirroring workspaceView.cleanupResult — a CleanupResultSummary
  // when status === 'done'.
  result: jsonObject.optional(),
});

const workspaceSweepCompleteMessage = z.object({
  type: z.literal('workspaceSweepComplete'),
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  projects: z.array(crossProjectSweepProjectResult),
  report: sweepReport.optional(),
});

const workspaceSweepBusyMessage = z.object({
  type: z.literal('workspaceSweepBusy'),
  holderPid: z.number(),
  heldSince: z.string(),
});

const workspaceSweepReportMessage = z.object({
  type: z.literal('workspaceSweepReport'),
  runId: z.string(),
  report: sweepReport.optional(),
});

const diagnosticReportMessage = z.object({
  type: z.literal('diagnosticReport'),
  report: diagnosticReport,
});

const ossAttemptsMessage = z.object({
  type: z.literal('ossAttempts'),
  store: z.object({
    attempts: z.array(jsonObject),
    registryActiveRepos: z.array(z.string()),
    lastRefreshAt: z.string().nullable(),
    lastRefreshIssueCheckErrors: z.array(jsonObject),
  }),
  refreshStatus: z.object({
    inProgress: z.boolean(),
    lastError: z.string().nullable().optional(),
    partial: z.boolean().optional(),
    truncated: z.array(z.string()).optional(),
  }).optional(),
});

const ServerMessageSchemaImpl = z.union([
  snapshotMessage,
  updateMessage,
  alertMessage,
  githubUpdateMessage,
  playbooksMessage,
  suggestionMessage,
  projectSummariesMessage,
  coordinatorSnapshotMessage,
  dashboardSelectionMessage,
  emptyEnterDecisionMessage,
  contributionWarningMessage,
  achievementUnlockedMessage,
  achievementResetAckMessage,
  quotaStatusMessage,
  resourceStatusMessage,
  circuitBreakerStatusMessage,
  schedulesMessage,
  scheduleFiredMessage,
  workspaceViewMessage,
  workspaceCleanupDetailMessage,
  workspaceSweepProgressMessage,
  workspaceBulkRemoveProgressMessage,
  workspaceSweepCompleteMessage,
  workspaceSweepBusyMessage,
  workspaceSweepReportMessage,
  diagnosticReportMessage,
  ossAttemptsMessage,
]);

export const ServerMessageSchema = ServerMessageSchemaImpl;
