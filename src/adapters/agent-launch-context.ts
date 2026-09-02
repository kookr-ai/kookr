import { readFile, stat } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { resolveAgentLauncherBinDir } from '../core/hook-writer-paths.js';
import { INTERACTIVE_TOOL_DENY_RULES } from '../shared/contracts/operator-needed.js';
import type { TaskStore } from '../core/tasks.js';
import type {
  PromptDeliveryFailureReason,
  PromptDeliveryHealth,
  PromptDeliveryStatus,
} from '../core/session-read-model.js';
import { ENTER_BYTES } from './keystroke.js';
import type { SessionId, TerminalBackend } from './terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../core/ports/terminal-input-writer-port.js';
import { DEFAULT_AGENT_TERM } from './session-term-env.js';

const promptEncoder = new TextEncoder();
const promptDecoder = new TextDecoder('utf-8', { fatal: false });
export const INITIAL_PROMPT_CHUNK_BYTES = 16 * 1024;

/**
 * ANSI bracketed-paste delimiters. A terminal UI that supports bracketed
 * paste treats every byte between `ESC[200~` and `ESC[201~` as literal
 * pasted content (newlines do not submit, control chars are not commands),
 * and treats input after `ESC[201~` as ordinary keystrokes. Kookr wraps the
 * initial prompt body in these markers so the submitting Enter that follows
 * the closing marker is an unambiguous keypress — see
 * {@link deliverInitialPromptToSession}.
 */
const PASTE_START_TEXT = '\x1b[200~';
const PASTE_END_TEXT = '\x1b[201~';
const PASTE_START = promptEncoder.encode(PASTE_START_TEXT);
const PASTE_END = promptEncoder.encode(PASTE_END_TEXT);

/**
 * DECSET sequence Claude Code emits when its TUI enables bracketed-paste
 * parsing. Seeing this in the session's raw captured bytes is the precise
 * signal that subsequent `ESC[200~ … ESC[201~` markers will be honoured as
 * paste delimiters. Do not substitute the visual `Claude Code + ❯` prompt
 * for this signal: Claude Code can paint the composer before paste-mode
 * parsing is ready, and a prompt delivered in that window can be dropped.
 * See {@link isBracketedPasteModeEnabled} and {@link waitForPasteReady}.
 */
const BRACKETED_PASTE_MODE_ENABLE_TEXT = '\x1b[?2004h';

/**
 * Composer-chrome markers proving the agent TUI has finished its first paint
 * and is accepting keyboard input. Matched against the captured pane with
 * every escape sequence AND every whitespace run removed, because the TUI
 * positions each word with its own cursor-forward escape — the raw bytes of
 * the footer read `bypass\x1b[13Gpermissions`, so a marker containing a
 * space would never match.
 *
 * `ESC[?2004h` alone is not enough: Claude Code emits it while still booting
 * (~2-3s before the first paint on a loaded machine) and silently discards
 * everything written in that window. See {@link waitForPasteReady}.
 */
const CLAUDE_COMPOSER_READY_MARKERS: readonly string[] = [
  // Footer shown in bypass-permissions mode: "⏵⏵ bypass permissions on
  // (shift+tab to cycle)".
  'shift+tab',
  'bypasspermissions',
  // Default footer: "? for shortcuts".
  'forshortcuts',
];

/**
 * Settle cushion (ms) after both readiness signals before the paste block is
 * written. The first paint lands slightly before the input reader is stable;
 * 1500ms delivered 12KB and 80KB prompts byte-perfect in live repro, while
 * writing at first paint still lost bytes.
 */
export const DEFAULT_PROMPT_READY_SETTLE_MS = 1_500;

/**
 * Default cushion (ms) between prompt text and the submitting Enter. Agent
 * TUIs can finalise injected composer text asynchronously under dtach; 150ms
 * left the prompt visible but unsubmitted in live repro, while 500ms reliably
 * submitted.
 */
export const DEFAULT_PROMPT_SUBMIT_DELAY_MS = 500;
export const DEFAULT_PROMPT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_PROMPT_READY_POLL_MS = 100;

/**
 * Default per-attempt deadline for {@link DeliverInitialPromptOptions.awaitSubmit}.
 * Tuned so a slow dtach + cold Claude Code can still confirm the prompt
 * submission via the `UserPromptSubmit` hook before a retry Enter is sent.
 */
