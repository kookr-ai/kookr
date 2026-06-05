import type { DetailPaneMode, TriageNavigationSlice, StoreGet, StoreSet } from '../store-types.js';
import type { AgentState } from '../../../shared/protocol.js';
import { isDndEnabled } from '../../hooks/useDnd.js';
import { compareRoutableAgents } from '../../agent-priority-order.js';
import { deriveProjectPriorityRanks } from '../../../shared/project-sidebar.js';
import { recordReportableAlert } from '../../bug-report-recorder.js';
import { saveSelectedProject } from '../selected-project-storage.js';
import { isActiveFinding, isHealthyRunning } from '../finding-helpers.js';

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
  agents: AgentState[],
  agentId: string,
  visibleProjectIds: Set<string>,
): { selectedAgentId: string; selectedAgentSource: 'manual'; selectedProject: string | null } {
  const projectId = agents.find((agent) => agent.agentId === agentId)?.projectId ?? null;
  const selectedProject = projectId && visibleProjectIds.has(projectId) ? projectId : null;
  saveSelectedProject(selectedProject);
  return { selectedAgentId: agentId, selectedAgentSource: 'manual', selectedProject };
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
    const agents = get().agents;
    const order = getPriorityOrderContext();
    const findings = agents
      .filter((agent) => !exclude(agent) && isActiveFinding(agent))
      .sort((left, right) => compareRoutableAgents(left, right, order));
    const healthy = agents
      .filter((agent) => !exclude(agent) && isHealthyRunning(agent))
      .sort((left, right) => compareRoutableAgents(left, right, { ...order, includeSeverity: false }));
    return [...findings, ...healthy];
  }

  return {
    selectedAgentId: null,
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

    selectAgent: (agentId) => {
      // selectedAgentSource: 'manual' marks this selection as a user choice
      // (rather than an auto-advance landing) so the engagement guard fires.
      set({ selectedAgentId: agentId, selectedAgentSource: 'manual', respondAllAgentIds: null, leftPane: 'activity', narrowTab: 'activity' });
    },

    nextBottleneck: () => {
      const { agents, selectedAgentId, visibleProjectSummaries } = get();
      const order = getPriorityOrderContext();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const findings = agents
        .filter(isActiveFinding)
        .sort((left, right) => compareRoutableAgents(left, right, order));

      if (findings.length === 0) {
        set({ selectedAgentId: null, selectedAgentSource: 'manual', shortcutsArmed: false });
        return;
      }

      const currentIdx = findings.findIndex((agent) => agent.agentId === selectedAgentId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % findings.length : 0;
      if (findings[nextIdx].agentId === selectedAgentId) {
        set({ selectedAgentId: null, selectedAgentSource: 'manual', shortcutsArmed: false });
        return;
      }

      set({ ...activateNavigationSelection(agents, findings[nextIdx].agentId, visibleProjectIds), shortcutsArmed: false });
    },

    nextTask: () => {
      const { agents, selectedAgentId, visibleProjectSummaries } = get();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents();

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % all.length : 0;
      set(activateNavigationSelection(agents, all[nextIdx].agentId, visibleProjectIds));
    },

    selectNextTaskAfterCompletion: (completedAgentId, completedTaskId) => {
      const { agents, selectedAgentId, visibleProjectSummaries } = get();
      // If the user changed focus while the dialog was open, keep their newer
      // selection instead of advancing from the older completion target.
      if (selectedAgentId !== completedAgentId) return;

      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents((agent) => (
        completedTaskId ? agent.taskId === completedTaskId : agent.agentId === completedAgentId
      ));

      if (all.length === 0) {
        set({
          selectedAgentId: null,
          selectedAgentSource: 'manual',
          respondAllAgentIds: null,
          shortcutsArmed: false,
        });
        return;
      }

      set({
        ...activateNavigationSelection(agents, all[0].agentId, visibleProjectIds),
        respondAllAgentIds: null,
        shortcutsArmed: false,
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
        get().nextTask();
        return;
      }
      if (findings.length === 1 && findings[0].agentId === selectedAgentId) {
        return;
      }
      get().nextBottleneck();
    },

    previousTask: () => {
      const { agents, selectedAgentId, visibleProjectSummaries } = get();
      const visibleProjectIds = new Set(visibleProjectSummaries.map((project) => project.project));
      const all = orderedRoutableAgents();

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const prevIdx = currentIdx >= 0 ? (currentIdx - 1 + all.length) % all.length : all.length - 1;
      set(activateNavigationSelection(agents, all[prevIdx].agentId, visibleProjectIds));
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
