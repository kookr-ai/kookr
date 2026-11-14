/**
 * Cleans text that came from a task (its name, its request, its closing summary)
 * before it is sent to the model provider: the codes a terminal uses to draw are
 * removed, and secret-looking tokens are hidden.
 *
 * Such text is not terminal output, but an agent can paste terminal output into it, and
 * the operator can paste anything into a request. A task's terminal itself is not read
 * through here alone: `read_task_output` renders the screen first (issue #3683), and this
 * cleaner is only the safety net over the rendered text.
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
 *    included), up to a fixed length per code. Every escape, 8-bit control and
 *    control character ends up inside a range; tab and line feed are ordinary text.
 * 2. Each code either joins what stands on either side of it or separates it. **Only
 *    the codes that move the cursor separate**, and they are a short, fixed list (see
 *    `CURSOR_MOVE_FINALS`, `CURSOR_MOVE_ESCAPES`, `CURSOR_MOVE_CONTROLS`). Every other
 *    code joins, including any code the list has never heard of. Colours and erases,
 *    the codes found inside words in real output, leave the characters before and
 *    after them side by side on screen; a few rarer codes move the cursor without
 *    being on the list (setting a scrolling region, inserting lines, some mode
 *    changes), and are joined all the same.
 * 3. Secrets are looked for in five ways, because no single reading of the text is
 *    right for every case:
 *    - in the raw characters, codes and all, exactly as the ordinary redaction does;
 *    - with every code read as a separator (finds a whole token standing right after
 *      any code, even one that joins);
 *    - with joining codes removed and cursor moves read as separators: the text as it
 *      is laid out on screen (finds a token that a colour, an erase or a mode change
 *      runs through);
 *    - with every code removed, looking only for tokens with a known prefix, which may
 *      start at a word boundary or right where a cursor move stood (finds a prefixed
 *      token that cursor moves run through);
 *    - with a token allowed to start at any of the letters and digits a code ends with
 *      (finds a token whose first characters the scanner read as part of a code that
 *      was in fact cut off: `ESC[35;1` + `ghp_…`, or `ESC[` + a token that starts with
 *      digits).
 *
 *    The reading that removes cursor moves looks only for known prefixes: with the
 *    "any run of 32 or more characters" rule it would hide ordinary words that a
 *    terminal placed side by side.
 * 4. Every span found in any of these ways is hidden, in the raw text, in one go. The
 *    codes that remain are then rendered: nothing for a joining code, a space for a
 *    cursor move.
 * 5. The ordinary redaction is applied once more to the result, which is what is sent.
 *
 * ## What is promised
 *
 * Two things hold by construction, and tests check both:
 *
 * - **The floor on what came in.** Whatever the ordinary redaction (`redactSpeechSecrets`)
 *   would hide in the raw characters is hidden: the spans it finds there are among the
 *   spans hidden (step 3, first way), except a match that lies wholly inside one code,
 *   which is removed with the code. Text with no control characters gets exactly the
 *   ordinary redaction.
 * - **The floor on what goes out.** The cleaned text contains nothing the ordinary
 *   redaction would still hide in it (step 5). The ordinary redaction is the rule the
 *   rest of the product applies to text it sends to a model. (Callers then collapse
 *   white space, replace a copy of the untrusted-text marker with `[marker removed]`,
 *   or shorten the text. The first two cannot make a token. A cut can, by giving a long
 *   run the word boundary it lacked, so every caller that shortens runs the ordinary
 *   redaction again on the shortened text.)
 *
 * The other ways of looking (step 3) go further than those two floors. They are
 * defence in depth: each finds the cases named beside it, the tests walk the
 * terminal-code grammar and the real bytes `tput` emits to check them, and none of them
 * is a proof for every arrangement of codes. Known to be outside them:
 *
 * - **A token glued onto a word on screen.** `name_` + colour code + a long run is
 *   `name_…` with the run attached, and `Bearer` + colour code + half a key + another
 *   code + the other half is `Bearerghp_…`. The ordinary redaction does not treat
 *   either as a token in plain text, and neither does this, unless the whole token
 *   stands right after the code.
 * - **A token with no known prefix that a cursor move splits.** It is read as two
 *   pieces, as on screen, and a piece shorter than 32 characters is not recognised on
 *   its own.
 * - **A token that a cut-off code and a second code both touch.** A cut-off code takes
 *   the token's first characters. That is undone when the rest of the token follows
 *   in one piece, and may not be when another code splits it.
 * - **A token that exists only on screen**, because characters were overwritten in
 *   place (backspace or cursor-left, then retype). This reads characters; it does not
 *   emulate a screen.
 *
 * Side effect of the prefixed reading: a word that a cursor move glues straight onto a
 * prefixed token is hidden with it.
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
 * The codes taken to move the cursor. Every other code, known or not, is taken to join
 * its neighbours. Joining never splits a token in two, so a colour or an erase inside a
 * key cannot hide it from the layout reading. It can glue a token onto the word before
 * it, so a code that really moves the cursor but is not listed here can hide a token
 * from that reading; the floors in the header still hold in that case.
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
  /** Also accept a token that starts right where a dropped cursor move stood, whatever stands before it. */
  startAfterCursorMoves = false,
): Span[] {
  // The reading is built from slices of the raw text, with a table saying where each slice came
  // from, rather than a step per character.
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
  /** Places in the reading where a dropped cursor move stood, in order. */
  const whereCursorMovesStood: number[] = [];
  let cursor = 0;
  for (const range of ranges) {
    copy(cursor, range.start);
    if (keep(range) === 'separate') separator(range.start);
    else if (!range.joins && whereCursorMovesStood[whereCursorMovesStood.length - 1] !== view.length) whereCursorMovesStood.push(view.length);
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
  if (startAfterCursorMoves) {
    // Dropping a cursor move glues the word before it onto what follows, and a token there no
    // longer starts at a word boundary. On screen the cursor move is a gap, so try each such place.
    // A place inside a token already found is skipped: without that, text made of nothing but
    // codes and prefixes would be rescanned from every code and the cost would grow with its square.
    // (Two characters of slack: `sk-` can begin on the last two characters of a GitHub token.)
    const regular = found.length;
    let next = 0;
    let coveredUpTo = 0;
    for (const at of whereCursorMovesStood) {
      while (next < regular && found[next]![0] <= at) {
        coveredUpTo = Math.max(coveredUpTo, found[next]![1]);
        next += 1;
      }
      if (at >= view.length || at + 2 < coveredUpTo) continue;
      const end = speechSecretEndAt(view, at, kind);
      if (end !== null) {
        found.push([at, end]);
        coveredUpTo = Math.max(coveredUpTo, end);
      }
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
