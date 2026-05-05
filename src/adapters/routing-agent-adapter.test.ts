import { describe, test, expect, beforeEach, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry, type AgentAdapter } from './agent-adapter.js';
import { RoutingAgentAdapter } from './routing-agent-adapter.js';
import type { AgentType } from '../core/agent-types.js';

function createMockAdapter(agentType: AgentType): AgentAdapter {
  const eventHandlers: Array<(tmuxName: string, event: any) => void> = [];
  const refreshHandlers: Array<() => void> = [];
  return {
    agentType,
    launch: vi.fn().mockResolvedValue('mock-tmux'),
    sendInput: vi.fn().mockResolvedValue(undefined),
    sendKeystroke: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    captureDisplay: vi.fn().mockResolvedValue('display content'),
    onEvent: vi.fn((handler) => { eventHandlers.push(handler); }),
    onRefreshNeeded: vi.fn((handler) => { refreshHandlers.push(handler); }),
    injectHookEvent: vi.fn(),
    getEffectiveHookSettings: vi.fn(() => undefined),
    // Expose for testing
    _emitEvent: (tmuxName: string, event: any) => {
      for (const h of eventHandlers) h(tmuxName, event);
    },
    _emitRefresh: () => {
      for (const h of refreshHandlers) h();
    },
  } as AgentAdapter & { _emitEvent: (t: string, e: any) => void; _emitRefresh: () => void };
}

describe('RoutingAgentAdapter', () => {
  let taskStore: TaskStore;
  let claudeAdapter: ReturnType<typeof createMockAdapter>;
  let codexAdapter: ReturnType<typeof createMockAdapter>;
  let registry: AdapterRegistry;
  let router: RoutingAgentAdapter;

  beforeEach(() => {
    taskStore = new TaskStore();
    claudeAdapter = createMockAdapter('claude-code');
    codexAdapter = createMockAdapter('codex-cli');
    registry = new AdapterRegistry();
    registry.register(claudeAdapter);
    registry.register(codexAdapter);
    router = new RoutingAgentAdapter(taskStore, registry);
  });

  describe('resolve routing', () => {
    test('routes to correct adapter based on session agentType', async () => {
      const task = taskStore.createTask({ prompt: 'test', cwd: '/cwd', agentType: 'codex-cli' });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-codex-1',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      await router.sendInput('kookr-codex-1', 'hello');

      expect(codexAdapter.sendInput).toHaveBeenCalledWith('kookr-codex-1', 'hello');
      expect(claudeAdapter.sendInput).not.toHaveBeenCalled();
    });

    test('routes to claude-code adapter for claude sessions', async () => {
      const task = taskStore.createTask({ prompt: 'test', cwd: '/cwd' });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-claude-1',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      await router.stop('kookr-claude-1');

      expect(claudeAdapter.stop).toHaveBeenCalledWith('kookr-claude-1');
      expect(codexAdapter.stop).not.toHaveBeenCalled();
    });

    test('falls back to default adapter for unknown session', async () => {
      await router.captureDisplay('unknown-session');

      expect(claudeAdapter.captureDisplay).toHaveBeenCalledWith('unknown-session');
    });

    test('routes sendKeystroke correctly', async () => {
      const task = taskStore.createTask({ prompt: 'test', cwd: '/cwd', agentType: 'codex-cli' });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-codex-2',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      await router.sendKeystroke('kookr-codex-2', 'y');

      expect(codexAdapter.sendKeystroke).toHaveBeenCalledWith('kookr-codex-2', 'y');
    });

    test('routes injectHookEvent correctly', () => {
      const task = taskStore.createTask({ prompt: 'test', cwd: '/cwd', agentType: 'codex-cli' });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-codex-3',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      router.injectHookEvent('kookr-codex-3', '{"event":"test"}');

      expect(codexAdapter.injectHookEvent).toHaveBeenCalledWith('kookr-codex-3', '{"event":"test"}');
    });

    test('routes getEffectiveHookSettings to the correct adapter by session agentType', () => {
      const task = taskStore.createTask({ prompt: 'x', cwd: '/cwd', agentType: 'codex-cli' });
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-codex-4',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
      });

      router.getEffectiveHookSettings('kookr-codex-4');

      expect(codexAdapter.getEffectiveHookSettings).toHaveBeenCalledWith('kookr-codex-4');
      expect(claudeAdapter.getEffectiveHookSettings).not.toHaveBeenCalled();
    });

    test('falls back to default adapter when session is unknown', () => {
      // Matches resolve() behavior: unknown session → registry.getDefault().
      // Claude was registered first in beforeEach, so it's the default.
      router.getEffectiveHookSettings('never-seen');

      expect(claudeAdapter.getEffectiveHookSettings).toHaveBeenCalledWith('never-seen');
      expect(codexAdapter.getEffectiveHookSettings).not.toHaveBeenCalled();
    });
  });

  describe('event fan-in', () => {
    test('fans in events from all adapters', () => {
      const events: Array<{ tmux: string; event: any }> = [];
      router.onEvent((tmuxName, event) => {
        events.push({ tmux: tmuxName, event });
      });

      const claudeWithEmit = claudeAdapter as AgentAdapter & { _emitEvent: (t: string, e: any) => void };
      const codexWithEmit = codexAdapter as AgentAdapter & { _emitEvent: (t: string, e: any) => void };

      claudeWithEmit._emitEvent('kookr-claude-1', { type: 'tool_use', toolName: 'Read' });
      codexWithEmit._emitEvent('kookr-codex-1', { type: 'tool_use', toolName: 'Write' });

      expect(events).toHaveLength(2);
      expect(events[0].tmux).toBe('kookr-claude-1');
      expect(events[1].tmux).toBe('kookr-codex-1');
    });

    test('fans in refresh events from all adapters', () => {
      let refreshCount = 0;
      router.onRefreshNeeded(() => { refreshCount++; });

      const claudeWithEmit = claudeAdapter as AgentAdapter & { _emitRefresh: () => void };
      const codexWithEmit = codexAdapter as AgentAdapter & { _emitRefresh: () => void };

      claudeWithEmit._emitRefresh();
      codexWithEmit._emitRefresh();

      expect(refreshCount).toBe(2);
    });
  });

  describe('launch', () => {
    test('delegates to default adapter', async () => {
      await router.launch('task-1', 'test prompt', '/cwd');

      expect(claudeAdapter.launch).toHaveBeenCalledWith('task-1', 'test prompt', '/cwd', undefined);
    });

    test('forwards ResumeContext to default adapter', async () => {
      const resume = { sessionId: 'session-xyz', transcriptPath: '/tmp/t.jsonl' };
      await router.launch('task-1', 'test prompt', '/cwd', resume);

      expect(claudeAdapter.launch).toHaveBeenCalledWith('task-1', 'test prompt', '/cwd', resume);
    });
  });
});
