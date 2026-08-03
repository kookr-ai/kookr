import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { ProbeExecRunner } from './probe-agent-binary.js';
import {
  childSessionStorageKey,
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
  type SessionRuntimeIdentity,
} from '../core/hook-parentage.js';
import { getGitInfo } from './git-info.js';
import {
  buildAgentLaunchContext,
  deliverInitialPromptToSession,
  isBracketedPasteModeEnabled,
  resolveBracketedPasteSubmit,
  DEFAULT_PROMPT_SUBMIT_DELAY_MS,
} from './agent-launch-context.js';
import { translateKeystroke, encodeBracketedPaste, ENTER_BYTES, CLEAR_LINE_BYTES } from './keystroke.js';
import { resolveHookWriterPath } from '../core/hook-writer-paths.js';
import { withTimeout } from '../core/with-timeout.js';
import { HookParseError } from '../core/hook-parser.js';
import { extractGrokHookHeader, parseGrokHookEvent, type RawGrokHookHeader } from './grok-hook-decoder.js';
import { readGrokHomeUsage, mapGrokUsageToTokenUsage } from './grok-rollout-scanner.js';
import { composeGrokHome, type GrokHomeFs } from './grok-home-composer.js';
import { formatGrokAuthPreflightFailure, inspectGrokAuthFile } from './grok-auth-preflight.js';
import {
  buildAllowlistedGrokEnv,
  buildGrokLaunchArgs,
  resolveGrokLaunchGate,
  resolveGrokModel,
  GROK_AGENT_BIN_ENV,
} from './grok-launch-args.js';
import {
  detectGrokBlockingStartupUI,
  detectGrokPermissionPromptUI,
  formatGrokPaneExcerpt,
  isGrokBusyOrResponding,
} from './grok-readiness.js';
import { normalizePaneForActivity } from '../shared/pane-semantics.js';
import {
  resolveGrokInstalledState,
  type GrokInstalledState,
} from './grok-build-preflight.js';
import type { GrokMonitoringHooksConfig } from './grok-build-instrumentation/monitoring-hooks.js';
import { buildGrokMonitoringHooksConfig } from './grok-build-instrumentation/monitoring-hooks.js';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_READY_POLL_MS = 100;
/**
 * Enter resends inside {@link deliverInitialPromptToSession}. Kept at 0 so the
 * first confirmation loop does not hammer Enter; in-session recovery uses
 * {@link DEFAULT_GROK_HANDSHAKE_RETRIES} instead (issue #1808). Busy chrome is
 * still sampled on the final attempt (assumed-submitted).
 */
const DEFAULT_GROK_PROMPT_SUBMIT_RETRIES = 0;
/**
 * In-session initial-prompt handshake retries after the first confirmation
 * loop returns `unconfirmed` (issue #1808). One extra wait (and optionally one
 * Enter resend when the pane still looks idle) is cheaper than cancelling the
 * whole task for the operator to respawn. Kept at 1 so we do not hammer a
 * stuck TUI with repeated resubmits. When the pane is already busy/responding
 * and the hook still never arrives, the launch assumes submission succeeded
 * rather than killing a live turn.
 */
export const DEFAULT_GROK_HANDSHAKE_RETRIES = 1;
/**
 * Marker the launch path waits on for initial-prompt acknowledgement. Logged
 * on timeout so failure diagnostics state what probe failed (issue #1808).
 */
export const GROK_INITIAL_PROMPT_ACK_MARKER = 'UserPromptSubmit hook (parent user_prompt)';
/**
 * Grok's command-hook acknowledgement can take many seconds (writer + HTTP +
 * cold session). The shared 2s Claude deadline is far too short; 10s still
 * under-covered cold boots where the model streams before the hook lands.
 * 30s per confirm attempt bounds worst-case wait while busy chrome can
 * short-circuit to assumed-submitted.
 */
