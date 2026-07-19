import { describe, expect, it } from 'vitest';
import { extractLastSubstantialAbsoluteFrame } from './absolute-position-tui-frame.js';

function syncFrame(opts: { cups: number; maxCol: number; label: string }): Uint8Array {
  const parts: string[] = ['\x1b[?2026h'];
  // Always plant a cell at maxCol so the width heuristic fires.
  parts.push(`\x1b[1;${opts.maxCol}H#`);
  for (let i = 0; i < opts.cups; i++) {
    const row = (i % 40) + 1;
    const col = 2 + (i % Math.max(1, opts.maxCol - 2));
    parts.push(`\x1b[${row};${col}H${opts.label[i % opts.label.length] ?? '·'}`);
  }
  // Pad so the region clears MIN_FRAME_BYTES even with few cups.
  parts.push('x'.repeat(1600));
  parts.push('\x1b[?2026l');
  return new TextEncoder().encode(parts.join(''));
}

describe('extractLastSubstantialAbsoluteFrame', () => {
  it('returns null for empty input', () => {
    expect(extractLastSubstantialAbsoluteFrame(new Uint8Array(0))).toBeNull();
  });

  it('returns null when only tiny spinner sync frames exist', () => {
    const tiny = new TextEncoder().encode('\x1b[?2026h\x1b[1;1H·\x1b[?2026l'.repeat(20));
    expect(extractLastSubstantialAbsoluteFrame(tiny)).toBeNull();
  });

  it('extracts the newest substantial wide sync frame', () => {
    const old = syncFrame({ cups: 50, maxCol: 180, label: 'OLD' });
    const mid = syncFrame({ cups: 60, maxCol: 190, label: 'MID' });
    const latest = syncFrame({ cups: 70, maxCol: 200, label: 'NEW' });
    const ring = new Uint8Array(old.length + mid.length + latest.length);
    ring.set(old, 0);
    ring.set(mid, old.length);
    ring.set(latest, old.length + mid.length);

    const frame = extractLastSubstantialAbsoluteFrame(ring);
    expect(frame).not.toBeNull();
    const text = new TextDecoder().decode(frame!);
    // Leading clear for blank xterm.
    expect(text.startsWith('\x1b[H\x1b[2J')).toBe(true);
    // Newest substantial body, not older ones.
    expect(text).toContain('N');
    expect(text).not.toContain('O'); // from OLD
  });

  it('skips narrow substantial frames (Codex-like)', () => {
    const narrow = syncFrame({ cups: 80, maxCol: 90, label: 'NAR' });
    expect(extractLastSubstantialAbsoluteFrame(narrow)).toBeNull();
  });
});
