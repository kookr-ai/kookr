import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
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
  ResumeContext,
} from './agent-adapter.js';
import { probeAgentBinary, type ProbeExecRunner } from './probe-agent-binary.js';
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
import { isValidEffortForAgent, isValidModelForAgent } from '../shared/contracts/agent-types.js';
import {
  buildAgentLaunchContext,
  DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS,
  DEFAULT_PROMPT_SUBMIT_DELAY_MS,
  deliverInitialPromptToSession,
  stripBracketedPasteMarkers,
  type InitialPromptDeliveryResult,
  resolveBracketedPasteSubmit,
} from './agent-launch-context.js';
import { translateKeystroke, encodeBracketedPaste, ENTER_BYTES, CLEAR_LINE_BYTES } from './keystroke.js';
import { effectiveHookSettingsPath, readPersistedHookSettings } from './effective-hook-settings.js';
import { loadFileBasedAgents, type InlineAgentDef } from './file-based-agents.js';
import { buildHookCommand, buildStopNudgeCommand, resolveHookWriterPath, resolveStopNudgePath } from '../core/hook-writer-paths.js';
import { withTimeout } from '../core/with-timeout.js';
import { normalizeUserPromptNewlines } from '../shared/contracts/user-prompt-text.js';
import { LaunchAbortedError, raceAgainstLaunchAbort, throwIfLaunchAborted } from './launch-abort.js';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

export interface HookSettings {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  permissions?: {
    allow?: string[];
    /**
     * Permission deny rules (issue #1562). Injected for unattended/autonomous
     * spawns to hard-deny interactive tools (`AskUserQuestion` and equivalents)
     * so a blocking call fails fast instead of hanging on an unanswerable
     * prompt. Empty/absent for attended tasks.
     */
    deny?: string[];
  };
}

export interface ClaudeCodeAdapterOptions {
  terminalInputWriter?: TerminalInputWriterPort;
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
  /**
   * Whether to submit the initial prompt via bracketed paste — the prompt
   * body wrapped in ANSI bracketed-paste markers, followed by a separate
   * Enter. Resolution: this option >
   * `KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE` env > `true`. If bracketed paste
   * is not confirmed, launch falls back to the plain write+Enter path before
   * failing closed. See `resolveBracketedPasteSubmit`.
   */
  promptBracketedPaste?: boolean;
  /**
   * Per-attempt deadline (ms) for the `UserPromptSubmit` confirmation that
   * gates the launch-path Enter retry loop. Production default lives in
   * `agent-launch-context.DEFAULT_PROMPT_SUBMIT_CONFIRM_MS`; tests override
   * to a small value so the worst-case bracketed-paste launch test does
   * not stall waiting for a hook the FakeTerminalBackend never produces.
   */
  promptSubmitConfirmTimeoutMs?: number;
  /**
   * Number of retry Enters after the initial submission Enter when the
   * `UserPromptSubmit` confirmation keeps timing out. Production default
   * lives in `agent-launch-context.DEFAULT_PROMPT_SUBMIT_RETRIES`; tests
   * use `0` to assert the open-loop path with no resends.
   */
  promptSubmitRetries?: number;
  /**
   * Test seam for the bracketed-paste readiness wait. Production callers use
   * the helper defaults; tests may shorten this to exercise timeout fallback
   * without waiting for the full startup deadline.
   */
  promptReadyTimeoutMs?: number;
  promptReadyPollMs?: number;
  /** Settle cushion after both readiness signals, before the paste (#2977). */
  promptReadySettleMs?: number;
  /**
   * Live getter for the configured per-agent-type effort default for
   * claude-code (#681). Called on every launch; returning a value pushes
   * `--effort <level>` into the argv (unless a per-task override is supplied
   * via {@link AdapterLaunchOptions.effort}, which wins). Returning `undefined`
   * — the default when no effort is configured — passes no effort flag, leaving
   * the launch argv byte-identical to pre-#681. Wired to live server settings
   * so an operator's settings change takes effect on the next launch without a
   * restart. Invalid values are ignored (skip + warn) as a final guard.
   */
  resolveDefaultEffort?: () => string | undefined;
}