export const DEFAULT_GROK_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Fixed cushion (ms) added on top of the nominal wait budget when computing
 * the default `agentBootTimeoutMs` below (issue #1642). Covers the
 * un-timed `backend.captureBytes` calls and cleanup work that run around the
 * timed waits themselves (blocking-startup-UI detection after the ready
 * wait, permission-prompt detection on an unconfirmed delivery,
 * `cleanupFailedLaunch`).
 */
export const AGENT_BOOT_TIMEOUT_MARGIN_MS = 10_000;

/**
 * Compute the default wall-clock bound for the grok-build `agent-boot`
 * phase (issue #1642: grok-build `POST /api/tasks` >90s launch hang).
 *
 * `agent-boot` runs {@link GrokBuildAdapter.waitForReadyOrAbort} (its own
 * `promptReadyTimeoutMs` poll for the bracketed-paste ready signal) followed
 * by `deliverInitialPromptToSession`, which — because `waitForReady` is
 * threaded through — polls for the SAME ready signal a second time
 * (`promptReadyTimeoutMs` again) before the submit-confirmation retries
 * (`promptSubmitConfirmTimeoutMs` per attempt, `promptSubmitRetries + 1`
 * attempts) plus up to `handshakeRetries` extra confirmation waits after an
 * unconfirmed delivery (issue #1808). Nominal budget:
 * `promptReadyTimeoutMs * 2 + promptSubmitConfirmTimeoutMs *
 * (promptSubmitRetries + 1 + handshakeRetries)`.
 *
 * That nominal sum is NOT a hard bound on its own: every wait in the chain
 * polls via `backend.captureBytes()`, and each individual `await` on that
 * call is not itself time-boxed — the `Date.now() <= deadline` check that
 * enforces each loop's timeout only runs BETWEEN awaits, so one hung/slow
 * capture (host contention, a wedged pty) can carry a "bounded" wait well
 * past its nominal deadline. When Grok is also showing a blocking startup
 * screen (auth/update/permission-row) instead of the ready composer, the
 * ready signal never arrives at all, so every wait in the chain runs to its
 * full nominal length AND is exposed to that per-await slippage — this is
 * the mechanism behind the reported `POST /api/tasks` holding >90s, up to
 * the 180s top-level `launchTimeoutSeconds` ceiling (#1528).
 *
 * {@link AGENT_BOOT_TIMEOUT_MARGIN_MS} is added as a cushion for the
 * un-timed work around those waits, and the whole `agent-boot` phase is then
 * raced against this deadline (see `launch()`) as a backstop that fires
 * regardless of what any individual internal await does — capping the phase
 * well below the 180s ceiling so a hung/blocked launch fails fast instead of
 * holding the request open.
 */
export function computeDefaultAgentBootTimeoutMs(
  promptReadyTimeoutMs: number,
  promptSubmitConfirmTimeoutMs: number,
  promptSubmitRetries: number,
  handshakeRetries: number = DEFAULT_GROK_HANDSHAKE_RETRIES,
): number {
  return (
    promptReadyTimeoutMs * 2 +
    promptSubmitConfirmTimeoutMs * (promptSubmitRetries + 1 + handshakeRetries) +
    AGENT_BOOT_TIMEOUT_MARGIN_MS
  );
}

/**
 * Race a promise against a wall-clock deadline (issue #1642), mirroring
 * `launch-service.ts`'s `raceLaunchAgainstTimeout` settle-once pattern at
 * adapter scale. On timeout the abandoned promise is NOT cancelled (this
 * layer exposes no abort hook either); its eventual settlement is observed
 * and swallowed — harmless because the caller's timeout catch always runs
 * `cleanupFailedLaunch` right after this rejects, so a late resolution has
 * nothing live left to attach to.
 */
async function raceWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(onTimeout());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      promise.then(
        () => { /* late success after abandonment — cleanupFailedLaunch already ran */ },
        () => { /* late rejection after abandonment — already surfaced via the timeout error */ },
      );
    }
  }
}

/**
 * Upper bound on the pane-tail substituted into a Grok stop/stop_failure
 * event's `lastMessage` (issue #1526 Phase C4). Grok's stop hook payload has
 * no final-assistant-message field, so the adapter falls back to a bounded
 * tail of the last captured display; 2000 chars comfortably covers a final
 * summary while keeping event payloads and fingerprints small.
 */
export const GROK_STOP_LAST_MESSAGE_MAX_CHARS = 2000;

/** Minimal, generic supervision status the RFC's Phase-1 slice exposes. */
export interface GrokSupervisionStatus {
  status: 'supported' | 'unsupported' | 'unknown';
  reason: string;
  /** The evidence build id from the reviewed manifest, when known. */
  evidenceBuildId?: string;
}

export interface GrokBuildAdapterOptions {
  terminalInputWriter?: TerminalInputWriterPort;
  /** Directory for durable per-session JSONL hook files. */
  hooksDir?: string;
  serverPort?: number;
  /** Grok binary path/command. Defaults to `KOOKR_GROK_BIN` env or `grok`. */
  agentBin?: string;
  /** Configured model. Defaults to `KOOKR_GROK_MODEL` env or `grok-4.5`. */
  model?: string;
  /** Explicit permission-bypass opt-in (mapped to `--permission-mode bypassPermissions`). */
  bypassAllPermissions?: boolean;
  /** The operator's real Grok home to seed auth + plugins from. Defaults to `~/.grok`. */
  sourceGrokHome?: string;
  /** Root directory under which per-session GROK_HOME dirs are created. Defaults to os tmpdir. */
  sessionHomeRoot?: string;
  /** Env source for the feature flag / kill switch / model resolution. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected `grok version` runner. */
  probeExec?: ProbeExecRunner;
  /** Test seam: injected fs for GROK_HOME composition. */
  homeFs?: Partial<GrokHomeFs>;
  /** Test seam: pre-resolved installed state (skips spawning `grok version`). */
  installedStateOverride?: GrokInstalledState;
  /** Whether to submit the initial prompt via bracketed paste. Defaults to true. */
  promptBracketedPaste?: boolean;
  promptReadyTimeoutMs?: number;
  promptSubmitConfirmTimeoutMs?: number;
  promptSubmitRetries?: number;
  /**
   * In-session handshake retries after the first confirmation loop returns
   * `unconfirmed` (issue #1808). Defaults to
   * {@link DEFAULT_GROK_HANDSHAKE_RETRIES}. Each attempt may re-await the
   * UserPromptSubmit signal and, when the pane still looks idle, resend Enter
   * once. Set to `0` to fail closed after the first confirmation timeout
   * (prior behaviour).
   */
  handshakeRetries?: number;
  /**
   * Wall-clock ceiling on the whole `agent-boot` phase — readiness wait +
   * initial-prompt delivery + submit-confirmation retries (issue #1642).
   * Defaults to {@link computeDefaultAgentBootTimeoutMs} of the configured
   * ready/confirm/retry knobs above, so overriding any of those also moves
   * the default deadline; set this explicitly to pin an independent bound.
   */
  agentBootTimeoutMs?: number;
}

/** Thrown when a Grok launch is refused before spawning (gate / qualification / auth-UI). */
export class GrokLaunchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokLaunchRefusedError';
  }
}

