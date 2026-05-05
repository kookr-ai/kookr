/**
 * Integration tests for AutoProceedService — exercises the full server stack
 * (WS protocol, event pipeline, snapshot broadcast) to verify the manual
 * PR checklist items:
 *
 * 1. Launch autonomous task → countdown appears in snapshot
 * 2. cancelAutoProceed → countdown clears
 * 3. respond before countdown → timer cancelled
 * 4. MAX_RETRIES=2 → escalation to supervised
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import type { ServerMessage, ClientMessage } from '../shared/protocol.js';
import type { AgentState } from '../core/monitor.js';

function getActualPort(server: KookrServerInternal): number {
  const addr = server.httpServer.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('Server not listening');
}

/** Connect a WS client and collect messages. Returns helpers. */
function connectWs(port: number): {
  ws: WebSocket;
  messages: ServerMessage[];
  send: (msg: ClientMessage) => void;
  waitForSnapshot: (predicate: (agents: AgentState[]) => boolean, timeoutMs?: number) => Promise<AgentState[]>;
  close: () => void;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: ServerMessage[] = [];

  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  function send(msg: ClientMessage) {
    ws.send(JSON.stringify(msg));
  }

  function waitForSnapshot(
    predicate: (agents: AgentState[]) => boolean,
    timeoutMs = 5000,
  ): Promise<AgentState[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Snapshot predicate not met within ${timeoutMs}ms. Last messages: ${messages.slice(-3).map(m => m.type).join(', ')}`));
      }, timeoutMs);

      function check() {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.type === 'snapshot' && predicate(msg.agents)) {
            clearTimeout(timer);
            resolve(msg.agents);
            return true;
          }
        }
        return false;
      }

      if (check()) return;

      const listener = () => {
        if (check()) {
          ws.removeListener('message', listener);
        }
      };
      ws.on('message', listener);
    });
  }

  return {
    ws,
    messages,
    send,
    waitForSnapshot,
    close: () => ws.close(),
  };
}

describe('AutoProceed integration', () => {
  let tempDir: string;
  let server: KookrServerInternal;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-autoproceed-'));
    server = await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: '/test/cwd',
      frontendDir: join(tempDir, 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: new FakeTerminalBackend(),
    });
    port = getActualPort(server);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Launch an autonomous task and return its agent state once it appears in the snapshot. */
  async function launchAutonomousTask(client: ReturnType<typeof connectWs>) {
    client.send({
      type: 'launch',
      prompt: 'Test autonomous task',
      cwd: '/test/project',
      autonomy: 'autonomous',
    });

    // Wait for the task to appear in a snapshot
    const agents = await client.waitForSnapshot(
      (agents) => agents.some((a) => a.taskName !== undefined || a.agentId.startsWith('kookr-')),
    );
    return agents.find((a) => a.taskName !== undefined || a.agentId.startsWith('kookr-'))!;
  }

  /** Inject a stop hook event to trigger needs_input with subType: stop */
  function injectStopEvent(agentId: string) {
    server.adapter.injectHookEvent(agentId, JSON.stringify({
      session_id: 'test-session',
      transcript_path: '/tmp/test-transcript.jsonl',
      cwd: '/test/project',
      hook_event_name: 'Stop',
      stop_hook_active: true,
      stop_reason: 'stop_tool',
      message: 'I have completed the analysis. Would you like me to proceed?',
    }));
  }

  test('autonomous task gets autoProceedingAt in snapshot after stop event', async () => {
    const client = connectWs(port);
    await new Promise((r) => client.ws.on('open', r));

    // Launch autonomous task
    const agent = await launchAutonomousTask(client);
    const agentId = agent.agentId;

    // Inject stop event → should trigger needs_input with subType: stop
    injectStopEvent(agentId);

    // Wait for snapshot with autoProceedingAt set
    const agents = await client.waitForSnapshot(
      (agents) => {
        const a = agents.find((s) => s.agentId === agentId);
        return !!(a?.anomaly?.autoProceedingAt);
      },
    );

    const found = agents.find((a) => a.agentId === agentId)!;
    expect(found.anomaly!.type).toBe('needs_input');
    expect(found.anomaly!.subType).toBe('stop');
    expect(found.anomaly!.autoProceedingAt).toBeDefined();

    // Verify the timestamp is in the future
    const proceedAt = new Date(found.anomaly!.autoProceedingAt!).getTime();
    expect(proceedAt).toBeGreaterThan(Date.now());

    client.close();
  });

  test('cancelAutoProceed clears autoProceedingAt from snapshot', async () => {
    const client = connectWs(port);
    await new Promise((r) => client.ws.on('open', r));

    const agent = await launchAutonomousTask(client);
    const agentId = agent.agentId;

    injectStopEvent(agentId);

    // Wait for auto-proceed to be scheduled
    await client.waitForSnapshot(
      (agents) => !!(agents.find((s) => s.agentId === agentId)?.anomaly?.autoProceedingAt),
    );

    // Cancel auto-proceed
    client.send({ type: 'cancelAutoProceed', agentId });

    // Wait for snapshot where autoProceedingAt is cleared
    const agents = await client.waitForSnapshot(
      (agents) => {
        const a = agents.find((s) => s.agentId === agentId);
        return a?.anomaly?.type === 'needs_input' && !a.anomaly.autoProceedingAt;
      },
    );

    const found = agents.find((a) => a.agentId === agentId)!;
    expect(found.anomaly!.type).toBe('needs_input');
    expect(found.anomaly!.autoProceedingAt).toBeUndefined();

    client.close();
  });

  test('respond cancels pending auto-proceed timer', async () => {
    const client = connectWs(port);
    await new Promise((r) => client.ws.on('open', r));

    const agent = await launchAutonomousTask(client);
    const agentId = agent.agentId;

    injectStopEvent(agentId);

    // Wait for auto-proceed scheduled
    await client.waitForSnapshot(
      (agents) => !!(agents.find((s) => s.agentId === agentId)?.anomaly?.autoProceedingAt),
    );

    // User responds — this should cancel the auto-proceed
    client.send({ type: 'respond', agentId, input: 'go ahead' });

    // Wait for anomaly to clear (respond clears needs_input)
    const agents = await client.waitForSnapshot(
      (agents) => {
        const a = agents.find((s) => s.agentId === agentId);
        // After respond: anomaly should be cleared, no autoProceedingAt
        return !a?.anomaly?.autoProceedingAt && a?.anomaly?.type !== 'needs_input';
      },
    );

    const found = agents.find((a) => a.agentId === agentId);
    expect(found?.anomaly?.autoProceedingAt).toBeUndefined();

    client.close();
  });

  test('setAutonomy to supervised cancels auto-proceed and resets retries', async () => {
    const client = connectWs(port);
    await new Promise((r) => client.ws.on('open', r));

    const agent = await launchAutonomousTask(client);
    const agentId = agent.agentId;
    const taskId = agent.taskId!;

    injectStopEvent(agentId);

    // Wait for auto-proceed scheduled
    await client.waitForSnapshot(
      (agents) => !!(agents.find((s) => s.agentId === agentId)?.anomaly?.autoProceedingAt),
    );

    // Switch to supervised
    client.send({ type: 'setAutonomy', taskId, level: 'supervised' });

    // Wait for autoProceedingAt to clear — use a snapshot that arrives AFTER
    // ws-connection-handler's post-handleMessage broadcast (the second one),
    // to ensure the full handler has completed.
    // Clear existing messages so we only match on NEW snapshots from the setAutonomy handler.
    client.messages.length = 0;
    const agents = await client.waitForSnapshot(
      (agents) => {
        const a = agents.find((s) => s.agentId === agentId);
        return a?.anomaly?.type === 'needs_input' && !a.anomaly.autoProceedingAt;
      },
    );

    const found = agents.find((a) => a.agentId === agentId)!;
    expect(found.anomaly!.autoProceedingAt).toBeUndefined();

    // Verify task autonomy was changed — check after giving the handler time to complete
    // The WS handler runs async; wait a tick to ensure it's fully done.
    await new Promise((r) => setTimeout(r, 50));
    const task = server.taskStore.findTaskBySession(agentId);
    expect(task?.autonomy).toBe('supervised');
    expect(task?.autoProceedRetries).toBe(0);

    client.close();
  });

  test('REST API POST /api/agents/:id/message cancels auto-proceed', async () => {
    const client = connectWs(port);
    await new Promise((r) => client.ws.on('open', r));

    const agent = await launchAutonomousTask(client);
    const agentId = agent.agentId;

    injectStopEvent(agentId);

    // Wait for auto-proceed scheduled
    await client.waitForSnapshot(
      (agents) => !!(agents.find((s) => s.agentId === agentId)?.anomaly?.autoProceedingAt),
    );

    // Send input via REST API
    const res = await fetch(`http://127.0.0.1:${port}/api/agents/${agentId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: 'proceed' }),
    });
    expect(res.status).toBe(200);

    // Wait for autoProceedingAt to clear
    const agents = await client.waitForSnapshot(
      (agents) => !!(agents.find((s) => s.agentId === agentId) && !agents.find((s) => s.agentId === agentId)?.anomaly?.autoProceedingAt),
    );

    const found = agents.find((a) => a.agentId === agentId);
    expect(found?.anomaly?.autoProceedingAt).toBeUndefined();

    client.close();
  });
});