/** Env var that overrides the default Claude Code binary path. */
export const CLAUDE_AGENT_BIN_ENV = 'KOOKR_AGENT_BIN';

// Re-exported here so legacy `import { resolvePluginDir } from '...claude-code-adapter.js'`
// keeps working. Source of truth lives in core/plugin-paths to allow other
// layers (core/playbook-discovery) to share the same resolution logic.
import { resolvePluginDir } from '../core/plugin-paths.js';
export { resolvePluginDir } from '../core/plugin-paths.js';

export class InitialPromptSubmissionNotConfirmedError extends Error {
  constructor(sessionId: string, result: InitialPromptDeliveryResult) {
    super(
      `Initial prompt submission was not confirmed for session ${sessionId} `
      + `after ${result.confirmationAttempts} confirmation attempt(s) and ${result.enterWrites} Enter write(s)`,
    );
    this.name = 'InitialPromptSubmissionNotConfirmedError';
  }
}

/**
 * The agent submitted a prompt that is not the one Kookr delivered. Raised
 * when the `UserPromptSubmit` hook reports fewer characters than were
 * written to the terminal — the signature of bytes dropped during delivery
 * (kookr-ai/kookr#2977). Failing the launch is deliberate: a truncated
 * prompt produces an agent working from a corrupted brief, which is strictly
 * worse than a launch the operator can retry.
 */
