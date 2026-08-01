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
  | 'snapshotPayloadWarnBytes'
  | 'snapshotPayloadMaxBytes'
  | 'observeSnapshotPayloadSize'
  | 'loadShedConfig'
  | 'backpressureDisconnectAfterSkips'
  | 'livenessSweepEnabled'
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
    serverEpoch?: string;
    enableWsDelta?: boolean;
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
    ...(overrides.serverEpoch !== undefined ? { serverEpoch: overrides.serverEpoch } : {}),
    ...(overrides.enableWsDelta !== undefined ? { enableWsDelta: overrides.enableWsDelta } : {}),
    ...(overrides.snapshotPayloadWarnBytes !== undefined
      ? { snapshotPayloadWarnBytes: overrides.snapshotPayloadWarnBytes }
      : {}),
    ...(overrides.snapshotPayloadMaxBytes !== undefined
      ? { snapshotPayloadMaxBytes: overrides.snapshotPayloadMaxBytes }
      : {}),
    ...(overrides.observeSnapshotPayloadSize
      ? { observeSnapshotPayloadSize: overrides.observeSnapshotPayloadSize }
      : {}),
    ...(overrides.loadShedConfig ? { loadShedConfig: overrides.loadShedConfig } : {}),
    ...(overrides.backpressureDisconnectAfterSkips !== undefined
      ? { backpressureDisconnectAfterSkips: overrides.backpressureDisconnectAfterSkips }
      : {}),
    ...(overrides.livenessSweepEnabled !== undefined
      ? { livenessSweepEnabled: overrides.livenessSweepEnabled }
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

  describe('load-shed wiring (#1725)', () => {
    test('without loadShedConfig, noteEventLoopDelaySample is a no-op and snapshots always fan out fully', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const realtime = await createTestRealtimeServices(tempDir);
      const send = vi.fn();
      addDashboardSocket(realtime, openSocket(send));

      expect(() => realtime.noteEventLoopDelaySample(999_999)).not.toThrow();
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

      // broadcastToAll always attaches a coordinator frame (pre-existing
      // behavior, unrelated to #1725) — both still reach the client normally.
      expect(parseSent(send.mock.calls.map((c) => c[0] as string)).map((m) => m.type))
        .toEqual(['snapshot', 'coordinator.snapshot']);
    });

    test('with loadShedConfig, sustained high delay engages the gate and snapshots are replaced by a degraded notice', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const realtime = await createTestRealtimeServices(tempDir, {
        loadShedConfig: { eventLoopDelayThresholdMs: 100, sustainTicks: 2, recoverTicks: 2 },
      });
      const send = vi.fn();
      addDashboardSocket(realtime, openSocket(send));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      realtime.noteEventLoopDelaySample(500);
      realtime.noteEventLoopDelaySample(500); // 2nd consecutive tick over threshold -> engaged

      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

      const messages = parseSent(send.mock.calls.map((c) => c[0] as string));
      expect(messages).toEqual([
        { type: 'wsBackpressureNotice', kind: 'loadShedActive', eventLoopDelayP95Ms: 500 },
      ]);
    });

    test('recovery resumes full snapshot fan-out on the SAME broadcast as the recovered notice', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const realtime = await createTestRealtimeServices(tempDir, {
        loadShedConfig: { eventLoopDelayThresholdMs: 100, sustainTicks: 1, recoverTicks: 1 },
      });
      const send = vi.fn();
      addDashboardSocket(realtime, openSocket(send));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      realtime.noteEventLoopDelaySample(500); // engages
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });
      send.mockClear();

      realtime.noteEventLoopDelaySample(10); // recovers
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });

      const messages = parseSent(send.mock.calls.map((c) => c[0] as string));
      expect(messages.map((m) => m.type)).toEqual(['wsBackpressureNotice', 'snapshot', 'coordinator.snapshot']);
    });

    test('R6: while shed is active, the expensive snapshot enrichment (coordinator build, taskStore reads) is skipped entirely, not just the transport', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const taskStore = new TaskStore();
      // Enrichment reads the store via the non-cloning viewTasks (issue #1749).
      const viewTasksSpy = vi.spyOn(taskStore, 'viewTasks');
      const realtime = await createTestRealtimeServices(tempDir, {
        taskStore,
        loadShedConfig: { eventLoopDelayThresholdMs: 100, sustainTicks: 1, recoverTicks: 1 },
      });
      const send = vi.fn();
      addDashboardSocket(realtime, openSocket(send));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Baseline: not shed — enrichment runs, taskStore is read (coordinator
      // build + achievement check share exactly ONE non-cloning read; a second
      // call would mean the #1749 full-store-read amplifier is creeping back).
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });
      expect(viewTasksSpy).toHaveBeenCalledTimes(1);
      viewTasksSpy.mockClear();

      // Engage shed, then broadcast again — enrichment must be skipped this time.
      realtime.noteEventLoopDelaySample(500);
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });
      expect(viewTasksSpy).not.toHaveBeenCalled();
    });
  });

  describe('delta protocol Stage 2 (#1754)', () => {
    test('first snapshot is full; subsequent flushes emit coalesced deltas', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const realtime = await createTestRealtimeServices(tempDir, {
        serverEpoch: '2026-08-01T00:00:00.000Z',
        enableWsDelta: true,
      });
      const sent: ServerMessage[] = [];
      addDashboardSocket(realtime, {
        readyState: WebSocket.OPEN,
        send: (data: string) => sent.push(JSON.parse(data) as ServerMessage),
      } as unknown as WebSocket);

      realtime.broadcastToAll({
        type: 'snapshot',
        agents: [{ agentId: 's1', taskId: 't1', events: [], anomaly: null } as SnapshotMessage['agents'][number]],
        serverCwd: '/repo',
      });
      const first = sent.filter((m) => m.type === 'snapshot' || m.type === 'delta');
      expect(first[0]?.type).toBe('snapshot');
      expect(first[0]).toEqual(expect.objectContaining({ epoch: '2026-08-01T00:00:00.000Z', seq: 1 }));

      sent.length = 0;
      realtime.broadcastToAll({
        type: 'snapshot',
        agents: [{
          agentId: 's1',
          taskId: 't1',
          events: [],
          anomaly: null,
          taskName: 'changed',
        } as SnapshotMessage['agents'][number]],
        serverCwd: '/repo',
      });
      const second = sent.filter((m) => m.type === 'snapshot' || m.type === 'delta');
      expect(second).toHaveLength(1);
      expect(second[0]?.type).toBe('delta');
      if (second[0]?.type === 'delta') {
        expect(second[0].seq).toBe(2);
        expect(second[0].agents?.upserts?.some((a) => a.taskName === 'changed')).toBe(true);
      }
    });

    test('enableWsDelta=false keeps full-snapshot fan-out even with a sequencer', async () => {
      tempDir = mkdtempSync(join(tmpdir(), 'kookr-realtime-'));
      const realtime = await createTestRealtimeServices(tempDir, {
        serverEpoch: '2026-08-01T00:00:00.000Z',
        enableWsDelta: false,
      });
      const sent: ServerMessage[] = [];
      addDashboardSocket(realtime, {
        readyState: WebSocket.OPEN,
        send: (data: string) => sent.push(JSON.parse(data) as ServerMessage),
      } as unknown as WebSocket);

      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });
      realtime.broadcastToAll({ type: 'snapshot', agents: [], serverCwd: '/repo' });
      const frames = sent.filter((m) => m.type === 'snapshot' || m.type === 'delta');
      expect(frames.every((m) => m.type === 'snapshot')).toBe(true);
      expect(frames).toHaveLength(2);
    });
  });
});
