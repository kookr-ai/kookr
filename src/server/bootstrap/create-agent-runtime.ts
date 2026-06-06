import { writeFile } from 'node:fs/promises';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../../adapters/codex-cli-adapter.js';
import { RoutingAgentAdapter } from '../../adapters/routing-agent-adapter.js';
import type { TerminalBackend } from '../../adapters/terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../../core/ports/terminal-input-writer-port.js';
import type { TaskStore } from '../../core/tasks.js';
import type { AgentEffortMap } from '../../core/agent-types.js';
import {
  runAdapterPreflights,
  type AgentPreflightSnapshot,
  type PreflightLogger,
} from '../agent-preflight.js';

export interface AgentRuntimeDeps {
  terminalBackend: TerminalBackend;
  terminalInputWriter?: TerminalInputWriterPort;
  taskStore: TaskStore;
  hooksDir: string;
  settingsDir: string;
  serverPort: number;
  agentBin?: string;
  codexBin?: string;
  bypassAllPermissions?: boolean;
  preflightOnFatal?: (snapshot: AgentPreflightSnapshot & { status: 'absent' }) => never;
  preflightLogger?: PreflightLogger;
  /**
   * Live getter for the configured per-agent-type effort defaults (#681). Each
   * adapter receives a narrowed `resolveDefaultEffort` closure reading its own
   * entry, so an operator's settings change applies to the next launch — across
   * every launch path — without a restart. Omitted in tests that don't exercise
   * effort: adapters then pass no effort flag (byte-identical to pre-#681).
   */
  getAgentEffort?: () => AgentEffortMap;
}

export interface AgentRuntime {
  claudeCodeAdapter: ClaudeCodeAdapter;
  codexCliAdapter: CodexCliAdapter;
  adapterRegistry: AdapterRegistry;
  adapter: AgentAdapter;
  agentPreflight: Record<string, AgentPreflightSnapshot>;
}

export async function createAgentRuntime(deps: AgentRuntimeDeps): Promise<AgentRuntime> {
  const terminalInputWriter = deps.terminalInputWriter ?? asTerminalInputWriterPort(deps.terminalBackend);
  const claudeCodeAdapter = new ClaudeCodeAdapter(deps.terminalBackend, deps.taskStore, {
    terminalInputWriter,
    hooksDir: deps.hooksDir,
    settingsDir: deps.settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: deps.serverPort,
    agentBin: deps.agentBin,
    bypassAllPermissions: deps.bypassAllPermissions,
    resolveDefaultEffort: () => deps.getAgentEffort?.()['claude-code'],
  });
  const codexCliAdapter = new CodexCliAdapter(deps.terminalBackend, deps.taskStore, {
    terminalInputWriter,
    hooksDir: deps.hooksDir,
    settingsDir: deps.settingsDir,
    writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    serverPort: deps.serverPort,
    agentBin: deps.codexBin,
    bypassAllPermissions: deps.bypassAllPermissions,
    resolveDefaultEffort: () => deps.getAgentEffort?.()['codex-cli'],
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
