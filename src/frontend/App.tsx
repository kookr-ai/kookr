import React, { lazy, Suspense, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { ProjectSummary } from '../shared/protocol.js';
import { deriveLaunchProjectCwd } from './derive-project-cwd.js';
import { useKookrStore } from './store/useStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useNotifications } from './hooks/useNotifications.js';
import { useAudibleAlert } from './hooks/useAudibleAlert.js';
import { useTaskCompletionChime } from './hooks/useTaskCompletionChime.js';
import { sendToTerminal } from './terminal-send.js';
import { track } from './telemetry.js';
import { buildAgentBuckets } from './agent-buckets.js';
import { deriveProjectPriorityRanks } from '../shared/project-sidebar.js';
import { TopBar } from './components/TopBar.js';
import { FindingsPanel } from './components/FindingsPanel.js';
import { DetailPanel } from './components/DetailPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { Toasts } from './components/Toasts.js';
import { BugReportDialog } from './components/BugReportDialog.js';
import { AchievementToasts } from './components/AchievementToast.js';
import { SentOverlay } from './components/SentOverlay.js';
import { SnoozeDialog } from './components/SnoozeDialog.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { CompleteDialogFooter } from './components/CompleteDialogFooter.js';
import type { TaskCompletionFeedback } from '../shared/contracts/messages.js';
import { ProjectSidebar } from './components/ProjectSidebar.js';
import { ProjectDetailDrawer } from './components/ProjectDetailDrawer.js';
import type { SettingsFocusField } from './components/SettingsDialog.js';
import { SweepButton } from './components/SweepButton.js';
import { OnboardingTour } from './components/OnboardingTour.js';
import { CoordinatorFindingsPane } from './components/CoordinatorSurfaces.js';
import { maybeOpenForFirstRun } from './store/onboarding-store.js';
import {
  detectShortcutPlatform,
  formatShortcutBinding,
  matchesShortcutAction,
  resolveShortcutBindings,
  type PlatformShortcutBindingOverrides,
} from '../shared/contracts/shortcut-bindings.js';
import { buildBugReportBundle } from './bug-report-bundle.js';
import { getBugReportAlerts, getBugReportWireObservations } from './bug-report-recorder.js';
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

interface ReflectionSuggestion {
  sessionId: string;
  summary: string;
  sessionLabel: string;
  totalInterventions: number;
  totalFindings: number;
}

type MobileDashboardTab = 'findings' | 'task';
type LaunchInitialTab = 'manual' | 'playbooks';

interface PendingCompleteConfirmation {
  taskId: string;
  agentId: string;
  label: string;
  method: 'button' | 'shortcut';
}

const MOBILE_BREAKPOINT_PX = 768;

function reflectionDismissKey(sessionId: string): string {
  return `kookr-reflection-dismissed-${sessionId}`;
}

export function App() {
  const { send } = useWebSocket();
  useNotifications();
  // Audible alerts. Findings are unfocused (anomaly chimes regardless of
  // which task is focused — that's when the user most needs to switch).
  // Completion is focus-gated (only the watched task chimes; non-focused
  // completions are surfaced visually in the completed list). See
  // docs/rfc/rfc-task-chime-browser.md §6.
  useAudibleAlert();
  useTaskCompletionChime();
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT_PX : false,
  );
  const [mobileTab, setMobileTab] = useState<MobileDashboardTab>('findings');
  const [showLaunch, setShowLaunch] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'complete' | null>(null);
  const [pendingComplete, setPendingComplete] = useState<PendingCompleteConfirmation | null>(null);
  const [completeFeedback, setCompleteFeedback] = useState<TaskCompletionFeedback | undefined>(undefined);
  const [showProjectSidebarManager, setShowProjectSidebarManager] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocusField | undefined>(undefined);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showCostComparison, setShowCostComparison] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const [showCoordinatorFindings, setShowCoordinatorFindings] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [bugReportNote, setBugReportNote] = useState('');
  const [shortcutOverrides, setShortcutOverrides] = useState<PlatformShortcutBindingOverrides>({});
  const [launchProjectContext, setLaunchProjectContext] = useState<ProjectSummary | null>(null);
  const [launchProjectCwd, setLaunchProjectCwd] = useState<string | null>(null);
  const [launchInitialTab, setLaunchInitialTab] = useState<LaunchInitialTab | null>(null);
  const [reflectionSuggestion, setReflectionSuggestion] = useState<ReflectionSuggestion | null>(null);
  const operationsPopoverRef = useRef<HTMLDivElement>(null);
  const terminalFocusTriggerRef = useRef<HTMLButtonElement>(null);
  const shortcutPlatform = useMemo(() => detectShortcutPlatform(), []);
  const shortcutBindings = useMemo(
    () => resolveShortcutBindings(shortcutPlatform, shortcutOverrides),
    [shortcutOverrides, shortcutPlatform],
  );
  const {
    agents,
    agentsHydrated,
    buildInfo,
    serverStartedAt,
    selectedAgentId,
    selectAgent,
    nextBottleneck,
    nextTask,
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
    terminalFocusMode,
    setNarrowTab,
    toggleTerminalFocusMode,
  } = useKookrStore();

  useEffect(() => {
    void import('./styles.css');
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/settings')
      .then((r) => r.json())
      .then((settings: { shortcutBindings?: PlatformShortcutBindingOverrides }) => {
        if (!cancelled) setShortcutOverrides(settings.shortcutBindings ?? {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Open launch dialog when relaunchTask is set
  useEffect(() => {
    if (relaunchTask) {
      setShowLaunch(true);
    }
  }, [relaunchTask]);

  // First-run onboarding tour: opens once per browser when localStorage has
  // no current onboarding seen key. Idempotent on subsequent reloads.
  useEffect(() => {
    maybeOpenForFirstRun();
  }, []);

  useEffect(() => {
    function updateViewportMode() {
      setIsMobileViewport(window.innerWidth <= MOBILE_BREAKPOINT_PX);
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
      setShowOperations(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowOperations(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showOperations]);

  const selectedProjectSummary = selectedProject
    ? projectSummaries.find((p) => p.project === selectedProject) ?? null
    : null;
  const terminalFocusActive = terminalFocusMode && !isMobileViewport;
  const bugReportDraft = useMemo(() => {
    if (!showBugReport) return null;
    return buildBugReportBundle({
      agents,
      selectedAgentId,
      selectedProject,
      buildInfo,
      serverStartedAt,
      alerts: getBugReportAlerts(),
      wireObservations: getBugReportWireObservations(),
      note: bugReportNote,
    });
  }, [agents, bugReportNote, buildInfo, selectedAgentId, selectedProject, serverStartedAt, showBugReport]);

  useEffect(() => {
    if (isMobileViewport && terminalFocusMode) {
      setNarrowTab('activity');
    }
  }, [isMobileViewport, setNarrowTab, terminalFocusMode]);

  useEffect(() => {
    if (!terminalFocusActive) return;
    const raf = window.requestAnimationFrame(() => {
      terminalFocusTriggerRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [terminalFocusActive]);

  function handleCloseLaunch() {
    setShowLaunch(false);
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
      setShowLaunch(true);
    }
  }, [selectedProjectSummary, agents]);

  const handleRunPlaybook = useCallback(() => {
    if (selectedProjectSummary) {
      setLaunchProjectContext(selectedProjectSummary);
      setLaunchProjectCwd(deriveLaunchProjectCwd(agents, selectedProjectSummary) ?? '');
      setLaunchInitialTab('playbooks');
      track({ type: 'launch_dialog_opened', method: 'project_drawer' });
      setShowLaunch(true);
    }
  }, [selectedProjectSummary, agents]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((showOperations || showBugReport) && e.key !== 'Escape') {
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
        setShowQuickLaunch(true);
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
          setShowSnooze(true);
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'quick_snooze')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const durationMs = 5 * 60 * 1000; // 5-minute default snooze
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.quick_snooze), action: 'quick_snooze', context: 'global' });
          const selected = useKookrStore.getState().agents.find((agent) => agent.agentId === state.selectedAgentId);
          send({ type: 'snooze', agentId: state.selectedAgentId, taskId: selected?.taskId, durationMs });
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'focus_reply')) {
        e.preventDefault();
        const replyInput = document.querySelector('.detail-panel .response-row input[type="text"]') as HTMLInputElement | null;
        if (replyInput) {
          track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.focus_reply), action: 'focus_reply', context: 'global' });
          replyInput.focus();
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'speak_finding')) {
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
          const speakButton = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="speak-finding-button"]'))
            .find((button) => button.dataset.agentId === state.selectedAgentId) ?? null;
          if (speakButton && !speakButton.disabled) {
            e.preventDefault();
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.speak_finding), action: 'speak_finding', context: 'global' });
            speakButton.click();
          }
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'cancel_task')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const agent = state.agents.find(a => a.agentId === state.selectedAgentId);
          if (agent?.taskId) {
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.cancel_task), action: 'cancel_task', context: 'global' });
            setConfirmAction('cancel');
          }
        }
      }
      if (matchesShortcutAction(e, shortcutBindings, 'complete_task')) {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const agent = state.agents.find(a => a.agentId === state.selectedAgentId);
          if (agent?.taskId) {
            track({ type: 'shortcut_used', key: formatShortcutBinding(shortcutBindings.complete_task), action: 'complete_task', context: 'global' });
            setPendingComplete({
              taskId: agent.taskId,
              agentId: agent.agentId,
              label: agent.taskName ?? agent.agentId,
              method: 'shortcut',
            });
            setConfirmAction('complete');
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
        if (isMobileViewport) return;
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
        sendToTerminal(digit);
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
          setShowShortcuts((v) => !v);
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
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileViewport, nextBottleneck, nextTask, previousTask, send, shortcutBindings, showBugReport, showOperations, toggleProjectSidebar, toggleTerminalFocusMode, selectProject, toggleAchievementsPanel]);

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

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId) ?? null;
  const projectPriorityRanks = useMemo(
    () => deriveProjectPriorityRanks(projectSummaries, projectSidebarPrefs),
    [projectSummaries, projectSidebarPrefs],
  );
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
    () => buildAgentBuckets(agents, selectedProject, coordinator, projectPriorityRanks),
    [agents, selectedProject, coordinator, projectPriorityRanks],
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

  // Clear-completed counts are derived from UNFILTERED agents so the confirm
  // dialog never promises a narrower sweep than the server performs. The server
  // has no project scope in clearCompleted — it operates globally — so the
  // counts shown to the user must also be global. Per review, showing filtered
  // counts here would produce "Delete 2 finished tasks?" while silently
  // sweeping 12 across other projects.
  const globalFinishedCount = agents.filter((a) => a.taskStatus === 'completed' || a.taskStatus === 'cancelled').length;
  const globalTerminatedCount = agents.filter((a) => a.taskStatus === 'terminated').length;

  const findingsPanel = (
    <FindingsPanel
      findings={findings}
      healthy={healthy}
      pending={pending}
      completed={completed}
      snoozed={snoozed}
      selectedAgentId={selectedAgentId}
      send={send}
      globalFinishedCount={globalFinishedCount}
      globalTerminatedCount={globalTerminatedCount}
    />
  );

  const detailPanel = (
    <DetailPanel
      agent={selectedAgent}
      send={send}
      onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'empty_panel' }); setShowLaunch(true); }}
      onRequestComplete={() => {
        if (!selectedAgent?.taskId) return;
        setPendingComplete({
          taskId: selectedAgent.taskId,
          agentId: selectedAgent.agentId,
          label: selectedAgent.taskName ?? selectedAgent.agentId,
          method: 'button',
        });
        setConfirmAction('complete');
      }}
      collapsed={!isMobileViewport && !selectedAgent}
      terminalFocusMode={terminalFocusActive}
      shortcutBindings={shortcutBindings}
    />
  );

  const openSettingsAtMaxActiveTasks = () => {
    setSettingsFocus('maxActiveTasks');
    setShowSettings(true);
  };
  const projectSidebar = !terminalFocusActive && (
    <ProjectSidebar
      onManage={() => setShowProjectSidebarManager(true)}
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
        setShowWorkspace(true);
      } : undefined}
      onLaunchManual={handleLaunchManualTask}
      onRunPlaybook={handleRunPlaybook}
      compact={isMobileViewport}
    />
  );

  return (
    <div className={`app${isMobileViewport ? ' app-mobile' : ''}`}>
      <TopBar
        findings={findings.length}
        currentIndex={selectedAgent && selectedAgent.anomaly
          ? findings.findIndex((f) => f.agentId === selectedAgentId)
          : -1}
        totalFindings={findings.length}
        compact={isMobileViewport}
        onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'button' }); setShowLaunch(true); }}
        onSchedules={() => setShowSchedules(true)}
        onSettings={() => { setSettingsFocus(undefined); setShowSettings(true); }}
        onShowShortcuts={() => setShowShortcuts(true)}
        onOssView={toggleOssView}
        onOperations={() => setShowOperations((value) => !value)}
        onBugReport={() => setShowBugReport(true)}
        operationsOpen={showOperations}
        onCoordinatorFindings={() => setShowCoordinatorFindings((value) => !value)}
        coordinatorFindingsOpen={showCoordinatorFindings}
        terminalFocusMode={terminalFocusMode}
        terminalFocusTriggerRef={terminalFocusTriggerRef}
        onTerminalFocusToggle={() => {
          track({ type: 'shortcut_used', key: 'TopBar Terminal Focus', action: 'toggle_terminal_focus', context: 'click' });
          toggleTerminalFocusMode();
        }}
        onCostComparison={() => setShowCostComparison(true)}
        sweepSlot={workspaceEnabled ? <SweepButton send={send} projectCount={projectSummaries.length} /> : undefined}
      />
      {showOperations && (
        <div className="operations-popover-shell" ref={operationsPopoverRef}>
          <Suspense fallback={null}>
            <OperationsPanel send={send} onClose={() => setShowOperations(false)} />
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
          <div className="main main-mobile">
            {projectDetailDrawer}
            {!terminalFocusActive && <CoordinatorFindingsPane open={showCoordinatorFindings} onClose={() => setShowCoordinatorFindings(false)} />}
            {mobileTab === 'findings' ? findingsPanel : detailPanel}
          </div>
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
            <button
              type="button"
              className="mobile-action-btn mobile-action-btn-primary"
              data-testid="mobile-action-launch"
              onClick={() => {
                track({ type: 'launch_dialog_opened', method: 'mobile_action' });
                setShowLaunch(true);
              }}
            >
              Launch
            </button>
          </div>
        </>
      ) : (
        <div className="main">
          {projectSidebar}
          {projectDetailDrawer}
          {!terminalFocusActive && <CoordinatorFindingsPane open={showCoordinatorFindings} onClose={() => setShowCoordinatorFindings(false)} />}
          {findingsPanel}
          {detailPanel}
        </div>
      )}
      <StatusBar
        findings={findings.length}
        total={filteredAgents.length}
        compact={isMobileViewport}
        onShowShortcuts={() => setShowShortcuts(true)}
        reflectionSuggestion={reflectionSuggestion}
        onReflect={triggerReflection}
        onDismissReflection={dismissReflectionSuggestion}
        shortcutBindings={shortcutBindings}
      />
      <Toasts />
      <AchievementToasts />
      <SentOverlay />
      {showShortcuts && (
        <Suspense fallback={null}>
          <ShortcutsHelp
            bindings={shortcutBindings}
            onClose={() => setShowShortcuts(false)}
          />
        </Suspense>
      )}
      {showAchievements && (
        <Suspense fallback={null}>
          <AchievementsPanel onClose={toggleAchievementsPanel} send={send} shortcutBindings={shortcutBindings} />
        </Suspense>
      )}
      {showProjectSidebarManager && (
        <Suspense fallback={null}>
          <ProjectSidebarManager onClose={() => setShowProjectSidebarManager(false)} />
        </Suspense>
      )}
      {showSnooze && selectedAgent && (
        <SnoozeDialog
          agentId={selectedAgent.agentId}
          agentName={selectedAgent.taskName ?? selectedAgent.agentId}
          onSnooze={(durationMs) => {
            send({ type: 'snooze', agentId: selectedAgent.agentId, taskId: selectedAgent.taskId, durationMs });
            setShowSnooze(false);
          }}
          onClose={() => setShowSnooze(false)}
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
              onChange={setCompleteFeedback}
            />
          }
          onConfirm={() => {
            track({ type: 'task_completed', agentId: pendingComplete.agentId, method: pendingComplete.method });
            send({
              type: 'completeTask',
              taskId: pendingComplete.taskId,
              ...(completeFeedback ? { feedback: completeFeedback } : {}),
            });
            setConfirmAction(null);
            setPendingComplete(null);
            setCompleteFeedback(undefined);
          }}
          onClose={() => {
            setConfirmAction(null);
            setPendingComplete(null);
            setCompleteFeedback(undefined);
          }}
        />
      )}
      {showQuickLaunch && (
        <Suspense fallback={null}>
          <QuickLaunch send={send} onClose={() => setShowQuickLaunch(false)} sttShortcutBinding={shortcutBindings.stt_toggle} />
        </Suspense>
      )}
      {showSchedules && (
        <Suspense fallback={null}>
          <SchedulesDialog onClose={() => setShowSchedules(false)} />
        </Suspense>
      )}
      {showCostComparison && (
        <Suspense fallback={null}>
          <CostComparisonPanel onClose={() => setShowCostComparison(false)} />
        </Suspense>
      )}
      {showSettings && (
        <Suspense fallback={null}>
          <SettingsDialog
            onClose={() => { setShowSettings(false); setSettingsFocus(undefined); }}
            focusField={settingsFocus}
            onSettingsSaved={(settings) => setShortcutOverrides(settings.shortcutBindings ?? {})}
          />
        </Suspense>
      )}
      {showBugReport && bugReportDraft && (
        <BugReportDialog
          bundle={bugReportDraft.bundle}
          serialized={bugReportDraft.serialized}
          note={bugReportNote}
          onNoteChange={setBugReportNote}
          onClose={() => {
            setShowBugReport(false);
            setBugReportNote('');
          }}
        />
      )}
      {ossShowView && (
        <Suspense fallback={null}>
          <OssProductivityView onClose={closeOssView} />
        </Suspense>
      )}
      {showWorkspace && selectedProject && (
        <Suspense fallback={null}>
          <ContributionWorkspace
            send={send}
            projectId={selectedProject}
            onClose={() => { setShowWorkspace(false); clearWorkspaceView(); }}
          />
        </Suspense>
      )}
      <OnboardingTour />
      {showLaunch && (
        <Suspense fallback={null}>
          <LaunchTaskDialog
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