export const DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS = 2_000;
/**
 * Default number of retry Enters after the initial submission Enter when
 * {@link DeliverInitialPromptOptions.awaitSubmit} keeps timing out. With the
 * default of 2 the adapter sends at most 3 Enters total — enough to cover
 * the known races (paste-mode not yet enabled, dtach latency spike) without
 * spamming the composer.
 */
export const DEFAULT_PROMPT_SUBMIT_RETRIES = 2;

/**
 * Substrings that, when visible in the post-Enter display, prove the agent
 * (Claude Code or Grok Build) has already accepted the prompt and is in a
 * state where another Enter could have side effects (cancel/confirm). The
 * retry path uses {@link isClaudeBusyOrResponding} to skip a retry when any
 * of these appear, defending against the case where the initial Enter
 * actually succeeded but the `UserPromptSubmit` hook is slow to round-trip.
 *
 * Grok markers matter: overnight launch storms (UserPromptSubmit confirm
 * timeouts with Auth preflight OK) often showed Grok already streaming
 * (`Thinking…`) while the hook ack never arrived. Without Grok markers the
 * confirm path returned `unconfirmed` and killed a live session.
 */
const AGENT_BUSY_MARKERS: readonly string[] = [
  'esc to interrupt',
  'Esc to interrupt',
  'ESC to interrupt',
  // Grok Build TUI — high-confidence "model is working" chrome (not idle
  // composer). Keep narrow: bare spinner glyphs alone can appear during
  // MCP load before any prompt is accepted.
  'Thinking…',
  'Thinking...',
  '◆ Thinking',
];
/**
 * Permission-prompt detector. Claude Code's permission UI renders numbered
 * choices preceded by the same `❯` glyph the idle composer uses, so a bare
 * `❯` match would false-positive. Require the numbered option to keep the
 * heuristic narrow.
 */
const CLAUDE_PERMISSION_PROMPT_RE = /(?:^|\n)\s*(?:❯\s*)?1\.\s+(?:Yes|Allow|Approve|Continue)\b/;
/** Grok Build permission row menu (Allow once / Reject) — mid-run and launch. */
const GROK_PERMISSION_BUSY_RE =
  /(?:^|\n)\s*[❯›>]?\s*(?:\d+\.\s*)?(?:Allow once\b|Always allow\b|Reject\b|No, and tell Grok\b)/i;

/** Env var that opts into/out of bracketed-paste prompt submission. */
export const PROMPT_BRACKETED_PASTE_ENV = 'KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE';

/**
 * Resolve whether the initial prompt should be submitted via bracketed
 * paste, from (in precedence order) an explicit caller value, the
 * {@link PROMPT_BRACKETED_PASTE_ENV} env var, then the default `true`.
 *
 * Claude Code's UI can coalesce a fast prompt+Enter burst into a single
 * paste and treat the trailing carriage return as a literal newline,
 * leaving the task prompt unsubmitted in the input box. Bracketed paste is
 * still the default defence; the adapter has a plain-write fallback for
 * Claude Code versions that drop bracketed paste during startup.
 */
export function resolveBracketedPasteSubmit(
  explicit?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const raw = env[PROMPT_BRACKETED_PASTE_ENV];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
  }
  return true;
}

export interface AgentLaunchContext {
  env: Record<string, string>;
  permissionAllowlist: string[];
  /**
   * Permission deny rules for the spawned agent (issue #1562). Non-empty only
   * for unattended/autonomous tasks, where interactive tools (`AskUserQuestion`
   * and equivalents) are hard-denied so a blocking call fails fast instead of
   * hanging. Empty for attended tasks — their generated settings are unchanged.
   */
  permissionDenylist: string[];
}

