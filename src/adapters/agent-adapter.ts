import type { AgentEvent } from '../core/types.js';
import type { AgentType } from '../core/agent-types.js';

/**
 * Common interface for all agent adapters (Claude Code, Codex CLI, etc.).
 * Each adapter handles launching, terminal interaction, hook parsing, and
 * event normalization for a specific agent type.
 */
/**
 * Hint passed to {@link AgentAdapter.launch} requesting resume of a prior
 * conversation rather than a fresh launch from `prompt`. Adapters that
 * support resume (currently Claude Code only) consult this; adapters that
 * don't (Codex CLI today) fall back to fresh launch and may log a warning.
 *
 * Constructed by crash-recovery from a dead session's persisted
 * `claudeSessionId` and `transcriptPath`. See `rfc-crash-recovery-resume.md`.
 */
export interface ResumeContext {
  /** Agent-native session id from a prior session (e.g., Claude Code session UUID). */
  sessionId: string;
  /** Absolute path to the transcript file, if known. Adapters MAY use this for
   *  pre-flight (e.g., file exists). Optional — when missing, adapters that
   *  support resume rely on the agent CLI to validate the sessionId. */
  transcriptPath?: string;
}

/**
 * Per-launch options that don't fit the resume concept. Currently carries the
 * sandbox profile flag for reflect-task spawns (write-allowlist + memory gate).
 * Adapters that don't recognize a profile MUST ignore it (Codex CLI today).
 *
 * Kept as a flag — not a `Partial<HookSettings>` — so the on-disk settings
 * shape stays private to the Claude Code adapter.
 */
export interface AdapterLaunchOptions {
  /** When set, the adapter applies a stricter sandbox: write-allowlist, memory frontmatter gate, no destructive bash. */
  sandboxProfile?: 'reflect';
  /**
   * Per-call override of the adapter's constructor-time `bypassAllPermissions`
   * default. When set, this value wins over instance state for THIS launch
   * only.
   */
  bypassPermissions?: boolean;
}

/**
 * Outcome of a startup binary preflight. See {@link AgentAdapter.preflight}.
 *
 * `configuredVia` distinguishes operator intent: `'env'` means the operator
 * explicitly set `KOOKR_AGENT_BIN` / `KOOKR_CODEX_BIN`; `'default'` means
 * the adapter fell back to the default command name on PATH.
 */
export type PreflightResult =
  | { kind: 'ok'; resolvedPath: string; version: string }
  | { kind: 'absent'; reason: string; configuredVia: 'env' | 'default'; envVarName: string };

export interface AgentAdapter {
  /** Unique identifier for this agent type (e.g., 'claude-code', 'codex-cli'). */
  readonly agentType: AgentType;

  /**
   * Launch an agent in a managed terminal session. Returns the terminal
   * session id (also used as the dtach socket filename and the WebSocket
   * attach route).
   *
   * When `resume` is provided AND the adapter supports resume AND the
   * preconditions are met (transcript file present), the launch will continue
   * the prior conversation on a forked branch (so the original transcript
   * is not mutated). Otherwise — including for adapters that do not yet
   * support resume — the launch is fresh with `prompt`, identical to today.
   */
  launch(
    taskId: string,
    prompt: string,
    cwd: string,
    resume?: ResumeContext,
    opts?: AdapterLaunchOptions,
  ): Promise<string>;

  /**
   * Probe the agent binary before the server accepts connections.
   * Optional — adapters that cannot meaningfully probe (routing wrappers,
   * fakes) omit this method. {@link runAdapterPreflights} skips them.
   */
  preflight?(): Promise<PreflightResult>;

  /** Send developer input to an agent's terminal session. */
  sendInput(tmuxName: string, text: string): Promise<void>;

  /** Send a single keystroke without trailing Enter (for permission prompts). */
  sendKeystroke(tmuxName: string, key: string): Promise<void>;

  /** Stop an agent by killing its terminal session. */
  stop(tmuxName: string): Promise<void>;

  /** Capture the current terminal display. */
  captureDisplay(tmuxName: string): Promise<string>;

  /** Register handler for normalized AgentEvents from hook events. */
  onEvent(handler: (tmuxName: string, event: AgentEvent) => void): void;

  /** Register handler for metadata-only refreshes (e.g., git info updates). */
  onRefreshNeeded(handler: () => void): void;

  /** Inject a raw hook event line for parsing and dispatch. */
  injectHookEvent(tmuxName: string, rawJson: string): void;

  /**
   * Return the hook settings Kookr actually passed to --settings for a
   * given session, along with the on-disk path of the settings file. The
   * content is sourced from adapter memory, not re-read from disk, so it
   * reflects exactly what the agent was launched with. Returns undefined
   * if the session is unknown to this adapter.
   */
  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined;
}

export interface EffectiveHookSettings {
  content: unknown;
  agentType: AgentType;
  settingsPath: string;
}

/**
 * Registry that maps agent type strings to adapter instances.
 * Used by the server to resolve which adapter handles a given task.
 */
export class AdapterRegistry {
  private adapters = new Map<AgentType, AgentAdapter>();
  private defaultType: AgentType | null = null;

  /** Register an adapter. The first registered adapter becomes the default. */
  register(adapter: AgentAdapter): void {
    if (this.adapters.size === 0) {
      this.defaultType = adapter.agentType;
    }
    this.adapters.set(adapter.agentType, adapter);
  }

  /** Get an adapter by agent type. Throws if not found. */
  get(agentType: AgentType): AgentAdapter {
    const adapter = this.adapters.get(agentType);
    if (!adapter) throw new Error(`Unknown agent type: ${agentType}`);
    return adapter;
  }

  /** Get all registered adapters. */
  getAll(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** Get the default adapter (first registered). Throws if none registered. */
  getDefault(): AgentAdapter {
    if (!this.defaultType) throw new Error('No adapters registered');
    return this.get(this.defaultType);
  }

  /** Get the default adapter type (first registered). Throws if none registered. */
  getDefaultType(): AgentType {
    if (!this.defaultType) throw new Error('No adapters registered');
    return this.defaultType;
  }

  /** Get all registered agent type strings. */
  getTypes(): AgentType[] {
    return [...this.adapters.keys()];
  }
}
