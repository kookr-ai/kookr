// Shared protocol types — the contract between frontend and server.
// Both sides import from here; neither imports directly from the other.

export type { AgentState } from './contracts/agent-state.js';
export type {
  AgentType,
  AgentSelection,
  AvailableAgentType,
  AvailableAgentSelection,
} from './contracts/agent-types.js';
export {
  AVAILABLE_AGENT_TYPES,
  buildAgentSelectionOptions,
} from './contracts/agent-types.js';
export type { AgentEvent } from './contracts/agent-events.js';
export type {
  AnomalySeverity,
  AnomalyType,
  FindingEvidenceAuditRecord,
  FindingEvidenceObservation,
  FindingEvidenceObservationSource,
  FindingEvidenceVerdict,
} from './contracts/anomalies.js';
export type {
  ActivityDisclosure,
  ActivityItem,
  AgentMessage,
  PasteContentKind,
  SystemNotice,
  ToolCategory,
  ToolGroup,
  ToolGroupEntry,
  UserMessage,
  UserPasteBurst,
} from './contracts/activity-summary.js';
export {
  buildActivityDisclosure,
  categorizeTool,
  compactToolSummary,
  pasteBurstLabel,
  summarizeActivity,
  toolLabel,
} from './contracts/activity-summary.js';
export type { BuildInfo } from './contracts/build-info.js';
export type { CircuitBreakerSnapshot } from './contracts/circuit-breaker.js';
export type { CompletionDigest } from './contracts/completion-digest.js';
export type { CoordinatorSnapshotState } from './contracts/coordinator.js';
export type {
  GitHubCheck,
  GitHubIssueState,
  GitHubPRState,
  GitHubReviewThread,
  GitHubStateChange,
} from './contracts/github.js';
export type { AgentActivityMeta } from './contracts/hook-events.js';
export type { Playbook, LaunchDependency } from './contracts/playbook.js';
export type { ProjectConfig } from './contracts/project-config.js';
export type { ProjectSummary, TaskSummary } from './contracts/project-summary.js';
export type { QuotaStatus, QuotaWindow } from './contracts/quota.js';
export type { QuickAction } from './contracts/quick-action.js';
export type { PermissionRequestBinding } from './contracts/permission-request-binding.js';
export type { ScheduleResponse, ScheduleListResponse, ScheduleStatusSnapshot } from './contracts/schedule.js';
export type {
  CollaborationCapabilities,
  SpeechCapability,
  STTCapability,
  TTSCapability,
} from './contracts/speech.js';
export type { TaskCompletionFeedback } from './contracts/task.js';
export type {
  TaskRelation,
  TaskRelationEvidence,
  TaskRelationLifecycle,
  TaskRelationRollup,
  TaskRelationSource,
  TaskRelationType,
} from './contracts/task-relations.js';
export {
  DETERMINISTIC_RELATION_CONFIDENCE,
  HIGH_CONFIDENCE_RELATION_THRESHOLD,
} from './contracts/task-relations.js';
export type { TurnState } from './contracts/task-status.js';
export { TELEMETRY_EVENT_TYPES } from './contracts/telemetry.js';
export type { TelemetryEvent, TelemetryEventType } from './contracts/telemetry.js';
export type { TokenUsage } from './contracts/usage.js';
export type {
  CleanupCandidateAssessment,
  CleanupCandidateDetail,
  CleanupClassification,
  CleanupDiagnosticLaunch,
  CleanupResultSummary,
  RepoPolicy,
  WorkspaceAttemptRecord,
  WorkspaceView,
  WorktreeLease,
} from './contracts/workspace.js';
export type {
  ClientMessage,
  ResourceUnavailableReason,
  ServerMessage,
  SnapshotMessage,
  SystemResourceStatus,
} from './contracts/messages.js';
export type {
  EmptyEnterDecision,
  EmptyEnterIntentRequest,
  EmptyEnterRejectReason,
  PromptStatus,
  TerminalInputSnapshot,
} from './terminal-input-contract.js';
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
