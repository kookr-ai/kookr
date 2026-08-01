/**
 * Reconstruct a complete absolute-position TUI screen from a ring buffer.
 *
 * Grok Build paints with --no-alt-screen + DECSET 2026 synchronized frames:
 * each sync region is a *differential* dirty-cell paint, not a full screen.
 * Replaying the raw ring smashes the browser xterm; shipping only the last
 * substantial sync frame leaves missing letters (cells painted earlier and
 * never re-emitted). Multi-attach via dtach often yields only ESC[H ESC[J
 * (empty) for idle Grok sessions.
 *
 * Solution: walk the entire ring through a minimal VT cell buffer (CUP/EL/ED/
 * ECH + UTF-8 printables), then serialize the final grid as one clean frame.
 * No env opt-in — this is the default absolute-TUI seed path.
 *
 * Issue #1774: walks are time-budgeted and yield to the event loop every N
 * bytes so a full 1MB ring cannot starve keystroke delivery. Concurrent
 * reconstructs are process-wide capped at 1 (busy callers get null and fall
 * back to cheaper seed paths).
 */

import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export interface ReconstructAbsoluteTuiScreenOptions {
  cols?: number;
  rows?: number;
  /** Minimum non-space cells required to treat the result as useful. */
  minPrintableCells?: number;
  /**
   * Wall-clock budget (ms) for the VT walk. When exceeded, serialize a
   * best-effort frame from the partially filled grid (if printable enough)
   * or return null. Default 50ms.
   */
  maxMs?: number;
  /**
   * Yield to the event loop after processing this many input bytes.
   * Default 64 KiB. Set to 0 to disable cooperative yields; the maxMs budget
   * is still checked on the same default cadence (64 KiB).
   */
  yieldEveryBytes?: number;
  /**
   * When true (default), only one reconstruct runs process-wide; concurrent
   * callers receive null immediately so attach can fall back to a cheaper seed.
   */
  concurrencyCap?: boolean;
  /** Injected monotonic clock (tests). Defaults to `performance.now`. */
  nowMs?: () => number;
  /** Injected cooperative yield (tests). Defaults to `setImmediate`. */
  yieldFn?: () => Promise<void>;
}

/** Process-wide counters for attach/reconstruct observability (issue #1774). */
export interface ReconstructAbsoluteTuiScreenStats {
  completed: number;
  budgetExceeded: number;
  busySkipped: number;
  lastElapsedMs: number;
  lastBytesProcessed: number;
  lastTotalBytes: number;
  inFlight: boolean;
}

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const DEFAULT_MIN_PRINTABLE = 40;
/** Default budget keeps attach under a frame-ish slice of the event loop. */
const DEFAULT_MAX_MS = 50;
/** Yield cadence on a 1MB ring (~16 yields max before end). */
const DEFAULT_YIELD_EVERY_BYTES = 64 * 1024;

let reconstructInFlight = false;

const stats: ReconstructAbsoluteTuiScreenStats = {
  completed: 0,
  budgetExceeded: 0,
  busySkipped: 0,
  lastElapsedMs: 0,
  lastBytesProcessed: 0,
  lastTotalBytes: 0,
  inFlight: false,
};

export function getReconstructAbsoluteTuiScreenStats(): ReconstructAbsoluteTuiScreenStats {
  return {
    ...stats,
    inFlight: reconstructInFlight,
  };
}

/** Test helper: clear process-wide counters and concurrency lock. */
export function resetReconstructAbsoluteTuiScreenForTests(): void {
  reconstructInFlight = false;
  stats.completed = 0;
  stats.budgetExceeded = 0;
  stats.busySkipped = 0;
  stats.lastElapsedMs = 0;
  stats.lastBytesProcessed = 0;
  stats.lastTotalBytes = 0;
  stats.inFlight = false;
}

/**
 * Replay `bytes` into a cols×rows cell grid and return a single seed frame
 * (ESC[H ESC[2J + row paints), or null when the grid is essentially empty /
 * another reconstruct is already in flight / budget expired with too little
 * content.
 *
 * Cooperative: yields every `yieldEveryBytes` and aborts the walk after
 * `maxMs` so a full RING_BUFFER_BYTES (1MB) replay cannot block the event
 * loop for seconds (issue #1774).
 */
