/**
 * OpenCodeAdapter (RFC rfc-opencode-agent-integration §2-§4).
 *
 * Launches the interactive opencode TUI in a managed terminal session with a
 * per-session composed config/data/plugin directory. The generated plugin pipes
 * Claude-shaped hook payloads into `kookr-hook-writer`, so inbound events reuse
 * the Claude hook normaliser (`parseHookEvent`). Modelled on GrokBuildAdapter.
 * Resume: the conversation DB lives in a per-task persistent data dir (opencode-task-data.ts) and a
 * resumed launch runs `opencode --session <ses_id> <cwd>`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SendInputOptions } from '../core/ports/agent-interaction-port.js';
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
import {
  childSessionStorageKey,
  classifyHookParentage,
  createSessionRuntimeIdentity,
  recordSessionStart,
  type SessionRuntimeIdentity,
} from '../core/hook-parentage.js';
import { HookParseError, extractRawHookHeader, parseHookEvent, type RawHookHeader } from '../core/hook-parser.js';
import { buildHookCommand, resolveHookWriterPath } from '../core/hook-writer-paths.js';
import { withTimeout } from '../core/with-timeout.js';
import type {
  AdapterEventHandler,
  AdapterLaunchOptions,
  AgentAdapter,
  EffectiveHookSettings,
  PreflightResult,
  ResumeContext,
} from './agent-adapter.js';
import {
  buildAgentLaunchContext,
  deliverInitialPromptToSession,
  resolveBracketedPasteSubmit,
  toPromptDeliveryHealth,
  DEFAULT_PROMPT_SUBMIT_DELAY_MS,
  type InitialPromptDeliveryResult,
} from './agent-launch-context.js';
import { writeComposerInput } from './composer-input.js';
import { getGitInfo } from './git-info.js';
import { translateKeystroke } from './keystroke.js';
import { LaunchAbortedError, raceAgainstLaunchAbort, throwIfLaunchAborted } from './launch-abort.js';
import { composeOpenCodeSession, type ComposeOpenCodeSessionOptions } from './opencode-home-composer.js';
import {
  defaultKookrClaudeHooks,
  resolveDefaultBinDir,
  resolveDefaultPluginHooksDir,
  type OpenCodeProfile,
} from './opencode-kookr-hooks.js';
import { buildShelfLessonsSection, type ShelfShowRunner } from './opencode-shelf-memory.js';
import { prepareOpenCodeSeed, resolveOpenCodeSeedDir } from './opencode-seed.js';
import { preflightOpenCode, resolveOpenCodeBin } from './opencode-preflight.js';
import {
  formatOpenCodePaneExcerpt,
  isOpenCodeBusyOrResponding,
  isOpenCodeComposerReady,
} from './opencode-readiness.js';
import { mapOpenCodeUsageToTokenUsage, readOpenCodeDataHomeUsage } from './opencode-usage-scanner.js';
import {
  DEFAULT_OPENCODE_DATA_DONE_TTL_HOURS,
  DEFAULT_OPENCODE_DATA_MAX_AGE_DAYS,
  DEFAULT_OPENCODE_DATA_MAX_MB,
  OPENCODE_DATA_SWEEP_INTERVAL_MS,
  openCodeTaskDataHome,
  isAbsentOrEmptyDir,
  markTaskDir,
  openCodeTaskDir,
  removeMarkedTaskDir,
  parseDataCap,
  readOpenCodeSessionId,
  resolveOpenCodeDataRoot,
  sweepOpenCodeTaskData,
  touchTaskDir,
} from './opencode-task-data.js';
import type { ProbeExecRunner } from './probe-agent-binary.js';
import type { TerminalBackend } from './terminal-backend.js';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** First boot paints only after opencode finishes terminal-capability queries (~22s without an attached terminal). */
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_READY_POLL_MS = 100;
/** opencode's plugin hook round-trip (writer + HTTP) is slower than Claude's 2s ack window. */
export const DEFAULT_OPENCODE_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS = 30_000;

/** Default TUI heap cap (MB); see KOOKR_OPENCODE_RAM_LIMIT_MB. */
export const DEFAULT_OPENCODE_RAM_LIMIT_MB = 512;
export const DEFAULT_OPENCODE_PROVIDER_ID = 'deepinfra';
export const DEFAULT_OPENCODE_MODEL_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
export const DEFAULT_OPENCODE_BASE_URL = 'https://api.deepinfra.com/v1/openai';
export const DEFAULT_OPENCODE_API_KEY_ENV = 'OPENAI_API_KEY';

type OpenCodeModelConfig = ComposeOpenCodeSessionOptions['model'];