interface BuildAgentLaunchContextOptions {
  taskStore: TaskStore;
  taskId: string;
  cwd: string;
  serverPort?: number;
  /**
   * Terminal session name for this launch (dtach/tmux id, e.g. `kookr-a1b2c3d4`).
   * When provided, injected as `KOOKR_AGENT_ID` so `kookr issue claim` can send
   * it as `sessionId` and the refusal block's `doing` follows the live session
   * (RFC PR 1b / issue #1230 dogfood).
   */
  sessionName?: string;
  /**
   * Directory to prepend to the agent `PATH` so a bare `kookr` resolves to the
   * bundled launcher shim (issue #786). Defaults to {@link resolveAgentLauncherBinDir};
   * pass `null` to skip PATH injection (used by tests that assert the rest of the
   * env in isolation). When the launcher can't be resolved, no PATH entry is added.
   */
  agentLauncherBinDir?: string | null;
  /**
   * Base `PATH` the launcher dir is prepended to. Defaults to the server's own
   * `process.env.PATH`; the spawned agent inherits this via the backend's
   * `{ ...process.env, ...spec.env }` merge.
   */
  basePath?: string;
  /**
   * Ceiling on the git-common-dir probe (issue #1526 Phase C / #1528).
   * Defaults to {@link GIT_COMMON_DIR_TIMEOUT_MS}; tests shrink it.
   */
  gitCommonDirTimeoutMs?: number;
  /**
   * Test seam for the git-common-dir probe itself — inject a hung/failing
   * resolver to exercise the degraded (no `KOOKR_GIT_COMMON_DIR`) path.
   */
  resolveGitCommonDirImpl?: (cwd: string) => Promise<string | null>;
}

/**
 * Hard ceiling on the git-common-dir probe (issue #1526 Phase C / #1528).
 *
 * In the 2026-07-25 incident, three schedule-fired launches wedged for hours
 * inside `buildAgentLaunchContext` under full-core CPU saturation — the only
 * awaits in that window are this probe's filesystem ops (`stat`/`readFile`
 * ride the libuv threadpool, which saturates under fork/load pressure; the
 * probe historically also spawned `git`, hence the issue's framing). Either
 * way the fix is the same: the probe is an *enhancement* (it only adds
 * `KOOKR_GIT_COMMON_DIR` + two permission allowlist entries), never a launch
 * prerequisite, so it gets a bound and degrades to "no git env" on expiry.
 */
export const GIT_COMMON_DIR_TIMEOUT_MS = 10_000;

/**
 * Run {@link resolveGitCommonDir} (or an injected resolver) with settle-once
 * semantics under a hard timeout. First settlement wins:
 * - resolver resolves in time → its value;
 * - resolver rejects in time → `null` (degraded, warned);
 * - timeout fires first → `null` (degraded, warned); any later settlement of
 *   the abandoned resolver is ignored (`Promise.race` already subscribed to
 *   it, so a late rejection can never become an unhandled rejection).
 */
