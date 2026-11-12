/**
 * Cleans text that came from a task (a request, a closing summary, terminal output)
 * before it is sent to the model provider: the codes a terminal uses to draw are
 * removed, and secret-looking tokens are hidden.
 *
 * ## Why the two jobs are done together
 *
 * The secret patterns rely on word boundaries, and a terminal code sits exactly where
 * a boundary should be:
 *
 * - `Bearer` + cursor-jump code + `ghp_…`: on screen there is a gap. Delete the code
 *   first and the text reads `Bearerghp_…`, which no longer looks like a token.
 * - `sk-abc` + colour code + `def…`: on screen it is one token. Hide secrets first and
 *   neither half is long enough to be recognised.
 *
 * ## How it works
 *
 * 1. One pass over the text finds every terminal code, as a range of the raw text. A
 *    code is "zero-width" (a colour, an erase, a window title: it takes no room on
 *    screen) or a "gap" (it moves the cursor, so what follows is apart from what came
 *    before). The scanner follows the terminal-code grammar (ECMA-48), and every
 *    escape, 8-bit control and control character ends up inside a range, whole.
 * 2. Secrets are looked for in five readings of the text, because no single reading
 *    is right for every case:
 *    - every code separates words (finds a token standing right after a code);
 *    - zero-width codes join, gaps separate (finds a token a colour runs through);
 *    - every code joins, looking only for tokens with a known prefix (finds such a
 *      token whatever runs through it, without mistaking ordinary words placed by
 *      cursor jumps for one long token);
 *    - only the escape or control character itself separates, and the rest of the
 *      code counts as text (known prefixes only); and, separately, the code separates
 *      but its last character counts as text. Between them these find a token whose
 *      first letter the scanner read as the end of a code that was in fact cut off
 *      (`ESC[35;1` + `ghp_…`).
 *
 *    The readings that join ordinary text together look only for known prefixes: with
 *    the "any run of 32 or more characters" rule they would hide ordinary words. On
 *    150 real saved terminal tails (34 million characters) the five readings hid one
 *    span more than laying the text out and redacting it once, and never one less.
 * 3. Every span any reading found is hidden, in the raw text, in one go. Then the
 *    codes that remain are rendered: nothing for a zero-width code, a space for a gap.
 *
 * Text with no control characters gets exactly the ordinary redaction.
 *
 * ## What it does not do
 *
 * It reads the stream, it does not emulate a screen. A token that only exists on screen
 * because characters were overwritten (backspace, cursor-left and retype) is not put
 * back together, and a long random run with no known prefix is not joined across a
 * cursor move. Rendering the screen with a real emulator needs a worker with a deadline
 * (see `server/streaming-attach-snapshot.ts`) and is a follow-up.
 */

import { redactSpeechSecrets, speechSecretSpans } from '../task-speech-summary.js';

interface CodeRange {
  start: number;
  /** Exclusive. */
  end: number;
  /** True when the code takes no room on screen; false when what follows it is apart from what came before. */
  zeroWidth: boolean;
}

const ESC = 0x1b;
const BEL = 0x07;
/** Longest string code (window title, hyperlink) accepted without its terminator, so one cannot swallow the rest of the text. */
const MAX_UNTERMINATED_STRING = 2048;
/** Final bytes of the control sequences that move the cursor. Every other control sequence is zero-width. */
const CURSOR_MOVE_FINALS = new Set('@ABCDEFGHIZ`adefsu');

const isParameter = (code: number): boolean => code >= 0x30 && code <= 0x3f;
const isIntermediate = (code: number): boolean => code >= 0x20 && code <= 0x2f;
const isControl = (code: number): boolean => (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
/** After ESC, these open a string code: OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`. */
const STRING_OPENERS_7BIT = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
/** The same openers as single 8-bit controls. */
const STRING_OPENERS_8BIT = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);

/** Find every terminal code in `text`. Linear: each character is looked at a bounded number of times. */
function scanCodes(text: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const code = text.charCodeAt(i);
    if (!isControl(code)) {
      i += 1;
      continue;
    }
    const start = i;
    const next = i + 1 < length ? text.charCodeAt(i + 1) : -1;

    if ((code === ESC && next === 0x5b) || code === 0x9b) {
      // Control sequence: parameters, intermediates, one final byte.
      let j = code === ESC ? i + 2 : i + 1;
      while (j < length && isParameter(text.charCodeAt(j))) j += 1;
      while (j < length && isIntermediate(text.charCodeAt(j))) j += 1;
      const final = j < length ? text.charCodeAt(j) : -1;
      if (final >= 0x40 && final <= 0x7e) {
        ranges.push({ start, end: j + 1, zeroWidth: !CURSOR_MOVE_FINALS.has(text[j]!) });
        i = j + 1;
      } else {
        // Cut off before its final byte: what was read of it is still a code, not text.
        ranges.push({ start, end: j, zeroWidth: false });
        i = j;
      }
      continue;
    }

    if ((code === ESC && STRING_OPENERS_7BIT.has(next)) || STRING_OPENERS_8BIT.has(code)) {
      // String code: runs to BEL, or to the string terminator (ESC \ or the 8-bit ST).
      let j = code === ESC ? i + 2 : i + 1;
      const limit = Math.min(length, j + MAX_UNTERMINATED_STRING);
      let end = -1;
      while (j < limit) {
        const c = text.charCodeAt(j);
        if (c === BEL || c === 0x9c) {
          end = j + 1;
          break;
        }
        if (c === ESC) {
          end = j + 1 < length && text.charCodeAt(j + 1) === 0x5c ? j + 2 : j; // ESC \ ends it; any other ESC starts a new code
          break;
        }
        if (c === 0x0a) {
          end = j; // never terminated: it does not run past its line
          break;
        }
        j += 1;
      }
      if (end === -1) end = j;
      ranges.push({ start, end, zeroWidth: true });
      i = end;
      continue;
    }

    if (code === ESC) {
      // Short escape: intermediates, then one final byte.
      let j = i + 1;
      while (j < length && isIntermediate(text.charCodeAt(j))) j += 1;
      const final = j < length ? text.charCodeAt(j) : -1;
      const end = final >= 0x30 && final <= 0x7e ? j + 1 : j;
      ranges.push({ start, end, zeroWidth: false });
      i = end;
      continue;
    }

    // A lone control character. A carriage return that only precedes a line feed takes no room.
    ranges.push({ start, end: i + 1, zeroWidth: code === 0x0d && next === 0x0a });
    i += 1;
  }
  return ranges;
}