export interface OpenCodeAdapterOptions {
  terminalInputWriter?: TerminalInputWriterPort;
  /** Directory for durable per-session JSONL hook files. */
  hooksDir?: string;
  serverPort?: number;
  /** opencode binary. Defaults to `KOOKR_OPENCODE_BIN`, the pinned tools install, then PATH `opencode`. */
  agentBin?: string;
  /** Default provider/model; `modelId` may contain slashes (e.g. DeepInfra ids). */
  providerId?: string;
  modelId?: string;
  baseUrl?: string;
  /** Name of the env var holding the provider API key (inherited, never written to config). */
  apiKeyEnv?: string;
  /**
   * Default tool-permission posture. Defaults to `allow` (RFC §10): the server-wide
   * `bypassAllPermissions` default is deliberately NOT mapped here, since `ask` would
   * stall unattended workers. A per-call `bypassPermissions` still overrides.
   */
  permission?: 'allow' | 'ask';
  /** Root under which per-session dirs are created. Defaults to os tmpdir. */
  sessionRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: injected `--version` runner. */
  probeExec?: ProbeExecRunner;
  /** Test seam: injected composer. */
  composeSession?: typeof composeOpenCodeSession;
  promptBracketedPaste?: boolean;
  promptReadyTimeoutMs?: number;
  promptSubmitConfirmTimeoutMs?: number;
  /**
   * Instructions (AGENTS.md), Claude-shaped hooks and hook env applied to every session.
   * Explicit `claudeHooks` here replace the generated default hook set.
   */
  profile?: OpenCodeProfile;
  /** Directory holding the bin scripts (the stop nudge). Defaults to `<repo>/bin`. */
  binDir?: string;
  /** Directory holding nb-inject.sh / nb-retro.sh. Defaults to `<repo>/plugin/hooks`. */
  pluginHooksDir?: string;
  /**
   * Pre-seed each session's config roots (hardlinked from a one-time template) so the TUI skips its
   * in-process `npm install`, and set `OPENCODE_FAST_BOOT=1` for seeded sessions. Default false
   * (the server wiring turns it on); on any seed failure sessions simply boot unseeded.
   */
  seed?: boolean;
  /** Seed template dir. Defaults to `KOOKR_OPENCODE_SEED_DIR`, else `~/.kookr/tools/opencode-<ver>/seed`. */
  seedDir?: string;
  /** Test seam: seed preparation. */
  prepareSeed?: typeof prepareOpenCodeSeed;
  /**
   * RAM cap for the TUI (`BUN_JSC_forceRAMSize`), in MB. Defaults to `KOOKR_OPENCODE_RAM_LIMIT_MB`,
   * else 512; 0 disables the cap.
   */
  ramLimitMb?: number;
  /**
   * Set `OPENCODE_FAST_BOOT=1` on seeded sessions (default off, env `KOOKR_OPENCODE_FAST_BOOT`).
   * Measured live: with no terminal attached (the normal Kookr case) the TUI never paints the
   * composer under FAST_BOOT, so the initial prompt is lost; it is only safe with an attached terminal.
   */
  fastBoot?: boolean;
  /** Test seam: `nb show <shelf>` runner. */
  shelfShow?: ShelfShowRunner;
  /**
   * Root of the per-task persistent opencode data (conversation DB, kept so a relaunch can resume).
   * Defaults to `KOOKR_OPENCODE_DATA_DIR`, else `opencode-data` beside the hooks dir.
   */
  dataRoot?: string;
  /** Unused-age cap for a task's data dir, days (`KOOKR_OPENCODE_DATA_MAX_AGE_DAYS`, default 14; 0 = off). */
  dataMaxAgeDays?: number;
  /** Hours a completed/cancelled task's data is kept for reopen+resume (`KOOKR_OPENCODE_DATA_DONE_TTL_HOURS`, default 24; 0 = remove at the next sweep). */
  dataDoneTtlHours?: number;
  /** Delay before the post-stop sweep (ms); lets a task delete/complete that triggered the stop settle. Default 5000. */
  postStopSweepDelayMs?: number;
  /** Total size cap for all task data, MB (`KOOKR_OPENCODE_DATA_MAX_MB`, default 1024; 0 = off). */
  dataMaxMb?: number;
  /** Generate the default Kookr hook set when no explicit `claudeHooks` is configured. Default true. */
  defaultHooks?: boolean;
}

