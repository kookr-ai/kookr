/**
 * Viewport-first streaming attach seed (RFC Phase 1 / C4, issue #1934).
 *
 * Cold streaming attaches used to ship the full ring (up to 1 MiB). This
 * module seeds the last N KB instead, with a **defined** safe cut so we never
 * start mid-CSI or mid-UTF-8. Absolute-position TUI paths do not use it.
 *
 * A byte suffix is not a picture of the screen for an agent that redraws
 * differentially, so the v2 attach prefers a screen snapshot (see
 * `streaming-attach-snapshot.ts`, issue #3564). This cut is what it falls back
 * to, and it is still the seed on the legacy v1 path.
 *
 * `bytes` must already be in logical order (oldest → newest), as returned by
 * `TerminalBackend.captureBytes`. Ring wraparound is handled by capture; this
 * function only cuts a logical suffix.
 */

/** Default seed budget: last 64 KiB of streaming scrollback. */
export const DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES = 64 * 1024;

/**
 * How far to look *before* the rough cut for an incomplete CSI or 2-byte ESC
 * sequence that started prior to the window. CSI params are short; 96 B is
 * generous. Escape *strings* (OSC, DCS, APC, PM, SOS) have no such bound: an
 * OSC 8 hyperlink carries a whole URL and an APC can carry an image, so their
 * opener is searched for without a distance limit (issue #3565).
 */
const ESC_LOOKBACK_BYTES = 96;

/**
 * Cut a logical ring snapshot to the last `maxBytes`, advancing the start past
 * incomplete UTF-8 and incomplete CSI / 2-byte ESC sequences.
 *
 * Rules (tested):
 * - empty / maxBytes ≤ 0 → empty
 * - length ≤ maxBytes → full buffer (no allocation when possible)
 * - mid-UTF-8 continuation at the cut → advance to next leading/ASCII byte
 * - CSI (ESC [ … final) started before the cut and not finished → skip to after final
 * - escape string (OSC `ESC ]`, DCS `ESC P`, SOS `ESC X`, PM `ESC ^`, APC `ESC _`)
 *   open at the cut, however long → skip to where the string ends
 * - 2-byte ESC (ESC + final 0x40–0x5F, excluding the introducers above) straddling
 *   cut → skip past final
 * - wrap is N/A here (caller supplies logical order)
 */
export function cutStreamingAttachSeed(
  bytes: Uint8Array,
  maxBytes: number = DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES,
): Uint8Array {
  if (bytes.length === 0 || maxBytes <= 0) {
    return bytes.length === 0 ? bytes : new Uint8Array(0);
  }
  if (bytes.length <= maxBytes) {
    return bytes;
  }

  let start = bytes.length - maxBytes;
  start = advancePastIncompleteUtf8(bytes, start);
  start = advancePastIncompleteEscSequence(bytes, start);

  if (start >= bytes.length) {
    return new Uint8Array(0);
  }
  if (start === bytes.length - maxBytes && maxBytes === bytes.length) {
    return bytes;
  }
  return bytes.subarray(start);
}

/** True when `b` is a UTF-8 continuation byte (10xxxxxx). */
function isUtf8Continuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * If `start` lands inside a multi-byte UTF-8 character, advance to the next
 * character boundary (non-continuation). Caps at end of buffer.
 */
export function advancePastIncompleteUtf8(bytes: Uint8Array, start: number): number {
  let i = start;
  while (i < bytes.length && isUtf8Continuation(bytes[i]!)) {
    i += 1;
  }
  return i;
}

/**
 * If an ESC sequence began before `start` and has not finished by `start`,
 * advance to the first byte after that sequence. Handles CSI, escape strings
 * (OSC / DCS / SOS / PM / APC) and simple 2-byte ESC (sufficient for streaming
 * agent output).
 *
 * A string body never contains ESC (an ESC ends the string), so the last ESC
 * before `start` is the opener whenever the cut lands inside a string. That is
 * why the backward search for it is unbounded; CSI and 2-byte ESC still only
 * count within `ESC_LOOKBACK_BYTES`.
 */
