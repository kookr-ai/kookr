import type {
  AgentState,
  AnomalySeverity,
  AvailableAgentType,
  BuildInfo,
  CircuitBreakerSnapshot,
  GitHubIssueState,
  GitHubPRState,
  GitHubStateChange,
  Playbook,
  ProjectSummary,
  QuickAction,
  QuotaStatus,
  ScheduleListResponse,
  ScheduleResponse,
  ScheduleStatusSnapshot,
  AgentType,
  AgentSelection,
  CleanupCandidateDetail,
  CleanupDiagnosticLaunch,
  WorkspaceView,
  CleanupResultSummary,
  SystemResourceStatus,
  CollaborationCapabilities,
  CoordinatorSnapshotState,
  DrainStatusSnapshot,
  SafeModeStatusSnapshot,
  LaunchDependency,
  SkillDiscoveryStateSnapshot,
  ServerMessage,
  SweepReport,
  WorkspaceBulkRemoveProgressMessage,
  WorkspaceSweepProgressMessage,
  WorkspaceSweepProgressSnapshot,
  TaskRelation,
} from '../../shared/protocol.js';
import type {
  ProjectSidebarCatalogEntry,
  ProjectSidebarPrefs,
  ProjectSidebarRow,
} from './project-sidebar-prefs.js';
import type {
  ContributionAttempt,
  IssueCheckError,
  OssAttemptsSnapshot,
  HostCapability,
} from '../../shared/contracts/messages.js';
import type { WorktreeCleanupVerdict } from '../../shared/contracts/worktree-cleanup-verdict.js';

export type AlertSeverity = 'error' | 'info';

export interface Alert {
  agentId: string;
  summary: string;
  details?: string;
  severity: AlertSeverity;
  timestamp: Date;
}

export const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

export interface RelaunchTask {
  prompt: string;
  cwd: string;
  criteria?: string;
  agentType?: AgentType;
  playbookId?: string;
  playbookParameterValues?: Record<string, string>;
}

export interface SentOverlay {
  agentName: string;
}

export interface ResponseSuggestion {
  agentId: string;
  suggestions: string[];
  quickActions: QuickAction[];
}

export interface TaskGitHub {
  taskId: string;
  prs: GitHubPRState[];
  issues: GitHubIssueState[];
  changes: GitHubStateChange[];
}

export type LeftPane = 'activity' | 'github';
export type NarrowTab = 'activity' | 'terminal' | 'github';
export type FocusZone = 'terminal' | 'response-input' | 'none';

export interface AchievementToast {
  id: string;
  name: string;
  emoji: string;
  description: string;
  unlockedAt: string;
  timestamp: number;
}

export interface SweepProgressState extends WorkspaceSweepProgressSnapshot {
  projectStatuses: Record<string, WorkspaceSweepProgressMessage['status']>;
}

/** Live cursor for a Probably-safe bulk reclaim (RFC PR 3). */
export interface BulkRemoveProgressState {
  runId: string;
  index: number;
  total: number;
  projectId: string;
  worktreePath: string;
  status: WorkspaceBulkRemoveProgressMessage['status'];
  /** Accumulated per-row outcome counts derived client-side. */
  done: number;
  skipped: number;
}

