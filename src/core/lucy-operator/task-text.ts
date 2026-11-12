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
 * 1. One pass over the text finds every terminal code, as a range of the raw text,
 *    reading them the way a terminal does (the ECMA-48 grammar, malformed codes
 *    included). Every escape, 8-bit control and control character ends up inside a
 *    range, whole.
 * 2. Each code either joins its neighbours or separates them. **Only the codes that
 *    move the cursor separate**, and they are a short, fixed list (see
 *    `CURSOR_MOVE_FINALS`, `CURSOR_MOVE_ESCAPES`, `CURSOR_MOVE_CONTROLS`). Every other
 *    code joins, including any code the list has never heard of. That is the safe
 *    direction: joining can make more text look like one token, never less.
 * 3. Secrets are looked for in five readings of the text, because no single reading is
 *    right for every case:
 *    - every code separates words (finds a token standing right after a code);
 *    - joining codes join, cursor moves separate (finds a token that a colour, an
 *      erase or a mode change runs through);
 *    - every code joins, looking only for tokens with a known prefix (a net under the
 *      list above: such a token is found even if a code was wrongly taken for a
 *      cursor move);
 *    - only the escape or control character itself separates, and the rest of the
 *      code counts as text (known prefixes only); and, separately, the code separates
 *      but its last character counts as text. Between them these find a token whose
 *      first letter the scanner read as the end of a code that was in fact cut off
 *      (`ESC[35;1` + `ghp_…`).
 *
 *    The readings that put ordinary text together where a cursor move stood look only
 *    for known prefixes: with the "any run of 32 or more characters" rule they would
 *    hide ordinary words that a terminal placed side by side.
 * 4. Every span any reading found is hidden, in the raw text, in one go. Then the
 *    codes that remain are rendered: nothing for a joining code, a space for a cursor
 *    move.
 *
 * Text with no control characters gets exactly the ordinary redaction.
 *
 * ## The guarantee, and what it does not cover
 *
 * A token that the ordinary redaction would hide in plain text is hidden when any
 * codes stand before it, after it, or inside it, with two exceptions:
 *
 * - **A token with no known prefix that a cursor move splits.** On screen the two
 *   halves are usually apart. They are read as two pieces, and a piece shorter than 32
 *   characters is not hidden. (Tokens with a known prefix are hidden even then.)
 * - **A token that exists only on screen**, because characters were overwritten in
 *   place (backspace or cursor-left, then retype). This reads the stream; it does not
 *   emulate a screen.
 *
 * Side effect of the net: a word glued straight onto a prefixed token by a code is
 * hidden with it.
 *
 * Rendering the screen with a real emulator removes both exceptions, but an emulator
 * fed untrusted output needs a worker with a deadline (see
 * `server/streaming-attach-snapshot.ts`); that is a follow-up.
 */

import { redactSpeechSecrets, speechSecretSpans } from '../task-speech-summary.js';

interface CodeRange {
  start: number;
  /** Exclusive. */
  end: number;
  /**
   * True when what stands before the code and what stands after it are next to each other on
   * screen, so the code may run through the middle of one word. False for the codes that move
   * the cursor (the short list below): what follows one of those is apart from what came before.
   */
  joins: boolean;
}

const ESC = 0x1b;
const BEL = 0x07;
const DEL = 0x7f;
/** Longest string code (window title, hyperlink) accepted without its terminator, so one cannot swallow the rest of the text. */
const MAX_UNTERMINATED_STRING = 2048;
/** Longest control sequence or short escape followed to its final byte. Real ones are a few characters. */
const MAX_SEQUENCE = 256;

/*
 * The codes that move the cursor. This list is the whole of it: every other code, known
 * or not, is taken to join its neighbours. That is the safe direction for a code this
 * list has never heard of: joining can only make more text look like one token, never
 * split a token in two.
 */
/** Final bytes of cursor-moving control sequences: up, down, forward, back, next line, previous line, column, position, tab stops, row, restore. */
const CURSOR_MOVE_FINALS = new Set('ABCDEFGHIZ`adefu');
/** Short escapes that move the cursor: index, next line, reverse index, restore cursor, full reset. */
const CURSOR_MOVE_ESCAPES = new Set(['D', 'E', 'M', '8', 'c']);
/** Control characters that move the cursor: backspace, vertical tab, form feed, carriage return, and the 8-bit index, next line, reverse index. */
const CURSOR_MOVE_CONTROLS = new Set([0x08, 0x0b, 0x0c, 0x0d, 0x84, 0x85, 0x8d]);

