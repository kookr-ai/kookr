import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { Monitor } from '../../core/monitor.js';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { PrLessonsDiscovery, PrLessonsStateHolder } from '../../core/pr-lessons-discovery.js';
import { ProjectConfigStore } from '../../core/project-config-store.js';
import { ProjectSidebarStore } from '../../core/project-sidebar-store.js';
import { SkillDiscoveryStateHolder, SkillTrackedRepoDiscovery } from '../../core/skill-tracked-repo-discovery.js';
import { TaskStore } from '../../core/tasks.js';
import type { ServerMessage, SnapshotMessage } from '../../shared/contracts/messages.js';
import { createRealtimeServices } from './create-realtime-services.js';

function fakeAdapter(agentType: AgentAdapter['agentType']): AgentAdapter {
  return {
    agentType,
    async launch() { return 'session'; },
    async sendInput() {},
    async sendKeystroke() {},
    async stop() {},
    async captureDisplay() { return ''; },
    onEvent() {},
    onRefreshNeeded() {},
    injectHookEvent() {},
    getEffectiveHookSettings() { return undefined; },
  };
}

describe('createRealtimeServices', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('broadcastToAll enriches snapshots before sending to connected clients', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
    const taskStore = new TaskStore();
    const staleTask = taskStore.createTask('Ship it', '/repo');
    const mutableTask = taskStore.getTaskForMutation(staleTask.id)!;
    mutableTask.sessions.push({
      tmuxSession: 'kookr-stale',
      agentType: 'codex-cli',
      cwd: '/repo',
      createdAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    taskStore.startTask(staleTask.id);
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(fakeAdapter('claude-code'));
    adapterRegistry.register(fakeAdapter('codex-cli'));
    const ossAttemptStore = new OssAttemptStore(tempDir);

    const realtime = await createRealtimeServices({
      kookrDir: tempDir,
      taskStore,
      queue,
      monitor,
      adapterRegistry,
      serverCwd: '/repo',
      ledgerAnalytics: new LedgerAnalytics(ossAttemptStore),
      projectConfigStore: new ProjectConfigStore(tempDir),
      projectSidebarStore: new ProjectSidebarStore(tempDir),
      skillDiscoveryState: new SkillDiscoveryStateHolder(new SkillTrackedRepoDiscovery(join(tempDir, 'claude'))),
      prLessonsState: new PrLessonsStateHolder(new PrLessonsDiscovery(join(tempDir, 'claude'))),
      getRegistryActiveProjects: () => [],
      getRegistryActiveRepos: () => [],
      ossAttemptStore,
      getDefaultAgentType: () => 'claude-code',
    });

    const sent: ServerMessage[] = [];
    realtime.clients.add({
      readyState: WebSocket.OPEN,
      send: (data: string) => sent.push(JSON.parse(data) as ServerMessage),
    } as unknown as WebSocket);

    realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(expect.objectContaining({
      type: 'snapshot',
      totalSpendUsd: 0,
      achievements: expect.any(Object),
      defaultAgentType: 'claude-code',
    }));
    expect(sent[1]).toEqual({
      type: 'coordinator.snapshot',
      coordinator: (sent[0] as SnapshotMessage).coordinator,
    });
    expect((sent[0] as SnapshotMessage).availableAgentTypes?.map((item) => item.type)).toEqual([
      'claude-code',
      'codex-cli',
    ]);
    expect((sent[0] as SnapshotMessage).coordinator?.outputs).toEqual([
      expect.objectContaining({
        detectorId: 'stale',
        taskId: staleTask.id,
      }),
    ]);
    expect(realtime.getWsBroadcastCount()).toBe(1);
  });
});
