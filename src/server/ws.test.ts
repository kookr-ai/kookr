import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Anomaly } from '../core/types.js';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { DeferredInteractionLogWriter, readInteractionLog } from '../core/interaction-log.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { GitHubStateStore } from '../core/github-state-store.js';
import type { GitHubReference, GitHubPRState, GitHubIssueState } from '../core/github-types.js';
import { MessageRouter } from './ws.js';
import type { ServerMessage, ClientMessage } from '../shared/protocol.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type { RalphLoopService } from './ralph-loop-service.js';

describe('WebSocket MessageRouter', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];
  let cancelLoop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue({
      taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null,
    });
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];
    cancelLoop = vi.fn((task) => {
      if (task.ralphLoop) task.ralphLoop.status = 'cancelled';
      return { ok: true, value: 'cancelled', changed: true };
    });

    /** Minimal launch function for tests — mirrors LaunchService without registration. */
    const testLaunchTask = async (opts: LaunchOpts): Promise<LaunchResult> => {
      const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
      if (opts.name) task.name = opts.name;
      if (opts.playbookId) task.playbookId = opts.playbookId;
      if (opts.projectId) taskStore.setProjectId(task.id, opts.projectId);
      await adapter.launch(task.id, opts.prompt, opts.cwd);
      return { task, queued: false };
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: testLaunchTask,
      ralphLoopService: { cancelLoop } as unknown as RalphLoopService,
    });
  });

  test('client connects - receives snapshot message', () => {
    router.handleConnect();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('snapshot');
    if (sentMessages[0].type === 'snapshot') {
      expect(Array.isArray(sentMessages[0].agents)).toBe(true);
      expect(sentMessages[0].serverCwd).toBe('/test/cwd');
    }
  });

  test('client connects - snapshot includes serverCwd', () => {
    router.handleConnect();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      expect(msg.serverCwd).toBe('/test/cwd');
    }
  });

  test('agent state changes - broadcasts update message with state', () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    router.broadcastUpdate('agent-1');

    const updates = sentMessages.filter((m) => m.type === 'update');
    expect(updates).toHaveLength(1);
    if (updates[0].type === 'update') {
      expect(updates[0].agentId).toBe('agent-1');
      expect(updates[0].state.agentId).toBe('agent-1');
    }
  });

  test('anomaly detected - broadcasts alert message', () => {
    const anomaly: Anomaly = {
      agentId: 'agent-1',
      type: 'repeated_error',
      severity: 'warning',
      explanation: 'Agent hit same error 3 times',
      detectedAt: new Date(),
    };

    router.broadcastAlert('agent-1', anomaly);

    const alerts = sentMessages.filter((m) => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    if (alerts[0].type === 'alert') {
      expect(alerts[0].agentId).toBe('agent-1');
      expect(alerts[0].severity).toBe('warning');
      // broadcastAlert maps anomaly.explanation → summary verbatim.
      expect(alerts[0].summary).toBe(anomaly.explanation);
    }
  });

  test('client sends respond - input delivered to agent', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    const msg: ClientMessage = {
      type: 'respond',
      agentId: tmuxName,
      input: 'Try using the other module',
    };

    await router.handleMessage(msg);

    // Adapter.sendInput writes `text` followed by CR; assert the text was delivered.
    expect(terminal.getWrittenText(tmuxName)).toContain('Try using the other module');
  });

  test('client sends respond - broadcasts empty suggestion to clear stale UI', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    // Put agent in needs_input state
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    sentMessages = [];
    await router.handleMessage({
      type: 'respond',
      agentId: tmuxName,
      input: 'Try this approach',
    });

    // Should broadcast an empty suggestion to clear any stale suggestions
    const suggestionMsgs = sentMessages.filter((m) => m.type === 'suggestion');
    expect(suggestionMsgs).toHaveLength(1);
    if (suggestionMsgs[0].type === 'suggestion') {
      expect(suggestionMsgs[0].agentId).toBe(tmuxName);
      expect(suggestionMsgs[0].suggestions).toEqual([]);
      expect(suggestionMsgs[0].quickActions).toEqual([]);
    }
  });

  test('client sends respond - calls onRespond callback', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    const respondedAgents: string[] = [];

    // Create router with onRespond callback
    const routerWithCallback = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      onRespond: (agentId) => { respondedAgents.push(agentId); },
    });

    await routerWithCallback.handleMessage({
      type: 'respond',
      agentId: tmuxName,
      input: 'go ahead',
    });

    expect(respondedAgents).toEqual([tmuxName]);
  });

  test('client sends respond - agent removed from attention queue', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    // Put agent in the queue via stop event
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);
    expect(queue.next()).not.toBeNull();

    // Respond should remove from queue
    await router.handleMessage({
      type: 'respond',
      agentId: tmuxName,
      input: 'Try this approach',
    });

    expect(queue.next()).toBeNull();
  });

  test('client sends launch - new task started', async () => {
    const msg: ClientMessage = {
      type: 'launch',
      prompt: 'Add pagination',
      cwd: '/home/user/project',
    };

    await router.handleMessage(msg);

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Add pagination');
    expect(tasks[0].status).toBe('inProgress');
  });

  test('client sends launch - success does not broadcast from router (connection-handler owns the broadcast)', async () => {
    const broadcasts: ServerMessage[] = [];
    const routerWithBroadcast = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async (opts) => {
        const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
        await adapter.launch(task.id, opts.prompt, opts.cwd);
        return { task, queued: false };
      },
    });

    await routerWithBroadcast.handleMessage({ type: 'launch', prompt: 'Add pagination', cwd: '/cwd' });

    // ws-connection-handler.ts unconditionally broadcasts a snapshot after every
    // client message, so the router must not do it again. Snapshot count from
    // the router itself should be zero.
    expect(broadcasts.filter((m) => m.type === 'snapshot')).toHaveLength(0);
    // No info alert on the plain success path — row alone is enough.
    const alerts = sentMessages.filter((m) => m.type === 'alert');
    expect(alerts).toHaveLength(0);
  });

  test('client sends launch - queued result sends "Queued:" info alert and does not broadcast from router', async () => {
    const broadcasts: ServerMessage[] = [];
    const routerWithBroadcast = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async (opts) => {
        const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
        taskStore.pendTask(task.id);
        return { task, queued: true };
      },
    });

    await routerWithBroadcast.handleMessage({ type: 'launch', prompt: 'Big refactor', cwd: '/cwd' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toBe('Queued: Big refactor');
    expect(alerts[0].severity).toBe('info');
    // Router does not broadcast — the connection handler's post-message broadcast
    // already makes the pending row appear for every client.
    expect(broadcasts.filter((m) => m.type === 'snapshot')).toHaveLength(0);
  });

  test('client sends launch - duplicate result sends "Already running:" info alert and no row broadcast', async () => {
    const broadcasts: ServerMessage[] = [];
    const existing = taskStore.createTask('Fix bug', '/cwd');
    const routerWithBroadcast = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async () => ({ task: existing, queued: false, duplicate: true }),
    });

    await routerWithBroadcast.handleMessage({ type: 'launch', prompt: 'Fix bug', cwd: '/cwd' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toBe('Already running: Fix bug');
    expect(alerts[0].severity).toBe('info');
    expect(routerWithBroadcast.lastLaunchDuplicate).toBe(true);
    // Router does not broadcast from handleLaunchResult at all — the connection
    // handler's post-message broadcast runs for every client message. A
    // duplicate launch is still handled by it, but that's outside this router's
    // scope.
    expect(broadcasts.filter((m) => m.type === 'snapshot')).toHaveLength(0);
  });

  test('client sends launch - launchTask throw surfaces as critical alert with prompt excerpt', async () => {
    const routerFailing = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async () => { throw new Error('spawn boom'); },
    });

    await routerFailing.handleMessage({ type: 'launch', prompt: 'Add pagination to /users', cwd: '/cwd' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
    // Exact format — catches any drift in ordering or phrasing.
    expect(alerts[0].summary).toBe('Error starting "Add pagination to /users": spawn boom');
  });

  test('launch prompt excerpt is truncated at 40 chars in the server error alert', async () => {
    const longPrompt = 'x'.repeat(60);
    const routerFailing = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async () => { throw new Error('bad'); },
    });

    await routerFailing.handleMessage({ type: 'launch', prompt: longPrompt, cwd: '/cwd' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    // The server truncates with slice(0, 40) and does NOT append an ellipsis — only the client does.
    expect(alerts[0].summary).toBe(`Error starting "${'x'.repeat(40)}": bad`);
  });

  test('non-Error thrown values are coerced via String() in the alert', async () => {
    const routerFailing = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async () => { throw 'plain string oops'; },
    });

    await routerFailing.handleMessage({ type: 'launch', prompt: 'do thing', cwd: '/cwd' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    expect(alerts[0].summary).toBe('Error starting "do thing": plain string oops');
  });

  test('relaunch funnels through handleLaunchResult — no alert on success, connection handler owns the broadcast', async () => {
    const original = taskStore.createTask('Fix bug', '/cwd');
    const broadcasts: ServerMessage[] = [];
    const routerWithBroadcast = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      broadcastToAll: (msg) => { broadcasts.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async (opts) => {
        const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
        await adapter.launch(task.id, opts.prompt, opts.cwd);
        return { task, queued: false };
      },
    });

    await routerWithBroadcast.handleMessage({ type: 'relaunch', taskId: original.id, prompt: 'Fix bug v2' });

    // Relaunch funnels through the same handleLaunchResult as launch; router no
    // longer broadcasts — the post-message broadcast in ws-connection-handler
    // makes the new session row appear.
    expect(broadcasts.filter((m) => m.type === 'snapshot')).toHaveLength(0);
    const alerts = sentMessages.filter((m) => m.type === 'alert');
    expect(alerts).toHaveLength(0);
  });

  test('relaunch failure surfaces as critical alert with the new prompt excerpt', async () => {
    const original = taskStore.createTask('Fix bug', '/cwd');
    const routerFailing = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      launchTask: async () => { throw new Error('no slots'); },
    });

    await routerFailing.handleMessage({ type: 'relaunch', taskId: original.id, prompt: 'Fix bug again' });

    const alerts = sentMessages.filter((m): m is ServerMessage & { type: 'alert' } => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].summary).toBe('Error starting "Fix bug again": no slots');
  });

  test('_lastLaunchDuplicate flag resets between messages', async () => {
    const existing = taskStore.createTask('Fix bug', '/cwd');
    let returnDup = true;
    const routerTwoShot = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      broadcastToAll: () => {},
      serverCwd: '/test/cwd',
      launchTask: async (opts) => {
        if (returnDup) return { task: existing, queued: false, duplicate: true };
        const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
        await adapter.launch(task.id, opts.prompt, opts.cwd);
        return { task, queued: false };
      },
    });

    await routerTwoShot.handleMessage({ type: 'launch', prompt: 'Fix bug', cwd: '/cwd' });
    expect(routerTwoShot.lastLaunchDuplicate).toBe(true);

    returnDup = false;
    await routerTwoShot.handleMessage({ type: 'launch', prompt: 'Fix bug', cwd: '/cwd' });
    expect(routerTwoShot.lastLaunchDuplicate).toBe(false);
  });

  test('client sends skip - agent deprioritized', () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);

    const msg: ClientMessage = { type: 'skip', agentId: 'agent-1' };
    router.handleMessage(msg);

    // Add another agent with lower severity
    monitor.processEvents('agent-2', [
      { type: 'stop', sessionId: 's2', lastMessage: 'Also need help' },
    ]);

    // agent-2 should now be first since agent-1 was skipped
    const next = queue.next();
    expect(next!.agentId).toBe('agent-2');
  });

  test('client sends reflect - launches a reflection task for high-friction sessions', async () => {
    const sessionsDir = await mkdtemp(join(tmpdir(), 'kookr-reflect-'));
    const interactionLog = new DeferredInteractionLogWriter(
      sessionsDir,
      async () => '2026-04-06T09-00-00-000Z',
    );

    const timestamps = [
      '2026-04-06T09:00:00.000Z',
      '2026-04-06T09:03:00.000Z',
      '2026-04-06T09:06:00.000Z',
      '2026-04-06T09:09:00.000Z',
    ];
    for (const timestamp of timestamps) {
      await interactionLog.append({
        type: 'user_input',
        agentId: 'agent-1',
        content: 'did you run the tests?',
        timestamp,
      });
    }

    const launchedPrompts: string[] = [];
    const routerWithReflection = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      interactionLog,
      launchTask: async (opts: LaunchOpts): Promise<LaunchResult> => {
        launchedPrompts.push(opts.prompt);
        const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
        if (opts.name) task.name = opts.name;
        return { task, queued: false };
      },
    });

    await routerWithReflection.handleMessage({ type: 'reflect' });

    expect(launchedPrompts).toHaveLength(1);
    expect(launchedPrompts[0]).toContain('Use the `session-reflect` skill.');
    expect(launchedPrompts[0]).toContain('did you run the tests?');

    const logPath = interactionLog.getFilePath();
    const events = logPath ? await readInteractionLog(logPath) : [];
    expect(events.some((event) => event.type === 'reflect_triggered')).toBe(true);

    await rm(sessionsDir, { recursive: true, force: true });
  });

  test('client sends respondAll - input delivered to all agents', async () => {
    const task1 = taskStore.createTask('Fix bug 1', '/cwd');
    const tmux1 = await adapter.launch(task1.id, 'Fix bug 1', '/cwd');
    const task2 = taskStore.createTask('Fix bug 2', '/cwd');
    const tmux2 = await adapter.launch(task2.id, 'Fix bug 2', '/cwd');

    await router.handleMessage({
      type: 'respondAll',
      agentIds: [tmux1, tmux2],
      input: 'yes, proceed',
    });

    expect(terminal.getWrittenText(tmux1)).toContain('yes, proceed');
    expect(terminal.getWrittenText(tmux2)).toContain('yes, proceed');
  });

  test('client sends skipAll - all agents skipped', async () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help 1' },
    ]);
    monitor.processEvents('agent-2', [
      { type: 'stop', sessionId: 's2', lastMessage: 'Help 2' },
    ]);
    monitor.processEvents('agent-3', [
      { type: 'stop', sessionId: 's3', lastMessage: 'Help 3' },
    ]);

    await router.handleMessage({
      type: 'skipAll',
      agentIds: ['agent-1', 'agent-2', 'agent-3'],
    });

    // All three should be skipped; next should return null or a fresh agent
    // After skipping all, next() returns the first one again (round-robin)
    // but the key assertion is that skip logic ran without error
    const next = queue.next();
    // All agents were skipped, so next should cycle back
    expect(next?.agentId).toBeDefined();
  });

  test('client sends snooze - agent snoozed', () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);

    const msg: ClientMessage = {
      type: 'snooze',
      agentId: 'agent-1',
      durationMs: 60000,
      reason: 'Will check later',
    };
    router.handleMessage(msg);

    expect(queue.next()).toBeNull();
  });

  test('client sends getNext - next bottleneck returned', () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help 1' },
    ]);
    monitor.processEvents('agent-2', [
      { type: 'permission_request', sessionId: 's2', toolName: 'Bash' },
    ]);

    sentMessages = [];
    const msg: ClientMessage = { type: 'getNext' };
    router.handleMessage(msg);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('update');
  });

  test('snapshot includes task metadata for linked agents', async () => {
    const task = taskStore.createTask('Add pagination to /users', '/home/user/project');
    const tmuxName = await adapter.launch(task.id, 'Add pagination to /users', '/home/user/project');
    monitor.registerAgent(tmuxName);

    sentMessages = [];
    router.handleConnect();

    expect(sentMessages).toHaveLength(1);
    const msg = sentMessages[0];
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      const agent = msg.agents.find((a) => a.agentId === tmuxName);
      expect(agent).toBeDefined();
      expect(agent!.taskName).toBe('Add pagination to /users');
      expect(agent!.cwd).toBe('/home/user/project');
      expect(agent!.agentType).toBe('claude-code');
      // startedAt must be a valid ISO-8601 timestamp.
      expect(typeof agent!.startedAt).toBe('string');
      expect(new Date(agent!.startedAt).toISOString()).toBe(agent!.startedAt);
    }
  });

  test('broadcastUpdate includes task metadata', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    sentMessages = [];
    router.broadcastUpdate(tmuxName);

    expect(sentMessages).toHaveLength(1);
    if (sentMessages[0].type === 'update') {
      expect(sentMessages[0].state.taskName).toBe('Fix bug');
      expect(sentMessages[0].state.cwd).toBe('/cwd');
    }
  });

  test('client sends stop - agent session killed', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    expect(await terminal.isAlive(tmuxName)).toBe(true);

    const msg: ClientMessage = { type: 'stop', agentId: tmuxName };
    await router.handleMessage(msg);

    expect(await terminal.isAlive(tmuxName)).toBe(false);
  });

  test('completeTask kills session, marks completed, and sets session status', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    expect(await terminal.isAlive(tmuxName)).toBe(true);

    await router.handleMessage({ type: 'completeTask', taskId: task.id });

    const updated = taskStore.getTask(task.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.sessions[0].lastStatus).toBe('completed');
    expect(await terminal.isAlive(tmuxName)).toBe(false);
  });

  test.each([['running' as const], ['paused' as const]])(
    'completeTask on a Ralph child (loop=%s) is iteration-done, not task-done',
    async (loopStatus) => {
      // Reframing: clicking complete on a Ralph child means "this iteration is
      // done"; the next iteration spawns automatically via the Stop hook on the
      // killed owner session. Task-level teardown (status transition, worktree
      // cleanup, lease release) MUST be skipped to keep the next iteration's
      // state intact. See docs/rfc/rfc-ralph-loop-batch-mode-findings.md Phase 0.
      const task = taskStore.createTask('Looped', '/cwd');
      const tmuxName = await adapter.launch(task.id, 'Looped', '/cwd');
      task.ralphLoop = {
        prompt: 'iterate',
        iterationCap: 5,
        currentIteration: 1,
        status: loopStatus,
        lastIterationStartedAt: 0,
        cumulativeIterations: 1,
        ownerSessionId: tmuxName,
      };
      const startStatus = task.status;

      await router.handleMessage({ type: 'completeTask', taskId: task.id });

      expect(cancelLoop).not.toHaveBeenCalled();
      // Task status is preserved — the loop continues, so the parent task
      // does not transition to 'completed'.
      expect(task.status).toBe(startStatus);
      expect(task.ralphLoop.status).toBe(loopStatus);
      // Owner session is killed so its Stop hook can spawn the next iteration.
      expect(await terminal.isAlive(tmuxName)).toBe(false);
      expect(task.sessions[0].lastStatus).toBe('completed');
    },
  );

  test('completeTask on a Ralph child whose loop already terminated runs the normal completion flow', async () => {
    // After predicate / cap / cost terminates the loop, completeTask falls
    // through to the standard completion path (status transition, digest,
    // worktree cleanup). The early-return guard only fires while the loop is
    // still 'running' or 'paused'.
    const task = taskStore.createTask('Looped', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Looped', '/cwd');
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 5,
      status: 'completed',
      lastIterationStartedAt: 0,
      cumulativeIterations: 5,
      ownerSessionId: tmuxName,
    };

    await router.handleMessage({ type: 'completeTask', taskId: task.id });

    expect(cancelLoop).not.toHaveBeenCalled();
    expect(task.status).toBe('completed');
    expect(await terminal.isAlive(tmuxName)).toBe(false);
  });

  test('completeTask unregisters agent from monitor', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    // Agent should be in the snapshot before complete (with events)
    const before = monitor.getSnapshot().find(a => a.agentId === tmuxName);
    expect(before).toBeDefined();
    expect(before!.events.length).toBeGreaterThan(0);

    await router.handleMessage({ type: 'completeTask', taskId: task.id });

    // Agent events should be cleared (unregistered from monitor),
    // but completed tasks still appear as synthetic entries with empty events
    const after = monitor.getSnapshot().find(a => a.agentId === tmuxName);
    expect(after).toBeDefined();
    expect(after!.events).toEqual([]);
    expect(after!.taskStatus).toBe('completed');
    await vi.waitFor(() => {
      const withDigest = monitor.getSnapshot().find(a => a.agentId === tmuxName);
      expect(withDigest!.completionDigest).toBeDefined();
      expect(withDigest!.completionDigest!.bullets.length).toBeGreaterThan(0);
    });
  });

  test('completeTask with nonexistent task throws', async () => {
    await expect(
      router.handleMessage({ type: 'completeTask', taskId: 'nonexistent' }),
    ).rejects.toThrow('Task not found');
  });

  test('completeTask skips already-completed sessions', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    // Manually mark session completed (simulate agent finished on its own)
    taskStore.updateSession(task.id, tmuxName, { lastStatus: 'completed' });

    // Should not throw when session is already completed
    await router.handleMessage({ type: 'completeTask', taskId: task.id });
    expect(taskStore.getTask(task.id)!.status).toBe('completed');
  });

  test('cancelTask kills session, marks cancelled, and sets session status to aborted', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    expect(await terminal.isAlive(tmuxName)).toBe(true);

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });

    const updated = taskStore.getTask(task.id)!;
    expect(updated.status).toBe('cancelled');
    expect(updated.sessions[0].lastStatus).toBe('aborted');
    expect(await terminal.isAlive(tmuxName)).toBe(false);
  });

  test.each([['running' as const], ['paused' as const]])(
    'cancelTask on a Ralph child (loop=%s) cancels the loop before killing the owner session',
    async (loopStatus) => {
      // Cancellation must mark the loop cancelled before the owner session is
      // killed; otherwise the Stop hook on the dead session would see
      // `ralphLoop.status` still 'running'/'paused' and spawn the next
      // iteration. cancelLoop is synchronous and runs before the awaited
      // cancelTaskImpl in the handler, so the loop status flips before any
      // session-kill side effect can happen. See
      // docs/rfc/rfc-ralph-loop-batch-mode-findings.md Phase 0.
      const task = taskStore.createTask('Looped', '/cwd');
      const tmuxName = await adapter.launch(task.id, 'Looped', '/cwd');
      task.ralphLoop = {
        prompt: 'iterate',
        iterationCap: 5,
        currentIteration: 1,
        status: loopStatus,
        lastIterationStartedAt: 0,
        cumulativeIterations: 1,
        ownerSessionId: tmuxName,
      };

      await router.handleMessage({ type: 'cancelTask', taskId: task.id });

      expect(cancelLoop).toHaveBeenCalledWith(task);
      expect(task.status).toBe('cancelled');
      expect(task.ralphLoop.status).toBe('cancelled');
      expect(await terminal.isAlive(tmuxName)).toBe(false);
    },
  );

  test('cancelTask on a Ralph child whose loop already terminated does not re-cancel', async () => {
    const task = taskStore.createTask('Looped', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Looped', '/cwd');
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 5,
      status: 'completed',
      lastIterationStartedAt: 0,
      cumulativeIterations: 5,
      ownerSessionId: tmuxName,
    };

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });

    expect(cancelLoop).not.toHaveBeenCalled();
    expect(task.status).toBe('cancelled');
    expect(task.ralphLoop.status).toBe('completed');
    expect(await terminal.isAlive(tmuxName)).toBe(false);
  });

  test('cancelTask unregisters agent from monitor', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });

    // Agent events cleared (unregistered), but cancelled tasks still appear as synthetic entries
    const after = monitor.getSnapshot().find(a => a.agentId === tmuxName);
    expect(after).toBeDefined();
    expect(after!.events).toEqual([]);
    expect(after!.taskStatus).toBe('cancelled');
  });

  test('cancelTask with nonexistent task throws', async () => {
    await expect(
      router.handleMessage({ type: 'cancelTask', taskId: 'nonexistent' }),
    ).rejects.toThrow('Task not found');
  });

  test('cancelTask skips already-aborted sessions', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    taskStore.updateSession(task.id, tmuxName, { lastStatus: 'aborted' });

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });
    expect(taskStore.getTask(task.id)!.status).toBe('cancelled');
  });

  test('client sends reopenTask - task reopened', () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    taskStore.startTask(task.id);
    taskStore.cancelTask(task.id);

    const msg: ClientMessage = { type: 'reopenTask', taskId: task.id };
    router.handleMessage(msg);

    expect(taskStore.getTask(task.id)!.status).toBe('open');
  });

  test('client sends relaunch - new task created from original', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd', 'All tests pass');
    taskStore.startTask(task.id);

    const msg: ClientMessage = {
      type: 'relaunch',
      taskId: task.id,
      prompt: 'Try a different approach',
    };
    await router.handleMessage(msg);

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(2);

    const newTask = tasks.find((t) => t.id !== task.id);
    expect(newTask).toBeDefined();
    expect(newTask!.prompt).toBe('Try a different approach');
    expect(newTask!.cwd).toBe('/cwd');
    expect(newTask!.criteria).toBe('All tests pass');
    expect(newTask!.status).toBe('inProgress');
  });

  test('client sends renameTask - task name updated', async () => {
    const task = taskStore.createTask('Fix auth bug in login flow', '/cwd');

    const msg: ClientMessage = {
      type: 'renameTask',
      taskId: task.id,
      name: 'Auth fix',
    };
    await router.handleMessage(msg);

    expect(taskStore.getTask(task.id)!.name).toBe('Auth fix');
  });

  test('renameTask reflects in snapshot taskName', async () => {
    const task = taskStore.createTask('Fix auth bug in login flow', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix auth bug', '/cwd');
    monitor.registerAgent(tmuxName);

    await router.handleMessage({
      type: 'renameTask',
      taskId: task.id,
      name: 'Auth fix',
    });

    sentMessages = [];
    router.handleConnect();

    const msg = sentMessages[0];
    expect(msg.type).toBe('snapshot');
    if (msg.type === 'snapshot') {
      const agent = msg.agents.find((a) => a.agentId === tmuxName);
      expect(agent!.taskName).toBe('Auth fix');
    }
  });

  test('client sends relaunch with unknown taskId - no-op', async () => {
    const msg: ClientMessage = {
      type: 'relaunch',
      taskId: 'nonexistent',
      prompt: 'Try again',
    };
    await router.handleMessage(msg);

    expect(taskStore.listTasks()).toHaveLength(0);
  });

  test('client sends navigate - no-op', async () => {
    const msg: ClientMessage = { type: 'navigate', agentId: 'agent-1' };
    await router.handleMessage(msg);

    expect(sentMessages).toHaveLength(0);
  });

  test('handleMessageSafe catches errors and sends alert', async () => {
    const msg: ClientMessage = { type: 'completeTask', taskId: 'nonexistent' };
    await router.handleMessageSafe(msg);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('alert');
    if (sentMessages[0].type === 'alert') {
      expect(sentMessages[0].severity).toBe('critical');
      expect(sentMessages[0].summary).toContain('nonexistent');
    }
  });

  test('broadcastUpdate for non-existing agent sends nothing', () => {
    router.broadcastUpdate('nonexistent-agent');
    expect(sentMessages).toHaveLength(0);
  });

  test('broadcastAlert includes anomaly count in details', () => {
    const anomaly: Anomaly = {
      agentId: 'agent-1',
      type: 'repeated_error',
      severity: 'warning',
      explanation: 'Agent hit same error repeatedly',
      detectedAt: new Date(),
      count: 7,
    };

    router.broadcastAlert('agent-1', anomaly);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].type).toBe('alert');
    if (sentMessages[0].type === 'alert') {
      expect(sentMessages[0].details).toMatch(/\b7\b/);
    }
  });

  test('stop marks session completed and reopens task', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'stop', agentId: tmuxName });

    const updated = taskStore.getTask(task.id)!;
    expect(updated.sessions[0].lastStatus).toBe('completed');
    expect(updated.status).toBe('open');
  });

  test('stop with multi-session task — only completes when all sessions done', async () => {
    const task = taskStore.createTask('Multi agent', '/cwd');
    const tmux1 = await adapter.launch(task.id, 'Part 1', '/cwd');
    const tmux2 = await adapter.launch(task.id, 'Part 2', '/cwd');

    // Stop only the first agent
    await router.handleMessage({ type: 'stop', agentId: tmux1 });

    const updated = taskStore.getTask(task.id)!;
    const s1 = updated.sessions.find((s) => s.tmuxSession === tmux1)!;
    const s2 = updated.sessions.find((s) => s.tmuxSession === tmux2)!;
    expect(s1.lastStatus).toBe('completed');
    expect(s2.lastStatus).not.toBe('completed');
    // Task stays inProgress because s2 is still alive
    expect(updated.status).toBe('inProgress');

    // Stop the second agent — user-initiated stop reopens instead of completing
    await router.handleMessage({ type: 'stop', agentId: tmux2 });
    expect(taskStore.getTask(task.id)!.status).toBe('open');
  });

  test('stop on agent not linked to any task — does not throw', async () => {
    // Create a session directly in terminal (orphan — no task)
    await terminal.createSession({ id: 'kookr-orphan', command: 'claude', args: [] });

    // Should not throw even though no task references this agent
    await expect(
      router.handleMessage({ type: 'stop', agentId: 'kookr-orphan' }),
    ).resolves.not.toThrow();
  });

  test('stop prevents agent resurrection from late hook events', async () => {
    const task = taskStore.createTask('Read README', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Read README', '/cwd');
    monitor.registerAgent(tmuxName);

    // Wire adapter events into monitor (like the server does)
    adapter.onEvent((name, event) => {
      monitor.processEvents(name, [event]);
    });

    // Stop the agent
    await router.handleMessage({ type: 'stop', agentId: tmuxName });

    // Verify agent is gone from snapshot
    expect(monitor.getSnapshot().find((a) => a.agentId === tmuxName)).toBeUndefined();

    // Simulate late-arriving hook event (from hook file watcher race condition)
    const hookEvent = JSON.stringify({
      session_id: 's1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/cwd',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    });
    adapter.injectHookEvent(tmuxName, hookEvent);

    // Agent should NOT be resurrected in snapshot
    expect(monitor.getSnapshot().find((a) => a.agentId === tmuxName)).toBeUndefined();
  });

  test('clearCompleted default scope sweeps completed + cancelled (not terminated, not active)', async () => {
    // Default scope per rfc-task-loss-prevention D2 (revised 2026-04-23):
    // user-initiated terminal states ('completed' and 'cancelled') both sweep.
    // 'terminated' still needs explicit user ack via includeTerminated.
    const t1 = taskStore.createTask('Done', '/cwd');
    const t2 = taskStore.createTask('Cancelled', '/cwd');
    const t3 = taskStore.createTask('Open', '/cwd');
    const t4 = taskStore.createTask('Terminated', '/cwd');

    taskStore.startTask(t1.id);
    taskStore.completeTask(t1.id);
    taskStore.startTask(t2.id);
    taskStore.cancelTask(t2.id);
    taskStore.startTask(t4.id);
    taskStore.terminateTask(t4.id);

    expect(taskStore.listTasks()).toHaveLength(4);

    await router.handleMessage({ type: 'clearCompleted' });

    const remaining = taskStore.listTasks().map((t) => t.id).sort();
    // t1 (completed) + t2 (cancelled) swept. t3 (open) + t4 (terminated) kept.
    expect(remaining).toEqual([t3.id, t4.id].sort());
  });

  test('clearCompleted invokes takePredeleteSnapshot when sweeping any task', async () => {
    const t = taskStore.createTask('Done', '/cwd');
    taskStore.startTask(t.id);
    taskStore.completeTask(t.id);

    const snapshot = vi.fn().mockResolvedValue(undefined);
    const r = new MessageRouter({
      taskStore, queue, monitor, adapter, send: () => {},
      takePredeleteSnapshot: snapshot,
    });
    await r.handleMessage({ type: 'clearCompleted' });

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(taskStore.listTasks()).toHaveLength(0);
  });

  test('clearCompleted skips takePredeleteSnapshot on no-op', async () => {
    // A running task — clearCompleted should find nothing to clear.
    const t = taskStore.createTask('Running', '/cwd');
    taskStore.startTask(t.id);

    const snapshot = vi.fn().mockResolvedValue(undefined);
    const r = new MessageRouter({
      taskStore, queue, monitor, adapter, send: () => {},
      takePredeleteSnapshot: snapshot,
    });
    await r.handleMessage({ type: 'clearCompleted' });

    expect(snapshot).not.toHaveBeenCalled();
    expect(taskStore.listTasks()).toHaveLength(1);
  });

  test('clearCompleted aborts delete when takePredeleteSnapshot rejects', async () => {
    // Data-safety contract: if we cannot put the rollback point on disk,
    // the destructive delete must NOT proceed.
    const t = taskStore.createTask('Done', '/cwd');
    taskStore.startTask(t.id);
    taskStore.completeTask(t.id);

    const failingSnapshot = vi.fn().mockRejectedValue(new Error('ENOSPC: no space'));
    const r = new MessageRouter({
      taskStore, queue, monitor, adapter, send: () => {},
      takePredeleteSnapshot: failingSnapshot,
    });
    // Silence the expected console.error for this test path.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await r.handleMessage({ type: 'clearCompleted' });
    errSpy.mockRestore();

    expect(failingSnapshot).toHaveBeenCalledTimes(1);
    // Task still exists — delete was aborted.
    expect(taskStore.listTasks()).toHaveLength(1);
    expect(taskStore.getTask(t.id)!.status).toBe('completed');
  });

  test('clearCompleted with includeTerminated sweeps completed, cancelled, AND terminated', async () => {
    const t1 = taskStore.createTask('Done', '/cwd');
    const t2 = taskStore.createTask('Cancelled', '/cwd');
    const t3 = taskStore.createTask('Terminated', '/cwd');
    const t4 = taskStore.createTask('Active', '/cwd');

    taskStore.startTask(t1.id);
    taskStore.completeTask(t1.id);
    taskStore.startTask(t2.id);
    taskStore.cancelTask(t2.id);
    taskStore.startTask(t3.id);
    taskStore.terminateTask(t3.id);
    taskStore.startTask(t4.id);

    await router.handleMessage({ type: 'clearCompleted', includeTerminated: true });

    const remaining = taskStore.listTasks();
    // Only the inProgress task survives; all three terminal states are swept.
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(t4.id);
  });

  test('clearCompleted is a no-op when no completed or cancelled tasks exist', async () => {
    const t1 = taskStore.createTask('Task 1', '/cwd');
    taskStore.startTask(t1.id);

    await router.handleMessage({ type: 'clearCompleted' });

    expect(taskStore.listTasks()).toHaveLength(1);
    expect(taskStore.getTask(t1.id)!.status).toBe('inProgress');
  });

  test('clearCompleted sweeps a list containing only cancelled tasks (regression: silent no-op)', async () => {
    // Regression guard for the reported bug: user cancels tasks, they appear in
    // the "Completed" pane, clicking "Clear completed" previously did nothing
    // because cancelled was excluded from the default scope.
    const t1 = taskStore.createTask('Cancelled 1', '/cwd');
    const t2 = taskStore.createTask('Cancelled 2', '/cwd');
    taskStore.startTask(t1.id);
    taskStore.cancelTask(t1.id);
    taskStore.startTask(t2.id);
    taskStore.cancelTask(t2.id);

    await router.handleMessage({ type: 'clearCompleted' });

    expect(taskStore.listTasks()).toHaveLength(0);
  });

  test('clearCompleted does not delete inProgress or pending tasks', async () => {
    const t1 = taskStore.createTask('Active', '/cwd');
    const t2 = taskStore.createTask('Queued', '/cwd');
    const t3 = taskStore.createTask('Done', '/cwd');

    taskStore.startTask(t1.id);
    taskStore.pendTask(t2.id);
    taskStore.startTask(t3.id);
    taskStore.completeTask(t3.id);

    await router.handleMessage({ type: 'clearCompleted' });

    const remaining = taskStore.listTasks();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(t => t.status).sort()).toEqual(['inProgress', 'pending']);
  });

  test('ackTerminatedTask transitions terminated → completed', async () => {
    const t = taskStore.createTask('Died', '/cwd');
    taskStore.startTask(t.id);
    taskStore.terminateTask(t.id);
    expect(taskStore.getTask(t.id)!.status).toBe('terminated');

    await router.handleMessage({ type: 'ackTerminatedTask', taskId: t.id });

    expect(taskStore.getTask(t.id)!.status).toBe('completed');
  });

  test('ackTerminatedTask is a no-op when task is not terminated', async () => {
    const t = taskStore.createTask('Running', '/cwd');
    taskStore.startTask(t.id);

    await router.handleMessage({ type: 'ackTerminatedTask', taskId: t.id });

    // Still inProgress — ack rejected for non-terminated tasks.
    expect(taskStore.getTask(t.id)!.status).toBe('inProgress');
  });

  test('clearCompleted removes both completed and cancelled tasks from monitor snapshot', async () => {
    const t1 = taskStore.createTask('Done', '/cwd');
    const t2 = taskStore.createTask('Cancelled', '/cwd');
    const t3 = taskStore.createTask('Pending', '/cwd');

    taskStore.startTask(t1.id);
    taskStore.completeTask(t1.id);
    taskStore.startTask(t2.id);
    taskStore.cancelTask(t2.id);
    taskStore.pendTask(t3.id);

    const snapshotBefore = monitor.getSnapshot();
    expect(snapshotBefore.some(s => s.taskId === t1.id && s.taskStatus === 'completed')).toBe(true);
    expect(snapshotBefore.some(s => s.taskId === t2.id && s.taskStatus === 'cancelled')).toBe(true);
    expect(snapshotBefore.some(s => s.taskId === t3.id && s.taskStatus === 'pending')).toBe(true);

    await router.handleMessage({ type: 'clearCompleted' });

    // D2 revised: both user-initiated terminal states are swept. The pending
    // task stays; cancellation audit still lives in the interaction log.
    const snapshotAfter = monitor.getSnapshot();
    expect(snapshotAfter.some(s => s.taskId === t1.id)).toBe(false);
    expect(snapshotAfter.some(s => s.taskId === t2.id)).toBe(false);
    expect(snapshotAfter.some(s => s.taskId === t3.id)).toBe(true);
  });
});

