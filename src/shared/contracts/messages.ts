import type { AgentState } from './agent-state.js';
import type { AgentSelection, AvailableAgentType } from './agent-types.js';
import type { AnomalySeverity, AnomalyType } from './anomalies.js';
import type { BuildInfo } from './build-info.js';
import type { CircuitBreakerSnapshot } from './circuit-breaker.js';
import type { DiagnosticReport } from './diagnostic.js';
import type { GitHubPRState, GitHubIssueState, GitHubStateChange } from './github.js';
import type { AttemptState, ContributionAttempt, IssueCheckError } from './oss-attempts.js';
import type { Playbook, PlaybookScope, LaunchDependency } from './playbook.js';
import type { ProjectSummary } from './project-summary.js';
import type { ProjectConfig } from './project-config.js';
import type { QuickAction } from './quick-action.js';
import type { PermissionRequestBinding } from './permission-request-binding.js';
import type { QuotaStatus } from './quota.js';
import type { ScheduleResponse, ScheduleStatusSnapshot } from './schedule.js';
import type { CollaborationCapabilities } from './speech.js';
import type { CoordinatorSnapshotState } from './coordinator.js';
import type { TaskCompletionFeedback, TaskPriorityUpdate } from './task.js';
import type { TelemetryEvent } from './telemetry.js';
import type {
  WorkspaceView,
  CleanupResultSummary,
  CleanupCandidateDetail,
  CleanupDiagnosticLaunch,
} from './workspace.js';

// Re-export store types through the shared contract layer so the frontend
// (and any other consumer that only talks to the wire) never has to import
// from src/core/* directly. See boundary-critic review of PR #384.
export type { AttemptState, ContributionAttempt, IssueCheckError };
export type { TaskCompletionFeedback };

/**
 * Observed presence of a host capability (a {@link LaunchDependency}) on the
 * Kookr server host. `available` — the dependency's binary spawned and ran;
 * `absent` — it is not on the server `PATH`. An *unknown* result (probe
 * timeout/error) is encoded as the dependency key being omitted from the
 * `capabilities` map, never as a third member.
 * See `docs/rfc/rfc-capability-gated-playbook-params.md`.
 */
export type HostCapability = 'available' | 'absent';

/** Per-project outcome of a cross-project worktree sweep. */
export type CrossProjectSweepProjectResult =
  | { kind: 'ok'; projectId: string; summaries: CleanupResultSummary[]; elapsedMs: number }
  | { kind: 'skipped'; projectId: string; reason: 'repo_path_unresolved' }
  | { kind: 'failed'; projectId: string; code: 'timeout' | 'error'; message: string; elapsedMs: number };

/**
 * Wire-format snapshot of OSS contribution attempts, broadcast on the
 * `ossAttempts` WS message and returned by `GET /api/oss-attempts`.
 *
 * Decouples the dashboard from the store's on-disk schema so that storage
 * tweaks (e.g. an internal `schemaVersion` bump, cached-field renames)
 * don't force a frontend protocol change. Produced by the server's
 * `toOssAttemptsSnapshot(store)` mapper in `src/server/oss-attempts-snapshot.ts`.
 */
export interface OssAttemptsSnapshot {
  attempts: ContributionAttempt[];
  /** External active repos from ~/.kookr/oss-repos.json; refreshed without gh calls. */
  registryActiveRepos: string[];
  lastRefreshAt: string | null;
  lastRefreshIssueCheckErrors: IssueCheckError[];
}

export type ResourceUnavailableReason =
  | 'cpu_warming_up'
  | 'cpu_unavailable'
  | 'cpu_delta_invalid'
  | 'memory_unavailable'
  | 'event_loop_unavailable'
  | 'sampler_error';

export interface SystemResourceStatus {
  source: { kind: 'server-host' };
  sampledAt: string;
  sampleGapMs: number | null;
  timerDriftMs: number | null;
  host: {
    cpuUsagePercent: number | null;
    memoryUsedPercent: number | null;
    memoryFreeBytes: number | null;
    memoryTotalBytes: number | null;
  };
  server: {
    eventLoopDelayP95Ms: number | null;
    processRssBytes: number | null;
    processHeapUsedBytes: number | null;
    processHeapTotalBytes: number | null;
  };
  unavailable: ResourceUnavailableReason[];
}

