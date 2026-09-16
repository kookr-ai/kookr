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
import type { SessionId } from './terminal-backend.js';

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

export interface DismissClaudeStartupDialogOptions {
  inputWriter: TerminalInputWriterPort;
  sleep?: (ms: number) => Promise<void>;
}

const SELECT_SETTLE_MS = 80;

function realSleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((res) => setTimeout(res, ms)) : Promise.resolve();
}

const paneDecoder = new TextDecoder('utf-8', { fatal: false });

/** True when the captured pane is a Claude startup dialog that defaults to No, exit. */
export function isClaudeStartupDialogBlocking(rawBytes: Uint8Array): boolean {
  return detectClaudeBlockingStartupDialog(paneDecoder.decode(rawBytes)) !== null;
}

/**
 * Accept the non-exit option on a visible Claude startup dialog (Down,
 * then Enter). The paste-ready wait calls this when {@link isClaudeStartupDialogBlocking}
 * is true, then keeps polling until the composer is ready or the wait
 * fails closed.
 */
export async function dismissClaudeStartupDialog(
  sessionId: SessionId,
  options: DismissClaudeStartupDialogOptions,
): Promise<void> {
  const sleep = options.sleep ?? realSleep;
  await options.inputWriter.writeInput(sessionId, translateKeystroke('Down'), {
    reason: 'claude-startup-dialog-down',
  });
  await sleep(SELECT_SETTLE_MS);
  await options.inputWriter.writeInput(sessionId, ENTER_BYTES, {
    reason: 'claude-startup-dialog-enter',
  });
}
