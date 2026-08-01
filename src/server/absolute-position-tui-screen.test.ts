import { afterEach, describe, expect, it } from 'vitest';
import {
  getReconstructAbsoluteTuiScreenStats,
  reconstructAbsoluteTuiScreen,
  resetReconstructAbsoluteTuiScreenForTests,
} from './absolute-position-tui-screen.js';

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decode(bytes: Uint8Array | null): string {
  if (!bytes) return '';
  return new TextDecoder().decode(bytes);
}

afterEach(() => {
  resetReconstructAbsoluteTuiScreenForTests();
});

describe('reconstructAbsoluteTuiScreen', () => {
  it('returns null for empty input', async () => {
    expect(await reconstructAbsoluteTuiScreen(new Uint8Array(0))).toBeNull();
  });

  it('returns null when only a spinner/cursor flicker remains', async () => {
    const tiny = encode('\x1b[?2026h\x1b[1;1H·\x1b[?2026l'.repeat(30));
    expect(await reconstructAbsoluteTuiScreen(tiny, { minPrintableCells: 40 })).toBeNull();
  });

  it('rebuilds a full screen from differential CUP paints', async () => {
    // Frame 1 paints "Hello" at row 2; frame 2 overwrites with "World" and
    // paints "Grok" on row 3 — reconstruction must show the final cells only.
    const ring = encode(
      '\x1b[?2026h'
      + '\x1b[2;1HHello'
      + '\x1b[?2026l'
      + '\x1b[?2026h'
      + '\x1b[2;1HWorld'
      + '\x1b[3;1HGrok terminal'
      + '\x1b[?2026l',
    );

    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 80,
      rows: 24,
      minPrintableCells: 5,
    });
    expect(frame).not.toBeNull();
    const text = decode(frame);
    expect(text.startsWith('\x1b[H\x1b[2J')).toBe(true);
    expect(text).toContain('World');
    expect(text).toContain('Grok terminal');
    expect(text).not.toContain('Hello');
  });

  it('honors EL so stale cells are cleared', async () => {
    const ring = encode(
      '\x1b[1;1HSTALE_CONTENT_HERE'
      + '\x1b[1;1H\x1b[2K' // erase line
      + '\x1b[1;1Hfresh',
    );
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 10,
      minPrintableCells: 3,
    });
    const text = decode(frame);
    expect(text).toContain('fresh');
    expect(text).not.toContain('STALE');
  });

  it('preserves UTF-8 box-drawing characters', async () => {
    const ring = encode('\x1b[5;3H│ Issue │ Fix\r\n\x1b[6;3H├───────┼');
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 12,
      minPrintableCells: 5,
    });
    const text = decode(frame);
    expect(text).toContain('│ Issue │ Fix');
    expect(text).toContain('├');
  });

  it('handles ECH erase-characters', async () => {
    const ring = encode('\x1b[1;1HABCxyz\x1b[1;4H\x1b[3X'); // erase 3 from col 4
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 20,
      rows: 5,
      minPrintableCells: 2,
    });
    const text = decode(frame);
    expect(text).toContain('ABC');
    expect(text).not.toContain('xyz');
  });

  it('yields cooperatively every N bytes on a large ring', async () => {
    // ~1MB of dense CUP paints so the walk crosses several yield boundaries.
    const cell = '\x1b[1;1HABCDEFGHIJKLMNOP'; // 22 bytes
    const target = 1 * 1024 * 1024;
    const repeats = Math.ceil(target / cell.length);
    const ring = encode(cell.repeat(repeats));
    expect(ring.length).toBeGreaterThanOrEqual(target);

    let yields = 0;
    const yieldEveryBytes = 64 * 1024;
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 80,
      rows: 24,
      minPrintableCells: 5,
      maxMs: 60_000,
      yieldEveryBytes,
      yieldFn: async () => {
        yields += 1;
      },
    });

    expect(frame).not.toBeNull();
    // floor(N/chunk)-1 is the guaranteed lower bound: the last chunk may
    // finish mid-sequence without another loop iteration at the boundary.
    const expectedMinYields = Math.max(1, Math.floor(ring.length / yieldEveryBytes) - 1);
    expect(yields).toBeGreaterThanOrEqual(expectedMinYields);
    const s = getReconstructAbsoluteTuiScreenStats();
    expect(s.completed).toBe(1);
    expect(s.budgetExceeded).toBe(0);
    expect(s.lastBytesProcessed).toBe(ring.length);
  });

  it('aborts the walk when maxMs budget is exceeded and returns best-effort', async () => {
    const cell = '\x1b[10;10HZZZZZZZZ';
    const ring = encode(cell.repeat(80_000)); // large enough for many yield points

    let clock = 0;
    let yields = 0;
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 20,
      minPrintableCells: 4,
      maxMs: 5,
      yieldEveryBytes: 1024,
      nowMs: () => clock,
      yieldFn: async () => {
        yields += 1;
        // Each yield burns past the budget on the second check.
        clock += 10;
      },
    });

    // Partial walk already painted "ZZZZZZZZ" — best-effort frame, not null.
    expect(frame).not.toBeNull();
    expect(decode(frame)).toContain('ZZZZZZZZ');
    expect(yields).toBeGreaterThanOrEqual(1);
    const s = getReconstructAbsoluteTuiScreenStats();
    expect(s.budgetExceeded).toBe(1);
    expect(s.lastBytesProcessed).toBeLessThan(ring.length);
    expect(s.lastBytesProcessed).toBeGreaterThan(0);
  });

  it('returns null when budget expires before any useful cells', async () => {
    // Only spaces / CSI private markers — never enough printable cells.
    const ring = encode('\x1b[?2026h\x1b[?2026l'.repeat(50_000));
    let clock = 0;
    const frame = await reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 10,
      minPrintableCells: 40,
      maxMs: 1,
      yieldEveryBytes: 256,
      nowMs: () => clock,
      yieldFn: async () => {
        clock += 5;
      },
    });
    expect(frame).toBeNull();
    expect(getReconstructAbsoluteTuiScreenStats().budgetExceeded).toBe(1);
  });

  it('caps concurrent reconstructs process-wide (busy → null)', async () => {
    const ring = encode('\x1b[1;1Hconcurrent-test-content-here');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstStarted = false;

    const first = reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 10,
      minPrintableCells: 5,
      maxMs: 60_000,
      yieldEveryBytes: 1,
      yieldFn: async () => {
        firstStarted = true;
        await gate;
      },
    });

    // Wait until the first reconstruct has claimed the lock and hit a yield.
    for (let i = 0; i < 50 && !firstStarted; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(firstStarted).toBe(true);

    const second = await reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 10,
      minPrintableCells: 5,
    });
    expect(second).toBeNull();
    expect(getReconstructAbsoluteTuiScreenStats().busySkipped).toBe(1);

    release();
    const firstFrame = await first;
    expect(firstFrame).not.toBeNull();
    expect(decode(firstFrame)).toContain('concurrent-test-content-here');
  });
});