export async function reconstructAbsoluteTuiScreen(
  bytes: Uint8Array,
  options: ReconstructAbsoluteTuiScreenOptions = {},
): Promise<Uint8Array | null> {
  if (bytes.length === 0) return null;

  const concurrencyCap = options.concurrencyCap !== false;
  if (concurrencyCap && reconstructInFlight) {
    stats.busySkipped += 1;
    return null;
  }

  reconstructInFlight = true;
  stats.inFlight = true;
  const startedAt = (options.nowMs ?? (() => performance.now()))();
  const nowMs = options.nowMs ?? (() => performance.now());
  const yieldFn = options.yieldFn ?? defaultYield;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const yieldEvery =
    options.yieldEveryBytes === undefined
      ? DEFAULT_YIELD_EVERY_BYTES
      : Math.max(0, Math.trunc(options.yieldEveryBytes));

  try {
    const cols = clampDim(options.cols, DEFAULT_COLS, 20, 400);
    const rows = clampDim(options.rows, DEFAULT_ROWS, 5, 200);
    const minPrintable = options.minPrintableCells ?? DEFAULT_MIN_PRINTABLE;

    const grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
    let r = 0;
    let c = 0;

    const setChar = (ch: string): void => {
      if (r >= 0 && r < rows && c >= 0 && c < cols) {
        grid[r][c] = ch;
      }
      c += 1;
      if (c >= cols) {
        c = 0;
        r = Math.min(rows - 1, r + 1);
      }
    };

    const n = bytes.length;
    let i = 0;
    // Budget is checked on a fixed cadence even when yields are disabled
    // (yieldEveryBytes === 0) so maxMs still terminates long walks.
    const checkEvery = yieldEvery > 0 ? yieldEvery : DEFAULT_YIELD_EVERY_BYTES;
    let nextCheckAt = checkEvery;
    let budgetExceeded = false;

    while (i < n) {
      if (i >= nextCheckAt) {
        // Check budget at cadence points so wall-clock time includes prior work
        // without paying performance.now() on every byte.
        if (nowMs() - startedAt >= maxMs) {
          budgetExceeded = true;
          break;
        }
        if (yieldEvery > 0) {
          await yieldFn();
          // Re-check after yield — another task may have burned the remainder.
          if (nowMs() - startedAt >= maxMs) {
            budgetExceeded = true;
            break;
          }
        }
        nextCheckAt = i + checkEvery;
      }

      const b = bytes[i];

      if (b === 0x1b && i + 1 < n) {
        const nxt = bytes[i + 1];
        if (nxt === 0x5b) {
          // CSI
          let j = i + 2;
          let privateMarker = false;
          if (
            j < n
            && (bytes[j] === 0x3f || bytes[j] === 0x3e || bytes[j] === 0x3c || bytes[j] === 0x3d)
          ) {
            privateMarker = true;
            j += 1;
          }
          const params: number[] = [];
          let cur = 0;
          let has = false;
          while (j < n) {
            const bb = bytes[j];
            if (bb >= 0x30 && bb <= 0x39) {
              cur = cur * 10 + (bb - 0x30);
              has = true;
              j += 1;
              continue;
            }
            if (bb === 0x3b) {
              params.push(has ? cur : 0);
              cur = 0;
              has = false;
              j += 1;
              continue;
            }
            if (bb === 0x3a) {
              // Sub-parameters (e.g. SGR 38:2:r:g:b) — skip digits/colons until
              // separator or final byte.
              j += 1;
              while (
                j < n
                && ((bytes[j] >= 0x30 && bytes[j] <= 0x39) || bytes[j] === 0x3a)
              ) {
                j += 1;
              }
              continue;
            }
            if (bb >= 0x20 && bb <= 0x2f) {
              // Intermediate bytes
              j += 1;
              continue;
            }
            if (bb >= 0x40 && bb <= 0x7e) {
              params.push(has ? cur : 0);
              const cmd = bb;
              if (!privateMarker) {
                applyCsi(grid, rows, cols, params, cmd, () => ({ r, c }), (nr, nc) => {
                  r = nr;
                  c = nc;
                });
              }
              i = j + 1;
              break;
            }
            j += 1;
          }
          if (j >= n) i = n;
          continue;
        }
        if (nxt === 0x5d) {
          // OSC ... BEL or ST
          let j = i + 2;
          while (j < n) {
            if (bytes[j] === 0x07) {
              j += 1;
              break;
            }
            if (bytes[j] === 0x1b && j + 1 < n && bytes[j + 1] === 0x5c) {
              j += 2;
              break;
            }
            j += 1;
          }
          i = j;
          continue;
        }
        // Character set designation ESC ( B etc.
        if (nxt === 0x28 || nxt === 0x29 || nxt === 0x2a || nxt === 0x2b) {
          i += 3;
          continue;
        }
        i += 2;
        continue;
      }

      if (b === 0x0a) {
        r = Math.min(rows - 1, r + 1);
        c = 0;
        i += 1;
        continue;
      }
      if (b === 0x0d) {
        c = 0;
        i += 1;
        continue;
      }
      if (b === 0x08) {
        c = Math.max(0, c - 1);
        i += 1;
        continue;
      }
      if (b === 0x09) {
        c = Math.min(cols - 1, c + (8 - (c % 8)));
        i += 1;
        continue;
      }
      if (b === 0x0e || b === 0x0f || b === 0x07) {
        i += 1;
        continue;
      }

      // Printable ASCII
      if (b < 0x80) {
        if (b >= 0x20) setChar(String.fromCharCode(b));
        i += 1;
        continue;
      }

      // UTF-8 multi-byte
      let len = 0;
      if ((b & 0xe0) === 0xc0) len = 2;
      else if ((b & 0xf0) === 0xe0) len = 3;
      else if ((b & 0xf8) === 0xf0) len = 4;
      else {
        i += 1;
        continue;
      }
      if (i + len <= n) {
        const ch = utf8Char(bytes, i, len);
        if (ch) setChar(ch);
        i += len;
      } else {
        i = n;
      }
    }

    const elapsedMs = nowMs() - startedAt;
    stats.lastElapsedMs = elapsedMs;
    stats.lastBytesProcessed = i;
    stats.lastTotalBytes = n;
    if (budgetExceeded) {
      stats.budgetExceeded += 1;
    } else {
      stats.completed += 1;
    }

    return serializeGrid(grid, rows, cols, minPrintable);
  } finally {
    reconstructInFlight = false;
    stats.inFlight = false;
  }
}

