import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { AdapterRegistry, type AgentAdapter } from '../adapters/agent-adapter.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { LedgerAnalytics } from '../core/ledger-analytics.js';
import { Monitor } from '../core/monitor.js';
import { OssAttemptStore } from '../core/oss-attempt-store.js';
import { ProjectConfigStore } from '../core/project-config-store.js';
import { TaskStore } from '../core/tasks.js';
import type { SnapshotPayloadSizeObservation } from './snapshot-payload-size-policy.js';
import { handleWsConnection, type WsConnectionDeps } from './ws-connection-handler.js';

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

interface FakeWs {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  handlers: Record<string, (...args: unknown[]) => void>;
}

function makeFakeWs(): FakeWs {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    readyState: 1,
    send: vi.fn(),
    handlers,
    on(event, cb) {
      handlers[event] = cb;
    },
  };
}

function makeDeps(tempDir: string, observations: SnapshotPayloadSizeObservation[]): WsConnectionDeps {
  const taskStore = new TaskStore();
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(fakeAdapter('claude-code'));
  const ossAttemptStore = new OssAttemptStore(tempDir);

  return {
    taskStore,
    queue,
    monitor,
    adapter: fakeAdapter('claude-code'),
    adapterRegistry,
    interactionLog: undefined,
    telemetryLog: undefined,
    buildInfo: { version: 'test', commit: 'test', builtAt: '2000-01-01T00:00:00.000Z' },
    serverStartedAt: '2000-01-01T00:00:00.000Z',
    serverCwd: '/repo',
    abortPendingSuggestion: () => {},
    lifecycleExtras: {
      hookWatcher: { stop() {} },
      watchdog: { unregisterAgent() {} },
    },
    agentLifecycleDeps: {} as WsConnectionDeps['agentLifecycleDeps'],
    broadcastToAll: () => {},
    broadcastProjectSummaries: () => {},
    launchTask: async () => ({ taskId: 'task', sessionId: 'session' }),
    githubStateStore: {
      getTaskIdsWithReferences: () => [],
      getTaskState: () => ({ prs: [], issues: [] }),
      getReferences: () => [],
      isRefOpen: () => undefined,
    } as unknown as WsConnectionDeps['githubStateStore'],
    ledgerAnalytics: new LedgerAnalytics(ossAttemptStore),
    projectConfigStore: new ProjectConfigStore(tempDir),
    achievementWatcher: {} as WsConnectionDeps['achievementWatcher'],
    ralphLoopService: {} as WsConnectionDeps['ralphLoopService'],
    availableAgentTypes: [],
    defaultAgentType: 'claude-code',
    getDefaultAgentType: () => 'claude-code',
    snapshotPayloadSizePolicy: {
      warnBytes: 1,
      maxBytes: 1,
      observe: (observation) => observations.push(observation),
    },
  };
}

describe('handleWsConnection snapshot payload size guard', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('real owner handleConnect snapshot is observed and dropped above the hard cap', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-ws-payload-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observations: SnapshotPayloadSizeObservation[] = [];
    const ws = makeFakeWs();
    const registrar = { register: vi.fn(), unregister: vi.fn() };

    handleWsConnection(
      ws as unknown as WebSocket,
      registrar,
      makeDeps(tempDir, observations),
      { kind: 'owner' },
    );

    const sent = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent.some((msg) => msg.type === 'snapshot')).toBe(false);
    expect(registrar.unregister).not.toHaveBeenCalled();
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        action: 'dropped',
        maxBytes: 1,
      }),
    ]));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('outbound snapshot payload exceeds hard cap; dropping frame'),
      expect.objectContaining({
        payloadType: 'snapshot',
        scopeKey: 'all',
        maxBytes: 1,
      }),
    );
  });
});
