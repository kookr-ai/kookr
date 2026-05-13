// Shared protocol types — the contract between frontend and server.
// Both sides import from here; neither imports directly from the other.

export type { AnomalySeverity, AnomalyType, AgentEvent, AgentActivityMeta, TokenUsage } from '../core/types.js';
export type { ActivityItem, ActivityDisclosure, ToolGroup, UserMessage, AgentMessage, SystemNotice, ToolGroupEntry, ToolCategory } from '../core/activity-summary.js';
export { summarizeActivity, compactToolSummary, categorizeTool, buildActivityDisclosure } from '../core/activity-summary.js';
export type { AgentState } from '../core/monitor.js';
export type { CompletionDigest } from '../core/completion-digest.js';
export type {
  GitHubPRState,
  GitHubIssueState,
  GitHubStateChange,
  GitHubReviewThread,
  GitHubCheck,
} from '../core/github-types.js';
export type { BuildInfo } from '../core/build-info.js';
export type { Playbook } from '../core/playbook.js';
export type { QuickAction } from '../core/response-assist.js';
export type { TelemetryEvent, TelemetryEventType } from '../core/telemetry.js';
export type { ProjectSummary } from '../core/project-summary.js';
export type { ProjectConfig } from '../core/project-config-store.js';
export type { AchievementDefinition } from '../core/achievement-catalog.js';
export type { AutonomyLevel } from '../core/tasks.js';
export type { AgentType, AvailableAgentType } from '../core/agent-types.js';
export { AVAILABLE_AGENT_TYPES } from '../core/agent-types.js';
export type { QuotaStatus, QuotaWindow } from '../core/quota-types.js';
export type { CircuitBreakerSnapshot } from '../core/circuit-breaker.js';
export type { ScheduleResponse, ScheduleListResponse, ScheduleStatusSnapshot } from '../core/schedule.js';
export type {
  CleanupCandidateAssessment,
  CleanupCandidateDetail,
  CleanupClassification,
  CleanupDiagnosticLaunch,
  CleanupResultSummary,
  WorkspaceAttemptRecord,
  WorkspaceView,
  WorktreeLease,
  RepoPolicy,
  StartWorkHandoff,
} from '../core/workspace-types.js';
export type { ClientMessage, ServerMessage, SnapshotMessage } from './contracts/messages.js';
export type {
  RalphLoopStatus,
  RalphLoopState,
  RalphLoopReadModel,
  RalphStallConfig,
  BurnedOutTarget,
} from './contracts/ralph.js';
export type {
  RalphIterationExitReason,
  RalphIterationDiffStats,
  RalphIterationVerdict,
  RalphIterationRecord,
  RalphIterationLogSummary,
  RalphIterationLogReadModel,
} from './contracts/ralph-iteration-log.js';
export type {
  CostAgent,
  CostDataQuality,
  TimeWindow,
  AggregateMetrics,
  PerPlaybookRow,
  PerTaskRow,
  CostComparisonNote,
  CostComparisonResponse,
} from './contracts/cost-comparison.js';
