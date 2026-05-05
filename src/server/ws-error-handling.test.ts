import { describe, test, expect, beforeEach } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import type {
  BackendError,
  BackendStats,
  SessionId,
  SessionSpec,
  TerminalBackend,
} from '../adapters/terminal-backend.js';
import { MessageRouter } from './ws.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';

/**
 * A terminal backend that always fails on createSession.
 * Simulates: claude not installed, dtach error, permission denied, etc.
 */
class FailingTerminalBackend implements TerminalBackend {
  async createSession(_spec: SessionSpec): Promise<void> {
    throw new Error('tmux: command not found');
  }
  async listSessions(): Promise<SessionId[]> { return []; }
  async isAlive(_id: SessionId): Promise<boolean> { return false; }
  async killSession(_id: SessionId): Promise<void> {}
  async write(_id: SessionId, _data: Uint8Array): Promise<void> {}
  async writeSequence(_id: SessionId, _payloads: Uint8Array[]): Promise<void> {}
  async captureBytes(_id: SessionId, _maxBytes?: number): Promise<Uint8Array> {
    return new Uint8Array();
  }
  onData(_id: SessionId, _cb: (data: Uint8Array) => void): () => void {
    return () => {};
  }
  onBackendError(_cb: (err: BackendError) => void): () => void {
    return () => {};
  }
  async resize(_id: SessionId, _cols: number, _rows: number): Promise<void> {}
  getStats(): BackendStats {
    return {
      attachedSessions: 0,
      reattachCounts: {},
      pendingWriters: 0,
      lastError: null,
      errorCount: 0,
    };
  }
}

describe('WebSocket error handling on launch failure', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;
  let adapter: ClaudeCodeAdapter;
  let sentMessages: ServerMessage[];
  let router: MessageRouter;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
    // Use a backend that always fails
    const failingBackend = new FailingTerminalBackend();
    adapter = new ClaudeCodeAdapter(failingBackend, taskStore);
    sentMessages = [];

    // Launch function that uses the failing adapter
    const failingLaunchTask = async (opts: LaunchOpts): Promise<LaunchResult> => {
      const task = taskStore.createTask(opts.prompt, opts.cwd, opts.criteria);
      await adapter.launch(task.id, opts.prompt, opts.cwd);
      return { task, queued: false };
    };

    router = new MessageRouter({
      taskStore, queue, monitor, adapter,
      send: (msg) => { sentMessages.push(msg); },
      launchTask: failingLaunchTask,
    });
  });

  test('handleMessageSafe catches launch failure and sends error alert', async () => {
    await router.handleMessageSafe({
      type: 'launch',
      prompt: 'Fix the auth bug',
      cwd: '/home/user/project',
    });

    const alerts = sentMessages.filter((m) => m.type === 'alert');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    expect(alert.type).toBe('alert');
    if (alert.type === 'alert') {
      expect(alert.severity).toBe('critical');
      expect(alert.summary).toContain('command not found');
    }
  });
});
