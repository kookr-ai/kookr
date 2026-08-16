// Shared protocol types — the contract between frontend and server.
// Both sides import from here; neither imports directly from the other.

export type { AgentState } from './contracts/agent-state.js';
export type { TaskStuckReason } from './contracts/task-stuck-reason.js';
export {
  COORDINATED_STALL_ROOT_CAUSES,
  SESSION_HEALTH_CLASSIFICATIONS,
  SESSION_HEALTH_SCHEMA_VERSION,
} from './contracts/session-health.js';
export type {
  CoordinatedStallFinding,
  SessionHealthBackend,
  SessionHealthBrowser,
  SessionHealthClassification,
  SessionHealthDiagnostics,
  SessionHealthAttachState,
  SessionHealthProgress,
  SessionHealthPtySignal,
  SessionHealthSignal,
  SessionHealthSignalState,
  SessionHealthSnapshot,
  SessionHealthTranscriptSignal,
  SessionHealthTransportState,
} from './contracts/session-health.js';
export type {
  AgentType,
  AgentSelection,
  AvailableAgentType,
  AvailableAgentSelection,
  EffortLevel,
  AgentEffortMap,
} from './contracts/agent-types.js';
export {
  AGENT_TYPES,
  AVAILABLE_AGENT_TYPES,
  ROUND_ROBIN_AGENT_TYPE,
  buildAgentSelectionOptions,
  effortLevelsForAgent,
  isAgentType,
  isValidEffortForAgent,
  isValidModelForAgent,
  modelsForAgent,
  previewRoundRobinNextLabel,
  resolveRoundRobinAgent,
} from './contracts/agent-types.js';
export type { GrokAuthStatus, GrokAuthStatusResponse } from './contracts/grok-auth-status.js';
export {
  GROK_AUTH_STATUS_PATH,
  GROK_AUTH_STATUSES,
  GROK_LOGIN_COMMAND,
  grokAuthAffectsSelection,
  parseGrokAuthStatusResponse,
  shouldDisableLaunchForGrokAuth,
  shouldShowGrokAuthBanner,
} from './contracts/grok-auth-status.js';
export type { AgentEvent } from './contracts/agent-events.js';
export type {
  AnomalySeverity,
  AnomalyType,
  FindingEvidenceAuditRecord,
  FindingEvidenceObservation,
  FindingEvidenceObservationSource,
  FindingEvidenceVerdict,
} from './contracts/anomalies.js';
export { ANOMALY_TYPES } from './contracts/anomalies.js';
export type {
  ActivityDisclosure,
  ActivityItem,
  AgentMessage,
  PasteContentKind,
  SystemNotice,
  ToolCategory,
  ToolGroup,
  ToolGroupEntry,
  UserInputDeliveryItem,
  UserMessage,
  UserPasteBurst,
} from './contracts/activity-summary.js';
export {
  buildActivityItems,
  buildActivityDisclosure,
  categorizeTool,
  compactToolSummary,
  pasteBurstLabel,
  summarizeActivity,
  toolLabel,
} from './contracts/activity-summary.js';
export type {
  UserInputDeliverySnapshot,
  UserInputDeliverySource,
  UserInputDeliveryStatus,
} from './contracts/user-input-delivery.js';
export { DELIVERY_SOURCE_LABEL } from './contracts/user-input-delivery.js';
export type { BuildInfo } from './contracts/build-info.js';
export type { CircuitBreakerSnapshot } from './contracts/circuit-breaker.js';
export type { CompletionDigest } from './contracts/completion-digest.js';
export type { LatestCompletionSignal } from './contracts/completion-signal.js';
export type { CoordinatorSnapshotState } from './contracts/coordinator.js';
export type {
  GitHubCheck,
  GitHubIssueState,
  GitHubPRMergeable,
  GitHubPRState,
  GitHubReviewThread,
  GitHubStateChange,
} from './contracts/github.js';
export type { AgentActivityMeta } from './contracts/hook-events.js';
export type { Playbook, LaunchDependency, PlaybookScope } from './contracts/playbook.js';
export type {
  EvolutionChampionRecord,
  EvolutionRunProjection,
  EvolutionTrajectoryPoint,
  EvolutionTrialOutcome,
  EvolutionTrialRecord,
} from './contracts/evolution.js';
export type { ProjectConfig } from './contracts/project-config.js';
export type {
  SkillDiscoveryProjectStatus,
  SkillDiscoveryScanStatus,
  SkillDiscoveryStateSnapshot,
} from './contracts/project-discovery.js';
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
export type { TaskCompletionFeedback, TaskLaunchPermissionPosture } from './contracts/task.js';
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
  SweepReport,
  SweepReportBucket,
  SweepReportBucketSummary,
  SweepReportNotAnalyzed,
  SweepReportRow,
  WorkspaceAttemptRecord,
  WorkspaceBulkRemoveRow,
  WorkspaceView,
  WorktreeLease,
} from './contracts/workspace.js';
export type {
  ClientMessage,
  DrainStatusSnapshot,
  SafeModeStatusSnapshot,
  ResourceUnavailableReason,
  ServerMessage,
  SnapshotMessage,
  SystemResourceStatus,
  WorkspaceBulkRemoveProgressMessage,
  WorkspaceSweepProgressMessage,
  WorkspaceSweepProgressSnapshot,
} from './contracts/messages.js';
export type {
  EmptyEnterDecision,
  EmptyEnterIntentRequest,
  EmptyEnterRejectReason,
  PromptStatus,
  TerminalInputSnapshot,
} from './contracts/terminal-input.js';
export type {
  RalphLoopStatus,
  RalphLoopState,
  RalphLoopReadModel,
  RalphStallConfig,
  BurnedOutTarget,
  RalphCostSignal,
} from './contracts/ralph.js';
export { resolveRalphCostSignal, resolveStallConfig } from './contracts/ralph.js';
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
