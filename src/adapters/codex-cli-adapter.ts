import { randomUUID } from 'node:crypto';
import type { TerminalBackend } from './terminal-backend.js';
import type { TaskStore } from '../core/tasks.js';
import type { AgentEvent } from '../core/types.js';
import type { AgentAdapter, AdapterLaunchOptions, EffectiveHookSettings, PreflightResult } from './agent-adapter.js';
import { probeAgentBinary, type ProbeExecRunner } from './probe-agent-binary.js';
import { parseHookEvent } from '../core/hook-parser.js';
import { getGitInfo, isGitBranchCommand } from './git-info.js';
import { buildAgentLaunchContext } from './agent-launch-context.js';
import { ensureCodexWorkspaceTrusted } from './codex-config.js';
import { resolveAndPrepareCheckpointDir, CHECKPOINT_LOAD_INSTRUCTION } from '../core/checkpoint-path.js';
import { translateKeystroke, ENTER_BYTES } from './keystroke.js';
import { effectiveHookSettingsPath, readPersistedHookSettings } from './effective-hook-settings.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

interface CodexHookSettings {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  permissions?: {
    allow: string[];
  };
}

const CODEX_HOOK_SUBSCRIPTIONS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionEnd',
] as const;

export interface CodexCliAdapterOptions {
  hooksDir?: string;
  settingsDir?: string;
  writeFile?: (path: string, content: string) => Promise<void>;
  serverPort?: number;
  /** Path or command name for the Codex CLI binary. Defaults to 'codex'. */
  agentBin?: string;
  /** Override the Codex config path used for workspace trust management. */
  codexConfigPath?: string;
  /** Disable the pre-trust step. Intended for tests only. */
  trustWorkspace?: boolean;
  /**
   * Opt-in: launch Codex with --dangerously-bypass-approvals-and-sandbox
   * instead of --full-auto, so the spawned agent bypasses both approvals
   * and the sandbox. Defaults to false.
   */
  bypassAllPermissions?: boolean;
  /**
   * Kookr data directory (`~/.kookr` or `~/.kookr-<port>`). When provided,
   * each launched task gets a per-(repo, branch) checkpoint directory under
   * `<kookrDataDir>/checkpoints/...`. Without this, checkpointing is silently
   * disabled (fail-open).
   */
  kookrDataDir?: string;
  /**
   * Test seam for {@link CodexCliAdapter.preflight}. When provided, the
   * adapter spawns probes through this runner instead of `child_process.execFile`.
   * Production callers should leave this unset.
   */
  probeExec?: ProbeExecRunner;
}

/** Env var that overrides the default Codex CLI binary path. */
export const CODEX_AGENT_BIN_ENV = 'KOOKR_CODEX_BIN';

