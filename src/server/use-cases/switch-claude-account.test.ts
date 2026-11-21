import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { emptyClaudeAccountRegistry, withAccount, type ClaudeAccountRegistry } from '../../core/claude-accounts.js';
import { switchClaudeAccount, type SwitchClaudeAccountDeps } from './switch-claude-account.js';

const TOKEN_WORK = 'sk-ant-oat01-' + 'w'.repeat(40);

function registryWithWork(): ClaudeAccountRegistry {
  return withAccount(emptyClaudeAccountRegistry(), 'work', TOKEN_WORK);
}

function makeDeps(taskStore: TaskStore, overrides: Partial<SwitchClaudeAccountDeps> = {}) {
  const monitor = new Monitor(taskStore, new AttentionQueue());
  // Records, for every stopped session, whether a promoter could have launched
  // the replacement at that moment (it must not: the old agent is still alive).
  const stoppedWhileFenced: Array<{ session: string; status: string | undefined; fenced: boolean }> = [];
  let taskIdForFence = '';
  const stop = vi.fn(async (session: string) => {
    stoppedWhileFenced.push({
      session,
      status: taskStore.getTask(taskIdForFence)?.status,
      fenced: taskStore.hasFreshLaunchReservation(taskIdForFence),
    });
  });
  const deps: SwitchClaudeAccountDeps = {
    taskStore,
    loadClaudeAccounts: registryWithWork,
    getLifecycleDeps: () => ({
      adapter: { stop },
      monitor,
      taskStore,
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
    } as never),
    tryPromotePending: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    deps,
    stop,
    stoppedWhileFenced,
    setTaskId: (id: string) => {
      taskIdForFence = id;
    },
  };
}

function runningTask(taskStore: TaskStore, opts: { conversation?: boolean } = {}) {
  const task = taskStore.createTask('Fix the flaky test', '/repo');
  taskStore.addSession(task.id, {
    tmuxSession: 'kookr-old',
    agentType: 'claude-code',
    cwd: '/repo-wt',
    createdAt: new Date(),
  }); // open -> inProgress
  if (opts.conversation !== false) {
    taskStore.updateSession(task.id, 'kookr-old', { claudeSessionId: 'conv-1' });
  }
  return task.id;
}

describe('switchClaudeAccount', () => {
  test('moves a running task in place: stops the old agent, keeps the task, queues a resume', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    const { deps, stop, stoppedWhileFenced, setTaskId } = makeDeps(taskStore);
    setTaskId(taskId);

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result).toMatchObject({ outcome: 'queued', from: 'host', to: 'work' });
    expect(stop).toHaveBeenCalledWith('kookr-old');
    // The old agent was stopped while the task was already pending (so
    // reconcile cannot terminate it) and fenced (so no promoter could start the
    // new agent next to the old one).
    expect(stoppedWhileFenced).toEqual([{ session: 'kookr-old', status: 'pending', fenced: true }]);
    const after = taskStore.getTask(taskId)!;
    expect(after.status).toBe('pending');
    expect(after.metadata?.claudeAccount).toBe('work');
    expect(after.sessions[0]?.lastStatus).toBe('aborted');
    expect(taskStore.wantsResumeOnNextLaunch(taskId)).toBe(true);
    // The fence is released so promotion can launch it.
    expect(taskStore.hasFreshLaunchReservation(taskId)).toBe(false);
    expect(deps.tryPromotePending).toHaveBeenCalledTimes(1);
  });

  test('reports relaunched when promotion started the new agent', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    const { deps } = makeDeps(taskStore, {
      tryPromotePending: async () => {
        taskStore.addSession(taskId, {
          tmuxSession: 'kookr-new',
          agentType: 'claude-code',
          cwd: '/repo',
          createdAt: new Date(),
        }); // pending -> inProgress, as the real promotion does
      },
    });

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result.outcome).toBe('relaunched');
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('a task that is not running only gets the new pin', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    taskStore.terminateTask(taskId);
    const { deps, stop } = makeDeps(taskStore);

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result).toMatchObject({ outcome: 'pinned', from: 'host', to: 'work' });
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)?.status).toBe('terminated');
    expect(taskStore.getTask(taskId)?.metadata?.claudeAccount).toBe('work');
  });

  test('switching to the account a task is already pinned to changes nothing', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    taskStore.setClaudeAccount(taskId, 'work');
    const { deps, stop } = makeDeps(taskStore);

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result.outcome).toBe('unchanged');
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('refuses an unknown account without touching the task', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    const { deps, stop } = makeDeps(taskStore);

    const result = await switchClaudeAccount(deps, taskId, 'nope');

    expect(result).toMatchObject({ outcome: 'invalid', code: 'invalid_claude_account' });
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
    expect(taskStore.getTask(taskId)?.metadata?.claudeAccount).toBeUndefined();
  });

  test('refuses a running task with no conversation to continue', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore, { conversation: false });
    const { deps, stop } = makeDeps(taskStore);

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result).toMatchObject({ outcome: 'invalid', code: 'not_resumable' });
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('refuses an active Ralph loop', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    taskStore.getTaskForMutation(taskId)!.ralphLoop = { status: 'running', iteration: 2 } as never;
    const { deps } = makeDeps(taskStore);

    expect(await switchClaudeAccount(deps, taskId, 'work')).toMatchObject({ outcome: 'invalid', code: 'ralph_loop_active' });
  });

  test('refuses a task that does not run Claude Code', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Fix it', cwd: '/repo', agentType: 'codex-cli' });
    const { deps } = makeDeps(taskStore);

    expect(task.agentType).toBe('codex-cli');
    expect(await switchClaudeAccount(deps, task.id, 'work')).toMatchObject({ outcome: 'invalid', code: 'not_claude_task' });
  });

  test('reports a relaunch that failed instead of a silent success', async () => {
    const taskStore = new TaskStore();
    const taskId = runningTask(taskStore);
    const { deps } = makeDeps(taskStore, {
      tryPromotePending: async () => {
        taskStore.cancelTask(taskId, { source: 'system', reason: 'launch_failure', detail: 'account removed' } as never);
      },
    });

    const result = await switchClaudeAccount(deps, taskId, 'work');

    expect(result).toMatchObject({ outcome: 'invalid', code: 'relaunch_failed' });
  });

  test('returns not_found for an unknown task', async () => {
    const { deps } = makeDeps(new TaskStore());
    expect((await switchClaudeAccount(deps, 'missing', 'work')).outcome).toBe('not_found');
  });
});
