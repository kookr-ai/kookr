import { describe, expect, it } from 'vitest';
import {
  inspectAbsolutePositionTuiRing,
  isAbsolutePositionTuiRing,
} from './absolute-position-tui-ring.js';

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Build a Grok-like absolute-position ring fragment. */
function denseAbsoluteTuiRing(opts: {
  cups: number;
  maxCol: number;
  syncFrames?: number;
  ed2?: number;
}): Uint8Array {
  const parts: string[] = [];
  for (let i = 0; i < (opts.ed2 ?? 0); i++) {
    parts.push('\x1b[2J\x1b[H');
  }
  for (let i = 0; i < (opts.syncFrames ?? 40); i++) {
    parts.push('\x1b[?2026h');
    const row = (i % 40) + 1;
    const col = Math.min(opts.maxCol, 10 + (i % Math.max(1, opts.maxCol - 10)));
    parts.push(`\x1b[${row};${col}H\x1b[38;2;200;200;200m·\x1b[0m`);
    parts.push('\x1b[?2026l');
  }
  // Extra CUPs to hit the threshold without more sync frames if needed.
  for (let i = 0; i < opts.cups; i++) {
    const row = (i % 48) + 1;
    const col = 2 + (i % Math.max(1, opts.maxCol - 2));
    parts.push(`\x1b[${row};${col}Hx`);
  }
  return encode(parts.join(''));
}

describe('isAbsolutePositionTuiRing', () => {
  it('returns false for empty or plain text rings', () => {
    expect(isAbsolutePositionTuiRing(encode(''))).toBe(false);
    expect(isAbsolutePositionTuiRing(encode('hello shell\n$ ls\nfile.txt\n'))).toBe(false);
  });

  it('returns false for a short banner with a few cursor moves', () => {
    const banner = encode('banner-text-ABC\x1b[2;1Hnext line\n');
    expect(isAbsolutePositionTuiRing(banner)).toBe(false);
  });

  it('returns true for Grok-like dense CUP + wide layout rings with no ED2', () => {
    const ring = denseAbsoluteTuiRing({ cups: 250, maxCol: 180, syncFrames: 30, ed2: 0 });
    const stats = inspectAbsolutePositionTuiRing(ring);
    expect(stats.cupCount).toBeGreaterThanOrEqual(200);
    expect(stats.ed2Count).toBe(0);
    expect(stats.maxCol).toBeGreaterThanOrEqual(120);
    expect(isAbsolutePositionTuiRing(ring)).toBe(true);
  });

  it('returns false when the stream frequently full-clears (line-oriented Ink)', () => {
    // Many CUPs but also many ED2 clears → prefer full ring replay path.
    const parts: string[] = [];
    for (let i = 0; i < 250; i++) {
      if (i % 20 === 0) parts.push('\x1b[2J\x1b[H');
      parts.push(`\x1b[${(i % 24) + 1};1Hline ${i}\n`);
    }
    expect(isAbsolutePositionTuiRing(encode(parts.join('')))).toBe(false);
  });

  it('treats wide absolute layouts as TUI even with modest sync counts', () => {
    const ring = denseAbsoluteTuiRing({ cups: 220, maxCol: 190, syncFrames: 5, ed2: 0 });
    expect(isAbsolutePositionTuiRing(ring)).toBe(true);
  });

  it('returns false for dense but narrow rings (Codex-like ~80–110 col layout)', () => {
    const ring = denseAbsoluteTuiRing({ cups: 400, maxCol: 100, syncFrames: 80, ed2: 0 });
    expect(isAbsolutePositionTuiRing(ring)).toBe(false);
  });

  it('still treats Grok as absolute when the newest 256KB is spinner-only but earlier frames painted wide chrome', () => {
    const wide = denseAbsoluteTuiRing({ cups: 250, maxCol: 180, syncFrames: 30, ed2: 0 });
    // Idle Grok only updates a low-column spinner; that tail used to drop
    // maxCol below the wide-layout bar and smash the pane as viewport-ring.
    const spinner = denseAbsoluteTuiRing({ cups: 40_000, maxCol: 5, syncFrames: 10, ed2: 0 });
    expect(spinner.byteLength).toBeGreaterThan(256 * 1024);
    expect(isAbsolutePositionTuiRing(spinner)).toBe(false);

    const combined = new Uint8Array(wide.length + spinner.length);
    combined.set(wide, 0);
    combined.set(spinner, wide.length);
    const stats = inspectAbsolutePositionTuiRing(combined);
    expect(stats.maxCol).toBeGreaterThanOrEqual(120);
    expect(isAbsolutePositionTuiRing(combined)).toBe(true);
  });
});
