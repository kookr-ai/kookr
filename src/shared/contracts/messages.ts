import type { AnomalySeverity, AnomalyType } from '../../core/types.js';
import type { AgentState } from '../../core/monitor.js';
import type { GitHubPRState, GitHubIssueState, GitHubStateChange } from '../../core/github-types.js';
import type { BuildInfo } from '../../core/build-info.js';
import type { Playbook } from '../../core/playbook.js';
import type { QuickAction } from '../../core/response-assist.js';
import type { TelemetryEvent } from '../../core/telemetry.js';
import type { ProjectSummary } from '../../core/project-summary.js';
import type { ProjectConfig } from '../../core/project-config-store.js';
import type { AutonomyLevel, TaskCompletionFeedback } from '../../core/tasks.js';
import type { AgentType, AvailableAgentType } from '../../core/agent-types.js';
import type { QuotaStatus } from '../../core/quota-types.js';
import type { CircuitBreakerSnapshot } from '../../core/circuit-breaker.js';
import type { ScheduleResponse, ScheduleStatusSnapshot } from '../../core/schedule.js';
import type { DiagnosticReport } from '../../core/self-diagnostic.js';
import type {
  WorkspaceView,
  CleanupResultSummary,
  CleanupCandidateDetail,
  CleanupDiagnosticLaunch,
} from '../../core/workspace-types.js';
import type { AttemptState, ContributionAttempt, IssueCheckError } from '../../core/oss-attempt-store.js';

// Re-export store types through the shared contract layer so the frontend
// (and any other consumer that only talks to the wire) never has to import
// from src/core/* directly. See boundary-critic review of PR #384.
export type { AttemptState, ContributionAttempt, IssueCheckError };
export type { TaskCompletionFeedback };

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

export type SnapshotMessage = {
  type: 'snapshot';
  agents: AgentState[];
  serverCwd: string;
  build?: BuildInfo;
  serverStartedAt?: string;
  sttEnabled?: boolean;
  sttUrl?: string;
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
  defaultAgentType?: AgentType;
  /** Server capability: contribution workspace is available. */
  workspaceEnabled?: boolean;
  /** True if a cross-project sweep is currently in progress on this server. */
  sweepRunning?: boolean;
};

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
  | { type: 'playbooks'; cwd: string; playbooks: Playbook[] }
  | { type: 'suggestion'; agentId: string; suggestionId?: string; suggestions: string[]; quickActions: QuickAction[] }
  | { type: 'projectSummaries'; projects: ProjectSummary[] }
  | { type: 'contributionWarning'; project: string; message: string; severity: 'approaching' | 'exceeded' }
  | { type: 'achievement:unlocked'; id: string; name: string; emoji: string; description: string; unlockedAt: string }
  | { type: 'achievement:reset:ack'; success: boolean; error?: string }
  | { type: 'quotaStatus'; quota: QuotaStatus }
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
  | { type: 'workspaceStartWorkAck'; taskId: string; queued: boolean; duplicate?: boolean; error?: string }
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
  | { type: 'snooze'; agentId: string; durationMs: number; reason?: string; resumeMonitoring?: boolean }
  | { type: 'cancelSnooze'; agentId: string }
  | { type: 'launch'; prompt: string; cwd: string; criteria?: string; autonomy?: AutonomyLevel; agentType?: AgentType }
  | { type: 'completeTask'; taskId: string; feedback?: TaskCompletionFeedback }
  | { type: 'setTaskFeedback'; taskId: string; feedback: TaskCompletionFeedback }
  | { type: 'requestTaskReflect'; taskId: string; direction: 'up' | 'down' }
  | { type: 'relaunch'; taskId: string; prompt: string; agentType?: AgentType }
  | { type: 'cancelTask'; taskId: string }
  | { type: 'reopenTask'; taskId: string }
  | { type: 'deleteTask'; taskId: string }
  | { type: 'renameTask'; taskId: string; name: string }
  | { type: 'stop'; agentId: string }
  | { type: 'reflect' }
  | { type: 'listPlaybooks'; cwd: string }
  | { type: 'launchPlaybook'; playbookPath: string; cwd: string; parameterValues: Record<string, string>; autonomy?: AutonomyLevel; agentType?: AgentType }
  | { type: 'telemetry'; events: TelemetryEvent[] }
  | { type: 'setProjectConfig'; project: string; config: Partial<ProjectConfig> }
  | { type: 'clearCompleted'; includeTerminated?: boolean }
  | { type: 'ackTerminatedTask'; taskId: string }
  | { type: 'achievement:reset' }
  | { type: 'achievement:setEnabled'; enabled: boolean }
  | { type: 'setAutonomy'; taskId: string; level: AutonomyLevel }
  | { type: 'cancelAutoProceed'; agentId: string }
  | { type: 'permissionChoice'; agentId: string; keystroke: string }
  | { type: 'rearmCircuitBreaker'; name: string }
  | { type: 'findingFeedback'; agentId: string; anomalyType: AnomalyType; explanation: string; verdict: 'false_positive' }
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
  | { type: 'workspace:startWork'; projectId: string; cwd: string; prompt: string; issueRef?: string; playbookId?: string }
  | { type: 'workspace:sweep' };
