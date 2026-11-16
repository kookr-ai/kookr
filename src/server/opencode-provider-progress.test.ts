/**
 * Issue #3534: an opencode worker streaming a long tool call (e.g. a large Write) emits no hook for
 * ~40 s. The generated plugin now reports provider output as `Notification(provider_progress)`.
 * This drives the exact payloads the plugin writes (see kookr-plugin-source.ts) through the real
 * OpenCodeAdapter and event pipeline, in both directions: tokens flowing keep the worker healthy,
 * and a provider that stops mid-stream still surfaces as hung.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { OpenCodeAdapter } from '../adapters/opencode-adapter.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { GitHubScannerService } from '../core/github-scanner-service.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import { Monitor } from '../core/monitor.js';
import { deriveStuckReason } from '../core/stuck-reason.js';
import { TaskStore } from '../core/tasks.js';
import { TokenTracker } from '../core/token-tracker.js';
import { Watchdog } from '../core/watchdog.js';
import { wireEventPipeline } from './event-pipeline.js';
import { RalphLoopService } from './ralph-loop-service.js';
import { resolveTaskAttentionSignals } from './task-attention-signals.js';

vi.mock('../core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/git.js')>();
  return { ...actual, getGitInfo: vi.fn().mockResolvedValue(null) };
});

const START = 1_800_000_000_000;
const SESSION = 'kookr-oc-progress';
// The opencode TUI pane does not change while the model streams tool arguments.
const FROZEN_PANE = 'opencode\n> Build  mock/m\n';

describe('opencode provider progress through the real hook pipeline (issue #3534)', () => {
  let adapter: OpenCodeAdapter;
  let taskStore: TaskStore;
  let watchdog: Watchdog;
  let monitor: Monitor;
  let queue: AttentionQueue;
  let taskId: string;

  // Shapes copied from the generated plugin: ordinary hooks carry no turn_id.
  const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => adapter.injectHookEvent(SESSION,
    JSON.stringify({ session_id: SESSION, hook_event_name, cwd: '/work', transcript_path: '', ...fields }));
  const progress = () => hook('Notification', {
    notification_type: 'provider_progress', turn_id: 'opencode-turn-1', observed_at_ms: Date.now(),
  });

  function stuckReason(): string | null {
    const verdict = watchdog.tick(SESSION, FROZEN_PANE, []);
    monitor.applyWatchdogVerdict(SESSION, verdict, { paneCaptureSucceeded: true });
    monitor.applyWatchdogVerdict(SESSION, watchdog.tick(SESSION, FROZEN_PANE, []), { paneCaptureSucceeded: true });
    const task = taskStore.getTask(taskId)!;
    const signals = resolveTaskAttentionSignals(task, { queue, watchdog }, Date.now());
    return deriveStuckReason({
      status: task.status, hungSuspect: signals.hungSuspect,
      anomalyType: signals.queuedAnomalyType, liveness: signals.liveness, now: Date.now(),
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    taskStore = new TaskStore();
    taskId = taskStore.createTask('opencode long Write', '/work').id;
    taskStore.addSession(taskId, { tmuxSession: SESSION, agentType: 'opencode', cwd: '/work', createdAt: new Date() });
    taskStore.getTaskForMutation(taskId)!.status = 'inProgress';
    const terminal = new FakeTerminalBackend();
    const sessionRoot = mkdtempSync(join(tmpdir(), 'oc-progress-'));
    adapter = new OpenCodeAdapter(terminal, taskStore, {
      env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv, agentBin: '/opt/opencode', sessionRoot,
      dataRoot: join(sessionRoot, 'opencode-data'), shelfShow: async () => '',
    });
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    watchdog = new Watchdog();
    const tokenTracker = new TokenTracker();
    const broadcastToAll = () => {};
    wireEventPipeline({
      adapter, monitor, taskStore, tokenTracker, watchdog, broadcastToAll, llmClient: null, serverCwd: '/work',
      githubScanner: new GitHubScannerService({
        taskStore, stateStore: new GitHubStateStore(),
        fetcher: { fetchPR: async () => null, fetchIssue: async () => null },
        config: { enabled: false, scanIntervalMs: 60_000, fetchIntervalMs: 60_000 }, onChanges: () => {},
      }),
      ralphLoopService: new RalphLoopService({
        taskStore, monitor, serverCwd: '/work', broadcastToAll, terminalBackend: terminal, tokenTracker,
        interactionLog: undefined, ralphCycler: undefined,
        launchFreshTaskSession: vi.fn(async () => 'unused'), completeTask: vi.fn(async () => undefined),
      }),
    });
    monitor.registerAgent(SESSION);
    watchdog.registerAgent(SESSION);
    hook('SessionStart', { source: 'startup' });
    hook('UserPromptSubmit', { prompt: 'Audit and write the report' });
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'ok' });
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  test('a 40 s tool-argument stream reported every 10 s never reads as hung', () => {
    for (let s = 10; s <= 40; s += 10) {
      vi.setSystemTime(START + s * 1_000);
      progress();
      vi.setSystemTime(START + s * 1_000 + 9_000);
      expect(stuckReason()).toBeNull();
    }
    vi.setSystemTime(START + 50_000);
    hook('PreToolUse', { tool_name: 'Write', tool_input: { filePath: '/work/AUDIT.md' } });
    expect(stuckReason()).toBeNull();
  });

  test('without provider output the same silence is flagged, as before', () => {
    vi.setSystemTime(START + 40_000);
    expect(stuckReason()).toBe('hung_suspect');
  });

  test('a provider that stops mid-stream is still flagged once its last output is stale', () => {
    vi.setSystemTime(START + 10_000);
    progress();
    vi.setSystemTime(START + 39_000);
    expect(stuckReason()).toBeNull();
    vi.setSystemTime(START + 45_000);
    expect(stuckReason()).toBe('hung_suspect');
    progress();
    expect(stuckReason()).toBeNull();
  });
});
