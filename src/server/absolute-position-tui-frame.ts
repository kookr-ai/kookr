/**
 * Extract a single usable absolute-position TUI frame from a ring buffer.
 *
 * Grok Build (and similar agents) paint with DECSET 2026 synchronized-output
 * frames. The ring accumulates thousands of those frames; replaying all of
 * them smashes the browser xterm. But the *largest recent* sync frame is
 * usually a complete screen paint and is safe to send once the browser xterm
 * is sized to match the agent's paint width (~200 cols for Grok).
 *
 * Attach-replay alone often only has sparse differential cells after
 * dtach's leading clear, so this ring-derived frame is the best cheap
 * "current screen" we have without a server-side VT emulator.
 */

const DECSET_2026_H = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68] as const; // ESC [ ? 2 0 2 6 h

/** Minimum payload size (bytes) to treat a sync region as a full frame. */
const MIN_FRAME_BYTES = 1500;
/** Minimum CUP count inside a sync region. */
const MIN_FRAME_CUPS = 40;
/** Prefer frames whose rightmost CUP is at least this wide (Grok chrome). */
const MIN_FRAME_MAX_COL = 100;
/** Only scan the tail of large rings. */
const SAMPLE_TAIL_BYTES = 512 * 1024;
/**
 * How many trailing sync regions to walk (newest first). Grok emits many tiny
 * spinner frames after a large paint, so the last few dozen starts are often
 * useless — scan far enough back to still hit a substantial frame.
 */
const MAX_CANDIDATES = 800;

function findSyncStarts(bytes: Uint8Array): number[] {
  const starts: number[] = [];
  const n = DECSET_2026_H.length;
  for (let i = 0; i + n <= bytes.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (bytes[i + j] !== DECSET_2026_H[j]) {
        ok = false;
        break;
      }
    }
    if (ok) starts.push(i);
  }
  return starts;
}

function scoreRegion(bytes: Uint8Array): { cups: number; maxCol: number } {
  let cups = 0;
  let maxCol = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x1b || bytes[i + 1] !== 0x5b) continue;
    let j = i + 2;
    let n1 = -1;
    let n2 = -1;
    let current = 0;
    let hasDigit = false;
    let paramIndex = 0;
    while (j < bytes.length) {
      const b = bytes[j];
      if (b >= 0x30 && b <= 0x39) {
        current = current * 10 + (b - 0x30);
        hasDigit = true;
        j++;
        continue;
      }
      if (b === 0x3b) {
        if (paramIndex === 0) n1 = hasDigit ? current : 0;
        else if (paramIndex === 1) n2 = hasDigit ? current : 0;
        paramIndex++;
        current = 0;
        hasDigit = false;
        j++;
        continue;
      }
      if (b >= 0x40 && b <= 0x7e) {
        if (paramIndex === 0) n1 = hasDigit ? current : -1;
        else if (paramIndex === 1) n2 = hasDigit ? current : -1;
        if (b === 0x48 || b === 0x66) {
          cups++;
          if (n2 > maxCol) maxCol = n2;
        }
        i = j;
        break;
      }
      break;
    }
  }
  return { cups, maxCol };
}

/**
 * Return the newest substantial DECSET-2026 region from `bytes`, or null when
 * nothing looks like a complete absolute-TUI paint.
 *
 * Prepends ESC[H ESC[2J so a blank xterm starts clean before the frame.
 */
export function extractLastSubstantialAbsoluteFrame(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === 0) return null;
  const sample = bytes.length > SAMPLE_TAIL_BYTES
    ? bytes.subarray(bytes.length - SAMPLE_TAIL_BYTES)
    : bytes;
  const starts = findSyncStarts(sample);
  if (starts.length === 0) return null;

  // Walk newest → oldest until we find a substantial region.
  const from = Math.max(0, starts.length - MAX_CANDIDATES);
  for (let i = starts.length - 1; i >= from; i--) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : sample.length;
    const region = sample.subarray(start, end);
    if (region.length < MIN_FRAME_BYTES) continue;
    const { cups, maxCol } = scoreRegion(region);
    if (cups < MIN_FRAME_CUPS) continue;
    if (maxCol < MIN_FRAME_MAX_COL) continue;

    // ESC [ H ESC [ 2 J + region
    const prefix = new Uint8Array([0x1b, 0x5b, 0x48, 0x1b, 0x5b, 0x32, 0x4a]);
    const out = new Uint8Array(prefix.length + region.length);
    out.set(prefix, 0);
    out.set(region, prefix.length);
    return out;
  }
  return null;
}
