import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { TaskStore } from '../core/tasks.js';
import { ENTER_BYTES } from './keystroke.js';
import type { SessionId, TerminalBackend } from './terminal-backend.js';

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
 * paste delimiters — strictly stronger than the visual `Claude Code + ❯`
 * heuristic, because the composer can paint before bracketed-paste mode is
 * enabled. See {@link isBracketedPasteModeEnabled} and
 * {@link waitForPasteReady}.
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
export const DEFAULT_PROMPT_SUBMIT_CONFIRM_MS = 2_000;
/**
 * Default number of retry Enters after the initial submission Enter when
 * {@link DeliverInitialPromptOptions.awaitSubmit} keeps timing out. With the
 * default of 2 the adapter sends at most 3 Enters total — enough to cover
 * the known races (paste-mode not yet enabled, dtach latency spike) without
 * spamming the composer.
 */
export const DEFAULT_PROMPT_SUBMIT_RETRIES = 2;

/** Env var that disables bracketed-paste prompt submission when set falsey. */
export const PROMPT_BRACKETED_PASTE_ENV = 'KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE';

/**
 * Resolve whether the initial prompt should be submitted via bracketed
 * paste, from (in precedence order) an explicit caller value, the
 * {@link PROMPT_BRACKETED_PASTE_ENV} env var, then the default `true`.
 *
 * Claude Code's UI coalesces a fast prompt+Enter burst into a single paste
 * and treats the trailing carriage return as a literal newline, leaving the
 * task prompt unsubmitted in the input box. Bracketed paste fixes that, so
 * it is on by default. The env var (`0`/`false`/`no`/`off`) is an opt-out;
 * the test suite uses it to keep the legacy single-write delivery path.
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
  /**
   * Pre-resolved per-task checkpoint directory. When provided, the launch
   * context exports `TASK_CHECKPOINT_DIR` and adds Read/Write/Bash entries
   * to the permission allowlist scoped to the directory tree.
   *
   * Resolution and pre-creation happen at the call site (server layer) where
   * `kookrDataDir` is in scope. See `src/core/checkpoint-path.ts`.
   * Always optional — the caller passes `undefined` on failure (fail-open).
   */
  checkpointDir?: string;
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

  if (opts.checkpointDir) {
    env.TASK_CHECKPOINT_DIR = opts.checkpointDir;
    permissionAllowlist.push(
      `Read(${toAbsolutePermissionPath(opts.checkpointDir)}/**)`,
      `Write(${toAbsolutePermissionPath(opts.checkpointDir)}/**)`,
      `Bash(${opts.checkpointDir}/repro.sh*)`,
    );
  }

  return { env, permissionAllowlist };
}

export interface DeliverInitialPromptOptions {
  /**
   * When true, wrap the prompt body in ANSI bracketed-paste markers and
   * deliver the submitting Enter as a separate write after the closing
   * marker. Required for Claude Code, whose UI otherwise coalesces a fast
   * prompt+Enter burst into one paste and treats the carriage return as a
   * literal newline. When false/absent the body and Enter go out together
   * in one `writeSequence` (legacy path; Codex CLI). Default false.
   */
  bracketedPaste?: boolean;
  /**
   * Bracketed-paste mode only: wait until Claude Code's full-screen TUI has
   * painted its composer before sending the paste block. Without this, the
   * paste opener can arrive before Claude enables bracketed-paste mode and
   * the prompt remains visible but unsubmitted.
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
   * Bracketed-paste mode only: ground-truth predicate that resolves `true`
   * once the agent has confirmed the prompt was submitted (Kookr observes
   * this via the `UserPromptSubmit` hook in the adapter layer), or `false`
   * if no confirmation arrives within `timeoutMs`. When provided, the
   * delivery sends another Enter on every `false` and gives up after
   * {@link submitRetries} retries — closing the residual race where the
   * first Enter is parsed as paste content because bracketed-paste mode
   * had not yet been finalised. When omitted, delivery is open-loop and
   * matches the prior behaviour exactly.
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

function realSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

export function isClaudeComposerReady(text: string): boolean {
  const plain = stripTerminalControls(text);
  return (plain.includes('ClaudeCode') || plain.includes('Claude Code')) && plain.includes('❯');
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

function stripTerminalControls(text: string): string {
  return text
    // OSC sequences, including terminal-title updates.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // CSI/ANSI escape sequences.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Wait until the session is ready to receive a bracketed paste. Preferred
 * signal: the raw `ESC[?2004h` DECSET — proof that the TUI has enabled
 * bracketed-paste parsing. Fallback signal: the visual `Claude Code + ❯`
 * composer indicator, which can light up slightly before paste mode is
 * enabled but still beats sending blind. Returns when either fires; on
 * timeout returns without throwing so delivery proceeds (matching prior
 * fail-open behaviour).
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
    if (isClaudeComposerReady(promptDecoder.decode(bytes))) return;

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
): Promise<void> {
  if (!options?.bracketedPaste) {
    // Legacy path: prompt chunks + Enter under one mutex acquisition. The
    // delivery path is chosen solely by `options.bracketedPaste`; the
    // `submitDelayMs` / `sleep` options do not apply here.
    const chunks = chunkPromptBytes(promptEncoder.encode(prompt));
    await backend.writeSequence(sessionId, [...chunks, ENTER_BYTES]);
    return;
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
  const submitConfirmTimeoutMs =
    options.submitConfirmTimeoutMs ?? DEFAULT_PROMPT_SUBMIT_CONFIRM_MS;
  const submitRetries = options.submitRetries ?? DEFAULT_PROMPT_SUBMIT_RETRIES;
  const sleep = options.sleep ?? realSleep;
  if (options.waitForReady) {
    await waitForPasteReady(backend, sessionId, { readyTimeoutMs, readyPollMs, sleep });
  }
  // Deliver the body wrapped in paste markers, then send Enter as its own
  // write so it is parsed as a keystroke, not paste content.
  await backend.writeSequence(sessionId, [PASTE_START, ...chunks, PASTE_END]);
  await sleep(submitDelayMs);
  await backend.write(sessionId, ENTER_BYTES);

  // Closed-loop confirmation: if the caller wired an `awaitSubmit` predicate
  // (the adapter does this via the `UserPromptSubmit` hook), wait for the
  // agent's own acknowledgement that the prompt left the composer. On
  // timeout, resend Enter — Claude Code treats Enter on an empty composer
  // as a no-op, so a redundant Enter after a successful (but unobserved)
  // submission is safe. Caps at `submitRetries` extra Enters.
  if (options.awaitSubmit) {
    for (let attempt = 0; attempt < submitRetries; attempt += 1) {
      if (await options.awaitSubmit(submitConfirmTimeoutMs)) return;
      await backend.write(sessionId, ENTER_BYTES);
    }
    // Last attempt: wait once more but do not send another Enter. If this
    // also times out, fall through silently — better to declare launch
    // complete than to spam the composer indefinitely.
    await options.awaitSubmit(submitConfirmTimeoutMs);
  }
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
