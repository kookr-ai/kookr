import React, { lazy, Suspense, useState, useEffect, useMemo, useCallback, useReducer, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentState, ClientMessage, ProjectSummary } from '../shared/protocol.js';
import { resolveCleanupOverride } from './cleanup-override.js';
import { deriveLaunchProjectCwd } from './derive-project-cwd.js';
import { useKookrStore } from './store/useStore.js';
import { applyRoundRobinIndex } from './store/round-robin-cursor.js';
import { applyQuotaHeadroomThreshold } from './store/quota-headroom-threshold.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useNotifications } from './hooks/useNotifications.js';
import { useTabAttentionBadge } from './hooks/useTabAttentionBadge.js';
import { useAudibleAlert } from './hooks/useAudibleAlert.js';
import { useOpsHealthPoll } from './hooks/useOpsHealthPoll.js';
import { useTaskCompletionChime } from './hooks/useTaskCompletionChime.js';
import { sendToTerminal } from './terminal-send.js';
import { globalEnterShouldNavigate } from './global-enter-nav.js';
import { track } from './telemetry.js';
import { buildAgentBuckets, countCompletedInWindow, countLaunchedInWindow } from './agent-buckets.js';
import { activeFindingIndex, queueFocusTarget } from './queue-focus.js';
import { computeChainMembership, computeDescendants } from './components/related-tasks-model.js';
import { deriveProjectPriorityRanks } from '../shared/project-sidebar.js';
import { TopBar } from './components/TopBar.js';
import { CommandPalette } from './components/CommandPalette.js';
import type {
  CommandAction,
  CommandFindingItem,
  CommandProjectItem,
  CommandTaskItem,
} from './components/command-palette-model.js';
import { FindingsPanel } from './components/FindingsPanel.js';
import { ScheduledTasksHint } from './components/ScheduledTasksHint.js';
import { shouldShow as scheduledTasksHintShouldShow } from './store/scheduled-tasks-hint-status.js';
import type { SchedulePrefill } from './components/SchedulesDialog.js';
import { DetailPanel } from './components/DetailPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { Toasts } from './components/Toasts.js';
import { PluginInstallBanner } from './components/PluginInstallBanner.js';
import { PermissionBypassBanner } from './components/PermissionBypassBanner.js';
import { DrainModeBanner } from './components/DrainModeBanner.js';
import { SafeModeBanner } from './components/SafeModeBanner.js';
import { ConnectionBanner } from './components/ConnectionBanner.js';
import { BugReportDialog } from './components/BugReportDialog.js';
import { ShareViewerDialog } from './components/ShareViewerDialog.js';
import { ReadOnlyBanner } from './components/ReadOnlyBanner.js';
import { installReadOnlyNoticeListener, useViewerGuardedSend, useViewerSession } from './viewer-session.js';
import { AchievementToasts } from './components/AchievementToast.js';
import { SentOverlay } from './components/SentOverlay.js';
import { SnoozeDialog } from './components/SnoozeDialog.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { CompleteDialogFooter } from './components/CompleteDialogFooter.js';
import { DestructiveUndoToasts } from './components/DestructiveUndoToasts.js';
import { SweepProgress } from './components/SweepProgress.js';
import { SweepReport } from './components/SweepReport.js';
import { ProjectSidebar } from './components/ProjectSidebar.js';
import { ProjectDetailDrawer } from './components/ProjectDetailDrawer.js';
import type { SettingsFocusField } from './components/SettingsDialog.js';
import { OnboardingTour } from './components/OnboardingTour.js';
import { CoordinatorFindingsPane } from './components/CoordinatorSurfaces.js';
import { maybeOpenForFirstRun, open as openOnboardingTour } from './store/onboarding-store.js';
import {
  clampFindingsWidth,
  loadFindingsWidth,
  saveFindingsWidth,
  MIN_FINDINGS_WIDTH,
  MAX_FINDINGS_WIDTH,
} from './store/dashboard-layout-prefs.js';
import {
  detectShortcutPlatform,
  formatShortcutBinding,
  matchesShortcutAction,
  resolveShortcutBindings,
  type PlatformShortcutBindingOverrides,
} from '../shared/contracts/shortcut-bindings.js';
import type { VerbosityScale } from '../shared/contracts/speech.js';
import { setSpeakVerbositySnapshot } from './hooks/useSpeakAgent.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { computeAbortActiveTaskIds } from './abort-active-tasks.js';
import { buildBugReportBundle } from './bug-report-bundle.js';
import { getBugReportAlerts, getBugReportWireObservations } from './bug-report-recorder.js';
import {
  ensureLongTaskObserverStarted,
  getDebugTimelineEntries,
  isDebugTimelineEnabled,
} from './debug-timeline.js';
import { getSelectionTransitionDiagnostics } from './selection-transition-recorder.js';
import { findingTypeLabel, oldestFindingWaitStartedAt } from './presentation.js';
import { activeModalReducer } from './app-modal-reducer.js';
import type { ActiveModal } from './app-modal-reducer.js';
import { useCompletionConfirmation } from './hooks/useCompletionConfirmation.js';
import type { PendingCompleteConfirmation } from './hooks/useCompletionConfirmation.js';
import './critical.css';

type LazyModule = Record<string, unknown> & { default?: Record<string, unknown> };

function pickLazyExport<T>(module: unknown, exportName: string): T {
  const lazyModule = module as LazyModule;
  return (lazyModule[exportName] ?? lazyModule.default?.[exportName]) as T;
}

const LaunchTaskDialog = lazy(() => import('./components/LaunchTaskDialog.js').then((m) => ({ default: pickLazyExport<typeof m.LaunchTaskDialog>(m, 'LaunchTaskDialog') })));
const QuickLaunch = lazy(() => import('./components/QuickLaunch.js').then((m) => ({ default: pickLazyExport<typeof m.QuickLaunch>(m, 'QuickLaunch') })));
const ShortcutsHelp = lazy(() => import('./components/ShortcutsHelp.js').then((m) => ({ default: pickLazyExport<typeof m.ShortcutsHelp>(m, 'ShortcutsHelp') })));
const AchievementsPanel = lazy(() => import('./components/AchievementsPanel.js').then((m) => ({ default: pickLazyExport<typeof m.AchievementsPanel>(m, 'AchievementsPanel') })));
const ProjectSidebarManager = lazy(() => import('./components/ProjectSidebarManager.js').then((m) => ({ default: pickLazyExport<typeof m.ProjectSidebarManager>(m, 'ProjectSidebarManager') })));
const SettingsDialog = lazy(() => import('./components/SettingsDialog.js').then((m) => ({ default: pickLazyExport<typeof m.SettingsDialog>(m, 'SettingsDialog') })));
const SchedulesDialog = lazy(() => import('./components/SchedulesDialog.js').then((m) => ({ default: pickLazyExport<typeof m.SchedulesDialog>(m, 'SchedulesDialog') })));
const ContributionWorkspace = lazy(() => import('./components/ContributionWorkspace.js').then((m) => ({ default: pickLazyExport<typeof m.ContributionWorkspace>(m, 'ContributionWorkspace') })));
const OssProductivityView = lazy(() => import('./components/OssProductivityView.js').then((m) => ({ default: pickLazyExport<typeof m.OssProductivityView>(m, 'OssProductivityView') })));
const CostComparisonPanel = lazy(() => import('./components/CostComparisonPanel.js').then((m) => ({ default: pickLazyExport<typeof m.CostComparisonPanel>(m, 'CostComparisonPanel') })));
const OperationsPanel = lazy(() => import('./components/OperationsPanel.js').then((m) => ({ default: pickLazyExport<typeof m.OperationsPanel>(m, 'OperationsPanel') })));
const DebugTimelinePanel = lazy(() => (
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
    ? import('./components/DebugTimelinePanel.js').then((m) => ({ default: pickLazyExport<typeof m.DebugTimelinePanel>(m, 'DebugTimelinePanel') }))
    : Promise.resolve({ default: (() => null) as React.ComponentType<{ onExport: () => void }> })
));

interface ReflectionSuggestion {
  sessionId: string;
  summary: string;
  sessionLabel: string;
  totalInterventions: number;
  totalFindings: number;
}

export const DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS = 10_000;

type DestructiveClientMessage = Extract<ClientMessage, { type: 'deleteTask' }>;

interface PendingDestructiveAction {
  id: string;
  kind: 'deleteTask' | 'clearCompleted';
  summary: string;
  taskIds: string[];
  messages: DestructiveClientMessage[];
  expiresAt: number;
}

interface QueueDeleteTaskArgs {
  taskId: string;
  label: string;
}

interface QueueClearCompletedArgs {
  includeTerminated: boolean;
  projectId?: string;
  taskIds: string[];
  count: number;
}

type MobileDashboardTab = 'findings' | 'task';
type LaunchInitialTab = 'manual' | 'playbooks';

const MOBILE_BREAKPOINT_PX = 768;
const WIDE_DETAIL_BREAKPOINT_PX = 1200;
// Horizontal space (project sidebar + divider + minimum terminal viewport)
// reserved when the findings panel is resized, so the terminal can never be
// squeezed to an unusable width on narrow desktops.
const MIN_TERMINAL_RESERVE_PX = 480;

function quotedTaskLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > 0 ? `"${trimmed}"` : 'task';
}

function isActiveRalphLoop(agent: AgentState | undefined): boolean {
  return agent?.ralphLoop?.status === 'running' || agent?.ralphLoop?.status === 'paused';
}


function reflectionDismissKey(sessionId: string): string {
  return `kookr-reflection-dismissed-${sessionId}`;
}

/**
 * Largest findings width the layout can currently show. Derived from the live
 * container width (which is laid out immediately) rather than the sibling pane
 * widths (the terminal pane mounts lazily and reports 0 during that window,
 * which would wrongly collapse the bound). Clamped into the absolute range.
 */
function maxFindingsWidthFor(container: HTMLElement | null): number {
  if (!container) return MAX_FINDINGS_WIDTH;
  return Math.max(
    MIN_FINDINGS_WIDTH,
    Math.min(MAX_FINDINGS_WIDTH, container.clientWidth - MIN_TERMINAL_RESERVE_PX),
  );
}

/**
 * Draggable, keyboard-accessible divider between the findings panel and the
 * terminal/detail viewport (issue #707). It reports the desired findings-panel
 * width back to the parent (which owns persistence and applies it as a CSS
 * variable). The panel's actual rendered width is measured from the divider's
 * previous sibling so both drag deltas and the exposed ARIA value stay accurate
 * whether the width is the CSS default or a persisted override.
 *
 * Defined inline rather than under components/ to keep the issue #707 write
 * scope narrow; it is self-contained and could be extracted later.
 */
function FindingsResizer({
  containerRef,
  onResizeStateChange,
  onResize,
  onCommit,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  onResizeStateChange: (active: boolean) => void;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [valueNow, setValueNow] = useState<number>(MIN_FINDINGS_WIDTH);
  const [valueMax, setValueMax] = useState<number>(MAX_FINDINGS_WIDTH);
  // Teardown for an in-flight pointer drag, so listeners are removed even if the
  // component unmounts mid-drag (e.g. the selected agent is cleared by a
  // WebSocket update while the user is dragging).
  const dragCleanup = useRef<(() => void) | null>(null);

  const panelWidth = useCallback((): number => {
    const panel = ref.current?.previousElementSibling as HTMLElement | null;
    return panel ? panel.getBoundingClientRect().width : valueNow;
  }, [valueNow]);

  // Observe the container so window resizes (which shrink the panes) re-evaluate
  // both the exposed ARIA bounds and the live width, and re-clamp a previously
  // committed width that no longer fits — keeping the terminal usable.
  useEffect(() => {
    const main = containerRef.current;
    if (!main || typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const max = maxFindingsWidthFor(main);
      setValueMax(max);
      const width = panelWidth();
      setValueNow(Math.round(width));
      if (width > max + 0.5) onResize(max);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main);
    return () => observer.disconnect();
    // panelWidth/onResize are stable across renders for our usage; observe once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  // Tear down any in-flight drag on unmount.
  useEffect(() => () => dragCleanup.current?.(), []);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth();
    onResizeStateChange(true);

    const computeNext = (clientX: number) =>
      clampFindingsWidth(startWidth + (clientX - startX), maxFindingsWidthFor(containerRef.current));

    const handleMove = (moveEvent: PointerEvent) => onResize(computeNext(moveEvent.clientX));
    const teardown = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      onResizeStateChange(false);
      dragCleanup.current = null;
    };
    function handleUp(upEvent: PointerEvent) {
      const next = computeNext(upEvent.clientX);
      teardown();
      onCommit(next);
    }
    dragCleanup.current = teardown;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const current = panelWidth();
    const max = maxFindingsWidthFor(containerRef.current);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft': next = current - step; break;
      case 'ArrowRight': next = current + step; break;
      case 'Home': next = MIN_FINDINGS_WIDTH; break;
      case 'End': next = max; break;
      default: return;
    }
    event.preventDefault();
    const clamped = clampFindingsWidth(next, max);
    onResize(clamped);
    onCommit(clamped);
  };

  return (
    <div
      ref={ref}
      className="findings-resizer"
      data-testid="findings-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize findings panel"
      aria-valuenow={valueNow}
      aria-valuemin={MIN_FINDINGS_WIDTH}
      aria-valuemax={valueMax}
      onPointerDown={beginDrag}
      onKeyDown={handleKeyDown}
    />
  );
}

/** Command-palette actions hidden from read-only viewers (owner-only / mutating). */
const READ_ONLY_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'launch',
  'playbooks',
  'sweep',
  'share-viewer',
  'settings',
  'schedules',
]);