export class InitialPromptTruncatedError extends Error {
  constructor(sessionId: string, sentChars: number, receivedChars: number) {
    super(
      `Initial prompt was truncated in transit for session ${sessionId}: `
      + `sent ${sentChars} chars, agent received ${receivedChars} `
      + `(${sentChars - receivedChars} lost)`,
    );
    this.name = 'InitialPromptTruncatedError';
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agentType = 'claude-code';
  private eventHandlers: Array<AdapterEventHandler> = [];
  private refreshHandlers: Array<() => void> = [];
  private settingsMap = new Map<string, HookSettings>();
  private tmuxToTaskId = new Map<string, string>();
  /** In-memory parentage view per Kookr session; hydrated lazily from SessionInfo. */
  private identities = new Map<string, SessionRuntimeIdentity>();
  /** Kookr-assigned monotonic sequence per Kookr session, threaded through EventMeta. */
  private sequenceCounters = new Map<string, number>();
  /** Strong worktree path inferred from tool payloads; provider cwd can remain at launch cwd. */
  private inferredWorktreeRoots = new Map<string, string>();
  /** Tool-result hooks often omit the original tool input, so carry the inferred path by tool_use_id. */
  private pendingToolGitPaths = new Map<string, Map<string, string>>();
  /**
   * Resolver for the first parent `UserPromptSubmit` hook on each launching
   * session — the ground-truth signal that the initial prompt left the
   * composer. The launch path registers a deferred here BEFORE delivering
   * the prompt, then awaits it with timeout/retry; `injectHookEvent` calls
   * the resolver when the matching hook arrives. Cleared on first fire and
   * on `stop()`. See `launch()` for usage.
   */
  private initialPromptSubmitResolvers = new Map<string, (submittedPrompt?: string) => void>();
  private hooksDir: string;
  private settingsDir: string;
  private writeFile?: (path: string, content: string) => Promise<void>;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private bypassAllPermissions: boolean;
  private pluginDir?: string;
  private probeExec?: ProbeExecRunner;
  private loadAgents: (cwd: string) => Record<string, InlineAgentDef>;
  private promptBracketedPaste: boolean;
  private promptSubmitConfirmTimeoutMs?: number;
  private promptSubmitRetries?: number;
  private promptReadyTimeoutMs?: number;
  private promptReadyPollMs?: number;
  private promptReadySettleMs?: number;
  private resolveDefaultEffort?: () => string | undefined;
  private inputWriter: TerminalInputWriterPort;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: ClaudeCodeAdapterOptions,
  ) {
    this.inputWriter = options?.terminalInputWriter ?? asTerminalInputWriterPort(backend);
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.settingsDir = options?.settingsDir ?? '~/.kookr/settings';
    this.writeFile = options?.writeFile;
    this.serverPort = options?.serverPort;
    this.agentBin = options?.agentBin ?? 'claude';
    this.agentBinConfiguredVia = options?.agentBin ? 'env' : 'default';
    this.bypassAllPermissions = options?.bypassAllPermissions ?? false;
    this.pluginDir = resolvePluginDir(options?.pluginDir);
    this.probeExec = options?.probeExec;
    this.loadAgents = options?.loadFileBasedAgents ?? ((cwd) => loadFileBasedAgents(cwd));
    this.promptBracketedPaste = resolveBracketedPasteSubmit(options?.promptBracketedPaste);
    this.promptSubmitConfirmTimeoutMs = options?.promptSubmitConfirmTimeoutMs;
    this.promptSubmitRetries = options?.promptSubmitRetries;
    this.promptReadyTimeoutMs = options?.promptReadyTimeoutMs;
    this.promptReadyPollMs = options?.promptReadyPollMs;
    this.promptReadySettleMs = options?.promptReadySettleMs;
    this.resolveDefaultEffort = options?.resolveDefaultEffort;
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

    // Phase instrumentation (issue #1589): session-create covers launch-context
    // build, settings generation/write, and the terminal createSession.
    opts?.onPhase?.('session-create');
    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
      sessionName: tmuxName,
    });

    // Generate hook settings. Unattended spawns also carry interactive-tool
    // deny rules (issue #1562) from the launch context.
    const settings = this.generateSettings(
      tmuxName,
      this.hooksDir,
      launchContext.permissionAllowlist,
      launchContext.permissionDenylist,
    );
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
    // Env lives in SessionSpec.env; flags are argv entries. The initial prompt
    // is delivered through the terminal after spawn so large prompts cannot
    // hit ARG_MAX or leak into parent-session hook command scanners.
    // --dangerously-skip-permissions is conditional on opt-in via
    // KOOKR_BYPASS_ALL_PERMISSIONS=true.
    // A per-call `bypassPermissions` override (AdapterLaunchOptions) wins over
    // the constructor-time default for THIS launch only; when unset the instance
    // default applies (issue #1366).
    const bypassPermissions = opts?.bypassPermissions ?? this.bypassAllPermissions;
    const args: string[] = [];
    if (bypassPermissions) {
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
    // Reasoning-effort flag (#681). Resolution order: per-task override
    // (opts.effort) → configured per-agent-type default (resolveDefaultEffort)
    // → unset. When both are absent, no `--effort` is pushed and the argv is
    // byte-identical to pre-#681. The agent-specific validity guard is a
    // last line of defense — the route + settings validation already reject
    // invalid values upstream — so a stray bad value is skipped (+ warn)
    // rather than passed through to break the launch.
    const effort = opts?.effort ?? this.resolveDefaultEffort?.();
    if (effort) {
      if (isValidEffortForAgent(this.agentType, effort)) {
        args.push('--effort', effort);
      } else {
        console.warn(
          `[claude-code-adapter] ignoring invalid effort "${effort}" for ${this.agentType}; ` +
          `valid: low, medium, high, xhigh, max`,
        );
      }
    }
    // Model pin (#1518). Resolution order: per-task override (opts.model) →
    // unset (Claude Code's own default). No Kookr-global per-agent model
    // default for claude-code. Upstream validation rejects unknown ids, so a
    // stray bad value is skipped (+ warn) rather than passed to break launch.
    if (opts?.model) {
      if (isValidModelForAgent(this.agentType, opts.model)) {
        args.push('--model', opts.model);
      } else {
        console.warn(
          `[claude-code-adapter] ignoring invalid model "${opts.model}" for ${this.agentType}`,
        );
      }
    }
    if (useResume) {
      // --fork-session creates a new sessionId for the resumed branch so the
      // user's pre-crash transcript is preserved as a read-only snapshot.
      // No prompt arg: the resumed conversation already contains the original
      // prompt.
      args.push('--resume', resume!.sessionId, '--fork-session');
      args.push('--settings', settingsPath);
    } else {
      args.push('--settings', settingsPath);
    }

    throwIfLaunchAborted(opts?.signal);
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
    if (opts?.signal?.aborted) {
      await this.cleanupFailedLaunch(tmuxName);
      throw new LaunchAbortedError(tmuxName);
    }
    // Phase instrumentation (issue #1589): agent-boot covers readiness and the
    // initial-prompt delivery/submit-confirmation loop below.
    opts?.onPhase?.('agent-boot');
    if (!useResume) {
      // Register a deferred BEFORE delivery so a fast UserPromptSubmit hook
      // is not missed. The resolver fires from `injectHookEvent` on the
      // first parent UserPromptSubmit for this session — Claude Code's own
      // ack that the prompt left the composer. `deliverInitialPromptToSession`
      // awaits it with timeout and resends Enter on miss, closing the
      // residual race where the first Enter is parsed as paste content
      // because bracketed-paste mode had not yet been enabled.
      const submitConfirmed = this.armInitialPromptSubmitSignal(tmuxName);
      try {
        // Submit the prompt via bracketed paste so Claude Code's UI parses the
        // trailing Enter as a keystroke, not paste content. See
        // deliverInitialPromptToSession.
        const awaitSubmit = (timeoutMs: number) => withTimeout(submitConfirmed.then(() => true), timeoutMs, false);
        let deliveryResult = await raceAgainstLaunchAbort(
          deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
            inputWriter: this.inputWriter,
            bracketedPaste: this.promptBracketedPaste,
            waitForReady: this.promptBracketedPaste,
            awaitSubmit: this.promptBracketedPaste ? awaitSubmit : undefined,
            submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
            submitRetries: this.promptSubmitRetries,
            readyTimeoutMs: this.promptReadyTimeoutMs,
            readyPollMs: this.promptReadyPollMs,
            readySettleMs: this.promptReadySettleMs,
          }),
          opts?.signal,
          tmuxName,
        );
        if (deliveryResult.status === 'unconfirmed' && this.promptBracketedPaste) {
          // Claude Code v2.1.156 can advertise bracketed-paste mode but still
          // drop the wrapped prompt during startup. Fall back to the legacy
          // plain write+Enter path, but keep the same UserPromptSubmit-backed
          // confirmation loop so the fallback cannot silently strand text in
          // the composer.
          deliveryResult = await raceAgainstLaunchAbort(
            deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
              inputWriter: this.inputWriter,
              bracketedPaste: false,
              awaitSubmit,
              submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
              submitRetries: this.promptSubmitRetries,
            }),
            opts?.signal,
            tmuxName,
          );
        }
        if (deliveryResult.status === 'unconfirmed') {
          throw new InitialPromptSubmissionNotConfirmedError(tmuxName, deliveryResult);
        }
        // Delivery-integrity check (#2977). `confirmed` only proves that *a*
        // prompt left the composer, not that it is the one we wrote: bytes
        // dropped in transit still submit, just short. The UserPromptSubmit
        // hook carries the text the agent accepted, so compare it with what we
        // sent and fail the launch rather than hand the task to an agent
        // working from a mutilated brief.
        //
        // Only `confirmed` is verified, and it costs nothing to check: that
        // status is reached *because* the hook resolved the deferred, so the
        // await below is already settled. The other statuses have no hook text
        // to compare against — `assumed-submitted` inferred submission from the
        // display, `open-loop` never wired a confirmation signal at all — and
        // waiting on a deferred that will never resolve would add the full
        // confirm timeout to every such launch.
        const submittedPrompt = deliveryResult.status === 'confirmed'
          ? await withTimeout(
            submitConfirmed,
            this.promptSubmitConfirmTimeoutMs ?? DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS,
            undefined,
          )
          : undefined;
        // Both sides need the same normalization or the check fires on healthy
        // launches. The hook body arrives folded to LF with surrounding
        // newlines stripped (`unwrapProviderUserPrompt`), so a CRLF brief — a
        // `gh`-fetched issue body, a Windows-authored playbook — would read as
        // one character short per line. What was actually written also had any
        // bracketed-paste markers stripped out of it. An empty body carries no
        // text to verify (the hook's documented shape for a signal-only
        // UserPromptSubmit) and is not evidence of loss.
        const received = normalizeUserPromptNewlines(submittedPrompt ?? '').trim();
        if (received.length > 0) {
          const sent = normalizeUserPromptNewlines(stripBracketedPasteMarkers(prompt)).trim();
          if (received.length < sent.length) {
            throw new InitialPromptTruncatedError(tmuxName, sent.length, received.length);
          }
          if (received !== sent) {
            // Not the truncation signature — the agent expanded or annotated
            // the prompt (launch warnings, file refs). Worth a breadcrumb,
            // not worth failing a launch that carries the full brief.
            console.warn(
              `[claude-code-adapter] submitted prompt differs from delivered prompt for ${tmuxName} `
              + `(sent ${sent.length} chars, received ${received.length}); not a truncation`,
            );
          }
        }
      } catch (err) {
        await this.cleanupFailedLaunch(tmuxName);
        throw err;
      } finally {
        // Free the resolver slot even if delivery throws — a later launch on
        // the same tmuxName (unlikely but possible) must not see a stale
        // already-resolved deferred.
        this.initialPromptSubmitResolvers.delete(tmuxName);
      }
    }

    if (opts?.signal?.aborted) {
      await this.cleanupFailedLaunch(tmuxName);
      throw new LaunchAbortedError(tmuxName);
    }
    // Phase instrumentation (issue #1589): ack — the prompt was acknowledged
    // (or resume needs none); register the session.
    opts?.onPhase?.('ack');
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

  private async cleanupFailedLaunch(tmuxName: string): Promise<void> {
    this.initialPromptSubmitResolvers.delete(tmuxName);
    this.settingsMap.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
    try {
      await this.backend.killSession(tmuxName);
    } catch {
      // Preserve the original launch failure. Backend errors are surfaced via
      // TerminalBackend diagnostics; launch callers need the prompt-delivery cause.
    }
  }

  /** Send developer input (text + Enter) to an agent's session. */
  async sendInput(tmuxName: string, text: string): Promise<void> {
    // Lead with Ctrl-U (clear line): keystrokes typed into the dashboard's
    // terminal panel but never submitted sit on the agent CLI's input line,
    // and without the clear they would be fused onto the front of this
    // message and submitted with it as one user_prompt (kookr F15). Ctrl-U
    // is a no-op on an empty composer line, so the common case is unchanged.
    // The clear is its own payload (with the inter-payload cushion) so the
    // TUI processes it as a keystroke instead of coalescing it into a fast
    // burst with the message text.
    //
    // Wrap the body in bracketed-paste markers, matching the launch-path
    // defence in deliverInitialPromptToSession. Claude Code's paste
    // heuristic is timing-based; when the TUI is busy it can drain text and
    // Enter together and absorb Enter as paste content. Explicit paste
    // markers keep the delayed trailing Enter an unambiguous submit key.
    await this.inputWriter.writeInputSequence(tmuxName, [
      CLEAR_LINE_BYTES,
      encodeBracketedPaste(text),
      ENTER_BYTES,
    ], { reason: 'adapter-send-input', interPayloadDelayMs: DEFAULT_PROMPT_SUBMIT_DELAY_MS });
  }

  /** Send a single keystroke without trailing Enter (for permission prompts). */
  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.inputWriter.writeInput(tmuxName, translateKeystroke(key), { reason: 'adapter-send-keystroke' });
  }

  /** Stop an agent by killing its session. */
  async stop(tmuxName: string): Promise<void> {
    // Release the in-flight launch waiter FIRST so that even if killSession
    // throws (dtach error, transient I/O fault) the launching promise still
    // unblocks. With the waiter still armed, a failed stop would leave the
    // launch hanging for up to `submitConfirmTimeoutMs * (submitRetries+1)`
    // waiting on a hook the dead session will never emit.
    const resolver = this.initialPromptSubmitResolvers.get(tmuxName);
    if (resolver) resolver();
    this.initialPromptSubmitResolvers.delete(tmuxName);
    await this.backend.killSession(tmuxName);
    this.settingsMap.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
  }

  /**
   * Install a deferred that resolves on the first parent `UserPromptSubmit`
   * hook for `tmuxName`. Returns the promise side; the resolver is held in
   * {@link initialPromptSubmitResolvers} and fired from
   * {@link injectHookEvent}. Idempotent: a pre-existing resolver is
   * cancelled (resolved) before being replaced, so a re-launch on the same
   * tmuxName cannot leak a never-resolved promise.
   */
  private armInitialPromptSubmitSignal(tmuxName: string): Promise<string | undefined> {
    const existing = this.initialPromptSubmitResolvers.get(tmuxName);
    if (existing) existing();
    return new Promise<string | undefined>((resolve) => {
      this.initialPromptSubmitResolvers.set(tmuxName, resolve);
    });
  }

  /** Capture the current terminal display as a decoded string. */
  async captureDisplay(tmuxName: string): Promise<string> {
    const bytes = await this.backend.captureBytes(tmuxName);
    return textDecoder.decode(bytes);
  }

  /**
   * Register an event handler for AgentEvents from hook events. Handlers
   * may declare 2 args (back-compat) or 3 args to receive the parentage-
   * carrying {@link EventMeta} envelope.
   */
  onEvent(handler: AdapterEventHandler): void {
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
   * Parses the JSON, classifies parentage, freezes parent metadata against
   * later distinct session ids, and emits the {@link AgentEvent} alongside
   * an {@link EventMeta} envelope. CWD/git refresh is applied only for
   * parent events so a child reviewer session cannot mutate parent state.
   * NEVER throws on a malformed payload — returns parseStatus='malformed'
   * so HookIngestion can record a diagnostic ledger row. See
   * rfc-activity-log-reliability §1–§3.
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
      // Known-shape JSON but unknown hook_event_name. Surface as 'dropped'.
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

    // Fire the launch-path submit signal on the first user_prompt that is
    // not classified as a child (subagent) session. Accept both 'parent' and
    // 'unknown': the hook command writes JSONL + HTTP POST and the HTTP POST
    // for UserPromptSubmit can race ahead of the SessionStart POST under load,
    // landing here before `classifyHookParentage` has a `parentSessionId` to
    // compare against. In that window classification returns 'unknown' even
    // though the launching session is the only one that could possibly be
    // emitting it. Excluding 'child' still keeps subagent prompts out, since
    // subagent SessionStart fires before its UserPromptSubmit on the same
    // child id and is what makes a child id known.
    if (event.type === 'user_prompt' && parentage !== 'child') {
      const resolver = this.initialPromptSubmitResolvers.get(tmuxName);
      if (resolver) {
        this.initialPromptSubmitResolvers.delete(tmuxName);
        // The hook payload is the ground truth for what the agent actually
        // received, and the launch path compares it against what it sent —
        // but only a definitively-`parent` prompt is safe to compare. The
        // `unknown` window above exists because a UserPromptSubmit POST can
        // beat its SessionStart, and a subagent's prompt can land in it; that
        // prompt is almost always shorter than a task brief, so treating it as
        // the agent's report would fail the launch and reap a healthy session.
        // Unknown parentage still confirms submission, it just carries no text
        // to verify.
        resolver(parentage === 'parent' ? event.prompt : undefined);
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

  /**
   * Lookup the per-Kookr-session ownership view, lazily hydrating from
   * persisted SessionInfo so server restarts and crash recovery see the
   * same frozen-parent semantics as a long-lived process.
   */
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

  /**
   * Get the generated settings for a tmux session (for testing).
   */
  getGeneratedSettings(tmuxName: string): HookSettings | undefined {
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

  private generateSettings(
    tmuxName: string,
    hookOutputDir: string,
    permissionAllowlist: string[],
    permissionDenylist: string[] = [],
  ): HookSettings {
    const hookFile = `${hookOutputDir}/${tmuxName}.jsonl`;

    // Dual-write: JSONL file (durable) + HTTP POST (fast). The Kookr hook
    // writer serializes large concurrent appends and forwards the same
    // payload to the server hook endpoint with fail-open behavior; if it
    // is missing on disk (e.g. fresh checkout pre-install), buildHookCommand
    // falls back to the legacy awk pipeline so the generated settings still
    // function. See rfc-activity-log-reliability §6.
    //
    // IMPORTANT: no trailing `&` — Claude Code runs hooks via non-interactive
    // bash, and `bash -c 'cmd &'` redirects stdin from /dev/null, so the hook
    // would read nothing.
    const hookCommand = buildHookCommand({
      tmuxName,
      hookFile,
      serverPort: this.serverPort,
      writerPath: resolveHookWriterPath(),
    });

    const cmd = { type: 'command', command: hookCommand };

    // Stop-hook nudge (RFC: rfc-agent-signal-surface §7) — a SECOND Stop hook
    // entry alongside the fire-and-forget writer. It reminds the agent (at most
    // once per task, hard fail-open) that it can raise an explicit completion
    // signal. Omitted entirely when the bundled script isn't on disk so we never
    // wire a broken command. See delivery-pragmatist review: it ships only now
    // that the `kookr signal` channel exists.
    const nudgePath = resolveStopNudgePath();
    const stopHooks = nudgePath
      ? [cmd, { type: 'command', command: buildStopNudgeCommand({ nudgePath }) }]
      : [cmd];

    return {
      hooks: {
        // Tool-name matchers — '*' matches all tool names
        SessionStart: [{ matcher: '*', hooks: [cmd] }],
        PreToolUse: [{ matcher: '*', hooks: [cmd] }],
        PostToolUse: [{ matcher: '*', hooks: [cmd] }],
        PostToolUseFailure: [{ matcher: '*', hooks: [cmd] }],
        PermissionRequest: [{ matcher: '*', hooks: [cmd] }],
        // No-matcher hooks — '' fires unconditionally
        Stop: [{ matcher: '', hooks: stopHooks }],
        StopFailure: [{ matcher: '', hooks: [cmd] }],
        Notification: [{ matcher: '', hooks: [cmd] }],
        UserPromptSubmit: [{ matcher: '', hooks: [cmd] }],
        SubagentStart: [{ matcher: '', hooks: [cmd] }],
        SubagentStop: [{ matcher: '', hooks: [cmd] }],
        SessionEnd: [{ matcher: '', hooks: [cmd] }],
      },
      // deny wins over allow in Claude Code's permission evaluation, so the
      // interactive-tool deny rules (issue #1562, unattended spawns only) hold
      // even alongside the always-present allowlist. Both keys are omitted when
      // empty so attended settings stay byte-identical to pre-#1562.
      permissions:
        permissionAllowlist.length > 0 || permissionDenylist.length > 0
          ? {
              ...(permissionAllowlist.length > 0 ? { allow: permissionAllowlist } : {}),
              ...(permissionDenylist.length > 0 ? { deny: permissionDenylist } : {}),
            }
          : undefined,
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
