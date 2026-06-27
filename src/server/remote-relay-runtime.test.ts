import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { BuildInfo } from '../core/build-info.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { Monitor } from '../core/monitor.js';
import { TaskStore } from '../core/tasks.js';
import type { Watchdog } from '../core/watchdog.js';
import { asNodeEpoch, asNodeId } from '../remote/ids.js';
import type { RemoteNodeClient } from '../remote/node-client.js';
import { createPushAlertOutbox, type PushAlertDeltaPayload } from '../remote/push.js';
import type { RelayConnectionCredentials } from './relay-connection-store.js';

const relayRuntimeMocks = vi.hoisted(() => ({
  relayStartRuntime: null as null | ((credentials: RelayConnectionCredentials) => Promise<{ start(): void; stop(): Promise<void> }>),
  remoteNodeClient: null as null | RemoteNodeClient,
  connectionObserver: null as null | ((state: 'connected' | 'disconnected') => void),
  controllerReconnect: vi.fn(),
  controllerDisconnect: vi.fn(),
}));

vi.mock('./relay-connection-manager.js', () => ({
  createRelayConnectionManager: vi.fn((opts: { startRuntime: typeof relayRuntimeMocks.relayStartRuntime }) => {
    relayRuntimeMocks.relayStartRuntime = opts.startRuntime;
    return {
      status: vi.fn(),
      startConfigured: vi.fn(),
      connect: vi.fn(),
      pair: vi.fn(),
      pairHosted: vi.fn(),
      rotate: vi.fn(),
      disconnect: vi.fn(),
      forget: vi.fn(),
    };
  }),
}));

vi.mock('../remote/audit.js', () => ({
  createRemoteAuditScaffold: vi.fn(),
}));

vi.mock('../remote/command-journal.js', () => ({
  CommandJournal: {
    open: vi.fn(async () => ({
      revokeGrant: vi.fn(),
    })),
  },
}));

vi.mock('../remote/controller-lease.js', () => ({
  ControllerLeaseManager: vi.fn(function ControllerLeaseManager() {
    return {
      acquireLocal: vi.fn(),
      dispose: vi.fn(),
      handleRelayDisconnect: relayRuntimeMocks.controllerDisconnect,
      handleRelayReconnect: relayRuntimeMocks.controllerReconnect,
    };
  }),
}));

vi.mock('../remote/node-client.js', () => ({
  createRemoteNodeClient: vi.fn(async () => relayRuntimeMocks.remoteNodeClient),
}));

vi.mock('../remote/handshake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../remote/handshake.js')>();
  return {
    ...actual,
    remoteTerminalInputFeatureEnabled: vi.fn(() => false),
  };
});