export interface TransportSessionSlice {
  agents: AgentState[];
  agentsHydrated: boolean;
  connected: boolean;
  /**
   * True while a production redeploy is in flight (dashboard Deploy button or
   * `/api/deploy/status` reported `deploying`). Sticky across the intentional
   * WS blackout (sessionStorage deploy-window, #1982) so ConnectionBanner can
   * show redeploy copy instead of an incident-style reconnect warning. Cleared
   * when a new buildInfo commit arrives after reconnect, on deploy-window TTL
   * expiry, or when deploy fails before the blackout.
   */
  deploying: boolean;
  terminalOutput: Record<string, string>;
  serverCwd: string;
  availableAgentTypes: AvailableAgentType[];
  defaultAgentType: AgentSelection;
  buildInfo: BuildInfo | null;
  serverStartedAt: string | null;
  playbooks: Playbook[];
  playbooksLoading: boolean;
  playbooksLastFetchedAt: number;
  playbooksLastFetchedCwd: string;
  /**
   * Host-capability state from the most recent `playbooks` message. Empty when
   * no discovered playbook gates a parameter, or when probes returned unknown.
   * Drives capability-gated parameter rendering in the launch form.
   */
  hostCapabilities: Partial<Record<LaunchDependency, HostCapability>>;
  sttUrl: string;
  /** Pocket TTS HTTP base URL when configured server-side. Empty string when unset. Gates the speak-finding feature in the UI. */
  ttsUrl: string;
  speechCapabilities: CollaborationCapabilities | null;
  activeSTTInputId: string | null;
  totalSpendUsd: number;
  /**
   * Server-configured concurrency cap (settings.maxActiveTasks). 0 = unknown
   * (no snapshot has carried it yet). Sticky: once set, snapshots that omit
   * the field don't reset it, since most broadcast sites don't thread the
   * getter through.
   */
  maxActiveTasks: number;
  /** Current server process is launching agents with permission prompts bypassed. */
  bypassAllPermissions: boolean;
  /** Current operator drain mode. While draining, new launches and schedule fires are paused. */
  drainStatus: DrainStatusSnapshot;
  /**
   * Automation kill-switch / SAFE MODE (issue #1710). Sticky: high-frequency
   * snapshots that omit the field leave the last-known value in place.
   */
  safeMode: SafeModeStatusSnapshot;
  coordinator: CoordinatorSnapshotState | null;
  dashboardSelection: {
    selectedTaskId: string | null;
    selectedSessionId: string | null;
    selectionVersion: number;
  };
  /**
   * Active typed task-relation graph (#599) projected onto the most recent
   * snapshot (#601). Sticky: snapshots that omit the field don't reset the
   * cache, because high-frequency event-pipeline broadcasts don't carry it.
   * Snapshots that ship an empty array WILL clear the cache — that's how the
   * client learns about deletions, which hard-drop relations without a
   * lifecycle transition.
   */
  taskRelations: TaskRelation[];
  /**
   * Dashboard task-list filter rooted in a relation graph (#601 UX). `chain`
   * scopes the task list to `computeChainMembership(rootTaskId)`; `children`
   * scopes it to `computeDescendants(rootTaskId)`. `off` disables the filter.
   * The hide-completed-descendants checkbox is *local* to the related-tasks
   * section and lives in component state, not here.
   */
  relationFilter: { mode: 'off' | 'chain' | 'children'; rootTaskId: string | null };
  setRelationFilter: (filter: { mode: 'off' | 'chain' | 'children'; rootTaskId: string | null }) => void;

  handleSnapshot: (
    agents: AgentState[],
    serverCwd?: string,
    build?: BuildInfo,
    serverStartedAt?: string,
    sttEnabled?: boolean,
    sttUrl?: string,
    totalSpendUsd?: number,
    achievements?: Record<string, string>,
    availableAgentTypes?: AvailableAgentType[],
    defaultAgentType?: AgentSelection,
    workspaceEnabled?: boolean,
    sweepRunning?: boolean,
    maxActiveTasks?: number,
    speechCapabilities?: CollaborationCapabilities,
    coordinator?: CoordinatorSnapshotState,
    ttsUrl?: string,
    bypassAllPermissions?: boolean,
    drainStatus?: DrainStatusSnapshot,
    sweepProgress?: WorkspaceSweepProgressSnapshot,
  ) => void;
  handleUpdate: (agentId: string, state: AgentState) => void;
  /**
   * Apply a Stage-2 coalesced delta (issue #1754): upsert/remove agents by
   * `"agentId:taskId"` key, sticky-replace `taskRelations` when present, and
   * shallow-merge whole-world aggregates.
   */
  handleDelta: (delta: {
    agents?: { upserts: AgentState[]; removed: string[] };
    taskRelations?: TaskRelation[];
    aggregates?: {
      totalSpendUsd?: number;
      maxActiveTasks?: number;
      drainStatus?: DrainStatusSnapshot;
      coordinator?: CoordinatorSnapshotState | null;
      achievements?: Record<string, string>;
      achievementCounters?: AchievementCountersState;
      achievementStreak?: { lastActiveDate: string | null; currentStreak: number };
      bypassAllPermissions?: boolean;
    };
  }) => void;
  handlePlaybooks: (
    playbooks: Playbook[],
    cwd: string,
    capabilities?: Partial<Record<LaunchDependency, HostCapability>>,
  ) => void;
  setConnected: (connected: boolean) => void;
  /**
   * Mark a production redeploy as in-flight. When `preDeployCommit` is provided
   * it is persisted with the sticky intent so completion can be detected after
   * a page remount (compare against the next non-matching buildInfo).
   */
  setDeploying: (deploying: boolean, preDeployCommit?: string | null) => void;
  handleDashboardSelection: (selection: {
    selectedTaskId: string | null;
    selectedSessionId: string | null;
    selectionVersion: number;
  }) => void;
  setTerminalOutput: (agentId: string, output: string) => void;
  setPlaybooksLoading: (loading: boolean) => void;
  setActiveSTTInput: (id: string | null) => void;
}

