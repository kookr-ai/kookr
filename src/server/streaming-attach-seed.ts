/**
 * Viewport-first streaming attach seed (RFC Phase 1 / C4, issue #1934).
 *
 * Cold streaming attaches used to ship the full ring (up to 1 MiB). Default
 * attach now seeds the last N KB with a **defined** safe cut so we never start
 * mid-CSI or mid-UTF-8. Absolute-position TUI paths do not use this module.
 *
 * `bytes` must already be in logical order (oldest → newest), as returned by
 * `TerminalBackend.captureBytes`. Ring wraparound is handled by capture; this
 * function only cuts a logical suffix.
 */

/** Default seed budget: last 64 KiB of streaming scrollback. */
export const DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES = 64 * 1024;

/**
 * How far to look *before* the rough cut for an incomplete ESC sequence that
 * started prior to the window. CSI params are short; 96 B is generous.
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
 * - 2-byte ESC (ESC + final 0x40–0x5F, excluding `[` / `]`) straddling cut → skip past final
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
 * advance to the first byte after that sequence. Only CSI and simple 2-byte
 * ESC are handled (sufficient for streaming agent output).
 */
export function advancePastIncompleteEscSequence(bytes: Uint8Array, start: number): number {
  if (start <= 0 || start >= bytes.length) return start;

  const lookFrom = Math.max(0, start - ESC_LOOKBACK_BYTES);
  // Find the last ESC in [lookFrom, start).
  let escAt = -1;
  for (let i = start - 1; i >= lookFrom; i--) {
    if (bytes[i] === 0x1b) {
      escAt = i;
      break;
    }
  }
  if (escAt < 0) return start;

  const afterEsc = escAt + 1;
  if (afterEsc >= bytes.length) {
    // Lone ESC at end — skip it if cut is after it.
    return afterEsc >= start ? Math.min(bytes.length, afterEsc + 1) : start;
  }

  const intro = bytes[afterEsc]!;

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

  // OSC: ESC ] … BEL (0x07) or ST (ESC \)
  if (intro === 0x5d /* ] */) {
    const endAt = findOscEnd(bytes, afterEsc + 1);
    if (endAt < 0) {
      return bytes.length;
    }
    if (endAt >= start) {
      return endAt + 1;
    }
    return start;
  }

  // 2-byte ESC Fe (0x40–0x5F) excluding [ and ] handled above.
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

/** Index of last byte of OSC terminator (BEL or the `\` of ST), or -1. */
function findOscEnd(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i++) {
    if (bytes[i] === 0x07 /* BEL */) return i;
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x5c /* ST: ESC \ */) return i + 1;
  }
  return -1;
}
