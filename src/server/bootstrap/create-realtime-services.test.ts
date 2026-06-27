import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
import { createRealtimeServices, type RealtimeServicesDeps } from './create-realtime-services.js';

type SnapshotPayloadTestOverrides = Pick<
  RealtimeServicesDeps,
  'snapshotPayloadWarnBytes' | 'snapshotPayloadMaxBytes' | 'observeSnapshotPayloadSize'
>;

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

async function createTestRealtimeServices(
  tempDir: string,
  overrides: {
    taskStore?: TaskStore;
    queue?: AttentionQueue;
    monitor?: Monitor;
    adapterRegistry?: AdapterRegistry;
    ossAttemptStore?: OssAttemptStore;
  } & SnapshotPayloadTestOverrides = {},
) {
  const taskStore = overrides.taskStore ?? new TaskStore();
  const queue = overrides.queue ?? new AttentionQueue();
  const monitor = overrides.monitor ?? new Monitor(taskStore, queue);
  const adapterRegistry = overrides.adapterRegistry ?? new AdapterRegistry();
  if (!overrides.adapterRegistry) adapterRegistry.register(fakeAdapter('claude-code'));
  const ossAttemptStore = overrides.ossAttemptStore ?? new OssAttemptStore(tempDir);

  return createRealtimeServices({
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
    ...(overrides.snapshotPayloadWarnBytes !== undefined
      ? { snapshotPayloadWarnBytes: overrides.snapshotPayloadWarnBytes }
      : {}),
    ...(overrides.snapshotPayloadMaxBytes !== undefined
      ? { snapshotPayloadMaxBytes: overrides.snapshotPayloadMaxBytes }
      : {}),
    ...(overrides.observeSnapshotPayloadSize
      ? { observeSnapshotPayloadSize: overrides.observeSnapshotPayloadSize }
      : {}),
  });
}

function openSocket(send: (data: string) => void, close = vi.fn()): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send,
    close,
  } as unknown as WebSocket;
}

/** Register a fake dashboard socket the way `handleWsConnection` would (owner, Phase 1). */
function addDashboardSocket(
  realtime: Awaited<ReturnType<typeof createTestRealtimeServices>>,
  ws: WebSocket,
): void {
  realtime.registry.register(ws, { kind: 'owner' }, 'dashboard');
}

function parseSent(messages: string[]): ServerMessage[] {
  return messages.map((data) => JSON.parse(data) as ServerMessage);
}

describe('createRealtimeServices', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
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

    const realtime = await createTestRealtimeServices(tempDir, {
      taskStore,
      queue,
      monitor,
      adapterRegistry,
      ossAttemptStore,
    });

    const sent: ServerMessage[] = [];
    addDashboardSocket(realtime, {
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

  test('broadcastToAll drops a client whose primary snapshot send throws and continues to later clients', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
    const realtime = await createTestRealtimeServices(tempDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const beforeClientMessages: string[] = [];
    const afterClientMessages: string[] = [];
    const failingClose = vi.fn();

    addDashboardSocket(realtime, openSocket((data) => beforeClientMessages.push(data)));
    addDashboardSocket(realtime, openSocket(() => {
      throw new Error('primary send failed');
    }, failingClose));
    addDashboardSocket(realtime, openSocket((data) => afterClientMessages.push(data)));

    realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

    expect(parseSent(beforeClientMessages).map((msg) => msg.type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
    expect(parseSent(afterClientMessages).map((msg) => msg.type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
    expect(failingClose).toHaveBeenCalledOnce();
    expect(realtime.registry.dashboardCount()).toBe(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to broadcast snapshot'),
      expect.any(Error),
    );
  });

  test('broadcastToAll guards coordinator snapshot sends without aborting later clients', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
    const realtime = await createTestRealtimeServices(tempDir);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const afterClientMessages: string[] = [];
    const failingClientMessages: string[] = [];
    const failingClose = vi.fn();

    addDashboardSocket(realtime, openSocket((data) => {
      const msg = JSON.parse(data) as ServerMessage;
      if (msg.type === 'coordinator.snapshot') {
        throw new Error('coordinator send failed');
      }
      failingClientMessages.push(data);
    }, failingClose));
    addDashboardSocket(realtime, openSocket((data) => afterClientMessages.push(data)));

    realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

    expect(parseSent(failingClientMessages).map((msg) => msg.type)).toEqual(['snapshot']);
    expect(parseSent(afterClientMessages).map((msg) => msg.type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
    expect(failingClose).toHaveBeenCalledOnce();
    expect(realtime.registry.dashboardCount()).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to broadcast coordinator.snapshot'),
      expect.any(Error),
    );
  });

  test('broadcastToAll observes and warns on large snapshot payloads below the hard cap', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
    const observations: Array<Parameters<NonNullable<RealtimeServicesDeps['observeSnapshotPayloadSize']>>[0]> = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realtime = await createTestRealtimeServices(tempDir, {
      snapshotPayloadWarnBytes: 1,
      snapshotPayloadMaxBytes: 1_000_000,
      observeSnapshotPayloadSize: (observation) => observations.push(observation),
    });
    const messages: string[] = [];

    addDashboardSocket(realtime, openSocket((data) => messages.push(data)));

    realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

    expect(parseSent(messages).map((msg) => msg.type)).toEqual([
      'snapshot',
      'coordinator.snapshot',
    ]);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        action: 'warned',
      }),
    ]));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('outbound snapshot payload exceeds warning threshold'),
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        warnBytes: 1,
        maxBytes: 1_000_000,
      }),
    );
  });

  test('broadcastToAll drops snapshots above the hard payload cap without dropping the client', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
    const observations: Array<Parameters<NonNullable<RealtimeServicesDeps['observeSnapshotPayloadSize']>>[0]> = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realtime = await createTestRealtimeServices(tempDir, {
      snapshotPayloadWarnBytes: 1,
      snapshotPayloadMaxBytes: 1,
      observeSnapshotPayloadSize: (observation) => observations.push(observation),
    });
    const send = vi.fn();
    const close = vi.fn();

    addDashboardSocket(realtime, openSocket(send, close));

    realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(realtime.registry.dashboardCount()).toBe(1);
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        action: 'dropped',
        maxBytes: 1,
      }),
    ]));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('outbound snapshot payload exceeds hard cap; dropping frame'),
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        maxBytes: 1,
      }),
    );
  });
});
