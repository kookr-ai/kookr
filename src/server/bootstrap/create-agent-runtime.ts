import { writeFile } from 'node:fs/promises';

import { AdapterRegistry, type AgentAdapter } from '../../adapters/agent-adapter.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code-adapter.js';
import { CodexCliAdapter } from '../../adapters/codex-cli-adapter.js';
import { GrokBuildAdapter } from '../../adapters/grok-build-adapter.js';
import type { GrokInstalledState } from '../../adapters/grok-build-preflight.js';
import type { ProbeExecRunner } from '../../adapters/probe-agent-binary.js';
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
  /** Grok Build binary path/command (`KOOKR_GROK_BIN`). */
  grokBin?: string;
  bypassAllPermissions?: boolean;
  /**
   * Env source for the Grok Build kill switch and model resolution. Defaults
   * to `process.env`; injectable for tests.
   */
  grokEnv?: NodeJS.ProcessEnv;
  /** Test seam: probe runner for the Grok binary-identity preflight. */
  grokProbeExec?: ProbeExecRunner;
  /** Test seam: bypass the Grok binary probe with a fixed installed state. */
  grokInstalledState?: GrokInstalledState;
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
  /** Always constructed; registered (and thus launchable) only when its binary preflight passed. */
  grokBuildAdapter: GrokBuildAdapter;
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

  // Grok Build adapter (issue #1343, GA). Registered by default like the other
  // agents — but ONLY when its binary is actually present: registration is what
  // feeds the frontend picker and the round-robin rotation
  // (AVAILABLE_AGENT_TYPES ∩ registry), and a registered-but-absent grok would
  // put a guaranteed-failing slot into the rotation (the cursor only advances
  // on successful launches, so it would wedge there). A missing default binary
  // therefore degrades to a warn-and-skip; an explicitly configured
  // KOOKR_GROK_BIN that is unreachable stays fail-loud, matching
  // runAdapterPreflights' env-misconfig policy. New launches can be halted
  // operationally via the KOOKR_GROK_BUILD_DISABLE_NEW_LAUNCHES kill switch,
  // and build qualification against the reviewed compatibility manifest is
  // advisory supervision status inside the adapter.
  const grokEnv = deps.grokEnv ?? process.env;
  const grokBuildAdapter = new GrokBuildAdapter(deps.terminalBackend, deps.taskStore, {
    terminalInputWriter,
    hooksDir: deps.hooksDir,
    serverPort: deps.serverPort,
    agentBin: deps.grokBin,
    bypassAllPermissions: deps.bypassAllPermissions,
    env: grokEnv,
    probeExec: deps.grokProbeExec,
    installedStateOverride: deps.grokInstalledState,
  });
  const preflightLogger = deps.preflightLogger ?? console;
  const grokPreflight = await grokBuildAdapter.preflight();
  if (grokPreflight.kind === 'ok') {
    adapterRegistry.register(grokBuildAdapter);
  } else if (grokPreflight.configuredVia === 'env') {
    preflightLogger.error(
      `[fatal] grok-build binary unreachable: ${grokPreflight.reason}\n` +
        `  Set ${grokPreflight.envVarName}=<path> or unset it to fall back to PATH.`,
    );
    (deps.preflightOnFatal ?? ((): never => process.exit(1)))({
      agentType: 'grok-build',
      status: 'absent',
      reason: grokPreflight.reason,
      configuredVia: grokPreflight.configuredVia,
      envVarName: grokPreflight.envVarName,
    });
  } else {
    preflightLogger.warn(
      `[startup] warning: grok binary not found on PATH (${grokPreflight.reason}); ` +
        `grok-build is not registered — it stays out of the agent picker and round-robin.`,
    );
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
