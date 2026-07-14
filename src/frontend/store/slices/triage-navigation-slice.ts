import type { DetailPaneMode, TriageNavigationSlice, StoreGet, StoreSet } from '../store-types.js';
import type { AgentState } from '../../../shared/protocol.js';
import { isDndEnabled } from '../../hooks/useDnd.js';
import { buildRoutableOrder, compareRoutableAgents } from '../../agent-priority-order.js';
import { deriveProjectPriorityRanks } from '../../../shared/project-sidebar.js';
import { recordReportableAlert } from '../../bug-report-recorder.js';
import { withSelectionTransitionSource } from '../../selection-transition-recorder.js';
import { saveSelectedProject } from '../selected-project-storage.js';
import { isActiveFinding } from '../finding-helpers.js';

const TERMINAL_FOCUS_STORAGE_KEY = 'kookr-terminal-focus-mode';
const DETAIL_PANE_MODE_STORAGE_KEY = 'kookr-detail-panel-mode';

function isDetailPaneMode(value: string | null): value is DetailPaneMode {
  return value === 'split' || value === 'left' || value === 'right';
}

function saveDetailPaneMode(mode: DetailPaneMode): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    if (mode === 'split') {
      localStorage.removeItem(DETAIL_PANE_MODE_STORAGE_KEY);
    } else {
      localStorage.setItem(DETAIL_PANE_MODE_STORAGE_KEY, mode);
    }
    localStorage.removeItem(TERMINAL_FOCUS_STORAGE_KEY);
    return true;
  } catch {
    // Persistence is best-effort; panel mode should still change in memory.
    console.warn('Kookr: failed to persist detail pane mode');
    return false;
  }
}

function loadDetailPaneMode(): DetailPaneMode {
  try {
    if (typeof localStorage === 'undefined') return 'split';
    const stored = localStorage.getItem(DETAIL_PANE_MODE_STORAGE_KEY);
    if (isDetailPaneMode(stored)) return stored;
    if (stored !== null) {
      console.warn(`Kookr: ignoring invalid detail pane mode "${stored}"`);
      localStorage.removeItem(DETAIL_PANE_MODE_STORAGE_KEY);
      return 'split';
    }

    const legacy = localStorage.getItem(TERMINAL_FOCUS_STORAGE_KEY);
    if (legacy === '1') {
      try {
        localStorage.setItem(DETAIL_PANE_MODE_STORAGE_KEY, 'right');
      } catch {
        console.warn('Kookr: failed to write migrated terminal focus mode preference');
      }
      try {
        localStorage.removeItem(TERMINAL_FOCUS_STORAGE_KEY);
      } catch {
        console.warn('Kookr: failed to remove legacy terminal focus mode preference');
      }
      return 'right';
    }
    if (legacy !== null) {
      localStorage.removeItem(TERMINAL_FOCUS_STORAGE_KEY);
    }
    return 'split';
  } catch {
    return 'split';
  }
}

function activateNavigationSelection(
  agent: AgentState,
  visibleProjectIds: Set<string>,
): { selectedAgentId: string; selectedTaskId: string | null; selectedAgentSource: 'manual'; selectedProject: string | null } {
  const projectId = agent?.projectId ?? null;
  const selectedProject = projectId && visibleProjectIds.has(projectId) ? projectId : null;
  saveSelectedProject(selectedProject);
  return { selectedAgentId: agent.agentId, selectedTaskId: agent.taskId ?? null, selectedAgentSource: 'manual', selectedProject };
}

function matchesSelection(agent: AgentState, selectedAgentId: string | null, selectedTaskId: string | null): boolean {
  if (agent.agentId !== selectedAgentId) return false;
  return selectedTaskId ? agent.taskId === selectedTaskId : true;
}

