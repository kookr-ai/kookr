/**
 * SIGKILL-mid-save crash-recovery fault-injection (issue #2490).
 *
 * Crash recovery is a load-bearing unattended path, but the rest of the suite
 * either mocks `recoverCrashedSessions` or hands it a hand-built store. This
 * file exercises the *real* failure Jean hits: a process is SIGKILL'd while it
 * is writing task state, leaving a truncated `tasks.json` on disk. It then
 * drives the genuine recovery pipeline end-to-end and asserts three things the
 * unattended fleet depends on:
 *
 *   1. A truncated / mid-write task-state file is self-healed OR reported —
 *      never a boot hang and never an unhandled throw (`loadTasksWithRecovery`).
 *   2. The REAL `recoverCrashedSessions` relaunches the recovered dead session
 *      (this test fails if crash-recovery is mocked out of the fixture).
 *   3. The post-recovery queue-fill "kick" decision (#2196) is correct: it
 *      fires when free slots are at/above the threshold AND the pending queue
 *      is empty, and is suppressed when the queue is non-empty, slots are below
 *      the floor, or the repo was already kicked this UTC day.
 *
 * The fault is injected by SIGKILL-ing a real child Node process that is
 * mid-write into a temp data dir — never the ambient kookr process, and never
 * a mocked relaunch. See the issue's "Risks" note.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { reconcile } from './reconciliation.js';
import { recoverCrashedSessions } from './crash-recovery.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import {
  decidePostRecoveryQueueFill,
  utcDayKey,
  POST_RECOVERY_MIN_FREE_SLOTS,
} from '../core/post-recovery-queue-fill.js';
import {
  saveTasks,
  loadTasks,
  loadTasksWithRecovery,
  CorruptTaskFileError,
} from '../core/task-persistence.js';

/** YYYYMMDD for today — matches the `.daily.<ymd>` snapshot naming in task-persistence. */
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Resolve `promise`, or reject with a labelled deadline error if it does not
 * settle within `ms`. Used to turn the acceptance criterion "not a boot hang"
 * into an actively-enforced assertion rather than one that merely leans on
 * vitest's global per-test timeout.
 */