/** Auth cache failures are rendered with login-specific recovery guidance. */
export class GrokAuthPreflightError extends GrokLaunchRefusedError {
  readonly code = 'grok_auth_preflight';

  constructor(message: string) {
    super(message);
    this.name = 'GrokAuthPreflightError';
  }
}

/**
 * Thrown when the grok-build `agent-boot` phase (readiness wait + initial
 * prompt delivery + submit-confirmation) exceeds its wall-clock bound
 * (issue #1642). Unlike {@link GrokLaunchRefusedError}, this fires AFTER the
 * terminal session was already created — it is the backstop against a
 * hung/blocked launch (Grok showing a blocking startup screen, or a wedged
 * terminal capture) holding `POST /api/tasks` open indefinitely.
 */
export class GrokAgentBootTimeoutError extends Error {
  readonly code = 'grok_agent_boot_timeout';
  constructor(taskId: string, tmuxName: string, timeoutMs: number) {
    super(
      `[grok-build-adapter] agent-boot did not complete within ${Math.round(timeoutMs / 1000)}s ` +
      `(task ${taskId}, session ${tmuxName}) — Grok may be showing a blocking startup screen ` +
      `(auth/update/permission-row) or the terminal capture is wedged. Aborting the launch ` +
      `rather than holding POST /api/tasks open.`,
    );
    this.name = 'GrokAgentBootTimeoutError';
  }
}

/** Type guard for {@link GrokAgentBootTimeoutError}. */
export function isGrokAgentBootTimeoutError(err: unknown): err is GrokAgentBootTimeoutError {
  return err instanceof GrokAgentBootTimeoutError;
}

/**
 * Grok Build adapter (issue #1343, RFC Issue 2). A COORDINATOR over
 * focused pure helpers — it does NOT subclass `ClaudeCodeAdapter` and adds no
 * speculative provider framework. It reuses the shared launch-context, prompt
 * delivery, parentage, input, hook-writer, and binary helpers by composition.
 *
 * POC-A constraints honored here: `GROK_HOME`-composed monitoring hooks (never
 * `--plugin-dir`, never a persistent `~/.grok` edit); a Grok-specific camelCase
 * hook decoder; child supervision via `subagent_start` correlation; an
 * allowlisted child environment; the exact resolved canonical binary path
 * re-checked immediately before launch; and advisory build qualification
 * derived from the reviewed compatibility manifest.
 *
 * Unattended interactive-tool denial (issue #1562): NOT YET IMPLEMENTED here.
 * Grok composes hooks via `GROK_HOME` rather than a Claude-style
 * `permissions.deny` block, so the deterministic settings deny used by the
 * Claude Code adapter has no direct analogue; the equivalent would be a
 * PreToolUse-style deny hook in the composed `GROK_HOME` that refuses Grok's
 * interactive-prompt tool for `task.unattended` spawns. The server-side
 * operator-needed flag (interactive-deny-processor) is adapter-agnostic in
 * mechanism, but only matches tool names listed in `INTERACTIVE_TOOL_NAMES`
 * (`operator-needed.ts`) — currently just Claude's `AskUserQuestion`. To cover
 * Grok, add its interactive-prompt tool name to that single-source list
 * alongside implementing the deny above.
 */
export class GrokBuildAdapter implements AgentAdapter {
  readonly agentType = 'grok-build';
  private eventHandlers: Array<AdapterEventHandler> = [];
  private refreshHandlers: Array<() => void> = [];
  private tmuxToTaskId = new Map<string, string>();
  private identities = new Map<string, SessionRuntimeIdentity>();
  private sequenceCounters = new Map<string, number>();
  private hookSettings = new Map<string, { config: GrokMonitoringHooksConfig; path: string }>();
  private sessionHomes = new Map<string, string>();
  private initialPromptSubmitResolvers = new Map<string, () => void>();
  /**
   * Last captured display per session, refreshed by {@link captureDisplay}
   * (the server's 5s watchdog tick calls it for every tracked agent). Used
   * synchronously by {@link injectHookEvent} to substitute a bounded pane
   * tail into Grok stop events, whose payloads carry no final message.
   */
  private lastDisplays = new Map<string, string>();

