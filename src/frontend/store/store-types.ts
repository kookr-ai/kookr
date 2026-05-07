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
  CleanupCandidateDetail,
  CleanupDiagnosticLaunch,
  WorkspaceView,
  CleanupResultSummary,
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
} from '../../shared/contracts/messages.js';

export type AlertSeverity = 'error' | 'info';

export interface Alert {
  agentId: string;
  summary: string;
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

export interface TransportSessionSlice {
  agents: AgentState[];
  agentsHydrated: boolean;
  connected: boolean;
  terminalOutput: Record<string, string>;
  serverCwd: string;
  availableAgentTypes: AvailableAgentType[];
  defaultAgentType: AgentType;
  buildInfo: BuildInfo | null;
  serverStartedAt: string | null;
  playbooks: Playbook[];
  playbooksLoading: boolean;
  playbooksLastFetchedAt: number;
  playbooksLastFetchedCwd: string;
  sttUrl: string;
  activeSTTInputId: string | null;
  totalSpendUsd: number;

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
    defaultAgentType?: AgentType,
    workspaceEnabled?: boolean,
    sweepRunning?: boolean,
  ) => void;
  handleUpdate: (agentId: string, state: AgentState) => void;
  handlePlaybooks: (playbooks: Playbook[], cwd: string) => void;
  setConnected: (connected: boolean) => void;
  setTerminalOutput: (agentId: string, output: string) => void;
  setPlaybooksLoading: (loading: boolean) => void;
  setActiveSTTInput: (id: string | null) => void;
}

export interface TriageNavigationSlice {
  selectedAgentId: string | null;
  alerts: Alert[];
  relaunchTask: RelaunchTask | null;
  sentOverlay: SentOverlay | null;
  githubState: Record<string, TaskGitHub>;
  leftPane: LeftPane;
  narrowTab: NarrowTab;
  suggestions: Record<string, ResponseSuggestion>;
  focusZone: FocusZone;
  respondAllAgentIds: string[] | null;
  shortcutsArmed: boolean;

  handleAlert: (agentId: string, summary: string, severity?: AlertSeverity) => void;
  handleSuggestion: (agentId: string, suggestions: string[], quickActions: QuickAction[]) => void;
  clearSuggestion: (agentId: string) => void;
  handleGitHubUpdate: (taskId: string, prs: GitHubPRState[], issues: GitHubIssueState[], changes: GitHubStateChange[]) => void;
  selectAgent: (agentId: string | null) => void;
  nextBottleneck: () => void;
  nextTask: () => void;
  previousTask: () => void;
  snoozeAgent: (agentId: string, durationMs: number) => void;
  dismissAlert: (index: number) => void;
  setRelaunchTask: (task: RelaunchTask) => void;
  clearRelaunchTask: () => void;
  showSentOverlay: (agentName: string) => void;
  clearSentOverlay: () => void;
  setLeftPane: (pane: LeftPane) => void;
  setNarrowTab: (tab: NarrowTab) => void;
  setFocusZone: (zone: FocusZone) => void;
  setRespondAllAgentIds: (agentIds: string[] | null) => void;
  armShortcuts: () => void;
}

export interface DiscoveryStatus {
  projects: string[];
  warnings: string[];
  scannedAt?: string;
  lastError?: string;
}

export interface ProjectSidebarSlice {
  selectedProject: string | null;
  projectSidebarVisible: boolean;
  projectSummaries: ProjectSummary[];
  visibleProjectSummaries: ProjectSummary[];
  projectSidebarRows: ProjectSidebarRow[];
  projectSidebarPrefs: ProjectSidebarPrefs;
  projectSidebarCatalog: Record<string, ProjectSidebarCatalogEntry>;
  projectSidebarError: string | null;
  projectSummariesHydrated: boolean;
  discoveryStatus: DiscoveryStatus | null;
  discoveryBusy: boolean;
  trackOssError: string | null;
  trackOssBusy: boolean;
  untrackOssError: string | null;
  untrackOssBusy: boolean;

  selectProject: (project: string | null) => void;
  toggleProjectSidebar: () => void;
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

  handleWorkspaceView: (
    view: WorkspaceView,
    error?: string,
    cleanupResult?: CleanupResultSummary,
    cleanupResults?: CleanupResultSummary[],
    diagnosticLaunch?: CleanupDiagnosticLaunch,
  ) => void;
  handleWorkspaceCleanupDetail: (worktreePath: string, detail?: CleanupCandidateDetail, error?: string) => void;
  handleWorkspaceStartWorkAck: (ack: { taskId: string; queued: boolean; duplicate?: boolean; error?: string }) => void;
  setWorkspaceLoading: (loading: boolean) => void;
  setWorkspaceCleanupDetailLoading: (loading: boolean) => void;
  setWorkspaceError: (error: string | null) => void;
  clearWorkspaceCleanupDetail: () => void;
  clearWorkspaceView: () => void;
  setSweepRunning: (running: boolean) => void;
  handleSweepComplete: (result: {
    runId: string;
    startedAt: string;
    finishedAt: string;
    projects: Array<
      | { kind: 'ok'; projectId: string; summaries: CleanupResultSummary[]; elapsedMs: number }
      | { kind: 'skipped'; projectId: string; reason: 'repo_path_unresolved' }
      | { kind: 'failed'; projectId: string; code: 'timeout' | 'error'; message: string; elapsedMs: number }
    >;
  }) => void;
  handleSweepBusy: (payload: { holderPid: number; heldSince: string }) => void;
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

export type KookrStore =
  & TransportSessionSlice
  & TriageNavigationSlice
  & ProjectSidebarSlice
  & AchievementsSystemSlice
  & WorkspaceSlice
  & OssAttemptsSlice;

export type StoreSet = (
  partial: Partial<KookrStore> | ((state: KookrStore) => Partial<KookrStore>),
) => void;

export type StoreGet = () => KookrStore;