export type SnapshotMessage = {
  type: 'snapshot';
  agents: AgentState[];
  serverCwd: string;
  /**
   * Remote-session control-plane revision. Omitted for local-only snapshots;
   * populated only by the opt-in remote node path.
   */
  serverRevision?: number;
  build?: BuildInfo;
  serverStartedAt?: string;
  /** @deprecated Phase 6 keeps this legacy field while clients migrate to speechCapabilities. */
  sttEnabled?: boolean;
  /** @deprecated Phase 6 keeps this legacy field while clients migrate to speechCapabilities. */
  sttUrl?: string;
  /** @deprecated Existing TTS URL field is additive only; prefer speechCapabilities. */
  ttsEnabled?: boolean;
  /** @deprecated Existing TTS URL field is additive only; prefer speechCapabilities. */
  ttsUrl?: string;
  /** Additive Phase 6 speech/device capability descriptors. */
  speechCapabilities?: CollaborationCapabilities;
  totalSpendUsd?: number;
  achievements?: Record<string, string>;
  /**
   * Counter snapshot for tier achievements (Loop Buster, Permission Whisperer,
   * forty-two). Phase 2 frontend renders progress bars from these. Server-only
   * counters (e.g. stuck_together_runs) are stripped before broadcast.
   */
  achievementCounters?: {
    repeated_error_resolutions: number;
    permission_blocked_resolutions: number;
    merge_conflict_resolutions: number;
    api_error_resolutions: number;
    needs_input_resolutions: number;
    session_start_total: number;
  };
  /** Streak counter for Iron Streak (consecutive days with a user-resolved anomaly). */
  achievementStreak?: { lastActiveDate: string | null; currentStreak: number };
  availableAgentTypes?: AvailableAgentType[];
  /** Configured default agent; may be the `round-robin` selection. */
  defaultAgentType?: AgentSelection;
  /** Server capability: contribution workspace is available. */
  workspaceEnabled?: boolean;
  /** True if a cross-project sweep is currently in progress on this server. */
  sweepRunning?: boolean;
  /**
   * Configured concurrency cap (settings.maxActiveTasks). When the count of
   * inProgress tasks reaches this number, new launches are queued as pending.
   * Omitted by snapshots produced where the getter isn't wired; the frontend
   * preserves the last-known value rather than dropping the indicator.
   */
  maxActiveTasks?: number;
  coordinator?: CoordinatorSnapshotState;
};

type LaunchPlaybookBaseMessage = {
  type: 'launchPlaybook';
  playbookPath: string;
  parameterValues: Record<string, string>;
  agentType?: AgentSelection;
  scope?: PlaybookScope;
};

type LaunchPlaybookLegacyMessage = LaunchPlaybookBaseMessage & {
  /** Legacy catalog+target cwd. Prefer playbookSourceCwd/taskTargetCwd for new clients. */
  cwd: string;
  playbookSourceCwd?: never;
  taskTargetCwd?: never;
  projectId?: string;
};

type LaunchPlaybookSplitMessage = LaunchPlaybookBaseMessage & {
  cwd?: string;
  playbookSourceCwd: string;
  taskTargetCwd: string;
  projectId?: string;
};

export type LaunchPlaybookClientMessage = LaunchPlaybookLegacyMessage | LaunchPlaybookSplitMessage;

export type ServerMessage =
  | SnapshotMessage
  | { type: 'update'; agentId: string; state: AgentState }
  | {
      type: 'alert';
      agentId: string;
      summary: string;
      details: string;
      severity: AnomalySeverity;
    }
  | {
      type: 'githubUpdate';
      taskId: string;
      prs: GitHubPRState[];
      issues: GitHubIssueState[];
      changes: GitHubStateChange[];
    }
  | {
      type: 'playbooks';
      cwd: string;
      playbooks: Playbook[];
      /**
       * Host-capability state for dependencies that some discovered playbook
       * gates a parameter on. Omitted entirely when no gated parameter exists;
       * a dependency key is omitted when its probe could not determine presence
       * (fail-open). See `docs/rfc/rfc-capability-gated-playbook-params.md`.
       */
      capabilities?: Partial<Record<LaunchDependency, HostCapability>>;
    }
  | { type: 'suggestion'; agentId: string; suggestionId?: string; suggestions: string[]; quickActions: QuickAction[] }
  | { type: 'projectSummaries'; projects: ProjectSummary[] }
  | { type: 'coordinator.snapshot'; coordinator: CoordinatorSnapshotState }
  | { type: 'contributionWarning'; project: string; message: string; severity: 'approaching' | 'exceeded' }
  | { type: 'achievement:unlocked'; id: string; name: string; emoji: string; description: string; unlockedAt: string }
  | { type: 'achievement:reset:ack'; success: boolean; error?: string }
  | { type: 'quotaStatus'; quota: QuotaStatus }
  | { type: 'resourceStatus'; status: SystemResourceStatus }
  | { type: 'circuitBreakerStatus'; breakers: CircuitBreakerSnapshot[] }
  | { type: 'schedules'; schedules: ScheduleResponse[]; revision: number; status: ScheduleStatusSnapshot }
  | { type: 'scheduleFired'; scheduleId: string; taskId: string }
  | {
      type: 'workspaceView';
      view: WorkspaceView;
      error?: string;
      cleanupResult?: CleanupResultSummary;
      cleanupResults?: CleanupResultSummary[];
      diagnosticLaunch?: CleanupDiagnosticLaunch;
    }
  | { type: 'workspaceCleanupDetail'; worktreePath: string; detail?: CleanupCandidateDetail; error?: string }
  | {
      type: 'workspaceSweepComplete';
      runId: string;
      startedAt: string;
      finishedAt: string;
      projects: Array<CrossProjectSweepProjectResult>;
    }
  | { type: 'workspaceSweepBusy'; holderPid: number; heldSince: string }
  | { type: 'diagnosticReport'; report: DiagnosticReport }
  | {
      type: 'ossAttempts';
      store: OssAttemptsSnapshot;
      refreshStatus?: {
        inProgress: boolean;
        lastError?: string | null;
        partial?: boolean;
        truncated?: string[];
      };
    };

