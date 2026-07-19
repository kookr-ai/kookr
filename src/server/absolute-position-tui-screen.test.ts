import { describe, expect, it } from 'vitest';
import { reconstructAbsoluteTuiScreen } from './absolute-position-tui-screen.js';

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function decode(bytes: Uint8Array | null): string {
  if (!bytes) return '';
  return new TextDecoder().decode(bytes);
}

describe('reconstructAbsoluteTuiScreen', () => {
  it('returns null for empty input', () => {
    expect(reconstructAbsoluteTuiScreen(new Uint8Array(0))).toBeNull();
  });

  it('returns null when only a spinner/cursor flicker remains', () => {
    const tiny = encode('\x1b[?2026h\x1b[1;1H·\x1b[?2026l'.repeat(30));
    expect(reconstructAbsoluteTuiScreen(tiny, { minPrintableCells: 40 })).toBeNull();
  });

  it('rebuilds a full screen from differential CUP paints', () => {
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

    const frame = reconstructAbsoluteTuiScreen(ring, {
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

  it('honors EL so stale cells are cleared', () => {
    const ring = encode(
      '\x1b[1;1HSTALE_CONTENT_HERE'
      + '\x1b[1;1H\x1b[2K' // erase line
      + '\x1b[1;1Hfresh',
    );
    const frame = reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 10,
      minPrintableCells: 3,
    });
    const text = decode(frame);
    expect(text).toContain('fresh');
    expect(text).not.toContain('STALE');
  });

  it('preserves UTF-8 box-drawing characters', () => {
    const ring = encode('\x1b[5;3H│ Issue │ Fix\r\n\x1b[6;3H├───────┼');
    const frame = reconstructAbsoluteTuiScreen(ring, {
      cols: 40,
      rows: 12,
      minPrintableCells: 5,
    });
    const text = decode(frame);
    expect(text).toContain('│ Issue │ Fix');
    expect(text).toContain('├');
  });

  it('handles ECH erase-characters', () => {
    const ring = encode('\x1b[1;1HABCxyz\x1b[1;4H\x1b[3X'); // erase 3 from col 4
    const frame = reconstructAbsoluteTuiScreen(ring, {
      cols: 20,
      rows: 5,
      minPrintableCells: 2,
    });
    const text = decode(frame);
    expect(text).toContain('ABC');
    expect(text).not.toContain('xyz');
  });
});
