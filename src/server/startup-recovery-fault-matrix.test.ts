import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { LaunchDependencyAdmission } from '../core/launch-dependency-admission.js';
import { buildTaskLaunchIntent } from '../core/task-launch-intent.js';
import { isTerminalStatus } from '../core/task-status.js';
import type { Task } from '../core/tasks.js';
import { reconcile, type ReconciliationResult } from './reconciliation.js';
import { recoverCrashedSessions, type CrashRecoveryResult } from './crash-recovery.js';
import { runStartupRecoveryPhase } from './startup-recovery.js';
import type { AgentLifecycleDeps } from './agent-lifecycle.js';
import type { Monitor } from '../core/monitor.js';
import type { Watchdog } from '../core/watchdog.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { RalphLoopService } from './ralph-loop-service.js';

/**
 * Fault-injection coverage for the startup recovery windows (issue #2794).
 *
 * `recoverCrashedSessions` walks a long, restart-sensitive pipeline —
 * reconciliation has already marked the dead session completed, then recovery
 * reopens the task, marks the old session crash-recovered, evaluates dependency
 * admission, persists a probe fence, launches a replacement adapter session,
 * delivers the initial prompt, and registers the new session. A process death
 * or a thrown fault at any of those boundaries must never leave the task/session
 * graph in an inconsistent ownership state: no live orphan terminal, no leaked
 * launch reservation, and the pre-crash session still owned by its task.
 *
 * The unit suites around it exercise individual crash-loop *decisions*; this
 * table-driven matrix instead injects a real fault at each launch boundary and
 * asserts a single shared set of ownership invariants holds across all of them,
 * so a recovery regression is caught here rather than in a live incident.
 */

interface FaultContext {
  taskStore: TaskStore;
  terminal: FakeTerminalBackend;
  adapter: ClaudeCodeAdapter;
  adapterRegistry: AdapterRegistry;
  task: Task;
  deadSessionId: string;
  reconcileResult: ReconciliationResult;
}

interface FaultRow {
  name: string;
  /** The recovery boundary this row severs. */
  boundary: string;
  /**
   * Arrange the fault and return the recovery options to run with. Runs after
   * reconciliation, before `recoverCrashedSessions`.
   */
  inject: (ctx: FaultContext) => Parameters<typeof recoverCrashedSessions>[3];
  /** How the severed launch must be classified. */
  classification: 'failed' | 'skipped';
  /** Substring the recorded reason/error must contain. */
  reasonMatch: RegExp;
  /** Whether a replacement adapter session was physically created before the fault. */
  createdReplacement: boolean;
  /** Terminal task status the fault should settle on (recoverable, never live). */
  settledStatus: Array<Task['status']>;
}

let tempDir: string;

async function makeContext(cwd: string): Promise<FaultContext> {
  const taskStore = new TaskStore();
  const terminal = new FakeTerminalBackend();
  const hooksDir = join(tempDir, 'hooks');
  const settingsDir = join(tempDir, 'settings');
  await mkdir(hooksDir, { recursive: true });
  await mkdir(settingsDir, { recursive: true });
  await mkdir(cwd, { recursive: true });

  const adapter = new ClaudeCodeAdapter(terminal, taskStore, {
    hooksDir,
    settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
  });
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(adapter);

  const created = taskStore.createTask('Fix the failing build', cwd);
  taskStore.addSession(created.id, {
    tmuxSession: `kookr-dead-${created.id.slice(0, 8)}`,
    agentType: 'claude-code',
    cwd,
    createdAt: new Date(),
    lastStatus: 'running',
  });
  // Give the task a durable launch intent so recovery has something to replay.
  taskStore.getTaskForMutation(created.id)!.launchIntent = {
    ...buildTaskLaunchIntent('claude-code'),
    prompt: 'Fix the failing build',
    cwd,
    agentType: 'claude-code',
  };
  const task = taskStore.getTask(created.id)!;
  const deadSessionId = task.sessions[0].tmuxSession;

  // Reconcile marks the dead session completed and auto-transitions the task to
  // terminated (rfc-task-loss-prevention D1) — the exact pre-state recovery runs
  // against in production.
  const reconcileResult = await reconcile(taskStore, terminal);
  expect(reconcileResult.markedCompleted).toContain(deadSessionId);

  return { taskStore, terminal, adapter, adapterRegistry, task, deadSessionId, reconcileResult };
}

/** Give the task a degraded 'kb' dependency so recovery issues a half-open probe. */
function withProbeDependency(ctx: FaultContext): LaunchDependencyAdmission {
  ctx.taskStore.getTaskForMutation(ctx.task.id)!.launchIntent = {
    ...buildTaskLaunchIntent('claude-code'),
    prompt: 'Fix the failing build',
    cwd: ctx.task.sessions[0].cwd,
    agentType: 'claude-code',
    dependencies: ['kb'],
  };
  const admission = new LaunchDependencyAdmission();
  admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
  return admission;
}