export interface TriageNavigationSlice {
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  alerts: Alert[];
  relaunchTask: RelaunchTask | null;
  sentOverlay: SentOverlay | null;
  githubState: Record<string, TaskGitHub>;
  leftPane: LeftPane;
  narrowTab: NarrowTab;
  detailPaneMode: DetailPaneMode;
  terminalFocusMode: boolean;
  suggestions: Record<string, ResponseSuggestion>;
  focusZone: FocusZone;
  respondAllAgentIds: string[] | null;
  shortcutsArmed: boolean;

  handleAlert: (agentId: string, summary: string, severity?: AlertSeverity, details?: string) => void;
  handleSuggestion: (agentId: string, suggestions: string[], quickActions: QuickAction[]) => void;
  clearSuggestion: (agentId: string) => void;
  handleGitHubUpdate: (taskId: string, prs: GitHubPRState[], issues: GitHubIssueState[], changes: GitHubStateChange[]) => void;
  selectAgent: (agentId: string | null, taskId?: string | null) => void;
  nextBottleneck: () => void;
  nextTask: () => void;
  selectNextTaskAfterCompletion: (completedAgentId: string, completedTaskId: string | null) => void;
  advanceEmptyEnter: () => void;
  previousTask: () => void;
  snoozeAgent: (agentId: string, durationMs: number) => void;
  dismissAlert: (index: number) => void;
  setRelaunchTask: (task: RelaunchTask) => void;
  clearRelaunchTask: () => void;
  showSentOverlay: (agentName: string) => void;
  clearSentOverlay: () => void;
  setLeftPane: (pane: LeftPane) => void;
  setNarrowTab: (tab: NarrowTab) => void;
  setDetailPaneMode: (mode: DetailPaneMode) => void;
  setTerminalFocusMode: (enabled: boolean) => void;
  toggleTerminalFocusMode: () => void;
  setFocusZone: (zone: FocusZone) => void;
  setRespondAllAgentIds: (agentIds: string[] | null) => void;
  armShortcuts: () => void;
}

export type DetailPaneMode = 'split' | 'left' | 'right';

export type DiscoveryStatus = SkillDiscoveryStateSnapshot;

export interface ProjectSidebarSlice {
  selectedProject: string | null;
  projectSidebarVisible: boolean;
  projectSummaries: ProjectSummary[];
  visibleProjectSummaries: ProjectSummary[];
  projectSidebarRows: ProjectSidebarRow[];
  projectSidebarPrefs: ProjectSidebarPrefs;
  projectSidebarCatalog: Record<string, ProjectSidebarCatalogEntry>;
  projectSidebarError: string | null;
  projectSidebarServerHydrated: boolean;
  projectSummariesHydrated: boolean;
  discoveryStatus: DiscoveryStatus | null;
  discoveryBusy: boolean;
  trackOssError: string | null;
  trackOssBusy: boolean;
  untrackOssError: string | null;
  untrackOssBusy: boolean;

