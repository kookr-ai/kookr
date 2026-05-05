/**
 * E2E test server — starts Kookr with FakeTerminalBackend (no dtach required)
 * and adds test-only API endpoints for event injection and state reset.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKookrServerInternal } from '../src/server/index.js';
import type { KookrServerInternal } from '../src/server/server-test-helpers.js';
import { FakeTerminalBackend } from '../src/adapters/fake-terminal-backend.js';
import { FakeTerminalBridge } from '../src/server/fake-terminal-bridge.js';
import type { Playbook } from '../src/core/playbook.js';

/** Playbook override — when set, listPlaybooks returns these instead of reading from disk. */
let playbookOverrides: Map<string, Playbook[]> | null = null;

const PORT = process.env.E2E_PORT !== undefined ? Number(process.env.E2E_PORT) : 4802;
const tempDir = mkdtempSync(join(tmpdir(), 'kookr-e2e-'));
const terminal = new FakeTerminalBackend();

async function main() {
  const server = await createKookrServerInternal({
    port: PORT,
    host: '127.0.0.1',
    kookrDir: tempDir,
    tasksFile: join(tempDir, 'tasks.json'),
    hooksDir: join(tempDir, 'hooks'),
    settingsDir: join(tempDir, 'settings'),
    serverCwd: '/home/user/projects',
    frontendDir: './dist/frontend',
    saveIntervalMs: 600_000,
    livenessIntervalMs: 600_000,
    terminalBackend: terminal,
    useFakeTerminalBridge: true,
    // Dummy STT URL so the mic button renders in the UI (no real STT service needed)
    sttUrl: 'ws://localhost:9999',
  });

  // --- Test-only API routes ---

  // Inject a hook event for a given tmux session.
  // Returns the post-injection snapshot so tests can verify state without racing WS delivery.
  server.app.post('/api/test/inject-event', async (c) => {
    const { tmuxName, event } = await c.req.json();
    server.adapter.injectHookEvent(tmuxName, JSON.stringify(event));
    const snapshot = server.monitor.getSnapshot();
    return c.json({ ok: true, agentCount: snapshot.length, findingCount: snapshot.filter(a => a.anomaly).length });
  });

  // Get the interaction log path (for tests to read or verify)
  server.app.get('/api/test/interaction-log', async (c) => {
    return c.json({ path: server.interactionLog.getFilePath() });
  });

  // Session option inspection was a tmux-era test endpoint (mouse mode
  // remediation). V8 removed tmux — dtach has no equivalent, so the route
  // always returns 410 Gone. Any E2E still hitting it is a stale test.
  server.app.get('/api/test/session-option/:tmuxName/:option', (c) => {
    return c.json({ error: 'session-option endpoint removed in V8 (dtach backend has no tmux options)' }, 410);
  });

  // Broadcast an alert to all connected WebSocket clients (for toast tests)
  server.app.post('/api/test/broadcast-alert', async (c) => {
    const { agentId, summary, severity } = await c.req.json();
    server.broadcastToAll({
      type: 'alert',
      agentId: agentId ?? 'test-agent',
      summary,
      details: '',
      severity: severity ?? 'info',
    });
    return c.json({ ok: true });
  });

  // Broadcast a github_update to all connected WebSocket clients
  server.app.post('/api/test/broadcast-github', async (c) => {
    const { taskId, prs, issues, changes } = await c.req.json();
    server.broadcastToAll({
      type: 'githubUpdate',
      taskId,
      prs: prs ?? [],
      issues: issues ?? [],
      changes: changes ?? [],
    });
    return c.json({ ok: true });
  });

  // Complete a task (for lifecycle tests)
  server.app.post('/api/test/complete-task/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    try {
      server.taskStore.completeTask(taskId);
      const snapshot = server.monitor.getSnapshot();
      server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Cancel a task (for lifecycle tests)
  server.app.post('/api/test/cancel-task/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    try {
      server.taskStore.cancelTask(taskId);
      const snapshot = server.monitor.getSnapshot();
      server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Archive endpoint removed — archived state no longer exists in TaskStatus

  // Reopen a task (for lifecycle tests)
  server.app.post('/api/test/reopen-task/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    try {
      server.taskStore.reopenTask(taskId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Set projectId on a task (for project tracking tests)
  server.app.post('/api/test/set-project-id', async (c) => {
    const { taskId, projectId } = await c.req.json();
    server.taskStore.setProjectId(taskId, projectId);
    // Broadcast updated snapshot so frontend sees the projectId
    const snapshot = server.monitor.getSnapshot();
    server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
    return c.json({ ok: true });
  });

  // Add a contribution record (for project tracking tests).
  // Maps the legacy ContributionRecord shape used by E2E fixtures onto the
  // unified OssAttemptStore. Seeds both the attempts list (so open-PR count
  // and last-contribution timestamp are correct) and the in-memory ledger
  // entries (so `getTodayCount`/`getWeekCount` — which source the
  // rate-limit badge — see the injected PR as `pr_created` today).
  server.app.post('/api/test/add-contribution', async (c) => {
    const record = await c.req.json() as {
      project: string;
      prUrl: string;
      prNumber: number;
      title?: string;
      createdAt: string;
      status: 'open' | 'merged' | 'closed';
    };
    const repo = record.project.replace(/^github\.com\//, '');
    const state = record.status === 'open' ? 'pr_open' : record.status;
    server.ossAttemptStore.upsertPr({
      repo,
      prNumber: record.prNumber,
      prUrl: record.prUrl,
      prTitle: record.title ?? '',
      state,
      at: record.createdAt,
      source: 'backfill',
    });
    // Also append to the ledger (append-only JSONL) and reload it so the
    // in-memory `ledgerEntries` array picks up the new pr_created record.
    try {
      const { appendFileSync } = await import('node:fs');
      const ledgerPath = server.ossAttemptStore.getLedgerPath();
      appendFileSync(
        ledgerPath,
        JSON.stringify({
          timestamp: record.createdAt,
          repo,
          action: 'pr_created',
          prUrl: record.prUrl,
        }) + '\n',
      );
      await server.ossAttemptStore.loadFromLedger();
    } catch (e) {
      console.warn('[test-server] ledger append failed:', e);
    }
    return c.json({ ok: true });
  });

  // Set project config (for project tracking tests)
  server.app.post('/api/test/set-project-config', async (c) => {
    const { project, ...config } = await c.req.json();
    server.projectConfigStore.setConfig(project, config);
    return c.json({ ok: true });
  });

  // Broadcast project summaries (for project tracking tests)
  server.app.post('/api/test/broadcast-project-summaries', async (c) => {
    const { computeProjectSummaries } = await import('../src/core/project-summary.js');
    const { LedgerAnalytics } = await import('../src/core/ledger-analytics.js');
    const agents = server.monitor.getSnapshot();
    const summaries = computeProjectSummaries({
      agents,
      ledgerAnalytics: new LedgerAnalytics(server.ossAttemptStore),
      configStore: server.projectConfigStore,
    });
    server.broadcastToAll({ type: 'projectSummaries', projects: summaries });
    return c.json({ ok: true, count: summaries.length });
  });

  // Broadcast a synthetic workspace view — lets the cleanup panel tests
  // seed candidates with enrichment fields without running real git.
  server.app.post('/api/test/broadcast-workspace-view', async (c) => {
    const view = await c.req.json();
    server.broadcastToAll({ type: 'workspaceView', view });
    return c.json({ ok: true });
  });

  // Get keys received by a fake terminal session (for verifying message delivery)
  server.app.get('/api/test/keys-received/:tmuxName', (c) => {
    const tmuxName = c.req.param('tmuxName');
    const session = terminal.sessions.get(tmuxName);
    if (!session) {
      return c.json({ error: `Session not found: ${tmuxName}` }, 404);
    }
    return c.json({ tmuxName, keysReceived: session.keysReceived });
  });

  // Backdate an anomaly's detectedAt (for age badge tests)
  server.app.post('/api/test/backdate-anomaly', async (c) => {
    const { agentId, minutesAgo } = await c.req.json();
    const detectedAt = new Date(Date.now() - minutesAgo * 60_000);
    const ok = server.queue.backdateAnomaly(agentId, detectedAt);
    if (!ok) return c.json({ error: `No active anomaly for ${agentId}` }, 404);
    // Broadcast updated snapshot so frontend sees the new detectedAt
    const snapshot = server.monitor.getSnapshot();
    server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
    return c.json({ ok: true });
  });

  // Reset all server state (clean slate between tests)
  server.app.post('/api/test/reset', async (c) => {
    // Unregister all agents from monitor
    const snapshot = server.monitor.getSnapshot();
    for (const agent of snapshot) {
      server.monitor.unregisterAgent(agent.agentId);
    }

    // Clear attention queue directly (catches orphaned entries not in monitor)
    server.queue.clear();

    // Clear task store
    server.taskStore.loadTasks([]);

    // Stop all hook watchers
    server.hookWatcher.stopAll();

    // Clear watchdog state
    server.watchdog.clear();

    // Clear fake terminal sessions and content
    terminal.sessions.clear();
    FakeTerminalBridge.clearContent();

    return c.json({ ok: true });
  });

  // Set pane content on a FakeTerminalManager session (used by capturePane/captureDisplay)
  server.app.post('/api/test/set-pane-content', async (c) => {
    const { tmuxName, content } = await c.req.json();
    const session = terminal.sessions.get(tmuxName);
    if (!session) return c.json({ error: `Session not found: ${tmuxName}` }, 404);
    session.paneContent = content;
    return c.json({ ok: true });
  });

  // Get last keystroke sent via sendKeystroke (for permission button tests)
  server.app.get('/api/test/last-keystroke', (c) => {
    return c.json({ lastKeystroke: terminal.lastKeystroke });
  });

  // Broadcast a suggestion to all connected WebSocket clients (for demo recording)
  server.app.post('/api/test/broadcast-suggestion', async (c) => {
    const { agentId, suggestions, quickActions } = await c.req.json();
    server.broadcastToAll({
      type: 'suggestion',
      agentId,
      suggestions: suggestions ?? [],
      quickActions: quickActions ?? [],
    });
    return c.json({ ok: true });
  });

  // Broadcast playbooks to all connected WebSocket clients (for demo recording)
  server.app.post('/api/test/broadcast-playbooks', async (c) => {
    const { cwd, playbooks } = await c.req.json();
    server.broadcastToAll({
      type: 'playbooks',
      cwd: cwd ?? '/home/user/projects',
      playbooks: playbooks ?? [],
    });
    return c.json({ ok: true });
  });

  // Create playbook files on disk so listPlaybooks discovers them.
  // Body: { cwd, playbooks: [{ filename, content }] }
  // Creates <cwd>/.kookr/playbooks/<filename> for each playbook.
  server.app.post('/api/test/create-playbook-files', async (c) => {
    const { cwd, playbooks } = await c.req.json() as {
      cwd: string;
      playbooks: Array<{ filename: string; content: string }>;
    };
    const pbDir = join(cwd, '.kookr', 'playbooks');
    mkdirSync(pbDir, { recursive: true });
    for (const { filename, content } of playbooks) {
      writeFileSync(join(pbDir, filename), content);
    }
    return c.json({ ok: true, dir: pbDir, count: playbooks.length });
  });

  // Disable achievements server-side (prevents toasts from firing during demo recording).
  // Achievement watcher isn't exposed on the server object, so we use a WebSocket message
  // approach: the recording script should hide achievement toasts via CSS instead.

  // Set lifetime spend and per-task token usage (for demo recording)
  server.app.post('/api/test/set-spend', async (c) => {
    const { lifetimeSpendUsd, tasks: taskCosts } = await c.req.json() as {
      lifetimeSpendUsd?: number;
      tasks?: Array<{ taskId: string; costUsd: number; inputTokens?: number; outputTokens?: number }>;
    };
    // Set per-task token usage
    if (taskCosts) {
      for (const { taskId, costUsd, inputTokens, outputTokens } of taskCosts) {
        server.taskStore.updateTokenUsage(taskId, {
          inputTokens: inputTokens ?? Math.round(costUsd * 10000),
          outputTokens: outputTokens ?? Math.round(costUsd * 2000),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd,
        });
      }
    }
    // Override lifetime spend if provided (loadTasks sets it)
    if (lifetimeSpendUsd !== undefined) {
      const allTasks = server.taskStore.getAllTasks();
      server.taskStore.loadTasks(allTasks, lifetimeSpendUsd);
    }
    // Broadcast updated snapshot so frontend sees the new spend
    const snapshot = server.monitor.getSnapshot();
    server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
    return c.json({ ok: true });
  });

  // Set completion digest on a task (for demo recording)
  server.app.post('/api/test/set-completion-digest/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const digest = await c.req.json();
    try {
      server.taskStore.setCompletionDigest(taskId, digest);
      // Broadcast updated snapshot
      const snapshot = server.monitor.getSnapshot();
      server.broadcastToAll({ type: 'snapshot', agents: snapshot, serverCwd: '/home/user/projects' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  // Set fake terminal content for a tmux session (used by demo recording)
  // Body: { tmuxName, content: { text, mode?, lineDelayMs?, loop? } }
  // Shorthand: { tmuxName, text } sets streaming mode with default speed
  server.app.post('/api/test/set-terminal-content', async (c) => {
    const body = await c.req.json();
    const { tmuxName } = body;
    if (body.content) {
      FakeTerminalBridge.setContent(tmuxName, body.content);
    } else if (body.text) {
      FakeTerminalBridge.setContent(tmuxName, { text: body.text });
    }
    return c.json({ ok: true });
  });

  // Print actual port (may differ from PORT when E2E_PORT=0 requests an ephemeral port).
  // The per-worker fixture in fixtures.ts parses this line to discover the port.
  const addr = server.httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`E2E_PORT=${actualPort}`);
  console.log(`E2E test server ready on http://127.0.0.1:${actualPort}`);

  async function cleanup() {
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
    process.exit(0);
  }

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

main().catch((err) => {
  console.error('E2E test server failed:', err);
  process.exit(1);
});