/** Tab and line feed are ordinary text here; every other control character, 7-bit or 8-bit, is a code. */
const isControl = (code: number): boolean => (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= DEL && code <= 0x9f);
/** Inside a sequence a terminal acts on a control character (or ignores DEL) and carries on reading the sequence. */
const isPassedOverInSequence = (code: number): boolean => (code <= 0x1f && code !== ESC) || code === DEL;
/** After ESC, these open a string code: OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`. */
const STRING_OPENERS_7BIT = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
/** The same openers as single 8-bit controls. */
const STRING_OPENERS_8BIT = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);

/**
 * Find every terminal code in `text`, the way a terminal reads them. Linear: a sequence
 * is followed for a bounded number of characters, and no character is read twice.
 */
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
      // Control sequence: any run of parameter and intermediate bytes (0x20 to 0x3f), then one
      // final byte. A terminal reads a malformed one (a parameter after an intermediate, a
      // control character in the middle) through to its final byte all the same, so this does too.
      const body = code === ESC ? i + 2 : i + 1;
      const limit = Math.min(length, body + MAX_SEQUENCE);
      let j = body;
      while (j < limit) {
        const c = text.charCodeAt(j);
        if ((c >= 0x20 && c <= 0x3f) || isPassedOverInSequence(c)) j += 1;
        else break;
      }
      const final = j < length ? text.charCodeAt(j) : -1;
      if (j < limit && final >= 0x40 && final <= 0x7e) {
        const first = body < length ? text.charCodeAt(body) : -1;
        const privatePrefix = first >= 0x3c && first <= 0x3f; // "<", "=", ">", "?": a terminal-specific code, not a cursor move
        ranges.push({ start, end: j + 1, joins: privatePrefix || !CURSOR_MOVE_FINALS.has(text[j]!) });
        i = j + 1;
      } else {
        // Cut off before its final byte: what was read of it is still a code, not text.
        ranges.push({ start, end: j, joins: true });
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
      if (end === -1) {
        // Never terminated and too long to follow. Stop here, but not in the middle of a word:
        // the rest of a token that straddles this point must not be left behind as ordinary text.
        const wordLimit = Math.min(length, j + MAX_SEQUENCE);
        while (j < wordLimit && !/\s/.test(text[j]!) && !isControl(text.charCodeAt(j))) j += 1;
        end = j;
      }
      ranges.push({ start, end, joins: true });
      i = end;
      continue;
    }

    if (code === ESC) {
      // Short escape: any intermediates (0x20 to 0x2f), then one final byte.
      const limit = Math.min(length, i + 1 + MAX_SEQUENCE);
      let j = i + 1;
      while (j < limit) {
        const c = text.charCodeAt(j);
        if ((c >= 0x20 && c <= 0x2f) || isPassedOverInSequence(c)) j += 1;
        else break;
      }
      const final = j < length ? text.charCodeAt(j) : -1;
      const end = j < limit && final >= 0x30 && final <= 0x7e ? j + 1 : j;
      ranges.push({ start, end, joins: !(end - start === 2 && CURSOR_MOVE_ESCAPES.has(text[start + 1]!)) });
      i = end;
      continue;
    }

    // A lone control character. A carriage return that only precedes a line feed is part of the line break.
    ranges.push({ start, end: i + 1, joins: !CURSOR_MOVE_CONTROLS.has(code) || (code === 0x0d && next === 0x0a) });
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
    ...secretsInReading(text, ranges, (range) => (range.joins ? 'drop' : 'separate'), 'all'),
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
      out += range.joins ? '' : ' ';
      cursor = Math.max(cursor, range.end);
    }
  };
  let hiddenUpTo = -1; // where the latest hidden span ends, or -1 before the first one
  for (const [start, end] of spans) {
    if (end <= cursor) continue; // inside a span already hidden
    if (start <= hiddenUpTo) {
      // Overlaps or touches the span just hidden (two readings found the same token): one marker covers both.
      cursor = Math.max(cursor, end);
      hiddenUpTo = cursor;
      continue;
    }
    writePlain(Math.max(cursor, start));
    out += '[redacted]';
    cursor = Math.max(cursor, end);
    hiddenUpTo = cursor;
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
    out += text.slice(cursor, range.start) + (range.joins ? '' : ' ');
    cursor = range.end;
  }
  return out + text.slice(cursor);
}