  selectProject: (project: string | null, options?: { source?: 'manual' | 'auto-advance' }) => void;
  toggleProjectSidebar: () => void;
  hydrateProjectSidebarFromServer: () => Promise<void>;
  handleProjectSummaries: (projects: ProjectSummary[]) => void;
  pinProjectToTop: (project: string) => void;
  unpinSidebarProject: (project: string) => void;
  hideSidebarProject: (project: string) => void;
  showSidebarProject: (project: string) => void;
  moveSidebarProject: (project: string, direction: 'up' | 'down') => void;
  reorderSidebarProject: (project: string, targetPinned: boolean, targetProject: string | null, position: 'before' | 'after') => void;
  resetProjectSidebar: () => void;
  clearProjectSidebarError: () => void;
  fetchDiscoveryStatus: () => Promise<void>;
  rescanSkills: () => Promise<void>;
  trackOssProject: (repo: string) => Promise<{ ok: boolean; error?: string }>;
  clearTrackOssError: () => void;
  untrackOssProject: (repo: string) => Promise<{ ok: boolean; error?: string }>;
  clearUntrackOssError: () => void;
}

export interface DiagnosticFinding {
  checkId: string;
  title: string;
  description: string;
  severity: 'warning' | 'critical';
  observed: number;
  threshold: number;
  scope: string;
}

export interface DiagnosticReport {
  timestamp: number;
  findings: DiagnosticFinding[];
}

export interface AchievementCountersState {
  repeated_error_resolutions: number;
  permission_blocked_resolutions: number;
  merge_conflict_resolutions: number;
  api_error_resolutions: number;
  needs_input_resolutions: number;
  session_start_total: number;
}

export interface AchievementStreakState {
  lastActiveDate: string | null;
  currentStreak: number;
}

export interface AchievementsSystemSlice {
  achievements: Record<string, string>;
  achievementCounters: AchievementCountersState;
  achievementStreak: AchievementStreakState;
  achievementToasts: AchievementToast[];
  achievementsEnabled: boolean;
  showAchievements: boolean;
  quotaStatus: QuotaStatus | null;
  circuitBreakers: CircuitBreakerSnapshot[];
  diagnosticReport: DiagnosticReport | null;
  schedules: ScheduleResponse[];
  scheduleRevision: number;
  scheduleStatus: ScheduleStatusSnapshot | null;

  handleAchievementUnlocked: (toast: AchievementToast) => void;
  dismissAchievementToast: (id: string) => void;
  setAchievementsEnabled: (enabled: boolean) => void;
  toggleAchievementsPanel: () => void;
  handleQuotaStatus: (quota: QuotaStatus) => void;
  handleCircuitBreakerStatus: (breakers: CircuitBreakerSnapshot[]) => void;
  handleDiagnosticReport: (report: DiagnosticReport) => void;
  handleSchedules: (payload: ScheduleListResponse) => void;
}

export interface WorkspaceSlice {
  workspaceEnabled: boolean;
  workspaceView: WorkspaceView | null;
  workspaceLoading: boolean;
  workspaceError: string | null;
  workspaceCleanupDetail: CleanupCandidateDetail | null;
  workspaceCleanupDetailLoading: boolean;
  workspaceCleanupDetailError: string | null;
  /** True while a cross-project sweep is running on the server. */
  sweepRunning: boolean;
  /** Live progress cursor for the current cross-project sweep. */
  sweepProgress: SweepProgressState | null;
  /** Disk-aware diagnosis report from the last completed sweep (PR 2). */
  sweepReport: SweepReport | null;
  /** Whether the Sweep Report panel is open (re-openable for the run's lifetime). */
  sweepReportOpen: boolean;
  /**
   * runId of the last completed sweep on the server, from the reconnect
   * snapshot. Lets a freshly-loaded client offer to reconstruct the report
   * from the ledger even when the live `sweepReport` was lost.
   */
  lastSweepRunId: string | null;
  /** True while a Probably-safe bulk reclaim is running (RFC PR 3). */
  bulkRemoveRunning: boolean;
  /** Live cursor for the current bulk reclaim. */
  bulkRemoveProgress: BulkRemoveProgressState | null;

