import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import type { TerminalBackend } from './terminal-backend.js';
import type { TaskStore } from '../core/tasks.js';
import type { AgentEvent } from '../core/types.js';
import type {
  AgentAdapter,
  AdapterLaunchOptions,
  EffectiveHookSettings,
  PreflightResult,
  ResumeContext,
} from './agent-adapter.js';
import { probeAgentBinary, type ProbeExecRunner } from './probe-agent-binary.js';
import { parseHookEvent } from '../core/hook-parser.js';
import { getGitInfo, isGitBranchCommand } from './git-info.js';
import { buildAgentLaunchContext } from './agent-launch-context.js';
import { resolveAndPrepareCheckpointDir, CHECKPOINT_LOAD_INSTRUCTION } from '../core/checkpoint-path.js';
import { translateKeystroke, ENTER_BYTES } from './keystroke.js';
import { effectiveHookSettingsPath, readPersistedHookSettings } from './effective-hook-settings.js';
import { loadFileBasedAgents, type InlineAgentDef } from './file-based-agents.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export interface HookSettings {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  permissions?: {
    allow: string[];
  };
}

export interface ClaudeCodeAdapterOptions {
  hooksDir?: string;
  settingsDir?: string;
  /** Write a file to disk. Injected so tests can skip real I/O. */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** Server port for HTTP push hook command. When set, hooks write to JSONL + POST to server. */
  serverPort?: number;
  /** Path or command name for the agent binary. Defaults to 'claude'. */
  agentBin?: string;
  /**
   * Opt-in: launch the agent with --dangerously-skip-permissions so the
   * spawned Claude Code bypasses all permission prompts. Defaults to false.
   */
  bypassAllPermissions?: boolean;
  /**
   * Kookr data directory (`~/.kookr` or `~/.kookr-<port>`). When provided,
   * each launched task gets a per-(repo, branch) checkpoint directory under
   * `<kookrDataDir>/checkpoints/...` and `KOOKR_CHECKPOINT_DIR` is injected
   * into the spawned agent's environment. Without this, checkpointing is
   * silently disabled (fail-open).
   */
  kookrDataDir?: string;
  /**
   * Absolute path to the kookr-toolkit plugin tree (containing
   * `.claude-plugin/plugin.json`). When set and the path is valid, the
   * adapter passes `--plugin-dir <path>` to every spawned `claude` so
   * Kookr-spawned agents see the toolkit regardless of cwd.
   *
   * Resolution order: this option > `KOOKR_PLUGIN_DIR` env > auto-resolved
   * relative to the adapter's compiled location. Empty string disables
   * injection. See `resolvePluginDir()`.
   */
  pluginDir?: string;
  /**
   * Test seam for {@link ClaudeCodeAdapter.preflight}. When provided, the
   * adapter spawns probes through this runner instead of `child_process.execFile`.
   * Production callers should leave this unset.
   */
  probeExec?: ProbeExecRunner;
  /**
   * Test seam for the file-based-agents loader. When provided, replaces the
   * default {@link loadFileBasedAgents} call so tests can inject synthetic
   * agent maps without touching `~/.claude/agents` or the cwd.
   */
  loadFileBasedAgents?: (cwd: string) => Record<string, InlineAgentDef>;
}

/** Env var that overrides the default Claude Code binary path. */
export const CLAUDE_AGENT_BIN_ENV = 'KOOKR_AGENT_BIN';