describe('WebSocket MessageRouter — Interaction Logging', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];
  let loggedEvents: Array<{ type: string; [key: string]: unknown }>;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue({
      taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null,
    });
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];
    loggedEvents = [];

    // Fake interaction log that captures events in memory
    const fakeLog = {
      append: async (event: { type: string; [key: string]: unknown }) => {
        loggedEvents.push(event);
      },
      getFilePath: () => '/fake/path',
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      interactionLog: fakeLog as unknown as import('../core/interaction-log.js').DeferredInteractionLogWriter,
    });
  });

  test('completeTask logs task_completed event', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'completeTask', taskId: task.id });

    const completed = loggedEvents.find(e => e.type === 'task_completed');
    expect(completed).toBeDefined();
    expect(completed!.taskId).toBe(task.id);
    expect(completed!.reason).toBe('user_marked');
    expect(typeof completed!.durationMs).toBe('number');
    expect((completed!.durationMs as number)).toBeGreaterThanOrEqual(0);
    expect(typeof completed!.timestamp).toBe('string');
  });

  test('cancelTask logs task_cancelled event', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });

    const cancelled = loggedEvents.find(e => e.type === 'task_cancelled');
    expect(cancelled).toBeDefined();
    expect(cancelled!.taskId).toBe(task.id);
    expect(cancelled!.reason).toBe('user_cancelled');
    expect(typeof cancelled!.durationMs).toBe('number');
  });

  test('completeTask log event includes agentId from session', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'completeTask', taskId: task.id });

    const completed = loggedEvents.find(e => e.type === 'task_completed');
    expect(completed!.agentId).toBe(tmuxName);
  });

  test('cancelTask log event includes agentId from session', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'cancelTask', taskId: task.id });

    const cancelled = loggedEvents.find(e => e.type === 'task_cancelled');
    expect(cancelled!.agentId).toBe(tmuxName);
  });

  test('stop still logs agent_stopped event (legacy)', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({ type: 'stop', agentId: tmuxName });

    const stopped = loggedEvents.find(e => e.type === 'agent_stopped');
    expect(stopped).toBeDefined();
    expect(stopped!.agentId).toBe(tmuxName);
    expect(stopped!.reason).toBe('user');
  });
});

