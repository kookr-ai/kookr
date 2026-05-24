import type { AgentState, TransportSessionSlice, StoreSet } from '../store-types.js';
import { SEVERITY_ORDER } from '../store-types.js';
import { mergeActivityAgent } from '../activity-history.js';
import { firstReadyKookrSTTEndpoint } from '../../../shared/contracts/speech.js';

function isTerminalTaskStatus(status: AgentState['taskStatus']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

function isUserDismissedTaskStatus(status: AgentState['taskStatus']): boolean {
  return status === 'completed' || status === 'cancelled';
}

function isActionableFinding(agent: AgentState): boolean {
  return (
    agent.anomaly !== null
    && !agent.snoozedUntil
    && !agent.suppressed
    && agent.taskStatus !== 'pending'
    && !isTerminalTaskStatus(agent.taskStatus)
  );
}

function nextActionableFindingId(agents: AgentState[], excludingAgentId: string): string | null {
  const findings = agents
    .filter((agent) => agent.agentId !== excludingAgentId && isActionableFinding(agent))
    .sort((left, right) => SEVERITY_ORDER[left.anomaly!.severity] - SEVERITY_ORDER[right.anomaly!.severity]);

  return findings[0]?.agentId ?? null;
}

function selectedAgentUpdateAfterServerState(
  selectedAgentId: string | null,
  previousAgents: AgentState[],
  nextAgents: AgentState[],
): { selectedAgentId?: string | null; selectedAgentSource?: 'manual'; respondAllAgentIds?: null; leftPane?: 'activity'; narrowTab?: 'activity'; shortcutsArmed?: false } {
  if (!selectedAgentId) return {};

  const previousSelected = previousAgents.find((agent) => agent.agentId === selectedAgentId);
  const nextSelected = nextAgents.find((agent) => agent.agentId === selectedAgentId);
  if (!nextSelected) {
    // Server evicted the agent. Tag as 'manual' so the engagement guard isn't
    // confused into thinking the (now null) selection is an auto-advance landing.
    return { selectedAgentId: null, selectedAgentSource: 'manual', respondAllAgentIds: null };
  }

  if (
    previousSelected
    && !isUserDismissedTaskStatus(previousSelected.taskStatus)
    && isUserDismissedTaskStatus(nextSelected.taskStatus)
  ) {
    return {
      selectedAgentId: nextActionableFindingId(nextAgents, selectedAgentId),
      selectedAgentSource: 'manual',
      respondAllAgentIds: null,
      leftPane: 'activity',
      narrowTab: 'activity',
      shortcutsArmed: false,
    };
  }

  return {};
}

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
    hostCapabilities: {},
    sttUrl: '',
    ttsUrl: '',
    speechCapabilities: null,
    activeSTTInputId: null,
    totalSpendUsd: 0,
    maxActiveTasks: 0,
    coordinator: null,

    handleSnapshot: (agents, serverCwd, build, serverStartedAt, sttEnabled, sttUrl, totalSpendUsd, achievements, availableAgentTypes, defaultAgentType, workspaceEnabled, sweepRunning, maxActiveTasks, speechCapabilities, coordinator, ttsUrl) => {
      set((prev) => {
        const previousById = new Map(prev.agents.map((agent) => [agent.agentId, agent]));
        const mergedAgents = agents.map((agent) => mergeActivityAgent(previousById.get(agent.agentId), agent));
        const descriptorSttUrl = firstReadyKookrSTTEndpoint(speechCapabilities);
        const nextSttUrl = sttEnabled && sttUrl ? sttUrl : descriptorSttUrl;
        return {
          agents: mergedAgents,
          ...selectedAgentUpdateAfterServerState(prev.selectedAgentId, prev.agents, mergedAgents),
          agentsHydrated: true,
          ...(serverCwd !== undefined ? { serverCwd } : {}),
          ...(availableAgentTypes !== undefined ? { availableAgentTypes } : {}),
          ...(defaultAgentType !== undefined ? { defaultAgentType } : {}),
          ...(build !== undefined ? { buildInfo: build } : {}),
          ...(serverStartedAt !== undefined ? { serverStartedAt } : {}),
          ...(nextSttUrl ? { sttUrl: nextSttUrl } : {}),
          ...(ttsUrl !== undefined ? { ttsUrl } : {}),
          ...(speechCapabilities !== undefined ? { speechCapabilities } : {}),
          ...(totalSpendUsd !== undefined ? { totalSpendUsd } : {}),
          ...(achievements !== undefined ? { achievements } : {}),
          ...(workspaceEnabled !== undefined ? { workspaceEnabled } : {}),
          ...(sweepRunning !== undefined ? { sweepRunning } : {}),
          ...(maxActiveTasks !== undefined ? { maxActiveTasks } : {}),
          ...(coordinator !== undefined ? { coordinator } : {}),
        };
      });
    },

    handleUpdate: (agentId, state) => {
      set((prev) => {
        const agents = prev.agents.map((agent) => (
          agent.agentId === agentId ? mergeActivityAgent(agent, state) : agent
        ));
        return {
          agents,
          ...selectedAgentUpdateAfterServerState(prev.selectedAgentId, prev.agents, agents),
        };
      });
    },

    handlePlaybooks: (playbooks, cwd, capabilities) => {
      set({
        playbooks,
        hostCapabilities: capabilities ?? {},
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