// Re-exported here so legacy `import { resolvePluginDir } from '...claude-code-adapter.js'`
// keeps working. Source of truth lives in core/plugin-paths to allow other
// layers (core/playbook-discovery) to share the same resolution logic.
import { resolvePluginDir } from '../core/plugin-paths.js';
export { resolvePluginDir } from '../core/plugin-paths.js';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentType = 'claude-code';
  private eventHandlers: Array<(tmuxName: string, event: AgentEvent) => void> = [];
  private refreshHandlers: Array<() => void> = [];
  private settingsMap = new Map<string, HookSettings>();
  private tmuxToTaskId = new Map<string, string>();
  private hooksDir: string;
  private settingsDir: string;
  private writeFile?: (path: string, content: string) => Promise<void>;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private bypassAllPermissions: boolean;
  private kookrDataDir?: string;
  private pluginDir?: string;
  private probeExec?: ProbeExecRunner;
  private loadAgents: (cwd: string) => Record<string, InlineAgentDef>;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: ClaudeCodeAdapterOptions,
  ) {
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.settingsDir = options?.settingsDir ?? '~/.kookr/settings';
    this.writeFile = options?.writeFile;
    this.serverPort = options?.serverPort;
    this.agentBin = options?.agentBin ?? 'claude';
    this.agentBinConfiguredVia = options?.agentBin ? 'env' : 'default';
    this.bypassAllPermissions = options?.bypassAllPermissions ?? false;
    this.kookrDataDir = options?.kookrDataDir;
    this.pluginDir = resolvePluginDir(options?.pluginDir);
    this.probeExec = options?.probeExec;
    this.loadAgents = options?.loadFileBasedAgents ?? ((cwd) => loadFileBasedAgents(cwd));
  }

  async preflight(): Promise<PreflightResult> {
    const probe = await probeAgentBinary(this.agentBin, { exec: this.probeExec });
    if (probe.kind === 'ok') return probe;
    return {
      kind: 'absent',
      reason: probe.reason,
      configuredVia: this.agentBinConfiguredVia,
      envVarName: CLAUDE_AGENT_BIN_ENV,
    };
  }

  /**
   * Launch a Claude Code agent under the dtach backend.
   * Returns the session id (historically called `tmuxName`).
   */
  async launch(taskId: string, prompt: string, cwd: string, resume?: ResumeContext, opts?: AdapterLaunchOptions): Promise<string> {
    const tmuxName = opts?.tmuxName ?? `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    // Resolve per-(repo, branch) checkpoint dir if data dir is configured.
    // Returns null on any failure — fail-open so checkpoint problems never
    // break task launch. See docs/poc/005-checkpoint-cycle-mechanics.md.
    const checkpointDir = this.kookrDataDir
      ? (await resolveAndPrepareCheckpointDir({ cwd, kookrDataDir: this.kookrDataDir })) ?? undefined
      : undefined;

    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
      checkpointDir,
    });

    // Generate hook settings
    const settings = this.generateSettings(tmuxName, this.hooksDir, launchContext.permissionAllowlist);
    this.settingsMap.set(tmuxName, settings);

    // Write settings file to disk if writeFile is available (production)
    const settingsPath = `${this.settingsDir}/${tmuxName}.json`;
    if (this.writeFile) {
      await this.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    // Decide resume vs fresh. Resume requires a sessionId; if a transcriptPath
    // is also supplied, verify the file exists before passing the flag (the CLI
    // would otherwise error opaquely). See rfc-crash-recovery-resume.md.
    const useResume =
      !!resume?.sessionId &&
      (!resume.transcriptPath || (await fileExists(resume.transcriptPath)));

    // Argv-based launch — zero shell features needed per docs/spikes/argv-audit.md.
    // Env lives in SessionSpec.env; each flag and the prompt are argv entries.
    // --dangerously-skip-permissions is conditional on opt-in via
    // KOOKR_BYPASS_ALL_PERMISSIONS=true. --append-system-prompt is conditional
    // on checkpointing being wired (see docs/poc/005-checkpoint-cycle-mechanics.md).
    const args: string[] = [];
    if (this.bypassAllPermissions) {
      // --dangerously-skip-permissions + --setting-sources '' are both required:
      // ask-rules in user settings would otherwise match before bypass mode is
      // consulted. See docs/poc/006-bypass-permissions-ask-rule-override.md.
      args.push('--dangerously-skip-permissions');
      args.push('--setting-sources', '');
      // --setting-sources '' also strips file-based agent discovery from
      // ~/.claude/agents and <cwd>/.claude/agents. Re-inject those agents
      // inline so they survive bypass mode without losing their original
      // names. See docs/poc/007-bypass-keeps-file-based-agents.md.
      const agents = this.loadAgents(cwd);
      if (Object.keys(agents).length > 0) {
        args.push('--agents', JSON.stringify(agents));
      }
    }
    if (this.pluginDir) args.push('--plugin-dir', this.pluginDir);
    if (useResume) {
      // --fork-session creates a new sessionId for the resumed branch so the
      // user's pre-crash transcript is preserved as a read-only snapshot.
      // No --append-system-prompt or prompt arg: the resumed conversation
      // already contains the original prompt and any checkpoint context.
      args.push('--resume', resume!.sessionId, '--fork-session');
      args.push('--settings', settingsPath);
    } else {
      if (checkpointDir) args.push('--append-system-prompt', CHECKPOINT_LOAD_INSTRUCTION);
      args.push('--settings', settingsPath, prompt);
    }

    await this.backend.createSession({
      id: tmuxName,
      command: this.agentBin,
      args,
      env: { ...launchContext.env, ...(opts?.extraEnv ?? {}) },
      cwd,
      size: { cols: 200, rows: 50 },
    });

    // Register session with task store
    this.taskStore.addSession(taskId, {
      tmuxSession: tmuxName,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
    });

    // Fire-and-forget: capture git context from CWD
    getGitInfo(cwd)
      .then((info) => {
        if (info) {
          this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
          // Trigger a snapshot broadcast so the frontend picks up git info.
          // Uses refreshHandlers (not eventHandlers) to avoid injecting a
          // spurious input_received event that could clear anomaly state.
          for (const handler of this.refreshHandlers) {
            handler();
          }
        }
      })
      .catch(() => { /* graceful degradation — no git info displayed */ });

    return tmuxName;
  }

  /** Send developer input (text + Enter) to an agent's session. */
  async sendInput(tmuxName: string, text: string): Promise<void> {
    await this.backend.writeSequence(tmuxName, [
      textEncoder.encode(text),
      ENTER_BYTES,
    ]);
  }

  /** Send a single keystroke without trailing Enter (for permission prompts). */
  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.backend.write(tmuxName, translateKeystroke(key));
  }

  /** Stop an agent by killing its session. */
  async stop(tmuxName: string): Promise<void> {
    await this.backend.killSession(tmuxName);
    this.settingsMap.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
  }

  /** Capture the current terminal display as a decoded string. */
  async captureDisplay(tmuxName: string): Promise<string> {
    const bytes = await this.backend.captureBytes(tmuxName);
    return textDecoder.decode(bytes);
  }

  /**
   * Register an event handler for AgentEvents from hook events.
   */
  onEvent(handler: (tmuxName: string, event: AgentEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Register a handler called when metadata changes (e.g. git info) require
   * a snapshot broadcast but no AgentEvent should be emitted.
   */
  onRefreshNeeded(handler: () => void): void {
    this.refreshHandlers.push(handler);
  }

  /**
   * Inject a raw hook event (for testing or from hook file tailing).
   * Parses the JSON, emits the AgentEvent, and updates session metadata.
   * Detects CWD changes and git commands to refresh git info.
   */
  injectHookEvent(tmuxName: string, rawJson: string): void {
    const event = parseHookEvent(rawJson);
    if (!event) return; // Unknown hook type — silently skip
    const taskId = this.tmuxToTaskId.get(tmuxName);

    // Update session metadata on SessionStart
    if (event.type === 'session_start' && taskId) {
      this.taskStore.updateSession(taskId, tmuxName, {
        claudeSessionId: event.sessionId,
        transcriptPath: event.transcriptPath,
      });
    }

    // Detect CWD changes and git commands to refresh git info
    if (taskId && 'cwd' in event && event.cwd) {
      const task = this.taskStore.getTask(taskId);
      const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) {
        let shouldRefreshGit = false;

        // Trigger 1: CWD changed — agent moved to a different directory
        if (event.cwd !== session.cwd) {
          this.taskStore.updateSessionCwd(taskId, tmuxName, event.cwd);
          shouldRefreshGit = true;
        }

        // Trigger 2: Git command detected — branch may have changed in same directory
        if (event.type === 'tool_result' && event.toolName === 'Bash' && isGitBranchCommand(event.toolResponse)) {
          shouldRefreshGit = true;
        }
        if (event.type === 'tool_use' && event.toolName === 'Bash' && isGitBranchCommand(event.toolInput)) {
          shouldRefreshGit = true;
        }

        if (shouldRefreshGit) {
          const currentCwd = event.cwd;
          getGitInfo(currentCwd)
            .then((info) => {
              if (info) {
                this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
              }
            })
            .catch(() => { /* graceful degradation */ });
        }
      }
    }

    // Emit to all handlers with tmuxName for routing
    for (const handler of this.eventHandlers) {
      handler(tmuxName, event);
    }
  }

  /**
   * Get the generated settings for a tmux session (for testing).
   */
  getGeneratedSettings(tmuxName: string): HookSettings | undefined {
    return this.settingsMap.get(tmuxName);
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    const content = this.settingsMap.get(tmuxName) ?? readPersistedHookSettings(this.settingsDir, tmuxName);
    if (!content) return undefined;
    const settingsPath = effectiveHookSettingsPath(this.settingsDir, tmuxName);
    if (!settingsPath) return undefined;
    return {
      content,
      agentType: this.agentType,
      settingsPath,
    };
  }

  private generateSettings(tmuxName: string, hookOutputDir: string, permissionAllowlist: string[]): HookSettings {
    const hookFile = `${hookOutputDir}/${tmuxName}.jsonl`;

    // When serverPort is set, dual-write: JSONL file (durable) + HTTP POST (fast).
    // tee reads stdin (the hook event JSON) and appends to the JSONL file, then
    // pipes the same data to curl for immediate HTTP delivery.
    // IMPORTANT: no trailing `&` — Claude Code runs hooks via non-interactive bash,
    // and `bash -c 'cmd &'` redirects stdin from /dev/null, so tee would read nothing.
    // curl's --max-time 1 prevents blocking Claude Code if the server is slow.
    let hookCommand: string;
    if (this.serverPort) {
      const url = `http://localhost:${this.serverPort}/api/hook-event/${tmuxName}`;
      hookCommand = `tee -a ${hookFile} | curl -s -X POST ${url} --max-time 1 -H 'Content-Type: application/json' -d @- >/dev/null 2>&1`;
    } else {
      hookCommand = `cat >> ${hookFile}`;
    }

    const cmd = { type: 'command', command: hookCommand };
    return {
      hooks: {
        // Tool-name matchers — '*' matches all tool names
        SessionStart: [{ matcher: '*', hooks: [cmd] }],
        PreToolUse: [{ matcher: '*', hooks: [cmd] }],
        PostToolUse: [{ matcher: '*', hooks: [cmd] }],
        PostToolUseFailure: [{ matcher: '*', hooks: [cmd] }],
        PermissionRequest: [{ matcher: '*', hooks: [cmd] }],
        // No-matcher hooks — '' fires unconditionally
        Stop: [{ matcher: '', hooks: [cmd] }],
        StopFailure: [{ matcher: '', hooks: [cmd] }],
        Notification: [{ matcher: '', hooks: [cmd] }],
        UserPromptSubmit: [{ matcher: '', hooks: [cmd] }],
        SubagentStart: [{ matcher: '', hooks: [cmd] }],
        SubagentStop: [{ matcher: '', hooks: [cmd] }],
        SessionEnd: [{ matcher: '', hooks: [cmd] }],
      },
      permissions: permissionAllowlist.length > 0 ? { allow: permissionAllowlist } : undefined,
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