export function createTriageNavigationSlice(set: StoreSet, get: StoreGet): TriageNavigationSlice {
  const initialDetailPaneMode = loadDetailPaneMode();

  function getPriorityOrderContext() {
    const state = get();
    return {
      chipTaskIds: new Set((state.coordinator?.chips ?? []).map((chip) => chip.taskId)),
      originalIndex: new Map(state.agents.map((agent, index) => [agent.agentId, index])),
      projectPriorityRanks: deriveProjectPriorityRanks(state.projectSummaries, state.projectSidebarPrefs),
    };
  }

  function orderedRoutableAgents(exclude: (agent: AgentState) => boolean = () => false) {
    const agents = get().agents.filter((agent) => !exclude(agent));
    return buildRoutableOrder(agents, getPriorityOrderContext());
  }

  return {
    selectedAgentId: null,
    selectedTaskId: null,
    alerts: [],
    relaunchTask: null,
    sentOverlay: null,
    githubState: {},
    leftPane: 'activity',
    narrowTab: 'activity',
    detailPaneMode: initialDetailPaneMode,
    terminalFocusMode: initialDetailPaneMode === 'right',
    suggestions: {},
    focusZone: 'none',
    respondAllAgentIds: null,
    shortcutsArmed: true,

    handleAlert: (agentId, summary, severity, details) => {
      const resolved = severity ?? (summary.startsWith('Error:') ? 'error' : 'info');
      recordReportableAlert({ agentId, summary, details, severity: resolved });
      // DND silences in-app toasts at the emit site so anomaly detection keeps
      // running and findings still update; only the visual alert is suppressed.
      if (isDndEnabled()) return;
      // Focus guard (F20): while the user is actively composing (reply input
      // or terminal focused), suppress toasts that originate from a DIFFERENT
      // live agent so unrelated agents can't interleave over focused work.
      // The alert is still recorded above and the finding still surfaces in
      // the rail. Non-agent alerts (agentId '' / 'workspace' / 'viewer' — not
      // present in `agents`) always show: they are feedback for the user's
      // own action.
      const { focusZone, selectedAgentId, agents } = get();
      if (
        focusZone !== 'none'
        && agentId !== selectedAgentId
        && agents.some((agent) => agent.agentId === agentId)
      ) {
        return;
      }
      set((prev) => ({
        alerts: [...prev.alerts, { agentId, summary, details, severity: resolved, timestamp: new Date() }],
      }));
    },

    handleSuggestion: (agentId, suggestions, quickActions) => {
      if (suggestions.length === 0 && quickActions.length === 0) {
        set((prev) => {
          const { [agentId]: _ignored, ...rest } = prev.suggestions;
          return { suggestions: rest };
        });
        return;
      }

      set((prev) => ({
        suggestions: { ...prev.suggestions, [agentId]: { agentId, suggestions, quickActions } },
      }));
    },

    clearSuggestion: (agentId) => {
      set((prev) => {
        const { [agentId]: _ignored, ...rest } = prev.suggestions;
        return { suggestions: rest };
      });
    },

    handleGitHubUpdate: (taskId, prs, issues, changes) => {
      set((prev) => ({
        githubState: {
          ...prev.githubState,
          [taskId]: { taskId, prs, issues, changes },
        },
      }));
    },

    selectAgent: (agentId, taskId) => {
      // selectedAgentSource: 'manual' marks this selection as a user choice
      // (rather than an auto-advance landing) so the engagement guard fires.
      withSelectionTransitionSource({ source: 'selectAgent', reason: agentId ? 'manual_select' : 'manual_deselect' }, () => {
        const selected = agentId
          ? get().agents.find((agent) => (
              agent.agentId === agentId
              && (taskId === undefined || agent.taskId === taskId)
            )) ?? get().agents.find((agent) => agent.agentId === agentId)
          : null;
        set({
          selectedAgentId: agentId,
          selectedTaskId: selected?.taskId ?? taskId ?? null,
          selectedAgentSource: 'manual',
          ...(agentId === null ? { focusZone: 'none' as const } : {}),
          respondAllAgentIds: null,
          leftPane: 'activity',
          narrowTab: 'activity',
        });
      });
    },

    nextBottleneck: () => {
      const { selectedAgentId, selectedTaskId, visibleProjectSummaries } = get();
      const agents = get().agents;
      const order = getPriorityOrderContext();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const findings = agents
        .filter(isActiveFinding)
        .sort((left, right) => compareRoutableAgents(left, right, order));

      if (findings.length === 0) {
        withSelectionTransitionSource({ source: 'nextBottleneck', reason: 'no_active_findings' }, () => {
          set({ selectedAgentId: null, selectedTaskId: null, selectedAgentSource: 'manual', focusZone: 'none', shortcutsArmed: false });
        });
        return;
      }

      const currentIdx = findings.findIndex((agent) => matchesSelection(agent, selectedAgentId, selectedTaskId));
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % findings.length : 0;
      if (matchesSelection(findings[nextIdx], selectedAgentId, selectedTaskId)) {
        withSelectionTransitionSource({ source: 'nextBottleneck', reason: 'only_current_finding' }, () => {
          set({ selectedAgentId: null, selectedTaskId: null, selectedAgentSource: 'manual', focusZone: 'none', shortcutsArmed: false });
        });
        return;
      }

      withSelectionTransitionSource({ source: 'nextBottleneck', reason: 'cycle_active_findings' }, () => {
        set({ ...activateNavigationSelection(findings[nextIdx], visibleProjectIds), shortcutsArmed: false });
      });
    },

    nextTask: () => {
      const { selectedAgentId, selectedTaskId, visibleProjectSummaries } = get();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents();

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => matchesSelection(agent, selectedAgentId, selectedTaskId));
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % all.length : 0;
      withSelectionTransitionSource({ source: 'nextTask', reason: 'cycle_routable_tasks' }, () => {
        set(activateNavigationSelection(all[nextIdx], visibleProjectIds));
      });
    },

    selectNextTaskAfterCompletion: (completedAgentId, completedTaskId) => {
      const { selectedAgentId, selectedTaskId, visibleProjectSummaries } = get();
      // If the user changed focus while the dialog was open, keep their newer
      // selection instead of advancing from the older completion target.
      if (selectedAgentId !== completedAgentId) return;
      if (completedTaskId && selectedTaskId && selectedTaskId !== completedTaskId) return;

      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents((agent) => (
        completedTaskId ? agent.taskId === completedTaskId : agent.agentId === completedAgentId
      ));

      if (all.length === 0) {
        withSelectionTransitionSource({ source: 'selectNextTaskAfterCompletion', reason: 'no_remaining_candidates' }, () => {
          set({
            selectedAgentId: null,
            selectedTaskId: null,
            selectedAgentSource: 'manual',
            focusZone: 'none',
            respondAllAgentIds: null,
            shortcutsArmed: false,
          });
        });
        return;
      }

      withSelectionTransitionSource({ source: 'selectNextTaskAfterCompletion', reason: 'completed_task_advance' }, () => {
        set({
          ...activateNavigationSelection(all[0], visibleProjectIds),
          respondAllAgentIds: null,
          shortcutsArmed: false,
        });
      });
    },

    // Empty-Enter navigation is pure cursor movement — it never dismisses a
    // finding. While any active findings exist, cycle among them only so the
    // most urgent work is never buried under healthy tasks; if the sole finding
    // is already selected, stay put (nextBottleneck would wrap onto self and
    // deselect). With zero findings, cycle the healthy tasks until a finding
    // appears, at which point the next Enter jumps to it. Shared by the reply
    // input, the terminal, and the global window-level Enter handler.
    advanceEmptyEnter: () => {
      const { agents, selectedAgentId } = get();
      const findings = agents.filter(isActiveFinding);
      if (findings.length === 0) {
        withSelectionTransitionSource({ source: 'advanceEmptyEnter', reason: 'no_findings_cycle_tasks' }, () => {
          get().nextTask();
        });
        return;
      }
      if (findings.length === 1 && findings[0].agentId === selectedAgentId) {
        return;
      }
      withSelectionTransitionSource({ source: 'advanceEmptyEnter', reason: 'cycle_findings' }, () => {
        get().nextBottleneck();
      });
    },

    previousTask: () => {
      const { selectedAgentId, selectedTaskId, visibleProjectSummaries } = get();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents();

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => matchesSelection(agent, selectedAgentId, selectedTaskId));
      const prevIdx = currentIdx >= 0 ? (currentIdx - 1 + all.length) % all.length : all.length - 1;
      withSelectionTransitionSource({ source: 'previousTask', reason: 'cycle_routable_tasks' }, () => {
        set(activateNavigationSelection(all[prevIdx], visibleProjectIds));
      });
    },

    snoozeAgent: (agentId, durationMs) => {
      const { agents, selectedAgentId } = get();
      const updated = agents.map((agent) =>
        agent.agentId === agentId ? { ...agent, snoozedUntil: Date.now() + durationMs } : agent,
      );
      set({ agents: updated });

      if (agentId === selectedAgentId) {
        get().nextBottleneck();
      }
    },

    dismissAlert: (index) => {
      set((prev) => ({
        alerts: prev.alerts.filter((_, alertIndex) => alertIndex !== index),
      }));
    },

    setRelaunchTask: (task) => {
      set({ relaunchTask: task });
    },

    clearRelaunchTask: () => {
      set({ relaunchTask: null });
    },

    showSentOverlay: (agentName) => {
      set({ sentOverlay: { agentName } });
    },

    clearSentOverlay: () => {
      set({ sentOverlay: null });
    },

    setLeftPane: (pane) => {
      set({ leftPane: pane });
    },

    setNarrowTab: (tab) => {
      set({ narrowTab: tab });
    },

    setDetailPaneMode: (mode) => {
      saveDetailPaneMode(mode);
      set({
        detailPaneMode: mode,
        terminalFocusMode: mode === 'right',
        ...(mode === 'right' ? { narrowTab: 'terminal' as const } : {}),
      });
    },

    setTerminalFocusMode: (enabled) => {
      get().setDetailPaneMode(enabled ? 'right' : 'split');
    },

    toggleTerminalFocusMode: () => {
      get().setDetailPaneMode(get().detailPaneMode === 'right' ? 'split' : 'right');
    },

    setFocusZone: (zone) => {
      if (get().focusZone === zone) return;
      set({ focusZone: zone });
    },

    setRespondAllAgentIds: (agentIds) => {
      set({ respondAllAgentIds: agentIds });
    },

    armShortcuts: () => {
      if (!get().shortcutsArmed) {
        set({ shortcutsArmed: true });
      }
    },
  };
}
