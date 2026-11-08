import { InputSubmitAbortedError, type SendInputOptions } from '../core/ports/agent-interaction-port.js';
import type { TerminalInputWriterPort } from '../core/ports/terminal-input-writer-port.js';
import { CLEAR_LINE_BYTES, ENTER_BYTES, encodeBracketedPaste } from './keystroke.js';

export { InputSubmitAbortedError };

/**
 * Type a composer message the way every agent adapter does: Ctrl-U (clear any
 * unsubmitted keystrokes, kookr F15), the text as one bracketed paste, then a
 * delayed Enter as an unambiguous submit keystroke (#935) — all as one
 * sequence inside the session's write queue.
 *
 * `opts.beforeSubmit` is evaluated by the writer inside that queue, right
 * before the Enter; a `false` aborts with {@link InputSubmitAbortedError} and
 * no Enter is written (issue #3513).
 */
export async function writeComposerInput(
  writer: TerminalInputWriterPort,
  sessionId: string,
  text: string,
  interPayloadDelayMs: number,
  opts?: SendInputOptions,
): Promise<void> {
  await writer.writeInputSequence(
    sessionId,
    [CLEAR_LINE_BYTES, encodeBracketedPaste(text), ENTER_BYTES],
    {
      reason: 'adapter-send-input',
      interPayloadDelayMs,
      ...(opts?.beforeSubmit ? { beforeFinalPayload: opts.beforeSubmit } : {}),
    },
  );
}