  handleWorkspaceView: (
    view: WorkspaceView,
    error?: string,
    cleanupResult?: CleanupResultSummary,
    cleanupResults?: CleanupResultSummary[],
    diagnosticLaunch?: CleanupDiagnosticLaunch,
  ) => void;
  handleWorkspaceCleanupDetail: (worktreePath: string, detail?: CleanupCandidateDetail, error?: string) => void;
  setWorkspaceLoading: (loading: boolean) => void;
  setWorkspaceCleanupDetailLoading: (loading: boolean) => void;
  setWorkspaceError: (error: string | null) => void;
  clearWorkspaceCleanupDetail: () => void;
  clearWorkspaceView: () => void;
  setSweepRunning: (running: boolean) => void;
  handleSweepProgress: (progress: WorkspaceSweepProgressMessage) => void;
  handleSweepComplete: (result: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    projects: Array<
      | { kind: 'ok'; projectId: string; summaries: CleanupResultSummary[]; elapsedMs: number }
      | { kind: 'skipped'; projectId: string; reason: 'repo_path_unresolved' }
      | { kind: 'skipped'; projectId: string; reason: 'workspace_unavailable'; missingDeps: string[] }
      | { kind: 'failed'; projectId: string; code: 'timeout' | 'error'; message: string; elapsedMs: number }
    >;
    report?: SweepReport;
  }) => void;
  handleSweepBusy: (payload: { holderPid: number; heldSince: string }) => void;
  /** Reconstructed-report response (reconnect-after-completion). */
  handleSweepReport: (payload: { runId: string; report?: SweepReport }) => void;
  /** Reconnect snapshot pointer to the last completed sweep. */
  setLastSweepRunId: (runId: string | null) => void;
  /** Open / close the re-openable Sweep Report panel. */
  openSweepReport: () => void;
  closeSweepReport: () => void;
  /** Optimistically mark a bulk reclaim as started when the client sends it. */
  startBulkRemove: () => void;
  /**
   * Fold a `workspaceBulkRemoveProgress` broadcast into the cursor. A `done`
   * row is dropped from the in-memory report (and its bucket recount) so the
   * Probably-safe list shrinks live; the run ends when the last row settles.
   */
  handleBulkRemoveProgress: (msg: WorkspaceBulkRemoveProgressMessage) => void;
}

export interface OssAttemptsSlice {
  ossAttempts: ContributionAttempt[];
  ossRegistryActiveRepos: string[];
  ossLastRefreshAt: string | null;
  ossShowView: boolean;
  ossRefreshLoading: boolean;
  ossRefreshError: string | null;
  ossTruncatedRepos: string[];
  /**
   * PR-granular issue-state fetch failures from the most recent refresh,
   * sourced from `store.lastRefreshIssueCheckErrors` via the snapshot.
   * Populated for every refresh path (manual button, startup refresh, future
   * timer) — not only the manual path — so the dashboard warning banner
   * closes the silent-degradation gap flagged in round-3 critic review.
   */
  ossLastRefreshIssueCheckErrors: IssueCheckError[];

  handleOssAttempts: (snapshot: OssAttemptsSnapshot) => void;
  toggleOssView: () => void;
  closeOssView: () => void;
  refreshOssAttempts: () => Promise<void>;
  fetchOssAttempts: () => Promise<void>;
}

/**
 * Slim projection of `GET /api/health.prodSmokeTick` for status-bar pills (#2037).
 * Full server shape lives on `ProdSmokeTickHealthSnapshot`; the dashboard only
 * needs the failing-streak fields for the compact pill.
 */
export interface ProdSmokeTickStatus {
  consecutiveFailures: number;
  status?: 'ok' | 'alert' | 'unknown';
  failingChecks?: string[];
  generatedAt?: string;
  firstFailedAt?: string;
}

/**
 * Slim projection of `GET /api/health.resourceWatchdog` for status-bar pills (#2037).
 */
export interface ResourceWatchdogStatus {
  enabled: boolean;
  lastDecision?: string | null;
  pressureWhileDisabled?: boolean;
  pressureWhileDisabledReason?: string | null;
}

/**
 * Slim projection of `GET /api/health.capacity` for the FAA residual status-bar
 * pill (issue #2082). Only the chronic finishedAwaitingAck count + oldest age
 * are needed for threshold + label.
 */
export interface CapacityResidualStatus {
  finishedAwaitingAck: number;
  oldestFinishedAwaitingAckAgeMs: number | null;
}

