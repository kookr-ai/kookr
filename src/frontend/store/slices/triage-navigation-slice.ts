import type { TriageNavigationSlice, StoreGet, StoreSet } from '../store-types.js';
import { SEVERITY_ORDER } from '../store-types.js';
import { isDndEnabled } from '../../hooks/useDnd.js';

export function createTriageNavigationSlice(set: StoreSet, get: StoreGet): TriageNavigationSlice {
  return {
    selectedAgentId: null,
    alerts: [],
    relaunchTask: null,
    sentOverlay: null,
    githubState: {},
    leftPane: 'activity',
    narrowTab: 'activity',
    suggestions: {},
    focusZone: 'none',
    respondAllAgentIds: null,
    shortcutsArmed: true,

    handleAlert: (agentId, summary, severity) => {
      // DND silences in-app toasts at the emit site so anomaly detection keeps
      // running and findings still update; only the visual alert is suppressed.
      if (isDndEnabled()) return;
      const resolved = severity ?? (summary.startsWith('Error:') ? 'error' : 'info');
      set((prev) => ({
        alerts: [...prev.alerts, { agentId, summary, severity: resolved, timestamp: new Date() }],
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
      set({ selectedAgentId: agentId, respondAllAgentIds: null, leftPane: 'activity', narrowTab: 'activity' });
    },

    nextBottleneck: () => {
      const { agents, selectedAgentId } = get();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => SEVERITY_ORDER[left.anomaly!.severity] - SEVERITY_ORDER[right.anomaly!.severity]);

      if (findings.length === 0) {
        set({ selectedAgentId: null, shortcutsArmed: false });
        return;
      }

      const currentIdx = findings.findIndex((agent) => agent.agentId === selectedAgentId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % findings.length : 0;
      if (findings[nextIdx].agentId === selectedAgentId) {
        set({ selectedAgentId: null, shortcutsArmed: false });
        return;
      }

      set({ selectedAgentId: findings[nextIdx].agentId, shortcutsArmed: false });
    },

    nextTask: () => {
      const { agents, selectedAgentId } = get();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => SEVERITY_ORDER[left.anomaly!.severity] - SEVERITY_ORDER[right.anomaly!.severity]);
      const healthy = agents.filter((agent) => agent.anomaly === null && !agent.snoozedUntil && !agent.suppressed);
      const all = [...findings, ...healthy];

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % all.length : 0;
      set({ selectedAgentId: all[nextIdx].agentId });
    },

    previousTask: () => {
      const { agents, selectedAgentId } = get();
      const findings = agents
        .filter((agent) => agent.anomaly !== null && !agent.snoozedUntil && !agent.suppressed)
        .sort((left, right) => SEVERITY_ORDER[left.anomaly!.severity] - SEVERITY_ORDER[right.anomaly!.severity]);
      const healthy = agents.filter((agent) => agent.anomaly === null && !agent.snoozedUntil && !agent.suppressed);
      const all = [...findings, ...healthy];

      if (all.length === 0) return;

      const currentIdx = all.findIndex((agent) => agent.agentId === selectedAgentId);
      const prevIdx = currentIdx >= 0 ? (currentIdx - 1 + all.length) % all.length : all.length - 1;
      set({ selectedAgentId: all[prevIdx].agentId });
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
