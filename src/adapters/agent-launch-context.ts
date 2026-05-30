import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TaskStore } from '../core/tasks.js';
import { ENTER_BYTES } from './keystroke.js';
import type { SessionId, TerminalBackend } from './terminal-backend.js';
import {
  asTerminalInputWriterPort,
  type TerminalInputWriterPort,
} from '../core/ports/terminal-input-writer-port.js';

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
 * Default cushion (ms) between the bracketed prompt block and the
 * submitting Enter. Claude Code finalises bracketed paste asynchronously
 * under dtach; 150ms left the prompt visible but unsubmitted in live repro,
 * while 500ms reliably submitted.
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
 * Substrings that, when visible in the post-Enter display, prove Claude
 * Code has already accepted the prompt and is in a state where another
 * Enter could have side effects (cancel/confirm). The retry path uses
 * {@link isClaudeBusyOrResponding} to skip a retry when any of these
 * appear, defending against the case where the initial Enter actually
 * succeeded but the `UserPromptSubmit` hook is slow to round-trip.
 */
const CLAUDE_BUSY_MARKERS: readonly string[] = [
  'esc to interrupt',
  'Esc to interrupt',
  'ESC to interrupt',
];
/**
 * Permission-prompt detector. Claude Code's permission UI renders numbered
 * choices preceded by the same `❯` glyph the idle composer uses, so a bare
 * `❯` match would false-positive. Require the numbered option to keep the
 * heuristic narrow.
 */
const CLAUDE_PERMISSION_PROMPT_RE = /(?:^|\n)\s*(?:❯\s*)?1\.\s+(?:Yes|Allow|Approve|Continue)\b/;

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
}

interface BuildAgentLaunchContextOptions {
  taskStore: TaskStore;
  taskId: string;
  cwd: string;
  serverPort?: number;
}

export async function buildAgentLaunchContext(
  opts: BuildAgentLaunchContextOptions,
): Promise<AgentLaunchContext> {
  const task = opts.taskStore.getTask(opts.taskId);
  const env: Record<string, string> = {
    KOOKR_TASK_ID: opts.taskId,
  };
  const permissionAllowlist = ['Bash(git *)'];

  if (task?.parentTaskId) {
    env.KOOKR_PARENT_TASK_ID = task.parentTaskId;
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

  const gitCommonDir = await resolveGitCommonDir(opts.cwd);
  if (gitCommonDir) {
    env.KOOKR_GIT_COMMON_DIR = gitCommonDir;
    permissionAllowlist.push(
      `Read(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
      `Write(${toAbsolutePermissionPath(gitCommonDir)}/**)`,
    );
  }

  return { env, permissionAllowlist };
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

export type InitialPromptDeliveryStatus =
  | 'open-loop'
  | 'confirmed'
  | 'assumed-submitted'
  | 'unconfirmed';

export interface InitialPromptDeliveryResult {
  status: InitialPromptDeliveryStatus;
  confirmationAttempts: number;
  enterWrites: number;
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
export function isBracketedPasteModeEnabled(rawBytes: Uint8Array): boolean {
  return promptDecoder.decode(rawBytes).includes(BRACKETED_PASTE_MODE_ENABLE_TEXT);
}

/**
 * Detect whether Claude Code has already accepted the most recent prompt
 * and is either streaming a response or showing a permission prompt. Used
 * by the launch path to skip a retry Enter that would otherwise risk
 * confirming a tool-permission dialog or interrupting a streaming reply.
 *
 * False negatives are acceptable (a missed signal merely allows a spurious
 * Enter into an empty composer, which Claude Code ignores); false positives
 * are not (they would leave the prompt stuck unsubmitted, which is the
 * very bug the retry loop exists to fix), so the markers below are kept
 * narrow and high-confidence rather than broad.
 */
export function isClaudeBusyOrResponding(rawBytes: Uint8Array): boolean {
  const text = stripTerminalControls(promptDecoder.decode(rawBytes));
  for (const marker of CLAUDE_BUSY_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return CLAUDE_PERMISSION_PROMPT_RE.test(text);
}

function stripTerminalControls(text: string): string {
  return text
    // OSC sequences, including terminal-title updates.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI/ANSI escape sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Wait until the session is ready to receive a bracketed paste. The only
 * ready signal is the raw `ESC[?2004h` DECSET — proof that the TUI has
 * enabled bracketed-paste parsing. The visual `Claude Code + ❯` composer
 * indicator is deliberately not enough because Claude Code can paint it
 * before paste-mode handling is active. On timeout this still returns
 * without throwing so delivery proceeds fail-open.
 */
async function waitForPasteReady(
  backend: TerminalBackend,
  sessionId: SessionId,
  options: Required<Pick<DeliverInitialPromptOptions, 'readyTimeoutMs' | 'readyPollMs' | 'sleep'>>,
): Promise<void> {
  const deadline = Date.now() + options.readyTimeoutMs;
  while (Date.now() <= deadline) {
    const bytes = await backend.captureBytes(sessionId);
    if (isBracketedPasteModeEnabled(bytes)) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await options.sleep(Math.min(options.readyPollMs, remainingMs));
  }
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
  const safeBody = prompt.replaceAll(PASTE_START_TEXT, '').replaceAll(PASTE_END_TEXT, '');
  const chunks = chunkPromptBytes(promptEncoder.encode(safeBody));
  const submitDelayMs = options.submitDelayMs ?? DEFAULT_PROMPT_SUBMIT_DELAY_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_PROMPT_READY_TIMEOUT_MS;
  const readyPollMs = options.readyPollMs ?? DEFAULT_PROMPT_READY_POLL_MS;
  const sleep = options.sleep ?? realSleep;
  if (options.waitForReady) {
    await waitForPasteReady(backend, sessionId, { readyTimeoutMs, readyPollMs, sleep });
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
