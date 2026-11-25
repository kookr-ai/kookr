/**
 * The operator's unsent terminal draft: the text typed into a task's agent
 * input box that has not been submitted yet.
 *
 * The server rebuilds it from the raw bytes the dashboard terminal forwards to
 * the agent, so that background close paths can see "a human is writing in
 * this task" and leave the task alone (the bug where a task was force-completed
 * while the operator was writing its next prompt). It is an approximation of
 * what the agent's input box holds: cursor moves and in-place edits are not
 * replayed, so it is good enough to answer "is there unsent text?" and to keep
 * the typed text recoverable, but it is not a faithful editor model.
 *
 * Rules, per input chunk:
 * - Enter (CR or LF) submits the draft, so the draft becomes empty. Ctrl-C and
 *   Ctrl-U also empty it, because the agent clears its input box on both.
 * - A backslash or ESC right before Enter is the agent's "insert a newline"
 *   chord, not a submit: it becomes a newline in the draft.
 * - Backspace / DEL remove the last character.
 * - Text inside a bracketed paste (`ESC [200~ ... ESC [201~`) is kept as
 *   typed, newlines included: a paste never submits.
 * - Escape sequences (arrow keys, focus reports, device-attribute replies...)
 *   and other control bytes are dropped: they are not text.
 */

const ENTER_CHARS = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BACKSPACE = '\b';
const DELETE = '\u007f';
const ESC = '\u001b';
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/**
 * Matches one escape sequence at the start of a string: CSI (`ESC [ ... final`),
 * SS3 (`ESC O x`), OSC (`ESC ] ... BEL|ST`), or a two-byte `ESC x`.
 */
const ESCAPE_SEQUENCE_RE =
  /^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[^[\]O])/;

/** Upper bound on the tracked draft, so a runaway stream cannot grow memory. */
export const OPERATOR_DRAFT_MAX_CHARS = 64 * 1024;

export interface OperatorDraftInput {
  /** The bytes as text, exactly as forwarded to the agent. */
  text: string;
  /**
   * True for a dashboard paste frame: the bridge wraps it in bracketed-paste
   * markers itself, so the text is literal and never submits.
   */
  paste?: boolean;
}

function appendLiteral(draft: string, text: string): string {
  // Keep newlines and tabs; drop other control bytes.
  // eslint-disable-next-line no-control-regex
  return draft + text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

function cap(draft: string): string {
  return draft.length > OPERATOR_DRAFT_MAX_CHARS ? draft.slice(-OPERATOR_DRAFT_MAX_CHARS) : draft;
}

/** Apply one input chunk to the current draft and return the new draft. */
export function reduceOperatorDraft(draft: string, input: OperatorDraftInput): string {
  if (input.paste) return cap(appendLiteral(draft, input.text));

  let next = draft;
  let rest = input.text;
  while (rest.length > 0) {
    if (rest.startsWith(PASTE_START)) {
      const end = rest.indexOf(PASTE_END, PASTE_START.length);
      const body = end === -1 ? rest.slice(PASTE_START.length) : rest.slice(PASTE_START.length, end);
      next = appendLiteral(next, body);
      rest = end === -1 ? '' : rest.slice(end + PASTE_END.length);
      continue;
    }
    const char = rest[0]!;
    if (char === ESC) {
      // ESC + Enter: the agent's newline chord (Meta/Option+Enter).
      if (rest.length > 1 && ENTER_CHARS.has(rest[1]!)) {
        next += '\n';
        rest = rest.slice(2);
        continue;
      }
      const match = ESCAPE_SEQUENCE_RE.exec(rest);
      rest = rest.slice(match ? match[0].length : 1);
      continue;
    }
    rest = rest.slice(1);
    if (ENTER_CHARS.has(char)) {
      // Backslash + Enter: the agent's newline chord, not a submit.
      if (next.endsWith('\\')) {
        next = `${next.slice(0, -1)}\n`;
      } else {
        next = '';
      }
      // Swallow the LF of a CRLF pair so it does not count twice.
      if (char === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
    } else if (char === CTRL_C || char === CTRL_U) {
      next = '';
    } else if (char === DELETE || char === BACKSPACE) {
      next = Array.from(next).slice(0, -1).join('');
    } else if (char === '\t' || char >= ' ') {
      next += char;
    }
  }
  return cap(next);
}

/** True when the draft holds something a human would not want to lose. */
export function isNonEmptyOperatorDraft(draft: string | undefined | null): boolean {
  return typeof draft === 'string' && draft.trim().length > 0;
}
