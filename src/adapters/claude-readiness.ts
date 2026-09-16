/**
 * Claude Code startup-UI guard.
 *
 * Claude's workspace-trust and bypass-permissions dialogs default to
 * "No, exit". Kookr's launch path used to treat paste-mode (or a 15s
 * timeout) as "ready" and send Enter, which confirmed that default and
 * killed the session. Detect those dialogs and accept the safe option
 * (Down, then Enter) before the task prompt is delivered.
 *
 * Claude's TUI paints words with CUP, so stripping CSI can glue
 * "Yes, I trust this folder" into "Yes,Itrustthisfolder". Match the
 * compacted form.
 */
import { stripTerminalControls } from './agent-launch-context.js';
import { ENTER_BYTES, translateKeystroke } from './keystroke.js';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import type { SessionId, TerminalBackend } from './terminal-backend.js';
import { raceAgainstLaunchAbort, throwIfLaunchAborted } from './launch-abort.js';

export type ClaudeBlockingStartupDialog = 'workspace-trust' | 'bypass-permissions';

/** Compact a pane so CUP-split words still match the dialog labels. */
export function compactClaudePane(display: string): string {
  return stripTerminalControls(display).replace(/\s+/g, '').toLowerCase();
}

/**
 * Return which blocking Claude startup dialog is visible, else `null`.
 * Operates on decoded display text (ANSI stripped, whitespace compacted).
 */
export function detectClaudeBlockingStartupDialog(
  display: string,
): ClaudeBlockingStartupDialog | null {
  const compact = compactClaudePane(display);
  if (compact.includes('yes,itrustthisfolder')) return 'workspace-trust';
  if (compact.includes('bypasspermissionsmode') && compact.includes('yes,iaccept')) {
    return 'bypass-permissions';
  }
  return null;
}

export class ClaudeStartupDialogError extends Error {
  readonly code = 'claude_startup_dialog';
  readonly dialog: ClaudeBlockingStartupDialog;

  constructor(dialog: ClaudeBlockingStartupDialog, sessionId: string) {
    super(
      `Claude Code is still showing the ${dialog} dialog on session ${sessionId} ` +
        `(default choice is "No, exit") — launch aborted instead of confirming exit`,
    );
    this.name = 'ClaudeStartupDialogError';
    this.dialog = dialog;
  }
}

export interface AcceptClaudeStartupDialogsOptions {
  inputWriter: TerminalInputWriterPort;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 100;
const SELECT_SETTLE_MS = 80;
const AFTER_ENTER_MS = 250;
const MAX_ACCEPTS = 3;

function realSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

/**
 * If Claude is showing a blocking startup dialog, accept the non-exit
 * option. Repeats for stacked dialogs (trust, then bypass-permissions).
 * Returns once no dialog is visible. Throws {@link ClaudeStartupDialogError}
 * if a dialog is still up at the deadline so the caller does not deliver
 * the task prompt onto "No, exit".
 */
export async function acceptClaudeStartupDialogsIfPresent(
  backend: TerminalBackend,
  sessionId: SessionId,
  options: AcceptClaudeStartupDialogsOptions,
): Promise<void> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const sleep = options.sleep ?? realSleep;
  const deadline = Date.now() + options.timeoutMs;
  let accepts = 0;

  const loop = async (): Promise<void> => {
    while (Date.now() <= deadline) {
      throwIfLaunchAborted(options.signal, sessionId);
      const bytes = await backend.captureBytes(sessionId);
      const dialog = detectClaudeBlockingStartupDialog(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      if (!dialog) return;
      if (accepts >= MAX_ACCEPTS) {
        throw new ClaudeStartupDialogError(dialog, sessionId);
      }
      await options.inputWriter.writeInput(sessionId, translateKeystroke('Down'), {
        reason: 'claude-startup-dialog-down',
      });
      await sleep(SELECT_SETTLE_MS);
      await options.inputWriter.writeInput(sessionId, ENTER_BYTES, {
        reason: 'claude-startup-dialog-enter',
      });
      accepts += 1;
      await sleep(AFTER_ENTER_MS);
    }

    const bytes = await backend.captureBytes(sessionId);
    const still = detectClaudeBlockingStartupDialog(
      new TextDecoder('utf-8', { fatal: false }).decode(bytes),
    );
    if (still) throw new ClaudeStartupDialogError(still, sessionId);
  };

  await raceAgainstLaunchAbort(loop(), options.signal, sessionId);
}