/**
 * Adapter for OpenAI Codex CLI agent.
 *
 * Codex CLI's hook payload format is nearly identical to Claude Code's:
 * same hook_event_name values (SessionStart, PreToolUse, PostToolUse, Stop,
 * UserPromptSubmit, PermissionRequest), same field structure (session_id,
 * cwd, tool_name, tool_input). The main differences:
 *
 * - Kookr subscribes Codex to a widened Claude-compatible event set. Older
 *   Codex builds ignore unknown hook groups; newer builds advertise support in
 *   SessionStart so Kookr can distinguish legacy mode from real capability.
 * - Extra fields: turn_id, model, permission_mode (ignored by our parser)
 * - Hook config injected via --settings flag (same format as Claude Code)
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly agentType = 'codex-cli';
  private eventHandlers: Array<(tmuxName: string, event: AgentEvent) => void> = [];
  private refreshHandlers: Array<() => void> = [];
  private settingsMap = new Map<string, CodexHookSettings>();
  private tmuxToTaskId = new Map<string, string>();
  private hooksDir: string;
  private settingsDir: string;
  private writeFile?: (path: string, content: string) => Promise<void>;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private codexConfigPath?: string;
  private trustWorkspace: boolean;
  private bypassAllPermissions: boolean;
  private kookrDataDir?: string;
  private probeExec?: ProbeExecRunner;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: CodexCliAdapterOptions,
  ) {
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.settingsDir = options?.settingsDir ?? '~/.kookr/settings';
    this.writeFile = options?.writeFile;
    this.serverPort = options?.serverPort;
    this.agentBin = options?.agentBin ?? 'codex';
    this.agentBinConfiguredVia = options?.agentBin ? 'env' : 'default';
    this.codexConfigPath = options?.codexConfigPath;
    this.trustWorkspace = options?.trustWorkspace ?? true;
    this.bypassAllPermissions = options?.bypassAllPermissions ?? false;
    this.kookrDataDir = options?.kookrDataDir;
    this.probeExec = options?.probeExec;
  }

  async preflight(): Promise<PreflightResult> {
    const probe = await probeAgentBinary(this.agentBin, { exec: this.probeExec });
    if (probe.kind === 'ok') return probe;
    return {
      kind: 'absent',
      reason: probe.reason,
      configuredVia: this.agentBinConfiguredVia,
      envVarName: CODEX_AGENT_BIN_ENV,
    };
  }

  async launch(taskId: string, prompt: string, cwd: string, resume?: import('./agent-adapter.js').ResumeContext, _opts?: AdapterLaunchOptions): Promise<string> {
    if (resume?.sessionId) {
      // Codex resume is deferred until the Codex fork emits hooks reliably;
      // without hooks, claudeSessionId is never populated for Codex sessions
      // and there is nothing to resume by. Ignoring the hint and launching
      // fresh keeps the universal adapter signature consistent.
      // See docs/rfc/rfc-crash-recovery-resume.md "Codex deferral".
      console.warn(
        `[codex-adapter] Ignoring resume request for ${taskId}: ` +
        `Codex resume is deferred until the Codex fork emits hooks ` +
        `(see docs/rfc/rfc-crash-recovery-resume.md). Launching fresh.`,
      );
    }
    const tmuxName = `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    // Resolve per-(repo, branch) checkpoint dir if configured. Fail-open.
    // See docs/poc/005-checkpoint-cycle-mechanics.md.
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

    // Generate hook settings (same format as Claude Code --settings)
    const settings = this.generateSettings(tmuxName, this.hooksDir, launchContext.permissionAllowlist);
    this.settingsMap.set(tmuxName, settings);
    const settingsPath = `${this.settingsDir}/${tmuxName}.json`;
    if (this.writeFile) {
      await this.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    }

    if (this.trustWorkspace) {
      await ensureCodexWorkspaceTrusted(cwd, {
        configPath: this.codexConfigPath,
      });
    }

    // Build the Codex CLI command.
    //
    // Codex CLI does not (yet) expose `--append-system-prompt`. To inject the
    // v5 checkpoint-load instruction we prepend it to the user prompt when
    // checkpointing is wired. Note: this is lossier than the Claude Code path
    // because the prefix lives in the conversation history (which can be
    // summarized away by /compact). Inter-session resume still works (each
    // new task gets the prefix again on launch). Intra-session post-compact
    // resume on Codex CLI is a known v1 gap — fix in a fork patch later.
    const checkpointPrefix = checkpointDir ? `${CHECKPOINT_LOAD_INSTRUCTION}\n\n` : '';
    const promptWithCheckpoint = `${checkpointPrefix}${prompt}`;
    const permissionFlagStr = this.bypassAllPermissions
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    // V8: argv-based launch through the backend. No shell features needed;
    // env goes in SessionSpec.env, each flag and the prompt become argv.
    const args = [
      '-c', 'features.codex_hooks=true',
      permissionFlagStr,
      '--settings', settingsPath,
      promptWithCheckpoint,
    ];
    await this.backend.createSession({
      id: tmuxName,
      command: this.agentBin,
      args,
      env: launchContext.env,
      cwd,
      size: { cols: 200, rows: 50 },
    });

    this.taskStore.addSession(taskId, {
      tmuxSession: tmuxName,
      agentType: 'codex-cli',
      cwd,
      createdAt: new Date(),
    });

    // Fire-and-forget: capture git context
    getGitInfo(cwd)
      .then((info) => {
        if (info) {
          this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
          for (const handler of this.refreshHandlers) {
            handler();
          }
        }
      })
      .catch(() => { /* graceful degradation */ });

    return tmuxName;
  }

  async sendInput(tmuxName: string, text: string): Promise<void> {
    // Codex TUI uses bracketed-paste heuristics to distinguish "pasted
    // multi-line text" from "typed + Enter submit." Collapsing text+Enter
    // into one write(bytes + '\r') risks Codex classifying the entire blob
    // as paste and NOT submitting. `writeSequence` keeps the two-syscall
    // split under one mutex acquisition, so concurrent writers can't
    // interleave but Codex's heuristic still sees two distinct writes.
    await this.backend.writeSequence(tmuxName, [textEncoder.encode(text), ENTER_BYTES]);
  }

  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.backend.write(tmuxName, translateKeystroke(key));
  }

  async stop(tmuxName: string): Promise<void> {
    await this.backend.killSession(tmuxName);
    this.settingsMap.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
  }

  async captureDisplay(tmuxName: string): Promise<string> {
    const bytes = await this.backend.captureBytes(tmuxName);
    return textDecoder.decode(bytes);
  }

  onEvent(handler: (tmuxName: string, event: AgentEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onRefreshNeeded(handler: () => void): void {
    this.refreshHandlers.push(handler);
  }

  /**
   * Inject a raw hook event. Codex CLI's hook payloads use the same
   * hook_event_name values and field structure as Claude Code, so
   * we reuse parseHookEvent directly.
   */
  injectHookEvent(tmuxName: string, rawJson: string): void {
    const event = parseHookEvent(rawJson);
    if (!event) return;
    const taskId = this.tmuxToTaskId.get(tmuxName);

    // Update session metadata on SessionStart
    if (event.type === 'session_start' && taskId) {
      this.taskStore.updateSession(taskId, tmuxName, {
        claudeSessionId: event.sessionId,
        transcriptPath: event.transcriptPath,
        codexHookCapabilities: event.codexHookCapabilities,
      });
    }

    // Detect CWD changes and git commands to refresh git info
    if (taskId && 'cwd' in event && event.cwd) {
      const task = this.taskStore.getTask(taskId);
      const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) {
        let shouldRefreshGit = false;

        if (event.cwd !== session.cwd) {
          this.taskStore.updateSessionCwd(taskId, tmuxName, event.cwd);
          shouldRefreshGit = true;
        }

        if (event.type === 'tool_result' && event.toolName === 'Bash' && isGitBranchCommand(event.toolResponse)) {
          shouldRefreshGit = true;
        }
        if (event.type === 'tool_use' && event.toolName === 'Bash' && isGitBranchCommand(event.toolInput)) {
          shouldRefreshGit = true;
        }

        if (shouldRefreshGit) {
          getGitInfo(event.cwd)
            .then((info) => {
              if (info) {
                this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
              }
            })
            .catch(() => { /* graceful degradation */ });
        }
      }
    }

    for (const handler of this.eventHandlers) {
      handler(tmuxName, event);
    }
  }

  getGeneratedSettings(tmuxName: string): CodexHookSettings | undefined {
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

  /**
   * Generate settings for --settings flag.
   * Uses the same format as Claude Code: { hooks: { EventName: [{ matcher, hooks }] } }
   * Use the widened compatibility surface. Older Codex builds silently ignore
   * unknown hook groups, which keeps mixed-version rollout safe.
   */
  private generateSettings(tmuxName: string, hookOutputDir: string, permissionAllowlist: string[]): CodexHookSettings {
    const hookFile = `${hookOutputDir}/${tmuxName}.jsonl`;

    let hookCommand: string;
    if (this.serverPort) {
      const url = `http://localhost:${this.serverPort}/api/hook-event/${tmuxName}`;
      hookCommand = `tee -a ${hookFile} | curl -s -X POST ${url} --max-time 1 -H 'Content-Type: application/json' -d @- >/dev/null 2>&1`;
    } else {
      hookCommand = `cat >> ${hookFile}`;
    }

    const cmd = { type: 'command', command: hookCommand };
    /** Events whose matchers require a tool-name glob ('*'); all others use ''. */
    const TOOL_MATCHER_EVENTS = new Set([
      'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'Notification', 'PermissionRequest',
    ]);
    const hooks = Object.fromEntries(
      CODEX_HOOK_SUBSCRIPTIONS.map((eventName) => [
        eventName,
        [{ matcher: TOOL_MATCHER_EVENTS.has(eventName) ? '*' : '', hooks: [cmd] }],
      ]),
    );

    return {
      hooks,
      permissions: permissionAllowlist.length > 0 ? { allow: permissionAllowlist } : undefined,
    };
  }
}
