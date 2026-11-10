import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { cutStreamingAttachSeed, DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES } from './streaming-attach-seed.js';
import { findSnapshotBoundary, snapshotStreamingAttachSeed } from './streaming-attach-snapshot.js';
import { diffRenderedAgentStream, SPINNER_ONLY_FRAMES } from './__fixtures__/diff-rendered-agent-stream.js';

const COLS = 80;
const ROWS = 24;
const encode = (text: string) => new TextEncoder().encode(text);
const write = (terminal: Terminal, bytes: Uint8Array) => new Promise<void>((resolve) => terminal.write(bytes, resolve));

/** What a browser pane shows: the visible rows and where the cursor sits. */
function screen(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    rows: Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''),
    cursor: [buffer.cursorX, buffer.cursorY],
  };
}

/** Paint `seed`, then `live`, into a fresh terminal the way the browser does after a reset. */
async function paint(seed: Uint8Array, live: Uint8Array = new Uint8Array(0)) {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
  try {
    await write(terminal, seed);
    if (live.length > 0) await write(terminal, live);
    return screen(terminal);
  } finally { terminal.dispose(); }
}

async function snapshot(bytes: Uint8Array, extra: Partial<Parameters<typeof snapshotStreamingAttachSeed>[1]> = {}) {
  return snapshotStreamingAttachSeed(bytes, { cols: COLS, rows: ROWS, ...extra });
}

