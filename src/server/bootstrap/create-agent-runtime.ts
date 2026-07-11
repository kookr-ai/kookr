import { writeFile } from 'node:fs/promises';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../../adapters/codex-cli-adapter.js';
import { GrokBuildAdapter } from '../../adapters/grok-build-adapter.js';
import { GROK_BUILD_ENABLED_ENV } from '../../adapters/grok-launch-args.js';
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
  /** Grok Build binary path/command (`KOOKR_GROK_BIN`). Experimental — see below. */
  grokBin?: string;
  bypassAllPermissions?: boolean;
  /**
   * Env source for the experimental Grok Build feature flag / kill switch and
   * model resolution. Defaults to `process.env`; injectable for tests. The Grok
   * adapter is registered ONLY when `KOOKR_GROK_BUILD_ENABLED=true`, so default
   * deployments are byte-identical (no Grok preflight, no new-agent surface).
   */
  grokEnv?: NodeJS.ProcessEnv;
  preflightOnFatal?: (snapshot: AgentPreflightSnapshot & { status: 'absent' }) => never;
  preflightLogger?: PreflightLogger;
  /**
   * Live getter for the configured per-agent-type effort defaults (#681). Each
   * adapter receives a narrowed `resolveDefaultEffort` closure reading its own
   * entry, so an operator's settings change applies to the next launch — across
   * every launch path — without a restart. Omitted in tests that don't exercise
   * effort: adapters then pass no effort override; model selection remains
   * adapter-specific.
   */
  getAgentEffort?: () => AgentEffortMap;
}

export interface AgentRuntime {
  claudeCodeAdapter: ClaudeCodeAdapter;
  codexCliAdapter: CodexCliAdapter;
  /** Present only when the experimental Grok Build feature flag is enabled. */
  grokBuildAdapter?: GrokBuildAdapter;
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

  // Experimental Grok Build adapter (issue #1343). Registered ONLY when the
  // operator opts in via KOOKR_GROK_BUILD_ENABLED=true, so unrelated deployments
  // pay no Grok preflight cost and never see the new agent type. It is not added
  // to AVAILABLE_AGENT_TYPES, so it stays out of the frontend picker and the
  // round-robin rotation (Phase 1 excludes frontend selection); launches are
  // additionally guarded per-call by the same flag + a kill switch + build
  // qualification inside the adapter.
  const grokEnv = deps.grokEnv ?? process.env;
  let grokBuildAdapter: GrokBuildAdapter | undefined;
  if (grokEnv[GROK_BUILD_ENABLED_ENV] === 'true') {
    grokBuildAdapter = new GrokBuildAdapter(deps.terminalBackend, deps.taskStore, {
      terminalInputWriter,
      hooksDir: deps.hooksDir,
      serverPort: deps.serverPort,
      agentBin: deps.grokBin,
      bypassAllPermissions: deps.bypassAllPermissions,
      env: grokEnv,
    });
    adapterRegistry.register(grokBuildAdapter);
  }

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
    grokBuildAdapter,
    adapterRegistry,
    adapter,
    agentPreflight,
  };
}