/**
 * Per-repo row from `GET /api/health.pipelineStarvation` (pipeline-starvation.v1).
 * Dashboard keeps the fields the Diagnostics card and CLI already surface.
 */
export interface PipelineStarvationRepoStatus {
  repo: string;
  consecutiveBlockedEmpty: number;
  effectiveScoutCooldownMs: number;
  lastBlockedEmptyAt?: string | null;
  lastSpawnSkipReason?: string | null;
  lastStarvationScoutTaskId?: string | null;
  lastStarvationScoutAt?: string | null;
  lastStarvationAlertAt?: string | null;
  lastBatchKickAt?: string | null;
  updatedAt?: string;
}

/** Invent-class mix from queue-feeder ledger (issue #2358). */
export interface InventPriorityClassStatus {
  product: number;
  micro: number;
  other: number;
  windowHours: number;
}

/**
 * Slim projection of `GET /api/health.pipelineStarvation` for the Diagnostics
 * panel (issue #2259). Full health block is retained so elevated rows can be
 * filtered client-side without a second request.
 */
export interface PipelineStarvationStatus {
  schemaVersion: 'pipeline-starvation.v1';
  repos: Record<string, PipelineStarvationRepoStatus>;
  inventByPriorityClass?: InventPriorityClassStatus;
}

/**
 * Per-dependency rollup from `GET /api/health.launchDependencies` for the
 * status-bar deps pill (issue #2364). Omits affectedTaskIds — tooltip only
 * needs names, counts, and categories.
 */
export interface LaunchDependencyStatusRow {
  dependency: string;
  degradedTaskCount: number;
  categories: string[];
}

/**
 * Slim projection of `GET /api/health.launchDependencies` for the status-bar
 * warn pill (issue #2364). Pill is elevated-only (`totalDegradedTasks > 0`);
 * the poll may still store a zeroed projection when the block is present.
 */
export interface LaunchDependenciesStatus {
  totalDegradedTasks: number;
  totalFindings?: number;
  dependencies: LaunchDependencyStatusRow[];
}

/** Decision-bucket counts from `GET /api/health.lessonYield` (lesson-yield.v2). */
export interface LessonYieldBucketCounts {
  wroteLesson: number;
  explicitSkip: number;
  searchOnly: number;
  noKbActivity: number;
}

/**
 * Slim projection of `GET /api/health.lessonYield` for the Diagnostics card
 * (issue #2395). Mirrors the always-on `kookr status` gauge (issue #2305) —
 * yield rate, decided/completed denominator, and decision buckets — without
 * the heavy `byCompletionPath` tree.
 */
export interface LessonYieldStatus {
  windowDays: number;
  yieldRate: number;
  decided: number;
  completedInWindow: number;
  buckets: LessonYieldBucketCounts;
}

export interface OpsHealthPayload {
  prodSmokeTick?: ProdSmokeTickStatus | null;
  resourceWatchdog?: ResourceWatchdogStatus | null;
  capacityResidual?: CapacityResidualStatus | null;
  pipelineStarvation?: PipelineStarvationStatus | null;
  launchDependencies?: LaunchDependenciesStatus | null;
  lessonYield?: LessonYieldStatus | null;
}

export interface SystemStatusSlice {
  resourceStatus: SystemResourceStatus | null;
  resourceStatusReceivedAtMs: number | null;
  /** Hourly prod smoke tick failing streak from `/api/health` (issue #2037). */
  prodSmokeTick: ProdSmokeTickStatus | null;
  /** Resource-watchdog enablement from `/api/health` (issue #2037). */
  resourceWatchdog: ResourceWatchdogStatus | null;
  /** Capacity FAA residual from `/api/health.capacity` (issue #2082). */
  capacityResidual: CapacityResidualStatus | null;
  /** Pipeline-starvation drought projection from `/api/health` (issue #2259). */
  pipelineStarvation: PipelineStarvationStatus | null;
  /** Launch-dependency degradation from `/api/health.launchDependencies` (issue #2364). */
  launchDependencies: LaunchDependenciesStatus | null;
  /** Lesson-authoring yield projection from `/api/health.lessonYield` (issue #2395). */
  lessonYield: LessonYieldStatus | null;

