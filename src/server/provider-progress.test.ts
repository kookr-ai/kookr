import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CodexCliAdapter } from '../adapters/codex-cli-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { parseHookEvent } from '../core/hook-parser.js';
import { Monitor } from '../core/monitor.js';
import { SessionHealthTracker } from '../core/session-health.js';
import { deriveStuckReason } from '../core/stuck-reason.js';
import { TaskStore } from '../core/tasks.js';
import { TokenTracker } from '../core/token-tracker.js';
import { Watchdog } from '../core/watchdog.js';
import { summarizeActivity } from '../shared/contracts/activity-summary.js';
import { wireEventPipeline } from './event-pipeline.js';
import { GitHubScannerService } from '../core/github-scanner-service.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { RalphLoopService } from './ralph-loop-service.js';
import { SessionHealthService } from './session-health-service.js';
import { resolveTaskAttentionSignals } from './task-attention-signals.js';

const START = 1_800_000_000_000;
const SESSION = 'kookr-provider-progress';
const PROVIDER = 'provider-parent';
const TURN = 'turn-1';

describe('Codex provider progress through the real hook pipeline', () => {
  let adapter: CodexCliAdapter;
  let taskStore: TaskStore;
  let watchdog: Watchdog;
  let monitor: Monitor;
  let queue: AttentionQueue;
  let health: SessionHealthService;
  let taskId: string;

  function hook(hook_event_name: string, fields: Record<string, unknown> = {}, origin?: 'replay') {
    return adapter.injectHookEvent(SESSION, JSON.stringify({
      hook_event_name, session_id: PROVIDER, turn_id: TURN, cwd: '/test', ...fields,
    }), undefined, origin ? { origin } : undefined);
  }

  function progress(fields: Record<string, unknown> = {}, origin?: 'replay') {
    return hook('Notification', {
      notification_type: 'provider_progress', observed_at_ms: Date.now(), ...fields,
    }, origin);
  }

  function check(pane = 'Generating tool arguments\n• Working (20s • esc to interrupt)') {
    const verdict = watchdog.tick(SESSION, pane, []);
    monitor.applyWatchdogVerdict(SESSION, verdict, { paneCaptureSucceeded: true });
    // Meet the existing two-observation UI debounce; time thresholds are
    // controlled separately by each scenario.
    monitor.applyWatchdogVerdict(SESSION, watchdog.tick(SESSION, pane, []), { paneCaptureSucceeded: true });
    const task = taskStore.getTask(taskId)!;
    const signals = resolveTaskAttentionSignals(task, { queue, watchdog }, Date.now());
    return {
      warning: monitor.getCurrentAnomaly(SESSION)?.type ?? null,
      health: health.getSessionHealth(SESSION)?.classification,
      stuckReason: deriveStuckReason({
        status: task.status, hungSuspect: signals.hungSuspect,
        anomalyType: signals.queuedAnomalyType, liveness: signals.liveness, now: Date.now(),
      }),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    taskStore = new TaskStore();
    const task = taskStore.createTask('Provider progress regression', '/test');
    taskId = task.id;
    taskStore.addSession(taskId, { tmuxSession: SESSION, agentType: 'codex-cli', cwd: '/test', createdAt: new Date() });
    taskStore.getTaskForMutation(taskId)!.status = 'inProgress';
    const terminal = new FakeTerminalBackend();
    adapter = new CodexCliAdapter(terminal, taskStore);
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    watchdog = new Watchdog();
    const tokenTracker = new TokenTracker();
    const broadcastToAll = () => {};
    wireEventPipeline({
      adapter, monitor, taskStore, tokenTracker, watchdog, broadcastToAll,
      llmClient: null, serverCwd: '/test',
      githubScanner: new GitHubScannerService({
        taskStore, stateStore: new GitHubStateStore(),
        fetcher: { fetchPR: async () => null, fetchIssue: async () => null },
        config: { enabled: false, scanIntervalMs: 60_000, fetchIntervalMs: 60_000 }, onChanges: () => {},
      }),
      ralphLoopService: new RalphLoopService({
        taskStore, monitor, serverCwd: '/test', broadcastToAll, terminalBackend: terminal, tokenTracker,
        interactionLog: undefined, ralphCycler: undefined,
        launchFreshTaskSession: vi.fn(async () => 'unused'), completeTask: vi.fn(async () => undefined),
      }),
    });
    monitor.registerAgent(SESSION);
    watchdog.registerAgent(SESSION);
    health = new SessionHealthService({
      listSessions: () => [{ sessionId: SESSION, taskStatus: 'inProgress' }],
      getTurnState: () => monitor.getAgentState(SESSION)?.turnState,
      getWatchdogState: (id) => watchdog.getState(id),
      getBackendDiagnostics: () => ({
        sessionId: SESSION, socketPresent: true, identityVerified: true,
        masterPid: 1, agentPid: 2, attachChildAlive: true, recoveryInProgress: false,
        attachGeneration: 1, reattachCount: 0, ringHead: 100, lastByteAt: Date.now(), lastAttachAt: START,
      }),
      browser: new SessionHealthTracker(), restartEpoch: START,
    });
    hook('SessionStart');
    hook('UserPromptSubmit', { prompt: 'Generate a long custom tool call' });
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  test('four minutes of observations stay healthy without tools or transcript writes, then silence restores the warning', () => {
    const initialEvents = monitor.getAgentEvents(SESSION);
    for (let seconds = 10; seconds <= 250; seconds += 10) {
      vi.setSystemTime(START + seconds * 1_000);
      progress();
      expect(check()).toEqual({ warning: null, health: 'healthy-working', stuckReason: null });
    }
    expect(watchdog.hasToolInProgress(SESSION)).toBe(false);
    expect(watchdog.getState(SESSION)!.lastTokenActivityAt).toBe(0);
    expect(monitor.getAgentEvents(SESSION)).toEqual(initialEvents);
    vi.setSystemTime(START + 285_000);
    expect(check('Generating tool arguments\n• Working (285s • esc to interrupt)')).toEqual({
      warning: 'stale_agent', health: 'provider-or-agent-stalled', stuckReason: 'hung_suspect',
    });
    vi.setSystemTime(START + 286_000);
    progress();
    expect(monitor.getCurrentAnomaly(SESSION)).toBeNull();
    expect(check()).toEqual({ warning: null, health: 'healthy-working', stuckReason: null });
  });

  test('delayed delivery keeps the original timestamp in watchdog and persisted session metadata', () => {
    vi.setSystemTime(START + 20_000);
    progress({ observed_at_ms: START + 10_000 });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 10_000);
    expect(taskStore.getTask(taskId)!.sessions[0].lastEventAt).toBe(START + 10_000);
    vi.setSystemTime(START + 45_000);
    expect(check().warning).toBe('stale_agent');
  });

  test.each([
    ['missing timestamp', { observed_at_ms: undefined }],
    ['string timestamp', { observed_at_ms: String(START + 10_000) }],
    ['fractional timestamp', { observed_at_ms: START + 0.5 }],
    ['negative timestamp', { observed_at_ms: -1 }],
    ['timestamp beyond Date range', { observed_at_ms: 8_640_000_000_000_001 }],
    ['future timestamp', { observed_at_ms: START + 80_000 }],
    ['expired observation', { observed_at_ms: START + 1 }],
    ['missing turn', { turn_id: undefined }],
    ['empty turn', { turn_id: '' }],
    ['wrong session', { session_id: 'child-provider' }],
    ['unbounded turn identity', { turn_id: 'x'.repeat(257) }],
  ])('ignores %s without generic-notification fallback', (_label, fields) => {
    vi.setSystemTime(START + 70_000);
    progress(fields);
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START);
    expect(check().warning).toBe('stale_agent');
  });

  test('replay cannot renew freshness even when the recorded observation is recent', () => {
    vi.setSystemTime(START + 70_000);
    progress({}, 'replay');
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START);
    expect(check().stuckReason).toBe('hung_suspect');
  });

  test('restart retains the historical observation clock while replay restores session state', () => {
    vi.setSystemTime(START + 20_000);
    progress();
    const persistedAt = taskStore.getTask(taskId)!.sessions[0].lastEventAt!;
    vi.setSystemTime(START + 100_000);
    watchdog.registerAgent(SESSION, persistedAt, START);
    hook('SessionStart', {}, 'replay');
    hook('UserPromptSubmit', { prompt: 'Restored prompt' }, 'replay');
    progress({ observed_at_ms: persistedAt }, 'replay');
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(persistedAt);
    expect(check().stuckReason).toBe('hung_suspect');
    progress();
    expect(check().warning).toBeNull();
  });

  test('concurrent inherited child hooks do not freshen the parent session', () => {
    hook('SessionStart', { session_id: 'child-provider', transcript_path: '/child-transcript' });
    hook('UserPromptSubmit', { session_id: 'child-provider', turn_id: 'child-turn', prompt: 'Child work' });
    vi.setSystemTime(START + 70_000);
    const result = progress({ session_id: 'child-provider', turn_id: 'child-turn' });
    expect(result.parentage).toBe('child');
    expect(check().warning).toBe('stale_agent');
    progress();
    expect(check().warning).toBeNull();
  });

  test.each(['Stop', 'StopFailure'])('%s rejects delayed old observations across a new prompt', (ending) => {
    vi.setSystemTime(START + 10_000);
    hook(ending, { last_assistant_message: 'Finished', error: 'cancelled' });
    const before = monitor.getAgentEvents(SESSION);
    vi.setSystemTime(START + 20_000);
    progress({ observed_at_ms: START + 5_000 });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 10_000);
    expect(monitor.getAgentEvents(SESSION)).toEqual(before);
    hook('UserPromptSubmit', { prompt: 'New turn', turn_id: 'turn-2' });
    vi.setSystemTime(START + 30_000);
    progress({ observed_at_ms: START + 15_000 });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 20_000);
    progress({ turn_id: 'turn-2' });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 30_000);
  });

  test('a Stop hook that requests continued sampling admits newer real observations without changing turn semantics', () => {
    vi.setSystemTime(START + 10_000);
    hook('Stop', { last_assistant_message: 'Stop hook will request more work' });
    const eventsBefore = monitor.getAgentEvents(SESSION);
    for (let seconds = 20; seconds <= 260; seconds += 10) {
      vi.setSystemTime(START + seconds * 1_000);
      progress();
      expect(watchdog.tick(SESSION, 'Generating continuation arguments', []).status).toBe('healthy');
    }
    expect(monitor.getAgentEvents(SESSION)).toEqual(eventsBefore);
    expect(monitor.getAgentState(SESSION)?.turnState).toBe('completed_turn');
    expect(watchdog.hasToolInProgress(SESSION)).toBe(false);
  });

  test('an automatic mailbox turn stays fresh without a UserPromptSubmit hook', () => {
    const eventsBefore = monitor.getAgentEvents(SESSION);
    for (let seconds = 10; seconds <= 250; seconds += 10) {
      vi.setSystemTime(START + seconds * 1_000);
      progress({ turn_id: 'automatic-mailbox-turn' });
      expect(check()).toEqual({ warning: null, health: 'healthy-working', stuckReason: null });
    }
    expect(monitor.getAgentEvents(SESSION)).toEqual(eventsBefore);
  });

  test('SessionEnd rejects even a newer observation and later tool bookkeeping cannot revive it', () => {
    vi.setSystemTime(START + 10_000);
    hook('SessionEnd');
    vi.setSystemTime(START + 20_000);
    progress();
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 10_000);
    hook('PostToolUse', { tool_name: 'Bash' });
    vi.setSystemTime(START + 30_000);
    progress();
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 20_000);
  });

  test('progress cannot evict permission requests from the monitor window or mark a tool complete', () => {
    hook('PreToolUse', { tool_name: 'Bash', tool_use_id: 'pending-tool' });
    hook('PermissionRequest', { tool_name: 'Bash' });
    for (let i = 1; i <= 100; i++) {
      vi.setSystemTime(START + i * 10_000);
      progress();
    }
    expect(watchdog.hasToolInProgress(SESSION)).toBe(true);
    expect(check()).toEqual({ warning: 'permission_blocked', health: 'provider-or-agent-stalled', stuckReason: 'permission_blocked' });
    expect(monitor.getAgentState(SESSION)?.turnState).toBe('blocked');
  });

  test('late progress observations cannot pass tool results or a subsequent prompt', () => {
    hook('Stop', { last_assistant_message: 'Finished' });
    vi.setSystemTime(START + 10_000);
    hook('PostToolUse', { tool_name: 'Bash' });
    vi.setSystemTime(START + 20_000);
    progress({ observed_at_ms: START + 5_000 });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 10_000);
    hook('UserPromptSubmit', { prompt: 'New turn', turn_id: 'turn-2' });
    hook('PostToolUse', { tool_name: 'Bash' });
    vi.setSystemTime(START + 30_000);
    progress({ observed_at_ms: START + 15_000 });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 20_000);
    progress({ turn_id: 'turn-2' });
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START + 30_000);
  });

  test('a cancelled task rejects progress even if its final hook has not arrived', () => {
    taskStore.getTaskForMutation(taskId)!.status = 'cancelled';
    vi.setSystemTime(START + 20_000);
    progress();
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START);
  });

  test('unknown ownership and direct hook-file probes cannot bypass progress validation', () => {
    vi.setSystemTime(START + 70_000);
    adapter.injectHookEvent('unregistered-session', JSON.stringify({
      hook_event_name: 'Notification', notification_type: 'provider_progress',
      session_id: PROVIDER, turn_id: TURN, observed_at_ms: Date.now(),
    }));
    const event = parseHookEvent(JSON.stringify({
      hook_event_name: 'Notification', notification_type: 'provider_progress',
      session_id: PROVIDER, turn_id: TURN, observed_at_ms: Date.now(),
    }))!;
    if (event.type !== 'notification') throw new Error('Expected notification');
    expect(watchdog.recordProviderProgress(SESSION, event, {
      parentage: 'unknown', rawSessionId: PROVIDER, sequence: 1, observedAt: Date.now(),
    })).toBe(false);
    expect(watchdog.recordProviderProgress(SESSION, event, {
      parentage: 'parent', rawSessionId: 'different-provider', sequence: 2, observedAt: Date.now(),
    })).toBe(false);
    watchdog.tick(SESSION, 'Generating tool arguments', [event]);
    expect(watchdog.getState(SESSION)!.lastEventAt).toBe(START);
  });

  test('normalization keeps only bounded progress metadata and historical activity stays quiet', () => {
    const event = parseHookEvent(JSON.stringify({
      hook_event_name: 'Notification', notification_type: 'provider_progress',
      session_id: PROVIDER, turn_id: TURN, observed_at_ms: START,
      message: 'private partial argument', reasoning: 'private reasoning',
    }))!;
    expect(JSON.stringify(event)).not.toContain('private');
    expect(event.turnId).toBe(TURN);
    expect(summarizeActivity([event])).toEqual([]);
  });
});
