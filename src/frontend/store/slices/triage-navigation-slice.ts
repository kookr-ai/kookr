import type { TriageNavigationSlice, StoreGet, StoreSet } from '../store-types.js';
import { isDndEnabled } from '../../hooks/useDnd.js';
import { compareRoutableAgents } from '../../agent-priority-order.js';
import { deriveProjectPriorityRanks } from '../../../shared/project-sidebar.js';
import { recordReportableAlert } from '../../bug-report-recorder.js';

const TERMINAL_FOCUS_STORAGE_KEY = 'kookr-terminal-focus-mode';

function loadTerminalFocusMode(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(TERMINAL_FOCUS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveTerminalFocusMode(enabled: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (enabled) {
      localStorage.setItem(TERMINAL_FOCUS_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(TERMINAL_FOCUS_STORAGE_KEY);
    }
  } catch {
    // Persistence is best-effort; focus mode should still toggle in memory.
  }
}

export function createTriageNavigationSlice(set: StoreSet, get: StoreGet): TriageNavigationSlice {
  function getPriorityOrderContext() {
    const state = get();
    return {
      chipTaskIds: new Set((state.coordinator?.chips ?? []).map((chip) => chip.taskId)),
      originalIndex: new Map(state.agents.map((agent, index) => [agent.agentId, index])),
      projectPriorityRanks: deriveProjectPriorityRanks(state.projectSummaries, state.projectSidebarPrefs),
    };
  }

  return {
    selectedAgentId: null,
    alerts: [],
    relaunchTask: null,
    sentOverlay: null,
    githubState: {},
    leftPane: 'activity',
    narrowTab: 'activity',
    terminalFocusMode: loadTerminalFocusMode(),
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
      const { agents, selectedAgentId } = get();
      const order = getPriorityOrderContext();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
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

      set({ selectedAgentId: findings[nextIdx].agentId, selectedAgentSource: 'manual', shortcutsArmed: false });
    },

    nextTask: () => {
      const { agents, selectedAgentId } = get();
      const order = getPriorityOrderContext();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => compareRoutableAgents(left, right, order));
      const healthy = agents
        .filter((agent) => agent.anomaly === null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => compareRoutableAgents(left, right, { ...order, includeSeverity: false }));
      const all = [...findings, ...healthy];

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % all.length : 0;
      set({ selectedAgentId: all[nextIdx].agentId, selectedAgentSource: 'manual' });
    },

    previousTask: () => {
      const { agents, selectedAgentId } = get();
      const order = getPriorityOrderContext();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => compareRoutableAgents(left, right, order));
      const healthy = agents
        .filter((agent) => agent.anomaly === null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => compareRoutableAgents(left, right, { ...order, includeSeverity: false }));
      const all = [...findings, ...healthy];

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const prevIdx = currentIdx >= 0 ? (currentIdx - 1 + all.length) % all.length : all.length - 1;
      set({ selectedAgentId: all[prevIdx].agentId, selectedAgentSource: 'manual' });
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

    setTerminalFocusMode: (enabled) => {
      saveTerminalFocusMode(enabled);
      set({
        terminalFocusMode: enabled,
        ...(enabled ? { narrowTab: 'terminal' as const } : {}),
      });
    },

    toggleTerminalFocusMode: () => {
      const enabled = !get().terminalFocusMode;
      saveTerminalFocusMode(enabled);
      set({
        terminalFocusMode: enabled,
        ...(enabled ? { narrowTab: 'terminal' as const } : {}),
      });
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
