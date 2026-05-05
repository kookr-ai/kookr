import { describe, expect, it } from 'vitest';
import { createSnapshotMessage, getProjectSummaries, getSnapshotAgentsForClient, getSnapshotAgentsRaw } from './get-snapshot.js';
import type { AgentEvent } from '../../core/types.js';

// Matches the self-diagnostic's SNAPSHOT_SIZE_WARNING threshold in
// src/core/self-diagnostic.ts. The projected snapshot of realistic pathological
// fixtures must stay well under this, so the diagnostic becomes a useful signal
// again rather than a permanent warning.
const SNAPSHOT_SIZE_WARNING_BYTES = 500 * 1024;

describe('snapshot use cases', () => {
  it('creates a snapshot message with optional metadata', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', events: [], anomaly: null }] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      serverStartedAt: '2026-04-04T10:00:00.000Z',
      totalSpendUsd: 12.5,
      sttUrl: 'ws://localhost:8003',
      achievements: { first: '2026-04-04T10:00:00.000Z' },
      availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }] as any,
      defaultAgentType: 'claude-code',
    });

    expect(msg).toEqual(expect.objectContaining({
      type: 'snapshot',
      serverCwd: '/repo',
      sttEnabled: true,
      sttUrl: 'ws://localhost:8003',
      totalSpendUsd: 12.5,
      defaultAgentType: 'claude-code',
    }));
    expect(msg.agents).toHaveLength(1);
  });

  it('delegates raw snapshot reads to the monitor', () => {
    const agents = [{ agentId: 'x' }] as any;
    expect(getSnapshotAgentsRaw({ monitor: { getSnapshot: () => agents } as any })).toBe(agents);
  });

  it('projects events for client transport (strips toolResponse, keeps raw via Raw)', () => {
    const rawEvents: AgentEvent[] = [
      {
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Read',
        toolResponse: 'x'.repeat(20_000),
      },
    ];
    const agents = [{ agentId: 'a-1', events: rawEvents, anomaly: null }] as any;
    const monitor = { getSnapshot: () => agents } as any;

    const client = getSnapshotAgentsForClient({ monitor });
    expect(client[0].events[0]).not.toHaveProperty('toolResponse');

    const raw = getSnapshotAgentsRaw({ monitor });
    expect(raw[0].events[0]).toHaveProperty('toolResponse');
  });

  it('projected snapshot of a pathological fixture stays under SNAPSHOT_SIZE_WARNING', () => {
    // Modeled on real prod observations (6 agents, 50 events/agent, ~10 KB per
    // tool_result toolResponse). Pre-fix this was ~1.3 MB; post-fix it must
    // drop below the diagnostic's warning threshold.
    const AGENT_COUNT = 6;
    const EVENTS_PER_AGENT = 50;
    const TOOL_RESPONSE_BYTES = 10_000;

    const bigEvents: AgentEvent[] = Array.from({ length: EVENTS_PER_AGENT }, (_, i) => ({
      type: 'tool_result' as const,
      sessionId: 's1',
      toolName: 'Read',
      toolResponse: 'y'.repeat(TOOL_RESPONSE_BYTES),
      toolUseId: `tu_${i}`,
    }));
    const agents = Array.from({ length: AGENT_COUNT }, (_, i) => ({
      agentId: `a-${i}`,
      events: bigEvents,
      anomaly: null,
    })) as any;
    const monitor = { getSnapshot: () => agents } as any;

    const clientBytes = JSON.stringify(getSnapshotAgentsForClient({ monitor })).length;
    const rawBytes = JSON.stringify(getSnapshotAgentsRaw({ monitor })).length;

    // Sanity: the raw fixture is indeed pathological (far exceeds the warning).
    expect(rawBytes).toBeGreaterThan(SNAPSHOT_SIZE_WARNING_BYTES * 2);
    // Budget: projection brings it well under the diagnostic's warning.
    expect(clientBytes).toBeLessThan(SNAPSHOT_SIZE_WARNING_BYTES / 2);
    // And the reduction ratio is at least an order of magnitude.
    expect(clientBytes).toBeLessThan(rawBytes / 10);
  });

  it('includes workspaceEnabled: true in snapshot when set', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      workspaceEnabled: true,
    });

    expect(msg.workspaceEnabled).toBe(true);
  });

  it('omits workspaceEnabled when not set', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
    });

    expect(msg).not.toHaveProperty('workspaceEnabled');
  });

  it('omits workspaceEnabled when false', () => {
    const monitor = {
      getSnapshot: () => [] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      workspaceEnabled: false,
    });

    expect(msg).not.toHaveProperty('workspaceEnabled');
  });

  it('builds project summaries from the snapshot query path', () => {
    const summaries = getProjectSummaries({
      monitor: {
        getSnapshot: () => [{
          agentId: 'a-1',
          taskId: 'task-1',
          taskName: 'Test task',
          cwd: '/repo',
          status: 'running',
          events: [],
          anomaly: null,
        }] as any,
      } as any,
      ledgerAnalytics: {
        getTodayCount: () => 0,
        getWeekCount: () => 0,
        getAttemptsByProjectRecent: () => [],
        getProjects: () => [],
        getTodayBlockedEntries: () => [],
      } as any,
      projectConfigStore: {
        getConfig: () => undefined,
        getRateLimit: () => undefined,
        getAllConfigs: () => [],
        getEffectiveDailyLimit: () => undefined,
      } as any,
    });

    expect(summaries).toHaveLength(0);
  });
});
