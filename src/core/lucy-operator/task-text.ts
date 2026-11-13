/**
 * Cleans text that came from a task (its name, its request, its closing summary)
 * before it is sent to the model provider: the codes a terminal uses to draw are
 * removed, and secret-looking tokens are hidden.
 *
 * Such text is not terminal output, but an agent can paste terminal output into it, and
 * the operator can paste anything into a request. A task's terminal itself is not read
 * through here alone: that look-up waits for the screen to be rendered (issue #3683).
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
 * 3. Secrets are looked for in five ways, because no single reading of the text is
 *    right for every case:
 *    - in the raw characters, codes and all, exactly as the ordinary redaction does
 *      (this is what makes the floor below hold by construction);
 *    - every code separates words (finds a token standing right after a code);
 *    - joining codes join, cursor moves separate (finds a token that a colour, an
 *      erase or a mode change runs through);
 *    - every code joins, looking only for tokens with a known prefix. A token may
 *      start at a word boundary or right where a code stood. This finds a prefixed
 *      token that any codes run through, cursor moves included, and is a net under
 *      the list above in case a code was wrongly taken for a cursor move;
 *    - a token may start at any of the letters and digits a code ends with. This finds
 *      a token whose first characters the scanner read as part of a code that was in
 *      fact cut off (`ESC[35;1` + `ghp_…`, or `ESC[` + a token that starts with digits).
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
 * ## What is promised
 *
 * **The floor.** The result is never weaker than the ordinary redaction
 * (`redactSpeechSecrets`) applied to the same characters: whatever that would hide in
 * the raw text is hidden here, and text with no control characters gets exactly the
 * ordinary redaction. This is the rule the rest of the product applies to text it sends
 * to a model. It holds by construction, because the spans the ordinary redaction finds
 * in the raw text are among the spans hidden, and a fuzz test over text with codes in
 * it checks that no character of such a span survives.
 *
 * **On top of the floor.** A token is also hidden when terminal codes stand before it,
 * after it or inside it, where the ordinary redaction alone would miss it. The test
 * walks the terminal-code grammar and the real bytes `tput` emits to check this. It is
 * defence in depth, not a proof for every sequence of bytes, and two cases are known
 * to be outside it:
 *
 * - **A token with no known prefix that a cursor move splits.** On screen the two
 *   halves are usually apart. They are read as two pieces, and a piece shorter than 32
 *   characters is not hidden. A token with a known prefix (`sk-`, a GitHub token) is
 *   hidden even then, as long as it starts at a word boundary or right after a code.
 *   One that is glued onto a word with no code between (`Bearerghp_…`) is not a token
 *   to the ordinary redaction either, with or without codes further in.
 * - **A token that exists only on screen**, because characters were overwritten in
 *   place (backspace or cursor-left, then retype). This reads characters; it does not
 *   emulate a screen.
 *
 * Side effect of the net: a word glued straight onto a prefixed token by a code is
 * hidden with it.
 *
 * Reading a task's terminal needs more than this: there the screen is what matters, so
 * that look-up waits for a real emulator, run in a worker with a deadline (issue #3683,
 * and see `server/streaming-attach-snapshot.ts`).
 */

import { redactSpeechSecrets, speechSecretEndAt, speechSecretSpans } from '../task-speech-summary.js';

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
        // A cursor move is a plain control sequence: digits and ";" only, then the final byte. A
        // private prefix ("<", "=", ">", "?"), an intermediate byte (as in `ESC[1$u`) or a ":" makes
        // it a different function, even when the final byte is the same letter.
        const plain = /^[0-9;]*$/.test(text.slice(body, j));
        ranges.push({ start, end: j + 1, joins: !(plain && CURSOR_MOVE_FINALS.has(text[j]!)) });
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
      // Never terminated and too long to follow: stop here. What follows is read as text again.
      if (end === -1) end = j;
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
 * this reading: `'drop'` (it joins its neighbours) or `'separate'` (it stands between
 * them).
 * Returns the spans found, as offsets into the raw text.
 */
