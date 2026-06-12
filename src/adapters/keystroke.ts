/**
 * Keystroke translation — convert symbolic key names into the raw byte
 * sequences a PTY expects. Adapters use this when forwarding operator /
 * permission-menu keystrokes into `TerminalBackend.write`.
 *
 * Scope is deliberately narrow: only the key names Kookr actually sends
 * today. If a new caller needs `C-c`, `Escape`, arrow keys, etc., add them
 * here (backed by a test) instead of reintroducing backend-specific
 * parsing across the codebase.
 */

const ENTER_BYTES = Uint8Array.of(0x0d);
const CR_LF_BYTES = Uint8Array.of(0x0d, 0x0a);
const ESC_BYTES = Uint8Array.of(0x1b);
const TAB_BYTES = Uint8Array.of(0x09);
/**
 * Ctrl-U (NAK, 0x15) — "kill line" in readline-style editors. Both the
 * Claude Code and Codex CLI composers honor it as delete-to-start-of-line,
 * and it is a no-op on an empty input line. Adapters send it ahead of a
 * composer message so keystrokes typed into the terminal panel but never
 * submitted cannot be fused onto the front of the message (kookr F15).
 */
const CLEAR_LINE_BYTES = Uint8Array.of(0x15);

const encoder = new TextEncoder();

/**
 * Bracketed-paste markers (DECSET 2004). Agent TUIs parse everything between
 * these markers as a single paste event, so a trailing Enter sent separately
 * remains a submit keystroke even when the TUI drains input bytes in a burst.
 */
export const PASTE_START_TEXT = '\x1b[200~';
export const PASTE_END_TEXT = '\x1b[201~';

/**
 * Wrap a composer message in bracketed-paste markers. Embedded markers are
 * stripped first so message content cannot break out of the paste envelope
 * and turn following bytes into terminal commands.
 */
export function encodeBracketedPaste(text: string): Uint8Array {
  const safeBody = text.replaceAll(PASTE_START_TEXT, '').replaceAll(PASTE_END_TEXT, '');
  return encoder.encode(`${PASTE_START_TEXT}${safeBody}${PASTE_END_TEXT}`);
}

/**
 * Translate a keystroke name to its byte sequence. Unknown key names fall
 * through as their literal UTF-8 bytes, preserving the historical
 * behavior where a plain printable key sends the single byte 'y'.
 */
export function translateKeystroke(key: string): Uint8Array {
  switch (key) {
    case 'Enter':
    case 'Return':
      return ENTER_BYTES;
    case 'Enter\n':
      return CR_LF_BYTES;
    case 'Escape':
      return ESC_BYTES;
    case 'Tab':
      return TAB_BYTES;
    default:
      return encoder.encode(key);
  }
}

/** Byte constants exported for callers that assemble write-sequences. */
export { ENTER_BYTES, CLEAR_LINE_BYTES };
