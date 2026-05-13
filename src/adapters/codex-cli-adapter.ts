import { randomUUID } from 'node:crypto';
import type { TerminalBackend } from './terminal-backend.js';
import type { TaskStore } from '../core/tasks.js';
import type {
  AgentEvent,
  EventMeta,
  EventParentage,
  InjectHookEventResult,
} from '../core/types.js';
import type {
  AdapterEventHandler,
  AgentAdapter,
  AdapterLaunchOptions,
  EffectiveHookSettings,
  PreflightResult,
} from './agent-adapter.js';
import { probeAgentBinary, probeBinaryFlagSupport, type ProbeExecRunner } from './probe-agent-binary.js';
import { extractRawHookHeader, parseHookEvent, HookParseError } from '../core/hook-parser.js';
import {
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
  type SessionRuntimeIdentity,
} from '../core/hook-parentage.js';
import { getGitInfo, isGitBranchCommand } from './git-info.js';
import { buildAgentLaunchContext } from './agent-launch-context.js';
import { ensureCodexWorkspaceTrusted } from './codex-config.js';
import { resolvePluginDir } from '../core/plugin-paths.js';
import { buildCheckpointLoadInstruction, resolveAndPrepareCheckpointDir } from '../core/checkpoint-path.js';
import { translateKeystroke, ENTER_BYTES } from './keystroke.js';
import { effectiveHookSettingsPath, readPersistedHookSettings } from './effective-hook-settings.js';
import { buildHookCommand, resolveHookWriterPath } from '../core/hook-writer-paths.js';

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
   * Absolute path to the kookr-toolkit plugin tree (containing
   * `.claude-plugin/plugin.json`). When the configured codex binary
   * advertises `--plugin-dir` in its `--help` output, the adapter passes
   * `--plugin-dir <path>` to every spawned `codex` so kookr-spawned agents
   * see the toolkit regardless of cwd.
   *
   * Resolution order: this option > `KOOKR_PLUGIN_DIR` env > auto-resolved
   * `<repo-root>/plugin`. Empty string disables. Mirrors the
   * `ClaudeCodeAdapter.pluginDir` option semantically.
   *
   * Capability gate: at first launch the adapter probes
   * `<bin> --help` for the `--plugin-dir` substring. Stock codex (no
   * jeanibarz/codex#52) doesn't have the flag, so injection is silently
   * skipped — the binary itself is the source of truth, no env var or
   * version check needed for the dev to opt in. Kookr-fork codex starts
   * working automatically once `pnpm codex:rebuild` installs a binary
   * that advertises the flag.
   */
  pluginDir?: string;
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
  private eventHandlers: Array<AdapterEventHandler> = [];
  private refreshHandlers: Array<() => void> = [];
  private settingsMap = new Map<string, CodexHookSettings>();
  private tmuxToTaskId = new Map<string, string>();
  /** In-memory parentage view per Kookr session; hydrated lazily from SessionInfo. */
  private identities = new Map<string, SessionRuntimeIdentity>();
  /** Kookr-assigned monotonic sequence per Kookr session. */
  private sequenceCounters = new Map<string, number>();
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
  private pluginDir?: string;
  private pluginDirSupportProbe?: Promise<boolean>;
  private warnedAboutMissingPluginDirSupport = false;
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
    // Mirror ClaudeCodeAdapter: auto-discover the kookr-toolkit plugin tree
    // from the compiled module location. The runtime --plugin-dir capability
    // probe (run lazily at first launch) gates whether we actually inject,
    // so onboarding devs don't have to set any env var even before the
    // codex-fork supporting --plugin-dir lands. See `probePluginDirSupport`.
    this.pluginDir = resolvePluginDir(options?.pluginDir);
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

  /**
   * Memoized capability probe: does this codex binary advertise `--plugin-dir`
   * in its `--help` output? Caches the Promise so concurrent first-launches
   * share the work. Lazy — only spawns the probe subprocess when the adapter
   * actually has a plugin tree to inject.
   */
  private probePluginDirSupport(): Promise<boolean> {
    if (this.pluginDirSupportProbe === undefined) {
      this.pluginDirSupportProbe = probeBinaryFlagSupport(
        this.agentBin,
        '--plugin-dir',
        { exec: this.probeExec },
      );
    }
    return this.pluginDirSupportProbe;
  }

  async launch(taskId: string, prompt: string, cwd: string, resume?: import('./agent-adapter.js').ResumeContext, opts?: AdapterLaunchOptions): Promise<string> {
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
    const checkpointInstruction = checkpointDir
      ? await buildCheckpointLoadInstruction(checkpointDir)
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
    const checkpointPrefix = checkpointInstruction ? `${checkpointInstruction}\n\n` : '';
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
    ];
    // Inject --plugin-dir <path> when (a) the kookr-toolkit tree resolves
    // and (b) the configured codex binary actually supports the flag. The
    // capability probe runs once per adapter instance, lazily, so cold start
    // pays a single `codex --help` invocation. Stock codex returns help
    // without the flag → injection is skipped silently. Kookr-fork codex
    // (jeanibarz/codex#52) advertises the flag → injection is automatic
    // with no env var setup.
    if (this.pluginDir) {
      const supported = await this.probePluginDirSupport();
      if (supported) {
        args.push('--plugin-dir', this.pluginDir);
      } else if (!this.warnedAboutMissingPluginDirSupport) {
        this.warnedAboutMissingPluginDirSupport = true;
        console.warn(
          `[codex-cli-adapter] codex binary "${this.agentBin}" does not advertise --plugin-dir; ` +
          `kookr-toolkit skills won't be loaded by spawned codex sessions. ` +
          `Run \`pnpm codex:rebuild\` from kookr to install the kookr-fork (jeanibarz/codex#52).`,
        );
      }
    }
    args.push(promptWithCheckpoint);
    await this.backend.createSession({
      id: tmuxName,
      command: this.agentBin,
      args,
      env: { ...launchContext.env, ...(opts?.extraEnv ?? {}) },
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

  onEvent(handler: AdapterEventHandler): void {
    this.eventHandlers.push(handler);
  }

  onRefreshNeeded(handler: () => void): void {
    this.refreshHandlers.push(handler);
  }

  /**
   * Inject a raw hook event. Codex CLI's hook payloads use the same
   * hook_event_name values and field structure as Claude Code, so we
   * reuse parseHookEvent directly. Parentage is classified before any
   * task-metadata mutation; only the first parent SessionStart sets
   * claudeSessionId / transcriptPath. NEVER throws on malformed payloads —
   * returns parseStatus='malformed' so HookIngestion can record a
   * diagnostic ledger row. See rfc-activity-log-reliability §2.
   */
  injectHookEvent(tmuxName: string, rawJson: string, externalSequence?: number): InjectHookEventResult {
    const observedAt = Date.now();
    const observedAtIso = new Date(observedAt).toISOString();

    let header: { rawSessionId?: string; rawTurnId?: string; rawHookEventName?: string };
    try {
      header = extractRawHookHeader(rawJson);
    } catch (err) {
      const reason = err instanceof HookParseError ? err.message : String(err);
      return { parseStatus: 'malformed', agentType: this.agentType, error: reason };
    }

    let event: AgentEvent | null;
    try {
      event = parseHookEvent(rawJson);
    } catch (err) {
      const reason = err instanceof HookParseError ? err.message : String(err);
      return {
        parseStatus: 'malformed',
        agentType: this.agentType,
        rawSessionId: header.rawSessionId,
        rawTurnId: header.rawTurnId,
        rawHookEventName: header.rawHookEventName,
        error: reason,
      };
    }
    if (!event) {
      return {
        parseStatus: 'dropped',
        agentType: this.agentType,
        rawSessionId: header.rawSessionId,
        rawTurnId: header.rawTurnId,
        rawHookEventName: header.rawHookEventName,
        parentage: 'unknown',
      };
    }

    const taskId = this.tmuxToTaskId.get(tmuxName)
      ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (taskId && !this.tmuxToTaskId.has(tmuxName)) {
      this.tmuxToTaskId.set(tmuxName, taskId);
    }
    const rawSessionId = 'sessionId' in event ? event.sessionId : header.rawSessionId;

    const identity = this.getOrHydrateIdentity(tmuxName, taskId);

    let parentage: EventParentage;
    if (event.type === 'session_start' && rawSessionId) {
      parentage = recordSessionStart(identity, rawSessionId, event.transcriptPath, observedAtIso);
      if (taskId) {
        if (parentage === 'parent') {
          const task = this.taskStore.getTask(taskId);
          const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
          if (session && !session.claudeSessionId) {
            this.taskStore.updateSession(taskId, tmuxName, {
              claudeSessionId: event.sessionId,
              transcriptPath: event.transcriptPath,
              codexHookCapabilities: event.codexHookCapabilities,
            });
          }
        } else if (parentage === 'child') {
          this.taskStore.recordChildSession(taskId, tmuxName, rawSessionId, {
            firstSeenAt: observedAtIso,
            transcriptPath: event.transcriptPath,
            reason: 'inherited_settings',
          });
        }
      }
    } else {
      parentage = classifyHookParentage(rawSessionId, identity);
    }

    if (parentage === 'parent' && taskId && 'cwd' in event && event.cwd) {
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

    const sequence = externalSequence ?? (this.sequenceCounters.get(tmuxName) ?? 0) + 1;
    this.sequenceCounters.set(tmuxName, sequence);
    const meta: EventMeta = { parentage, rawSessionId, sequence, observedAt };

    for (const handler of this.eventHandlers) {
      handler(tmuxName, event, meta);
    }

    return {
      parseStatus: 'ok',
      agentType: this.agentType,
      rawSessionId: header.rawSessionId,
      rawTurnId: header.rawTurnId,
      rawHookEventName: header.rawHookEventName,
      parentage,
      sequence,
    };
  }

  private getOrHydrateIdentity(tmuxName: string, taskId: string | undefined): SessionRuntimeIdentity {
    let identity = this.identities.get(tmuxName);
    if (identity) return identity;
    identity = createSessionRuntimeIdentity();
    if (taskId) {
      const task = this.taskStore.getTask(taskId);
      const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session?.claudeSessionId) {
        identity.parentSessionId = session.claudeSessionId;
        identity.parentTranscriptPath = session.transcriptPath;
      }
      if (session?.childSessionIds) {
        for (const [id, info] of Object.entries(session.childSessionIds)) {
          identity.childSessionIds.set(id, info);
        }
      }
    }
    this.identities.set(tmuxName, identity);
    return identity;
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

    // See rfc-activity-log-reliability §6. Dual-write durable + HTTP fan-out
    // via the Kookr hook writer; falls back to the legacy awk pipeline when
    // the writer is missing on disk.
    const hookCommand = buildHookCommand({
      tmuxName,
      hookFile,
      serverPort: this.serverPort,
      writerPath: resolveHookWriterPath(),
    });

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