  handleResourceStatus: (status: SystemResourceStatus, receivedAtMs?: number) => void;
  /** Update smoke-tick / resource-watchdog / capacity residual / pipeline-starvation / launch-deps / lesson-yield projections. */
  handleOpsHealth: (payload: OpsHealthPayload) => void;
}

/**
 * Why the auto-advance subscriber's last tick reached its outcome. Surfaced
 * in the FollowPill popover so the user can answer "why isn't it switching?"
 */
export type AutoAdvanceTickReason =
  | 'no_eligible_project'
  | 'already_top'
  | 'engaged'
  | 'settling';

/** What caused an actual auto-switch to fire (logged once per switch). */
export type AutoAdvanceSwitchCause = 'activation' | 'queue_head_changed';

export interface AutoAdvanceSwitchRecord {
  from: string | null;
  to: string;
  cause: AutoAdvanceSwitchCause;
  ts: number;
}

export interface AutoAdvanceErrorRecord {
  message: string;
  firstSeenTs: number;
}

export interface AutoAdvanceSlice {
  /** Opt-in mode flag, persisted in localStorage `kookr-auto-advance-mode`. */
  autoAdvanceEnabled: boolean;
  /**
   * Provenance of the current `selectedAgentId`. `'manual'` means the user
   * selected (or any non-auto-advance code path did); `'auto-advance'` means
   * the auto-advance branch landed the user on a project without selecting
   * an agent (selectedAgentId may be null in that case). The engagement
   * guard uses this to avoid the cascade-self-disable trap.
   */
  selectedAgentSource: 'manual' | 'auto-advance';
  /** Outcome of the most recent decision-point tick (never written on early-exit). */
  lastTickReason: AutoAdvanceTickReason | null;
  /** Most recent actual switch; powers the popover "Last switch" line. */
  lastAutoSwitch: AutoAdvanceSwitchRecord | null;
  /** Persistent tick error (cleared on next successful tick). */
  autoAdvanceError: AutoAdvanceErrorRecord | null;

  /** Toggle the mode and fire activation telemetry + an immediate tick. */
  toggleAutoAdvance: () => void;
}

/**
 * Convention: every store mutation that writes `selectedAgentId` MUST also
 * write `selectedAgentSource` in the same `set()` call. Manual user actions
 * tag `'manual'`; only the auto-advance branch in `selectProject(...)` writes
 * `'auto-advance'`. Splitting the writes across two `set()` calls is a
 * subscriber-flicker bug.
 */

/**
 * Removal verdicts for the task-completion dialog's cleanup checkbox.
 *
 * Distinct from {@link WorkspaceSlice}: that one serves the Contribution
 * Workspace and classifies worktrees by its own richer rules; this one mirrors
 * what the completion cleanup will actually do. Conflating them is how the
 * dialog would end up promising an outcome the cleanup doesn't honor.
 */
export interface WorktreeCleanupSlice {
  /** Task the in-flight/current verdicts belong to. Null when no dialog is open. */
  cleanupVerdictsTaskId: string | null;
  /** Null while the first probe is in flight. Empty array = task owns no worktrees. */
  cleanupVerdicts: WorktreeCleanupVerdict[] | null;
  cleanupVerdictsError: string | null;
  /** True only for a re-check; the initial probe uses the null-verdicts state. */
  cleanupVerdictsRefreshing: boolean;

  /** Mark a probe as started. `refresh` keeps existing verdicts visible. */
  beginWorktreeCleanupInspect: (taskId: string, opts?: { refresh?: boolean }) => void;
  handleWorktreeCleanupVerdicts: (
    taskId: string,
    verdicts: WorktreeCleanupVerdict[],
    error?: string,
  ) => void;
  clearWorktreeCleanupVerdicts: () => void;
}

export type KookrStore =
  & TransportSessionSlice
  & TriageNavigationSlice
  & ProjectSidebarSlice
  & AchievementsSystemSlice
  & WorkspaceSlice
  & OssAttemptsSlice
  & SystemStatusSlice
  & AutoAdvanceSlice
  & WorktreeCleanupSlice;

export type StoreSet = (
  partial: Partial<KookrStore> | ((state: KookrStore) => Partial<KookrStore>),
) => void;

export type StoreGet = () => KookrStore;
