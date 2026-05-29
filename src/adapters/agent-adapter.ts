import type { AgentEvent, EventMeta, InjectHookEventResult } from '../core/types.js';
import type { AgentType } from '../core/agent-types.js';
import type { AgentInteractionPort } from '../core/ports/agent-interaction-port.js';

/**
 * Handler signature for adapter hook events. The optional third argument is
 * the Kookr-side {@link EventMeta} envelope carrying parentage classification
 * relative to the Kookr terminal session. Existing 2-arg subscribers still
 * type-check (TS function parameter contravariance). New code that needs to
 * route based on parent/child should accept the third argument.
 */
export type AdapterEventHandler = (
  tmuxName: string,
  event: AgentEvent,
  meta: EventMeta,
) => void;

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
  /** Preallocated terminal session id. Ralph loops use this to publish ownership before spawning. */
  tmuxName?: string;
  /**
   * Per-call override of the adapter's constructor-time `bypassAllPermissions`
   * default. When set, this value wins over instance state for THIS launch
   * only.
   */
  bypassPermissions?: boolean;
  /**
   * Generic env-variable extension point. Each adapter MUST merge these into
   * the spawned process's environment. Used by Ralph stall handling to inject
   * `RALPH_VERDICT_FILE`, but kept generic to avoid leaking caller-specific
   * concerns into the adapter interface. See rfc-ralph-loop-stall-handling.md §8.
   */
  extraEnv?: Record<string, string>;
  /**
   * Per-task reasoning-effort override (#681). When set, the adapter translates
   * it to the agent CLI's effort lever (claude-code: `--effort <level>`;
   * codex-cli: `-c model_reasoning_effort="<level>"`). When undefined, the
   * adapter falls back to its constructor-time per-agent-type default; when
   * *that* is also undefined no effort flag is passed at all — byte-identical
   * to pre-#681 launch argv.
   *
   * Carries only the resolved per-task override. The per-agent-type default is
   * resolved *inside* the adapter (see each adapter's `resolveDefaultEffort`)
   * so it applies uniformly across every launch path — fresh launch, queued
   * promotion, crash-recovery resume, and Ralph relaunch — without each call
   * site having to thread it. Resolution order is therefore: this override →
   * adapter's per-agent default → unset.
   */
  effort?: string;
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

export interface AgentAdapter extends AgentInteractionPort {
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

  /** Stop an agent by killing its terminal session. */
  stop(tmuxName: string): Promise<void>;

  /** Capture the current terminal display. */
  captureDisplay(tmuxName: string): Promise<string>;

  /** Register handler for normalized AgentEvents from hook events.
   *  The third argument carries Kookr-side parentage classification; see
   *  {@link AdapterEventHandler}. */
  onEvent(handler: AdapterEventHandler): void;

  /** Register handler for metadata-only refreshes (e.g., git info updates). */
  onRefreshNeeded(handler: () => void): void;

  /** Inject a raw hook event line for parsing and dispatch. Returns an
   *  {@link InjectHookEventResult} describing what happened so HookIngestion
   *  can build the ledger envelope without re-parsing. Adapters MUST NOT
   *  throw on malformed payloads. The optional `sequence` lets callers thread
   *  a Kookr-side sequence number into the emitted EventMeta; when omitted,
   *  the adapter falls back to its own per-session counter. */
  injectHookEvent(tmuxName: string, rawJson: string, sequence?: number): InjectHookEventResult;

  /**
   * Return the hook settings Kookr passed to --settings for a given session,
   * along with the on-disk path of the settings file. Adapters serve current
   * launches from memory and may fall back to the persisted settings file for
   * sessions restored after a server restart. Returns undefined if no settings
   * are known for this adapter/session.
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