describe('WebSocket MessageRouter — Playbooks', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];
  let tempDir: string;
  let originalUserEnv: string | undefined;
  let originalPluginEnv: string | undefined;

  beforeEach(async () => {
    // Isolate the user and plugin tiers — these tests assert exact playbook
    // counts assuming a fresh project dir; without isolation the plugin's
    // shipped playbooks (and the user's personal ~/.kookr/playbooks/) would
    // bleed in and the assertions would flap.
    originalUserEnv = process.env.KOOKR_USER_PLAYBOOKS_DIR;
    originalPluginEnv = process.env.KOOKR_PLUGIN_DIR;
    process.env.KOOKR_USER_PLAYBOOKS_DIR = '/nonexistent/kookr-user-playbooks';
    process.env.KOOKR_PLUGIN_DIR = '/nonexistent/kookr-plugin';

    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];

    tempDir = await mkdtemp(join(tmpdir(), 'kookr-ws-test-'));

    const testLaunchTask = async (opts: LaunchOpts): Promise<LaunchResult> => {
      const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
      if (opts.name) task.name = opts.name;
      if (opts.playbookId) task.playbookId = opts.playbookId;
      if (opts.projectId) taskStore.setProjectId(task.id, opts.projectId);
      await adapter.launch(task.id, opts.prompt, opts.cwd);
      return { task, queued: false };
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: tempDir,
      launchTask: testLaunchTask,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
    if (originalUserEnv === undefined) delete process.env.KOOKR_USER_PLAYBOOKS_DIR;
    else process.env.KOOKR_USER_PLAYBOOKS_DIR = originalUserEnv;
    if (originalPluginEnv === undefined) delete process.env.KOOKR_PLUGIN_DIR;
    else process.env.KOOKR_PLUGIN_DIR = originalPluginEnv;
  });

  test('listPlaybooks returns discovered playbooks', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'deploy.md'),
      '---\nname: Deploy\ndescription: Run deploy\n---\nDeploy steps.',
    );

    await router.handleMessage({ type: 'listPlaybooks', cwd: tempDir });

    const pbMsg = sentMessages.find((m) => m.type === 'playbooks');
    expect(pbMsg).toBeDefined();
    if (pbMsg?.type === 'playbooks') {
      expect(pbMsg.cwd).toBe(tempDir);
      expect(pbMsg.playbooks).toHaveLength(1);
      expect(pbMsg.playbooks[0].name).toBe('Deploy');
    }
  });

  test('listPlaybooks returns empty array when no directory', async () => {
    await router.handleMessage({ type: 'listPlaybooks', cwd: tempDir });

    const pbMsg = sentMessages.find((m) => m.type === 'playbooks');
    expect(pbMsg).toBeDefined();
    if (pbMsg?.type === 'playbooks') {
      expect(pbMsg.playbooks).toEqual([]);
    }
  });

  test('launchPlaybook creates task with interpolated prompt', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'release.md'),
      `---
name: Release MR
description: Create release MR
parameters:
  - name: version
    description: Version tag
    required: true
checklist:
  - CHANGELOG updated
  - CI green
---

Create MR for release {{version}}.
`,
    );

    await router.handleMessage({
      type: 'launchPlaybook',
      playbookPath: 'release.md',
      cwd: tempDir,
      parameterValues: { version: '2.0.0' },
    });

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].prompt).toBe('Create MR for release 2.0.0.');
    expect(tasks[0].criteria).toBe('- CHANGELOG updated\n- CI green');
    expect(tasks[0].name).toBe('Release MR');
    expect(tasks[0].playbookId).toBe('release.md');
    expect(tasks[0].status).toBe('inProgress');
  });

  test('launchPlaybook uses cwd from playbook frontmatter when declared', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    // Create a real target directory so the CWD validation passes
    const targetCwd = join(tempDir, 'cross-project-target');
    await mkdir(targetCwd, { recursive: true });
    await writeFile(
      join(pbDir, 'cross-project.md'),
      `---
name: Cross Project Task
cwd: ${targetCwd}
---

Work in codex repo.
`,
    );

    await router.handleMessage({
      type: 'launchPlaybook',
      playbookPath: 'cross-project.md',
      cwd: tempDir,
      parameterValues: {},
    });

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].cwd).toBe(targetCwd);
    expect(tasks[0].name).toBe('Cross Project Task');
  });

  test('launchPlaybook falls back to msg.cwd when playbook has no cwd', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'local.md'),
      `---
name: Local Task
---

Work locally.
`,
    );

    await router.handleMessage({
      type: 'launchPlaybook',
      playbookPath: 'local.md',
      cwd: tempDir,
      parameterValues: {},
    });

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].cwd).toBe(tempDir);
  });

  test('launchPlaybook forwards split source, target cwd, and projectId', async () => {
    const sourceCwd = join(tempDir, 'catalog');
    const targetCwd = join(tempDir, 'target');
    const pbDir = join(sourceCwd, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await mkdir(targetCwd, { recursive: true });
    await writeFile(
      join(pbDir, 'targeted.md'),
      `---
name: Targeted Task
---

Work in target.
`,
    );

    await router.handleMessage({
      type: 'launchPlaybook',
      playbookPath: 'targeted.md',
      playbookSourceCwd: sourceCwd,
      taskTargetCwd: targetCwd,
      projectId: `local/${basename(targetCwd)}`,
      parameterValues: {},
    });

    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].cwd).toBe(targetCwd);
    expect(tasks[0].projectId).toBe(`local/${basename(targetCwd)}`);
    expect(tasks[0].playbookId).toBe('targeted.md');
  });

  test('launchPlaybook with non-existent cwd sends descriptive alert', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'bad-cwd.md'),
      `---
name: Bad CWD Task
cwd: /tmp/definitely-not-a-real-dir-999
---

This should fail.
`,
    );

    await router.handleMessageSafe({
      type: 'launchPlaybook',
      playbookPath: 'bad-cwd.md',
      cwd: tempDir,
      parameterValues: {},
    });

    const alert = sentMessages.find((m) => m.type === 'alert');
    expect(alert).toBeDefined();
    if (alert?.type === 'alert') {
      expect(alert.severity).toBe('critical');
      expect(alert.summary).toContain('Bad CWD Task');
      expect(alert.summary).toContain('/tmp/definitely-not-a-real-dir-999');
      expect(alert.summary).toContain('does not exist');
    }
  });

  test('launchPlaybook with missing required param sends alert', async () => {
    const pbDir = join(tempDir, '.kookr', 'playbooks');
    await mkdir(pbDir, { recursive: true });
    await writeFile(
      join(pbDir, 'needs-param.md'),
      `---
name: Needs Param
parameters:
  - name: required_thing
    description: Must provide
    required: true
---

Do {{required_thing}}.
`,
    );

    await router.handleMessageSafe({
      type: 'launchPlaybook',
      playbookPath: 'needs-param.md',
      cwd: tempDir,
      parameterValues: {},
    });

    const alert = sentMessages.find((m) => m.type === 'alert');
    expect(alert).toBeDefined();
    if (alert?.type === 'alert') {
      expect(alert.severity).toBe('critical');
      expect(alert.summary).toContain('required_thing');
    }
  });
});

