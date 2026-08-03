import { describe, expect, it } from 'vitest';
import {
  advancePastIncompleteEscSequence,
  advancePastIncompleteUtf8,
  cutStreamingAttachSeed,
  DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES,
} from './streaming-attach-seed.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

describe('cutStreamingAttachSeed', () => {
  it('returns empty for empty input', () => {
    const empty = new Uint8Array(0);
    expect(cutStreamingAttachSeed(empty, 1024)).toBe(empty);
    expect(cutStreamingAttachSeed(empty, 0).length).toBe(0);
  });

  it('returns empty when maxBytes ≤ 0 and buffer non-empty', () => {
    expect(cutStreamingAttachSeed(enc('hello'), 0).length).toBe(0);
    expect(cutStreamingAttachSeed(enc('hello'), -1).length).toBe(0);
  });

  it('returns the full buffer when length ≤ maxBytes (identity when possible)', () => {
    const buf = enc('short scrollback\n');
    const out = cutStreamingAttachSeed(buf, 1024);
    expect(out).toBe(buf);
    expect(dec(out)).toBe('short scrollback\n');
  });

  it('keeps the last maxBytes of plain ASCII', () => {
    const buf = enc('ABCDEFGHIJ');
    expect(dec(cutStreamingAttachSeed(buf, 4))).toBe('GHIJ');
  });

  it('does not start mid-UTF-8 multi-byte character', () => {
    // "ab" + € (E2 82 AC) + "xy"
    const euro = enc('€'); // 3 bytes
    expect(euro.length).toBe(3);
    const buf = new Uint8Array([
      0x61, 0x62, // ab
      ...euro,
      0x78, 0x79, // xy
    ]);
    // Rough cut at second byte of € → must advance to after € (or drop partial).
    // length=7; maxBytes=4 → rough start=3 which is 0x82 (continuation).
    const out = cutStreamingAttachSeed(buf, 4);
    // After skipping continuations we land on 0x78 'x' → "xy" (2 bytes) — or
    // if we only skip one continuation we might still be mid-char; algorithm
    // skips all continuations → "xy".
    expect(dec(out)).toBe('xy');
    // Must not produce a replacement char from a broken lead.
    expect(out[0]).not.toBe(0x82);
    expect(out[0]).not.toBe(0xac);
  });

  it('does not start mid-CSI sequence', () => {
    // "OLD" + CSI red + "NEWTEXT"
    // ESC [ 3 1 m
    const csi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]);
    const body = enc('NEWTEXT');
    const prefix = enc('OLD');
    const buf = new Uint8Array([...prefix, ...csi, ...body]);
    // Rough cut inside CSI (at '3' of 31m): start = len - 9 → lands on 0x33 mid-CSI.
    // Full: OLD(3)+CSI(5)+NEWTEXT(7)=15; maxBytes=9 → rough start=6 = '3'.
    const out = cutStreamingAttachSeed(buf, 9);
    // Must begin after CSI final 'm', i.e. at 'N' of NEWTEXT.
    expect(dec(out)).toBe('NEWTEXT');
    expect(out[0]).toBe(0x4e /* N */);
  });

  it('skips a CSI that straddles the cut when final is after the cut', () => {
    const csi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d]); // ESC[31m
    const buf = new Uint8Array([...enc('XXXX'), ...csi, ...enc('Y')]);
    // len=4+5+1=10; maxBytes=3 → rough start=7 (inside CSI or at m)
    const out = cutStreamingAttachSeed(buf, 3);
    // Whatever remains must not start with CSI param digits alone.
    if (out.length > 0) {
      expect(out[0] === 0x33 || out[0] === 0x31).toBe(false);
    }
  });

  it('handles ring wrap only as logical order (suffix cut)', () => {
    // captureBytes already unwraps; we only assert suffix semantics.
    const logical = enc('...wrapped-head...|TAIL-VIEWPORT');
    const out = cutStreamingAttachSeed(logical, 13);
    expect(dec(out)).toBe('TAIL-VIEWPORT');
  });

  it('default maxBytes is DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES', () => {
    expect(DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES).toBe(64 * 1024);
    const big = new Uint8Array(DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES + 100);
    big.fill(0x61);
    big[big.length - 1] = 0x5a;
    const out = cutStreamingAttachSeed(big);
    expect(out.length).toBe(DEFAULT_STREAMING_ATTACH_VIEWPORT_BYTES);
    expect(out[out.length - 1]).toBe(0x5a);
  });
});

describe('advancePastIncompleteUtf8', () => {
  it('leaves ASCII starts alone', () => {
    const b = enc('abc');
    expect(advancePastIncompleteUtf8(b, 1)).toBe(1);
  });

  it('skips continuation bytes', () => {
    const b = new Uint8Array([0x61, 0x80, 0x80, 0x62]);
    expect(advancePastIncompleteUtf8(b, 1)).toBe(3);
  });
});

describe('advancePastIncompleteEscSequence', () => {
  it('advances past CSI that completes after start', () => {
    // ESC [ 3 1 m X — start at '3'
    const b = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58]);
    expect(advancePastIncompleteEscSequence(b, 2)).toBe(5);
  });

  it('does not move when CSI completed before start', () => {
    const b = new Uint8Array([0x1b, 0x5b, 0x6d, 0x58, 0x59]);
    expect(advancePastIncompleteEscSequence(b, 3)).toBe(3);
  });
});
