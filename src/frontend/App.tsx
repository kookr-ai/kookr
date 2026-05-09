import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { ProjectSummary } from '../core/project-summary.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import type { TaskStatus } from '../core/types.js';
import { deriveLaunchProjectCwd } from './derive-project-cwd.js';
import { useKookrStore } from './store/useStore.js';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useNotifications } from './hooks/useNotifications.js';
import { useAudibleAlert } from './hooks/useAudibleAlert.js';
import { sendToTerminal } from './terminal-send.js';
import { track } from './telemetry.js';
import { isActiveFinding } from './store/finding-helpers.js';
import { TopBar } from './components/TopBar.js';
import { FindingsPanel } from './components/FindingsPanel.js';
import { DetailPanel } from './components/DetailPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { LaunchTaskDialog } from './components/LaunchTaskDialog.js';
import { QuickLaunch } from './components/QuickLaunch.js';
import { Toasts } from './components/Toasts.js';
import { AchievementToasts } from './components/AchievementToast.js';
import { SentOverlay } from './components/SentOverlay.js';
import { ShortcutsHelp } from './components/ShortcutsHelp.js';
import { AchievementsPanel } from './components/AchievementsPanel.js';
import { SnoozeDialog } from './components/SnoozeDialog.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { CompleteDialogFooter } from './components/CompleteDialogFooter.js';
import type { TaskCompletionFeedback } from '../shared/contracts/messages.js';
import { ProjectSidebar } from './components/ProjectSidebar.js';
import { ProjectDetailDrawer } from './components/ProjectDetailDrawer.js';
import { ProjectSidebarManager } from './components/ProjectSidebarManager.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { SchedulesDialog } from './components/SchedulesDialog.js';
import { ContributionWorkspace } from './components/ContributionWorkspace.js';
import { SweepButton } from './components/SweepButton.js';
import { OssProductivityView } from './components/OssProductivityView.js';
import { CostComparisonPanel } from './components/CostComparisonPanel.js';
import { OnboardingTour } from './components/OnboardingTour.js';
import { maybeOpenForFirstRun } from './store/onboarding-store.js';
import './styles.css';

interface ReflectionSuggestion {
  sessionId: string;
  summary: string;
  sessionLabel: string;
  totalInterventions: number;
  totalFindings: number;
}

type MobileDashboardTab = 'findings' | 'task';

const MOBILE_BREAKPOINT_PX = 768;

function reflectionDismissKey(sessionId: string): string {
  return `kookr-reflection-dismissed-${sessionId}`;
}