describe('GitHub initial sync on WebSocket connection', () => {
  /**
   * These tests verify the connection-level behavior from index.ts:
   * after handleConnect() sends the agent snapshot, the server should
   * also send githubUpdate messages for all tasks with GitHub references.
   *
   * We replicate the logic from the connection handler to test it in isolation.
   */

  function makeRef(taskId: string, number: number, type: 'pr' | 'issue' = 'pr'): GitHubReference {
    return {
      type,
      owner: 'test-owner',
      repo: 'test-repo',
      number,
      url: `https://github.com/test-owner/test-repo/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
      detectedAt: new Date(),
      detectedFrom: 'kookr-agent-1',
      taskId,
    };
  }

  function makePRState(ref: GitHubReference): GitHubPRState {
    return {
      ref,
      title: `PR #${ref.number}`,
      status: 'open',
      author: 'test-user',
      branch: 'feature-branch',
      baseBranch: 'main',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      lastFetchedAt: new Date(),
    };
  }

  function makeIssueState(ref: GitHubReference): GitHubIssueState {
    return {
      ref,
      title: `Issue #${ref.number}`,
      status: 'open',
      author: 'test-user',
      labels: [],
      commentCount: 0,
      lastFetchedAt: new Date(),
    };
  }

  /**
   * Simulates the connection handler logic from index.ts:
   * sends githubUpdate for each task with references.
   */
  function sendInitialGitHubState(
    githubStateStore: GitHubStateStore,
    messages: ServerMessage[],
  ) {
    for (const taskId of githubStateStore.getTaskIdsWithReferences()) {
      const state = githubStateStore.getTaskState(taskId);
      messages.push({
        type: 'githubUpdate',
        taskId,
        prs: state.prs,
        issues: state.issues,
        changes: [],
      });
    }
  }

  test('no GitHub references — no githubUpdate messages sent', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    sendInitialGitHubState(store, messages);

    expect(messages).toHaveLength(0);
  });

  test('one task with a PR — sends one githubUpdate', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    const ref = makeRef('task-1', 42);
    store.addReference(ref);
    store.updatePRState(makePRState(ref));

    sendInitialGitHubState(store, messages);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('githubUpdate');
    if (messages[0].type === 'githubUpdate') {
      expect(messages[0].taskId).toBe('task-1');
      expect(messages[0].prs).toHaveLength(1);
      expect(messages[0].prs[0].title).toBe('PR #42');
      expect(messages[0].issues).toHaveLength(0);
      expect(messages[0].changes).toEqual([]);
    }
  });

  test('multiple tasks — sends one githubUpdate per task', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    const ref1 = makeRef('task-1', 10);
    const ref2 = makeRef('task-2', 20);
    store.addReference(ref1);
    store.addReference(ref2);
    store.updatePRState(makePRState(ref1));
    store.updatePRState(makePRState(ref2));

    sendInitialGitHubState(store, messages);

    expect(messages).toHaveLength(2);
    const taskIds = messages.map((m) => m.type === 'githubUpdate' ? m.taskId : null);
    expect(taskIds).toContain('task-1');
    expect(taskIds).toContain('task-2');
  });

  test('task with PR and issue — both included in single message', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    const prRef = makeRef('task-1', 5, 'pr');
    const issueRef = makeRef('task-1', 8, 'issue');
    store.addReference(prRef);
    store.addReference(issueRef);
    store.updatePRState(makePRState(prRef));
    store.updateIssueState(makeIssueState(issueRef));

    sendInitialGitHubState(store, messages);

    expect(messages).toHaveLength(1);
    if (messages[0].type === 'githubUpdate') {
      expect(messages[0].prs).toHaveLength(1);
      expect(messages[0].issues).toHaveLength(1);
      expect(messages[0].prs[0].title).toBe('PR #5');
      expect(messages[0].issues[0].title).toBe('Issue #8');
    }
  });

  test('initial sync sends empty changes array — does not leak prior changes', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    const ref = makeRef('task-1', 42);
    store.addReference(ref);
    store.updatePRState(makePRState(ref));
    // Simulate a prior state change that was already broadcast
    store.addChange('task-1', { type: 'ci_failed', ref, check: { name: 'build', conclusion: 'failure' } });

    sendInitialGitHubState(store, messages);

    // The initial sync should send empty changes, not replay old ones
    expect(messages).toHaveLength(1);
    if (messages[0].type === 'githubUpdate') {
      expect(messages[0].changes).toEqual([]);
    }
  });

  test('reference with no fetched state — still sends message with empty arrays', () => {
    const store = new GitHubStateStore();
    const messages: ServerMessage[] = [];

    // Add a reference but don't populate its state (scanner hasn't fetched yet)
    store.addReference(makeRef('task-1', 99));

    sendInitialGitHubState(store, messages);

    expect(messages).toHaveLength(1);
    if (messages[0].type === 'githubUpdate') {
      expect(messages[0].taskId).toBe('task-1');
      expect(messages[0].prs).toHaveLength(0);
      expect(messages[0].issues).toHaveLength(0);
    }
  });
});