const FAULT_ROWS: FaultRow[] = [
  {
    name: 'adapter launch fault before any session exists',
    boundary: 'relaunch',
    inject: (ctx) => {
      vi.spyOn(ctx.terminal, 'createSession').mockRejectedValue(new Error('backend unreachable'));
      return {};
    },
    classification: 'failed',
    reasonMatch: /backend unreachable/,
    createdReplacement: false,
    settledStatus: ['open'],
  },
  {
    name: 'prompt-delivery fault after the replacement session is created',
    boundary: 'prompt delivery (after adapter launch, before session registration)',
    inject: (ctx) => {
      // The replacement terminal is created (onSessionCreated fires), then the
      // initial-prompt write fails before the adapter can call addSession.
      const boom = new Error('composer write failed');
      vi.spyOn(ctx.terminal, 'writeInputSequence').mockRejectedValue(boom);
      vi.spyOn(ctx.terminal, 'writeInput').mockRejectedValue(boom);
      vi.spyOn(ctx.terminal, 'writeSequence').mockRejectedValue(boom);
      vi.spyOn(ctx.terminal, 'write').mockRejectedValue(boom);
      return {};
    },
    classification: 'failed',
    reasonMatch: /composer write failed/,
    createdReplacement: true,
    settledStatus: ['open'],
  },
  {
    name: 'persistence fault at the pre-launch probe barrier',
    boundary: 'persistence / task save',
    inject: (ctx) => {
      const admission = withProbeDependency(ctx);
      return {
        launchDependencyAdmission: admission,
        // Healthy findings flip the degraded circuit half-open, so recovery
        // claims a probe and persists its fence before launching.
        dependencyPreflightRunner: async () => [],
        // The durable probe-fence write is where the restart-sensitive barrier
        // lives; failing it must abort the launch, not orphan a worker.
        flushTasks: vi.fn().mockRejectedValue(new Error('disk full')),
      };
    },
    classification: 'failed',
    reasonMatch: /dependency probe persistence failed: disk full/,
    createdReplacement: false,
    settledStatus: ['pending'],
  },
];

describe('startup recovery fault matrix (issue #2794)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'startup-fault-matrix-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(FAULT_ROWS)(
    'holds task/session ownership invariants when a fault severs the $boundary boundary',
    async (row) => {
      const ctx = await makeContext(join(tempDir, row.boundary.replace(/[^a-z]+/gi, '-')));
      const options = row.inject(ctx);

      const result = await recoverCrashedSessions(
        ctx.taskStore,
        ctx.adapterRegistry,
        ctx.reconcileResult,
        options,
      );

      // --- Classification: severed, never counted as a live relaunch ---
      expect(result.relaunched).toHaveLength(0);
      const bucket: Array<{ taskId: string; reason?: string; error?: string }> =
        row.classification === 'failed' ? result.failed : result.skipped;
      expect(bucket).toEqual([
        expect.objectContaining({ taskId: ctx.task.id }),
      ]);
      const detail = bucket[0].error ?? bucket[0].reason ?? '';
      expect(detail).toMatch(row.reasonMatch);

      const settled = ctx.taskStore.getTask(ctx.task.id)!;

      // --- Ownership invariant 1: no leaked launch reservation ---
      // The finally block must release the lease so the task is claimable again.
      expect(ctx.taskStore.hasFreshLaunchReservation(ctx.task.id)).toBe(false);

      // --- Ownership invariant 2: the task never looks like it owns a live worker ---
      expect(isTerminalStatus(settled.status)).toBe(false); // recoverable, not lost
      expect(row.settledStatus).toContain(settled.status);
      for (const session of settled.sessions) {
        expect(['completed', 'aborted']).toContain(session.lastStatus);
      }

      // --- Ownership invariant 3: no orphaned live terminal in the backend ---
      const aliveSessions = await ctx.terminal.listSessions();
      expect(aliveSessions).toHaveLength(0);

      // --- Ownership invariant 4: the pre-crash session stays owned by its task ---
      const dead = settled.sessions.find((s) => s.tmuxSession === ctx.deadSessionId);
      expect(dead).toBeDefined();
      expect(dead!.lastStatus).toBe('completed');
      expect(dead!.crashRecovered).toBe(true);

      // --- Row-specific: a created replacement session must be reaped + tracked ---
      const replacements = settled.sessions.filter((s) => s.tmuxSession !== ctx.deadSessionId);
      if (row.createdReplacement) {
        expect(replacements).toHaveLength(1);
        expect(replacements[0].lastStatus).toBe('aborted');
        expect(await ctx.terminal.isAlive(replacements[0].tmuxSession)).toBe(false);
      } else {
        expect(replacements).toHaveLength(0);
      }
    },
  );

  test('control: a fault-free recovery relaunches and owns exactly one live session', async () => {
    const ctx = await makeContext(join(tempDir, 'control'));

    const result = await recoverCrashedSessions(
      ctx.taskStore,
      ctx.adapterRegistry,
      ctx.reconcileResult,
    );

    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.relaunched).toEqual([
      expect.objectContaining({ taskId: ctx.task.id, oldSessionId: ctx.deadSessionId }),
    ]);

    const settled = ctx.taskStore.getTask(ctx.task.id)!;
    expect(settled.status).toBe('inProgress');
    // Reservation released even on success (finally: endLaunch).
    expect(ctx.taskStore.hasFreshLaunchReservation(ctx.task.id)).toBe(false);

    // Exactly one live replacement session, owned and alive in the backend.
    const newSessionId = result.relaunched[0].newSessionId;
    expect(newSessionId).not.toBe(ctx.deadSessionId);
    expect(await ctx.terminal.isAlive(newSessionId)).toBe(true);
    const dead = settled.sessions.find((s) => s.tmuxSession === ctx.deadSessionId)!;
    expect(dead.crashRecovered).toBe(true);
    expect(await ctx.terminal.isAlive(ctx.deadSessionId)).toBe(false);
  });
});

