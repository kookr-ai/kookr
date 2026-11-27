import { describe, expect, test } from 'vitest';
import type { Task } from '../../core/tasks.js';
import type { ServerMessage, SystemResourceStatus } from '../../shared/contracts/messages.js';
import type { FleetVitalsSample } from '../../shared/contracts/fleet-vitals.js';
import { createFleetVitalsService, listLiveAgentTasks } from './create-fleet-vitals-service.js';

function fakeTask(id: string, status: Task['status'], outputTokens?: number): Task {
  return {
    id,
    status,
    tokenUsage: outputTokens === undefined
      ? undefined
      : { inputTokens: 1, outputTokens, cacheReadTokens: 2, cacheWriteTokens: 3, costUsd: 0.5 },
  } as unknown as Task;
}

const STATUS: SystemResourceStatus = {
  source: { kind: 'server-host' },
  sampledAt: '2026-11-27T18:00:00.000Z',
  sampleGapMs: 2_000,
  timerDriftMs: 0,
  host: {
    cpuUsagePercent: 40,
    memoryUsedPercent: 50,
    memoryFreeBytes: 8,
    memoryTotalBytes: 16,
    dataDirectory: { path: null, diskFreeBytes: null, diskTotalBytes: null, diskFreePercent: null },
  },
  server: { eventLoopDelayP95Ms: 5, processRssBytes: 1, processHeapUsedBytes: 1, processHeapTotalBytes: 1 },
  unavailable: [],
};

describe('listLiveAgentTasks', () => {
  test('keeps only tasks whose agent is running, with their token totals', () => {
    const live = listLiveAgentTasks([
      fakeTask('running', 'inProgress', 700),
      fakeTask('no-usage-yet', 'inProgress'),
      fakeTask('queued', 'pending', 10),
      fakeTask('not-started', 'open'),
    ]);
    expect(live).toEqual([
      { id: 'running', tokens: { inputTokens: 1, outputTokens: 700, cacheReadTokens: 2, cacheWriteTokens: 3 } },
      { id: 'no-usage-yet', tokens: null },
    ]);
  });
});

describe('createFleetVitalsService', () => {
  function build(hasDashboardClients: boolean) {
    let refreshes = 0;
    const sent: FleetVitalsSample[] = [];
    const service = createFleetVitalsService({
      taskStore: { viewLiveTasks: () => [fakeTask('a', 'inProgress', 100), fakeTask('b', 'pending')] },
      monitor: { getFleetSubagentCount: () => 4 },
      broadcastToAll: (msg: ServerMessage) => { if (msg.type === 'fleetVitals') sent.push(msg.sample); },
      hasDashboardClients: () => hasDashboardClients,
      gpuProbe: {
        refresh: async () => { refreshes += 1; },
        snapshot: () => ({ devices: [], ageMs: null, unavailable: 'warming_up' }),
      },
    });
    return { service, sent, refreshes: () => refreshes };
  }

  test('reads agents from the task store and subagents from the monitor', () => {
    const { service, sent } = build(true);
    service.observeResourceStatus(STATUS);
    expect(sent).toHaveLength(1);
    expect(sent[0].fleet.agents).toBe(1);
    expect(sent[0].fleet.subagents).toBe(4);
    expect(sent[0].machine.cpuUsagePercent).toBe(40);
    expect(sent[0].machine.logicalCpuCount).toBeGreaterThan(0);
  });

  test('runs the GPU command only while a dashboard is connected', () => {
    const watched = build(true);
    watched.service.observeResourceStatus(STATUS);
    expect(watched.refreshes()).toBe(1);

    const unwatched = build(false);
    unwatched.service.observeResourceStatus(STATUS);
    expect(unwatched.refreshes()).toBe(0);
    // The sample itself is still produced, so the history fills while nobody watches.
    expect(unwatched.sent).toHaveLength(1);
  });
});