vi.mock('../remote/session-stream-publisher.js', () => ({
  createSessionStreamPublisher: vi.fn(() => ({
    currentCursor: vi.fn(() => null),
    recordDemandProof: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

vi.mock('./relay-share-client.js', () => ({
  createRelayShareClient: vi.fn(() => ({})),
}));

vi.mock('./remote-command-handler.js', () => ({
  configureRemoteCommandHandler: vi.fn(async () => undefined),
}));

vi.mock('./task-share-service.js', () => ({
  TaskShareService: vi.fn(function TaskShareService() {
    return {
      publishActiveTaskProjections: vi.fn(),
      publishTaskProjectionForTask: vi.fn(),
      recordTerminalPublicationDemand: vi.fn(() => false),
    };
  }),
}));

describe('remote relay push alert replay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    relayRuntimeMocks.relayStartRuntime = null;
    relayRuntimeMocks.remoteNodeClient = null;
    relayRuntimeMocks.connectionObserver = null;
    relayRuntimeMocks.controllerReconnect.mockClear();
    relayRuntimeMocks.controllerDisconnect.mockClear();
  });

  function makeClient(overrides: Partial<RemoteNodeClient['status']> = {}): RemoteNodeClient {
    return {
      status: {
        relayConnected: true,
        protocolVersion: 1,
        nodeId: asNodeId('node-a'),
        nodeEpoch: asNodeEpoch('7'),
        nodeMode: 'active',
        connectionState: 'connected',
        features: { enabled: [], disabled: [] },
        ...overrides,
      },
      start: vi.fn(),
      stop: vi.fn(),
      publish: vi.fn(() => true),
      setCommandHandler: vi.fn(),
      setConnectionObserver: vi.fn((handler: ((state: 'connected' | 'disconnected') => void) | null) => {
        relayRuntimeMocks.connectionObserver = handler;
      }),
    };
  }

  function makeTaskStore(): { store: TaskStore; taskId: string } {
    const store = new TaskStore();
    const task = store.createTask({
      prompt: 'Approve deployment',
      cwd: '/tmp/project',
      name: 'Production deploy',
    });
    return { store, taskId: task.id };
  }

  async function flushAsyncPublish(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function importRuntime() {
    return await import('./remote-relay-runtime.js');
  }

  it('enqueues a permission push alert while the relay is reconnecting and replays it once connected', async () => {
    const { publishPermissionBlockedPushAlert } = await importRuntime();
    const { store, taskId } = makeTaskStore();
    const outbox = createPushAlertOutbox({ capacity: 4 });
    const client = makeClient({ relayConnected: false, connectionState: 'backing-off' });
    vi.spyOn(Date, 'now').mockReturnValue(1234);

    await expect(publishPermissionBlockedPushAlert({
      taskId,
      taskStore: store,
      remoteNodeClient: client,
      outbox,
      env: { KOOKR_RELAY_DISPLAY_NAME: 'Jean laptop' },
      now: () => new Date('2026-05-15T00:00:00.000Z'),
    })).resolves.toBe(false);

    expect(client.publish).not.toHaveBeenCalled();
    expect(outbox.snapshot()).toEqual([
      expect.objectContaining({
        alertId: `permission-${taskId}-1234`,
        nodeDisplayName: 'Jean laptop',
        taskShortLabel: 'Production deploy',
      }),
    ]);

    client.status.relayConnected = true;
    client.status.connectionState = 'connected';
    expect(outbox.flush(client, {
      now: () => new Date('2026-05-15T00:00:01.000Z'),
      env: {},
    })).toEqual({ attempted: 1, sent: 1, pending: 0 });

    expect(client.publish).toHaveBeenCalledTimes(1);
    const event = vi.mocked(client.publish).mock.calls[0][0];
    expect(event.kind).toBe('state.delta');
    expect((event.payload as PushAlertDeltaPayload).payload.alertId).toBe(`permission-${taskId}-1234`);
  });

  it('flushes buffered permission push alerts from the installed connected observer', async () => {
    const { createRemoteRelayRuntime } = await importRuntime();
    const { store, taskId } = makeTaskStore();
    const client = makeClient({ relayConnected: false, connectionState: 'backing-off' });
    relayRuntimeMocks.remoteNodeClient = client;
    vi.spyOn(Date, 'now').mockReturnValue(5678);

    const runtime = await createRemoteRelayRuntime({
      kookrDir: '/tmp/kookr-test',
      serverCwd: '/tmp/project',
      serverStartedAt: '2026-05-15T00:00:00.000Z',
      buildInfo: { version: 'test', commit: 'test', date: '2026-05-15T00:00:00.000Z' } as BuildInfo,
      terminalBackend: { getStats: () => ({}) } as TerminalBackend,
      taskStore: store,
      queue: {} as AttentionQueue,
      monitor: {} as Monitor,
      adapter: {} as AgentAdapter,
      watchdog: {} as Watchdog,
      interactionLog: {} as DeferredInteractionLogWriter,
      abortPendingSuggestion: vi.fn(),
      markDone: vi.fn(async () => undefined),
    });

    expect(relayRuntimeMocks.relayStartRuntime).toBeTypeOf('function');
    await relayRuntimeMocks.relayStartRuntime!({
      relayUrl: 'http://127.0.0.1:9',
      relayToken: 'token',
      nodeId: 'node-a',
    });

    runtime.publishPermissionBlocked(taskId);
    await flushAsyncPublish();
    expect(client.publish).not.toHaveBeenCalled();

    client.status.relayConnected = true;
    client.status.connectionState = 'connected';
    expect(relayRuntimeMocks.connectionObserver).toBeTypeOf('function');
    relayRuntimeMocks.connectionObserver!('connected');

    expect(relayRuntimeMocks.controllerReconnect).toHaveBeenCalledTimes(1);
    expect(client.publish).toHaveBeenCalledTimes(1);
    const event = vi.mocked(client.publish).mock.calls[0][0];
    expect(event.kind).toBe('state.delta');
    expect((event.payload as PushAlertDeltaPayload).payload.alertId).toBe(`permission-${taskId}-5678`);

    relayRuntimeMocks.connectionObserver!('connected');
    expect(client.publish).toHaveBeenCalledTimes(1);
  });

  it('clears buffered push alerts when the relay runtime is replaced', async () => {
    const { createRemoteRelayRuntime } = await importRuntime();
    const { store, taskId } = makeTaskStore();
    const firstClient = makeClient({ relayConnected: false, connectionState: 'backing-off' });
    relayRuntimeMocks.remoteNodeClient = firstClient;
    vi.spyOn(Date, 'now').mockReturnValue(9012);

    const runtime = await createRemoteRelayRuntime({
      kookrDir: '/tmp/kookr-test',
      serverCwd: '/tmp/project',
      serverStartedAt: '2026-05-15T00:00:00.000Z',
      buildInfo: { version: 'test', commit: 'test', date: '2026-05-15T00:00:00.000Z' } as BuildInfo,
      terminalBackend: { getStats: () => ({}) } as TerminalBackend,
      taskStore: store,
      queue: {} as AttentionQueue,
      monitor: {} as Monitor,
      adapter: {} as AgentAdapter,
      watchdog: {} as Watchdog,
      interactionLog: {} as DeferredInteractionLogWriter,
      abortPendingSuggestion: vi.fn(),
      markDone: vi.fn(async () => undefined),
    });

    expect(relayRuntimeMocks.relayStartRuntime).toBeTypeOf('function');
    await relayRuntimeMocks.relayStartRuntime!({
      relayUrl: 'http://127.0.0.1:9',
      relayToken: 'first-token',
      nodeId: 'node-a',
    });

    runtime.publishPermissionBlocked(taskId);
    await flushAsyncPublish();
    expect(firstClient.publish).not.toHaveBeenCalled();

    const secondClient = makeClient({ relayConnected: true, connectionState: 'connected' });
    relayRuntimeMocks.remoteNodeClient = secondClient;
    await relayRuntimeMocks.relayStartRuntime!({
      relayUrl: 'http://127.0.0.1:10',
      relayToken: 'second-token',
      nodeId: 'node-b',
    });

    expect(relayRuntimeMocks.connectionObserver).toBeTypeOf('function');
    relayRuntimeMocks.connectionObserver!('connected');

    expect(firstClient.publish).not.toHaveBeenCalled();
    expect(secondClient.publish).not.toHaveBeenCalled();
  });

  it('does not enqueue when the immediate permission push alert send succeeds', async () => {
    const { publishPermissionBlockedPushAlert } = await importRuntime();
    const { store, taskId } = makeTaskStore();
    const outbox = createPushAlertOutbox({ capacity: 4 });
    const client = makeClient();

    await expect(publishPermissionBlockedPushAlert({
      taskId,
      taskStore: store,
      remoteNodeClient: client,
      outbox,
      env: {},
    })).resolves.toBe(true);

    expect(client.publish).toHaveBeenCalledTimes(1);
    expect(outbox.snapshot()).toEqual([]);
  });

  it('does not enqueue disabled push alerts for later replay', async () => {
    const { publishPermissionBlockedPushAlert } = await importRuntime();
    const { store, taskId } = makeTaskStore();
    const outbox = createPushAlertOutbox({ capacity: 4 });
    const client = makeClient();

    await expect(publishPermissionBlockedPushAlert({
      taskId,
      taskStore: store,
      remoteNodeClient: client,
      outbox,
      env: { KOOKR_PUSH_DISABLED: 'true' },
    })).resolves.toBe(false);

    expect(client.publish).not.toHaveBeenCalled();
    expect(outbox.snapshot()).toEqual([]);
  });
});
