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
import { composeGrokHome, type GrokHomeFs } from './grok-home-composer.js';
import {
  buildAllowlistedGrokEnv,
  buildGrokLaunchArgs,
  resolveGrokLaunchGate,
  resolveGrokModel,
  GROK_AGENT_BIN_ENV,
} from './grok-launch-args.js';
import { detectGrokBlockingStartupUI } from './grok-readiness.js';
import {
  resolveGrokInstalledState,
  type GrokInstalledState,
} from './grok-build-preflight.js';
import type { GrokMonitoringHooksConfig } from './grok-build-instrumentation/monitoring-hooks.js';
import { buildGrokMonitoringHooksConfig } from './grok-build-instrumentation/monitoring-hooks.js';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_READY_POLL_MS = 100;

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
  /** Configured model. Defaults to `KOOKR_GROK_MODEL` env or `grok-build`. */
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
}

/** Thrown when a Grok launch is refused before spawning (gate / qualification / auth-UI). */
export class GrokLaunchRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokLaunchRefusedError';
  }
}

/**
 * Experimental Grok Build adapter (issue #1343, RFC Issue 2). A COORDINATOR over
 * focused pure helpers — it does NOT subclass `ClaudeCodeAdapter` and adds no
 * speculative provider framework. It reuses the shared launch-context, prompt
 * delivery, parentage, input, hook-writer, and binary helpers by composition.
 *
 * POC-A constraints honored here: `GROK_HOME`-composed monitoring hooks (never
 * `--plugin-dir`, never a persistent `~/.grok` edit); a Grok-specific camelCase
 * hook decoder; child supervision via `subagent_start` correlation; an
 * allowlisted child environment; the exact resolved canonical binary path
 * re-checked immediately before launch; and build qualification derived solely
 * from the reviewed compatibility manifest.
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
  private promptSubmitConfirmTimeoutMs?: number;
  private promptSubmitRetries?: number;
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
    this.promptSubmitConfirmTimeoutMs = options?.promptSubmitConfirmTimeoutMs;
    this.promptSubmitRetries = options?.promptSubmitRetries;
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
        `is out of scope for the experimental adapter (Phase 1). Launching fresh.`,
      );
    }

    // Gate 1: experimental feature flag + new-launch kill switch.
    const gate = resolveGrokLaunchGate(this.env);
    if (!gate.allowed) throw new GrokLaunchRefusedError(gate.reason);

    // Gate 2: exact-binary identity + build qualification, re-resolved here so a
    // PATH swap or auto-update between preflight and launch cannot smuggle an
    // unqualified binary through (TOCTOU). Unknown builds are POC-runner-only.
    const state = await this.resolveInstalledState(true);
    if (state.kind === 'absent') {
      throw new GrokLaunchRefusedError(`Grok binary unavailable: ${state.reason}`);
    }
    if (state.qualification.status !== 'tested') {
      throw new GrokLaunchRefusedError(
        `Refusing to launch Grok on an unqualified build — ${state.qualification.reason}. ` +
        `Unknown builds may run only inside the POC runner.`,
      );
    }

    const tmuxName = opts?.tmuxName ?? `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    // Task-context env (KOOKR_* + launcher PATH), reused from the shared helper.
    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
    });

    // Compose an isolated per-session GROK_HOME: monitoring hooks + seeded auth
    // + linked toolkit plugins. Never mutates the real ~/.grok.
    const sessionRoot = await mkdtemp(join(this.sessionHomeRoot, `kookr-grok-${tmuxName}-`));
    const grokHome = join(sessionRoot, '.grok');
    this.sessionHomes.set(tmuxName, sessionRoot);
    const hookFile = `${this.hooksDir}/${tmuxName}.jsonl`;
    const monitoring = {
      tmuxName,
      hookFile,
      serverPort: this.serverPort,
      writerPath: resolveHookWriterPath(),
    };
    try {
      await composeGrokHome({ grokHome, sourceGrokHome: this.sourceGrokHome, monitoring, fs: this.homeFs });
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
    const env = buildAllowlistedGrokEnv({
      processEnv: this.env,
      launchContextEnv: launchContext.env,
      grokHome,
    });
    const args = buildGrokLaunchArgs({ model: this.model, bypassAllPermissions: this.bypassAllPermissions });

    await this.backend.createSession({
      id: tmuxName,
      command: state.identity.canonicalPath,
      args,
      env,
      envMode: 'replace',
      cwd,
      size: { cols: 200, rows: 50 },
    });

    // Ready-state probe + abort-on-unexpected-UI, THEN byte-level prompt delivery.
    const submitConfirmed = this.armInitialPromptSubmitSignal(tmuxName);
    try {
      await this.waitForReadyOrAbort(tmuxName);
      const awaitSubmit = (timeoutMs: number) => withTimeout(submitConfirmed.then(() => true), timeoutMs, false);
      let delivery = await deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
        inputWriter: this.inputWriter,
        bracketedPaste: this.promptBracketedPaste,
        waitForReady: this.promptBracketedPaste,
        awaitSubmit: this.promptBracketedPaste ? awaitSubmit : undefined,
        submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
        submitRetries: this.promptSubmitRetries,
        readyTimeoutMs: this.promptReadyTimeoutMs,
      });
      if (delivery.status === 'unconfirmed' && this.promptBracketedPaste) {
        // Fall back to the plain write+Enter path, keeping the same hook-backed
        // confirmation loop so text cannot be silently stranded in the composer.
        delivery = await deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
          inputWriter: this.inputWriter,
          bracketedPaste: false,
          awaitSubmit,
          submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
          submitRetries: this.promptSubmitRetries,
        });
      }
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    } finally {
      this.initialPromptSubmitResolvers.delete(tmuxName);
    }

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
        `${blocker}. Aborting rather than typing into it — check Grok authentication/entitlement ` +
        `(chat access requires a console.x.ai grant) or a pending CLI update.`,
      );
    }
    // `ready === false` here means the DECSET never arrived within the window;
    // delivery still proceeds fail-open (deliverInitialPromptToSession also
    // waits for the same signal and has a plain-write fallback).
    void ready;
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
    await this.backend.killSession(tmuxName);
    this.hookSettings.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
    await this.cleanupSessionHome(tmuxName);
  }

  async captureDisplay(tmuxName: string): Promise<string> {
    return textDecoder.decode(await this.backend.captureBytes(tmuxName));
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

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    const settings = this.hookSettings.get(tmuxName);
    if (!settings) return undefined;
    return { content: settings.config, agentType: this.agentType, settingsPath: settings.path };
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}