export function App() {
  const { send: rawSend } = useWebSocket();
  const { isViewer } = useViewerSession();
  // #811: for a read-only viewer, neutralize every WS-driven mutation control in
  // one place — the server gate (#806) already drops viewer inbound frames, so
  // sending is pointless; we no-op and surface the read-only notice instead.
  const send = useViewerGuardedSend(rawSend, isViewer);
  useEffect(() => {
    installReadOnlyNoticeListener();
  }, []);
  useNotifications();
  useTabAttentionBadge();
  // Audible alerts. Findings are unfocused (anomaly chimes regardless of
  // which task is focused — that's when the user most needs to switch).
  // Completion-signal audio is also unfocused: it means an agent has said a
  // task is ready for review, not that the user manually completed it.
  // See docs/rfc/rfc-completion-signal-audio-cue.md.
  useAudibleAlert();
  useTaskCompletionChime();
  // Issue #2037: poll /api/health for smoke-tick streak + resourceWatchdog off
  // so the status bar can show compact pills when those unattended risks fire.
  useOpsHealthPoll();
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT_PX : false,
  );
  const [wideDetailActive, setWideDetailActive] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth > WIDE_DETAIL_BREAKPOINT_PX : false,
  );
  const [mobileTab, setMobileTab] = useState<MobileDashboardTab>('findings');
  // Persisted desktop split between the findings panel and the terminal
  // viewport. `null` means "use the CSS default width". Live drag updates state
  // for instant feedback; the value is persisted on drag-end / keyboard commit.
  const mainRef = useRef<HTMLElement>(null);
  const [findingsWidth, setFindingsWidth] = useState<number | null>(() => loadFindingsWidth());
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const commitFindingsWidth = useCallback((width: number) => {
    setFindingsWidth(width);
    saveFindingsWidth(width);
  }, []);
  // Which mutually-exclusive modal dialog is open (issue #1825). One value in
  // place of ~12 independent visibility booleans; opening any modal implicitly
  // closes the previous one. Per-modal payloads stay in their own state below.
  const [activeModal, dispatchModal] = useReducer(activeModalReducer, null);
  const openModal = useCallback((modal: ActiveModal) => dispatchModal({ type: 'open', modal }), []);
  const closeModal = useCallback(() => dispatchModal({ type: 'close' }), []);
  const toggleModal = useCallback((modal: ActiveModal) => dispatchModal({ type: 'toggle', modal }), []);
  // Shared cancel/complete confirmation selector: a single value keeps the
  // cancel and complete dialogs mutually exclusive. The complete flow's rich
  // state lives in useCompletionConfirmation (declared below, once
  // requestCleanupInspect exists); this only tracks which one is showing.
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'complete' | null>(null);
  const [cleanupWorktreeOnComplete, setCleanupWorktreeOnComplete] = useState<boolean | undefined>(undefined);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocusField | undefined>(undefined);
  // Seed for opening the Schedules dialog straight into a pre-filled create form
  // from a task-panel "schedule this playbook" button. Null = manual open.
  const [schedulePrefill, setSchedulePrefill] = useState<SchedulePrefill | null>(null);
  // One-time post-create hint pointing at the command-palette trigger.
  const [scheduleHintActive, setScheduleHintActive] = useState(false);
  // Non-modal surfaces that legitimately co-exist with a modal and with each
  // other, so they keep their own state instead of joining `activeModal`: the
  // diagnostics popover, the inline coordinator-findings pane, and the command
  // palette (a launcher toggled from anywhere, including over another surface).
  const [showOperations, setShowOperations] = useState(false);
  const [operationsFocus, setOperationsFocus] = useState<'live-friction' | null>(null);
  const closeOperations = useCallback(() => {
    setShowOperations(false);
    setOperationsFocus(null);
  }, []);
  const openLiveFrictionDiagnostics = useCallback(() => {
    setOperationsFocus('live-friction');
    setShowOperations(true);
  }, []);
  const openDiagnostics = useCallback(() => {
    setShowOperations(true);
  }, []);
  const toggleOperations = useCallback(() => {
    setShowOperations((open) => {
      if (open) setOperationsFocus(null);
      return !open;
    });
  }, []);
  const [showCoordinatorFindings, setShowCoordinatorFindings] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [debugTimelineEnabled] = useState(() => isDebugTimelineEnabled());
  useEffect(() => {
    // Optional Long Task API observer (debug/?longtask=1). Measured snapshot /
    // xterm spans sample independently of this flag.
    ensureLongTaskObserverStarted();
  }, []);
  const [bugReportNote, setBugReportNote] = useState('');
  const [shortcutOverrides, setShortcutOverrides] = useState<PlatformShortcutBindingOverrides>({});
  const [launchProjectContext, setLaunchProjectContext] = useState<ProjectSummary | null>(null);
  const [launchProjectCwd, setLaunchProjectCwd] = useState<string | null>(null);
  const [launchInitialTab, setLaunchInitialTab] = useState<LaunchInitialTab | null>(null);
  // Bumped by palette opens so an already-mounted LaunchTaskDialog remounts
  // onto the requested tab instead of ignoring the new initialTab prop.
  const [launchDialogGeneration, setLaunchDialogGeneration] = useState(0);
  const [reflectionSuggestion, setReflectionSuggestion] = useState<ReflectionSuggestion | null>(null);
  const [pendingDestructiveActions, setPendingDestructiveActions] = useState<PendingDestructiveAction[]>([]);
  const operationsPopoverRef = useRef<HTMLDivElement>(null);
  const terminalFocusTriggerRef = useRef<HTMLButtonElement>(null);
  const destructiveTimersRef = useRef<Map<string, number>>(new Map());
  const destructiveActionSeqRef = useRef(0);
  const sendRef = useRef(send);
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const shortcutBindings = useMemo(
    () => resolveShortcutBindings(shortcutPlatform, shortcutOverrides),
    [shortcutOverrides, shortcutPlatform],
  );
  const {
    agents,
    agentsHydrated,
    buildInfo,
    dashboardSelection,
    serverStartedAt,
    selectedAgentId,
    selectedTaskId,
    selectAgent,
    nextBottleneck,
    nextTask,
    selectNextTaskAfterCompletion,
    advanceEmptyEnter,
    previousTask,
    relaunchTask,
    clearRelaunchTask,
    selectedProject,
    selectProject,
    toggleProjectSidebar,
    projectSummaries,
    projectSummariesHydrated,
    projectSidebarPrefs,
    showAchievements,
    toggleAchievementsPanel,
    workspaceEnabled,
    clearWorkspaceView,
    handleAlert,
    ossShowView,
    closeOssView,
    toggleOssView,
    coordinator,
    leftPane,
    detailPaneMode,
    terminalFocusMode,
    setNarrowTab,
    toggleTerminalFocusMode,
    cleanupVerdicts,
    cleanupVerdictsError,
    cleanupVerdictsRefreshing,
    beginWorktreeCleanupInspect,
    clearWorktreeCleanupVerdicts,
  } = useKookrStore(useShallow((state) => ({
    agents: state.agents,
    agentsHydrated: state.agentsHydrated,
    buildInfo: state.buildInfo,
    dashboardSelection: state.dashboardSelection,
    serverStartedAt: state.serverStartedAt,
    selectedAgentId: state.selectedAgentId,
    selectedTaskId: state.selectedTaskId,
    selectAgent: state.selectAgent,
    nextBottleneck: state.nextBottleneck,
    nextTask: state.nextTask,
    selectNextTaskAfterCompletion: state.selectNextTaskAfterCompletion,
    advanceEmptyEnter: state.advanceEmptyEnter,
    previousTask: state.previousTask,
    relaunchTask: state.relaunchTask,
    clearRelaunchTask: state.clearRelaunchTask,
    selectedProject: state.selectedProject,
    selectProject: state.selectProject,
    toggleProjectSidebar: state.toggleProjectSidebar,
    projectSummaries: state.projectSummaries,
    projectSummariesHydrated: state.projectSummariesHydrated,
    projectSidebarPrefs: state.projectSidebarPrefs,
    showAchievements: state.showAchievements,
    toggleAchievementsPanel: state.toggleAchievementsPanel,
    workspaceEnabled: state.workspaceEnabled,
    clearWorkspaceView: state.clearWorkspaceView,
    handleAlert: state.handleAlert,
    ossShowView: state.ossShowView,
    closeOssView: state.closeOssView,
    toggleOssView: state.toggleOssView,
    coordinator: state.coordinator,
    leftPane: state.leftPane,
    detailPaneMode: state.detailPaneMode,
    terminalFocusMode: state.terminalFocusMode,
    setNarrowTab: state.setNarrowTab,
    toggleTerminalFocusMode: state.toggleTerminalFocusMode,
    cleanupVerdicts: state.cleanupVerdicts,
    cleanupVerdictsError: state.cleanupVerdictsError,
    cleanupVerdictsRefreshing: state.cleanupVerdictsRefreshing,
    beginWorktreeCleanupInspect: state.beginWorktreeCleanupInspect,
    clearWorktreeCleanupVerdicts: state.clearWorktreeCleanupVerdicts,
  })));

  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /**
   * Ask the server whether this task's worktrees can be removed. Fires when the
   * complete dialog opens and on each manual re-check; the reply lands in the
   * store via the `worktreeCleanupVerdicts` message.
   */
  const requestCleanupInspect = useCallback((taskId: string, opts?: { refresh?: boolean }) => {
    beginWorktreeCleanupInspect(taskId, opts);
    send({ type: 'worktree:inspectCleanup', taskId });
  }, [beginWorktreeCleanupInspect, send]);

  // Task-completion confirmation flow (pending task, feedback, reflect toggle,
  // worktree-cleanup checkbox). Extracted from App into a dedicated hook per
  // issue #1825; visibility is still gated on `confirmAction === 'complete'` so
  // the cancel and complete dialogs stay mutually exclusive.
  const {
    pending: pendingComplete,
    feedback: completeFeedback,
    setFeedback: setCompleteFeedback,
    requestReflect: completeRequestReflect,
    setRequestReflect: setCompleteRequestReflect,
    cleanupWorktree: completeCleanupWorktree,
    cleanupWorktreeTouched: completeCleanupWorktreeTouched,
    setCleanupWorktree: setCompleteCleanupWorktree,
    begin: beginComplete,
    reset: resetComplete,
  } = useCompletionConfirmation({
    cleanupWorktreeOnComplete,
    isOpen: confirmAction === 'complete',
    onBegin: requestCleanupInspect,
  });

  // Open the complete confirmation for a task: seed the completion state and
  // switch the shared selector to 'complete'.
  const openCompleteConfirmation = useCallback((target: PendingCompleteConfirmation) => {
    beginComplete(target);
    setConfirmAction('complete');
  }, [beginComplete]);

  // Close the complete confirmation and clear all of its derived state.
  const closeCompleteConfirmation = useCallback(() => {
    setConfirmAction(null);
    resetComplete();
    clearWorktreeCleanupVerdicts();
  }, [resetComplete, clearWorktreeCleanupVerdicts]);

  const removePendingDestructiveAction = useCallback((id: string) => {
    const timer = destructiveTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      destructiveTimersRef.current.delete(id);
    }
    setPendingDestructiveActions((actions) => actions.filter((action) => action.id !== id));
  }, []);

  const queueDestructiveAction = useCallback((action: Omit<PendingDestructiveAction, 'id' | 'expiresAt'>) => {
    const delay = DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS;
    const id = `${action.kind}-${Date.now()}-${destructiveActionSeqRef.current++}`;
    const expiresAt = Date.now() + delay;
    const pendingAction: PendingDestructiveAction = { ...action, id, expiresAt };

    const timer = window.setTimeout(() => {
      destructiveTimersRef.current.delete(id);
      setPendingDestructiveActions((actions) => actions.filter((candidate) => candidate.id !== id));
      for (const message of pendingAction.messages) {
        const sent = sendRef.current(message);
        if (!sent) {
          useKookrStore.getState().handleAlert(
            '',
            `${pendingAction.summary} was not sent because the connection is down.`,
            'error',
          );
          break;
        }
      }
    }, delay);

    destructiveTimersRef.current.set(id, timer);
    setPendingDestructiveActions((actions) => [...actions, pendingAction]);
  }, []);

  const queueDeleteTask = useCallback(({ taskId, label }: QueueDeleteTaskArgs) => {
    queueDestructiveAction({
      kind: 'deleteTask',
      summary: `Deleting ${quotedTaskLabel(label)}`,
      taskIds: [taskId],
      messages: [{ type: 'deleteTask', taskId }],
    });
  }, [queueDestructiveAction]);

  const queueClearCompleted = useCallback((args: QueueClearCompletedArgs) => {
    if (args.count === 0 || args.taskIds.length === 0) return;
    queueDestructiveAction({
      kind: 'clearCompleted',
      summary: `Deleting ${args.count} finished task${args.count === 1 ? '' : 's'}`,
      taskIds: args.taskIds,
      messages: args.taskIds.map((taskId) => ({ type: 'deleteTask', taskId })),
    });
  }, [queueDestructiveAction]);

  useEffect(() => {
    return () => {
      for (const timer of destructiveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      destructiveTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    void import('./styles.css');
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((settings: {
        shortcutBindings?: PlatformShortcutBindingOverrides;
        speakVerbosity?: VerbosityScale;
        cleanupWorktreeOnComplete?: boolean;
        roundRobinIndex?: number;
        quotaHeadroomThreshold?: number;
      }) => {
        if (cancelled) return;
        setShortcutOverrides(settings.shortcutBindings ?? {});
        setSpeakVerbositySnapshot(settings.speakVerbosity);
        setCleanupWorktreeOnComplete(settings.cleanupWorktreeOnComplete);
        applyRoundRobinIndex(settings.roundRobinIndex);
        applyQuotaHeadroomThreshold(settings.quotaHeadroomThreshold);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Open launch dialog when relaunchTask is set
  useEffect(() => {
    if (relaunchTask) {
      openModal('launch');
    }
  }, [relaunchTask, openModal]);

  // First-run onboarding tour: opens once per browser when localStorage has
  // no current onboarding seen key. Idempotent on subsequent reloads.
  useEffect(() => {
    maybeOpenForFirstRun();
  }, []);

  useEffect(() => {
    function updateViewportMode() {
      const width = window.innerWidth;
      setIsMobileViewport(width <= MOBILE_BREAKPOINT_PX);
      setWideDetailActive(width > WIDE_DETAIL_BREAKPOINT_PX);
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    return () => window.removeEventListener('resize', updateViewportMode);
  }, []);

  useEffect(() => {
    if (!showOperations) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.operations-trigger')) return;
      if (operationsPopoverRef.current?.contains(event.target as Node)) return;
      closeOperations();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        closeOperations();
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showOperations, closeOperations]);

  const selectedProjectSummary = selectedProject
    ? projectSummaries.find((p) => p.project === selectedProject) ?? null
    : null;
  const selectedAgent = selectedAgentId
    ? agents.find((a) => (
        a.agentId === selectedAgentId
        && selectedTaskId === a.taskId
      )) ?? agents.find((a) => a.agentId === selectedAgentId) ?? null
    : null;
  // Read from the live agent rather than snapshotting at dialog-open: a loop can
  // finish while the dialog sits there, and a stale snapshot would make the
  // dialog's re-check control unable to ever clear the block it reports.
  const pendingCompleteRalphActive = isActiveRalphLoop(
    pendingComplete ? agents.find((a) => a.agentId === pendingComplete.agentId) : undefined,
  );
  useEffect(() => {
    const effectiveSelectedTaskId = selectedAgent?.taskId ?? null;
    const effectiveSelectedSessionId = selectedAgent?.agentId ?? null;
    if (
      dashboardSelection.selectedTaskId === effectiveSelectedTaskId
      && dashboardSelection.selectedSessionId === effectiveSelectedSessionId
    ) {
      return;
    }
    send({
      type: 'selectionChanged',
      selectedTaskId: effectiveSelectedTaskId,
      selectedSessionId: effectiveSelectedSessionId,
    });
  }, [
    dashboardSelection.selectedSessionId,
    dashboardSelection.selectedTaskId,
    selectedAgent?.agentId,
    selectedAgent?.taskId,
    selectedTaskId,
    send,
  ]);
  const selectedAgentShowsSplit = selectedAgent === null
    || !(selectedAgent.taskStatus !== undefined && isTerminalStatus(selectedAgent.taskStatus) && selectedAgent.completionDigest);
  const terminalFocusActive = terminalFocusMode && wideDetailActive && selectedAgentShowsSplit;
  const bugReportOpen = activeModal === 'bugReport';
  const bugReportDraft = useMemo(() => {
    if (!bugReportOpen) return null;
    return buildBugReportBundle({
      agents,
      selectedAgentId,
      selectedProject,
      buildInfo,
      serverStartedAt,
      alerts: getBugReportAlerts(),
      wireObservations: getBugReportWireObservations(),
      selectionDiagnostics: getSelectionTransitionDiagnostics(),
      debugTimeline: getDebugTimelineEntries(),
      note: bugReportNote,
    });
  }, [agents, bugReportNote, buildInfo, selectedAgentId, selectedProject, serverStartedAt, bugReportOpen]);

  const exportDebugTrace = useCallback(() => {
    const { bundle, serialized } = buildBugReportBundle({
      agents,
      selectedAgentId,
      selectedProject,
      buildInfo,
      serverStartedAt,
      alerts: getBugReportAlerts(),
      wireObservations: [],
      selectionDiagnostics: getSelectionTransitionDiagnostics(),
      debugTimeline: getDebugTimelineEntries(),
      note: 'Debug timeline export',
    });
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `kookr-debug-trace-${bundle.generatedAt.replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [agents, buildInfo, selectedAgentId, selectedProject, serverStartedAt]);

  useEffect(() => {
    if (wideDetailActive) return;
    if (detailPaneMode === 'right') {
      setNarrowTab('terminal');
    } else if (detailPaneMode === 'left') {
      setNarrowTab(leftPane === 'github' ? 'github' : 'activity');
    }
  }, [detailPaneMode, leftPane, setNarrowTab, wideDetailActive]);

  useEffect(() => {
    if (!terminalFocusActive) return;
    const raf = window.requestAnimationFrame(() => {
      terminalFocusTriggerRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [terminalFocusActive]);

  function handleCloseLaunch() {
    closeModal();
    setLaunchProjectContext(null);
    setLaunchProjectCwd(null);
    setLaunchInitialTab(null);
    clearRelaunchTask();
  }

  const handleLaunchManualTask = useCallback(() => {
    if (selectedProjectSummary) {
      setLaunchProjectContext(selectedProjectSummary);
      setLaunchProjectCwd(deriveLaunchProjectCwd(agents, selectedProjectSummary) ?? '');
      setLaunchInitialTab('manual');
      track({ type: 'launch_dialog_opened', method: 'project_drawer_manual' });
      openModal('launch');
    }
  }, [selectedProjectSummary, agents, openModal]);

  const handleRunPlaybook = useCallback(() => {
    if (selectedProjectSummary) {
      setLaunchProjectContext(selectedProjectSummary);
      setLaunchProjectCwd(deriveLaunchProjectCwd(agents, selectedProjectSummary) ?? '');
      setLaunchInitialTab('playbooks');
      track({ type: 'launch_dialog_opened', method: 'project_drawer' });
      openModal('launch');
    }
  }, [selectedProjectSummary, agents, openModal]);

  const openLaunchFromPalette = useCallback((tab: LaunchInitialTab, method: string) => {
    setLaunchProjectContext(null);
    setLaunchProjectCwd(null);
    setLaunchInitialTab(tab);
    clearRelaunchTask();
    setLaunchDialogGeneration((generation) => generation + 1);
    track({ type: 'launch_dialog_opened', method });
    openModal('launch');
  }, [clearRelaunchTask, openModal]);

  // The bug-report and share-viewer modals swallow global shortcuts (only
  // Escape passes through). The diagnostics popover does too, but it stays a
  // separate boolean since it can co-exist with a modal.
  const modalBlocksShortcuts = activeModal === 'bugReport' || activeModal === 'shareViewer';

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // ⌘K / Ctrl+K toggles the command palette from anywhere — including while
      // typing in a field — so it must run before the dialog/composition guards.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setShowCommandPalette((value) => !value);
        return;
      }
      if ((showOperations || modalBlocksShortcuts) && e.key !== 'Escape') {
        return;
      }
      if (matchesShortcutAction(e, shortcutBindings, 'next_bottleneck')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.next_bottleneck), action: 'next_bottleneck', context: 'global' });
        nextBottleneck();
      }
      if (matchesShortcutAction(e, shortcutBindings, 'quick_launch')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.quick_launch), action: 'quick_launch', context: 'global' });
        openModal('quickLaunch');
      }
      if (matchesShortcutAction(e, shortcutBindings, 'stt_toggle')) {
        e.preventDefault();
        // Voice shortcut toggles recording — target the right mic button.
        // 1. If any button is currently recording, stop it
        const recording = document.querySelector('.btn-voice.recording') as HTMLButtonElement | null;
        if (recording) {
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.stt_toggle), action: 'stt_toggle', context: 'global' });
          recording.click();
        } else {
          // 2. Find the mic button nearest the focused element (sibling in same row/label)
          const focused = document.activeElement as HTMLElement | null;
          const nearestMic = focused?.closest('.response-row, label, .quick-launch-bar')
            ?.querySelector('.btn-voice:not(:disabled)') as HTMLButtonElement | null;
          // 3. Fall back to the first visible non-disabled mic button
          const target = nearestMic ?? document.querySelector('.btn-voice:not(:disabled)') as HTMLButtonElement | null;
          if (target) {
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.stt_toggle), action: 'stt_toggle', context: 'global' });
            target.click();
          }
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'snooze_dialog')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.snooze_dialog), action: 'snooze_dialog', context: 'global' });
          openModal('snooze');
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'quick_snooze')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const durationMs = 5 * 60 * 1000; // 5-minute default snooze
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.quick_snooze), action: 'quick_snooze', context: 'global' });
          send({ type: 'snooze', agentId: state.selectedAgentId, taskId: selectedAgent?.taskId, durationMs });
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'focus_reply')) {
        e.preventDefault();
        const replyInput = document.querySelector('.detail-panel .response-row textarea') as HTMLTextAreaElement | null;
        if (replyInput) {
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.focus_reply), action: 'focus_reply', context: 'global' });
          replyInput.focus();
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'speak_agent')) {
        // Skip when the user is typing into any editable field so the keystroke
        // reaches the input. .closest covers <input>/<textarea> as well as
        // contenteditable subtrees (rich composers, code editors).
        const focused = document.activeElement as HTMLElement | null;
        const inEditable =
          focused?.tagName === 'INPUT' ||
          focused?.tagName === 'TEXTAREA' ||
          (focused?.isContentEditable ?? false);
        if (!inEditable) {
          const state = useKookrStore.getState();
          const speakButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="speak-button"]'))
            .find((button) => button.dataset.agentId === state.selectedAgentId) ?? null;
          if (speakButton && !speakButton.disabled) {
            e.preventDefault();
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.speak_agent), action: 'speak_agent', context: 'global' });
            speakButton.click();
          }
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'cancel_task')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          if (selectedAgent?.taskId) {
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.cancel_task), action: 'cancel_task', context: 'global' });
            setConfirmAction('cancel');
          }
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'complete_task')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          if (selectedAgent?.taskId) {
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.complete_task), action: 'complete_task', context: 'global' });
            openCompleteConfirmation({
              taskId: selectedAgent.taskId,
              agentId: selectedAgent.agentId,
              label: selectedAgent.taskName ?? selectedAgent.agentId,
              method: 'shortcut',
            });
          }
        }
      }
      // Toggle project sidebar.
      if (matchesShortcutAction(e, shortcutBindings, 'toggle_project_sidebar')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.toggle_project_sidebar), action: 'toggle_project_sidebar', context: 'global' });
        toggleProjectSidebar();
      }
      // Toggle Auto-Advance (follow priority project).
      if (matchesShortcutAction(e, shortcutBindings, 'toggle_auto_advance')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.toggle_auto_advance), action: 'toggle_auto_advance', context: 'global' });
        useKookrStore.getState().toggleAutoAdvance();
      }
      if (matchesShortcutAction(e, shortcutBindings, 'toggle_terminal_focus')) {
        e.preventDefault();
        if (!wideDetailActive) return;
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.toggle_terminal_focus), action: 'toggle_terminal_focus', context: 'global' });
        toggleTerminalFocusMode();
      }
      // Toggle achievements panel.
      if (matchesShortcutAction(e, shortcutBindings, 'toggle_achievements')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.toggle_achievements), action: 'toggle_achievements', context: 'global' });
        toggleAchievementsPanel();
      }
      // Select all projects.
      if (matchesShortcutAction(e, shortcutBindings, 'select_all_projects')) {
        e.preventDefault();
        selectProject(null);
      }
      // Send terminal digit, then skip to next task.
      const terminalSend = (['terminal_send_1', 'terminal_send_2', 'terminal_send_3'] as const)
        .find((action) => matchesShortcutAction(e, shortcutBindings, action));
      if (terminalSend) {
        e.preventDefault();
        const digit = terminalSend.slice(-1);
        if (!sendToTerminal(digit)) return;
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings[terminalSend]), action: 'terminal_send_and_next', context: 'global' });
        nextTask();
      }
      // Select project by sidebar order.
      const projectSelect = ([
        'select_project_1',
        'select_project_2',
        'select_project_3',
        'select_project_4',
        'select_project_5',
        'select_project_6',
      ] as const).find((action) => matchesShortcutAction(e, shortcutBindings, action));
      if (projectSelect) {
        e.preventDefault();
        const idx = Number(projectSelect.slice(-1)) - 1;
        const state = useKookrStore.getState();
        if (idx < state.visibleProjectSummaries.length) {
          selectProject(state.visibleProjectSummaries[idx].project);
        }
      }
      // Escape to deselect current task — works from any context except inside dialogs
      if (matchesShortcutAction(e, shortcutBindings, 'deselect_task')) {
        const inDialog = (e.target as HTMLElement)?.closest('.dialog-overlay');
        if (!inDialog) {
          const state = useKookrStore.getState();
          if (state.selectedAgentId !== null) {
            e.preventDefault();
            (document.activeElement as HTMLElement)?.blur();
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.deselect_task), action: 'deselect', context: 'global' });
            selectAgent(null);
          }
        }
      }
      // ? to open shortcuts help — only when not focused on an input/textarea
      if (matchesShortcutAction(e, shortcutBindings, 'toggle_shortcuts_help')) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          toggleModal('shortcuts');
        }
      }
      // Cycle selected task.
      if (matchesShortcutAction(e, shortcutBindings, 'next_task')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.next_task), action: 'next_task', context: 'global' });
        nextTask();
      }
      if (matchesShortcutAction(e, shortcutBindings, 'previous_task')) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.previous_task), action: 'previous_task', context: 'global' });
        previousTask();
      }
      // Bare Enter is a global "advance to next task" — usable from anywhere on
      // the dashboard (no selection, or focus resting on a non-editable element)
      // so the user can skim tasks without first clicking into a pane. Enter is
      // deliberately NOT routed through `shortcutBindings`: it is a fixed,
      // non-rebindable global, so it does not use `matchesShortcutAction` like
      // the branches above. Do NOT hijack it while the user is composing: the
      // reply input and the terminal own Enter for their empty-advance / submit
      // behavior (and call preventDefault when they consume it — hence the
      // defaultPrevented guard), and an open dialog owns Enter for confirmation.
      // The interactive-control / dialog decision lives in globalEnterShouldNavigate.
      if (
        e.key === 'Enter'
        && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
        && !e.isComposing && !e.defaultPrevented
        && globalEnterShouldNavigate(document.activeElement ?? (e.target as Element | null))
      ) {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Enter', action: 'advance_empty_input', context: 'global' });
        advanceEmptyEnter();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextBottleneck, nextTask, advanceEmptyEnter, previousTask, send, shortcutBindings, modalBlocksShortcuts, showOperations, openModal, toggleModal, openCompleteConfirmation, toggleProjectSidebar, toggleTerminalFocusMode, selectProject, toggleAchievementsPanel, wideDetailActive, selectedAgent]);

  useEffect(() => {
    if (!selectedProject || !agentsHydrated || !projectSummariesHydrated) return;

    const timer = window.setTimeout(() => {
      const state = useKookrStore.getState();
      if (!state.selectedProject) return;

      const hasProjectSummary = state.projectSummaries.some((project) => project.project === state.selectedProject);
      const hasProjectAgent = state.agents.some((agent) => agent.projectId === state.selectedProject);

      if (!hasProjectSummary && !hasProjectAgent) {
        state.selectProject(null);
      }
    }, 150);

    return () => window.clearTimeout(timer);
  }, [agents, agentsHydrated, projectSummaries, projectSummariesHydrated, selectedProject]);

  const projectPriorityRanks = useMemo(
    () => deriveProjectPriorityRanks(projectSummaries, projectSidebarPrefs),
    [projectSummaries, projectSidebarPrefs],
  );
  const taskRelations = useKookrStore((state) => state.taskRelations);
  const relationFilter = useKookrStore((state) => state.relationFilter);
  const agentsAfterRelationFilter = useMemo(() => {
    if (relationFilter.mode === 'off' || !relationFilter.rootTaskId) return agents;
    const allowed =
      relationFilter.mode === 'chain'
        ? computeChainMembership(relationFilter.rootTaskId, taskRelations)
        : computeDescendants(relationFilter.rootTaskId, taskRelations);
    if (relationFilter.mode === 'children') allowed.add(relationFilter.rootTaskId);
    return agents.filter((a) => !a.taskId || allowed.has(a.taskId));
  }, [agents, relationFilter, taskRelations]);
  const {
    filteredAgents,
    pending,
    completed,
    snoozed,
    findings,
    healthy,
    activeTaskCount,
    completedTaskCount,
  } = useMemo(
    () => buildAgentBuckets(agentsAfterRelationFilter, selectedProject, coordinator, projectPriorityRanks),
    [agentsAfterRelationFilter, selectedProject, coordinator, projectPriorityRanks],
  );
  const commandPaletteFindings = useMemo(
    () => buildAgentBuckets(agents, null, coordinator, projectPriorityRanks).findings,
    [agents, coordinator, projectPriorityRanks],
  );
  const oldestFindingWait = useMemo(
    () => oldestFindingWaitStartedAt(findings),
    [findings],
  );
  // Position the top-bar queue indicator names ("Triaging X of N"), reused by
  // its focus action so the label and the click target stay in lockstep.
  const currentFindingIndex = activeFindingIndex(
    findings,
    selectedAgentId,
    Boolean(selectedAgent?.anomaly),
  );
  const [windowNowMs, setWindowNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setWindowNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const completedLast24h = useMemo(
    () => countCompletedInWindow(completed, windowNowMs),
    [completed, windowNowMs],
  );
  const launchedLast24h = useMemo(
    () => countLaunchedInWindow(filteredAgents, windowNowMs),
    [filteredAgents, windowNowMs],
  );

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileTab('findings');
      return;
    }
    if (selectedAgentId) {
      setMobileTab('task');
    }
  }, [isMobileViewport, selectedAgentId]);

  useEffect(() => {
    if (!agentsHydrated) return;
    if (activeTaskCount > 0) {
      setReflectionSuggestion(null);
      return;
    }
    if (completedTaskCount === 0) return;

    let cancelled = false;
    fetch('/api/reflect/recommendation')
      .then((res) => res.ok ? res.json() : null)
      .then((payload) => {
        if (cancelled || !payload?.sessionId || !payload?.recommendation) return;
        if (payload.recommendation.shouldSuggest !== true) {
          setReflectionSuggestion(null);
          return;
        }
        if (window.localStorage.getItem(reflectionDismissKey(payload.sessionId)) === '1') {
          setReflectionSuggestion(null);
          return;
        }

        setReflectionSuggestion({
          sessionId: payload.sessionId,
          summary: payload.recommendation.summary,
          sessionLabel: payload.recommendation.sessionLabel,
          totalInterventions: payload.report?.totalInterventions ?? 0,
          totalFindings: payload.recommendation.totalFindings ?? 0,
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [activeTaskCount, agentsHydrated, completedTaskCount]);

  function dismissReflectionSuggestion() {
    if (!reflectionSuggestion) return;
    window.localStorage.setItem(reflectionDismissKey(reflectionSuggestion.sessionId), '1');
    setReflectionSuggestion(null);
  }

  function triggerReflection() {
    if (!reflectionSuggestion) return;
    const sent = send({ type: 'reflect' });
    if (!sent) {
      handleAlert('', 'Reflection task was not created because the connection is down.', 'error');
      return;
    }
    window.localStorage.setItem(reflectionDismissKey(reflectionSuggestion.sessionId), '1');
    setReflectionSuggestion(null);
  }

  const pendingDestructiveTaskIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const action of pendingDestructiveActions) {
      for (const taskId of action.taskIds) ids.add(taskId);
    }
    return ids;
  }, [pendingDestructiveActions]);

  useEffect(() => {
    if (selectedAgent?.taskId && pendingDestructiveTaskIdSet.has(selectedAgent.taskId)) {
      selectAgent(null);
    }
  }, [pendingDestructiveTaskIdSet, selectAgent, selectedAgent?.taskId]);

  // Clear-completed counts must match the server-side sweep scope. The
  // all-projects panel omits projectId and sweeps globally; project panels pass
  // projectId and sweep only tasks in that project.
  const clearCompletedScopeAgents = selectedProject
    ? agents.filter((a) => a.projectId === selectedProject)
    : agents;
  const clearCompletedFinishedAgents = clearCompletedScopeAgents.filter((a) =>
    a.taskId
    && !pendingDestructiveTaskIdSet.has(a.taskId)
    && (a.taskStatus === 'completed' || a.taskStatus === 'cancelled')
  );
  const clearCompletedTerminatedAgents = clearCompletedScopeAgents.filter((a) =>
    a.taskId
    && !pendingDestructiveTaskIdSet.has(a.taskId)
    && a.taskStatus === 'terminated'
  );
  const clearCompletedFinishedCount = clearCompletedFinishedAgents.length;
  const clearCompletedTerminatedCount = clearCompletedTerminatedAgents.length;

  // Active (non-terminal) task IDs in the current scope, deduped by task so a
  // multi-session task aborts once. Feeds the control-room "Abort all" action
  // (issue #1325): one batch request cancels these and interrupts their live
  // sessions, instead of prompting each agent to abort.
  const abortActiveTaskIds = useMemo(
    () => computeAbortActiveTaskIds(clearCompletedScopeAgents, pendingDestructiveTaskIdSet),
    [clearCompletedScopeAgents, pendingDestructiveTaskIdSet],
  );

  const findingsPanel = (
    <FindingsPanel
      findings={findings}
      healthy={healthy}
      pending={pending}
      completed={completed}
      snoozed={snoozed}
      selectedAgentId={selectedAgentId}
      selectedTaskId={selectedTaskId}
      send={send}
      clearCompletedFinishedCount={clearCompletedFinishedCount}
      clearCompletedTerminatedCount={clearCompletedTerminatedCount}
      clearCompletedFinishedTaskIds={clearCompletedFinishedAgents.map((agent) => agent.taskId!)}
      clearCompletedTerminatedTaskIds={clearCompletedTerminatedAgents.map((agent) => agent.taskId!)}
      clearCompletedProjectId={selectedProject ?? undefined}
      abortActiveTaskIds={abortActiveTaskIds}
      pendingDeletionTaskIds={pendingDestructiveTaskIdSet}
      onQueueDeleteTask={queueDeleteTask}
      onQueueClearCompleted={queueClearCompleted}
      onSchedulePlaybook={(prefill) => {
        setSchedulePrefill(prefill);
        openModal('schedules');
      }}
      shortcutBindings={shortcutBindings}
      onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'findings_empty' }); openModal('launch'); }}
    />
  );

  const detailPanel = (
    <DetailPanel
      agent={selectedAgent}
      send={send}
      onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'empty_panel' }); openModal('launch'); }}
      onLaunchPlaybooks={() => openLaunchFromPalette('playbooks', 'overview_recent_playbook')}
      onOpenSchedules={() => openModal('schedules')}
      onCheckSetup={() => setShowOperations(true)}
      onRequestComplete={() => {
        if (!selectedAgent?.taskId) return;
        openCompleteConfirmation({
          taskId: selectedAgent.taskId,
          agentId: selectedAgent.agentId,
          label: selectedAgent.taskName ?? selectedAgent.agentId,
          method: 'button',
        });
      }}
      detailPaneMode={detailPaneMode}
      wideDetailActive={wideDetailActive}
      terminalFocusMode={terminalFocusActive}
      shortcutBindings={shortcutBindings}
      // Overview data for the no-selection state (F8) — the rail's own bucket
      // classification, so "Waiting on you" and the counts match the rail.
      overview={{ waiting: findings, running: healthy, completed }}
    />
  );

  const openSettingsAtMaxActiveTasks = () => {
    setSettingsFocus('maxActiveTasks');
    openModal('settings');
  };
  const projectSidebar = !terminalFocusActive && (
    <ProjectSidebar
      onManage={() => openModal('projectSidebarManager')}
      onAdjustCap={openSettingsAtMaxActiveTasks}
    />
  );

  const projectDetailDrawer = !terminalFocusActive && selectedProjectSummary && (
    <ProjectDetailDrawer
      key={selectedProjectSummary.project}
      project={selectedProjectSummary}
      onClose={() => selectProject(null)}
      send={send}
      onOpenWorkspace={workspaceEnabled ? () => {
        openModal('workspace');
      } : undefined}
      onLaunchManual={handleLaunchManualTask}
      onRunPlaybook={handleRunPlaybook}
      compact={isMobileViewport}
    />
  );

  // Command-palette action registry — the single home for the actions that used
  // to be their own top-bar icons. Diagnostics + Coordinator findings stay as
  // quick icons too (they carry glanceable alert/badge state), so the palette is
  // a superset, not a replacement.
  const commandActions: CommandAction[] = [
    { id: 'diagnostics', label: 'Diagnostics', section: 'view', keywords: ['operations', 'health', 'circuit breaker'], run: toggleOperations },
    { id: 'coordinator-findings', label: 'Coordinator findings', section: 'view', keywords: ['chain', 'blocked', 'prior'], run: () => setShowCoordinatorFindings((value) => !value) },
    { id: 'oss', label: 'OSS contribution productivity', section: 'view', keywords: ['open source', 'contributions'], run: toggleOssView },
    { id: 'launch', label: 'Launch task', section: 'tools', keywords: ['spawn', 'new task'], run: () => {
      openLaunchFromPalette('manual', 'command_palette');
    } },
    { id: 'playbooks', label: 'Browse playbooks', section: 'tools', keywords: ['playbook', 'spawn', 'new task'], run: () => {
      openLaunchFromPalette('playbooks', 'command_palette_playbooks');
    } },
    ...(wideDetailActive
      ? [{
          id: 'terminal-focus',
          label: 'Terminal focus',
          section: 'tools' as const,
          shortcut: formatShortcutBinding(shortcutBindings.toggle_terminal_focus),
          keywords: ['terminal', 'focus', 'fullscreen'],
          run: () => {
            track({ type: 'shortcut_used', key: 'CommandPalette Terminal Focus', action: 'toggle_terminal_focus', context: 'click' });
            toggleTerminalFocusMode();
          },
        }]
      : []),
    { id: 'schedules', label: 'Schedules', section: 'tools', keywords: ['cron', 'routine', 'recurring'], run: () => openModal('schedules') },
    ...(workspaceEnabled && projectSummaries.length > 0
      ? [{ id: 'sweep', label: 'Sweep merged worktrees', section: 'tools' as const, keywords: ['worktree', 'cleanup', 'git', 'squash'], run: () => openModal('sweepConfirm') }]
      : []),
    { id: 'cost', label: 'Cost comparison', section: 'tools', keywords: ['claude', 'codex', 'price', 'spend'], run: () => openModal('costComparison') },
    { id: 'bug-report', label: 'Bug report', section: 'session', keywords: ['feedback', 'issue', 'report'], run: () => openModal('bugReport') },
    { id: 'share-viewer', label: 'Share read-only view', section: 'session', keywords: ['viewer', 'share', 'read-only', 'guest', 'link'], run: () => openModal('shareViewer') },
    { id: 'settings', label: 'Settings', section: 'session', keywords: ['preferences', 'config', 'options'], run: () => { setSettingsFocus(undefined); openModal('settings'); } },
    { id: 'tour', label: 'Take the tour', section: 'session', keywords: ['onboarding', 'walkthrough', 'product tour'], run: () => openOnboardingTour() },
    { id: 'shortcuts', label: 'Help & shortcuts', section: 'session', shortcut: formatShortcutBinding(shortcutBindings.toggle_shortcuts_help), keywords: ['help', 'keys', 'keyboard'], run: () => openModal('shortcuts') },
  ].filter((action) =>
    // #811: a read-only viewer cannot run owner-only / mutating commands (the
    // server would 403 / drop them); drop them from the palette so they are not
    // active controls. View-only commands (diagnostics, findings, help, …) stay.
    !isViewer || !READ_ONLY_HIDDEN_COMMANDS.has(action.id),
  );
  const commandTasks: CommandTaskItem[] = [];
  const seenCommandTaskIds = new Set<string>();
  for (const a of agents) {
    if (!a.taskId || seenCommandTaskIds.has(a.taskId)) continue;
    seenCommandTaskIds.add(a.taskId);
    commandTasks.push({
      taskId: a.taskId,
      agentId: a.agentId,
      label: a.taskName ?? a.agentId,
      status: a.taskStatus,
      projectLabel: a.projectId,
    });
  }
  const commandFindings: CommandFindingItem[] = commandPaletteFindings.map((agent) => ({
    agentId: agent.agentId,
    taskId: agent.taskId,
    label: agent.taskName ?? agent.agentId,
    severity: agent.anomaly?.severity ?? agent.effectiveAttentionSeverity ?? 'info',
    type: findingTypeLabel(agent),
    projectLabel: agent.projectId,
    explanation: agent.anomaly?.explanation,
  }));
  const commandProjects: CommandProjectItem[] = projectSummaries.map((project) => ({
    projectId: project.project,
    label: project.displayName,
    activeAgents: project.activeAgents,
    findingCount: project.findingCount,
    keywords: [
      project.localPath ?? '',
      project.notes ?? '',
      ...(project.recentTasks.map((task) => task.name ?? task.taskId)),
    ].filter((keyword) => keyword.length > 0),
  }));

  return (
    <div className={`app${isMobileViewport ? ' app-mobile' : ''}${isViewer ? ' app-read-only' : ''}`}>
      <a href="#main-content" className="skip-link" data-testid="skip-to-content">
        Skip to content
      </a>
      <ReadOnlyBanner />
      <SafeModeBanner />
      <DrainModeBanner />
      <ConnectionBanner />
      <PermissionBypassBanner />
      <SweepProgress />
      <SweepReport send={send} />
      <TopBar
        findings={findings.length}
        currentIndex={currentFindingIndex}
        totalFindings={findings.length}
        onFocusQueue={() => {
          // Focus the finding the queue indicator names: the currently selected
          // finding if one is active, otherwise the first waiting finding.
          const target = queueFocusTarget(findings, selectedAgentId, Boolean(selectedAgent?.anomaly));
          if (target) selectAgent(target.agentId, target.taskId);
        }}
        compact={isMobileViewport}
        onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'button' }); openModal('launch'); }}
        readOnly={isViewer}
        onCommandPalette={() => setShowCommandPalette(true)}
        scheduleHintActive={scheduleHintActive}
        onOperations={toggleOperations}
        operationsOpen={showOperations}
        onCoordinatorFindings={() => setShowCoordinatorFindings((value) => !value)}
        coordinatorFindingsOpen={showCoordinatorFindings}
        terminalFocusMode={terminalFocusMode}
        terminalFocusAvailable={wideDetailActive}
        terminalFocusTriggerRef={terminalFocusTriggerRef}
        onTerminalFocusToggle={() => {
          track({ type: 'shortcut_used', key: 'TopBar Terminal Focus', action: 'toggle_terminal_focus', context: 'click' });
          toggleTerminalFocusMode();
        }}
        shortcutBindings={shortcutBindings}
      />
      {showOperations && (
        <div className="operations-popover-shell" ref={operationsPopoverRef}>
          <Suspense fallback={null}>
            <OperationsPanel
              send={send}
              expandLiveFriction={operationsFocus === 'live-friction'}
              onClose={closeOperations}
            />
          </Suspense>
        </div>
      )}
      {isMobileViewport ? (
        <>
          {projectSidebar}
          <div className="mobile-dashboard-tabs" data-testid="mobile-dashboard-tabs">
            <button
              type="button"
              data-testid="mobile-tab-findings"
              className={`mobile-dashboard-tab${mobileTab === 'findings' ? ' active' : ''}`}
              onClick={() => setMobileTab('findings')}
            >
              Findings
              <span className="mobile-dashboard-badge">{findings.length}</span>
            </button>
            <button
              type="button"
              data-testid="mobile-tab-task"
              className={`mobile-dashboard-tab${mobileTab === 'task' ? ' active' : ''}`}
              onClick={() => setMobileTab('task')}
            >
              Task
              <span className="mobile-dashboard-badge">{selectedAgent ? 1 : 0}</span>
            </button>
          </div>
          <main id="main-content" tabIndex={-1} className="main main-mobile">
            {projectDetailDrawer}
            {!terminalFocusActive && <CoordinatorFindingsPane open={showCoordinatorFindings} onClose={() => setShowCoordinatorFindings(false)} />}
            {mobileTab === 'findings' ? findingsPanel : detailPanel}
          </main>
          {mobileTab === 'findings' && (
            <div className="mobile-quick-actions" data-testid="mobile-quick-actions">
              <button
                type="button"
                className="mobile-action-btn"
                data-testid="mobile-action-next-finding"
                disabled={findings.length === 0}
                onClick={() => {
                  track({ type: 'shortcut_used', key: 'Mobile Next Finding', action: 'next_bottleneck', context: 'touch' });
                  nextBottleneck();
                  setMobileTab('task');
                }}
              >
                Next finding
              </button>
              <button
                type="button"
                className="mobile-action-btn"
                data-testid="mobile-action-prev-task"
                disabled={filteredAgents.length === 0}
                onClick={() => {
                  track({ type: 'shortcut_used', key: 'Mobile Prev Task', action: 'previous_task', context: 'touch' });
                  previousTask();
                  setMobileTab('task');
                }}
              >
                Prev task
              </button>
              <button
                type="button"
                className="mobile-action-btn"
                data-testid="mobile-action-next-task"
                disabled={filteredAgents.length === 0}
                onClick={() => {
                  track({ type: 'shortcut_used', key: 'Mobile Next Task', action: 'next_task', context: 'touch' });
                  nextTask();
                  setMobileTab('task');
                }}
              >
                Next task
              </button>
              {!isViewer && (
                <button
                  type="button"
                  className="mobile-action-btn mobile-action-btn-primary"
                  data-testid="mobile-action-launch"
                  onClick={() => {
                    track({ type: 'launch_dialog_opened', method: 'mobile_action' });
                    openModal('launch');
                  }}
                >
                  Launch
                </button>
              )}
            </div>
          )}
        </>
      ) : (
        <main
          id="main-content"
          tabIndex={-1}
          ref={mainRef}
          className={`main${isResizingSplit ? ' main-resizing' : ''}`}
          style={findingsWidth != null
            ? ({ '--findings-panel-width': `${findingsWidth}px` } as React.CSSProperties)
            : undefined}
        >
          {projectSidebar}
          {projectDetailDrawer}
          {!terminalFocusActive && <CoordinatorFindingsPane open={showCoordinatorFindings} onClose={() => setShowCoordinatorFindings(false)} />}
          {findingsPanel}
          {!terminalFocusActive && selectedAgentShowsSplit && (
            <FindingsResizer
              containerRef={mainRef}
              onResizeStateChange={setIsResizingSplit}
              onResize={setFindingsWidth}
              onCommit={commitFindingsWidth}
            />
          )}
          {detailPanel}
        </main>
      )}
      <StatusBar
        findings={findings.length}
        oldestFindingWaitStartedAt={oldestFindingWait}
        total={filteredAgents.length}
        completedLast24h={completedLast24h}
        launchedLast24h={launchedLast24h}
        compact={isMobileViewport}
        onShowShortcuts={() => openModal('shortcuts')}
        onOpenCapacity={openSettingsAtMaxActiveTasks}
        onOpenLiveFriction={openLiveFrictionDiagnostics}
        onOpenDiagnostics={openDiagnostics}
        reflectionSuggestion={reflectionSuggestion}
        onReflect={triggerReflection}
        onDismissReflection={dismissReflectionSuggestion}
        shortcutBindings={shortcutBindings}
      />
      <Toasts />
      <DestructiveUndoToasts
        actions={pendingDestructiveActions}
        onUndo={removePendingDestructiveAction}
      />
      {debugTimelineEnabled && (
        <Suspense fallback={null}>
          <DebugTimelinePanel onExport={exportDebugTrace} />
        </Suspense>
      )}
      <PluginInstallBanner />
      <AchievementToasts />
      <SentOverlay />
      {showCommandPalette && (
        <CommandPalette
          actions={commandActions}
          tasks={commandTasks}
          findings={commandFindings}
          projects={commandProjects}
          onSelectTask={(agentId, taskId) => selectAgent(agentId, taskId)}
          onSelectFinding={(agentId, taskId) => selectAgent(agentId, taskId)}
          onSelectProject={(projectId) => selectProject(projectId)}
          onClose={() => setShowCommandPalette(false)}
        />
      )}
      {activeModal === 'sweepConfirm' && (
        <ConfirmDialog
          title="Sweep merged worktrees"
          message={`Sweep merged and squash-merged worktrees across ${projectSummaries.length} project${projectSummaries.length !== 1 ? 's' : ''}?`}
          confirmLabel="Sweep"
          onConfirm={() => {
            useKookrStore.getState().setSweepRunning(true);
            send({ type: 'workspace:sweep' });
            closeModal();
          }}
          onClose={closeModal}
        />
      )}
      {activeModal === 'shortcuts' && (
        <Suspense fallback={null}>
          <ShortcutsHelp
            bindings={shortcutBindings}
            onClose={closeModal}
          />
        </Suspense>
      )}
      {showAchievements && (
        <Suspense fallback={null}>
          <AchievementsPanel onClose={toggleAchievementsPanel} send={send} shortcutBindings={shortcutBindings} />
        </Suspense>
      )}
      {activeModal === 'projectSidebarManager' && (
        <Suspense fallback={null}>
          <ProjectSidebarManager onClose={closeModal} />
        </Suspense>
      )}
      {activeModal === 'snooze' && selectedAgent && (
        <SnoozeDialog
          agentId={selectedAgent.agentId}
          agentName={selectedAgent.taskName ?? selectedAgent.agentId}
          onSnooze={(durationMs) => {
            send({ type: 'snooze', agentId: selectedAgent.agentId, taskId: selectedAgent.taskId, durationMs });
            closeModal();
          }}
          onClose={closeModal}
        />
      )}
      {confirmAction === 'cancel' && selectedAgent?.taskId && (
        <ConfirmDialog
          title="Cancel Task"
          message={`Cancel "${selectedAgent.taskName ?? selectedAgent.agentId}"? The agent session will be terminated.`}
          confirmLabel="Cancel Task"
          confirmClass="btn-danger"
          onConfirm={() => {
            track({ type: 'task_cancelled', agentId: selectedAgent.agentId, method: 'shortcut' });
            send({ type: 'cancelTask', taskId: selectedAgent.taskId! });
            setConfirmAction(null);
          }}
          onClose={() => setConfirmAction(null)}
        />
      )}
      {confirmAction === 'complete' && pendingComplete && (
        <ConfirmDialog
          title="Complete Task"
          message={`Mark "${pendingComplete.label}" as complete?`}
          confirmLabel="Complete"
          suppressEnterToConfirm={completeFeedback !== undefined}
          footer={
            <CompleteDialogFooter
              feedback={completeFeedback}
              requestReflect={completeRequestReflect}
              cleanupWorktree={completeCleanupWorktree}
              cleanupVerdicts={cleanupVerdicts ?? undefined}
              cleanupInspectFailed={cleanupVerdictsError !== null}
              ralphActive={pendingCompleteRalphActive}
              cleanupRefreshing={cleanupVerdictsRefreshing}
              onRefreshCleanupVerdicts={() => requestCleanupInspect(pendingComplete.taskId, { refresh: true })}
              onChange={setCompleteFeedback}
              onRequestReflectChange={setCompleteRequestReflect}
              onCleanupWorktreeChange={setCompleteCleanupWorktree}
            />
          }
          onConfirm={() => {
            track({ type: 'task_completed', agentId: pendingComplete.agentId, method: pendingComplete.method });
            const cleanupOverride = resolveCleanupOverride({
              verdicts: cleanupVerdicts,
              inspectFailed: cleanupVerdictsError !== null,
              ralphActive: pendingCompleteRalphActive,
              touched: completeCleanupWorktreeTouched,
              savedDefault: cleanupWorktreeOnComplete,
              checkboxValue: completeCleanupWorktree,
            });
            const completionSent = send({
              type: 'completeTask',
              taskId: pendingComplete.taskId,
              ...(cleanupOverride === undefined ? {} : { cleanupWorktree: cleanupOverride }),
              ...(completeFeedback ? { feedback: completeFeedback } : {}),
              ...(completeFeedback ? { requestReflect: completeRequestReflect } : {}),
            });
            if (completionSent) {
              selectNextTaskAfterCompletion(pendingComplete.agentId, pendingComplete.taskId);
            }
            closeCompleteConfirmation();
          }}
          onClose={closeCompleteConfirmation}
        />
      )}
      {activeModal === 'quickLaunch' && (
        <Suspense fallback={null}>
          <QuickLaunch send={send} onClose={closeModal} sttShortcutBinding={shortcutBindings.stt_toggle} />
        </Suspense>
      )}
      {activeModal === 'schedules' && (
        <Suspense fallback={null}>
          <SchedulesDialog
            onClose={() => { closeModal(); setSchedulePrefill(null); }}
            prefill={schedulePrefill ?? undefined}
            onCreated={(fromPrefill) => {
              if (!fromPrefill) return;
              // Close the dialog so the spotlighted command-palette trigger is
              // actually visible behind it, then show the discovery hint.
              closeModal();
              setSchedulePrefill(null);
              if (scheduledTasksHintShouldShow()) setScheduleHintActive(true);
            }}
          />
        </Suspense>
      )}
      {activeModal === 'costComparison' && (
        <Suspense fallback={null}>
          <CostComparisonPanel onClose={closeModal} />
        </Suspense>
      )}
      {activeModal === 'settings' && (
        <Suspense fallback={null}>
          <SettingsDialog
            onClose={() => { closeModal(); setSettingsFocus(undefined); }}
            focusField={settingsFocus}
            onSettingsSaved={(settings) => {
              setShortcutOverrides(settings.shortcutBindings ?? {});
              setSpeakVerbositySnapshot(settings.speakVerbosity);
              setCleanupWorktreeOnComplete(settings.cleanupWorktreeOnComplete);
            }}
          />
        </Suspense>
      )}
      {activeModal === 'bugReport' && bugReportDraft && (
        <BugReportDialog
          bundle={bugReportDraft.bundle}
          serialized={bugReportDraft.serialized}
          note={bugReportNote}
          onNoteChange={setBugReportNote}
          onClose={() => {
            closeModal();
            setBugReportNote('');
          }}
        />
      )}
      {activeModal === 'shareViewer' && (
        <ShareViewerDialog onClose={closeModal} />
      )}
      {ossShowView && (
        <Suspense fallback={null}>
          <OssProductivityView
            onClose={closeOssView}
            onBrowsePlaybooks={() => {
              openLaunchFromPalette('playbooks', 'oss_empty_cta');
            }}
          />
        </Suspense>
      )}
      {activeModal === 'workspace' && selectedProject && (
        <Suspense fallback={null}>
          <ContributionWorkspace
            send={send}
            projectId={selectedProject}
            onClose={() => { closeModal(); clearWorkspaceView(); }}
          />
        </Suspense>
      )}
      <OnboardingTour onLaunchFirstTask={() => openLaunchFromPalette('manual', 'onboarding_tour')} />
      {scheduleHintActive && (
        <ScheduledTasksHint onHide={() => setScheduleHintActive(false)} />
      )}
      {activeModal === 'launch' && (
        <Suspense fallback={null}>
          <LaunchTaskDialog
            key={`launch-${launchDialogGeneration}-${launchInitialTab ?? 'manual'}`}
            send={send}
            onClose={handleCloseLaunch}
            defaultCwd={relaunchTask?.cwd}
            defaultPrompt={relaunchTask?.prompt}
            defaultCriteria={relaunchTask?.criteria}
            defaultAgentType={relaunchTask?.agentType}
            relaunchPlaybookId={relaunchTask?.playbookId}
            relaunchParameterValues={relaunchTask?.playbookParameterValues}
            projectContext={launchProjectContext ?? undefined}
            projectCwd={launchProjectCwd ?? undefined}
            initialTab={launchInitialTab ?? undefined}
            sttShortcutBinding={shortcutBindings.stt_toggle}
          />
        </Suspense>
      )}
    </div>
  );
}