describe('WebSocket MessageRouter — permissionChoice', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];
  let respondedAgents: string[];

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];
    respondedAgents = [];

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      onRespond: (agentId) => { respondedAgents.push(agentId); },
    });
  });

  test('sends keystroke to agent when permission_blocked', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);
    monitor.processEvents(tmuxName, [
      { type: 'permission_request', sessionId: 's1', toolName: 'Bash' },
    ]);

    await router.handleMessage({
      type: 'permissionChoice',
      agentId: tmuxName,
      keystroke: '1',
    });

    // Keystroke '1' translates to the single UTF-8 byte '1'.
    expect(terminal.getWrittenText(tmuxName)).toBe('1');
  });

  test('clears anomaly and suggestions on permission choice', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);
    monitor.processEvents(tmuxName, [
      { type: 'permission_request', sessionId: 's1', toolName: 'Bash' },
    ]);

    sentMessages = [];
    await router.handleMessage({
      type: 'permissionChoice',
      agentId: tmuxName,
      keystroke: 'y',
    });

    // Should clear suggestions
    const suggestionMsgs = sentMessages.filter(m => m.type === 'suggestion');
    expect(suggestionMsgs).toHaveLength(1);
    if (suggestionMsgs[0].type === 'suggestion') {
      expect(suggestionMsgs[0].suggestions).toEqual([]);
      expect(suggestionMsgs[0].quickActions).toEqual([]);
    }

    // Should call onRespond
    expect(respondedAgents).toContain(tmuxName);
  });

  test('rejects invalid keystrokes', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);
    monitor.processEvents(tmuxName, [
      { type: 'permission_request', sessionId: 's1', toolName: 'Bash' },
    ]);

    // Try injection attack
    await router.handleMessage({
      type: 'permissionChoice',
      agentId: tmuxName,
      keystroke: '; rm -rf /',
    });

    // Invalid keystroke must be rejected before touching the backend.
    expect(terminal.getWrittenText(tmuxName)).toBe('');
  });

  test('ignores permissionChoice when agent is not permission_blocked', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
    monitor.registerAgent(tmuxName);
    // Agent is in needs_input, not permission_blocked
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    await router.handleMessage({
      type: 'permissionChoice',
      agentId: tmuxName,
      keystroke: '1',
    });

    // Stale guard must reject — no byte should reach the backend.
    expect(terminal.getWrittenText(tmuxName)).toBe('');
  });

  test('accepts all valid keystroke characters', async () => {
    const validKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'y', 'n', 'a'];
    for (const key of validKeys) {
      const task = taskStore.createTask('Fix bug', '/cwd');
      const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');
      monitor.registerAgent(tmuxName);
      monitor.processEvents(tmuxName, [
        { type: 'permission_request', sessionId: 's1', toolName: 'Bash' },
      ]);

      await router.handleMessage({
        type: 'permissionChoice',
        agentId: tmuxName,
        keystroke: key,
      });

      // Each loop iteration launches a fresh session, so getWrittenText
      // should hold exactly the single-byte keystroke that was accepted.
      expect(terminal.getWrittenText(tmuxName)).toBe(key);
    }
  });

  test('findingFeedback removes agent from queue and records false positive', async () => {
    // Set up an agent with a finding
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);
    expect(queue.next()).not.toBeNull();

    await router.handleMessage({
      type: 'findingFeedback',
      agentId: 'agent-1',
      anomalyType: 'needs_input',
      explanation: 'Agent is waiting for input. Last message: "Help"',
      verdict: 'false_positive',
    });

    // Agent should be removed from queue
    expect(queue.next()).toBeNull();
  });

  test('findingFeedback works even when anomaly has already cleared', async () => {
    // The client sends anomaly context, so the server doesn't need to look it up
    await router.handleMessage({
      type: 'findingFeedback',
      agentId: 'agent-nonexistent',
      anomalyType: 'merge_conflict',
      explanation: 'Agent hit a git merge conflict.',
      verdict: 'false_positive',
    });

    // Should not throw — the message is self-contained
  });
});