export function App() {
  const { send } = useWebSocket();
  useNotifications();
  useAudibleAlert();
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= MOBILE_BREAKPOINT_PX : false,
  );
  const [mobileTab, setMobileTab] = useState<MobileDashboardTab>('findings');
  const [showLaunch, setShowLaunch] = useState(false);
  const [showQuickLaunch, setShowQuickLaunch] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSnooze, setShowSnooze] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'complete' | null>(null);
  const [completeFeedback, setCompleteFeedback] = useState<TaskCompletionFeedback | undefined>(undefined);
  const [showProjectSidebarManager, setShowProjectSidebarManager] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSchedules, setShowSchedules] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showCostComparison, setShowCostComparison] = useState(false);
  const [launchProjectContext, setLaunchProjectContext] = useState<ProjectSummary | null>(null);
  const [launchProjectCwd, setLaunchProjectCwd] = useState<string | null>(null);
  const [reflectionSuggestion, setReflectionSuggestion] = useState<ReflectionSuggestion | null>(null);
  const {
    agents,
    agentsHydrated,
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
    showAchievements,
    toggleAchievementsPanel,
    workspaceEnabled,
    clearWorkspaceView,
    handleAlert,
    ossShowView,
    closeOssView,
    toggleOssView,
  } = useKookrStore();

  // Open launch dialog when relaunchTask is set
  useEffect(() => {
    if (relaunchTask) {
      setShowLaunch(true);
    }
  }, [relaunchTask]);

  // First-run onboarding tour: opens once per browser when localStorage has
  // no `kookr:onboarding:seen-v1` key. Idempotent on subsequent reloads.
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

  const selectedProjectSummary = selectedProject
    ? projectSummaries.find((p) => p.project === selectedProject) ?? null
    : null;

  function handleCloseLaunch() {
    setShowLaunch(false);
    setLaunchProjectContext(null);
    setLaunchProjectCwd(null);
    clearRelaunchTask();
  }

  const handleRunPlaybook = useCallback(() => {
    if (selectedProjectSummary) {
      setLaunchProjectContext(selectedProjectSummary);
      setLaunchProjectCwd(deriveLaunchProjectCwd(agents, selectedProjectSummary) ?? '');
      track({ type: 'launch_dialog_opened', method: 'project_drawer' });
      setShowLaunch(true);
    }
  }, [selectedProjectSummary, agents]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+N', action: 'next_bottleneck', context: 'global' });
        nextBottleneck();
      }
      if (e.altKey && e.key === 'l') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+L', action: 'quick_launch', context: 'global' });
        setShowQuickLaunch(true);
      }
      if (e.altKey && e.key === 'm') {
        e.preventDefault();
        // Alt+M toggles voice recording — target the right mic button
        // 1. If any button is currently recording, stop it
        const recording = document.querySelector('.btn-voice.recording') as HTMLButtonElement | null;
        if (recording) {
          track({ type: 'shortcut_used', key: 'Alt+M', action: 'stt_toggle', context: 'global' });
          recording.click();
        } else {
          // 2. Find the mic button nearest the focused element (sibling in same row/label)
          const focused = document.activeElement as HTMLElement | null;
          const nearestMic = focused?.closest('.response-row, label, .quick-launch-bar')
            ?.querySelector('.btn-voice:not(:disabled)') as HTMLButtonElement | null;
          // 3. Fall back to the first visible non-disabled mic button
          const target = nearestMic ?? document.querySelector('.btn-voice:not(:disabled)') as HTMLButtonElement | null;
          if (target) {
            track({ type: 'shortcut_used', key: 'Alt+M', action: 'stt_toggle', context: 'global' });
            target.click();
          }
        }
      }
      if (e.altKey && e.key === 's') {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          track({ type: 'shortcut_used', key: 'Alt+S', action: 'snooze_dialog', context: 'global' });
          setShowSnooze(true);
        }
      }
      if (e.altKey && e.key === 'z') {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const durationMs = 5 * 60 * 1000; // 5-minute default snooze
          track({ type: 'shortcut_used', key: 'Alt+Z', action: 'quick_snooze', context: 'global' });
          const selected = useKookrStore.getState().agents.find((agent) => agent.agentId === state.selectedAgentId);
          send({ type: 'snooze', agentId: state.selectedAgentId, taskId: selected?.taskId, durationMs });
        }
      }
      if (e.altKey && e.key === 'r') {
        e.preventDefault();
        const replyInput = document.querySelector('.detail-panel .response-row input[type="text"]') as HTMLInputElement | null;
        if (replyInput) {
          track({ type: 'shortcut_used', key: 'Alt+R', action: 'focus_reply', context: 'global' });
          replyInput.focus();
        }
      }
      if (e.altKey && e.key === 'Delete') {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const agent = state.agents.find(a => a.agentId === state.selectedAgentId);
          if (agent?.taskId) {
            track({ type: 'shortcut_used', key: 'Alt+Delete', action: 'cancel_task', context: 'global' });
            setConfirmAction('cancel');
          }
        }
      }
      if (e.altKey && e.key === 'End') {
        e.preventDefault();
        const state = useKookrStore.getState();
        if (state.selectedAgentId) {
          const agent = state.agents.find(a => a.agentId === state.selectedAgentId);
          if (agent?.taskId) {
            track({ type: 'shortcut_used', key: 'Alt+End', action: 'complete_task', context: 'global' });
            setConfirmAction('complete');
          }
        }
      }
      // Alt+P toggles project sidebar
      if (e.altKey && e.key === 'p') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+P', action: 'toggle_project_sidebar', context: 'global' });
        toggleProjectSidebar();
      }
      // Alt+A toggles achievements panel
      if (e.altKey && e.key === 'a') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+A', action: 'toggle_achievements', context: 'global' });
        toggleAchievementsPanel();
      }
      // Alt+0 = All projects
      if (e.altKey && e.key === '0') {
        e.preventDefault();
        selectProject(null);
      }
      // Alt+1-3 = send digit to terminal, then skip to next task
      if (e.altKey && e.key >= '1' && e.key <= '3') {
        e.preventDefault();
        sendToTerminal(e.key);
        track({ type: 'shortcut_used', key: `Alt+${e.key}`, action: 'terminal_send_and_next', context: 'global' });
        nextTask();
      }
      // Alt+4-9 = select project by sidebar order
      if (e.altKey && e.key >= '4' && e.key <= '9') {
        e.preventDefault();
        const idx = parseInt(e.key, 10) - 4;
        const state = useKookrStore.getState();
        if (idx < state.visibleProjectSummaries.length) {
          selectProject(state.visibleProjectSummaries[idx].project);
        }
      }
      // Escape to deselect current task — works from any context except inside dialogs
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const inDialog = (e.target as HTMLElement)?.closest('.dialog-overlay');
        if (!inDialog) {
          const state = useKookrStore.getState();
          if (state.selectedAgentId !== null) {
            e.preventDefault();
            (document.activeElement as HTMLElement)?.blur();
            track({ type: 'shortcut_used', key: 'Escape', action: 'deselect', context: 'global' });
            selectAgent(null);
          }
        }
      }
      // ? to open shortcuts help — only when not focused on an input/textarea
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setShowShortcuts((v) => !v);
        }
      }
      // Alt+J = next task, Alt+K = previous task
      if (e.altKey && e.key === 'j') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+J', action: 'next_task', context: 'global' });
        nextTask();
      }
      if (e.altKey && e.key === 'k') {
        e.preventDefault();
        track({ type: 'shortcut_used', key: 'Alt+K', action: 'previous_task', context: 'global' });
        previousTask();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextBottleneck, nextTask, previousTask, send, toggleProjectSidebar, selectProject, toggleAchievementsPanel]);

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

  // Filter agents by selected project
  const filteredAgents = useMemo(() => {
    if (!selectedProject) return agents;
    return agents.filter((a) => a.projectId === selectedProject);
  }, [agents, selectedProject]);

  const selectedAgent = agents.find((a) => a.agentId === selectedAgentId) ?? null;
  // Exhaustiveness helper: treats undefined as "no task → not terminal".
  const isTerminal = (s: TaskStatus | undefined): boolean => s !== undefined && isTerminalStatus(s);
  const pending = filteredAgents.filter((a) => a.taskStatus === 'pending');
  // 'completed' pane surfaces every task the user is "done with": completed,
  // cancelled, AND terminated. The distinction matters for the ack flow and
  // clearCompleted scoping (see D2), but visually they're grouped.
  const completed = filteredAgents.filter((a) => isTerminal(a.taskStatus));
  const snoozed = filteredAgents
    .filter((a) => a.taskStatus !== 'pending' && !isTerminal(a.taskStatus) && (!!a.snoozedUntil || a.suppressed))
    .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0));
  const findings = filteredAgents.filter((a) => a.taskStatus !== 'pending' && !isTerminal(a.taskStatus) && isActiveFinding(a));
  // 'healthy' = actively running tasks (not pending, not in any terminal state).
  // Terminal states include 'terminated' after rfc-task-loss-prevention.
  const healthy = filteredAgents.filter((a) => a.anomaly === null && !a.snoozedUntil && !a.suppressed && a.taskStatus !== 'pending' && !isTerminal(a.taskStatus));
  const activeTaskCount = agents.filter((agent) => !isTerminal(agent.taskStatus)).length;
  const completedTaskCount = agents.filter((agent) => isTerminal(agent.taskStatus)).length;

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
      collapsed={!isMobileViewport && !selectedAgent}
    />
  );

  const projectSidebar = <ProjectSidebar onManage={() => setShowProjectSidebarManager(true)} />;

  const projectDetailDrawer = selectedProjectSummary && (
    <ProjectDetailDrawer
      project={selectedProjectSummary}
      onClose={() => selectProject(null)}
      send={send}
      onOpenWorkspace={workspaceEnabled ? () => {
        setShowWorkspace(true);
      } : undefined}
      onRunPlaybook={handleRunPlaybook}
      compact={!isMobileViewport && Boolean(selectedAgent)}
    />
  );

  return (
    <div className={`app${isMobileViewport ? ' app-mobile' : ''}`}>
      <TopBar
        findings={findings.length}
        healthyAgents={healthy}
        currentIndex={selectedAgent && selectedAgent.anomaly
          ? findings.findIndex((f) => f.agentId === selectedAgentId)
          : -1}
        totalFindings={findings.length}
        compact={isMobileViewport}
        onLaunch={() => { track({ type: 'launch_dialog_opened', method: 'button' }); setShowLaunch(true); }}
        onSchedules={() => setShowSchedules(true)}
        onSettings={() => setShowSettings(true)}
        onShowShortcuts={() => setShowShortcuts(true)}
        onOssView={toggleOssView}
        onCostComparison={() => setShowCostComparison(true)}
        sweepSlot={workspaceEnabled ? <SweepButton send={send} projectCount={projectSummaries.length} /> : undefined}
      />
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
      />
      <Toasts />
      <AchievementToasts />
      <SentOverlay />
      {showShortcuts && <ShortcutsHelp onClose={() => setShowShortcuts(false)} />}
      {showAchievements && <AchievementsPanel onClose={toggleAchievementsPanel} send={send} />}
      {showProjectSidebarManager && (
        <ProjectSidebarManager onClose={() => setShowProjectSidebarManager(false)} />
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
      {confirmAction === 'complete' && selectedAgent?.taskId && (
        <ConfirmDialog
          title="Complete Task"
          message={`Mark "${selectedAgent.taskName ?? selectedAgent.agentId}" as complete?`}
          confirmLabel="Complete"
          suppressEnterToConfirm={completeFeedback !== undefined}
          footer={
            <CompleteDialogFooter
              feedback={completeFeedback}
              onChange={setCompleteFeedback}
            />
          }
          onConfirm={() => {
            track({ type: 'task_completed', agentId: selectedAgent.agentId, method: 'shortcut' });
            send({
              type: 'completeTask',
              taskId: selectedAgent.taskId!,
              ...(completeFeedback ? { feedback: completeFeedback } : {}),
            });
            setConfirmAction(null);
            setCompleteFeedback(undefined);
          }}
          onClose={() => {
            setConfirmAction(null);
            setCompleteFeedback(undefined);
          }}
        />
      )}
      {showQuickLaunch && (
        <QuickLaunch send={send} onClose={() => setShowQuickLaunch(false)} />
      )}
      {showSchedules && <SchedulesDialog onClose={() => setShowSchedules(false)} />}
      {showCostComparison && <CostComparisonPanel onClose={() => setShowCostComparison(false)} />}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {ossShowView && <OssProductivityView onClose={closeOssView} />}
      {showWorkspace && selectedProject && (
        <ContributionWorkspace
          send={send}
          projectId={selectedProject}
          onClose={() => { setShowWorkspace(false); clearWorkspaceView(); }}
        />
      )}
      <OnboardingTour />
      {showLaunch && (
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
        />
      )}
    </div>
  );
}
