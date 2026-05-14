import { describe, expect, it } from 'vitest';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { TaskStore } from '../core/tasks.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { MessageRouter } from './ws.js';

function fakeAdapter(): AgentAdapter {
  return {
    agentType: 'claude-code',
    async launch() { return 'session'; },
    async sendInput() {},
    async sendKeystroke() {},
    async stop() {},
    async captureDisplay() { return ''; },
    onEvent() {},
    onRefreshNeeded() {},
    injectHookEvent() {},
    getEffectiveHookSettings() { return undefined; },
  };
}

describe('local-only WebSocket snapshots', () => {
  it('do not emit serverRevision on the real connect snapshot path with relay unset', () => {
    const previousRelay = process.env.KOOKR_RELAY_URL;
    delete process.env.KOOKR_RELAY_URL;
    try {
      const taskStore = new TaskStore();
      const queue = new AttentionQueue();
      const monitor = new Monitor(taskStore, queue);
      const sent: ServerMessage[] = [];

      const router = new MessageRouter({
        taskStore,
        queue,
        monitor,
        adapter: fakeAdapter(),
        send: (msg) => sent.push(msg),
        serverCwd: '/repo',
        ralphLoopService: {} as never,
      });

      router.handleConnect();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'snapshot', serverCwd: '/repo' });
      expect(sent[0]).not.toHaveProperty('serverRevision');
    } finally {
      if (previousRelay === undefined) delete process.env.KOOKR_RELAY_URL;
      else process.env.KOOKR_RELAY_URL = previousRelay;
    }
  });
});