/** Split a per-task model pin: an optional leading `<providerId>/` is stripped, the rest is the model id. */
function resolveModelConfig(base: OpenCodeModelConfig, override?: string): OpenCodeModelConfig {
  if (!override) return base;
  const prefix = `${base.providerId}/`;
  return { ...base, modelId: override.startsWith(prefix) ? override.slice(prefix.length) : override };
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly agentType = 'opencode';
  private eventHandlers: Array<AdapterEventHandler> = [];
  private refreshHandlers: Array<() => void> = [];
  private tmuxToTaskId = new Map<string, string>();
  private identities = new Map<string, SessionRuntimeIdentity>();
  private sequenceCounters = new Map<string, number>();
  private hookSettings = new Map<string, EffectiveHookSettings>();
  private sessionDirs = new Map<string, string>();
  /** tmuxName -> per-task persistent XDG_DATA_HOME (survives the session). */
  private dataHomes = new Map<string, string>();
  /** tmuxName -> task data dir created by a FRESH launch (removed again if that launch fails). */
  private freshTaskDirs = new Map<string, string>();
  private dataRoot: string;
  private dataMaxAgeMs: number;
  private dataMaxBytes: number;
  private dataDoneTtlMs: number;
  private postStopSweepDelayMs: number;
  private lastDataSweep = 0;
  private initialPromptSubmitResolvers = new Map<string, () => void>();
  /**
   * SessionStart seen before the session was registered on the task. The plugin emits it as soon as
   * opencode loads, i.e. before `addSession` at the end of launch, so it would otherwise never reach
   * the session record and the task would have no recoverable conversation id (resume gate).
   */
  private earlyParentStarts = new Map<string, { sessionId: string; transcriptPath: string }>();

  private inputWriter: TerminalInputWriterPort;
  private hooksDir: string;
  private serverPort?: number;
  private agentBin: string;
  private agentBinConfiguredVia: 'env' | 'default';
  private model: OpenCodeModelConfig;
  private permission: 'allow' | 'ask';
  private sessionRoot: string;
  private env: NodeJS.ProcessEnv;
  private probeExec?: ProbeExecRunner;
  private composeSession: typeof composeOpenCodeSession;
  private promptBracketedPaste: boolean;
  private promptReadyTimeoutMs: number;
  private promptSubmitConfirmTimeoutMs: number;
  private profile?: OpenCodeProfile;
  private binDir?: string;
  private pluginHooksDir?: string;
  private defaultHooks: boolean;
  private seed: boolean;
  private seedDir: string;
  private prepareSeed: typeof prepareOpenCodeSeed;
  private seedPromise?: Promise<string | undefined>;
  private ramLimitMb: number;
  private fastBoot: boolean;
  private shelfShow?: ShelfShowRunner;
  private preflightProbe?: Promise<PreflightResult>;

  constructor(
    private backend: TerminalBackend,
    private taskStore: TaskStore,
    options?: OpenCodeAdapterOptions,
  ) {
    this.env = options?.env ?? process.env;
    this.inputWriter = options?.terminalInputWriter ?? asTerminalInputWriterPort(backend);
    this.hooksDir = options?.hooksDir ?? '~/.kookr/hooks';
    this.serverPort = options?.serverPort;
    const resolved = options?.agentBin
      ? { bin: options.agentBin, configuredVia: 'env' as const }
      : resolveOpenCodeBin(this.env);
    this.agentBin = resolved.bin;
    this.agentBinConfiguredVia = resolved.configuredVia;
    this.model = {
      providerId: options?.providerId ?? DEFAULT_OPENCODE_PROVIDER_ID,
      modelId: options?.modelId ?? DEFAULT_OPENCODE_MODEL_ID,
      baseUrl: options?.baseUrl ?? DEFAULT_OPENCODE_BASE_URL,
      apiKeyEnv: options?.apiKeyEnv ?? DEFAULT_OPENCODE_API_KEY_ENV,
    };
    this.profile = options?.profile;
    this.binDir = options?.binDir;
    this.pluginHooksDir = options?.pluginHooksDir;
    this.defaultHooks = options?.defaultHooks ?? true;
    this.seed = options?.seed ?? false;
    this.seedDir = options?.seedDir ?? resolveOpenCodeSeedDir(this.env);
    this.prepareSeed = options?.prepareSeed ?? prepareOpenCodeSeed;
    this.ramLimitMb = options?.ramLimitMb ?? parseRamLimitMb(this.env.KOOKR_OPENCODE_RAM_LIMIT_MB);
    this.shelfShow = options?.shelfShow;
    this.dataRoot = options?.dataRoot ?? resolveOpenCodeDataRoot(this.env, this.hooksDir);
    this.dataMaxAgeMs = (options?.dataMaxAgeDays
      ?? parseDataCap(this.env.KOOKR_OPENCODE_DATA_MAX_AGE_DAYS, DEFAULT_OPENCODE_DATA_MAX_AGE_DAYS)) * 86_400_000;
    this.dataDoneTtlMs = (options?.dataDoneTtlHours
      ?? parseDataCap(this.env.KOOKR_OPENCODE_DATA_DONE_TTL_HOURS, DEFAULT_OPENCODE_DATA_DONE_TTL_HOURS)) * 3_600_000;
    this.postStopSweepDelayMs = options?.postStopSweepDelayMs ?? 5000;
    this.dataMaxBytes = (options?.dataMaxMb
      ?? parseDataCap(this.env.KOOKR_OPENCODE_DATA_MAX_MB, DEFAULT_OPENCODE_DATA_MAX_MB)) * 1024 * 1024;
    this.fastBoot = options?.fastBoot ?? ['1', 'true', 'yes'].includes(this.env.KOOKR_OPENCODE_FAST_BOOT?.trim().toLowerCase() ?? '');
    this.permission = options?.permission ?? 'allow';
    this.sessionRoot = options?.sessionRoot ?? tmpdir();
    this.probeExec = options?.probeExec;
    this.composeSession = options?.composeSession ?? composeOpenCodeSession;
    this.promptBracketedPaste = resolveBracketedPasteSubmit(options?.promptBracketedPaste, this.env);
    this.promptReadyTimeoutMs = options?.promptReadyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.promptSubmitConfirmTimeoutMs =
      options?.promptSubmitConfirmTimeoutMs ?? DEFAULT_OPENCODE_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS;
  }

  /** Pinned-version binary probe (memoized; `launch` does not re-probe). */
  preflight(): Promise<PreflightResult> {
    this.preflightProbe ??= preflightOpenCode({
      env: this.env,
      exec: this.probeExec,
      resolution: { bin: this.agentBin, configuredVia: this.agentBinConfiguredVia },
    });
    return this.preflightProbe;
  }

  async launch(
    taskId: string,
    prompt: string,
    cwd: string,
    resume?: ResumeContext,
    opts?: AdapterLaunchOptions,
  ): Promise<string> {
    const tmuxName = opts?.tmuxName ?? `kookr-${randomUUID().slice(0, 8)}`;
    this.tmuxToTaskId.set(tmuxName, taskId);

    opts?.onPhase?.('session-create');
    // Resume only when the task's persistent opencode DB still holds a session; otherwise warn and
    // launch fresh with the prompt (the data dir may have been swept or the task never ran).
    const opencodeSessionId = resume?.sessionId ? await this.findResumableSession(taskId, resume) : undefined;
    let env: Record<string, string>;
    try {
      env = await this.prepareSession(taskId, cwd, tmuxName, opts, opencodeSessionId !== undefined);
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    }

    const submitConfirmed = this.armInitialPromptSubmitSignal(tmuxName);
    throwIfLaunchAborted(opts?.signal);
    try {
      await this.backend.createSession({
        id: tmuxName,
        command: this.agentBin,
        args: opencodeSessionId ? ['--session', opencodeSessionId, cwd] : [cwd],
        env,
        cwd,
        size: { cols: 200, rows: 50 },
      });
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    }
    opts?.onSessionCreated?.(tmuxName);
    if (opts?.signal?.aborted) {
      await this.cleanupFailedLaunch(tmuxName);
      throw new LaunchAbortedError(tmuxName);
    }

    opts?.onPhase?.('agent-boot');
    let deliveryResult: InitialPromptDeliveryResult | undefined;
    try {
      deliveryResult = await raceAgainstLaunchAbort(
        opencodeSessionId
          // Resume: the conversation already holds the original prompt (Claude does the same); just
          // wait for the composer so the session registers healthy.
          ? this.waitForComposerReady(tmuxName).then(() => undefined)
          : this.runAgentBootSequence(tmuxName, prompt, submitConfirmed),
        opts?.signal,
        tmuxName,
      );
    } catch (err) {
      await this.cleanupFailedLaunch(tmuxName);
      throw err;
    } finally {
      this.initialPromptSubmitResolvers.delete(tmuxName);
    }
    if (opts?.signal?.aborted) {
      await this.cleanupFailedLaunch(tmuxName);
      throw new LaunchAbortedError(tmuxName);
    }

    opts?.onPhase?.('ack');
    this.taskStore.addSession(taskId, {
      tmuxSession: tmuxName,
      agentType: 'opencode',
      cwd,
      createdAt: new Date(),
      ...(deliveryResult ? { promptDelivery: toPromptDeliveryHealth(deliveryResult) } : {}),
    });
    const early = this.earlyParentStarts.get(tmuxName);
    this.earlyParentStarts.delete(tmuxName);
    if (early) {
      this.taskStore.updateSession(taskId, tmuxName, { claudeSessionId: early.sessionId, transcriptPath: early.transcriptPath });
    }
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

  /** Compose the per-session dir and return the merged child env. */
  private async prepareSession(
    taskId: string,
    cwd: string,
    tmuxName: string,
    opts?: AdapterLaunchOptions,
    resuming = false,
  ): Promise<Record<string, string>> {
    const launchContext = await buildAgentLaunchContext({
      taskStore: this.taskStore,
      taskId,
      cwd,
      serverPort: this.serverPort,
      sessionName: tmuxName,
    });
    const sessionDir = await mkdtemp(join(this.sessionRoot, `kookr-opencode-${tmuxName}-`));
    this.sessionDirs.set(tmuxName, sessionDir);
    // Per-task persistent data: kept across stop so a relaunch can resume; a fresh launch starts clean.
    const taskDir = openCodeTaskDir(this.dataRoot, taskId);
    if (!resuming) {
      // Only a dir Kookr created (ownership marker) may be reset; anything else in the way is refused, never deleted.
      if (!(await removeMarkedTaskDir(taskDir, taskId)) && !(await isAbsentOrEmptyDir(taskDir))) {
        throw new Error(`refusing to use ${taskDir} as opencode task data: it exists and was not created by Kookr`);
      }
      this.freshTaskDirs.set(tmuxName, taskDir);
    }
    const dataHome = openCodeTaskDataHome(taskDir);
    // Marker first: a crash between the two steps must not leave an unmarked (and thus never reclaimed) dir.
    await mkdir(taskDir, { recursive: true, mode: 0o700 });
    await markTaskDir(taskDir, taskId);
    await mkdir(dataHome, { recursive: true, mode: 0o700 });
    await touchTaskDir(taskDir);
    this.dataHomes.set(tmuxName, dataHome);
    void this.maybeSweepTaskData(taskId);
    const hookCommand = buildHookCommand({
      tmuxName,
      hookFile: `${this.hooksDir}/${tmuxName}.jsonl`,
      serverPort: this.serverPort,
      writerPath: resolveHookWriterPath(),
    });
    // Per-call bypass wins, then the constructor default.
    const permission = opts?.bypassPermissions !== undefined
      ? (opts.bypassPermissions ? 'allow' : 'ask')
      : this.permission;
    let instructions = this.profile?.instructions;
    if (this.profile?.shelves?.length) {
      // Only the configured shelves, read with the session's NB_DIR (fail-open).
      const lessons = await buildShelfLessonsSection(this.profile.shelves, {
        env: { ...this.env, ...(opts?.extraEnv ?? {}) },
        show: this.shelfShow,
        warn: (m) => console.warn(m),
      });
      if (lessons) instructions = `${instructions ?? ''}${instructions?.endsWith('\n') ? '\n' : '\n\n'}${lessons}`;
    }
    const seedDir = this.seed ? await this.ensureSeed() : undefined;
    const hookEnv = {
      KOOKR_TASK_ID: taskId,
      ...(this.serverPort ? { KOOKR_PORT: String(this.serverPort) } : {}),
      ...(this.profile?.hookEnv ?? {}),
    };
    const claudeHooks = this.profile?.claudeHooks ?? (this.defaultHooks
      ? defaultKookrClaudeHooks({
          pluginHooksDir: this.pluginHooksDir ?? resolveDefaultPluginHooksDir(this.env),
          binDir: this.binDir ?? resolveDefaultBinDir(this.env),
        })
      : undefined);
    const composed = await this.composeSession({
      sessionDir,
      sessionId: tmuxName,
      cwd,
      dataHome,
      hookCommand,
      model: resolveModelConfig(this.model, opts?.model),
      permission,
      ...(seedDir ? { seedDir } : {}),
      ramLimitMb: this.ramLimitMb,
      fastBoot: this.fastBoot,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(claudeHooks ? { claudeHooks: { ...claudeHooks, env: { ...(claudeHooks.env ?? {}), ...hookEnv } } } : {}),
    });
    this.hookSettings.set(tmuxName, {
      content: { hookCommand, permission },
      agentType: this.agentType,
      settingsPath: composed.pluginPath,
    });
    // Layering: launch context < caller extraEnv < composed isolation vars.
    return { ...launchContext.env, ...(opts?.extraEnv ?? {}), ...composed.env };
  }

  /** Memoised seed preparation (a failure is remembered for the process: sessions boot unseeded). */
  private ensureSeed(): Promise<string | undefined> {
    this.seedPromise ??= this.prepareSeed({
      bin: this.agentBin,
      seedDir: this.seedDir,
      env: this.env,
      warn: (m) => console.warn(m),
    }).catch(() => undefined);
    return this.seedPromise;
  }

  /** The opencode session id to continue for `taskId`, or undefined (with a warning) => launch fresh. */
  private async findResumableSession(taskId: string, resume: ResumeContext): Promise<string | undefined> {
    const preferred = resume.sessionId.startsWith('ses_')
      ? resume.sessionId
      : this.taskStore.getTask(taskId)?.metadata?.opencodeSessionId;
    const id = await readOpenCodeSessionId(openCodeTaskDataHome(openCodeTaskDir(this.dataRoot, taskId)), preferred);
    if (!id) {
      console.warn(
        `[opencode-adapter] resume requested for ${taskId} but no opencode session was found in its persistent data ` +
          `(${this.dataRoot}); launching fresh.`,
      );
    }
    return id;
  }

  /** Throttled, fire-and-forget retention sweep (see opencode-task-data.ts). */
  private async maybeSweepTaskData(launchingTaskId?: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastDataSweep < OPENCODE_DATA_SWEEP_INTERVAL_MS) return;
    this.lastDataSweep = now;
    await this.sweepTaskData(launchingTaskId);
  }

  /** Run the retention sweep now. Never throws. */
  async sweepTaskData(launchingTaskId?: string): Promise<void> {
    try {
      const active = new Set(this.tmuxToTaskId.values());
      if (launchingTaskId) active.add(launchingTaskId);
      const res = await sweepOpenCodeTaskData({
        root: this.dataRoot,
        statusOf: (id) => this.taskStore.getTask(id)?.status,
        activeTaskIds: active,
        isActive: (id) => id === launchingTaskId || [...this.tmuxToTaskId.values()].includes(id),
        maxAgeMs: this.dataMaxAgeMs,
        doneTtlMs: this.dataDoneTtlMs,
        maxBytes: this.dataMaxBytes,
        warn: (m) => console.warn(m),
      });
      if (res.removed.length > 0) {
        console.log(`[opencode-adapter] swept ${res.removed.length} persistent opencode data dir(s): ${res.removed.map((r) => `${r.taskId.slice(0, 8)}:${r.reason}`).join(', ')}`);
      }
    } catch {
      /* retention is best-effort */
    }
  }

  /** Poll until the composer chrome is painted. Fail-open on timeout (confirmation still guards delivery). */
  private async waitForComposerReady(tmuxName: string): Promise<void> {
    if (this.promptReadyTimeoutMs <= 0) return;
    const deadline = Date.now() + this.promptReadyTimeoutMs;
    while (Date.now() <= deadline) {
      const display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
      if (isOpenCodeComposerReady(display)) return;
      await sleep(Math.min(DEFAULT_READY_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    console.warn(`[opencode-adapter] composer not ready for ${tmuxName} within ${this.promptReadyTimeoutMs}ms; proceeding fail-open`);
  }

  private async runAgentBootSequence(
    tmuxName: string,
    prompt: string,
    submitConfirmed: Promise<void>,
  ): Promise<InitialPromptDeliveryResult> {
    await this.waitForComposerReady(tmuxName);
    const delivery = await deliverInitialPromptToSession(this.backend, tmuxName, prompt, {
      inputWriter: this.inputWriter,
      bracketedPaste: this.promptBracketedPaste,
      waitForReady: false,
      awaitSubmit: this.promptBracketedPaste
        ? (timeoutMs) => withTimeout(submitConfirmed.then(() => true), timeoutMs, false)
        : undefined,
      submitConfirmTimeoutMs: this.promptSubmitConfirmTimeoutMs,
      // The shared retry path uses Claude busy markers; never resend Enter blindly.
      submitRetries: 0,
      readyTimeoutMs: this.promptReadyTimeoutMs,
    });
    if (delivery.status !== 'unconfirmed') return delivery;

    const display = textDecoder.decode(await this.backend.captureBytes(tmuxName));
    if (isOpenCodeBusyOrResponding(display)) {
      // The turn is running even though the hook never arrived: do not kill a live turn.
      console.warn(
        `[opencode-adapter] assuming initial prompt submitted for ${tmuxName}: pane is busy but ` +
          `UserPromptSubmit never arrived; pane excerpt: ${formatOpenCodePaneExcerpt(display)}`,
      );
      return { ...delivery, status: 'assumed-submitted' };
    }
    throw new Error(
      `[opencode-adapter] opencode did not acknowledge the initial prompt within ` +
        `${this.promptSubmitConfirmTimeoutMs}ms (waiting for UserPromptSubmit hook); refusing to resend it. ` +
        `Pane excerpt: ${formatOpenCodePaneExcerpt(display)}`,
    );
  }

  private armInitialPromptSubmitSignal(tmuxName: string): Promise<void> {
    this.initialPromptSubmitResolvers.get(tmuxName)?.();
    return new Promise<void>((resolve) => {
      this.initialPromptSubmitResolvers.set(tmuxName, resolve);
    });
  }

  private forgetSession(tmuxName: string): void {
    this.initialPromptSubmitResolvers.delete(tmuxName);
    this.earlyParentStarts.delete(tmuxName);
    this.hookSettings.delete(tmuxName);
    this.tmuxToTaskId.delete(tmuxName);
  }

  private async cleanupFailedLaunch(tmuxName: string): Promise<void> {
    await this.recordSessionTokenUsage(tmuxName);
    const failedTaskId = this.tmuxToTaskId.get(tmuxName);
    this.forgetSession(tmuxName);
    try {
      await this.backend.killSession(tmuxName);
    } catch {
      /* preserve the original failure */
    }
    await this.cleanupSessionDir(tmuxName);
    // A failed FRESH launch leaves nothing worth resuming; a failed resume keeps the conversation.
    const fresh = this.freshTaskDirs.get(tmuxName);
    this.freshTaskDirs.delete(tmuxName);
    this.dataHomes.delete(tmuxName);
    if (fresh && failedTaskId) await removeMarkedTaskDir(fresh, failedTaskId).catch(() => { /* best-effort */ });
  }

  private async cleanupSessionDir(tmuxName: string): Promise<void> {
    const dir = this.sessionDirs.get(tmuxName);
    this.sessionDirs.delete(tmuxName);
    if (!dir) return;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  async sendInput(tmuxName: string, text: string, opts?: SendInputOptions): Promise<void> {
    await writeComposerInput(this.inputWriter, tmuxName, text, DEFAULT_PROMPT_SUBMIT_DELAY_MS, opts);
  }

  async sendKeystroke(tmuxName: string, key: string): Promise<void> {
    await this.inputWriter.writeInput(tmuxName, translateKeystroke(key), { reason: 'adapter-send-keystroke' });
  }

  /** Kill the terminal session (the backend drains the owned process tree) and remove the session dir. */
  async stop(tmuxName: string): Promise<void> {
    this.initialPromptSubmitResolvers.get(tmuxName)?.();
    await this.backend.killSession(tmuxName);
    // After the kill (opencode has flushed its DB) and BEFORE the session dir is deleted.
    await this.recordSessionTokenUsage(tmuxName);
    await this.recordOpenCodeSessionId(tmuxName);
    const dataHome = this.dataHomes.get(tmuxName);
    this.dataHomes.delete(tmuxName);
    this.freshTaskDirs.delete(tmuxName);
    this.forgetSession(tmuxName);
    await this.cleanupSessionDir(tmuxName);
    // The per-task data (conversation DB) deliberately outlives the session so the task can resume.
    if (dataHome) await touchTaskDir(dirname(dataHome));
    await this.sweepTaskData();
    // A task delete/complete that caused this stop may land just after it: sweep once more shortly.
    if (this.postStopSweepDelayMs > 0) {
      setTimeout(() => { void this.sweepTaskData(); }, this.postStopSweepDelayMs).unref();
    }
  }

  /** Persist the opencode session id on the task (`metadata.opencodeSessionId`) for operators and relaunch. Best-effort. */
  private async recordOpenCodeSessionId(tmuxName: string): Promise<void> {
    const dataHome = this.dataHomes.get(tmuxName);
    const taskId = this.tmuxToTaskId.get(tmuxName) ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (!dataHome || !taskId) return;
    try {
      const id = await readOpenCodeSessionId(dataHome, this.taskStore.getTask(taskId)?.metadata?.opencodeSessionId);
      if (id && this.taskStore.getTask(taskId)?.metadata?.opencodeSessionId !== id) {
        this.taskStore.recordOpenCodeSessionId(taskId, id);
      }
    } catch {
      /* best-effort */
    }
  }

  /**
   * Sum the session's opencode DB into the task's token usage (mirrors the grok adapter).
   * Best-effort: a missing/unreadable DB leaves usage unset and never blocks teardown.
   */
  private async recordSessionTokenUsage(tmuxName: string): Promise<void> {
    const dataHome = this.dataHomes.get(tmuxName);
    if (!dataHome) return;
    const taskId = this.tmuxToTaskId.get(tmuxName) ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (!taskId) return;
    try {
      const result = await readOpenCodeDataHomeUsage(dataHome);
      if (result.kind !== 'ok') return;
      if (!this.taskStore.getTask(taskId)) return;
      this.taskStore.updateTokenUsage(taskId, mapOpenCodeUsageToTokenUsage(result.usage));
      for (const handler of this.refreshHandlers) handler();
    } catch {
      /* telemetry is best-effort — never block teardown on a scan failure */
    }
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
   * Decode a Claude-shaped hook payload emitted by the generated plugin and
   * dispatch it. NEVER throws on malformed payloads — returns a diagnostic
   * parseStatus so HookIngestion can record a ledger row.
   */
  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    externalSequence?: number,
    options?: { origin?: EventOrigin },
  ): InjectHookEventResult {
    const observedAt = Date.now();
    let header: RawHookHeader;
    try {
      header = extractRawHookHeader(rawJson);
    } catch (err) {
      return { parseStatus: 'malformed', agentType: this.agentType, error: describeParseError(err) };
    }
    const diag = {
      agentType: 'opencode' as const,
      rawSessionId: header.rawSessionId,
      rawTurnId: header.rawTurnId,
      rawHookEventName: header.rawHookEventName,
    };

    let event: AgentEvent | null;
    try {
      event = parseHookEvent(rawJson);
    } catch (err) {
      return { parseStatus: 'malformed', ...diag, error: describeParseError(err) };
    }
    if (!event) return { parseStatus: 'dropped', ...diag, parentage: 'unknown' };

    const taskId = this.tmuxToTaskId.get(tmuxName) ?? this.taskStore.findTaskBySession(tmuxName)?.id;
    if (taskId && !this.tmuxToTaskId.has(tmuxName)) this.tmuxToTaskId.set(tmuxName, taskId);
    const rawSessionId = 'sessionId' in event ? event.sessionId : header.rawSessionId;
    const identity = this.getOrHydrateIdentity(tmuxName, taskId);
    const parentage = this.classifyAndRecord(tmuxName, taskId, event, header, identity, rawSessionId, observedAt);

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
    return { parseStatus: 'ok', ...diag, parentage, sequence };
  }

  /** Classify parentage, record the parent/child session on SessionStart, and refresh git info on a cwd change. */
  private classifyAndRecord(
    tmuxName: string,
    taskId: string | undefined,
    event: AgentEvent,
    header: RawHookHeader,
    identity: SessionRuntimeIdentity,
    rawSessionId: string | undefined,
    observedAt: number,
  ): EventParentage {
    let parentage: EventParentage;
    if (event.type === 'session_start' && rawSessionId) {
      parentage = recordSessionStart(identity, rawSessionId, event.transcriptPath, new Date(observedAt).toISOString());
      if (taskId) this.recordSessionStartOnTask(taskId, tmuxName, event, parentage, identity, rawSessionId, observedAt);
    } else {
      parentage = classifyHookParentage(rawSessionId, identity, header.rawTranscriptPath);
    }
    if (parentage === 'parent' && taskId && 'cwd' in event && event.cwd) {
      this.refreshCwd(taskId, tmuxName, event.cwd);
    }
    return parentage;
  }

  private recordSessionStartOnTask(
    taskId: string,
    tmuxName: string,
    event: Extract<AgentEvent, { type: 'session_start' }>,
    parentage: EventParentage,
    identity: SessionRuntimeIdentity,
    rawSessionId: string,
    observedAt: number,
  ): void {
    if (parentage === 'parent') {
      const session = this.taskStore.getTask(taskId)?.sessions.find((s) => s.tmuxSession === tmuxName);
      if (session && !session.claudeSessionId) {
        this.taskStore.updateSession(taskId, tmuxName, {
          claudeSessionId: event.sessionId,
          transcriptPath: event.transcriptPath,
        });
      } else if (!session) {
        this.earlyParentStarts.set(tmuxName, { sessionId: event.sessionId, transcriptPath: event.transcriptPath ?? '' });
      }
    } else if (parentage === 'child') {
      this.taskStore.recordChildSession(
        taskId,
        tmuxName,
        childSessionStorageKey(identity, rawSessionId, event.transcriptPath),
        {
          firstSeenAt: new Date(observedAt).toISOString(),
          transcriptPath: event.transcriptPath,
          reason: 'inherited_settings',
        },
      );
    }
  }

  private refreshCwd(taskId: string, tmuxName: string, cwd: string): void {
    const session = this.taskStore.getTask(taskId)?.sessions.find((s) => s.tmuxSession === tmuxName);
    if (!session || cwd === session.cwd) return;
    this.taskStore.updateSessionCwd(taskId, tmuxName, cwd);
    getGitInfo(cwd)
      .then((info) => {
        if (info) {
          this.taskStore.updateSessionGitInfo(taskId, tmuxName, info);
          for (const handler of this.refreshHandlers) handler();
        }
      })
      .catch(() => { /* graceful degradation */ });
  }

  private getOrHydrateIdentity(tmuxName: string, taskId: string | undefined): SessionRuntimeIdentity {
    let identity = this.identities.get(tmuxName);
    if (identity) return identity;
    identity = createSessionRuntimeIdentity();
    const session = taskId
      ? this.taskStore.getTask(taskId)?.sessions.find((s) => s.tmuxSession === tmuxName)
      : undefined;
    if (session?.claudeSessionId) {
      identity.parentSessionId = session.claudeSessionId;
      identity.parentTranscriptPath = session.transcriptPath;
    }
    for (const [id, info] of Object.entries(session?.childSessionIds ?? {})) {
      identity.childSessionIds.set(id, info);
    }
    this.identities.set(tmuxName, identity);
    return identity;
  }

  getActiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    return this.hookSettings.get(tmuxName);
  }

  getEffectiveHookSettings(tmuxName: string): EffectiveHookSettings | undefined {
    return this.getActiveHookSettings(tmuxName);
  }
}

/** `KOOKR_OPENCODE_RAM_LIMIT_MB`: unset => 512, 0 => off, invalid => 512. */
export function parseRamLimitMb(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_OPENCODE_RAM_LIMIT_MB;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_OPENCODE_RAM_LIMIT_MB;
}

function describeParseError(err: unknown): string {
  return err instanceof HookParseError ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}