export function advancePastIncompleteEscSequence(bytes: Uint8Array, start: number): number {
  if (start <= 0 || start >= bytes.length) return start;

  const escAt = bytes.lastIndexOf(0x1b, start - 1);
  if (escAt < 0) return start;

  const afterEsc = escAt + 1;
  if (afterEsc >= bytes.length) {
    // Lone ESC at end — skip it if cut is after it.
    return afterEsc >= start ? Math.min(bytes.length, afterEsc + 1) : start;
  }

  const intro = bytes[afterEsc]!;

  // Escape string: ESC ] / P / X / ^ / _ … terminator. Checked before the
  // lookback limit because a string can be any length.
  if (isStringIntroducer(intro)) {
    const resumeAt = findStringResume(bytes, afterEsc + 1, intro);
    // Ended before the cut — cut is fine. Otherwise the cut is inside the
    // string: resume where it ends (end of buffer if it never ends).
    return resumeAt <= start ? start : resumeAt;
  }

  if (escAt < start - ESC_LOOKBACK_BYTES) return start;

  // CSI: ESC [ params intermediate final(0x40–0x7E)
  if (intro === 0x5b /* [ */) {
    const finalAt = findCsiFinal(bytes, afterEsc + 1);
    if (finalAt < 0) {
      // Unterminated CSI through end of buffer — drop the partial from the seed.
      return bytes.length;
    }
    if (finalAt >= start) {
      // Sequence straddles the cut: begin after the final byte.
      return finalAt + 1;
    }
    // Sequence completed before the cut — cut is fine.
    return start;
  }

  // 2-byte ESC Fe (0x40–0x5F) excluding the CSI and string introducers above.
  // Also cover SS2/SS3 etc. Common: ESC 7/8, ESC M, ESC D, ESC E.
  if (intro >= 0x40 && intro <= 0x5f) {
    const finalAt = afterEsc;
    if (finalAt >= start) {
      return finalAt + 1;
    }
    return start;
  }

  // ESC + SP/intermediate + final (rare) — if final not yet reached, skip to end of look.
  // Treat unknown incomplete ESC as: if no final 0x30–0x7E after esc within window past start,
  // leave cut as-is (better partial SGR crumb than dropping useful text).
  return start;
}

/** OSC `]`, DCS `P`, SOS `X`, PM `^`, APC `_`: the ESC forms that open a string. */
function isStringIntroducer(b: number): boolean {
  return b === 0x5d || b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f;
}

/**
 * Index of the first byte after the escape string whose body starts at `from`,
 * or `bytes.length` if the string does not end in the buffer. A string ends
 * the way a VT parser ends it:
 * - ST (`ESC \`) → after the `\`
 * - BEL → after it, for OSC only (xterm's OSC terminator; other strings ignore BEL)
 * - CAN / SUB → after it (string cancelled)
 * - any other ESC → at that ESC (string cancelled; the ESC starts the next sequence)
 */
function findStringResume(bytes: Uint8Array, from: number, intro: number): number {
  for (let i = from; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x1b) {
      if (i + 1 >= bytes.length) return bytes.length; // ESC at end: ST or not is unknown.
      return bytes[i + 1] === 0x5c /* \ */ ? i + 2 : i;
    }
    if (b === 0x07 /* BEL */ && intro === 0x5d) return i + 1;
    if (b === 0x18 /* CAN */ || b === 0x1a /* SUB */) return i + 1;
  }
  return bytes.length;
}

/** Index of CSI final byte, or -1 if not found. */
function findCsiFinal(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b >= 0x40 && b <= 0x7e) return i;
    // Abort on ESC (nested) — treat as broken and stop.
    if (b === 0x1b) return -1;
  }
  return -1;
}
