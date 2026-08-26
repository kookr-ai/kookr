import { describe, test, expect, beforeEach, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { AgentType } from '../core/agent-types.js';
import { launchTask, type LaunchServiceDeps } from './launch-service.js';

function createMockAdapter(agentType: AgentType, taskStore: TaskStore): AgentAdapter {
  return {
    agentType,
    launch: vi.fn(async (taskId: string, _prompt: string, cwd: string) => {
      const tmuxName = `kookr-${agentType}-${taskId.slice(0, 4)}`;
      taskStore.addSession(taskId, {
        tmuxSession: tmuxName,
        agentType,
        cwd,
        createdAt: new Date(),
      });
      return tmuxName;
    }),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn().mockResolvedValue(''),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
    getEffectiveHookSettings: vi.fn(() => undefined),
  };
}

describe('multi-agent launch', () => {
  let taskStore: TaskStore;
  let claudeAdapter: AgentAdapter;
  let codexAdapter: AgentAdapter;
  let registry: AdapterRegistry;
  let deps: LaunchServiceDeps;

  beforeEach(() => {
    taskStore = new TaskStore();
    claudeAdapter = createMockAdapter('claude-code', taskStore);
    codexAdapter = createMockAdapter('codex-cli', taskStore);
    registry = new AdapterRegistry();
    registry.register(claudeAdapter);
    registry.register(codexAdapter);

    deps = {
      taskStore,
      adapterRegistry: registry,
      flushTasks: vi.fn().mockResolvedValue(undefined),
      lifecycleDeps: {
        monitor: { registerAgent: vi.fn(), getSnapshot: vi.fn().mockReturnValue([]) } as any,
        watchdog: { registerAgent: vi.fn() } as any,
        hookWatcher: { watch: vi.fn(), isWatching: vi.fn().mockReturnValue(false) } as any,
        githubScanner: { scanTask: vi.fn(), isActive: vi.fn().mockReturnValue(false), processTaskPrompt: vi.fn() } as any,
        autoNameTask: vi.fn(),
      },
    };
  });

  test('default launch uses claude-code adapter', async () => {
    const result = await launchTask(deps, { prompt: 'Fix bug', cwd: '/tmp' });

    expect(result.task.agentType).toBe('claude-code');
    expect(claudeAdapter.launch).toHaveBeenCalledOnce();
    expect(codexAdapter.launch).not.toHaveBeenCalled();
  });

  test('agentType=codex-cli uses codex adapter', async () => {
    const result = await launchTask(deps, { prompt: 'Fix bug', cwd: '/tmp', agentType: 'codex-cli' });

    expect(result.task.agentType).toBe('codex-cli');
    expect(codexAdapter.launch).toHaveBeenCalledOnce();
    expect(claudeAdapter.launch).not.toHaveBeenCalled();
  });

  test('agentType=claude-code explicitly uses claude adapter', async () => {
    const result = await launchTask(deps, { prompt: 'Fix bug', cwd: '/tmp', agentType: 'claude-code' });

    expect(result.task.agentType).toBe('claude-code');
    expect(claudeAdapter.launch).toHaveBeenCalledOnce();
  });

  test('task stores agentType from CreateTaskOptions', () => {
    const task = taskStore.createTask({ prompt: 'Fix bug', cwd: '/tmp', agentType: 'codex-cli' });
    expect(task.agentType).toBe('codex-cli');
  });

  test('task defaults to claude-code when agentType not specified', () => {
    const task = taskStore.createTask({ prompt: 'Fix bug', cwd: '/tmp' });
    expect(task.agentType).toBe('claude-code');
  });

});
