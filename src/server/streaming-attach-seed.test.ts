import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
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

describe('cut inside a long escape string (issue #3565)', () => {
  const ESC = '\x1b';
  const ST = `${ESC}\\`;

  /** Plain filler made of printable ASCII lines, no ESC bytes. */
  function filler(n: number): string {
    return 'x'.repeat(n - 1) + '\n';
  }

  it('does not start inside an OSC 8 URL whose opener is far before the cut', () => {
    // The issue's reproduction: ~70 KB buffer, a 420-byte URL, cut 200 bytes into it.
    const url = 'https://example.test/' + 'p'.repeat(420 - 'https://example.test/'.length);
    const opener = `${ESC}]8;;${url}${ST}`;
    const head = filler(4000);
    const urlOffset = head.length + `${ESC}]8;;`.length;
    const tail = `link text${ESC}]8;;${ST} after the link\n` + filler(64 * 1024);
    const all = head + opener + tail;
    const buf = enc(all);
    // Choose maxBytes so the rough cut lands 200 bytes into the URL.
    const maxBytes = buf.length - (urlOffset + 200);

    const out = dec(cutStreamingAttachSeed(buf, maxBytes));

    expect(out.startsWith('link text')).toBe(true);
    expect(out).not.toContain('pppp');
  });

  it('skips to just after BEL when the OSC is BEL-terminated', () => {
    const buf = enc(`${ESC}]0;${'t'.repeat(500)}\x07TITLE-DONE`);
    const out = dec(cutStreamingAttachSeed(buf, 'TITLE-DONE'.length + 300));
    expect(out).toBe('TITLE-DONE');
  });

  it('leaves the cut alone when a long string ended well before it', () => {
    const buf = enc(`${ESC}]8;;${'u'.repeat(500)}${ST}` + 'A'.repeat(300) + 'KEEP');
    const out = dec(cutStreamingAttachSeed(buf, 200));
    expect(out).toBe('A'.repeat(196) + 'KEEP');
  });

  it('leaves the cut alone when the string ended with BEL well before it', () => {
    const buf = enc(`${ESC}]0;title\x07` + 'B'.repeat(300));
    expect(dec(cutStreamingAttachSeed(buf, 150))).toBe('B'.repeat(150));
  });

  it('paints the link text, not the URL tail, in xterm.js when the cut lands in an OSC 8 URL', async () => {
    const url = 'https://example.test/' + 'q'.repeat(400);
    const all = enc(`${filler(2000)}${ESC}]8;;${url}${ST}LINK${ESC}]8;;${ST}\r\nend\r\n`);
    // Cut 150 bytes into the URL.
    const cutAt = all.indexOf(0x71 /* q */) + 150;
    const seed = cutStreamingAttachSeed(all, all.length - cutAt);

    const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write(seed, resolve));
      const buffer = terminal.buffer.active;
      const rows = Array.from({ length: 5 }, (_, y) => buffer.getLine(y)?.translateToString(true) ?? '');
      expect(rows.slice(0, 2)).toEqual(['LINK', 'end']);
    } finally {
      terminal.dispose();
    }
  });

  it('treats APC, DCS, PM and SOS as strings ended by ST', () => {
    for (const intro of ['_', 'P', '^', 'X']) {
      const buf = enc(`${ESC}${intro}${'Z'.repeat(400)}${ST}VISIBLE`);
      const out = dec(cutStreamingAttachSeed(buf, 'VISIBLE'.length + 100));
      expect(out, `intro ${intro}`).toBe('VISIBLE');
    }
  });

  it('does not end a DCS string at BEL (only OSC accepts BEL)', () => {
    const buf = enc(`${ESC}P${'d'.repeat(200)}\x07${'d'.repeat(200)}${ST}VISIBLE`);
    // Rough cut lands after the BEL, still inside the DCS body.
    const out = dec(cutStreamingAttachSeed(buf, 'VISIBLE'.length + 100));
    expect(out).toBe('VISIBLE');
  });

  it('resumes at the ESC that cancels an unterminated string', () => {
    const buf = enc(`${ESC}]8;;${'u'.repeat(400)}${ESC}[0mNEXT`);
    const out = dec(cutStreamingAttachSeed(buf, `${ESC}[0mNEXT`.length + 100));
    expect(out).toBe(`${ESC}[0mNEXT`);
  });

  it('resumes after CAN that cancels a string', () => {
    const buf = enc(`${ESC}]8;;${'u'.repeat(400)}\x18NEXT`);
    expect(dec(cutStreamingAttachSeed(buf, 'NEXT'.length + 100))).toBe('NEXT');
  });

  it('drops the seed when the string is still open at the end of the buffer', () => {
    const buf = enc(`${ESC}]8;;${'u'.repeat(400)}`);
    expect(cutStreamingAttachSeed(buf, 100).length).toBe(0);
  });

  it('still ignores a CSI that began more than the CSI lookback before the cut', () => {
    // A CSI whose final byte is far after its ESC is malformed; the 96-byte
    // CSI lookback is unchanged, so the cut is left where it is.
    const buf = enc(`${ESC}[${'1;'.repeat(100)}m` + 'C'.repeat(50));
    expect(advancePastIncompleteEscSequence(buf, 150)).toBe(150);
  });
});