describe('snapshotStreamingAttachSeed (issue #3564)', () => {
  const stream = diffRenderedAgentStream(SPINNER_ONLY_FRAMES);

  it('uses a stream whose last 64 KiB holds only spinner frames', () => {
    // Guards the fixture: if it stopped exceeding the viewport budget, the
    // comparisons below would silently stop exercising the bug.
    expect(stream.spinnerBytes).toBeGreaterThan(DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES);
  });

  it('paints the true screen where the 64 KiB byte tail paints an almost empty one', async () => {
    const truth = await paint(stream.bytes);
    expect(truth.rows.filter((row) => row.trim()).length).toBeGreaterThan(15);

    // The bug: a byte suffix of a differential stream is edits with nothing to edit.
    const tail = await paint(cutStreamingAttachSeed(stream.bytes));
    expect(tail.rows.filter((row) => row.trim()).length).toBeLessThan(4);
    expect(tail).not.toEqual(truth);

    const result = await snapshot(stream.bytes);
    if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
    expect(await paint(result.bytes)).toEqual(truth);
    expect(result.bytes.byteLength).toBeLessThan(DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES);
  });

  it('keeps the screen exact while live frames continue after the seed', async () => {
    const live = diffRenderedAgentStream(SPINNER_ONLY_FRAMES + 40).bytes.subarray(stream.bytes.byteLength);
    expect(live.byteLength).toBeGreaterThan(0);
    const truth = await paint(stream.bytes, live);

    const result = await snapshot(stream.bytes);
    if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
    expect(await paint(result.bytes, live)).toEqual(truth);
  });

  it('stays exact when the capture point falls inside an escape sequence', async () => {
    // A capture can land between any two PTY reads. Cut inside the color
    // sequence of the next frame: `ESC[38;2;215;119;` | `87m…`.
    const next = diffRenderedAgentStream(SPINNER_ONLY_FRAMES + 3).bytes;
    const marker = encode('\x1b[38;2;215;119;87m');
    let at = -1;
    for (let i = stream.bytes.byteLength; i + marker.length <= next.byteLength && at < 0; i++) {
      if (marker.every((byte, offset) => next[i + offset] === byte)) at = i;
    }
    expect(at).toBeGreaterThan(-1);
    const capture = at + marker.length - 3;
    const captured = next.subarray(0, capture);
    const live = next.subarray(capture);
    const truth = await paint(next);

    const result = await snapshot(captured);
    if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
    // The unfinished sequence travels as raw bytes, not through the serializer.
    expect(result.rawTailBytes).toBeGreaterThan(0);
    expect(result.emulatedBytes + result.rawTailBytes).toBe(captured.byteLength);
    expect(await paint(result.bytes, live)).toEqual(truth);
  });

  it('carries a split multi-byte character across the seed boundary', async () => {
    // Plain text with no escape character near the end: only UTF-8 can be cut.
    const text = encode(`${'plain output line\r\n'.repeat(400)}café ✓ done`);
    const capture = text.byteLength - 6; // inside the 3-byte check mark
    const result = await snapshot(text.subarray(0, capture));
    if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
    expect(result.rawTailBytes).toBeGreaterThan(0);
    expect(await paint(result.bytes, text.subarray(capture))).toEqual(await paint(text));
  });

  it('trims scrollback to the byte budget but always sends the visible screen', async () => {
    const text = encode('numbered output line that fills some columns\r\n'.repeat(400));
    const truth = await paint(text);

    const roomy = await snapshot(text);
    if (roomy.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${roomy.reason}`);
    expect(roomy.bytes.byteLength).toBeGreaterThan(4000);

    const tight = await snapshot(text, { maxBytes: 4000 });
    if (tight.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${tight.reason}`);
    expect(tight.bytes.byteLength).toBeLessThanOrEqual(4000);
    // Less scrollback than the roomy seed, but still some, and the same screen.
    expect(tight.bytes.byteLength).toBeGreaterThan(1500);
    expect(await paint(tight.bytes)).toEqual(truth);

    // A budget smaller than the screen itself cannot blank the pane.
    const tiny = await snapshot(text, { maxBytes: 10 });
    if (tiny.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${tiny.reason}`);
    expect(tiny.bytes.byteLength).toBeGreaterThan(10);
    expect(await paint(tiny.bytes)).toEqual(truth);
  });

  it('restores terminal modes the byte tail no longer contains', async () => {
    // Bracketed paste is switched on once at startup, megabytes before the tail.
    const terminal = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
    try {
      const result = await snapshot(stream.bytes);
      if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
      await write(terminal, result.bytes);
      expect(terminal.modes.bracketedPasteMode).toBe(true);
    } finally { terminal.dispose(); }
  });

  it('keeps cell colors and text attributes, which the row text cannot show', async () => {
    // Rows of plain text compare equal whether or not the colors survived, so
    // compare the style of every cell on a screen that uses each color mode.
    const styled = encode(
      '\x1b[1;38;2;10;20;30;48;5;99mtruecolor on palette\x1b[0m plain\r\n'
      + '\x1b[2;3;4;7;31mdim italic underline inverse red\x1b[0m\r\n'
      + `${'filler line\r\n'.repeat(10)}`
      + '\x1b[1;32mgreen bold\x1b[0m tail',
    );
    const cellStyles = async (seed: Uint8Array) => {
      const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true });
      try {
        await write(terminal, seed);
        const buffer = terminal.buffer.active;
        return Array.from({ length: terminal.rows }, (_, y) => {
          const line = buffer.getLine(buffer.baseY + y);
          return Array.from({ length: terminal.cols }, (_, x) => {
            const cell = line?.getCell(x);
            return cell && [
              cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
              cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isInverse(),
            ].join(',');
          });
        });
      } finally { terminal.dispose(); }
    };
    const truth = await cellStyles(styled);
    // Default, truecolor+bold on palette, dim/italic/underline/inverse red, bold green.
    expect(new Set(truth.flat()).size).toBeGreaterThanOrEqual(4);

    const result = await snapshot(styled);
    if (result.kind !== 'snapshot') throw new Error(`snapshot unavailable: ${result.reason}`);
    expect(await cellStyles(result.bytes)).toEqual(truth);
  });

  it('refuses a screen that is itself implausibly large instead of sending it', async () => {
    // Every cell a different truecolor: nothing for the serializer to merge, so
    // even with all scrollback dropped the visible screen alone is over the ceiling.
    const cols = 300;
    const rows = 200;
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      let line = '';
      for (let x = 0; x < cols; x++) line += `\x1b[38;2;${x % 256};${y % 256};${(x * 7 + y) % 256}m#`;
      lines.push(line);
    }
    const result = await snapshot(encode(lines.join('\r\n')), { cols, rows, maxBytes: 1000, maxMs: 10_000 });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'oversized' });
  });

  it('reports why no snapshot was produced instead of throwing', async () => {
    expect(await snapshot(new Uint8Array(0))).toMatchObject({ kind: 'unavailable', reason: 'empty' });
    expect(await snapshot(stream.bytes, { cols: 0 })).toMatchObject({ kind: 'unavailable', reason: 'invalid-geometry' });
    expect(await snapshot(stream.bytes, { rows: Number.NaN })).toMatchObject({ kind: 'unavailable', reason: 'invalid-geometry' });
  });

  it('gives up once the replay runs past its time budget', async () => {
    // The clock jumps 10 ms per reading, so a 5 ms budget is spent after the first slice.
    let clock = 0;
    const result = await snapshot(stream.bytes, { maxMs: 5, nowMs: () => (clock += 10) });
    expect(result).toMatchObject({ kind: 'unavailable', reason: 'budget-exceeded' });
    // The slot is released on that path: the next attach still gets a snapshot.
    expect((await snapshot(stream.bytes)).kind).toBe('snapshot');
  });

  it('runs one replay at a time and tells a waiting caller it was busy', async () => {
    // Long enough to span several emulator slices, so the first replay is
    // still holding the slot when the second caller's wait runs out.
    const long = diffRenderedAgentStream(SPINNER_ONLY_FRAMES * 6).bytes;
    expect(long.byteLength).toBeGreaterThan(3 * 128 * 1024);
    const first = snapshot(long);
    const second = snapshot(stream.bytes, { maxQueueWaitMs: 0 });
    expect(await second).toMatchObject({ kind: 'unavailable', reason: 'busy' });
    expect((await first).kind).toBe('snapshot');
    // A caller willing to wait is served once the slot frees up.
    const [third, fourth] = await Promise.all([snapshot(stream.bytes), snapshot(stream.bytes)]);
    expect(third.kind).toBe('snapshot');
    expect(fourth.kind).toBe('snapshot');
  });
});

