import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { TerminalBackend } from './terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../core/ports/terminal-input-writer-port.js';
import type { TaskStore } from '../core/tasks.js';
import type {
  AgentEvent,
  EventMeta,
  EventOrigin,
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
import {
  probeAgentBinary,
  probeBinaryFlagSupport,
  type ProbeExecRunner,
} from './probe-agent-binary.js';
import { extractRawHookHeader, parseHookEvent, HookParseError, type RawHookHeader } from '../core/hook-parser.js';
import {
  childSessionStorageKey,
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
  type SessionRuntimeIdentity,
} from '../core/hook-parentage.js';
import { getGitInfo, isGitBranchCommand } from './git-info.js';
import { inferGitInfoPathFromEvent } from './git-path-inference.js';
import { isValidEffortForAgent } from '../shared/contracts/agent-types.js';
import { buildAgentLaunchContext, DEFAULT_PROMPT_SUBMIT_DELAY_MS } from './agent-launch-context.js';
import { ensureCodexWorkspaceTrusted } from './codex-config.js';
import { resolvePluginDir } from '../core/plugin-paths.js';
import { translateKeystroke, encodeBracketedPaste, ENTER_BYTES, CLEAR_LINE_BYTES } from './keystroke.js';
import { effectiveHookSettingsPath, readPersistedHookSettings } from './effective-hook-settings.js';
import { buildHookCommand, resolveHookWriterPath } from '../core/hook-writer-paths.js';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Sibling helper binary the Codex CLI spawns for shell/tool execution (issue #2001). */
export const CODEX_CODE_MODE_HOST_BIN = 'codex-code-mode-host';

/** Env var that overrides the default Codex model for Kookr-fork launches. */
export const CODEX_MODEL_ENV = 'KOOKR_CODEX_MODEL';
/**
 * Default Codex model for Kookr-fork launches. Override with {@link CODEX_MODEL_ENV}.
 * Sol is the general-purpose GPT-5.6 coding model; Luna remains available by setting
 * `KOOKR_CODEX_MODEL=gpt-5.6-luna` (and pairing it with a high effort if desired).
 */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol';
/**
 * Model used when an explicit `ultra` reasoning effort is requested. Luna's
 * advertised ceiling is `max`, so ultra always escalates to Sol regardless of
 * {@link CODEX_MODEL_ENV}.
 */
export const ULTRA_CODEX_MODEL = 'gpt-5.6-sol';

/**
 * Resolve the Codex model for a Kookr-fork launch.
 *
 * - `effort === 'ultra'` → {@link ULTRA_CODEX_MODEL} (Sol)
 * - otherwise → `KOOKR_CODEX_MODEL` if set and non-empty, else {@link DEFAULT_CODEX_MODEL}
 */
export function resolveCodexModel(effort?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (effort === 'ultra') return ULTRA_CODEX_MODEL;
  const fromEnv = env[CODEX_MODEL_ENV]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CODEX_MODEL;
}

/**
 * Locate the sibling `codex-code-mode-host` next to the resolved codex binary
 * (issue #2001). Codex spawns this host for shell/tool execution; a CLI-only
 * install boots but every tool call fails with "failed to spawn code-mode host".
 *
 * Resolution: PATH-resolve `agentBin` (or use absolute path), then check
 * `<dirname(codex)>/codex-code-mode-host` is executable.
 */
export async function resolveCodexCodeModeHost(
  agentBin: string,
  deps: {
    resolveExecutablePath?: (bin: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
    access?: (path: string, mode: number) => Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
  const env = deps.env ?? process.env;
  const accessFn = deps.access ?? ((p: string, mode: number) => access(p, mode));
  const resolvePath = deps.resolveExecutablePath ?? resolveExecutablePathLight;

  const launcherPath = await resolvePath(agentBin, env);
  if (!launcherPath) {
    return {
      ok: false,
      reason:
        `${CODEX_CODE_MODE_HOST_BIN} missing: could not resolve codex binary "${agentBin}" on PATH`,
    };
  }

  const hostPath = join(dirname(launcherPath), CODEX_CODE_MODE_HOST_BIN);
  try {
    await accessFn(hostPath, fsConstants.X_OK);
    return { ok: true, path: hostPath };
  } catch {
    return {
      ok: false,
      reason:
        `${CODEX_CODE_MODE_HOST_BIN} is not executable next to codex at "${hostPath}" ` +
        `(install both binaries via pnpm codex:rebuild)`,
    };
  }
}

/** Light PATH lookup (no hash) for locating the codex binary directory. */
async function resolveExecutablePathLight(
  bin: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (isAbsolute(bin) || bin.includes('/')) {
    try {
      await access(bin, fsConstants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const pathDirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, bin);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

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
  terminalInputWriter?: TerminalInputWriterPort;
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
  /**
   * Test seam for {@link resolveCodexCodeModeHost}. When provided, overrides
   * the sibling-host executable check (issue #2001). Production callers leave
   * this unset.
   */
  resolveCodeModeHost?: typeof resolveCodexCodeModeHost;
  /**
   * Live getter for the configured per-agent-type effort default for
   * codex-cli (#681). Called on every launch; returning a value pushes
   * `-c model_reasoning_effort="<level>"` into the argv (unless a per-task
   * override is supplied via {@link AdapterLaunchOptions.effort}, which wins).
   * Returning `undefined` — the default when no effort is configured — passes
   * no `model_reasoning_effort` override; the adapter still selects its
   * configured default model.
   * Invalid values are ignored (skip + warn) as a final guard.
   */
  resolveDefaultEffort?: () => string | undefined;
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
 *
 * Unattended interactive-tool denial (issue #1562): NOT YET IMPLEMENTED here.
 * The Claude Code adapter injects `permissions.deny` for interactive tools on
 * `task.unattended` spawns (see `generateSettings` +
 * `buildAgentLaunchContext.permissionDenylist`). Because Codex consumes the
 * same `--settings` format, the equivalent is to plumb the same
 * `permissionDenylist` into whatever config this adapter writes and deny the
 * Codex interactive-prompt tool once its exact tool name is confirmed. The
 * server-side operator-needed flag (interactive-deny-processor) is
 * adapter-agnostic in mechanism, but only matches tool names listed in
 * `INTERACTIVE_TOOL_NAMES` (`operator-needed.ts`) — currently just Claude's
 * `AskUserQuestion`. To cover Codex, add its interactive-prompt tool name to
 * that single-source list alongside implementing the deny above.
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
  /** Strong worktree path inferred from tool payloads; provider cwd can remain at launch cwd. */
  private inferredWorktreeRoots = new Map<string, string>();
  /** Tool-result hooks often omit the original tool input, so carry the inferred path by tool_use_id. */
  private pendingToolGitPaths = new Map<string, Map<string, string>>();
  private hooksDir: string;
  private settingsDir: string;
  private writeFile?: (path: string, content: string) => Promise<void>;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private codexConfigPath?: string;
  private trustWorkspace: boolean;
  private bypassAllPermissions: boolean;
  private pluginDir?: string;
  /** Also gates fork-only model and reasoning-effort settings. */
  private kookrForkSupportProbe?: Promise<boolean>;
  private warnedAboutMissingPluginDirSupport = false;
  private warnedAboutUnsupportedForkEfforts = new Set<string>();
  private promptFileSupportProbe?: Promise<boolean>;
  private warnedAboutMissingPromptFileSupport = false;
  private probeExec?: ProbeExecRunner;
  private resolveCodeModeHost: typeof resolveCodexCodeModeHost;
  private resolveDefaultEffort?: () => string | undefined;
  private inputWriter: TerminalInputWriterPort;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: CodexCliAdapterOptions,
  ) {
    this.inputWriter = options?.terminalInputWriter ?? asTerminalInputWriterPort(backend);
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.settingsDir = options?.settingsDir ?? '~/.kookr/settings';
    this.writeFile = options?.writeFile;
    this.serverPort = options?.serverPort;
    this.agentBin = options?.agentBin ?? 'codex';
    this.agentBinConfiguredVia = options?.agentBin ? 'env' : 'default';
    this.codexConfigPath = options?.codexConfigPath;
    this.trustWorkspace = options?.trustWorkspace ?? true;
    this.bypassAllPermissions = options?.bypassAllPermissions ?? false;
    // Mirror ClaudeCodeAdapter: auto-discover the kookr-toolkit plugin tree
    // from the compiled module location. The runtime --plugin-dir capability
    // probe (run lazily at first launch) gates whether we actually inject,
    // so onboarding devs don't have to set any env var even before the
    // codex-fork supporting --plugin-dir lands. See `probeKookrForkSupport`.
    this.pluginDir = resolvePluginDir(options?.pluginDir);
    this.probeExec = options?.probeExec;
    // Host check is real by default. When tests inject `probeExec` without an
    // explicit host resolver, skip the filesystem host probe so hermetic unit
    // tests (no real ~/bin install) keep exercising launch arg construction.
    // Production never sets probeExec; missing-host still fails closed there.
    this.resolveCodeModeHost =
      options?.resolveCodeModeHost
      ?? (options?.probeExec
        ? async () => ({ ok: true as const, path: join('/tmp', CODEX_CODE_MODE_HOST_BIN) })
        : resolveCodexCodeModeHost);
    this.resolveDefaultEffort = options?.resolveDefaultEffort;
  }

  async preflight(): Promise<PreflightResult> {
    const probe = await probeAgentBinary(this.agentBin, { exec: this.probeExec });
    if (probe.kind !== 'ok') {
      return {
        kind: 'absent',
        reason: probe.reason,
        configuredVia: this.agentBinConfiguredVia,
        envVarName: CODEX_AGENT_BIN_ENV,
      };
    }
    // Issue #2001: CLI-only installs boot but every tool call fails with
    // "failed to spawn code-mode host …/codex-code-mode-host". Treat a missing
    // sibling host as absent so codex-cli is not registered / not a fallback.
    const host = await this.resolveCodeModeHost(this.agentBin);
    if (!host.ok) {
      return {
        kind: 'absent',
        reason: host.reason,
        configuredVia: this.agentBinConfiguredVia,
        envVarName: CODEX_AGENT_BIN_ENV,
      };
    }
    return probe;
  }

  /**
   * Memoized capability probe: does this codex binary advertise `--plugin-dir`
   * in its `--help` output? The flag identifies the Kookr fork and gates both
   * plugin injection and fork-specific model/effort settings. Caches the
   * Promise so concurrent first launches share the work.
   */
  private probeKookrForkSupport(): Promise<boolean> {
    if (this.kookrForkSupportProbe === undefined) {
      this.kookrForkSupportProbe = probeBinaryFlagSupport(
        this.agentBin,
        '--plugin-dir',
        { exec: this.probeExec },
      );
    }
    return this.kookrForkSupportProbe;
  }

  /**
   * Memoized capability probe: does this codex binary advertise `--prompt-file`
   * in its `--help` output? When true, the initial prompt is delivered as a
   * file artifact (race-free, no ARG_MAX limit). When false (stock codex, or a
   * kookr-fork built before the flag landed), the caller falls back to a
   * positional argv prompt — also race-free, but bounded by ARG_MAX.
   */
  private probePromptFileSupport(): Promise<boolean> {
    if (this.promptFileSupportProbe === undefined) {
      this.promptFileSupportProbe = probeBinaryFlagSupport(
        this.agentBin,
        '--prompt-file',
        { exec: this.probeExec },
      );
    }
    return this.promptFileSupportProbe;
  }

  async launch(taskId: string, prompt: string, cwd: string, resume?: import('./agent-adapter.js').ResumeContext, opts?: AdapterLaunchOptions): Promise<string> {
    // Issue #2001 defense-in-depth: refuse launch when the sibling host binary
    // is missing (preflight may have been skipped in tests or the binary
    // removed after registration). Clear error beats a tool-dead session.
    const host = await this.resolveCodeModeHost(this.agentBin);
    if (!host.ok) {
      throw new Error(
        `codex-cli launch refused: ${host.reason}. ` +
        `Rebuild/install with \`pnpm codex:rebuild\` (installs both codex and ${CODEX_CODE_MODE_HOST_BIN}).`,
      );
    }
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
    // Honor a caller-preallocated session id (AdapterLaunchOptions.tmuxName).
    // Ralph loops publish `loop.ownerSessionId` from this value BEFORE launching
    // and gate their own Stop-event ownership on it; minting a fresh UUID here
    // would point ownership at a session that is never created (issue #1366).
    const tmuxName = opts?.tmuxName ?? `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    // Phase instrumentation (issue #1589): session-create covers launch-context
    // build, settings/prompt-file write, and the terminal createSession.
    opts?.onPhase?.('session-create');
    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
      sessionName: tmuxName,
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

    // Build the Codex CLI command. A per-call `bypassPermissions` override
    // (AdapterLaunchOptions) wins over the constructor-time default for THIS
    // launch only; when unset the instance default applies (issue #1366).
    const bypassPermissions = opts?.bypassPermissions ?? this.bypassAllPermissions;
    const permissionFlagStr = bypassPermissions
      ? '--dangerously-bypass-approvals-and-sandbox'
      : '--full-auto';

    // Deliver the initial prompt. Preferred path: write it to a launch-artifact
    // file (like the --settings JSON) and pass --prompt-file. Codex folds the
    // file content into its positional-prompt path at startup — submitted
    // internally with no terminal-input race — and only a short path travels
    // in argv (no ARG_MAX / E2BIG, see #319). The file shares the settings
    // file's lifecycle; it is not separately cleaned up.
    //
    // Fallback: a codex binary that does not advertise --prompt-file (stock
    // codex, or a kookr-fork built before the flag landed) gets the prompt as
    // a trailing positional argv entry instead — also race-free, but bounded
    // by ARG_MAX. The capability probe runs once per adapter instance.
    const promptFileSupported = await this.probePromptFileSupport();
    const promptPath = `${this.settingsDir}/${tmuxName}.prompt.txt`;
    if (promptFileSupported) {
      if (this.writeFile) {
        await this.writeFile(promptPath, prompt);
      }
    } else if (!this.warnedAboutMissingPromptFileSupport) {
      this.warnedAboutMissingPromptFileSupport = true;
      console.warn(
        `[codex-cli-adapter] codex binary "${this.agentBin}" does not advertise --prompt-file; ` +
        `delivering the initial prompt via positional argv instead. Large prompts (>~100 KiB) ` +
        `may hit ARG_MAX. Run \`pnpm codex:rebuild\` from kookr to install the kookr-fork.`,
      );
    }

    // A Sol session is the default for the Kookr fork (override with
    // KOOKR_CODEX_MODEL). The same capability probe used for --plugin-dir
    // keeps stock/older Codex binaries on their previous model defaults.
    // Luna tops out at `max`; an explicit `ultra` request selects Sol, which
    // advertises ultra — regardless of KOOKR_CODEX_MODEL.
    const forkCapabilitiesSupported = await this.probeKookrForkSupport();
    const effort = opts?.effort ?? this.resolveDefaultEffort?.();
    const model = forkCapabilitiesSupported ? resolveCodexModel(effort) : undefined;

    // V8: argv-based launch through the backend. No shell features needed;
    // env goes in SessionSpec.env, flags become argv.
    const args = [
      '-c', 'features.codex_hooks=true',
      ...(model ? ['-c', `model="${model}"`] : []),
      permissionFlagStr,
      '--settings', settingsPath,
    ];
    // Reasoning-effort override (#681). Codex has no dedicated `--effort` flag;
    // its lever is the `model_reasoning_effort` config key, overridable from
    // the CLI via `-c key=value` (value parsed as TOML). Resolution order:
    // per-task override (opts.effort) → configured per-agent-type default
    // (resolveDefaultEffort) → unset. When both are absent, no effort override
    // is pushed; the adapter still selects its configured default model. The
    // agent-specific validity
    // guard is a last line of defense (route + settings validation reject
    // invalid values upstream). The prompt positional is appended later, so
    // this flag pair never lands in trailing-positional position.
    const forkOnlyEffort = effort === 'max' || effort === 'ultra';
    if (effort && forkOnlyEffort && !forkCapabilitiesSupported) {
      if (!this.warnedAboutUnsupportedForkEfforts.has(effort)) {
        this.warnedAboutUnsupportedForkEfforts.add(effort);
        console.warn(
          `[codex-cli-adapter] effort "${effort}" requires the Kookr Codex fork; ` +
          `keeping the stock Codex model and skipping the unsupported override. ` +
          `Run \`pnpm codex:rebuild\` from kookr to install the fork.`,
        );
      }
    } else if (effort) {
      if (isValidEffortForAgent(this.agentType, effort)) {
        args.push('-c', `model_reasoning_effort="${effort}"`);
      } else {
        console.warn(
          `[codex-cli-adapter] ignoring invalid effort "${effort}" for ${this.agentType}; ` +
          `valid: none, minimal, low, medium, high, xhigh, max, ultra`,
        );
      }
    }
    if (promptFileSupported) {
      args.push('--prompt-file', promptPath);
    }
    // Inject --plugin-dir <path> when (a) the kookr-toolkit tree resolves
    // and (b) the configured codex binary actually supports the flag. The
    // capability probe runs once per adapter instance, lazily, so cold start
    // pays a single `codex --help` invocation. Stock codex returns help
    // without the flag → injection is skipped silently. Kookr-fork codex
    // (jeanibarz/codex#52) advertises the flag → injection is automatic
    // with no env var setup.
    if (this.pluginDir) {
      const supported = await this.probeKookrForkSupport();
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
    if (!promptFileSupported) {
      // Positional argv fallback for binaries without --prompt-file. Must be
      // the last argv entry (codex treats a trailing bare arg as the prompt).
      args.push(prompt);
    }
    await this.backend.createSession({
      id: tmuxName,
      command: this.agentBin,
      args,
      env: { ...launchContext.env, ...(opts?.extraEnv ?? {}) },
      cwd,
      size: { cols: 200, rows: 50 },
    });
    // Issue #2500: the dtach master now exists — report it so an abandoned
    // launch (top-level launch timeout) can link and reap it instead of leaving
    // it unowned for up to 24h. `addSession` below only runs at `ack`.
    opts?.onSessionCreated?.(tmuxName);
    // Phase instrumentation (issue #1589): Codex folds the initial prompt into
    // its startup argv (--prompt-file / positional), so there is no separate
    // terminal delivery loop — agent-boot and ack collapse onto session start.
    opts?.onPhase?.('agent-boot');
    opts?.onPhase?.('ack');

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
    // Lead with Ctrl-U (clear line): keystrokes typed into the dashboard's
    // terminal panel but never submitted sit on the Codex composer line, and
    // without the clear they would be fused onto the front of this message
    // and submitted with it as one user prompt (kookr F15). Ctrl-U is a
    // no-op on an empty composer line.
    //
    // Wrap the message body in bracketed-paste markers so Codex parses it
    // as one explicit paste event instead of relying on its timing-based
    // paste-burst heuristic. The trailing Enter is still delayed and sent as
    // its own payload, making it an unambiguous submit keystroke even when a
    // busy TUI drains the preceding bytes in one batch (#935).
    await this.inputWriter.writeInputSequence(tmuxName, [CLEAR_LINE_BYTES, encodeBracketedPaste(text), ENTER_BYTES], {
      reason: 'adapter-send-input',
      interPayloadDelayMs: DEFAULT_PROMPT_SUBMIT_DELAY_MS,
    });
  }

  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.inputWriter.writeInput(tmuxName, translateKeystroke(key), { reason: 'adapter-send-keystroke' });
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
  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    externalSequence?: number,
    options?: { origin?: EventOrigin },
  ): InjectHookEventResult {
    const observedAt = Date.now();
    const observedAtIso = new Date(observedAt).toISOString();

    let header: RawHookHeader;
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
          this.taskStore.recordChildSession(taskId, tmuxName, childSessionStorageKey(identity, rawSessionId, event.transcriptPath), {
            firstSeenAt: observedAtIso,
            transcriptPath: event.transcriptPath,
            reason: 'inherited_settings',
          });
        }
      }
    } else {
      parentage = classifyHookParentage(rawSessionId, identity, header.rawTranscriptPath);
    }

    if (parentage === 'parent' && taskId && 'cwd' in event && event.cwd) {
      const task = this.taskStore.getTask(taskId);
      const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session) {
        const inferredGitPath = this.resolveInferredGitPath(tmuxName, event);
        const stickyWorktreeRoot = this.inferredWorktreeRoots.get(tmuxName);
        let gitRefreshPath: string | null = null;

        if (event.cwd !== session.cwd && !inferredGitPath && !stickyWorktreeRoot) {
          this.taskStore.updateSessionCwd(taskId, tmuxName, event.cwd);
          gitRefreshPath = event.cwd;
        }

        if (event.type === 'tool_result' && event.toolName === 'Bash' && isGitBranchCommand(event.toolResponse)) {
          gitRefreshPath = stickyWorktreeRoot ?? event.cwd;
        }
        if (event.type === 'tool_use' && event.toolName === 'Bash' && isGitBranchCommand(event.toolInput)) {
          gitRefreshPath = inferredGitPath ?? stickyWorktreeRoot ?? event.cwd;
        }
        if (inferredGitPath) gitRefreshPath = inferredGitPath;

        if (gitRefreshPath) {
          const currentPath = gitRefreshPath;
          getGitInfo(currentPath)
            .then((info) => {
              if (info) {
                if (inferredGitPath && info.worktreeRoot && info.worktreeRoot !== session.cwd) {
                  this.inferredWorktreeRoots.set(tmuxName, info.worktreeRoot);
                  this.taskStore.updateSessionCwd(taskId, tmuxName, info.worktreeRoot);
                }
                this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
                for (const handler of this.refreshHandlers) {
                  handler();
                }
              }
            })
            .catch(() => { /* graceful degradation */ });
        }
      }
    }

    const sequence = externalSequence ?? (this.sequenceCounters.get(tmuxName) ?? 0) + 1;
    this.sequenceCounters.set(tmuxName, sequence);
    const meta: EventMeta = {
      parentage,
      rawSessionId,
      sequence,
      observedAt,
      ...(options?.origin ? { origin: options.origin } : {}),
    };

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

  private resolveInferredGitPath(tmuxName: string, event: AgentEvent): string | null {
    const directPath = inferGitInfoPathFromEvent(event);
    if (directPath) {
      if (event.type === 'tool_use' && event.toolUseId) {
        let paths = this.pendingToolGitPaths.get(tmuxName);
        if (!paths) {
          paths = new Map();
          this.pendingToolGitPaths.set(tmuxName, paths);
        }
        paths.set(event.toolUseId, directPath);
      }
      return directPath;
    }

    if ((event.type === 'tool_result' || event.type === 'tool_error') && event.toolUseId) {
      const paths = this.pendingToolGitPaths.get(tmuxName);
      const pendingPath = paths?.get(event.toolUseId) ?? null;
      paths?.delete(event.toolUseId);
      if (paths?.size === 0) this.pendingToolGitPaths.delete(tmuxName);
      return pendingPath;
    }

    return null;
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

  getActiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    const content = this.settingsMap.get(tmuxName);
    if (!content) return undefined;
    const settingsPath = effectiveHookSettingsPath(this.settingsDir, tmuxName);
    if (!settingsPath) return undefined;
    return {
      content,
      agentType: this.agentType,
      settingsPath,
    };
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    const active = this.getActiveHookSettings(tmuxName);
    if (active) return active;
    const content = readPersistedHookSettings(this.settingsDir, tmuxName);
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
