import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import type { Actor } from './auth.js';
import type { ClientMessage } from '../shared/protocol.js';

// Mock the MessageRouter so we can assert the read-only gate never reaches the
// mutation path (handleMessageSafe) for a viewer. handleConnect is a no-op so
// the initial-connection burst doesn't touch real state.
const handleMessageSafe = vi.fn(async () => {});
const handleConnect = vi.fn(() => {});
vi.mock('./ws.js', () => ({
  MessageRouter: class {
    lastLaunchDuplicate = false;
    handleConnect = handleConnect;
    handleMessageSafe = handleMessageSafe;
  },
}));

// Mock the snapshot/use-case helpers so connection setup and the post-message
// rebroadcast don't require a fully-wired monitor/ledger/etc.
vi.mock('./use-cases/get-snapshot.js', () => ({
  createSnapshotMessage: () => ({ type: 'snapshot' }),
  getProjectSummaries: () => [],
}));

import {
  ALLOWED_VIEWER_INBOUND,
  isAllowedViewerInbound,
  handleWsConnection,
  type WsConnectionDeps,
} from './ws-connection-handler.js';

const OWNER: Actor = { kind: 'owner' };
const VIEWER: Actor = { kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } };

// A representative sample of every category of inbound message: mutations,
// feedback, launches, the inline achievement:* handlers, and read paths. None
// of these are in the (empty) viewer allow-list, so all must be denied a viewer.
const KNOWN_TYPES: ClientMessage['type'][] = [
  'respond', 'respondAll', 'directReply', 'navigate', 'getNext',
  'selectionChanged', 'emptyEnterIntent', 'skip', 'skipAll', 'snooze',
  'cancelSnooze', 'launch', 'launchPlaybook', 'completeTask', 'setTaskFeedback',
  'requestTaskReflect', 'requestTaskSnapshotReflect', 'relaunch', 'cancelTask',
  'reopenTask', 'dismissAgentSignal', 'deleteTask', 'renameTask',
  'setTaskPriority', 'stop', 'reflect', 'listPlaybooks', 'telemetry',
  'setProjectConfig', 'clearCompleted', 'ackTerminatedTask',
  'achievement:reset', 'achievement:setEnabled', 'permissionChoice',
  'rearmCircuitBreaker', 'findingFeedback', 'missedFinding',
  'workspace:getView', 'workspace:getCleanupDetail', 'workspace:cleanupCandidate',
  'workspace:bulkSafeCleanup', 'workspace:runCleanupDiagnostic', 'workspace:sweep',
];

describe('isAllowedViewerInbound (#806 WS read-only gate)', () => {
  it('allows owners every message type', () => {
    for (const type of KNOWN_TYPES) {
      expect(isAllowedViewerInbound(OWNER, type)).toBe(true);
    }
    // Owners are unaffected even by an unknown/future type.
    expect(isAllowedViewerInbound(OWNER, 'someFutureType' as ClientMessage['type'])).toBe(true);
  });

  it('denies a viewer every known mutating/inline inbound type', () => {
    for (const type of KNOWN_TYPES) {
      expect(isAllowedViewerInbound(VIEWER, type)).toBe(false);
    }
  });

  it('denies a viewer unknown/future types (default-deny)', () => {
    expect(isAllowedViewerInbound(VIEWER, 'someFutureMutation' as ClientMessage['type'])).toBe(false);
  });

  it('viewer allow-list does not admit any known application message type', () => {
    // Guards against a future edit that widens viewer access by populating the
    // allow-list with a mutating type. Currently the set is empty.
    for (const type of KNOWN_TYPES) {
      expect(ALLOWED_VIEWER_INBOUND.has(type)).toBe(false);
    }
    expect(ALLOWED_VIEWER_INBOUND.size).toBe(0);
  });

  it('denies the inline achievement:* handlers specifically', () => {
    expect(isAllowedViewerInbound(VIEWER, 'achievement:reset')).toBe(false);
    expect(isAllowedViewerInbound(VIEWER, 'achievement:setEnabled')).toBe(false);
  });
});

// --- Integration: drive the real ws.on('message') gate ---------------------

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

const achievementWatcher = {
  reset: vi.fn(async () => {}),
  setEnabled: vi.fn(() => {}),
  check: vi.fn(() => {}),
  recordResolution: vi.fn(() => {}),
};

function makeDeps(): WsConnectionDeps {
  return {
    achievementWatcher,
    broadcastToAll: vi.fn(),
    broadcastProjectSummaries: vi.fn(),
    githubStateStore: {
      getTaskIdsWithReferences: () => [],
      getTaskState: () => ({ prs: [], issues: [] }),
      getReferences: () => [],
    },
    // The remaining deps are only consumed by the (mocked) MessageRouter and
    // initial-burst helpers, so stubs/undefined are sufficient here.
  } as unknown as WsConnectionDeps;
}