async function withDeadline<T>(label: string, ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`boot hang: ${label} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Spawn a real child Node process that begins a NON-atomic save into
 * `tasksPath`: it writes an incomplete `truncatedPrefix` (no fsync, no
 * close+rename), signals readiness, and only schedules the *rest* of the save
 * for later. The parent SIGKILLs it after readiness, so the process dies with
 * the save genuinely in-flight — the tail write, fsync, and atomic rename never
 * happen. What survives on disk is the half-written prefix (a synchronous
 * `writeSync` before READY, so the bytes are deterministic and the test is not
 * flaky), i.e. the truncated `tasks.json` a real mid-save crash leaves behind.
 *
 * Resolves with the child's exit signal so the caller can assert the SIGKILL
 * actually landed (a real kill of a child fixture, never the ambient process).
 */
async function sigkillMidSave(tasksPath: string, truncatedPrefix: string): Promise<NodeJS.Signals | null> {
  const childScript = `
    const fs = require('fs');
    const target = process.argv[1];
    const prefix = process.argv[2];
    const fd = fs.openSync(target, 'w');
    // Save is now in-flight: only the prefix is written — no fsync, no rename.
    fs.writeSync(fd, prefix);
    process.stdout.write('READY\\n');
    // The rest of the save (tail bytes + fsync + rename) would run here, but the
    // parent SIGKILLs us first, so it never reaches disk.
    setTimeout(() => {
      fs.writeSync(fd, prefix);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }, 60_000);
  `;

  return await new Promise<NodeJS.Signals | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, tasksPath, truncatedPrefix], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let killSent = false;
    const timer = setTimeout(() => {
      if (!killSent) {
        child.kill('SIGKILL');
        reject(new Error('child writer never signalled READY within 10s'));
      }
    }, 10_000);
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      if (chunk.includes('READY') && !killSent) {
        killSent = true;
        // SIGKILL the writer with the save in-flight — no fsync, no atomic rename.
        child.kill('SIGKILL');
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (_code, signal) => {
      clearTimeout(timer);
      resolve(signal);
    });
  });
}

describe('Crash Recovery — SIGKILL mid-save fault injection (#2490)', () => {
  let taskStore: TaskStore;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let adapterRegistry: AdapterRegistry;
  let tempDir: string;
  let dataDir: string;
  let tasksPath: string;

  beforeEach(async () => {
    taskStore = new TaskStore();
    terminal = new FakeTerminalBackend();
    tempDir = await mkdtemp(join(tmpdir(), 'crash-sigkill-'));
    dataDir = join(tempDir, 'data');
    await mkdir(dataDir, { recursive: true });
    tasksPath = join(dataDir, 'tasks.json');

    const hooksDir = join(tempDir, 'hooks');
    const settingsDir = join(tempDir, 'settings');
    await mkdir(hooksDir, { recursive: true });
    await mkdir(settingsDir, { recursive: true });

    adapter = new ClaudeCodeAdapter(terminal, taskStore, {
      hooksDir,
      settingsDir,
      writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    });
    adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(adapter);
  });

  afterEach(async () => {
    // Every test mints a fresh temp dir (data/, hooks/, settings/, project/,
    // plus quarantined tasks.json.corrupt-* files) — clean it so runs don't
    // accumulate scratch state in the OS tmpdir.
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a store holding one crashed-session task, persist a VALID `tasks.json`
   * plus a matching daily snapshot, then return the valid serialized bytes so a
   * caller can truncate them into the SIGKILL fixture. The session's `cwd` is
   * created on disk so crash recovery does not skip it as a missing worktree.
   *
   * `snapshotYmd` is captured once here and reused by the caller's assertion so
   * a local-midnight rollover between seed and assert can't cause a date-string
   * mismatch flake.
   */
  async function seedValidTaskStateWithSnapshot(): Promise<{ cwd: string; serialized: string; snapshotYmd: string }> {
    const cwd = join(tempDir, 'project');
    await mkdir(cwd, { recursive: true });

    const seed = new TaskStore();
    const task = seed.createTask('Recover me after the kill', cwd);
    seed.addSession(task.id, {
      tmuxSession: `kookr-dead-${task.id.slice(0, 8)}`,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const snapshotYmd = todayYmd();
    await saveTasks(seed.getAllTasks(), tasksPath);
    // Daily snapshot alongside the live file — the surface boot recovery
    // restores from when the live file is corrupt.
    await copyFile(tasksPath, `${tasksPath}.daily.${snapshotYmd}`);

    const serialized = await readFile(tasksPath, 'utf-8');
    return { cwd, serialized, snapshotYmd };
  }

  test('SIGKILL during a task-state write leaves a genuinely truncated tasks.json', async () => {
    const { serialized } = await seedValidTaskStateWithSnapshot();
    // A faithful mid-write prefix: the first ~60% of a real serialization.
    const truncated = serialized.slice(0, Math.max(1, Math.floor(serialized.length * 0.6)));

    const signal = await sigkillMidSave(tasksPath, truncated);

    // The writer really died by signal, not a clean exit.
    expect(signal).toBe('SIGKILL');

    const onDisk = await readFile(tasksPath, 'utf-8');
    expect(onDisk).toBe(truncated);
    // Proof the truncation is real corruption, not a partial-but-valid file:
    // a plain load must throw rather than silently returning junk.
    await expect(loadTasks(tasksPath)).rejects.toThrow(CorruptTaskFileError);
  });

  test('boot self-heals a SIGKILL-truncated task-state from the daily snapshot — no hang, no throw', async () => {
    const { serialized, snapshotYmd } = await seedValidTaskStateWithSnapshot();
    const truncated = serialized.slice(0, Math.max(1, Math.floor(serialized.length * 0.6)));
    await sigkillMidSave(tasksPath, truncated);

    // The boot loader must NOT throw and must NOT hang: it quarantines the
    // corrupt file and restores the newest valid daily snapshot. The explicit
    // deadline turns "no boot hang" into an enforced assertion.
    const recovered = await withDeadline('loadTasksWithRecovery', 5_000, loadTasksWithRecovery(tasksPath));

    expect(recovered.recovery).toBeDefined();
    expect(recovered.recovery!.quarantinedPath).toContain('tasks.json.corrupt-');
    expect(recovered.recovery!.restoredFrom).toContain(`tasks.json.daily.${snapshotYmd}`);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.tasks[0].prompt).toBe('Recover me after the kill');

    // The quarantined file preserves the exact truncated bytes for forensics.
    expect(await readFile(recovered.recovery!.quarantinedPath, 'utf-8')).toBe(truncated);
    // And the live file is valid again (re-loadable without recovery).
    const reloaded = await loadTasks(tasksPath);
    expect(reloaded.tasks).toHaveLength(1);
  });

  test('boot reports a SIGKILL-truncated task-state and boots empty when no snapshot exists — no hang', async () => {
    // A truncated live file with NO daily snapshot to fall back to. Boot must
    // still make forward progress: quarantine + empty store, never a throw/hang.
    const seedCwd = join(tempDir, 'no-snapshot-project');
    await mkdir(seedCwd, { recursive: true });
    const seed = new TaskStore();
    const t = seed.createTask('anything', seedCwd);
    seed.addSession(t.id, {
      tmuxSession: `kookr-dead-${t.id.slice(0, 8)}`,
      agentType: 'claude-code',
      cwd: seedCwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await saveTasks(seed.getAllTasks(), tasksPath);
    const serialized = await readFile(tasksPath, 'utf-8');
    // No .daily snapshot copied on purpose.

    await sigkillMidSave(tasksPath, serialized.slice(0, Math.max(1, Math.floor(serialized.length * 0.5))));

    const recovered = await withDeadline('loadTasksWithRecovery', 5_000, loadTasksWithRecovery(tasksPath));
    expect(recovered.recovery).toBeDefined();
    expect(recovered.recovery!.quarantinedPath).toContain('tasks.json.corrupt-');
    expect(recovered.recovery!.restoredFrom).toBeUndefined();
    expect(recovered.tasks).toHaveLength(0);

    // No lingering live tasks.json (it was quarantined, not restored).
    const entries = await readdir(dataDir);
    expect(entries.some((e) => e === 'tasks.json')).toBe(false);
    expect(entries.some((e) => e.startsWith('tasks.json.corrupt-'))).toBe(true);
  });

  // This test satisfies the acceptance criterion "a test fails if crash-recovery
  // is mocked out of the SIGKILL fixture": it imports and drives the real
  // recoverCrashedSessions (this file never calls vi.mock), so replacing it with
  // a stub that returns no relaunch would fail the assertions below.
  test('real crash-recovery relaunches the SIGKILL-recovered dead session, then queue-fill is eligible when slots are free', async () => {
    const { serialized } = await seedValidTaskStateWithSnapshot();
    await sigkillMidSave(tasksPath, serialized.slice(0, Math.max(1, Math.floor(serialized.length * 0.6))));

    // --- Boot recovery: heal the truncated store (no hang) ---
    const recovered = await withDeadline('loadTasksWithRecovery', 5_000, loadTasksWithRecovery(tasksPath));
    expect(recovered.tasks).toHaveLength(1);

    // Hydrate a live store from the healed state, exactly as boot does.
    taskStore.loadTasks(recovered.tasks, recovered.lifetimeSpendUsd);

    // --- Real crash recovery: reconcile marks the dead session, then the
    //     genuine recoverCrashedSessions relaunches it (no mock). ---
    const reconcileResult = await reconcile(taskStore, terminal);
    const recoveredTask = taskStore.getAllTasks()[0];
    const deadSessionId = recoveredTask.sessions[0].tmuxSession;
    expect(reconcileResult.markedCompleted).toContain(deadSessionId);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].oldSessionId).toBe(deadSessionId);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const afterRecovery = taskStore.getTask(recoveredTask.id)!;
    expect(afterRecovery.status).toBe('inProgress');
    // The relaunched session is a real live session in the (fake) terminal.
    const newSessionId = result.relaunched[0].newSessionId;
    expect(await terminal.isAlive(newSessionId)).toBe(true);

    // --- Post-recovery queue-fill kick decision (#2196) ---
    // This is the real recovery "kick": decidePostRecoveryQueueFill fires when
    // capacity has returned (free slots >= threshold) AND the pending queue is
    // empty, spawning a supply-aware scout — NOT ordinary promotion of an
    // already-pending task. AC3 is asserted directly against that decision.
    const activeCount = taskStore.getActiveCount();
    const freeSlots = MAX_ACTIVE_TASKS - activeCount;
    expect(activeCount).toBe(1);
    // The one relaunched task leaves plenty of headroom above the floor.
    expect(freeSlots).toBeGreaterThanOrEqual(POST_RECOVERY_MIN_FREE_SLOTS);
    expect(taskStore.getPendingCount()).toBe(0); // queue empty post-recovery

    const nowMs = Date.now();
    const baseKickInput = {
      free: freeSlots,
      pendingQueueDepth: taskStore.getPendingCount(),
      dispatchHealthy: true,
      scoutOrBatchInFlight: false,
      lastKickUtcDay: null,
      repo: 'kookr-ai/kookr',
      nowMs,
    };

    // Free slots >= threshold AND queue empty → kick.
    const kick = decidePostRecoveryQueueFill(baseKickInput);
    expect(kick.kick).toBe(true);

    // Negative guards prove the assertion is not tautological — each guard flips
    // the decision for exactly one reason:
    // (a) a non-empty pending queue suppresses the kick,
    const pending = taskStore.createTask('Queued while offline', join(tempDir, 'project'));
    taskStore.pendTask(pending.id);
    const queued = decidePostRecoveryQueueFill({
      ...baseKickInput,
      pendingQueueDepth: taskStore.getPendingCount(),
    });
    expect(queued).toMatchObject({ kick: false, reason: 'queue_not_empty' });
    expect(taskStore.getPendingCount()).toBe(1);

    // (b) free slots below the floor suppress the kick,
    const starved = decidePostRecoveryQueueFill({
      ...baseKickInput,
      free: POST_RECOVERY_MIN_FREE_SLOTS - 1,
    });
    expect(starved).toMatchObject({ kick: false, reason: 'insufficient_free_slots' });

    // (c) an already-kicked UTC day suppresses the kick (once-per-repo-per-day).
    const repeat = decidePostRecoveryQueueFill({
      ...baseKickInput,
      lastKickUtcDay: utcDayKey(nowMs),
    });
    expect(repeat).toMatchObject({ kick: false, reason: 'already_kicked_utc_day' });
  });
});