describe('findSnapshotBoundary', () => {
  it('stops before the last escape character', () => {
    const bytes = encode('text\x1b[31mred\x1b[3');
    expect(findSnapshotBoundary(bytes)).toBe(bytes.byteLength - 3);
  });

  it('keeps the whole buffer when it ends in complete plain text', () => {
    const bytes = encode('x'.repeat(5000));
    expect(findSnapshotBoundary(bytes)).toBe(bytes.byteLength);
  });

  it('does not search the whole ring for an escape character that is far from the end', () => {
    // Only the last few KiB can hold an unfinished sequence. An escape character
    // at the very start of a long plain-text ring must not drag the boundary
    // there and push the whole ring through as raw bytes.
    const bytes = encode(`\x1b[1m${'x'.repeat(10_000)}`);
    expect(findSnapshotBoundary(bytes)).toBe(bytes.byteLength);
  });

  it.each([
    ['2-byte', 'é', 1],
    ['3-byte', '✓', 1],
    ['3-byte', '✓', 2],
    ['4-byte', '\u{1f600}', 1],
    ['4-byte', '\u{1f600}', 3],
  ])('backs off an unfinished %s character (%s, %i byte(s) present)', (_name, char, present) => {
    const prefix = 'y'.repeat(5000);
    const bytes = encode(prefix + char).subarray(0, 5000 + present);
    expect(findSnapshotBoundary(bytes)).toBe(5000);
  });

  it('does not back off a complete multi-byte character', () => {
    const bytes = encode(`${'y'.repeat(5000)}\u{1f600}`);
    expect(findSnapshotBoundary(bytes)).toBe(bytes.byteLength);
  });
});