export type ClientMessage =
  | { type: 'respond'; agentId: string; input: string }
  | { type: 'respondAll'; agentIds: string[]; input: string }
  | { type: 'directReply'; agentId: string; input: string }
  | { type: 'navigate'; agentId: string }
  | { type: 'getNext' }
  | { type: 'skip'; agentId: string }
  | { type: 'skipAll'; agentIds: string[] }
  | { type: 'snooze'; agentId: string; taskId?: string; durationMs: number; reason?: string; resumeMonitoring?: boolean }
  | { type: 'cancelSnooze'; agentId: string; taskId?: string }
  | { type: 'launch'; prompt: string; cwd: string; criteria?: string; agentType?: AgentSelection; dependencies?: LaunchDependency[] }
  | { type: 'completeTask'; taskId: string; feedback?: TaskCompletionFeedback }
  | { type: 'setTaskFeedback'; taskId: string; feedback: TaskCompletionFeedback }
  | { type: 'requestTaskReflect'; taskId: string; direction: 'up' | 'down' }
  | { type: 'relaunch'; taskId: string; prompt: string; agentType?: AgentSelection; dependencies?: LaunchDependency[] }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'reopenTask'; taskId: string }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'renameTask'; taskId: string; name: string }
  | { type: 'setTaskPriority'; taskId: string; priority: TaskPriorityUpdate }
  | { type: 'stop'; agentId: string }
  | { type: 'reflect' }
  | { type: 'listPlaybooks'; cwd: string }
  | LaunchPlaybookClientMessage
  | { type: 'telemetry'; events: TelemetryEvent[] }
  | { type: 'setProjectConfig'; project: string; config: Partial<ProjectConfig> }
  | { type: 'clearCompleted'; includeTerminated?: boolean }
  | { type: 'ackTerminatedTask'; taskId: string }
  | { type: 'achievement:reset' }
  | { type: 'achievement:setEnabled'; enabled: boolean }
  | { type: 'permissionChoice'; agentId: string; keystroke: string; permissionRequest: PermissionRequestBinding }
  | { type: 'rearmCircuitBreaker'; name: string }
  | {
      type: 'findingFeedback';
      agentId: string;
      anomalyType: AnomalyType;
      explanation: string;
      verdict: 'false_positive';
      userReason?: string;
    }
  | {
      type: 'missedFinding';
      agentId: string;
      userReason: string;
      suspectedType?: AnomalyType;
    }
  | { type: 'workspace:getView'; projectId: string }
  | { type: 'workspace:getCleanupDetail'; projectId: string; worktreePath: string }
  | {
      type: 'workspace:cleanupCandidate';
      projectId: string;
      worktreePath: string;
      branch?: string;
      repoPath?: string;
      deleteBranch?: boolean;
      riskAccepted?: boolean;
      discardDirtyState?: boolean;
      reviewFingerprint?: string;
    }
  | { type: 'workspace:bulkSafeCleanup'; projectId: string }
  | { type: 'workspace:runCleanupDiagnostic'; projectId: string; worktreePath: string; reviewFingerprint: string }
  | { type: 'workspace:sweep' };
