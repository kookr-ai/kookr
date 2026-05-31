import { describe, test, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { reconcile } from './reconciliation.js';
import { recoverCrashedSessions } from './crash-recovery.js';

describe('Crash Recovery', () => {
  let taskStore: TaskStore;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let adapterRegistry: AdapterRegistry;
  let tempDir: string;
  let hooksDir: string;
  let settingsDir: string;

  beforeEach(async () => {
    taskStore = new TaskStore();
    terminal = new FakeTerminalBackend();
    tempDir = await mkdtemp(join(tmpdir(), 'crash-recovery-'));
    hooksDir = join(tempDir, 'hooks');
    settingsDir = join(tempDir, 'settings');
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

  async function setupCrashedTask(
    prompt: string,
    cwd: string,
    sessionOverrides?: Record<string, unknown>,
  ) {
    // Ensure CWD exists
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask(prompt, cwd);
    taskStore.addSession(task.id, {
      tmuxSession: `kookr-dead-${task.id.slice(0, 8)}`,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      ...sessionOverrides,
    });
    return taskStore.getTask(task.id)!;
  }

  test('relaunches dead sessions after reconciliation', async () => {
    const cwd = join(tempDir, 'project');
    const task = await setupCrashedTask('Fix the bug', cwd);
    const deadSessionId = task.sessions[0].tmuxSession;

    // Reconcile marks the session completed and auto-transitions the task
    // to 'terminated' (rfc-task-loss-prevention D1).
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(deadSessionId);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Crash recovery relaunches
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].taskId).toBe(task.id);
    expect(result.relaunched[0].oldSessionId).toBe(deadSessionId);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    // Task should be reopened and back to inProgress (adapter.launch calls addSession)
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    expect(updatedTask.status).toBe('inProgress');
    expect(updatedTask.sessions).toHaveLength(2);

    // Old session marked as crash-recovered
    const oldSession = updatedTask.sessions.find((s) => s.tmuxSession === deadSessionId)!;
    expect(oldSession.crashRecovered).toBe(true);

    // New session has relaunch metadata
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession !== deadSessionId)!;
    expect(newSession.relaunchCount).toBe(1);
    expect(newSession.lastRelaunchedAt).toBeGreaterThan(0);
  });

  test('does NOT relaunch a spawned task that finished its turn cleanly (#693)', async () => {
    // A self-continuation chain link (parentTaskId set) that ended on a clean
    // `completed_turn` is done, not crashed. reconcile auto-completes it; crash
    // recovery must leave it terminal rather than re-running it and re-spawning
    // its successor at startup.
    const cwd = join(tempDir, 'cycle-n');
    await mkdir(cwd, { recursive: true });
    const parent = taskStore.createTask('Cycle N-1', cwd);
    const child = taskStore.createTask({
      prompt: 'Cycle N: do work then spawn cycle N+1',
      cwd,
      parentTaskId: parent.id,
    });
    const deadSessionId = `kookr-clean-${child.id.slice(0, 8)}`;
    taskStore.addSession(child.id, {
      tmuxSession: deadSessionId,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'completed_turn',
    });

    // Reconcile auto-completes the clean-finished spawned task.
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(deadSessionId);
    expect(taskStore.getTask(child.id)!.status).toBe('completed');

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].taskId).toBe(child.id);
    expect(result.skipped[0].reason).toContain('finished its turn cleanly');
    // Stays terminal — not reopened/relaunched.
    expect(taskStore.getTask(child.id)!.status).toBe('completed');
    expect(taskStore.getTask(child.id)!.sessions).toHaveLength(1);
  });

  test('still relaunches a spawned task that crashed mid-turn (#693 guard is clean-finish-only)', async () => {
    // The clean-finish skip must not suppress genuine crash recovery: a spawned
    // task whose newest session died while still `running` is a crash and is
    // relaunched as before.
    const cwd = join(tempDir, 'cycle-crash');
    await mkdir(cwd, { recursive: true });
    const parent = taskStore.createTask('Cycle parent', cwd);
    const child = taskStore.createTask({
      prompt: 'Cycle that crashed mid-work',
      cwd,
      parentTaskId: parent.id,
    });
    const deadSessionId = `kookr-crashed-${child.id.slice(0, 8)}`;
    taskStore.addSession(child.id, {
      tmuxSession: deadSessionId,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(taskStore.getTask(child.id)!.status).toBe('terminated');

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].taskId).toBe(child.id);
    expect(taskStore.getTask(child.id)!.status).toBe('inProgress');
  });

  test('skips when CWD does not exist', async () => {
    const cwd = join(tempDir, 'nonexistent-project');
    const task = await setupCrashedTask('Fix bug', cwd);
    // Don't create the CWD directory — but we need it for addSession above
    // So let's create then remove it
    await rm(cwd, { recursive: true });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('CWD does not exist');
    expect(result.relaunched).toHaveLength(0);
  });

  test('skips rapid crash-loop (recently relaunched)', async () => {
    const cwd = join(tempDir, 'project-loop');
    const task = await setupCrashedTask('Fix bug', cwd, {
      relaunchCount: 1,
      lastRelaunchedAt: Date.now() - 10_000, // 10 seconds ago — within 60s window
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('rapid crash-loop');
    expect(result.relaunched).toHaveLength(0);
  });

  test('allows recovery when lastRelaunchedAt is old (outside crash-loop window)', async () => {
    const cwd = join(tempDir, 'project-old-relaunch');
    const task = await setupCrashedTask('Fix bug', cwd, {
      relaunchCount: 3,
      lastRelaunchedAt: Date.now() - 120_000, // 2 minutes ago — outside 60s window
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    // Relaunch count should be incremented
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.relaunchCount === 4)!;
    expect(newSession).toBeDefined();
  });

  test('reopens auto-transitioned task before relaunch', async () => {
    const cwd = join(tempDir, 'project-reopen');
    const task = await setupCrashedTask('Build feature', cwd);

    // After reconcile, task is auto-transitioned to 'terminated' (all sessions dead)
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Crash recovery reopens and relaunches
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);
    expect(result.relaunched).toHaveLength(1);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
  });

  test('handles adapter.launch() failure gracefully', async () => {
    const cwd = join(tempDir, 'project-fail');
    const task = await setupCrashedTask('Do work', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);

    // Sabotage the terminal to make createSession throw
    vi.spyOn(terminal, 'createSession').mockRejectedValue(new Error('tmux broken'));

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe('tmux broken');
    expect(result.relaunched).toHaveLength(0);
  });

  test('handles multiple tasks with mixed outcomes', async () => {
    const cwd1 = join(tempDir, 'proj1');
    const cwd2 = join(tempDir, 'proj2');
    const cwd3 = join(tempDir, 'proj3-gone');

    const task1 = await setupCrashedTask('Task 1', cwd1);
    const task2 = await setupCrashedTask('Task 2', cwd2, {
      relaunchCount: 1,
      lastRelaunchedAt: Date.now() - 5_000, // crash loop
    });
    const task3 = await setupCrashedTask('Task 3', cwd3);
    await rm(cwd3, { recursive: true }); // CWD gone

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1); // task1
    expect(result.relaunched[0].taskId).toBe(task1.id);
    expect(result.skipped).toHaveLength(2); // task2 (crash-loop) + task3 (CWD gone)
    expect(result.failed).toHaveLength(0);
  });

  test('no-op when reconcile has no dead sessions', async () => {
    const cwd = join(tempDir, 'alive-project');
    await mkdir(cwd, { recursive: true });
    const task = taskStore.createTask('Running task', cwd);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-alive',
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: 'kookr-alive', command: 'claude', args: [], env: {}, cwd });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toHaveLength(0);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test('new session is registered in tmux (via adapter.launch)', async () => {
    const cwd = join(tempDir, 'project-tmux');
    const task = await setupCrashedTask('Do work', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // The new session should exist as a live tmux session
    const newTmux = result.relaunched[0].newSessionId;
    expect(await terminal.isAlive(newTmux)).toBe(true);

    // And the terminal should have the claude command
    const fakeSession = terminal.sessions.get(newTmux)!;
    expect(fakeSession.spec.command).toContain('claude');
    expect(fakeSession.spec.cwd).toBe(cwd);
  });

  test('removes stale .git/index.lock before relaunch', async () => {
    const cwd = join(tempDir, 'project-gitlock');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const lockFile = join(cwd, '.git', 'index.lock');
    await writeFile(lockFile, 'stale lock');

    const task = await setupCrashedTask('Fix thing', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);
    await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // Lock file should have been removed
    await expect(access(lockFile)).rejects.toThrow();
  });

  test('skips task that already has a running session', async () => {
    const cwd = join(tempDir, 'project-live');
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask('Fix the bug', cwd);

    // Add a live session (will be resumed by reconcile)
    const liveTmux = `kookr-live-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: liveTmux,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: liveTmux, command: 'claude', args: [], env: {}, cwd });

    // Add a dead session (will be marked completed by reconcile)
    const deadTmux = `kookr-dead-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: deadTmux,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.resumed).toContain(liveTmux);
    expect(reconcileResult.markedCompleted).toContain(deadTmux);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('task already has a running session');
    expect(result.relaunched).toHaveLength(0);
  });

  test('skips intra-pass duplicate when task has multiple dead sessions', async () => {
    const cwd = join(tempDir, 'project-multi-dead');
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask('Fix the bug', cwd);

    // Add two dead sessions (both from previous crash cycles)
    const dead1 = `kookr-dead1-${task.id.slice(0, 8)}`;
    const dead2 = `kookr-dead2-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: dead1,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    taskStore.addSession(task.id, {
      tmuxSession: dead2,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(dead1);
    expect(reconcileResult.markedCompleted).toContain(dead2);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // Only one should be relaunched, the other skipped as intra-pass duplicate
    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('task already relaunched in this recovery pass');
  });

  test('skips duplicate prompt across different tasks', async () => {
    const cwd1 = join(tempDir, 'proj-dup1');
    const cwd2 = join(tempDir, 'proj-dup2');

    // Two different tasks with identical prompts
    const task1 = await setupCrashedTask('Identical prompt text', cwd1);
    const task2 = await setupCrashedTask('Identical prompt text', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // First task gets relaunched, second is skipped as duplicate prompt
    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('duplicate prompt already running or relaunched');
  });

  test('allows different prompts to be relaunched independently', async () => {
    const cwd1 = join(tempDir, 'proj-diff1');
    const cwd2 = join(tempDir, 'proj-diff2');

    const task1 = await setupCrashedTask('Fix bug A', cwd1);
    const task2 = await setupCrashedTask('Fix bug B', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips task when identical prompt is already running in another task', async () => {
    const cwd1 = join(tempDir, 'proj-running');
    const cwd2 = join(tempDir, 'proj-dead');
    await mkdir(cwd1, { recursive: true });
    await mkdir(cwd2, { recursive: true });

    // Task 1 has a live session
    const task1 = taskStore.createTask('Same prompt', cwd1);
    const liveTmux = `kookr-live-${task1.id.slice(0, 8)}`;
    taskStore.addSession(task1.id, {
      tmuxSession: liveTmux,
      agentType: 'claude-code',
      cwd: cwd1,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: liveTmux, command: 'claude', args: [], env: {}, cwd: cwd1 });

    // Task 2 has a dead session with the same prompt
    const task2 = await setupCrashedTask('Same prompt', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.resumed).toContain(liveTmux);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('duplicate prompt already running or relaunched');
  });

  test('consecutive crash simulation — recovery works after both crashes', async () => {
    const cwd = join(tempDir, 'project-multi-crash');
    const task = await setupCrashedTask('Long task', cwd);

    // === First crash + recovery ===
    const reconcile1 = await reconcile(taskStore, terminal);
    const recovery1 = await recoverCrashedSessions(taskStore, adapterRegistry, reconcile1);
    expect(recovery1.relaunched).toHaveLength(1);
    const newTmux1 = recovery1.relaunched[0].newSessionId;

    // Verify the new session is alive
    expect(await terminal.isAlive(newTmux1)).toBe(true);

    // === Simulate second crash (kill the relaunched session) ===
    await terminal.killSession(newTmux1);

    // Wait a bit to be outside the crash-loop window in the test
    // We can't actually wait 60s, so we'll manually set lastRelaunchedAt to the past
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    const newSession1 = updatedTask.sessions.find((s) => s.tmuxSession === newTmux1)!;
    newSession1.lastRelaunchedAt = Date.now() - 120_000; // simulate 2 minutes ago

    // === Second recovery ===
    const reconcile2 = await reconcile(taskStore, terminal);
    expect(reconcile2.markedCompleted).toContain(newTmux1);

    const recovery2 = await recoverCrashedSessions(taskStore, adapterRegistry, reconcile2);
    expect(recovery2.relaunched).toHaveLength(1);
    expect(recovery2.skipped).toHaveLength(0);

    // Third session exists and is alive
    const finalTask = taskStore.getTask(task.id)!;
    expect(finalTask.sessions).toHaveLength(3);
    expect(finalTask.status).toBe('inProgress');
    const newTmux2 = recovery2.relaunched[0].newSessionId;
    expect(await terminal.isAlive(newTmux2)).toBe(true);

    // Relaunch count incremented
    const newSession2 = finalTask.sessions.find((s) => s.tmuxSession === newTmux2)!;
    expect(newSession2.relaunchCount).toBe(2);
  });

  // === Resume-on-crash (rfc-crash-recovery-resume.md) ===

  test('resume mode: passes claudeSessionId + transcriptPath to adapter when both persisted', async () => {
    const cwd = join(tempDir, 'project-resume');
    const transcriptPath = join(tempDir, 'transcripts', 'session-abc.jsonl');
    await mkdir(join(tempDir, 'transcripts'), { recursive: true });
    await writeFile(transcriptPath, '{"type":"user","content":"hello"}\n', 'utf-8');

    const task = await setupCrashedTask('Refactor auth', cwd, {
      claudeSessionId: 'session-abc',
      transcriptPath,
    });

    // Spy on adapter.launch to capture the resume argument
    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('resumed');
    expect(result.relaunched[0].fallbackReason).toBeUndefined();

    // Adapter was called with the ResumeContext
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const [calledTaskId, calledPrompt, calledCwd, calledResume] = launchSpy.mock.calls[0];
    expect(calledTaskId).toBe(task.id);
    expect(calledPrompt).toBe('Refactor auth');
    expect(calledCwd).toBe(cwd);
    expect(calledResume).toEqual({ sessionId: 'session-abc', transcriptPath });

    // New session is marked resumedFromCrash
    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession === result.relaunched[0].newSessionId)!;
    expect(newSession.resumedFromCrash).toBe(true);
  });

  test('fresh fallback: no claudeSessionId persisted (agent crashed before SessionStart)', async () => {
    const cwd = join(tempDir, 'project-no-session');
    const task = await setupCrashedTask('Fix the bug', cwd);
    // Note: no claudeSessionId, no transcriptPath set

    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('fresh');
    expect(result.relaunched[0].fallbackReason).toBe('no claudeSessionId persisted');

    // Adapter was called WITHOUT a ResumeContext
    expect(launchSpy.mock.calls[0][3]).toBeUndefined();

    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession === result.relaunched[0].newSessionId)!;
    expect(newSession.resumedFromCrash).toBeUndefined();
  });

  test('fresh fallback: transcript file is missing on disk', async () => {
    const cwd = join(tempDir, 'project-missing-transcript');
    const transcriptPath = join(tempDir, 'transcripts', 'gone.jsonl');
    // Intentionally do NOT create the transcript file

    const task = await setupCrashedTask('Fix the bug', cwd, {
      claudeSessionId: 'session-gone',
      transcriptPath,
    });

    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('fresh');
    expect(result.relaunched[0].fallbackReason).toBe('transcript file missing');
    expect(launchSpy.mock.calls[0][3]).toBeUndefined();
  });

  test('codex sessions always get fresh launch even when claudeSessionId is set', async () => {
    // Register a fake codex adapter that records its launch arguments
    const codexLaunches: Array<{ taskId: string; prompt: string; cwd: string; resume?: unknown }> = [];
    const codexAdapter = {
      agentType: 'codex-cli' as const,
      async launch(taskId: string, prompt: string, cwd: string, resume?: unknown): Promise<string> {
        codexLaunches.push({ taskId, prompt, cwd, resume });
        const tmuxName = `kookr-codex-${taskId.slice(0, 8)}`;
        await terminal.createSession({ id: tmuxName, command: 'codex', args: [], env: {}, cwd });
        taskStore.addSession(taskId, {
          tmuxSession: tmuxName,
          agentType: 'codex-cli',
          cwd,
          createdAt: new Date(),
        });
        return tmuxName;
      },
      sendInput: async () => {},
      sendKeystroke: async () => {},
      stop: async () => {},
      captureDisplay: async () => '',
      onEvent: () => {},
      onRefreshNeeded: () => {},
      injectHookEvent: () => {},
      getEffectiveHookSettings: () => undefined,
    };
    adapterRegistry.register(codexAdapter);

    const cwd = join(tempDir, 'project-codex');
    await mkdir(cwd, { recursive: true });

    // Create a Codex task whose dead session DID populate a claudeSessionId
    // (hypothetically — Codex doesn't currently emit hooks, but the recovery
    // logic must still skip resume for Codex even if the field is present).
    const task = taskStore.createTask({ prompt: 'Refactor module', cwd, agentType: 'codex-cli' });
    const deadTmux = `kookr-dead-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: deadTmux,
      agentType: 'codex-cli',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      claudeSessionId: 'codex-session-uuid',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    // Mode is 'fresh' with the agent-type fallback reason; the adapter
    // received the ResumeContext (recovery doesn't pre-filter by agentType)
    // but ignored it.
    expect(result.relaunched[0].mode).toBe('fresh');
    expect(result.relaunched[0].fallbackReason).toBe('agent type does not support resume');
    expect(codexLaunches).toHaveLength(1);
    expect(codexLaunches[0].resume).toEqual({ sessionId: 'codex-session-uuid', transcriptPath: undefined });

    // Codex session not marked resumedFromCrash
    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession !== deadTmux)!;
    expect(newSession.resumedFromCrash).toBeUndefined();
  });

  test('resume args branch: adapter passes --resume <id> --fork-session and omits the prompt', async () => {
    const cwd = join(tempDir, 'project-args');
    const transcriptPath = join(tempDir, 'transcripts', 'args-session.jsonl');
    await mkdir(join(tempDir, 'transcripts'), { recursive: true });
    await writeFile(transcriptPath, '{}\n', 'utf-8');

    await setupCrashedTask('Original prompt should not appear', cwd, {
      claudeSessionId: 'args-session',
      transcriptPath,
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);
    expect(result.relaunched).toHaveLength(1);

    // FakeTerminalBackend records sessions; inspect the launch argv.
    const session = terminal.sessions.get(result.relaunched[0].newSessionId);
    expect(session).toBeDefined();
    expect(session!.args).toContain('--resume');
    expect(session!.args).toContain('args-session');
    expect(session!.args).toContain('--fork-session');
    // The original prompt MUST NOT be in argv on a resume launch
    expect(session!.args).not.toContain('Original prompt should not appear');
  });
});