type Span = [start: number, end: number];

/**
 * Look for secrets in one reading of the text. `keep(range)` says what a code becomes in
 * this reading: `'drop'` (it joins its neighbours), `'separate'` (it stands between
 * them), `'first'` (only its first character separates; the rest is read as text), or
 * `'last'` (it separates, but its last character is read as text).
 * Returns the spans found, as offsets into the raw text.
 */
function secretsInReading(
  text: string,
  ranges: readonly CodeRange[],
  keep: (range: CodeRange) => 'drop' | 'separate' | 'first' | 'last',
  kind: 'all' | 'prefixed',
): Span[] {
  // The reading is built from slices of the raw text, with a table saying where each slice came
  // from, so a megabyte of output costs a few string joins rather than a step per character.
  let view = '';
  const pieces: Array<{ viewStart: number; rawStart: number }> = [];
  const copy = (from: number, to: number): void => {
    if (to <= from) return;
    pieces.push({ viewStart: view.length, rawStart: from });
    view += text.slice(from, to);
  };
  const separator = (at: number): void => {
    pieces.push({ viewStart: view.length, rawStart: at });
    view += '\n'; // never part of a secret, always a word boundary
  };
  let cursor = 0;
  for (const range of ranges) {
    copy(cursor, range.start);
    const mode = keep(range);
    if (mode !== 'drop') {
      separator(range.start);
      if (mode === 'first') copy(range.start + 1, range.end);
      else if (mode === 'last' && range.end - range.start >= 2) copy(range.end - 1, range.end);
    }
    cursor = range.end;
  }
  copy(cursor, text.length);

  /** Where the character at `index` of the reading sits in the raw text. */
  const toRaw = (index: number): number => {
    let low = 0;
    let high = pieces.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (pieces[middle]!.viewStart <= index) low = middle;
      else high = middle - 1;
    }
    const piece = pieces[low]!;
    return piece.rawStart + (index - piece.viewStart);
  };
  return speechSecretSpans(view, kind).map(([start, end]): Span => [toRaw(start), toRaw(end - 1) + 1]);
}

/**
 * Task text made safe to send to the model provider: terminal codes removed, secrets
 * hidden. Line breaks and tabs are kept.
 */
export function cleanTaskText(text: string): string {
  const ranges = scanCodes(text);
  if (ranges.length === 0) return redactSpeechSecrets(text);

  const spans: Span[] = [
    ...secretsInReading(text, ranges, () => 'separate', 'all'),
    ...secretsInReading(text, ranges, (range) => (range.zeroWidth ? 'drop' : 'separate'), 'all'),
    ...secretsInReading(text, ranges, () => 'drop', 'prefixed'),
    ...secretsInReading(text, ranges, () => 'first', 'prefixed'),
    ...secretsInReading(text, ranges, () => 'last', 'all'),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let out = '';
  let cursor = 0; // everything before this offset of the raw text has been written
  let nextRange = 0;
  /** Write raw text up to `to`, rendering the codes on the way. */
  const writePlain = (to: number): void => {
    while (cursor < to) {
      while (nextRange < ranges.length && ranges[nextRange]!.end <= cursor) nextRange += 1;
      const range = ranges[nextRange];
      if (!range || range.start >= to) {
        out += text.slice(cursor, to);
        cursor = to;
        return;
      }
      out += text.slice(cursor, Math.max(cursor, range.start));
      out += range.zeroWidth ? '' : ' ';
      cursor = Math.max(cursor, range.end);
    }
  };
  for (const [start, end] of spans) {
    if (end <= cursor) continue; // inside a span already hidden
    writePlain(Math.max(cursor, start));
    out += '[redacted]';
    cursor = Math.max(cursor, end);
  }
  writePlain(text.length);
  // The ordinary redaction once more, over what will actually be sent: it also handles the
  // prompt delimiters, and anything it would hide in the final text is hidden.
  return redactSpeechSecrets(out);
}

/**
 * The text as a terminal would lay it out, with no secret hiding. For display and tests;
 * text bound for the provider must go through {@link cleanTaskText}.
 */
export function stripTerminalControl(text: string): string {
  const ranges = scanCodes(text);
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start) + (range.zeroWidth ? '' : ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}