const registrar = { register: vi.fn(), unregister: vi.fn() };

function dispatch(ws: FakeWs, msg: object): Promise<void> {
  return (ws.handlers.message as (data: unknown) => Promise<void>)(
    Buffer.from(JSON.stringify(msg)),
  );
}

describe('handleWsConnection read-only gate (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('viewer achievement:reset is rejected with no state change and no router call', async () => {
    const ws = makeFakeWs();
    const deps = makeDeps();
    handleWsConnection(ws as unknown as WebSocket, registrar, deps, VIEWER);
    ws.send.mockClear();

    await dispatch(ws, { type: 'achievement:reset' });

    expect(achievementWatcher.reset).not.toHaveBeenCalled();
    expect(handleMessageSafe).not.toHaveBeenCalled();
    // The real "no state change" guarantee: rejection must NOT propagate a
    // snapshot to other clients (achievement:reset's mutation path rebroadcasts).
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
    expect(deps.broadcastProjectSummaries).not.toHaveBeenCalled();
    const sent = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent.some((m) => m.type === 'alert' && /read-only/i.test(m.summary))).toBe(true);
  });

  it('viewer achievement:setEnabled is rejected (no watcher mutation, alert sent)', async () => {
    const ws = makeFakeWs();
    const deps = makeDeps();
    handleWsConnection(ws as unknown as WebSocket, registrar, deps, VIEWER);
    ws.send.mockClear();

    await dispatch(ws, { type: 'achievement:setEnabled', enabled: false });

    expect(achievementWatcher.setEnabled).not.toHaveBeenCalled();
    expect(handleMessageSafe).not.toHaveBeenCalled();
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('Read-only'));
  });

  it('viewer mutation (deleteTask) is rejected before the router runs, no broadcast', async () => {
    const ws = makeFakeWs();
    const deps = makeDeps();
    handleWsConnection(ws as unknown as WebSocket, registrar, deps, VIEWER);
    ws.send.mockClear();

    await dispatch(ws, { type: 'deleteTask', taskId: 't1' });

    expect(handleMessageSafe).not.toHaveBeenCalled();
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
    expect(deps.broadcastProjectSummaries).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('Read-only'));
  });

  it('owner achievement:setEnabled reaches the inline handler (gate is owner-transparent)', async () => {
    const ws = makeFakeWs();
    handleWsConnection(ws as unknown as WebSocket, registrar, makeDeps(), OWNER);

    await dispatch(ws, { type: 'achievement:setEnabled', enabled: true });

    expect(achievementWatcher.setEnabled).toHaveBeenCalledWith(true);
  });

  it('owner mutation reaches the router (gate is owner-transparent)', async () => {
    const ws = makeFakeWs();
    handleWsConnection(ws as unknown as WebSocket, registrar, makeDeps(), OWNER);

    await dispatch(ws, { type: 'deleteTask', taskId: 't1' });

    expect(handleMessageSafe).toHaveBeenCalledTimes(1);
  });

  it('defaults to owner when no actor is supplied (back-compat)', async () => {
    const ws = makeFakeWs();
    handleWsConnection(ws as unknown as WebSocket, registrar, makeDeps());

    await dispatch(ws, { type: 'deleteTask', taskId: 't1' });

    expect(handleMessageSafe).toHaveBeenCalledTimes(1);
  });
});

describe('handleWsConnection initial burst (#809 actor-aware)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('owner burst goes through router.handleConnect (unchanged)', () => {
    const ws = makeFakeWs();
    handleWsConnection(ws as unknown as WebSocket, registrar, makeDeps(), OWNER);
    expect(handleConnect).toHaveBeenCalledTimes(1);
  });

  it('viewer burst serves the scoped snapshot from buildScopedSnapshot, not handleConnect', () => {
    const ws = makeFakeWs();
    const scoped = { type: 'snapshot', agents: [], serverCwd: '/repo' };
    const buildScopedSnapshot = vi.fn(() => scoped);
    const deps = { ...makeDeps(), buildScopedSnapshot } as unknown as WsConnectionDeps;

    handleWsConnection(ws as unknown as WebSocket, registrar, deps, VIEWER);

    // Single owner of scope filtering — the viewer never goes through the
    // owner's whole-world handleConnect path.
    expect(handleConnect).not.toHaveBeenCalled();
    expect(buildScopedSnapshot).toHaveBeenCalledWith(VIEWER.kind === 'viewer' ? VIEWER.scope : undefined);
    const sent = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent).toContainEqual(scoped);
  });

  it('viewer without a buildScopedSnapshot factory fails closed (no snapshot served)', () => {
    const ws = makeFakeWs();
    handleWsConnection(ws as unknown as WebSocket, registrar, makeDeps(), VIEWER);
    expect(handleConnect).not.toHaveBeenCalled();
    const sent = ws.send.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(sent.some((m) => m.type === 'snapshot')).toBe(false);
  });
});
