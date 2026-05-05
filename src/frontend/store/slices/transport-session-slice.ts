import type { TransportSessionSlice, StoreSet } from '../store-types.js';

export function createTransportSessionSlice(set: StoreSet): TransportSessionSlice {
  return {
    agents: [],
    agentsHydrated: false,
    connected: false,
    terminalOutput: {},
    serverCwd: '',
    availableAgentTypes: [],
    defaultAgentType: 'claude-code',
    buildInfo: null,
    serverStartedAt: null,
    playbooks: [],
    playbooksLoading: false,
    playbooksLastFetchedAt: 0,
    playbooksLastFetchedCwd: '',
    sttUrl: '',
    activeSTTInputId: null,
    totalSpendUsd: 0,

    handleSnapshot: (agents, serverCwd, build, serverStartedAt, sttEnabled, sttUrl, totalSpendUsd, achievements, availableAgentTypes, defaultAgentType, workspaceEnabled, sweepRunning) => {
      set({
        agents,
        agentsHydrated: true,
        ...(serverCwd !== undefined ? { serverCwd } : {}),
        ...(availableAgentTypes !== undefined ? { availableAgentTypes } : {}),
        ...(defaultAgentType !== undefined ? { defaultAgentType } : {}),
        ...(build !== undefined ? { buildInfo: build } : {}),
        ...(serverStartedAt !== undefined ? { serverStartedAt } : {}),
        ...(sttEnabled && sttUrl ? { sttUrl } : {}),
        ...(totalSpendUsd !== undefined ? { totalSpendUsd } : {}),
        ...(achievements !== undefined ? { achievements } : {}),
        ...(workspaceEnabled !== undefined ? { workspaceEnabled } : {}),
        ...(sweepRunning !== undefined ? { sweepRunning } : {}),
      });
    },

    handleUpdate: (agentId, state) => {
      set((prev) => ({
        agents: prev.agents.map((agent) => (agent.agentId === agentId ? state : agent)),
      }));
    },

    handlePlaybooks: (playbooks, cwd) => {
      set({
        playbooks,
        playbooksLoading: false,
        playbooksLastFetchedAt: Date.now(),
        playbooksLastFetchedCwd: cwd,
      });
    },

    setConnected: (connected) => {
      set({ connected });
    },

    setTerminalOutput: (agentId, output) => {
      set((prev) => ({
        terminalOutput: { ...prev.terminalOutput, [agentId]: output },
      }));
    },

    setPlaybooksLoading: (loading) => {
      set({ playbooksLoading: loading });
    },

    setActiveSTTInput: (id) => {
      set({ activeSTTInputId: id });
    },
  };
}
