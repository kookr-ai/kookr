/**
 * Detect dense absolute-position TUI frames in a terminal ring buffer.
 *
 * Agents like Grok Build paint with thousands of CUP (`ESC[row;colH`) cell
 * updates and synchronized-output frames, and almost never issue ED2
 * (`ESC[2J`). Replaying that history into a browser xterm at a different
 * geometry produces the "smashed / overlapping / raw SGR crumbs" pane.
 *
 * Line-oriented shells and lighter TUIs (few CUPs, occasional clears) return
 * false so SessionBridge can keep replaying their scrollback.
 */

const SAMPLE_TAIL_BYTES = 256 * 1024;

/** Minimum CUP count in the sample before we treat the ring as absolute-TUI. */
const MIN_CUP_COUNT = 200;

/**
 * Absolute-TUI rings almost never full-clear. Allow a tiny ED2 count so a
 * single clear at session start does not disable the heuristic.
 */
const MAX_ED2_COUNT = 2;

export interface AbsolutePositionTuiRingStats {
  sampleBytes: number;
  cupCount: number;
  ed2Count: number;
  syncOutputCount: number;
  maxCol: number;
}

interface CsiScan {
  cupCount: number;
  ed2Count: number;
  syncOutputCount: number;
  maxCol: number;
}

/**
 * Scan `[from, to)` for CUP / ED2 / DECSET 2026 markers without allocating a
 * UTF-8 string of multi-megabyte rings.
 */
function scanCsiRange(bytes: Uint8Array, from: number, to: number): CsiScan {
  let cupCount = 0;
  let ed2Count = 0;
  let syncOutputCount = 0;
  let maxCol = 0;

  for (let i = from; i < to; i++) {
    // ESC [
    if (bytes[i] !== 0x1b || bytes[i + 1] !== 0x5b) continue;

    let j = i + 2;
    // Optional private marker for DECSET (?…)
    const privateMarker = bytes[j] === 0x3f /* ? */ ? bytes[j++] : 0;

    let n1 = -1;
    let n2 = -1;
    let current = 0;
    let hasDigit = false;
    let paramIndex = 0;

    while (j < to) {
      const b = bytes[j];
      if (b >= 0x30 && b <= 0x39) {
        current = current * 10 + (b - 0x30);
        hasDigit = true;
        j++;
        continue;
      }
      if (b === 0x3b /* ; */) {
        if (paramIndex === 0) n1 = hasDigit ? current : 0;
        else if (paramIndex === 1) n2 = hasDigit ? current : 0;
        paramIndex++;
        current = 0;
        hasDigit = false;
        j++;
        continue;
      }
      // Final byte of CSI (0x40–0x7E)
      if (b >= 0x40 && b <= 0x7e) {
        if (paramIndex === 0) n1 = hasDigit ? current : -1;
        else if (paramIndex === 1) n2 = hasDigit ? current : -1;

        if (privateMarker === 0x3f) {
          // DECSET/DECRST: ESC [ ? 2026 h/l
          if (n1 === 2026 && (b === 0x68 /* h */ || b === 0x6c /* l */)) {
            if (b === 0x68) syncOutputCount++;
          }
        } else if (b === 0x48 /* H */ || b === 0x66 /* f */) {
          // CUP / HVP: ESC [ row ; col H
          cupCount++;
          if (n2 > maxCol) maxCol = n2;
        } else if (b === 0x4a /* J */ && n1 === 2) {
          ed2Count++;
        }
        i = j;
        break;
      }
      // Intermediate / unexpected — abort this CSI
      break;
    }
  }

  return { cupCount, ed2Count, syncOutputCount, maxCol };
}

/**
 * Scan a byte buffer for CUP / ED2 / DECSET 2026 markers without allocating a
 * full UTF-8 string of multi-megabyte rings.
 *
 * Density (CUP / ED2 / sync) uses the newest 256 KiB so a long-idle Grok
 * spinner still looks like an absolute TUI. `maxCol` is taken from the whole
 * buffer: Grok's idle tail often only updates a low-column spinner, which
 * used to drop the session onto the streaming viewport-ring smash path.
 */
export function inspectAbsolutePositionTuiRing(bytes: Uint8Array): AbsolutePositionTuiRingStats {
  const tailStart = bytes.length > SAMPLE_TAIL_BYTES ? bytes.length - SAMPLE_TAIL_BYTES : 0;
  const tail = scanCsiRange(bytes, tailStart, bytes.length);
  const prefixMaxCol = tailStart === 0 ? 0 : scanCsiRange(bytes, 0, tailStart).maxCol;
  const maxCol = Math.max(tail.maxCol, prefixMaxCol);

  return {
    sampleBytes: bytes.length - tailStart,
    cupCount: tail.cupCount,
    ed2Count: tail.ed2Count,
    syncOutputCount: tail.syncOutputCount,
    maxCol,
  };
}

/**
 * Minimum rightmost CUP column observed in Grok-style full-width chrome.
 * Codex and Claude often absolute-position within ~80–110 cols; Grok paints
 * status columns out near 180–200. Requiring a wide layout avoids skipping
 * healthy Codex rings that also use sync-output + many CUPs.
 */
const MIN_WIDE_LAYOUT_COL = 120;

/**
 * True when replaying this ring into xterm would almost certainly paint a
 * corrupted absolute-position TUI frame stack (Grok-style).
 */
export function isAbsolutePositionTuiRing(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const stats = inspectAbsolutePositionTuiRing(bytes);
  if (stats.cupCount < MIN_CUP_COUNT) return false;
  if (stats.ed2Count > MAX_ED2_COUNT) return false;
  // Wide absolute layout is the load-bearing signal (Grok status/chrome columns).
  // Dense sync frames alone are not enough — Codex emits many of those too.
  return stats.maxCol >= MIN_WIDE_LAYOUT_COL;
}