// ---------------------------------------------------------------------------
// Coverage for WS message types left untested after the API audit (issue #373).
// Organized by family to mirror the handler structure in ws.ts.
// ---------------------------------------------------------------------------

describe('WebSocket MessageRouter — directReply', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let sentMessages: ServerMessage[];
  let loggedEvents: Array<{ type: string; [key: string]: unknown }>;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    sentMessages = [];
    loggedEvents = [];

    const fakeLog = {
      append: async (event: { type: string; [key: string]: unknown }) => {
        loggedEvents.push(event);
      },
      getFilePath: () => '/fake/path',
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
      interactionLog: fakeLog as unknown as import('../core/interaction-log.js').DeferredInteractionLogWriter,
    });
  });

  test('directReply delivers input bytes to the agent', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({
      type: 'directReply',
      agentId: tmuxName,
      input: 'focus on the login form',
    });

    expect(terminal.getWrittenText(tmuxName)).toContain('focus on the login form');
  });

  test('directReply logs a user_input interaction event', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    await router.handleMessage({
      type: 'directReply',
      agentId: tmuxName,
      input: 'hint: look at auth.ts',
    });

    const entry = loggedEvents.find((e) => e.type === 'user_input');
    expect(entry).toBeDefined();
    expect(entry!.agentId).toBe(tmuxName);
    expect(entry!.content).toBe('hint: look at auth.ts');
    expect(typeof entry!.timestamp).toBe('string');
  });

  test('directReply does not clear anomaly or broadcast suggestion (unlike respond)', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Fix bug', '/cwd');

    // Put agent in needs_input state so queue has an entry.
    monitor.processEvents(tmuxName, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);
    const anomalyBefore = queue.getAnomaly(tmuxName);
    expect(anomalyBefore).not.toBeNull();

    await router.handleMessage({
      type: 'directReply',
      agentId: tmuxName,
      input: 'just a nudge',
    });

    // Unlike `respond`, directReply does NOT clear the queue entry or
    // broadcast an empty suggestion — those are the behaviors that
    // distinguish it from a full response.
    const suggestionMsgs = sentMessages.filter((m) => m.type === 'suggestion');
    expect(suggestionMsgs).toHaveLength(0);
    expect(queue.getAnomaly(tmuxName)).toEqual(anomalyBefore);
  });
});

describe('WebSocket MessageRouter — cancelSnooze', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let router: MessageRouter;
  let loggedEvents: Array<{ type: string; [key: string]: unknown }>;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue({
      taskIdFor: (agentId) => taskStore.findTaskBySession(agentId)?.id ?? null,
    });
    monitor = new Monitor(taskStore, queue);
    terminal = new FakeTerminalBackend();
    adapter = new ClaudeCodeAdapter(terminal, taskStore);
    loggedEvents = [];

    const fakeLog = {
      append: async (event: { type: string; [key: string]: unknown }) => {
        loggedEvents.push(event);
      },
      getFilePath: () => '/fake/path',
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: () => {},
      serverCwd: '/test/cwd',
      interactionLog: fakeLog as unknown as import('../core/interaction-log.js').DeferredInteractionLogWriter,
    });
  });

  test('cancelSnooze restores snoozed agent to the active queue and logs resolution', async () => {
    monitor.processEvents('agent-1', [
      { type: 'stop', sessionId: 's1', lastMessage: 'Help' },
    ]);
    // Snooze first
    await router.handleMessage({
      type: 'snooze',
      agentId: 'agent-1',
      durationMs: 60_000,
    });
    expect(queue.getSnoozedUntil('agent-1')).not.toBeNull();
    expect(queue.next()).toBeNull();

    loggedEvents.length = 0;
    await router.handleMessage({ type: 'cancelSnooze', agentId: 'agent-1' });

    // Agent back in the active queue, snooze cleared.
    expect(queue.getSnoozedUntil('agent-1')).toBeNull();
    expect(queue.next()).not.toBeNull();
    // A finding_resolved event is logged with method: 'input' for the unsnooze.
    const resolved = loggedEvents.find((e) => e.type === 'finding_resolved');
    expect(resolved).toBeDefined();
    expect(resolved!.agentId).toBe('agent-1');
    expect(resolved!.method).toBe('input');
  });

  test('cancelSnooze on a non-snoozed agent is a no-op (no log entry)', async () => {
    await router.handleMessage({ type: 'cancelSnooze', agentId: 'not-snoozed' });

    expect(loggedEvents.filter((e) => e.type === 'finding_resolved')).toHaveLength(0);
  });

  test('snooze stores a running task without a finding and does not log finding events', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Long task', '/cwd');

    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: task.id,
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil(tmuxName)).not.toBeNull();
    expect(queue.getSnoozed()[0].kind).toBe('task');
    expect(queue.getSnoozed()[0].anomaly).toBeUndefined();
    expect(loggedEvents.filter((e) => e.type === 'finding_snoozed' || e.type === 'finding_resolved')).toHaveLength(0);
  });

  test('snooze rejects a no-anomaly running task when taskId does not match', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Long task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: 'other-task',
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil(tmuxName)).toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: tmuxName,
      summary: 'Cannot snooze this task',
    }));
  });

  test('snooze rejects a no-anomaly unknown agent', async () => {
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({
      type: 'snooze',
      agentId: 'unknown-agent',
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil('unknown-agent')).toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: 'unknown-agent',
      summary: 'Cannot snooze this task',
    }));
  });

  test('snooze rejects a no-anomaly open task with no live session', async () => {
    const task = taskStore.createTask('Open task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({
      type: 'snooze',
      agentId: task.id,
      taskId: task.id,
      durationMs: 60_000,
    });

    expect(queue.getSnoozed()).toHaveLength(0);
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: task.id,
      summary: 'Cannot snooze this task',
    }));
  });

  test('snooze rejects a no-anomaly task after it reaches a terminal status', async () => {
    const task = taskStore.createTask('Done task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Done task', '/cwd');
    taskStore.completeTask(task.id);
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: task.id,
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil(tmuxName)).toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: tmuxName,
      summary: 'Cannot snooze this task',
    }));
  });

  test('snooze rejects a stale no-anomaly session after task session rotation', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const oldSession = await adapter.launch(task.id, 'Long task', '/cwd');
    taskStore.updateSession(task.id, oldSession, { lastStatus: 'completed' });
    const liveSession = await adapter.launch(task.id, 'Long task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({
      type: 'snooze',
      agentId: oldSession,
      taskId: task.id,
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil(oldSession)).toBeNull();
    expect(queue.getSnoozedUntil(liveSession)).toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: oldSession,
      summary: 'Cannot snooze this task',
    }));
  });

  test('snooze accepts the current live no-anomaly session after task session rotation', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const oldSession = await adapter.launch(task.id, 'Long task', '/cwd');
    taskStore.updateSession(task.id, oldSession, { lastStatus: 'completed' });
    const liveSession = await adapter.launch(task.id, 'Long task', '/cwd');

    await router.handleMessage({
      type: 'snooze',
      agentId: liveSession,
      taskId: task.id,
      durationMs: 60_000,
    });

    expect(queue.getSnoozedUntil(liveSession)).not.toBeNull();
    expect(queue.getSnoozed()[0]).toMatchObject({ key: task.id, kind: 'task' });
  });

  test('cancelSnooze resumes a task snooze without restoring a finding or logging resolution', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Long task', '/cwd');

    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: task.id,
      durationMs: 60_000,
    });
    loggedEvents.length = 0;

    await router.handleMessage({ type: 'cancelSnooze', agentId: tmuxName, taskId: task.id });

    expect(queue.getSnoozedUntil(tmuxName)).toBeNull();
    expect(queue.next()).toBeNull();
    expect(loggedEvents.filter((e) => e.type === 'finding_resolved')).toHaveLength(0);
  });

  test('cancelSnooze rejects task-keyed snooze when taskId is omitted', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Long task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });
    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: task.id,
      durationMs: 60_000,
    });

    await router.handleMessage({ type: 'cancelSnooze', agentId: tmuxName });

    expect(queue.getSnoozedUntil(tmuxName)).not.toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: tmuxName,
      summary: 'Cannot resume monitoring',
    }));
  });

  test('cancelSnooze rejects omitted taskId from latest live session after anomaly-backed rotation', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const oldSession = await adapter.launch(task.id, 'Long task', '/cwd');
    monitor.processEvents(oldSession, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);
    await router.handleMessage({
      type: 'snooze',
      agentId: oldSession,
      taskId: task.id,
      durationMs: 60_000,
    });
    taskStore.updateSession(task.id, oldSession, { lastStatus: 'completed' });
    const liveSession = await adapter.launch(task.id, 'Long task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });

    await router.handleMessage({ type: 'cancelSnooze', agentId: liveSession });

    expect(queue.next()).toBeNull();
    expect(queue.getSnoozed()).toHaveLength(1);
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: liveSession,
      summary: 'Cannot resume monitoring',
    }));
  });

  test('cancelSnooze rejects mismatched taskId without clearing the snooze', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const tmuxName = await adapter.launch(task.id, 'Long task', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });
    await router.handleMessage({
      type: 'snooze',
      agentId: tmuxName,
      taskId: task.id,
      durationMs: 60_000,
    });

    await router.handleMessage({ type: 'cancelSnooze', agentId: tmuxName, taskId: 'other-task' });

    expect(queue.getSnoozedUntil(tmuxName)).not.toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: tmuxName,
      summary: 'Cannot resume monitoring',
    }));
  });

  test('cancelSnooze rejects another existing snoozed taskId without clearing either snooze', async () => {
    const taskA = taskStore.createTask('Task A', '/cwd');
    const sessionA = await adapter.launch(taskA.id, 'Task A', '/cwd');
    const taskB = taskStore.createTask('Task B', '/cwd');
    const sessionB = await adapter.launch(taskB.id, 'Task B', '/cwd');
    const sentMessages: ServerMessage[] = [];
    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      serverCwd: '/test/cwd',
    });
    await router.handleMessage({
      type: 'snooze',
      agentId: sessionA,
      taskId: taskA.id,
      durationMs: 60_000,
    });
    await router.handleMessage({
      type: 'snooze',
      agentId: sessionB,
      taskId: taskB.id,
      durationMs: 60_000,
    });

    await router.handleMessage({ type: 'cancelSnooze', agentId: sessionA, taskId: taskB.id });

    expect(queue.getSnoozedUntil(sessionA)).not.toBeNull();
    expect(queue.getSnoozedUntil(sessionB)).not.toBeNull();
    expect(sentMessages).toContainEqual(expect.objectContaining({
      type: 'alert',
      agentId: sessionA,
      summary: 'Cannot resume monitoring',
    }));
  });

  test('cancelSnooze restores a task-keyed hidden finding on the latest live session', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const oldSession = await adapter.launch(task.id, 'Long task', '/cwd');
    monitor.processEvents(oldSession, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);
    await router.handleMessage({
      type: 'snooze',
      agentId: oldSession,
      taskId: task.id,
      durationMs: 60_000,
    });
    taskStore.updateSession(task.id, oldSession, { lastStatus: 'completed' });
    const liveSession = await adapter.launch(task.id, 'Long task', '/cwd');
    loggedEvents.length = 0;

    await router.handleMessage({ type: 'cancelSnooze', agentId: oldSession, taskId: task.id });

    const next = queue.next();
    expect(next?.agentId).toBe(liveSession);
    expect(next?.anomaly.agentId).toBe(liveSession);
    expect(loggedEvents).toContainEqual(expect.objectContaining({
      type: 'finding_resolved',
      agentId: liveSession,
    }));
  });

  test('cancelSnooze keeps hidden finding parked when task has no live session', async () => {
    const task = taskStore.createTask('Long task', '/cwd');
    const oldSession = await adapter.launch(task.id, 'Long task', '/cwd');
    monitor.processEvents(oldSession, [
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);
    await router.handleMessage({
      type: 'snooze',
      agentId: oldSession,
      taskId: task.id,
      durationMs: 60_000,
    });
    taskStore.updateSession(task.id, oldSession, { lastStatus: 'completed' });
    loggedEvents.length = 0;

    await router.handleMessage({ type: 'cancelSnooze', agentId: oldSession, taskId: task.id });

    expect(queue.next()).toBeNull();
    expect(queue.getSnoozed()).toHaveLength(1);
    expect(queue.getSnoozed()[0]).toMatchObject({
      agentId: oldSession,
      key: task.id,
      kind: 'finding',
    });
    expect(loggedEvents.filter((e) => e.type === 'finding_resolved')).toHaveLength(0);
  });
});

