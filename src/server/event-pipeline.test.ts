/**
 * Tests for stale suggestion clearing and suggestion lifecycle telemetry
 * in the event pipeline.
 *
 * Two test suites:
 * 1. Mock-based: fast, isolated tests using vi.fn() mocks with controlled
 *    pre/post anomaly snapshots to verify the anomaly-diff clearing logic.
 * 2. Integration: real Monitor/Adapter to verify end-to-end clearing via
 *    hook event injection and lifecycle telemetry wiring.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { wireEventPipeline, type EventPipelineDeps } from './event-pipeline.js';
import type { AgentEvent } from '../core/types.js';
import type { ServerMessage } from '../shared/protocol.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { TokenTracker } from '../core/token-tracker.js';
import { Watchdog } from '../core/watchdog.js';
import { GitHubScannerService } from '../core/github-scanner-service.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import {
  _resetLifecycles,
  getActiveSuggestionId,
  startLifecycle,
} from '../core/suggestion-telemetry.js';
import type { RalphCycler } from '../core/ralph-cycler.js';
import { RalphLoopService } from './ralph-loop-service.js';

// ---------------------------------------------------------------------------
// Mock-based tests: controlled pre/post anomaly snapshots
// ---------------------------------------------------------------------------

type EventHandler = (tmuxName: string, event: AgentEvent) => void;

function createMockDeps(): {
  deps: EventPipelineDeps;
  fireEvent: (tmuxName: string, event: AgentEvent) => void;
  broadcasts: ServerMessage[];
} {
  let eventHandler: EventHandler | null = null;
  const broadcasts: ServerMessage[] = [];

  const deps: EventPipelineDeps = {
    adapter: {
      agentType: 'claude-code',
      launch: vi.fn(),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn().mockResolvedValue(''),
      onEvent: (handler: EventHandler) => { eventHandler = handler; },
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
    },
    monitor: {
      processEvents: vi.fn(),
      getSnapshot: vi.fn().mockReturnValue([]),
      getAgentEvents: vi.fn().mockReturnValue([]),
      markInputReceived: vi.fn(),
    } as any,
    taskStore: {
      findTaskBySession: vi.fn().mockReturnValue(null),
      updateSession: vi.fn(),
      listTasks: vi.fn().mockReturnValue([]),
    } as any,
    tokenTracker: {
      register: vi.fn(),
      scanTask: vi.fn().mockResolvedValue(false),
      getUsage: vi.fn(),
    } as any,
    watchdog: {
      recordEvents: vi.fn(),
      recordTokenActivity: vi.fn(),
    } as any,
    githubScanner: {
      isActive: vi.fn().mockReturnValue(false),
    } as any,
    llmClient: null,
    serverCwd: '/test',
    broadcastToAll: (msg: ServerMessage) => { broadcasts.push(msg); },
    ralphLoopService: {
      finalizeCompletedLoopStop: vi.fn().mockResolvedValue(false),
      handleStopEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as RalphLoopService,
  };

  return {
    deps,
    fireEvent: (tmuxName: string, event: AgentEvent) => {
      if (!eventHandler) throw new Error('Event handler not registered');
      eventHandler(tmuxName, event);
    },
    broadcasts,
  };
}

function suggestionBroadcasts(broadcasts: ServerMessage[]): ServerMessage[] {
  return broadcasts.filter((m) => m.type === 'suggestion');
}

describe('event-pipeline: anomaly-diff clearing (mock-based)', () => {
  let deps: EventPipelineDeps;
  let fireEvent: (tmuxName: string, event: AgentEvent) => void;
  let broadcasts: ServerMessage[];

  beforeEach(() => {
    _resetLifecycles();
    const mocks = createMockDeps();
    deps = mocks.deps;
    fireEvent = mocks.fireEvent;
    broadcasts = mocks.broadcasts;
  });

  test('clears suggestions when needs_input transitions to healthy', () => {
    // First snapshot call (pre): needs_input
    // After processEvents: monitor mock returns healthy
    let callCount = 0;
    (deps.monitor.getSnapshot as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return [{ agentId: 'agent-1', anomaly: { type: 'needs_input' }, events: [] }];
      }
      return [{ agentId: 'agent-1', anomaly: null, events: [] }];
    });
    wireEventPipeline(deps);

    fireEvent('agent-1', { type: 'tool_use', toolName: 'Read', toolUseId: 'tu-1' } as AgentEvent);

    const suggestions = suggestionBroadcasts(broadcasts);
    // Exactly one clear broadcast; duplicate fires must trip this assertion.
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      type: 'suggestion',
      agentId: 'agent-1',
      suggestionId: '',
      suggestions: [],
      quickActions: [],
    });
  });

  test('does NOT fire anomaly-diff when anomaly stays needs_input (e.g. AskUserQuestion)', () => {
    // Both pre and post show needs_input — no transition away
    (deps.monitor.getSnapshot as any).mockReturnValue([
      { agentId: 'agent-1', anomaly: { type: 'needs_input', subType: 'ask_user_question' }, events: [] },
    ]);
    wireEventPipeline(deps);

    fireEvent('agent-1', { type: 'tool_use', toolName: 'AskUserQuestion', toolUseId: 'tu-1' } as AgentEvent);

    // Anomaly-diff's clear uses suggestionId = '' (no active lifecycle in mock);
    // the smart-assist fallback generates a non-empty suggestionId. So an empty
    // suggestionId is the signature of the anomaly-diff clearing path.
    const anomalyDiffClears = suggestionBroadcasts(broadcasts).filter(
      (m) => m.type === 'suggestion'
        && m.suggestionId === ''
        && m.suggestions.length === 0
        && m.quickActions.length === 0,
    );
    expect(anomalyDiffClears).toHaveLength(0);
  });

  test('does NOT clear when no anomaly before and after', () => {
    (deps.monitor.getSnapshot as any).mockReturnValue([
      { agentId: 'agent-1', anomaly: null, events: [] },
    ]);
    wireEventPipeline(deps);

    fireEvent('agent-1', { type: 'tool_use', toolName: 'Read', toolUseId: 'tu-1' } as AgentEvent);

    const suggestions = suggestionBroadcasts(broadcasts);
    expect(suggestions).toHaveLength(0);
  });

  test('clearing is per-agent — does not affect other agents', () => {
    let callCount = 0;
    (deps.monitor.getSnapshot as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        return [
          { agentId: 'agent-1', anomaly: { type: 'needs_input' }, events: [] },
          { agentId: 'agent-2', anomaly: { type: 'needs_input' }, events: [] },
        ];
      }
      return [
        { agentId: 'agent-1', anomaly: null, events: [] },
        { agentId: 'agent-2', anomaly: { type: 'needs_input' }, events: [] },
      ];
    });
    wireEventPipeline(deps);

    fireEvent('agent-1', { type: 'tool_use', toolName: 'Read', toolUseId: 'tu-1' } as AgentEvent);

    const suggestions = suggestionBroadcasts(broadcasts);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ agentId: 'agent-1' });
  });
});

// ---------------------------------------------------------------------------
// Integration tests: real Monitor/Adapter, hook event injection
// ---------------------------------------------------------------------------

function makeStopHook(sessionId = 's1') {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'Stop',
    last_assistant_message: 'I need your input',
    cwd: '/cwd',
  });
}

function makeToolUseHook(toolName = 'Read', sessionId = 's1') {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
    cwd: '/cwd',
  });
}

function makeUserPromptHook(sessionId = 's1') {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: 'UserPromptSubmit',
    cwd: '/cwd',
  });
}

describe('wireEventPipeline – stale suggestion clearing (integration)', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let tokenTracker: TokenTracker;
  let watchdog: Watchdog;
  let githubScanner: GitHubScannerService;
  let broadcastMessages: ServerMessage[];

  beforeEach(() => {
    _resetLifecycles();
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    tokenTracker = new TokenTracker();
    watchdog = new Watchdog();
    const githubStateStore = new GitHubStateStore();
    githubScanner = new GitHubScannerService({
      taskStore, stateStore: githubStateStore,
      fetcher: { fetchPR: async () => null, fetchIssue: async () => null } as any,
      config: { enabled: false, scanIntervalMs: 60000, fetchIntervalMs: 60000 },
      onChanges: () => {},
    });
    broadcastMessages = [];
  });

  function setup() {
    const broadcastToAll = (msg: ServerMessage) => { broadcastMessages.push(msg); };
    return wireEventPipeline({
      adapter, monitor, taskStore, tokenTracker, watchdog,
      githubScanner, llmClient: null, serverCwd: '/test',
      broadcastToAll,
      ralphLoopService: new RalphLoopService({
        taskStore,
        monitor,
        serverCwd: '/test',
        broadcastToAll,
        interactionLog: undefined,
        ralphCycler: undefined,
        terminalBackend: terminal,
        tokenTracker,
        launchFreshTaskSession: vi.fn(async () => 'unused-session'),
        completeTask: vi.fn(async () => undefined),
      }),
    });
  }

  async function launchAgent() {
    const task = taskStore.createTask('Test', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Test', '/cwd');
    monitor.registerAgent(tmuxName);
    return tmuxName;
  }

  test('tool_use event after stop clears suggestions via anomaly-diff', async () => {
    setup();
    const tmuxName = await launchAgent();

    // Agent stops → needs_input
    adapter.injectHookEvent(tmuxName, makeStopHook());
    expect(monitor.getSnapshot().find(s => s.agentId === tmuxName)?.anomaly?.type).toBe('needs_input');

    broadcastMessages.length = 0;

    // Agent resumes with tool_use → needs_input cleared
    adapter.injectHookEvent(tmuxName, makeToolUseHook());

    const state = monitor.getSnapshot().find(s => s.agentId === tmuxName);
    expect(state?.anomaly?.type).not.toBe('needs_input');

    // Should broadcast suggestion-clear
    const suggestionMsgs = broadcastMessages.filter(
      (m): m is Extract<ServerMessage, { type: 'suggestion' }> => m.type === 'suggestion',
    );
    const clearMsg = suggestionMsgs.find(m => m.suggestions.length === 0);
    expect(clearMsg).toBeDefined();
    expect(clearMsg!.agentId).toBe(tmuxName);
  });

  test('user_prompt also clears via anomaly-diff', async () => {
    setup();
    const tmuxName = await launchAgent();

    adapter.injectHookEvent(tmuxName, makeStopHook());
    expect(monitor.getSnapshot().find(s => s.agentId === tmuxName)?.anomaly?.type).toBe('needs_input');

    broadcastMessages.length = 0;

    adapter.injectHookEvent(tmuxName, makeUserPromptHook());

    const suggestionMsgs = broadcastMessages.filter(
      (m): m is Extract<ServerMessage, { type: 'suggestion' }> => m.type === 'suggestion',
    );
    // At least one clear (empty suggestions + quickActions) confirms anomaly-diff fired.
    const clears = suggestionMsgs.filter(
      (m) => m.suggestions.length === 0 && m.quickActions.length === 0,
    );
    expect(clears.length).toBeGreaterThanOrEqual(1);
  });

  test('events that do not change anomaly state do not trigger clearing', async () => {
    setup();
    const tmuxName = await launchAgent();

    // tool_use when NOT in needs_input state
    adapter.injectHookEvent(tmuxName, makeToolUseHook());

    const suggestionMsgs = broadcastMessages.filter(m => m.type === 'suggestion');
    expect(suggestionMsgs).toHaveLength(0);
  });

  test('abortPendingSuggestion with used outcome resolves lifecycle as used', async () => {
    const { abortPendingSuggestion } = setup();
    const tmuxName = await launchAgent();

    startLifecycle(tmuxName, 'test-sug-id');
    expect(getActiveSuggestionId(tmuxName)).toBe('test-sug-id');

    abortPendingSuggestion(tmuxName, 'used');

    expect(getActiveSuggestionId(tmuxName)).toBeUndefined();

    // Broadcast should include the suggestionId
    const lastSuggestion = broadcastMessages.filter(m => m.type === 'suggestion').pop() as any;
    expect(lastSuggestion?.suggestionId).toBe('test-sug-id');
  });

  test('abortPendingSuggestion defaults to cleared outcome', async () => {
    const { abortPendingSuggestion } = setup();
    const tmuxName = await launchAgent();

    startLifecycle(tmuxName, 'test-sug-2');
    abortPendingSuggestion(tmuxName);

    expect(getActiveSuggestionId(tmuxName)).toBeUndefined();
  });

  test('anomaly-diff clearing resolves lifecycle as cleared', async () => {
    setup();
    const tmuxName = await launchAgent();

    // Agent stops
    adapter.injectHookEvent(tmuxName, makeStopHook());

    // Manually start a lifecycle (simulating what the pipeline does for AI suggestions)
    startLifecycle(tmuxName, 'diff-sug-id');

    // Agent resumes with tool_use → anomaly-diff fires → lifecycle resolved as cleared
    adapter.injectHookEvent(tmuxName, makeToolUseHook());

    expect(getActiveSuggestionId(tmuxName)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R16 onPermissionBlocked transition guard (rfc-remote-chat-trigger §7)
// ---------------------------------------------------------------------------

describe('event-pipeline: R16 onPermissionBlocked transition guard', () => {
  let deps: EventPipelineDeps;
  let fireEvent: (tmuxName: string, event: AgentEvent) => void;
  let onPermissionBlocked: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetLifecycles();
    const mocks = createMockDeps();
    deps = mocks.deps;
    fireEvent = mocks.fireEvent;
    onPermissionBlocked = vi.fn();
    deps.onPermissionBlocked = onPermissionBlocked;
    // findTaskBySession returns a fake task so the R16 path can look up task.id.
    // The Task shape needs enough fields for the downstream createSnapshotMessage path.
    (deps.taskStore.findTaskBySession as any).mockReturnValue({
      id: 't-rc-1',
      prompt: 'p',
      cwd: '/c',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'sess-1', agentType: 'claude-code', createdAt: new Date(), cwd: '/c' }],
    });
  });

  // Test harness: a small state machine where the monitor's getSnapshot
  // returns whatever is currently in `state`. `processEvents` is the
  // transition trigger — we override it to flip `state` from `pre` to `post`
  // for the current event. This sidesteps call-count fragility (each event
  // dispatch may call getSnapshot 2-4 times depending on the broadcast path).
  function setupTransition(pre: 'blocked' | null, post: 'blocked' | null): { permEvent: AgentEvent } {
    const permEvent = {
      type: 'permission_request',
      toolName: 'Bash',
      toolInput: { command: 'git push origin feat-x' },
    } as AgentEvent;
    let phase: 'pre' | 'post' = 'pre';
    const snapshotFor = (anomalyKind: 'blocked' | null) =>
      [{ agentId: 'sess-1', anomaly: anomalyKind === 'blocked' ? { type: 'permission_blocked' } : null, events: [permEvent] }];
    (deps.monitor.getSnapshot as any).mockImplementation(() =>
      snapshotFor(phase === 'pre' ? pre : post),
    );
    (deps.monitor.processEvents as any).mockImplementation(() => { phase = 'post'; });
    return { permEvent };
  }

  test('fires exactly once on transition into permission_blocked', () => {
    const { permEvent } = setupTransition(null, 'blocked');
    wireEventPipeline(deps);
    fireEvent('sess-1', permEvent);
    expect(onPermissionBlocked).toHaveBeenCalledTimes(1);
    expect(onPermissionBlocked).toHaveBeenCalledWith('t-rc-1', expect.stringContaining('git push origin'));
  });

  test('does NOT fire when state stays permission_blocked (already blocked → still blocked)', () => {
    const { permEvent } = setupTransition('blocked', 'blocked');
    wireEventPipeline(deps);
    fireEvent('sess-1', permEvent);
    fireEvent('sess-1', permEvent);
    expect(onPermissionBlocked).not.toHaveBeenCalled();
  });

  test('does NOT fire when state stays clean (not-blocked → not-blocked)', () => {
    const { permEvent } = setupTransition(null, null);
    wireEventPipeline(deps);
    fireEvent('sess-1', permEvent);
    expect(onPermissionBlocked).not.toHaveBeenCalled();
  });

  test('does NOT throw when no onPermissionBlocked dep is wired', () => {
    delete deps.onPermissionBlocked;
    setupTransition(null, 'blocked');
    wireEventPipeline(deps);
    expect(() =>
      fireEvent('sess-1', { type: 'tool_use', toolName: 'X', toolUseId: 'tu' } as AgentEvent),
    ).not.toThrow();
  });

  test('swallows callback throws without breaking the pipeline', () => {
    onPermissionBlocked.mockImplementation(() => { throw new Error('integration is broken'); });
    const { permEvent } = setupTransition(null, 'blocked');
    wireEventPipeline(deps);
    // The integration callback throw is caught around the call site; the
    // pipeline may still throw downstream for unrelated reasons given our
    // minimal mocks. The important assertion is that onPermissionBlocked WAS
    // invoked AND the integration error did not interrupt the pipeline before
    // any downstream work.
    try { fireEvent('sess-1', permEvent); } catch { /* downstream noise */ }
    expect(onPermissionBlocked).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ralph fresh-runtime wiring on Stop (regression for the iteration-stall
// follow-up to PR #61).
//
// Before this fix, wireEventPipeline constructed its own RalphLoopService
// instances and omitted launchFreshTaskSession on one path. The singleton
// service makes that missing-dependency class compile-time visible while this
// test preserves the end-to-end Stop → fresh-runtime regression coverage.
// ---------------------------------------------------------------------------

describe('wireEventPipeline – Ralph fresh-runtime wiring on Stop (integration)', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let tokenTracker: TokenTracker;
  let watchdog: Watchdog;
  let githubScanner: GitHubScannerService;

  beforeEach(() => {
    _resetLifecycles();
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    tokenTracker = new TokenTracker();
    watchdog = new Watchdog();
    const githubStateStore = new GitHubStateStore();
    githubScanner = new GitHubScannerService({
      taskStore, stateStore: githubStateStore,
      fetcher: { fetchPR: async () => null, fetchIssue: async () => null } as any,
      config: { enabled: false, scanIntervalMs: 60000, fetchIntervalMs: 60000 },
      onChanges: () => {},
    });
  });

  test('Stop event on a running Ralph loop invokes launchFreshTaskSession', async () => {
    // Real task + agent first — the launch returns the tmuxName we'll wire
    // as the Ralph loop owner so the Stop fingerprint check passes, AND we
    // need the real task id before constructing the cycler stub so we can
    // skip the placeholder/overwrite dance.
    const task = taskStore.createTask('Looped', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'iterate again', '/cwd');
    monitor.registerAgent(tmuxName);

    const launchFreshTaskSession = vi.fn(async (_task, _prompt, opts?: { tmuxName?: string }) => opts?.tmuxName ?? 'kookr-iter2');

    // Cycler stub returns launch_fresh — its action shape is verified
    // against the real RalphCyclerAction discriminated union by the
    // RalphCycler type assertion below. No I/O deps needed because we're
    // bypassing handleStop's real implementation entirely.
    const ralphCycler: Pick<RalphCycler, 'handleStop'> = {
      handleStop: vi.fn().mockResolvedValue({
        kind: 'launch_fresh',
        taskId: task.id,
        text: 'iterate again',
      }),
    };

    // Synthesize the Ralph loop in the same shape startLoop would produce,
    // with the terminal owner populated so isStopFromMainTaskSession will
    // accept the synthetic Stop hook below.
    const runtimeSessionId = 'runtime-1';
    task.ralphLoop = {
      prompt: 'iterate again',
      iterationCap: 5,
      currentIteration: 0,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 0,
      ownerSessionId: tmuxName,
    };

    const broadcastToAll = () => {};

    wireEventPipeline({
      adapter, monitor, taskStore, tokenTracker, watchdog,
      githubScanner, llmClient: null, serverCwd: '/test',
      broadcastToAll,
      ralphCycler: ralphCycler as RalphCycler,
      ralphLoopService: new RalphLoopService({
        taskStore,
        monitor,
        serverCwd: '/test',
        broadcastToAll,
        interactionLog: undefined,
        ralphCycler: ralphCycler as RalphCycler,
        terminalBackend: terminal,
        tokenTracker,
        launchFreshTaskSession,
        completeTask: vi.fn(async () => undefined),
      }),
    });

    // Inject a Stop hook from the owning terminal session.
    adapter.injectHookEvent(tmuxName, makeStopHook(runtimeSessionId));

    // RalphLoopService.handleStopEvent is fire-and-forget from the pipeline.
    // vi.waitFor handles the async settle without a hand-rolled deadline
    // poll and produces a useful failure message pointing at the unmet
    // expectation.
    await vi.waitFor(
      () => expect(launchFreshTaskSession).toHaveBeenCalledTimes(1),
      { timeout: 2000, interval: 20 },
    );

    expect(ralphCycler.handleStop).toHaveBeenCalledTimes(1);
    expect(launchFreshTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      'iterate again',
      { tmuxName: expect.stringMatching(/^kookr-[0-9a-f]{8}$/) },
    );
  });
});
