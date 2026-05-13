import { writeFile } from 'node:fs/promises';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../../adapters/codex-cli-adapter.js';
import { RoutingAgentAdapter } from '../../adapters/routing-agent-adapter.js';
import type { TerminalBackend } from '../../adapters/terminal-backend.js';
import type { TaskStore } from '../../core/tasks.js';
import {
  runAdapterPreflights,
  type AgentPreflightSnapshot,
  type PreflightLogger,
} from '../agent-preflight.js';

export interface AgentRuntimeDeps {
  terminalBackend: TerminalBackend;
  taskStore: TaskStore;
  hooksDir: string;
  settingsDir: string;
  serverPort: number;
  agentBin?: string;
  codexBin?: string;
  bypassAllPermissions?: boolean;
  kookrDir: string;
  preflightOnFatal?: (snapshot: AgentPreflightSnapshot & { status: 'absent' }) => never;
  preflightLogger?: PreflightLogger;
}

export interface AgentRuntime {
  claudeCodeAdapter: ClaudeCodeAdapter;
  codexCliAdapter: CodexCliAdapter;
  adapterRegistry: AdapterRegistry;
  adapter: AgentAdapter;
  agentPreflight: Record<string, AgentPreflightSnapshot>;
}

export async function createAgentRuntime(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  const claudeCodeAdapter = new ClaudeCodeAdapter(deps.terminalBackend, deps.taskStore, {
    hooksDir: deps.hooksDir,
    settingsDir: deps.settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: deps.serverPort,
    agentBin: deps.agentBin,
    bypassAllPermissions: deps.bypassAllPermissions,
    kookrDataDir: deps.kookrDir,
  });
  const codexCliAdapter = new CodexCliAdapter(deps.terminalBackend, deps.taskStore, {
    hooksDir: deps.hooksDir,
    settingsDir: deps.settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: deps.serverPort,
    agentBin: deps.codexBin,
    bypassAllPermissions: deps.bypassAllPermissions,
    kookrDataDir: deps.kookrDir,
  });

  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(claudeCodeAdapter);
  adapterRegistry.register(codexCliAdapter);
  const adapter = new RoutingAgentAdapter(deps.taskStore, adapterRegistry);

  const agentPreflight = await runAdapterPreflights(adapterRegistry, {
    onFatal: deps.preflightOnFatal ?? ((): never => process.exit(1)),
    logger: deps.preflightLogger,
  });

  return {
    claudeCodeAdapter,
    codexCliAdapter,
    adapterRegistry,
    adapter,
    agentPreflight,
  };
}