export async function resolveGitCommonDirBounded(
  cwd: string,
  opts: { timeoutMs?: number; resolver?: (cwd: string) => Promise<string | null> } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? GIT_COMMON_DIR_TIMEOUT_MS;
  const resolver = opts.resolver ?? resolveGitCommonDir;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolver(cwd).catch((err: unknown) => {
        console.warn(
          `[launch-context] git-common-dir probe failed for ${cwd} (proceeding without git env): ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[launch-context] git-common-dir probe timed out after ${timeoutMs}ms for ${cwd} — ` +
            'proceeding without KOOKR_GIT_COMMON_DIR (degraded, non-fatal)',
          );
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function buildAgentLaunchContext(
  opts: BuildAgentLaunchContextOptions,
): Promise<AgentLaunchContext> {
  const task = opts.taskStore.getTask(opts.taskId);
  const userInitiatedRelaunch = task?.metadata?.userInitiatedRelaunch === true;
  const env: Record<string, string> = {
    KOOKR_TASK_ID: opts.taskId,
    // Managed agents always run inside a PTY. A server restarted with
    // TERM=dumb would otherwise strand Codex on its interactive confirmation.
    TERM: DEFAULT_AGENT_TERM,
  };
  const permissionAllowlist = ['Bash(git *)'];

  // Unattended/autonomous tasks (issue #1562): hard-deny interactive tools so a
  // blocking call fails fast (and flags the task operator-needed via the server
  // event pipeline) rather than hanging on an unanswerable prompt. Attended
  // tasks get an empty denylist, leaving their generated settings unchanged.
  const permissionDenylist = task?.unattended ? [...INTERACTIVE_TOOL_DENY_RULES] : [];

  // Session id for claim ownership / refusal-block `doing` (RFC PR 1b).
  if (opts.sessionName) {
    env.KOOKR_AGENT_ID = opts.sessionName;
  }

  if (task?.parentTaskId && !userInitiatedRelaunch) {
    env.KOOKR_PARENT_TASK_ID = task.parentTaskId;
  }

  // Surface the runtime launch posture to the running agent so headless
  // playbooks can branch on how they were launched (issue #1714).
  // A scheduled or parent-spawned run has nobody to answer an interactive
  // prompt, so the parallel-issue-batch playbook uses this to report-and-exit on
  // an empty backlog instead of stranding on `AskUserQuestion`. `parentTaskId`
  // is already exposed above; `schedule` provenance had no runtime signal until
  // now. Manual/unknown provenance is passed through too so the playbook's
  // interactive branch stays exact. An attended relaunch is reported as
  // manual even though its persisted lineage provenance remains parent-based.
  if (task?.provenance) {
    // A user relaunch retains parent provenance in persisted lineage, but its
    // runtime posture is attended/manual: headless playbooks must not treat it
    // as an autonomous child merely because it has a parentTaskId.
    env.KOOKR_LAUNCH_PROVENANCE = userInitiatedRelaunch ? 'manual' : task.provenance.kind;
  }

  // Unattended/autonomous marker (issue #1562) as a runtime signal too: an
  // operator can mark a manually-launched run unattended, which also means
  // "nobody is watching to answer a prompt". Headless playbooks treat this as
  // report-and-exit as well, not just schedule/parent provenance (issue #1714).
  if (task?.unattended) {
    env.KOOKR_UNATTENDED = '1';
  }

  // Propagate the Stop-hook nudge kill switch (RFC: rfc-agent-signal-surface §7)
  // so the baked Stop hook can read it. (In-flight tasks are disabled via the
  // /dev/shm runtime marker the nudge script also stats.)
  if (process.env.KOOKR_NUDGE_DISABLED) {
    env.KOOKR_NUDGE_DISABLED = process.env.KOOKR_NUDGE_DISABLED;
  }

  // Propagate Claude Code's auto-memory kill switch so spawned sessions (which
  // run with `--setting-sources ''`, i.e. no user/project settings) honor it.
  // When set, the harness disables auto memory AND the toolkit's memory hooks
  // switch from permissive validation to a hard block that redirects writes to
  // `kb remember`. Unset = unchanged behavior for operators who use memory.
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY) {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  }

  if (opts.serverPort) {
    env.KOOKR_PORT = String(opts.serverPort);
    env.KOOKR_API_BASE_URL = `http://127.0.0.1:${opts.serverPort}`;
    permissionAllowlist.push(
      'Bash(curl *KOOKR_API_BASE_URL*api/tasks*)',
      `Bash(curl *http://127.0.0.1:${opts.serverPort}/api/tasks*)`,
      `Bash(curl *http://localhost:${opts.serverPort}/api/tasks*)`,
    );
  }

  const gitCommonDir = await resolveGitCommonDirBounded(opts.cwd, {
    ...(opts.gitCommonDirTimeoutMs !== undefined ? { timeoutMs: opts.gitCommonDirTimeoutMs } : {}),
    ...(opts.resolveGitCommonDirImpl ? { resolver: opts.resolveGitCommonDirImpl } : {}),
  });
  if (gitCommonDir) {
    env.KOOKR_GIT_COMMON_DIR = gitCommonDir;
    permissionAllowlist.push(
      `Read(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
      `Write(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
    );
  }

  // Make a bare `kookr` resolvable to the agent (issue #786). Spawned agents are
  // told to run `kookr signal completion-ready`, but the PATH they inherit has no
  // extensionless `kookr` — so the bare command failed with exit 127. Prepend the
  // bundled launcher's `bin/` dir to PATH. (The Stop-hook nudge ran fine because
  // it invokes `node <absolute path>`, not a PATH lookup — hence the inconsistency
  // where the nudge fired but the command it suggested could not run.)
  //
  // The same bin dir also exposes the `kb` spool shim (issue #1519): lesson
  // writes (`kb remember --lesson` / `--kb=agent-task-lessons`) that fail at
  // runtime are appended to a durable local spool and replayed on recovery.
  // Non-remember `kb` subcommands pass through to the real binary with no
  // behavioural change.
  const launcherBinDir =
    opts.agentLauncherBinDir === undefined ? resolveAgentLauncherBinDir() : opts.agentLauncherBinDir;
  if (launcherBinDir) {
    const basePath = opts.basePath ?? process.env.PATH ?? '';
    env.PATH = basePath ? `${launcherBinDir}${delimiter}${basePath}` : launcherBinDir;
  }

  return { env, permissionAllowlist, permissionDenylist };
}

export interface DeliverInitialPromptOptions {
  inputWriter?: TerminalInputWriterPort;
  /**
   * When true, wrap the prompt body in ANSI bracketed-paste markers and
   * deliver the submitting Enter as a separate write after the closing
   * marker. This is the default path for Claude Code because it prevents
   * multiline prompt bodies from being submitted one line at a time. When
   * false/absent the body and Enter go out together in one `writeSequence`;
   * callers can still provide `awaitSubmit` so the helper resends Enter
   * until the prompt is confirmed.
   */
  bracketedPaste?: boolean;
  /**
   * Bracketed-paste mode only: wait until Claude Code's full-screen TUI has
   * enabled bracketed-paste parsing before sending the paste block. Without
   * this, the paste opener can arrive before Claude enables bracketed-paste
   * mode and be ignored or misparsed.
   */
  waitForReady?: boolean;
  /** Bracketed-paste ready wait timeout. On timeout, delivery proceeds. */
  readyTimeoutMs?: number;
  /** Bracketed-paste ready wait poll interval. */
  readyPollMs?: number;
  /**
   * Bracketed-paste mode only: cushion (ms) after the readiness signals are
   * observed and before the paste block is written. Defaults to
   * {@link DEFAULT_PROMPT_READY_SETTLE_MS}. Skipped entirely when the
   * readiness wait times out, so a fail-open delivery is no slower than before.
   */
  readySettleMs?: number;
  /**
   * Bracketed-paste mode only: cushion (ms) between the wrapped prompt
   * block and the submitting Enter. Defaults to
   * {@link DEFAULT_PROMPT_SUBMIT_DELAY_MS}.
   */
  submitDelayMs?: number;
  /**
   * Ground-truth predicate that resolves `true` once the agent has confirmed
   * the prompt was submitted (Kookr observes this via the `UserPromptSubmit`
   * hook in the adapter layer), or `false` if no confirmation arrives within
   * `timeoutMs`. When provided, the delivery sends another Enter on every
   * `false` and gives up after {@link submitRetries} retries. This applies to
   * both bracketed-paste and plain delivery: the first Enter can be parsed as
   * paste content in bracketed mode or land after text without submitting in
   * plain mode. When omitted, delivery is open-loop and matches the prior
   * behaviour exactly.
   */
  awaitSubmit?: (timeoutMs: number) => Promise<boolean>;
  /** Per-attempt timeout passed to {@link awaitSubmit}. */
  submitConfirmTimeoutMs?: number;
  /**
   * Number of *retry* Enters allowed after the first if `awaitSubmit` keeps
   * timing out. Total Enter writes therefore = `submitRetries + 1`. Defaults
   * to {@link DEFAULT_PROMPT_SUBMIT_RETRIES}.
   */
  submitRetries?: number;
  /**
   * Sleep implementation. Defaults to a real `setTimeout`-backed wait;
   * tests inject a stub to assert ordering without spending real time.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Single source of truth for this union is {@link PromptDeliveryStatus} in
 * core; aliased here so the historical adapter-facing name keeps working.
 */
export type InitialPromptDeliveryStatus = PromptDeliveryStatus;

export interface InitialPromptDeliveryResult {
  status: InitialPromptDeliveryStatus;
  confirmationAttempts: number;
  enterWrites: number;
}

/**
 * Project a delivery result into the durable {@link PromptDeliveryHealth}
 * record persisted on the session (#2792). Deterministic: the same result and
 * `observedAt` clock always produce the same record. Callers pass this to
 * `TaskStore.addSession` so remote recovery/diagnosis can read the launch-time
 * delivery outcome from persisted session state.
 */
export function toPromptDeliveryHealth(
  result: InitialPromptDeliveryResult,
  observedAt: Date = new Date(),
): PromptDeliveryHealth {
  const failureReason = promptDeliveryFailureReason(result.status);
  return {
    status: result.status,
    confirmationAttempts: result.confirmationAttempts,
    enterWrites: result.enterWrites,
    observedAt: observedAt.toISOString(),
    ...(failureReason ? { failureReason } : {}),
  };
}

function promptDeliveryFailureReason(
  status: InitialPromptDeliveryStatus,
): PromptDeliveryFailureReason | undefined {
  switch (status) {
    case 'assumed-submitted':
      return 'submit-assumed-after-timeout';
    case 'unconfirmed':
      return 'submit-not-confirmed';
    case 'open-loop':
    case 'confirmed':
      return undefined;
  }
}

function realSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

/**
 * Detect whether the session has already emitted the DECSET that turns on
 * bracketed-paste parsing. Operates on the raw bytes (not the post-strip
 * display) because the escape sequence is exactly what
 * {@link stripTerminalControls} would remove.
 */
/**
 * Remove any bracketed-paste markers already present in a prompt body. Applied
 * before wrapping so agent-authored content cannot prematurely close the
 * synthetic paste; exported because the launch delivery-integrity check must
 * compare the agent's report against the body that was actually written, not
 * the body it started from.
 */
export function stripBracketedPasteMarkers(prompt: string): string {
  return prompt.replaceAll(PASTE_START_TEXT, '').replaceAll(PASTE_END_TEXT, '');
}

export function isBracketedPasteModeEnabled(rawBytes: Uint8Array): boolean {
  return promptDecoder.decode(rawBytes).includes(BRACKETED_PASTE_MODE_ENABLE_TEXT);
}

/**
 * Detect whether the agent TUI has painted its composer chrome — the signal
 * that it is past the boot window in which keyboard input is dropped.
 * Complements {@link isBracketedPasteModeEnabled}: paste-mode parsing is
 * advertised first, the composer appears seconds later, and only after both
 * is a written prompt actually retained. See {@link waitForPasteReady}.
 */
export function isClaudeComposerReady(rawBytes: Uint8Array): boolean {
  const compact = stripTerminalControls(promptDecoder.decode(rawBytes))
    .replace(/\s+/g, '')
    .toLowerCase();
  return CLAUDE_COMPOSER_READY_MARKERS.some((marker) => compact.includes(marker));
}

/**
 * Detect whether the agent TUI has already accepted the most recent prompt
 * and is either streaming a response or showing a permission prompt. Used
 * by the launch path to skip a retry Enter that would otherwise risk
 * confirming a tool-permission dialog or interrupting a streaming reply.
 *
 * Covers Claude Code and Grok Build chrome. The export name is historical
 * (Claude-first); behaviour is agent-agnostic.
 *
 * False negatives are acceptable (a missed signal merely allows a spurious
 * Enter into an empty composer, which Claude/Grok typically ignore); false
 * positives are not (they would leave the prompt stuck unsubmitted, which is
 * the very bug the retry loop exists to fix), so the markers below are kept
 * narrow and high-confidence rather than broad.
 */
export function isClaudeBusyOrResponding(rawBytes: Uint8Array): boolean {
  return isPaneBusyOrAwaitingDialog(promptDecoder.decode(rawBytes));
}

/**
 * Decoded-pane variant of {@link isClaudeBusyOrResponding}. Used when the
 * caller already has display text from `captureDisplay`, such as the
 * mid-session submit retry sweep.
 */
export function isPaneBusyOrAwaitingDialog(pane: string): boolean {
  const text = stripTerminalControls(pane);
  for (const marker of AGENT_BUSY_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return CLAUDE_PERMISSION_PROMPT_RE.test(text) || GROK_PERMISSION_BUSY_RE.test(text);
}

/** Strip OSC and CSI escape sequences from captured pane text. */
export function stripTerminalControls(text: string): string {
  return text
    // OSC sequences, including terminal-title updates.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI/ANSI escape sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Wait until the session is ready to receive a bracketed paste. Readiness
 * needs BOTH signals, then a settle cushion:
 *
 * 1. `ESC[?2004h` — the TUI advertises bracketed-paste parsing.
 * 2. Composer chrome painted ({@link isClaudeComposerReady}).
 *
 * Signal 1 alone was the previous gate and is not sufficient: Claude Code
 * emits the DECSET during terminal setup and then spends seconds loading
 * (settings, plugins, MCP) before its input reader is live, silently
 * discarding everything written in that window. In live repro, a prompt
 * written at the DECSET was lost in full 3/3 times; the same prompt written
 * after composer chrome + a settle cushion arrived byte-perfect 3/3 times at
 * 3KB, 12KB and 80KB. Delivering into the boot window is the root cause of
 * the truncated task prompts tracked in kookr-ai/kookr#2977.
 *
 * On timeout this still returns without throwing so delivery proceeds
 * fail-open — and skips the settle cushion, so a timed-out wait costs no
 * more than before.
 */
async function waitForPasteReady(
  backend: TerminalBackend,
  sessionId: SessionId,
  options: Required<
    Pick<DeliverInitialPromptOptions, 'readyTimeoutMs' | 'readyPollMs' | 'readySettleMs' | 'sleep'>
  >,
): Promise<void> {
  const deadline = Date.now() + options.readyTimeoutMs;
  while (Date.now() <= deadline) {
    const bytes = await backend.captureBytes(sessionId);
    if (isBracketedPasteModeEnabled(bytes) && isClaudeComposerReady(bytes)) {
      await options.sleep(options.readySettleMs);
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await options.sleep(Math.min(options.readyPollMs, remainingMs));
  }
  // Fail-open, but not silently: if the composer markers ever stop matching
  // (a footer reword, an agent parked on a trust-folder or login screen), every
  // launch pays the full timeout and then delivers into an unknown state. That
  // is the old, lossy behaviour, and it should be visible in the log rather
  // than inferred from truncated prompts.
  console.warn(
    `[agent-launch] paste-readiness wait timed out for ${sessionId} after ${options.readyTimeoutMs}ms; `
    + 'delivering anyway (prompt loss is possible — see #2977)',
  );
}

/** Split a prompt byte string into ARG_MAX-safe terminal-write chunks. */
function chunkPromptBytes(promptBytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < promptBytes.length; offset += INITIAL_PROMPT_CHUNK_BYTES) {
    chunks.push(promptBytes.subarray(offset, offset + INITIAL_PROMPT_CHUNK_BYTES));
  }
  return chunks;
}

async function awaitPromptSubmissionConfirmation(
  backend: TerminalBackend,
  sessionId: SessionId,
  inputWriter: TerminalInputWriterPort,
  options: DeliverInitialPromptOptions,
  enterWrites: number,
): Promise<InitialPromptDeliveryResult | null> {
  if (!options.awaitSubmit) return null;

  const submitConfirmTimeoutMs =
    options.submitConfirmTimeoutMs ?? DEFAULT_PROMPT_SUBMIT_CONFIRM_TIMEOUT_MS;
  const submitRetries = options.submitRetries ?? DEFAULT_PROMPT_SUBMIT_RETRIES;

  for (let attempt = 0; attempt <= submitRetries; attempt += 1) {
    if (await options.awaitSubmit(submitConfirmTimeoutMs)) {
      return { status: 'confirmed', confirmationAttempts: attempt + 1, enterWrites };
    }
    if (attempt === submitRetries) {
      // Grok's idle composer footer contains "esc to interrupt", so the shared
      // Claude busy markers false-positive there. Grok recovery lives in
      // GrokBuildAdapter's handshake path via isGrokBusyOrResponding instead.
      return { status: 'unconfirmed', confirmationAttempts: attempt + 1, enterWrites };
    }
    const capture = await backend.captureBytes(sessionId);
    if (isClaudeBusyOrResponding(capture)) {
      return { status: 'assumed-submitted', confirmationAttempts: attempt + 1, enterWrites };
    }
    await inputWriter.writeInput(sessionId, ENTER_BYTES, { reason: 'launch-prompt-retry-enter' });
    enterWrites += 1;
  }

  return { status: 'unconfirmed', confirmationAttempts: submitRetries + 1, enterWrites };
}

/**
 * Deliver the initial prompt to a freshly-spawned agent session over the
 * terminal, then submit it with an Enter keystroke.
 *
 * With `bracketedPaste: true` the prompt body is wrapped in ANSI
 * bracketed-paste markers (`ESC[200~` … `ESC[201~`) and the submitting
 * Enter is written separately after the closing marker. A terminal UI that
 * supports bracketed paste therefore treats the body as pasted content and
 * the trailing Enter as an unambiguous keystroke — independent of how the
 * input bursts are chunked or how fast the agent boots. This is required
 * for Claude Code; Codex CLI uses the legacy path below.
 *
 * When `awaitSubmit` is provided, the function additionally closes the loop
 * around the Enter: after the initial Enter it waits for the predicate to
 * confirm the prompt was accepted (Kookr supplies a `UserPromptSubmit`-hook
 * backed predicate) and resends Enter on each timeout up to
 * `submitRetries` extra attempts. Without `awaitSubmit` the behaviour is
 * open-loop and matches earlier releases byte-for-byte.
 *
 * Without `bracketedPaste` the body and Enter are delivered together in one
 * `writeSequence` (one mutex acquisition).
 *
 * Splitting the Enter into its own write is safe here: callers invoke this
 * immediately after `createSession`, before the session is registered with
 * the task store, so no concurrent writer can interleave.
 */
export async function deliverInitialPromptToSession(
  backend: TerminalBackend,
  sessionId: SessionId,
  prompt: string,
  options?: DeliverInitialPromptOptions,
): Promise<InitialPromptDeliveryResult> {
  const inputWriter = options?.inputWriter ?? asTerminalInputWriterPort(backend);
  if (!options?.bracketedPaste) {
    // Legacy path: prompt chunks + Enter under one mutex acquisition. The
    // delivery path is chosen solely by `options.bracketedPaste`; the
    // `submitDelayMs` / `sleep` options do not apply here.
    const chunks = chunkPromptBytes(promptEncoder.encode(prompt));
    await inputWriter.writeInputSequence(sessionId, [...chunks, ENTER_BYTES], { reason: 'launch-prompt' });
    const confirmed = await awaitPromptSubmissionConfirmation(
      backend,
      sessionId,
      inputWriter,
      options ?? {},
      1,
    );
    return confirmed ?? { status: 'open-loop', confirmationAttempts: 0, enterWrites: 1 };
  }

  // Bracketed-paste path. Strip any bracketed-paste markers already present
  // in the prompt before wrapping, so agent-authored content cannot
  // prematurely close the synthetic paste and turn trailing bytes into
  // terminal commands — the standard bracketed-paste injection guard
  // (terminal multiplexers strip these from clipboard content too).
  const safeBody = stripBracketedPasteMarkers(prompt);
  const chunks = chunkPromptBytes(promptEncoder.encode(safeBody));
  const submitDelayMs = options.submitDelayMs ?? DEFAULT_PROMPT_SUBMIT_DELAY_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_PROMPT_READY_TIMEOUT_MS;
  const readyPollMs = options.readyPollMs ?? DEFAULT_PROMPT_READY_POLL_MS;
  const readySettleMs = options.readySettleMs ?? DEFAULT_PROMPT_READY_SETTLE_MS;
  const sleep = options.sleep ?? realSleep;
  if (options.waitForReady) {
    await waitForPasteReady(backend, sessionId, { readyTimeoutMs, readyPollMs, readySettleMs, sleep });
  }
  // Deliver the body wrapped in paste markers, then send Enter as its own
  // write so it is parsed as a keystroke, not paste content.
  await inputWriter.writeInputSequence(sessionId, [PASTE_START, ...chunks, PASTE_END], { reason: 'launch-prompt-paste' });
  await sleep(submitDelayMs);
  await inputWriter.writeInput(sessionId, ENTER_BYTES, { reason: 'launch-prompt-enter' });
  let enterWrites = 1;

  // Closed-loop confirmation: if the caller wired an `awaitSubmit` predicate
  // (the adapter does this via the `UserPromptSubmit` hook), wait for the
  // agent's own acknowledgement that the prompt left the composer.
  //
  // On timeout, only resend Enter when the captured display shows no signs
  // that Claude has already accepted the prompt. The hazard the check
  // closes: if the initial Enter actually submitted but the hook ack is
  // slow to round-trip, a blind resend at the 2 s mark can land on a
  // tool-permission dialog ("1. Yes") and confirm it, or on a streaming
  // response (no-op in practice, but still uncontracted). When the display
  // is unambiguous about Claude being busy, treat the submission as
  // confirmed and stop waiting — better to release the launch than to
  // poke a live composer.
  //
  // Invariant: `submitRetries + 1` awaits total, `submitRetries` Enter
  // resends. With `submitRetries = 0` the loop body runs exactly once
  // (await + no resend), matching the documented "skip the retries"
  // semantics.
  const confirmed = await awaitPromptSubmissionConfirmation(
    backend,
    sessionId,
    inputWriter,
    options,
    enterWrites,
  );
  if (confirmed) return confirmed;

  return { status: 'open-loop', confirmationAttempts: 0, enterWrites };
}

async function resolveGitCommonDir(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git');

  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    return null;
  }

  if (gitStat.isDirectory()) {
    return resolve(gitPath);
  }

  if (!gitStat.isFile()) {
    return null;
  }

  const content = await readFile(gitPath, 'utf-8');
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return null;

  return resolve(match[1].trim(), '..', '..');
}

function toAbsolutePermissionPath(path: string): string {
  return path.startsWith('/') ? `/${path}` : `//${path}`;
}