  private inputWriter: TerminalInputWriterPort;
  private hooksDir: string;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private model: string;
  private bypassAllPermissions: boolean;
  private sourceGrokHome: string;
  private sessionHomeRoot: string;
  private env: NodeJS.ProcessEnv;
  private probeExec?: ProbeExecRunner;
  private homeFs?: Partial<GrokHomeFs>;
  private installedStateOverride?: GrokInstalledState;
  private promptBracketedPaste: boolean;
  private promptReadyTimeoutMs: number;
  private promptSubmitConfirmTimeoutMs: number;
  private promptSubmitRetries: number;
  private handshakeRetries: number;
  private agentBootTimeoutMs: number;
  /** Memoized installed-state resolution (identity + qualification). */
  private installedStateProbe?: Promise<GrokInstalledState>;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: GrokBuildAdapterOptions,
  ) {
    this.env = options?.env ?? process.env;
    this.inputWriter = options?.terminalInputWriter ?? asTerminalInputWriterPort(backend);
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.serverPort = options?.serverPort;
    this.agentBin = options?.agentBin ?? this.env[GROK_AGENT_BIN_ENV] ?? 'grok';
    this.agentBinConfiguredVia = options?.agentBin || this.env[GROK_AGENT_BIN_ENV] ? 'env' : 'default';
    this.model = options?.model ?? resolveGrokModel(this.env);
    this.bypassAllPermissions = options?.bypassAllPermissions ?? false;
    this.sourceGrokHome = options?.sourceGrokHome ?? join(homedir(), '.grok');
    this.sessionHomeRoot = options?.sessionHomeRoot ?? tmpdir();
    this.probeExec = options?.probeExec;
    this.homeFs = options?.homeFs;
    this.installedStateOverride = options?.installedStateOverride;
    this.promptBracketedPaste = resolveBracketedPasteSubmit(options?.promptBracketedPaste, this.env);
    this.promptReadyTimeoutMs = options?.promptReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.promptSubmitConfirmTimeoutMs =
      options?.promptSubmitConfirmTimeoutMs ?? DEFAULT_GROK_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS;
    // Intra-delivery Enter resends stay fail-closed (Grok has no Claude-style
    // busy markers in deliverInitialPromptToSession). In-session handshake
    // recovery after that loop uses {@link isGrokBusyOrResponding} instead
    // (issue #1808).
    this.promptSubmitRetries = options?.promptSubmitRetries ?? DEFAULT_GROK_PROMPT_SUBMIT_RETRIES;
    this.handshakeRetries = options?.handshakeRetries ?? DEFAULT_GROK_HANDSHAKE_RETRIES;
    this.agentBootTimeoutMs =
      options?.agentBootTimeoutMs ??
      computeDefaultAgentBootTimeoutMs(
        this.promptReadyTimeoutMs,
        this.promptSubmitConfirmTimeoutMs,
        this.promptSubmitRetries,
        this.handshakeRetries,
      );
  }

  /** Resolve installed identity/qualification (memoized). */
  private resolveInstalledState(force = false): Promise<GrokInstalledState> {
    if (this.installedStateOverride) return Promise.resolve(this.installedStateOverride);
    if (force || this.installedStateProbe === undefined) {
      this.installedStateProbe = resolveGrokInstalledState({
        agentBin: this.agentBin,
        exec: this.probeExec,
        env: this.env,
      });
    }
    return this.installedStateProbe;
  }

  /**
   * Startup binary preflight — installed-agent IDENTITY only (RFC §3.1). Reports
   * the exact canonical path + build id; does NOT perform auth/model/region
   * checks (those are launch readiness) and does NOT gate on qualification (an
   * installed-but-unqualified build is still "present" — {@link
   * supervisionStatus} reports it unsupported, and {@link launch} refuses it).
   */
  async preflight(): Promise<PreflightResult> {
    const state = await this.resolveInstalledState();
    if (state.kind === 'absent') {
      return {
        kind: 'absent',
        reason: state.reason,
        configuredVia: this.agentBinConfiguredVia,
        envVarName: GROK_AGENT_BIN_ENV,
      };
    }
    return {
      kind: 'ok',
      resolvedPath: state.identity.canonicalPath,
      version: state.version,
      canonicalPath: state.identity.canonicalPath,
      buildId: state.buildId,
      identity: state.identity,
    };
  }

  /**
   * Minimal generic supervision status (RFC §3): `supported | unsupported |
   * unknown`, a reason, and the evidence build id. Composes the feature gate,
   * binary presence, and manifest qualification.
   */
  async supervisionStatus(): Promise<GrokSupervisionStatus> {
    const gate = resolveGrokLaunchGate(this.env);
    const state = await this.resolveInstalledState();
    if (state.kind === 'absent') {
      return { status: 'unsupported', reason: `Grok binary unavailable: ${state.reason}` };
    }
    const q = state.qualification;
    const gatePrefix = gate.allowed ? '' : `${gate.reason} `;
    if (q.status === 'tested') {
      return {
        status: gate.allowed ? 'supported' : 'unsupported',
        reason: `${gatePrefix}${q.reason}`.trim(),
        evidenceBuildId: q.evidenceBuildId,
      };
    }
    if (q.status === 'known-incompatible') {
      return { status: 'unsupported', reason: `${gatePrefix}${q.reason}`.trim(), evidenceBuildId: q.evidenceBuildId };
    }
    return { status: 'unknown', reason: `${gatePrefix}${q.reason}`.trim(), evidenceBuildId: q.evidenceBuildId };
  }

  async launch(
    taskId: string,
    prompt: string,
    cwd: string,
    resume?: ResumeContext,
    opts?: AdapterLaunchOptions,
  ): Promise<string> {
    // Resume is disabled in Phase 1 (POC-B concern). Launch fresh with a warning.
    if (resume?.sessionId) {
      console.warn(
        `[grok-build-adapter] Ignoring resume request for ${taskId}: Grok resume ` +
        `is not yet implemented for the Grok Build adapter. Launching fresh.`,
      );
    }

    // Gate 1: new-launch kill switch.
    const gate = resolveGrokLaunchGate(this.env);
    if (!gate.allowed) throw new GrokLaunchRefusedError(gate.reason);

    // Binary identity + build qualification, re-resolved here so a PATH swap or
    // auto-update between preflight and launch is observed (TOCTOU). Since GA,
    // qualification is ADVISORY: a build that doesn't match the reviewed
    // compatibility manifest still launches, with a warning that supervision
    // behavior was not verified for it (supervisionStatus reports the same).
    const state = await this.resolveInstalledState(true);
    if (state.kind === 'absent') {
      throw new GrokLaunchRefusedError(`Grok binary unavailable: ${state.reason}`);
    }
    if (state.qualification.status !== 'tested') {
      console.warn(
        `[grok-build-adapter] Launching on an unqualified Grok build — ` +
        `${state.qualification.reason}. Supervision behavior (hooks, outcome ` +
        `classification) was not verified against this build.`,
      );
    }

    const tmuxName = opts?.tmuxName ?? `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    // Phase instrumentation (issue #1589): session-create spans the whole
    // pre-terminal setup — launch-context build, the per-session GROK_HOME
    // composition (mkdtemp + composeGrokHome copy) and auth preflight, and the
    // terminal createSession. If the grok-build `POST /api/tasks` >90s hang is
    // in this setup rather than in Grok's boot, the timings pin it to this phase.
    opts?.onPhase?.('session-create');
    // Task-context env (KOOKR_* + launcher PATH), reused from the shared helper.
    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
      sessionName: tmuxName,
    });

    // Compose an isolated per-session GROK_HOME: monitoring hooks + linked
    // toolkit plugins. Credentials stay on the operator's real ~/.grok/auth.json
    // (shared via GROK_AUTH_PATH) so N agents do not clone one rotating OIDC RT.
    const sessionRoot = await mkdtemp(join(this.sessionHomeRoot, `kookr-grok-${tmuxName}-`));
    const grokHome = grokHomeFor(sessionRoot);
    this.sessionHomes.set(tmuxName, sessionRoot);
    const hookFile = `${this.hooksDir}/${tmuxName}.jsonl`;
    const monitoring = {
      tmuxName,
      hookFile,
      serverPort: this.serverPort,
      writerPath: resolveHookWriterPath(),
    };
    let authPath: string;
    try {
      const composed = await composeGrokHome({
        grokHome,
        sourceGrokHome: this.sourceGrokHome,
        monitoring,
        fs: this.homeFs,
      });
      const sharedAuthPath = composed.authPath ?? join(this.sourceGrokHome, 'auth.json');
      const authPreflight = await inspectGrokAuthFile(sharedAuthPath);
      if (authPreflight.kind !== 'ok') {
        throw new GrokAuthPreflightError(formatGrokAuthPreflightFailure(sharedAuthPath, authPreflight));
      }
      authPath = sharedAuthPath;
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    }
    this.hookSettings.set(tmuxName, {
      config: buildGrokMonitoringHooksConfig(monitoring),
      path: join(grokHome, 'hooks', 'kookr-monitoring.json'),
    });

    // Allowlisted child env (server secrets excluded) + interactive argv. We exec
    // the EXACT resolved canonical path, not the launcher symlink.
    // Honor the caller-supplied env extension (AdapterLaunchOptions.extraEnv) so
    // Ralph loops can inject RALPH_VERDICT_FILE / RALPH_ITERATION, matching the
    // Claude/Codex adapters. It layers above the allowlist base and task context
    // but below the security-critical GROK_* control vars and the XAI_API_KEY
    // scrub, so honoring it cannot widen the secret surface (issue #1366).
    const env = buildAllowlistedGrokEnv({
      processEnv: this.env,
      launchContextEnv: launchContext.env,
      extraEnv: opts?.extraEnv,
      grokHome,
      authPath,
    });
    // A per-call `bypassPermissions` override wins over the constructor-time
    // default for THIS launch only; when unset the instance default applies.
    const bypassPermissions = opts?.bypassPermissions ?? this.bypassAllPermissions;
    const args = buildGrokLaunchArgs({ model: this.model, bypassAllPermissions: bypassPermissions });

    await this.backend.createSession({
      id: tmuxName,
      command: state.identity.canonicalPath,
      args,
      env,
      envMode: 'replace',
      cwd,
      size: { cols: 200, rows: 50 },
    });

    // Phase instrumentation (issue #1589): agent-boot covers Grok's TUI
    // readiness wait (waitForReadyOrAbort polls up to promptReadyTimeoutMs) and
    // the byte-level prompt delivery below.
    opts?.onPhase?.('agent-boot');
    // Ready-state probe + abort-on-unexpected-UI, THEN byte-level prompt
    // delivery — raced against agentBootTimeoutMs (issue #1642) so a
    // hung/blocked launch (blocking startup UI, or a wedged terminal
    // capture) fails fast instead of holding POST /api/tasks open for up to
    // the 180s top-level launch timeout.
    const submitConfirmed = this.armInitialPromptSubmitSignal(tmuxName);
    try {
      await raceWithDeadline(
        this.runAgentBootSequence(tmuxName, prompt, submitConfirmed),
        this.agentBootTimeoutMs,
        () => new GrokAgentBootTimeoutError(taskId, tmuxName, this.agentBootTimeoutMs),
      );
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    } finally {
      this.initialPromptSubmitResolvers.delete(tmuxName);
    }

    // Phase instrumentation (issue #1589): ack — Grok acknowledged the prompt.
    opts?.onPhase?.('ack');
    this.taskStore.addSession(taskId, {
      tmuxSession: tmuxName,
      agentType: 'grok-build',
      cwd,
      createdAt: new Date(),
    });

    getGitInfo(cwd)
      .then((info) => {
        if (info) {
          this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
          for (const handler of this.refreshHandlers) handler();
        }
      })
      .catch(() => { /* graceful degradation */ });

    return tmuxName;
  }

  /**
   * Wait for Grok's TUI to signal readiness (`ESC[?2004h`, the bracketed-paste
   * enable it emits at startup — POC-A pty capture), then abort if the captured
   * screen is an auth/update UI rather than the ready composer. Fail-open on the
   * ready wait (proceed on timeout) but fail-closed on a detected auth screen.
   */
  private async waitForReadyOrAbort(tmuxName: string): Promise<void> {
    const deadline = Date.now() + this.promptReadyTimeoutMs;
    let ready = false;
    while (Date.now() <= deadline) {
      const bytes = await this.backend.captureBytes(tmuxName);
      if (isBracketedPasteModeEnabled(bytes)) { ready = true; break; }
      await sleep(Math.min(DEFAULT_READY_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    const display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
    const blocker = detectGrokBlockingStartupUI(display);
    if (blocker) {
      await this.cleanupFailedLaunch(tmuxName);
      throw new GrokLaunchRefusedError(
        `${blocker}. Auth preflight passed, but Grok displayed a blocking startup screen. ` +
        `Aborting rather than typing into it — check Grok authentication/entitlement ` +
        `(chat access requires a console.x.ai grant) or a pending CLI update.`,
      );
    }
    // `ready === false` here means the DECSET never arrived within the window;
    // delivery still proceeds fail-open, while the hook-backed confirmation
    // guard refuses to resend an unacknowledged prompt.
    void ready;
  }

  /**
   * The `agent-boot` sequence: ready-state probe + abort-on-unexpected-UI,
   * then byte-level prompt delivery. Extracted from `launch()` so it can be
   * raced against `agentBootTimeoutMs` (issue #1642) — the caller wraps this
   * in {@link raceWithDeadline} and runs `cleanupFailedLaunch` on either a
   * thrown error from here or a timeout from the race.
   */
  private async runAgentBootSequence(
    tmuxName: string,
    prompt: string,
    submitConfirmed: Promise<void>,
  ): Promise<void> {
    await this.waitForReadyOrAbort(tmuxName);
    const awaitSubmit = (timeoutMs: number) => withTimeout(submitConfirmed.then(() => true), timeoutMs, false);
    const delivery = await deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
      inputWriter: this.inputWriter,
      bracketedPaste: this.promptBracketedPaste,
      waitForReady: this.promptBracketedPaste,
      awaitSubmit: this.promptBracketedPaste ? awaitSubmit : undefined,
      submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
      submitRetries: this.promptSubmitRetries,
      readyTimeoutMs: this.promptReadyTimeoutMs,
    });
    if (delivery.status !== 'unconfirmed') return;

    // First confirmation loop timed out. Capture the pane for diagnosis, then
    // optionally retry the handshake once in-session (issue #1808) before
    // failing the launch — cheaper than cancelling the task for an operator
    // respawn. Permission menus still fail immediately (retry cannot help).
    let display = '';
    try {
      display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
    } catch {
      /* diagnosis is best-effort — never mask the delivery failure */
    }
    const permissionPrompt = display ? detectGrokPermissionPromptUI(display) : null;
    if (permissionPrompt) {
      throw new Error(this.formatUnconfirmedPromptError(permissionPrompt, display));
    }

    console.warn(
      `[grok-build-adapter] initial-prompt ack pending for ${tmuxName}: ` +
        `waiting for ${GROK_INITIAL_PROMPT_ACK_MARKER}; ` +
        `pane excerpt: ${formatGrokPaneExcerpt(display)}`,
    );

    for (let attempt = 0; attempt < this.handshakeRetries; attempt += 1) {
      let busy = false;
      try {
        display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
        busy = isGrokBusyOrResponding(display);
      } catch {
        /* treat capture failure as idle — a no-op Enter is safer than a stuck launch */
      }
      if (busy) {
        // Permission menus are "busy" for retry-Enter safety but are NOT a
        // successful prompt accept — fail closed so the operator can resolve.
        const midPermission = detectGrokPermissionPromptUI(display);
        if (midPermission) {
          throw new Error(this.formatUnconfirmedPromptError(midPermission, display));
        }
        // Streaming/Thinking: give the hook a short window, then assume
        // success. Do NOT burn a full confirm timeout or kill a live turn
        // when the hook never arrives — overnight PR droughts were mass
        // launch_error on sessions already working while UserPromptSubmit
        // stayed silent (auth preflight OK).
        const busyAckMs = Math.min(3_000, this.promptSubmitConfirmTimeoutMs);
        if (await awaitSubmit(busyAckMs)) return;
        console.warn(
          `[grok-build-adapter] assuming initial prompt submitted for ${tmuxName}: ` +
            `pane is busy/responding but ${GROK_INITIAL_PROMPT_ACK_MARKER} never arrived; ` +
            `pane excerpt: ${formatGrokPaneExcerpt(display)}`,
        );
        return;
      }
      // Still looks idle: the first Enter may have been dropped. Resend
      // Enter once, then re-await the same UserPromptSubmit signal.
      try {
        await this.inputWriter.writeInput(tmuxName, ENTER_BYTES, {
          reason: 'launch-prompt-handshake-retry-enter',
        });
      } catch (err) {
        console.warn(
          `[grok-build-adapter] handshake retry Enter failed for ${tmuxName}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (await awaitSubmit(this.promptSubmitConfirmTimeoutMs)) return;
      // Re-check busy after the retry window — Grok may have started
      // streaming without emitting the hook. Permission menus are "busy"
      // for Enter safety but must still fail closed (same as mid-busy /
      // final assumed-submit paths).
      try {
        display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
        if (isGrokBusyOrResponding(display)) {
          const afterRetryPermission = detectGrokPermissionPromptUI(display);
          if (afterRetryPermission) {
            throw new Error(this.formatUnconfirmedPromptError(afterRetryPermission, display));
          }
          console.warn(
            `[grok-build-adapter] assuming initial prompt submitted for ${tmuxName}: ` +
              `pane became busy after handshake retry ${attempt + 1}; ` +
              `pane excerpt: ${formatGrokPaneExcerpt(display)}`,
          );
          return;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('[grok-build-adapter]')) throw err;
        /* keep prior display on capture failure */
      }
      console.warn(
        `[grok-build-adapter] handshake retry ${attempt + 1}/${this.handshakeRetries} ` +
          `for ${tmuxName} still unconfirmed (busy=${busy}); ` +
          `pane excerpt: ${formatGrokPaneExcerpt(display)}`,
      );
    }

    // Final capture for the thrown error body (may have changed during retries).
    try {
      display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
    } catch {
      /* keep prior display */
    }
    // Last-chance assumed-submit: streaming/Thinking with zero hook ack is
    // still a successful delivery. Permission menus stay fail-closed.
    if (display && isGrokBusyOrResponding(display)) {
      const finalPermission = detectGrokPermissionPromptUI(display);
      if (finalPermission) {
        throw new Error(this.formatUnconfirmedPromptError(finalPermission, display));
      }
      console.warn(
        `[grok-build-adapter] assuming initial prompt submitted for ${tmuxName}: ` +
          `final pane is busy/responding without ${GROK_INITIAL_PROMPT_ACK_MARKER}; ` +
          `pane excerpt: ${formatGrokPaneExcerpt(display)}`,
      );
      return;
    }
    throw new Error(this.formatUnconfirmedPromptError(null, display));
  }

  /**
   * Build the unconfirmed-initial-prompt error (issue #1808). Always names the
   * acknowledgement marker and includes a pane excerpt so operators can see
   * what the TUI actually showed at timeout without log spelunking.
   */
  private formatUnconfirmedPromptError(
    permissionPrompt: string | null,
    display: string,
  ): string {
    const excerpt = formatGrokPaneExcerpt(display);
    return (
      `[grok-build-adapter] Grok did not acknowledge the initial prompt within ` +
      `${this.promptSubmitConfirmTimeoutMs}ms ` +
      `(waiting for ${GROK_INITIAL_PROMPT_ACK_MARKER}); refusing to resend it. ` +
      (permissionPrompt
        ? `${permissionPrompt} — resolve it in the terminal before relaunching. `
        : '') +
      `Auth preflight passed; inspect Grok terminal/PTY readiness and hook dispatch ` +
      `(including terminal query handling). Pane excerpt: ${excerpt}`
    );
  }

  private armInitialPromptSubmitSignal(tmuxName: string): Promise<void> {
    const existing = this.initialPromptSubmitResolvers.get(tmuxName);
    if (existing) existing();
    return new Promise<void>((resolve) => {
      this.initialPromptSubmitResolvers.set(tmuxName, resolve);
    });
  }

  private async cleanupFailedLaunch(tmuxName: string): Promise<void> {
    this.initialPromptSubmitResolvers.delete(tmuxName);
    this.hookSettings.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
    this.lastDisplays.delete(tmuxName);
    try {
      await this.backend.killSession(tmuxName);
    } catch {
      /* preserve the original failure */
    }
    await this.cleanupSessionHome(tmuxName);
  }

  private async cleanupSessionHome(tmuxName: string): Promise<void> {
    const root = this.sessionHomes.get(tmuxName);
    this.sessionHomes.delete(tmuxName);
    if (!root) return;
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  async sendInput(tmuxName: string, text: string): Promise<void> {
    await this.inputWriter.writeInputSequence(
      tmuxName,
      [CLEAR_LINE_BYTES, encodeBracketedPaste(text), ENTER_BYTES],
      { reason: 'adapter-send-input', interPayloadDelayMs: DEFAULT_PROMPT_SUBMIT_DELAY_MS },
    );
  }

  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.inputWriter.writeInput(tmuxName, translateKeystroke(key), { reason: 'adapter-send-keystroke' });
  }

  /**
   * Stop the session, draining the owned process tree (the backend's
   * TERM→wait→KILL escalation covers subagent/MCP children — POC-A gate 11
   * confirmed a SIGKILL of the owned tree drains every descendant). Also
   * releases any in-flight launch waiter and removes the composed GROK_HOME.
   */
  async stop(tmuxName: string): Promise<void> {
    const resolver = this.initialPromptSubmitResolvers.get(tmuxName);
    if (resolver) resolver();
    this.initialPromptSubmitResolvers.delete(tmuxName);
    // Extract token telemetry BEFORE the ephemeral GROK_HOME is torn down —
    // this is the last point at which the session transcript still exists.
    await this.recordSessionTokenUsage(tmuxName);
    await this.backend.killSession(tmuxName);
    this.hookSettings.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
    this.lastDisplays.delete(tmuxName);
    await this.cleanupSessionHome(tmuxName);
  }

  /**
   * Read Grok's per-turn token telemetry from the session's transcripts and
   * record it on the owning task (issue #1581). Grok writes `turn_completed`
   * usage into `<GROK_HOME>/sessions/**​/updates.jsonl`; the managed home is an
   * ephemeral per-session directory that {@link cleanupSessionHome} deletes on
   * stop, so this runs at teardown while the transcript is still present. The
   * mapping mirrors the Codex rollout-metering conversion so the recorded
   * {@link import('../core/types.js').TokenUsage} shape is identical across
   * adapters. Best-effort: a missing/unparseable transcript leaves `tokenUsage`
   * unset (marked unavailable downstream) rather than failing teardown.
   */
  private async recordSessionTokenUsage(tmuxName: string): Promise<void> {
    const sessionRoot = this.sessionHomes.get(tmuxName);
    if (!sessionRoot) return;
    const taskId = this.tmuxToTaskId.get(tmuxName) ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (!taskId) return;
    try {
      const usage = await readGrokHomeUsage(grokHomeFor(sessionRoot));
      if (!usage) return;
      if (!this.taskStore.getTask(taskId)) return;
      this.taskStore.updateTokenUsage(taskId, mapGrokUsageToTokenUsage(usage));
      for (const handler of this.refreshHandlers) handler();
    } catch {
      /* telemetry is best-effort — never block teardown on a scan failure */
    }
  }

  async captureDisplay(tmuxName: string): Promise<string> {
    const display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
    this.lastDisplays.set(tmuxName, display);
    return display;
  }

  /**
   * Bounded pane-tail fallback for Grok stop/stop_failure `lastMessage`
   * (issue #1526 Phase C4). Live Grok payloads usually include
   * `lastAssistantMessage` (decoded into `lastMessage`); this path only runs
   * when that field is empty so completion-signal classification (#1324) is
   * not starved. The best synchronous source is the last captured display
   * (refreshed at most 5s ago by the watchdog tick): volatile UI rows are
   * stripped via the shared pane normalizer, then the tail is capped at
   * {@link GROK_STOP_LAST_MESSAGE_MAX_CHARS}.
   */
  private paneTailLastMessage(tmuxName: string): string {
    const display = this.lastDisplays.get(tmuxName);
    if (!display) return '';
    const normalized = normalizePaneForActivity(display);
    return normalized.slice(-GROK_STOP_LAST_MESSAGE_MAX_CHARS).trim();
  }

  onEvent(handler: AdapterEventHandler): void {
    this.eventHandlers.push(handler);
  }

  onRefreshNeeded(handler: () => void): void {
    this.refreshHandlers.push(handler);
  }

  /**
   * Decode + normalize a raw Grok hook payload and dispatch it. Uses the
   * Grok-specific camelCase decoder (NOT Claude's snake_case parser). NEVER
   * throws on malformed/forged/oversized payloads — returns a diagnostic
   * parseStatus so HookIngestion records a ledger row. Parentage reuses the
   * shared frozen-parent classifier, so a subagent's distinct `sessionId`
   * (== its `subagentId`) is gated out of parent activity.
   */
  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    externalSequence?: number,
    options?: { origin?: EventOrigin },
  ): InjectHookEventResult {
    const observedAt = Date.now();
    const observedAtIso = new Date(observedAt).toISOString();

    let header: RawGrokHookHeader;
    try {
      header = extractGrokHookHeader(rawJson);
    } catch (err) {
      const reason = err instanceof HookParseError ? err.message : String(err);
      return { parseStatus: 'malformed', agentType: this.agentType, error: reason };
    }

    let event: AgentEvent | null;
    try {
      event = parseGrokHookEvent(rawJson);
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

    // When lastAssistantMessage is missing/empty, substitute a bounded pane
    // tail (issue #1526 Phase C4). Replays are left untouched: at replay time
    // the pane no longer shows the original turn, and enriching from the
    // CURRENT pane would change completion-signal fingerprints across restarts.
    if (
      (event.type === 'stop' || event.type === 'stop_failure')
      && event.lastMessage === ''
      && options?.origin !== 'replay'
    ) {
      const tail = this.paneTailLastMessage(tmuxName);
      if (tail) event = { ...event, lastMessage: tail };
    }

    const taskId = this.tmuxToTaskId.get(tmuxName) ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (taskId && !this.tmuxToTaskId.has(tmuxName)) this.tmuxToTaskId.set(tmuxName, taskId);
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
          this.taskStore.recordChildSession(
            taskId,
            tmuxName,
            childSessionStorageKey(identity, rawSessionId, event.transcriptPath),
            { firstSeenAt: observedAtIso, transcriptPath: event.transcriptPath, reason: 'inherited_settings' },
          );
        }
      }
    } else {
      parentage = classifyHookParentage(rawSessionId, identity, header.rawTranscriptPath);
    }

    // Best-effort cwd/git refresh on a parent cwd change (Grok tool names are
    // not Claude's, so no tool-name git inference is attempted here).
    if (parentage === 'parent' && taskId && 'cwd' in event && event.cwd) {
      const task = this.taskStore.getTask(taskId);
      const session = task?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session && event.cwd !== session.cwd) {
        const nextCwd = event.cwd;
        this.taskStore.updateSessionCwd(taskId, tmuxName, nextCwd);
        getGitInfo(nextCwd)
          .then((info) => {
            if (info) {
              this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
              for (const handler of this.refreshHandlers) handler();
            }
          })
          .catch(() => { /* graceful degradation */ });
      }
    }

    // Fire the launch-path submit signal on the first non-child user_prompt.
    if (event.type === 'user_prompt' && parentage !== 'child') {
      const resolver = this.initialPromptSubmitResolvers.get(tmuxName);
      if (resolver) {
        this.initialPromptSubmitResolvers.delete(tmuxName);
        resolver();
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

    for (const handler of this.eventHandlers) handler(tmuxName, event, meta);

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

  getActiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    const settings = this.hookSettings.get(tmuxName);
    if (!settings) return undefined;
    return { content: settings.config, agentType: this.agentType, settingsPath: settings.path };
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    return this.getActiveHookSettings(tmuxName);
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

/**
 * The composed `GROK_HOME` inside a per-session root (`<sessionRoot>/.grok`).
 * `sessionHomes` stores the session root (the whole tree {@link
 * GrokBuildAdapter.cleanupSessionHome} removes); both the launch composer and
 * the stop-time metering read the `.grok` subdirectory, so the layout is
 * derived here once.
 */
function grokHomeFor(sessionRoot: string): string {
  return join(sessionRoot, '.grok');
}
