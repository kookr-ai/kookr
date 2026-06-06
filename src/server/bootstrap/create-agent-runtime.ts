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
import { runAgentLauncherPreflight } from '../agent-launcher-preflight.js';

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

  // Verify a bare `kookr` resolves on the agent PATH (issue #786). Warn-and-
  // continue, not fatal: completion signalling is advisory (the agent never
  // fails its task over it), and a Claude-only deployment with a stripped bin/
  // should still boot. But surface it loudly here so the break is diagnosed at
  // startup rather than at an agent's final `kookr signal completion-ready`.
  const logger = deps.preflightLogger ?? console;
  const launcherPreflight = await runAgentLauncherPreflight();
  if (launcherPreflight.status === 'ok') {
    logger.log(`[startup] agent-launcher: \`kookr\` resolves on agent PATH via ${launcherPreflight.launcherDir}`);
  } else {
    logger.warn(
      `[startup] agent-launcher: ${launcherPreflight.reason}. ` +
        'Agents may hit exit 127 on `kookr signal completion-ready` until this is fixed.',
    );
  }

  return {
    claudeCodeAdapter,
    codexCliAdapter,
    adapterRegistry,
    adapter,
    agentPreflight,
  };
}