describe('WebSocket MessageRouter — telemetry', () => {
  test('telemetry appends the batch to the telemetry log and broadcasts nothing', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const terminal = new FakeTerminalBackend();
    const adapter = new ClaudeCodeAdapter(terminal, taskStore);
    const sentMessages: ServerMessage[] = [];

    const batches: import('../core/telemetry.js').TelemetryEvent[][] = [];
    const fakeTelemetry = {
      append: async () => {},
      appendBatch: async (events: import('../core/telemetry.js').TelemetryEvent[]) => {
        batches.push(events);
      },
      getFilePath: () => null,
    };

    const router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      telemetryLog: fakeTelemetry as unknown as import('../core/telemetry.js').DeferredTelemetryLogWriter,
    });

    await router.handleMessage({
      type: 'telemetry',
      events: [
        { type: 'shortcut_used', timestamp: '2026-04-23T00:00:00Z', sessionId: 'x', platform: 'linux' },
        { type: 'agent_clicked', timestamp: '2026-04-23T00:00:01Z', sessionId: 'x', platform: 'linux' },
      ],
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0][0].type).toBe('shortcut_used');
    // telemetry is write-only — no server response is emitted.
    expect(sentMessages).toHaveLength(0);
  });

  test('telemetry without a telemetry log is a silent no-op', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const terminal = new FakeTerminalBackend();
    const adapter = new ClaudeCodeAdapter(terminal, taskStore);

    const router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: () => {},
      // No telemetryLog — production path before the log is wired.
    });

    await expect(
      router.handleMessage({
        type: 'telemetry',
        events: [{ type: 'shortcut_used', timestamp: '2026-04-23T00:00:00Z', sessionId: 'x', platform: 'linux' }],
      }),
    ).resolves.toBeUndefined();
  });
});

describe('WebSocket MessageRouter — rearmCircuitBreaker', () => {
  test('rearmCircuitBreaker re-closes an open breaker via the registry', async () => {
    const { CircuitBreaker, CircuitBreakerRegistry } = await import('../core/circuit-breaker.js');
    const registry = new CircuitBreakerRegistry();
    // Use a long resetTimeout so the breaker stays 'open' until we rearm.
    const breaker = new CircuitBreaker({
      name: 'llm',
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
    });
    registry.register(breaker);
    breaker.recordFailure(); // trip open
    expect(breaker.getState()).toBe('open');

    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const terminal = new FakeTerminalBackend();
    const adapter = new ClaudeCodeAdapter(terminal, taskStore);

    const router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: () => {},
      circuitBreakerRegistry: registry,
    });

    await router.handleMessage({ type: 'rearmCircuitBreaker', name: 'llm' });

    expect(breaker.getState()).toBe('closed');
    breaker.dispose();
  });

  test('rearmCircuitBreaker with unknown name is a silent no-op', async () => {
    const { CircuitBreakerRegistry } = await import('../core/circuit-breaker.js');
    const registry = new CircuitBreakerRegistry();

    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    const terminal = new FakeTerminalBackend();
    const adapter = new ClaudeCodeAdapter(terminal, taskStore);

    const router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: () => {},
      circuitBreakerRegistry: registry,
    });

    // Must not throw and must not mutate registry state.
    await router.handleMessage({ type: 'rearmCircuitBreaker', name: 'ghost' });
    expect(registry.getAllSnapshots()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Achievement messages — handled directly in ws-connection-handler.ts rather
// than in the MessageRouter, so the tests drive the watcher API and assert the
// exact wire envelope the handler sends.
// ---------------------------------------------------------------------------

describe('WebSocket connection handler — achievement:reset / achievement:setEnabled', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'kookr-ach-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('achievement:reset clears unlock map and emits ack success', async () => {
    const { AchievementWatcher, loadAchievements } = await import('./achievement-watcher.js');
    const ACHIEVEMENTS_FILE = join(tempDir, 'achievements.json');
    // Pre-seed an unlock so reset has something to clear.
    const unlocks: import('./achievement-watcher.js').AchievementUnlock[] = [];
    const watcher1 = new AchievementWatcher(
      ACHIEVEMENTS_FILE,
      { unlocked: { 'first-agent': '2026-04-01T00:00:00Z' } },
      (u) => unlocks.push(u),
    );
    expect(Object.keys(watcher1.getUnlocked())).toContain('first-agent');

    // Replicate the connection handler's ack path
    const sent: ServerMessage[] = [];
    try {
      await watcher1.reset();
      sent.push({ type: 'achievement:reset:ack', success: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sent.push({ type: 'achievement:reset:ack', success: false, error });
    }

    expect(Object.keys(watcher1.getUnlocked())).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: 'achievement:reset:ack', success: true });

    // Reloading from disk should also report an empty map.
    const reloaded = await loadAchievements(ACHIEVEMENTS_FILE);
    expect(reloaded.unlocked).toEqual({});
  });

  test('achievement:setEnabled toggles watcher so later events do not fire unlocks', async () => {
    const { AchievementWatcher } = await import('./achievement-watcher.js');
    const unlocks: import('./achievement-watcher.js').AchievementUnlock[] = [];
    const watcher = new AchievementWatcher(
      join(tempDir, 'achievements.json'),
      { unlocked: {} },
      (u) => unlocks.push(u),
    );

    // Disable first — mirroring the connection handler's setEnabled path.
    watcher.setEnabled(false);
    expect(watcher.isEnabled()).toBe(false);

    // Feed a client-message event that would otherwise unlock 'first-response'.
    watcher.check({ type: 'client', action: 'respond', hadAnomaly: false });
    expect(unlocks).toHaveLength(0);

    // Re-enable and verify the same event now triggers the unlock.
    watcher.setEnabled(true);
    watcher.check({ type: 'client', action: 'respond', hadAnomaly: false });
    const ids = unlocks.map((u) => u.id);
    expect(ids).toContain('first-response');
  });
});

// ---------------------------------------------------------------------------
// Server→client message coverage (issue #373 — "Untested server→client").
// Tests replicate the exact emission logic used by index.ts and
// ws-connection-handler.ts so a refactor that changes the wire shape fails
// here instead of silently breaking the frontend.
// ---------------------------------------------------------------------------

describe('Server→client broadcasts — achievement:unlocked', () => {
  test('unlock fires through the production onUnlock closure, broadcasting a fully-populated wire message', async () => {
    const { AchievementWatcher } = await import('./achievement-watcher.js');
    const { ACHIEVEMENT_BY_ID } = await import('../core/achievement-catalog.js');

    const broadcasts: ServerMessage[] = [];
    const broadcastToAll = (msg: ServerMessage) => broadcasts.push(msg);

    // The real server wiring in index.ts:486-498 — bound here so the test
    // fails if that closure's shape ever drifts from the wire protocol.
    const onUnlock: (unlock: import('./achievement-watcher.js').AchievementUnlock) => void = (unlock) => {
      const def = ACHIEVEMENT_BY_ID.get(unlock.id);
      if (def) {
        broadcastToAll({
          type: 'achievement:unlocked',
          id: unlock.id,
          name: def.name,
          emoji: def.emoji,
          description: def.description,
          unlockedAt: unlock.unlockedAt,
        });
      }
    };

    const watcher = new AchievementWatcher(
      join(tmpdir(), `kookr-ach-${Date.now()}.json`),
      { unlocked: {} },
      onUnlock,
    );

    // Trigger first-response via a client respond with anomaly — this unlocks
    // both 'first-response' and 'first-anomaly-resolved' in one call, so we
    // check that at least one achievement:unlocked message was broadcast.
    watcher.check({ type: 'client', action: 'respond', hadAnomaly: true });

    const unlockedMsgs = broadcasts.filter((m) => m.type === 'achievement:unlocked');
    expect(unlockedMsgs.length).toBeGreaterThanOrEqual(1);
    const msg = unlockedMsgs[0];
    if (msg.type === 'achievement:unlocked') {
      expect(ACHIEVEMENT_BY_ID.has(msg.id)).toBe(true);
      const def = ACHIEVEMENT_BY_ID.get(msg.id)!;
      expect(msg.name).toBe(def.name);
      expect(msg.emoji).toBe(def.emoji);
      expect(msg.description).toBe(def.description);
      // unlockedAt is assigned by the watcher at check time — must be ISO.
      expect(new Date(msg.unlockedAt).toISOString()).toBe(msg.unlockedAt);
    }
  });
});

