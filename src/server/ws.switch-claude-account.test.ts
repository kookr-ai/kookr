import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { emptyClaudeAccountRegistry, withAccount } from '../core/claude-accounts.js';
import type { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import type { ServerMessage } from '../shared/protocol.js';

// Promotion is the seam where a switched task takes back its slot (issue
// #4235); record what the dashboard path hands it instead of launching agents.
const { promotePendingTasks } = vi.hoisted(() => ({ promotePendingTasks: vi.fn(async () => undefined) }));
vi.mock('./agent-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-lifecycle.js')>()),
  promotePendingTasks,
}));

const { MessageRouter } = await import('./ws.js');

const TOKEN_WORK = 'sk-ant-oat01-' + 'w'.repeat(40);

/**
 * The dashboard moves a task to another Claude account over the socket
 * (`switchClaudeAccount`), because the HTTP route needs the supervisor token
 * and the dashboard has none. These tests go through MessageRouter, as the
 * browser does, so they also cover the wiring the handler cannot see: the
 * account registry and the `firstTaskId` given to promotion.
 */
describe('MessageRouter: switchClaudeAccount', () => {
  let taskStore: TaskStore;
  let sent: ServerMessage[];
  let broadcast: ServerMessage[];
  let dir: string;
  let stop: ReturnType<typeof vi.fn>;
  let router: InstanceType<typeof MessageRouter>;

  function makeRouter(withRegistry = true) {
    const queue = new AttentionQueue();
    const monitor = new Monitor(taskStore, queue);
    return new MessageRouter({
      taskStore, queue, monitor,
      adapter: { stop } as never,
      adapterRegistry: {} as AdapterRegistry,
      agentLifecycleDeps: {} as never,
      send: (msg) => { sent.push(msg); },
      broadcastToAll: (msg) => { broadcast.push(msg); },
      buildSnapshotMessage: () => ({ type: 'quotaStatus', quota: { fiveHour: null, sevenDay: null, updatedAt: 0 } }) as ServerMessage,
      serverCwd: '/repo',
      launchTask: vi.fn(),
      auditLogPath: join(dir, 'audit.jsonl'),
      lifecycleExtras: { hookWatcher: { stop: vi.fn() }, watchdog: { unregisterAgent: vi.fn() } },
      ralphLoopService: {} as RalphLoopService,
      ...(withRegistry ? { loadClaudeAccounts: () => withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_WORK) } : {}),
    });
  }

  function runningTask(): string {
    const task = taskStore.createTask('Fix the flaky test', '/repo');
    taskStore.addSession(task.id, { tmuxSession: 'kookr-old', agentType: 'claude-code', cwd: '/repo', createdAt: new Date() });
    taskStore.updateSession(task.id, 'kookr-old', { claudeSessionId: 'conv-1' });
    return task.id;
  }

  const replies = () => sent.filter((m) => m.type === 'claudeAccountSwitchResult');

  beforeEach(async () => {
    taskStore = new TaskStore();
    sent = [];
    broadcast = [];
    stop = vi.fn(async () => undefined);
    promotePendingTasks.mockClear();
    dir = await mkdtemp(join(tmpdir(), 'ws-switch-account-'));
    router = makeRouter();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('moves a running task to a registered account, promotes it first, replies and audits', async () => {
    const taskId = runningTask();

    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'r1', taskId, account: ' work ' });

    expect(replies()).toEqual([{
      type: 'claudeAccountSwitchResult', requestId: 'r1', taskId, ok: true, outcome: 'queued', from: 'host', to: 'work',
    }]);
    expect(stop).toHaveBeenCalledWith('kookr-old');
    expect(taskStore.getTask(taskId)!.metadata?.claudeAccount).toBe('work');
    // The freed slot goes back to this task, not to an older pending one.
    expect(promotePendingTasks).toHaveBeenCalledWith(expect.objectContaining({ firstTaskId: taskId }));
    // Every dashboard sees the change straight away.
    expect(broadcast.map((m) => m.type)).toContain('quotaStatus');
    const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit).toEqual([expect.objectContaining({
      type: 'task.claudeAccountSwitch', taskId, from: 'host', account: 'work', outcome: 'queued', actor: expect.objectContaining({ source: 'websocket' }),
    })]);
  });

  test('pins a task that is not running', async () => {
    const task = taskStore.createTask('Later', '/repo');
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'r2', taskId: task.id, account: 'work' });
    expect(replies()).toEqual([expect.objectContaining({ requestId: 'r2', ok: true, outcome: 'pinned', to: 'work' })]);
    expect(taskStore.getTask(task.id)!.metadata?.claudeAccount).toBe('work');
  });

  test('replies with the refusal, and changes nothing, for an unknown account, an unknown task and a blank name', async () => {
    const taskId = runningTask();
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'a', taskId, account: 'nope' });
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'b', taskId: 'missing', account: 'work' });
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'c', taskId, account: '   ' });
    expect(replies()).toEqual([
      expect.objectContaining({ requestId: 'a', ok: false, code: 'invalid_claude_account' }),
      expect.objectContaining({ requestId: 'b', ok: false, code: 'not_found', error: 'Task not found' }),
      expect.objectContaining({ requestId: 'c', ok: false, code: 'invalid_claude_account' }),
    ]);
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)!.metadata?.claudeAccount).toBeUndefined();
    expect(broadcast).toEqual([]);
  });

  test('without the registry only host is known, so a named account is refused', async () => {
    router = makeRouter(false);
    const taskId = runningTask();
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'r', taskId, account: 'work' });
    expect(replies()).toEqual([expect.objectContaining({ ok: false, code: 'invalid_claude_account' })]);
  });

  test('a Contact Share task gets a refusal reply, not a silent drop', async () => {
    await router.handleMessage({ type: 'switchClaudeAccount', requestId: 'r', taskId: 'shared:abc:def', account: 'work' });
    expect(replies()).toEqual([expect.objectContaining({ requestId: 'r', ok: false, code: 'shared_task' })]);
  });
});