function secretsInReading(
  text: string,
  ranges: readonly CodeRange[],
  keep: (range: CodeRange) => 'drop' | 'separate',
  kind: 'all' | 'prefixed',
  /** Also accept a token that starts right where a dropped code stood, whatever stands before the code. */
  startAfterCodes = false,
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
  /** Places in the reading where a dropped code stood. */
  const whereCodesStood: number[] = [];
  let cursor = 0;
  for (const range of ranges) {
    copy(cursor, range.start);
    if (keep(range) === 'separate') separator(range.start);
    else if (whereCodesStood[whereCodesStood.length - 1] !== view.length) whereCodesStood.push(view.length);
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
  const found: Array<[number, number]> = speechSecretSpans(view, kind);
  if (startAfterCodes) {
    // Dropping a code glues the word before it onto what follows, and a token there no longer
    // starts at a word boundary. A code is a boundary all the same, so try each such place.
    for (const at of whereCodesStood) {
      if (at >= view.length) continue;
      const end = speechSecretEndAt(view, at, kind);
      if (end !== null) found.push([at, end]);
    }
  }
  return found.map(([start, end]): Span => [toRaw(start), toRaw(end - 1) + 1]);
}

/**
 * What the ordinary redaction finds in the raw characters, codes and all. A match that
 * lies wholly inside one code (a long run of parameter digits) is left out: the code is
 * removed anyway, and hiding it would put a marker where nothing was.
 */
function secretsInRawText(text: string, ranges: readonly CodeRange[]): Span[] {
  const spans: Span[] = [];
  let next = 0;
  for (const [start, end] of speechSecretSpans(text, 'all')) {
    while (next < ranges.length && ranges[next]!.end <= start) next += 1;
    const range = ranges[next];
    if (range && range.start <= start && end <= range.end) continue;
    spans.push([start, end]);
  }
  return spans;
}

/** How far back from the end of a code a swallowed token may start. Real codes end in a few letters and digits. */
const MAX_SWALLOWED = 40;

/**
 * Find tokens whose first characters the scanner read as the end of a code. A control
 * sequence that was cut off takes whatever follows as its parameters and final byte:
 * `ESC[` + `1a2b…` reads `1` as a parameter and `a` as the end. So for the letters and
 * digits a code ends with, each position is tried as the possible start of a token that
 * runs on into the text after the code.
 */
function secretsStartingInsideCodes(text: string, ranges: readonly CodeRange[]): Span[] {
  const spans: Span[] = [];
  for (const range of ranges) {
    let tail = range.end;
    const earliest = Math.max(range.start + 1, range.end - MAX_SWALLOWED);
    while (tail > earliest && /[A-Za-z0-9+/_-]/.test(text[tail - 1]!)) tail -= 1;
    for (let at = tail; at < range.end; at++) {
      const end = speechSecretEndAt(text, at);
      // Only a token that runs past the code counts: one that ends inside it is the code itself.
      if (end !== null && end > range.end) {
        spans.push([at, end]);
        break;
      }
    }
  }
  return spans;
}

/**
 * Task text made safe to send to the model provider: terminal codes removed, secrets
 * hidden. Line breaks and tabs are kept.
 */
export function cleanTaskText(text: string): string {
  const ranges = scanCodes(text);
  if (ranges.length === 0) return redactSpeechSecrets(text);

  const spans: Span[] = [
    // The floor: the ordinary redaction of the raw characters, exactly as the rest of the product
    // applies it. Everything after this line can only add to what is hidden.
    ...secretsInRawText(text, ranges),
    ...secretsInReading(text, ranges, () => 'separate', 'all'),
    ...secretsInReading(text, ranges, (range) => (range.joins ? 'drop' : 'separate'), 'all'),
    ...secretsInReading(text, ranges, () => 'drop', 'prefixed', true),
    ...secretsStartingInsideCodes(text, ranges),
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