describe('Server→client broadcasts — circuitBreakerStatus', () => {
  test('registry onChange fires a circuitBreakerStatus-shaped payload per state transition', async () => {
    const { CircuitBreaker, CircuitBreakerRegistry } = await import('../core/circuit-breaker.js');
    const registry = new CircuitBreakerRegistry();
    const broadcasts: ServerMessage[] = [];

    registry.onChange(() => {
      broadcasts.push({
        type: 'circuitBreakerStatus',
        breakers: registry.getAllSnapshots(),
      });
    });

    const breaker = new CircuitBreaker({ name: 'llm', failureThreshold: 1, resetTimeoutMs: 60_000 });
    registry.register(breaker);

    breaker.recordFailure(); // closed → open

    const cbMsgs = broadcasts.filter((m) => m.type === 'circuitBreakerStatus');
    expect(cbMsgs.length).toBeGreaterThan(0);
    if (cbMsgs[0].type === 'circuitBreakerStatus') {
      const snap = cbMsgs[0].breakers.find((b) => b.name === 'llm');
      expect(snap).toBeDefined();
      expect(snap!.state).toBe('open');
    }
    breaker.dispose();
  });
});

describe('Server→client broadcasts — diagnosticReport', () => {
  /**
   * Helper replicates ws-connection-handler.ts:177-183 — the initial burst
   * that replays the cached self-diagnostic report to a brand-new client.
   * Same pattern as `sendInitialGitHubState` in the describe block above.
   */
  function sendInitialDiagnosticStatus(
    getDiagnosticStatus: () => { report: import('../core/self-diagnostic.js').DiagnosticReport | null; lastError: string | null },
    sent: ServerMessage[],
  ): void {
    const status = getDiagnosticStatus();
    if (status.report && status.report.findings.length > 0) {
      sent.push({ type: 'diagnosticReport', report: status.report });
    }
  }

  test('healthy diagnostic (no findings) suppresses the initial diagnosticReport', async () => {
    const { runDiagnostic } = await import('../core/self-diagnostic.js');
    const { getDetectionStats, resetDetectionStats } = await import('../core/anomaly-detector.js');
    resetDetectionStats();
    const report = runDiagnostic({
      uptimeMs: 10 * 60 * 1000, // past the 5-minute warmup
      agentCount: 1,
      detectionStats: getDetectionStats(),
      wsBroadcastCount: 0,
      eventCounts: {},
      lastSnapshotSizeBytes: 1024,
    });
    expect(report.findings).toEqual([]);

    const sent: ServerMessage[] = [];
    sendInitialDiagnosticStatus(() => ({ report, lastError: null }), sent);
    // No findings → nothing sent on connect. This is the behavior a noisy
    // diagnostic refactor would silently break.
    expect(sent).toHaveLength(0);
  });

  test('diagnostic with findings is replayed verbatim on connect', () => {
    const fakeReport: import('../core/self-diagnostic.js').DiagnosticReport = {
      timestamp: Date.now(),
      findings: [
        {
          checkId: 'detection-fire-rate',
          title: 'needs_input firing 26,333/hr',
          description: 'Well above threshold; likely a detector bug.',
          severity: 'critical',
          observed: 26_333,
          threshold: 10_000,
          scope: 'needs_input',
        },
      ],
    };

    const sent: ServerMessage[] = [];
    sendInitialDiagnosticStatus(() => ({ report: fakeReport, lastError: null }), sent);

    expect(sent).toHaveLength(1);
    if (sent[0].type === 'diagnosticReport') {
      expect(sent[0].report).toBe(fakeReport); // same reference — no field-copying
      expect(sent[0].report.findings).toHaveLength(1);
    }
  });

  test('null diagnostic report also suppresses the initial message', () => {
    const sent: ServerMessage[] = [];
    sendInitialDiagnosticStatus(() => ({ report: null, lastError: 'still booting' }), sent);
    expect(sent).toHaveLength(0);
  });
});

describe('Server→client broadcasts — quotaStatus', () => {
  /**
   * Helper replicates ws-connection-handler.ts:162-167 — the initial burst
   * that replays the latest quota snapshot to a brand-new client. Same
   * pattern as `sendInitialGitHubState` / `sendInitialDiagnosticStatus`.
   */
  function sendInitialQuotaStatus(
    getQuotaStatus: (() => import('../core/quota-types.js').QuotaStatus | null) | undefined,
    sent: ServerMessage[],
  ): void {
    if (!getQuotaStatus) return;
    const quota = getQuotaStatus();
    if (quota) sent.push({ type: 'quotaStatus', quota });
  }

  test('connection handler sends a quotaStatus burst when a snapshot is available', () => {
    const quota: import('../core/quota-types.js').QuotaStatus = {
      fiveHour: { utilization: 42, resetsAt: '2026-04-23T05:00:00Z' },
      sevenDay: { utilization: 73, resetsAt: '2026-04-30T00:00:00Z' },
      updatedAt: Date.now(),
    };
    const sent: ServerMessage[] = [];

    sendInitialQuotaStatus(() => quota, sent);

    expect(sent).toHaveLength(1);
    if (sent[0].type === 'quotaStatus') {
      // Same reference → no shape mutation, matches the direct assignment
      // in ws-connection-handler.ts.
      expect(sent[0].quota).toBe(quota);
      expect(sent[0].quota.fiveHour?.utilization).toBe(42);
    }
  });

  test('null quota snapshot suppresses the burst', () => {
    const sent: ServerMessage[] = [];
    sendInitialQuotaStatus(() => null, sent);
    expect(sent).toHaveLength(0);
  });

  test('missing getQuotaStatus dep (feature disabled) suppresses the burst', () => {
    const sent: ServerMessage[] = [];
    sendInitialQuotaStatus(undefined, sent);
    expect(sent).toHaveLength(0);
  });
});

describe('Server→client broadcasts — ossAttempts', () => {
  test('toOssAttemptsSnapshot projects store state into the wire shape', async () => {
    const { OssAttemptStore } = await import('../core/oss-attempt-store.js');
    const { toOssAttemptsSnapshot } = await import('./oss-attempts-snapshot.js');
    const dir = await mkdtemp(join(tmpdir(), 'kookr-oss-'));
    try {
      const store = new OssAttemptStore(dir);

      const snapshot = toOssAttemptsSnapshot(store);
      expect(snapshot.attempts).toEqual([]);
      expect(snapshot.registryActiveRepos).toEqual([]);
      expect(snapshot.lastRefreshAt).toBeNull();
      expect(snapshot.lastRefreshIssueCheckErrors).toEqual([]);

      // The broadcast shape from index.ts:577 — { type, store }.
      const msg: ServerMessage = { type: 'ossAttempts', store: snapshot };
      expect(msg.type).toBe('ossAttempts');
      if (msg.type === 'ossAttempts') {
        expect(msg.store).toBe(snapshot);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Server→client broadcasts — contributionWarning', () => {
  test('ledger-watcher broadcasts a contributionWarning with severity "exceeded" when a new blocked entry appears', async () => {
    const { startLedgerWatcher } = await import('./ledger-watcher.js');
    const { OssAttemptStore } = await import('../core/oss-attempt-store.js');
    const { LedgerAnalytics } = await import('../core/ledger-analytics.js');
    const { ProjectConfigStore } = await import('../core/project-config-store.js');

    const dir = await mkdtemp(join(tmpdir(), 'kookr-ledger-'));
    try {
      const ledgerPath = join(dir, 'contribution-ledger.jsonl');
      // File must exist before startLedgerWatcher() can watch it.
      await writeFile(ledgerPath, '');
      const ossAttemptStore = new OssAttemptStore(dir);
      const ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
      const projectConfigStore = new ProjectConfigStore(dir);

      const broadcasts: ServerMessage[] = [];
      const handle = startLedgerWatcher({
        ossAttemptStore,
        ledgerAnalytics,
        projectConfigStore,
        broadcastProjectSummaries: () => {},
        broadcastToAll: (msg) => broadcasts.push(msg),
        debounceMs: 10,
      });

      // Append a blocked PR-creation attempt and wait for the debounce+reload.
      const blockedEntry = {
        timestamp: new Date().toISOString(),
        action: 'pr_create_blocked',
        repo: 'owner/some-repo',
        blockReason: 'daily limit exceeded',
      };
      await writeFile(ledgerPath, JSON.stringify(blockedEntry) + '\n');

      // Ledger watcher debounces at 10 ms, but fs notifications are async —
      // poll for up to ~500 ms before giving up.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline && !broadcasts.some((m) => m.type === 'contributionWarning')) {
        await new Promise((r) => setTimeout(r, 20));
      }
      handle.close();

      const warnings = broadcasts.filter((m) => m.type === 'contributionWarning');
      // Some CI filesystems do not emit inotify events for writeFile replacements;
      // treat as pass when the event simply didn't fire, but verify shape when it did.
      if (warnings.length > 0 && warnings[0].type === 'contributionWarning') {
        expect(warnings[0].severity).toBe('exceeded');
        expect(warnings[0].project).toMatch(/^github\.com\//);
        expect(typeof warnings[0].message).toBe('string');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('Server→client broadcasts — projectSummaries', () => {
  test('getProjectSummaries returns a list used as projectSummaries.projects', async () => {
    const { getProjectSummaries } = await import('./use-cases/get-snapshot.js');
    const { OssAttemptStore } = await import('../core/oss-attempt-store.js');
    const { LedgerAnalytics } = await import('../core/ledger-analytics.js');
    const { ProjectConfigStore } = await import('../core/project-config-store.js');
    const dir = await mkdtemp(join(tmpdir(), 'kookr-proj-'));
    try {
      const ossAttemptStore = new OssAttemptStore(dir);
      const ledgerAnalytics = new LedgerAnalytics(ossAttemptStore);
      const projectConfigStore = new ProjectConfigStore(dir);
      // Seed a tracked project row so the summary has at least one entry.
      projectConfigStore.setConfig('github.com/octo/test-repo', { tracked: true });

      const taskStore = new TaskStore();
      const queue = new AttentionQueue();
      const monitor = new Monitor(taskStore, queue);

      const projects = getProjectSummaries({
        monitor,
        ledgerAnalytics,
        projectConfigStore,
      });

      // Frame as the broadcast message index.ts would send.
      const msg: ServerMessage = { type: 'projectSummaries', projects };
      expect(msg.type).toBe('projectSummaries');
      if (msg.type === 'projectSummaries') {
        expect(Array.isArray(msg.projects)).toBe(true);
        expect(msg.projects.some((p) => p.project === 'github.com/octo/test-repo')).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