/**
 * End-to-end: the same fault surfaced through the full startup phase must stay
 * fail-safe — the phase completes, reports the failure in its summary, and never
 * throws or leaks the reservation past the recovery step.
 */
describe('runStartupRecoveryPhase stays fail-safe when a relaunch fault fires (issue #2794)', () => {
  const AUTO_RELAUNCH_ENV = 'KOOKR_AUTO_RELAUNCH';
  let prevAutoRelaunch: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'startup-fault-phase-'));
    prevAutoRelaunch = process.env[AUTO_RELAUNCH_ENV];
    delete process.env[AUTO_RELAUNCH_ENV];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevAutoRelaunch === undefined) delete process.env[AUTO_RELAUNCH_ENV];
    else process.env[AUTO_RELAUNCH_ENV] = prevAutoRelaunch;
  });

  test('a severed adapter launch is reported, not thrown, and leaks nothing', async () => {
    const ctx = await makeContext(join(tempDir, 'phase'));
    vi.spyOn(ctx.terminal, 'createSession').mockRejectedValue(new Error('backend unreachable'));

    const monitor = { registerAgent: vi.fn(), unregisterAgent: vi.fn(), getSnapshot: vi.fn(() => []) };
    const watchdog = { registerAgent: vi.fn(), unregisterAgent: vi.fn() };
    const hookWatcher = {
      watch: vi.fn(),
      isWatching: vi.fn(() => false),
      stop: vi.fn(),
      pruneStaleReplayCheckpoints: vi.fn(() => 0),
    };
    const lifecycleDeps: AgentLifecycleDeps = {
      monitor: monitor as unknown as Monitor,
      watchdog: watchdog as unknown as Watchdog,
      hookWatcher: hookWatcher as unknown as HookFileWatcher,
      githubScanner: { isActive: () => false } as unknown as AgentLifecycleDeps['githubScanner'],
      autoNameTask: vi.fn(),
      flushTasks: vi.fn().mockResolvedValue(undefined),
    };

    const summary = await runStartupRecoveryPhase({
      taskStore: ctx.taskStore,
      queue: new AttentionQueue(),
      monitor: monitor as unknown as Monitor,
      watchdog: watchdog as unknown as Watchdog,
      terminalBackend: ctx.terminal,
      hookWatcher: hookWatcher as unknown as HookFileWatcher,
      suppressionTracker: { import: vi.fn() } as unknown as SnoozeSuppressionTracker,
      interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as unknown as DeferredInteractionLogWriter,
      adapterRegistry: ctx.adapterRegistry,
      reconcileResult: ctx.reconcileResult,
      persisted: { tasks: [] },
      lifecycleDeps,
      serverCwd: '/repo',
      broadcastToAll: vi.fn(),
      ralphLoopService: {
        reconcileStartupLoops: vi.fn().mockResolvedValue({ examined: 0, preserved: 0, failed: 0, perTask: [] }),
      } as unknown as RalphLoopService,
      restartEpoch: Date.parse('2026-09-02T00:00:00.000Z'),
    });

    // The phase completed and surfaced the failure rather than throwing.
    const failed = (summary as CrashRecoveryResult | null)?.failed ?? [];
    expect(failed).toEqual([expect.objectContaining({ taskId: ctx.task.id })]);
    // A failed relaunch registers no new agent.
    expect(monitor.registerAgent).not.toHaveBeenCalled();
    // Ownership invariants still hold end-to-end.
    expect(ctx.taskStore.hasFreshLaunchReservation(ctx.task.id)).toBe(false);
    expect(await ctx.terminal.listSessions()).toHaveLength(0);
    const settled = ctx.taskStore.getTask(ctx.task.id)!;
    expect(isTerminalStatus(settled.status)).toBe(false);
    expect(settled.sessions.find((s) => s.tmuxSession === ctx.deadSessionId)).toBeDefined();
  });
});
