/**
 * Terminal paste routing — decide whether a browser paste into a
 * Kookr-managed agent terminal needs the safe path or can stay byte-
 * transparent, and build the control frame for the safe path.
 *
 * See kookr issue #356: a multiline paste streamed as raw xterm bytes makes
 * the agent TUI submit one prompt per newline. Multiline pastes are routed
 * through a structured `paste` WS frame; the server (SessionBridge) wraps
 * them in bracketed-paste markers so the agent receives one atomic paste.
 */

/** Wire shape of the safe-paste control frame consumed by SessionBridge. */
export interface PasteFrame {
  type: 'paste';
  text: string;
}

/**
 * True when a paste would otherwise submit more than one agent prompt.
 *
 * The precise trigger is an embedded newline (CR or LF) — that is exactly
 * what an agent TUI treats as Enter. A single-line paste is byte-identical
 * to typing, so it stays on the raw path and ordinary input is untouched.
 */
export function isMultilinePaste(text: string): boolean {
  return /[\r\n]/.test(text);
}

/** Serialize the safe-paste control frame for `WebSocket.send`. */
export function buildPasteFrame(text: string): string {
  return JSON.stringify({ type: 'paste', text } satisfies PasteFrame);
}