async function defaultYield(): Promise<void> {
  await yieldImmediate();
}

function serializeGrid(
  grid: string[][],
  rows: number,
  cols: number,
  minPrintable: number,
): Uint8Array | null {
  let printable = 0;
  const parts: string[] = ['\x1b[H\x1b[2J'];
  for (let y = 0; y < rows; y++) {
    let end = cols;
    while (end > 0 && grid[y][end - 1] === ' ') end -= 1;
    if (end === 0) continue;
    let line = '';
    for (let x = 0; x < end; x++) {
      const ch = grid[y][x];
      line += ch;
      if (ch !== ' ') printable += 1;
    }
    parts.push(`\x1b[${y + 1};1H${line}`);
  }

  if (printable < minPrintable) return null;
  return new TextEncoder().encode(parts.join(''));
}

function clampDim(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function utf8Char(bytes: Uint8Array, start: number, len: number): string | null {
  try {
    const ch = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, start + len));
    if (!ch || ch === '\uFFFD') return null;
    return ch;
  } catch {
    return null;
  }
}

type Cursor = { r: number; c: number };

function applyCsi(
  grid: string[][],
  rows: number,
  cols: number,
  params: number[],
  cmd: number,
  getCursor: () => Cursor,
  setCursor: (r: number, c: number) => void,
): void {
  const { r, c } = getCursor();
  const p0 = params[0] ?? 0;
  const p1 = params.length > 1 ? params[1] : 0;

  // H / f — CUP
  if (cmd === 0x48 || cmd === 0x66) {
    const nr = Math.max(0, Math.min(rows - 1, (p0 || 1) - 1));
    const nc = Math.max(0, Math.min(cols - 1, (p1 || 1) - 1));
    setCursor(nr, nc);
    return;
  }
  // A — CUU
  if (cmd === 0x41) {
    setCursor(Math.max(0, r - (p0 || 1)), c);
    return;
  }
  // B — CUD
  if (cmd === 0x42) {
    setCursor(Math.min(rows - 1, r + (p0 || 1)), c);
    return;
  }
  // C — CUF
  if (cmd === 0x43) {
    setCursor(r, Math.min(cols - 1, c + (p0 || 1)));
    return;
  }
  // D — CUB
  if (cmd === 0x44) {
    setCursor(r, Math.max(0, c - (p0 || 1)));
    return;
  }
  // G — CHA
  if (cmd === 0x47) {
    setCursor(r, Math.max(0, Math.min(cols - 1, (p0 || 1) - 1)));
    return;
  }
  // d — VPA
  if (cmd === 0x64) {
    setCursor(Math.max(0, Math.min(rows - 1, (p0 || 1) - 1)), c);
    return;
  }
  // J — ED
  if (cmd === 0x4a) {
    const mode = p0;
    if (mode === 2 || mode === 3) {
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) grid[y][x] = ' ';
      }
    } else if (mode === 0) {
      for (let x = c; x < cols; x++) grid[r][x] = ' ';
      for (let y = r + 1; y < rows; y++) {
        for (let x = 0; x < cols; x++) grid[y][x] = ' ';
      }
    } else if (mode === 1) {
      for (let y = 0; y < r; y++) {
        for (let x = 0; x < cols; x++) grid[y][x] = ' ';
      }
      for (let x = 0; x <= c; x++) grid[r][x] = ' ';
    }
    return;
  }
  // K — EL
  if (cmd === 0x4b) {
    const mode = p0;
    if (mode === 0) {
      for (let x = c; x < cols; x++) grid[r][x] = ' ';
    } else if (mode === 1) {
      for (let x = 0; x <= c; x++) grid[r][x] = ' ';
    } else {
      for (let x = 0; x < cols; x++) grid[r][x] = ' ';
    }
    return;
  }
  // X — ECH
  if (cmd === 0x58) {
    const nErase = p0 || 1;
    for (let k = 0; k < nErase && c + k < cols; k++) grid[r][c + k] = ' ';
    return;
  }
  // P — DCH
  if (cmd === 0x50) {
    const nDel = p0 || 1;
    for (let x = c; x + nDel < cols; x++) grid[r][x] = grid[r][x + nDel];
    for (let x = Math.max(c, cols - nDel); x < cols; x++) grid[r][x] = ' ';
    return;
  }
  // @ — ICH
  if (cmd === 0x40) {
    const nIns = p0 || 1;
    for (let x = cols - 1; x >= c + nIns; x--) grid[r][x] = grid[r][x - nIns];
    for (let x = c; x < c + nIns && x < cols; x++) grid[r][x] = ' ';
  }
  // SGR (m) and other finals: no-op for text reconstruction
}
