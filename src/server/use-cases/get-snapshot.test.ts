import { describe, expect, it } from 'vitest';
import { buildLocalSpeechCapabilities, createSnapshotMessage, getProjectSummaries, getSnapshotAgentsForClient, getSnapshotAgentsRaw } from './get-snapshot.js';
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
      ttsUrl: 'http://localhost:8004',
      now: () => new Date('2026-05-15T22:00:00.000Z'),
      achievements: { first: '2026-04-04T10:00:00.000Z' },
      availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }] as any,
      defaultAgentType: 'claude-code',
    });

    expect(msg).toEqual(expect.objectContaining({
      type: 'snapshot',
      serverCwd: '/repo',
      sttEnabled: true,
      sttUrl: 'ws://localhost:8003',
      ttsEnabled: true,
      ttsUrl: 'http://localhost:8004',
      totalSpendUsd: 12.5,
      defaultAgentType: 'claude-code',
    }));
    expect(msg.speechCapabilities?.capabilitiesByDevice['local-node']).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'stt',
        protocol: 'kookr-stt-ws',
        endpointUrl: 'ws://localhost:8003',
        readiness: 'ready',
      }),
      expect.objectContaining({
        kind: 'tts',
        endpointUrl: 'http://localhost:8004',
        readiness: 'ready',
      }),
    ]));
    expect(msg.agents).toHaveLength(1);
  });

  it('builds no speech capability descriptors when STT/TTS are disabled', () => {
    expect(buildLocalSpeechCapabilities({})).toBeUndefined();
  });

  it('includes activity metadata when provider is wired', () => {
    const monitor = {
      getSnapshot: () => [{ agentId: 'a-1', events: [], anomaly: null }] as any,
    };

    const msg = createSnapshotMessage({
      monitor,
      serverCwd: '/repo',
      activityMetaProvider: {
        getActivityMeta: () => ({
          totalEventsSeen: 3,
          parentEventCount: 1,
          childEventCount: 1,
          foreignEventCount: 0,
          unknownParentageCount: 0,
          malformedRecordCount: 1,
          droppedRecordCount: 0,
          duplicateRecordCount: 0,
        }),
      },
    });

    expect(msg.agents[0].activityMeta).toMatchObject({
      totalEventsSeen: 3,
      childEventCount: 1,
      malformedRecordCount: 1,
    });
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

  it('projects finding evidence for client transport without raw pane excerpts', () => {
    const agents = [{
      agentId: 'a-1',
      events: [],
      anomaly: null,
      findingEvidenceAudit: {
        id: 'finding-1',
        agentId: 'a-1',
        anomalyType: 'needs_input',
        explanation: 'Waiting',
        detectedAt: '2026-05-18T10:00:00.000Z',
        updatedAt: '2026-05-18T10:00:05.000Z',
        status: 'active',
        verdict: 'supports_finding',
        observations: [{
          sampledAt: '2026-05-18T10:00:05.000Z',
          ageMs: 5_000,
          source: 'watchdog_tick',
          anomalyStillPresent: true,
          lastEventType: 'stop',
          eventCount: 1,
          paneHash: 'abc123',
          paneChangedSincePrevious: false,
          paneExcerpt: 'raw terminal contents',
        }],
        notes: [],
      },
    }] as any;
    const monitor = { getSnapshot: () => agents } as any;

    const client = getSnapshotAgentsForClient({ monitor });
    expect(client[0].findingEvidenceAudit?.observations[0]).not.toHaveProperty('paneExcerpt');

    const raw = getSnapshotAgentsRaw({ monitor });
    expect(raw[0].findingEvidenceAudit.observations[0]).toHaveProperty('paneExcerpt');
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

  it('stamps active-task GitHub overlay fields when getTaskGithubReferences is supplied', () => {
    const summaries = getProjectSummaries({
      monitor: {
        getSnapshot: () => [{
          agentId: 'a-1',
          taskId: 'task-1',
          taskName: 'Fix #42',
          taskStatus: 'inProgress',
          projectId: 'github.com/octo/cat',
          cwd: '/repo',
          events: [],
          anomaly: null,
          summary: '',
          summarizedAt: null,
          lastActivityAt: 0,
        }] as any,
      } as any,
      ledgerAnalytics: {
        getTodayCount: () => 0,
        getWeekCount: () => 0,
        getAttemptsByProject: () => [],
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
      getTaskGithubReferences: (taskId: string) => taskId === 'task-1' ? [{
        type: 'issue' as const,
        owner: 'octo',
        repo: 'cat',
        number: 42,
        url: 'https://github.com/octo/cat/issues/42',
        detectedAt: new Date(),
        detectedFrom: 'agent-1',
        taskId: 'task-1',
      }] : [],
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].openIssuesTiedToActiveTasks).toBe(1);
    expect(summaries[0].openPrsTiedToActiveTasks).toBe(0);
    expect(summaries[0].activeTaskGithubLinks).toHaveLength(1);
    expect(summaries[0].activeTaskGithubLinks?.[0]).toMatchObject({
      kind: 'issue', number: 42, taskId: 'task-1', taskName: 'Fix #42',
    });
  });
});
