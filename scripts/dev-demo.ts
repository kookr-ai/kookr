import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { FakeTerminalBackend } from '../src/adapters/fake-terminal-backend.js';
import type { AgentEvent } from '../src/core/types.js';
import { createKookrServerInternal } from '../src/server/index.js';
import type { KookrServerInternal } from '../src/server/server-test-helpers.js';
import { resolveListenPort } from '../src/server/resolve-listen-port.js';
import { FakeTerminalBridge, type FakeTerminalContent } from '../src/server/fake-terminal-bridge.js';
import {
  authRefactorContent,
  cacheRefactorContent,
  jwtFixContent,
  paginationContent,
  rateLimitContent,
} from '../demo/terminal-content.js';

try {
  process.loadEnvFile?.();
} catch {
  // A demo should still boot in a checkout without .env.
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4801;
const DEMO_SERVER_CWD = '/demo/workspaces';

export interface DevDemoServerOptions {
  port?: number;
  host?: string;
  kookrDir?: string;
  keepDataDir?: boolean;
  printReady?: boolean;
}

export interface DevDemoServerHandle {
  server: KookrServerInternal;
  terminal: FakeTerminalBackend;
  baseUrl: string;
  kookrDir: string;
  seededTaskIds: string[];
  close(): Promise<void>;
}

interface DemoAgentSeed {
  sessionId: string;
  prompt: string;
  cwd: string;
  projectId: string;
  agentType?: 'claude-code' | 'codex-cli';
  terminal: FakeTerminalContent;
  events: AgentEvent[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  createdMinutesAgo: number;
}

const WEBAPP_CWD = `${DEMO_SERVER_CWD}/acme-webapp`;
const API_CWD = `${DEMO_SERVER_CWD}/acme-api`;
const DOCS_CWD = `${DEMO_SERVER_CWD}/acme-docs`;

function getActualPort(server: KookrServerInternal, fallback: number): number {
  const address = server.httpServer.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

function sessionStart(sessionId: string, cwd: string, model = 'claude-sonnet-4-6'): AgentEvent {
  return {
    type: 'session_start',
    sessionId,
    transcriptPath: `/tmp/kookr-demo-${sessionId}.jsonl`,
    model,
    cwd,
  };
}

function toolUse(sessionId: string, cwd: string, toolName: string, toolInput?: unknown): AgentEvent {
  return {
    type: 'tool_use',
    sessionId,
    toolName,
    toolInput,
    toolUseId: `tool-${sessionId}-${toolName.toLowerCase()}`,
    cwd,
  };
}

function permissionRequest(sessionId: string, cwd: string, toolName: string, command: string): AgentEvent {
  return {
    type: 'permission_request',
    sessionId,
    toolName,
    toolInput: { command },
    suggestions: [
      { label: 'Allow', value: 'yes', shortcut: '1' },
      { label: 'Deny', value: 'no', shortcut: '2' },
    ],
    cwd,
  };
}

function stop(sessionId: string, cwd: string, lastMessage: string): AgentEvent {
  return {
    type: 'stop',
    sessionId,
    cwd,
    lastMessage,
    activeBackgroundTaskCount: 0,
    activeSessionCronCount: 0,
  };
}

function demoAgents(): DemoAgentSeed[] {
  return [
    {
      sessionId: 'demo-permission-auth',
      prompt: 'Fix JWT token refresh in auth.ts',
      cwd: WEBAPP_CWD,
      projectId: 'acme/webapp',
      terminal: { text: jwtFixContent(), mode: 'instant' },
      events: [
        sessionStart('demo-permission-auth', WEBAPP_CWD),
        toolUse('demo-permission-auth', WEBAPP_CWD, 'Read', { file_path: 'src/auth/token.ts' }),
        toolUse('demo-permission-auth', WEBAPP_CWD, 'Bash', { command: 'npm test --coverage' }),
        permissionRequest('demo-permission-auth', WEBAPP_CWD, 'Bash', 'npm test --coverage'),
      ],
      costUsd: 0.42,
      inputTokens: 28600,
      outputTokens: 5900,
      createdMinutesAgo: 31,
    },
    {
      sessionId: 'demo-needs-input-cache',
      prompt: 'Refactor cache layer for shared storage',
      cwd: WEBAPP_CWD,
      projectId: 'acme/webapp',
      terminal: { text: cacheRefactorContent(), mode: 'instant' },
      events: [
        sessionStart('demo-needs-input-cache', WEBAPP_CWD),
        toolUse('demo-needs-input-cache', WEBAPP_CWD, 'Grep', { pattern: 'redis|memcached' }),
        stop('demo-needs-input-cache', WEBAPP_CWD, 'Should I use Redis or Memcached for the cache layer?'),
      ],
      costUsd: 0.18,
      inputTokens: 12400,
      outputTokens: 3300,
      createdMinutesAgo: 22,
    },
    {
      sessionId: 'demo-healthy-pagination',
      prompt: 'Add pagination to /users endpoint',
      cwd: API_CWD,
      projectId: 'acme/api-service',
      terminal: { text: paginationContent(), mode: 'streaming', lineDelayMs: 260, loop: true },
      events: [
        sessionStart('demo-healthy-pagination', API_CWD),
        toolUse('demo-healthy-pagination', API_CWD, 'Edit', { file_path: 'src/routes/users.ts' }),
      ],
      costUsd: 0.31,
      inputTokens: 21300,
      outputTokens: 4700,
      createdMinutesAgo: 17,
    },
    {
      sessionId: 'demo-codex-rate-limit',
      prompt: 'Add rate limiting to pagination endpoint',
      cwd: API_CWD,
      projectId: 'acme/api-service',
      agentType: 'codex-cli',
      terminal: { text: rateLimitContent(), mode: 'streaming', lineDelayMs: 340, loop: true },
      events: [
        sessionStart('demo-codex-rate-limit', API_CWD, 'gpt-5-codex'),
        toolUse('demo-codex-rate-limit', API_CWD, 'Read', { file_path: 'src/middleware/rate-limit.ts' }),
      ],
      costUsd: 0.27,
      inputTokens: 18900,
      outputTokens: 4200,
      createdMinutesAgo: 11,
    },
    {
      sessionId: 'demo-completed-auth-refactor',
      prompt: 'Refactor auth middleware to async/await',
      cwd: DOCS_CWD,
      projectId: 'acme/docs',
      terminal: { text: authRefactorContent(), mode: 'instant' },
      events: [
        sessionStart('demo-completed-auth-refactor', DOCS_CWD),
        toolUse('demo-completed-auth-refactor', DOCS_CWD, 'Edit', { file_path: 'src/auth/middleware.ts' }),
      ],
      costUsd: 0.15,
      inputTokens: 9800,
      outputTokens: 2600,
      createdMinutesAgo: 48,
    },
  ];
}

async function seedDemoData(server: KookrServerInternal, terminal: FakeTerminalBackend): Promise<string[]> {
  const seededTaskIds: string[] = [];
  const now = Date.now();

  for (const seed of demoAgents()) {
    const createdAt = new Date(now - seed.createdMinutesAgo * 60_000);
    const task = server.taskStore.createTask({
      prompt: seed.prompt,
      name: seed.prompt,
      cwd: seed.cwd,
      projectId: seed.projectId,
      agentType: seed.agentType ?? 'claude-code',
      priority: seed.sessionId === 'demo-permission-auth' ? 'high' : undefined,
    });

    await terminal.createSession({
      id: seed.sessionId,
      command: seed.agentType === 'codex-cli' ? 'codex' : 'claude',
      args: ['--demo-agent'],
      cwd: seed.cwd,
    });
    terminal.sessions.get(seed.sessionId)!.paneContent = seed.terminal.text;
    FakeTerminalBridge.setContent(seed.sessionId, seed.terminal);

    server.taskStore.addSession(task.id, {
      tmuxSession: seed.sessionId,
      agentType: seed.agentType ?? 'claude-code',
      cwd: seed.cwd,
      createdAt,
      claudeSessionId: seed.sessionId,
      transcriptPath: `/tmp/kookr-demo-${seed.sessionId}.jsonl`,
      lastStatus: 'running',
      gitBranch: seed.projectId === 'acme/api-service' ? 'feat/api-pagination' : 'feat/demo-work',
      gitCommit: 'demo123',
      gitIsWorktree: true,
      gitIsDetached: false,
      worktreeHealth: 'ok',
      worktreeHealthObservedAt: new Date(now - 2 * 60_000).toISOString(),
    });
    server.taskStore.updateTokenUsage(task.id, {
      inputTokens: seed.inputTokens,
      outputTokens: seed.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: seed.costUsd,
    });

    server.monitor.registerAgent(seed.sessionId);
    server.monitor.processEvents(seed.sessionId, seed.events);

    if (seed.sessionId === 'demo-completed-auth-refactor') {
      server.taskStore.updateSession(task.id, seed.sessionId, { lastStatus: 'completed' });
      server.taskStore.completeTask(task.id);
      server.taskStore.setCompletionDigest(task.id, {
        bullets: [
          'Converted auth middleware to async/await',
          'Kept token validation behavior unchanged',
          'Added regression coverage for missing token responses',
        ],
        filesChanged: ['src/auth/middleware.ts', 'src/auth/middleware.test.ts'],
        testSummary: '6 auth middleware tests passing',
      });
    }

    seededTaskIds.push(task.id);
  }

  const pending = server.taskStore.createTask({
    prompt: 'Update onboarding copy for the docs site',
    name: 'Update onboarding copy for the docs site',
    cwd: DOCS_CWD,
    projectId: 'acme/docs',
    agentType: 'claude-code',
  });
  server.taskStore.pendTask(pending.id);
  seededTaskIds.push(pending.id);

  return seededTaskIds;
}

export async function createDevDemoServer(options: DevDemoServerOptions = {}): Promise<DevDemoServerHandle> {
  const previousRemoteChatDisabled = process.env.KOOKR_REMOTE_CHAT_DISABLED;
  const previousRelayUrl = process.env.KOOKR_RELAY_URL;
  const previousRelayToken = process.env.KOOKR_RELAY_TOKEN;
  process.env.KOOKR_REMOTE_CHAT_DISABLED = '1';
  delete process.env.KOOKR_RELAY_URL;
  delete process.env.KOOKR_RELAY_TOKEN;

  const host = options.host ?? process.env.KOOKR_HOST ?? DEFAULT_HOST;
  const requestedPort = options.port ?? Number.parseInt(process.env.KOOKR_PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : DEFAULT_PORT;
  const kookrDir = options.kookrDir ?? mkdtempSync(join(tmpdir(), 'kookr-dev-demo-'));
  const terminal = new FakeTerminalBackend();
  const lifecycleAc = new AbortController();

  let server: KookrServerInternal;
  try {
    server = await createKookrServerInternal({
      port,
      host,
      kookrDir,
      tasksFile: join(kookrDir, 'tasks.json'),
      hooksDir: join(kookrDir, 'hooks'),
      settingsDir: join(kookrDir, 'settings'),
      serverCwd: DEMO_SERVER_CWD,
      frontendDir: join(process.cwd(), 'dist', 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: terminal,
      useFakeTerminalBridge: true,
      claudeDir: join(kookrDir, 'claude'),
      sttUrl: 'ws://localhost:9999',
      lifecycleSignal: lifecycleAc.signal,
      validateLaunchCwd: async () => {},
    });
  } catch (err) {
    restoreDemoEnv(previousRemoteChatDisabled, previousRelayUrl, previousRelayToken);
    throw err;
  }

  const actualPort = getActualPort(server, port);
  const seededTaskIds = await seedDemoData(server, terminal);
  const baseUrl = `http://${host}:${actualPort}`;

  if (options.printReady !== false) {
    console.log(`[dev-demo] seeded ${seededTaskIds.length} synthetic tasks`);
    console.log(`[dev-demo] backend ready on ${baseUrl}`);
    console.log('[dev-demo] dashboard: http://127.0.0.1:5173');
  }

  let closed = false;
  return {
    server,
    terminal,
    baseUrl,
    kookrDir,
    seededTaskIds,
    close: async () => {
      if (closed) return;
      closed = true;
      lifecycleAc.abort();
      await server.close();
      FakeTerminalBridge.clearContent();
      restoreDemoEnv(previousRemoteChatDisabled, previousRelayUrl, previousRelayToken);
      if (!options.keepDataDir && !options.kookrDir) {
        rmSync(kookrDir, { recursive: true, force: true });
      }
    },
  };
}

function restoreDemoEnv(
  remoteChatDisabled: string | undefined,
  relayUrl: string | undefined,
  relayToken: string | undefined,
): void {
  restoreEnvValue('KOOKR_REMOTE_CHAT_DISABLED', remoteChatDisabled);
  restoreEnvValue('KOOKR_RELAY_URL', relayUrl);
  restoreEnvValue('KOOKR_RELAY_TOKEN', relayToken);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function main(): Promise<void> {
  const host = process.env.KOOKR_HOST ?? DEFAULT_HOST;
  const portResolution = await resolveListenPort(process.env.KOOKR_PORT ?? String(DEFAULT_PORT), host);
  if (portResolution.source === 'auto') {
    process.env.KOOKR_PORT = String(portResolution.port);
  }
  const handle = await createDevDemoServer({ host, port: portResolution.port });

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n${signal} received. Shutting down dev demo...`);
    await handle.close();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[dev-demo] failed:', err);
    process.exit(1);
  });
}
