import { describe, expect, test } from 'vitest';
import {
  analyzePaneSemantics,
  normalizePaneForActivity,
  stripTerminalControls,
  visibleLinesFromTerminalText,
} from './pane-semantics.js';

describe('stripTerminalControls', () => {
  test('strips CSI color / cursor sequences', () => {
    // Explicit CSI literals: ESC [ 31 m (red) … ESC [ 0 m (reset), ESC [ 2 J (clear).
    const csiRed = '\x1b[31m';
    const csiReset = '\x1b[0m';
    const csiClear = '\x1b[2J';
    const csiHome = '\x1b[H';

    const raw = `${csiClear}${csiHome}${csiRed}hello${csiReset} world`;
    const stripped = stripTerminalControls(raw);

    expect(stripped).toBe('hello world');
    expect(stripped).not.toMatch(/\x1b/);
  });

  test('strips OSC sequences terminated by BEL or ST', () => {
    // OSC window-title: ESC ] 0 ; title BEL  and  ESC ] 0 ; title ESC \
    const oscBel = '\x1b]0;kookr\x07';
    const oscSt = '\x1b]0;kookr\x1b\\';

    expect(stripTerminalControls(`${oscBel}pane`)).toBe('pane');
    expect(stripTerminalControls(`${oscSt}pane`)).toBe('pane');
  });

  test('strips single-character ESC sequences in the C1 [@-_] range', () => {
    // ESC M (reverse index) and ESC D (index) — single-byte C1 forms.
    // The regex only matches ESC followed by a char in [@-_] (0x40–0x5F).
    const raw = '\x1bMvisible\x1bD';
    expect(stripTerminalControls(raw)).toBe('visible');
  });

  test('is idempotent and leaves plain text untouched', () => {
    const plain = 'plain terminal text with $ and ❯';
    expect(stripTerminalControls(plain)).toBe(plain);
    expect(stripTerminalControls(stripTerminalControls(plain))).toBe(plain);

    const withCsi = '\x1b[1mbold\x1b[0m';
    const once = stripTerminalControls(withCsi);
    expect(stripTerminalControls(once)).toBe(once);
    expect(once).not.toMatch(/\x1b/);
  });
});

describe('visibleLinesFromTerminalText', () => {
  test('splits on LF into visible lines', () => {
    expect(visibleLinesFromTerminalText('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  test('treats CRLF as a single line ending', () => {
    expect(visibleLinesFromTerminalText('first\r\nsecond\r\n')).toEqual(['first', 'second', '']);
  });

  test('bare CR redraws the current line (column 0)', () => {
    // Terminal redraw: write status, CR, overwrite with prompt.
    expect(visibleLinesFromTerminalText('Working…\r❯ ')).toEqual(['❯ ']);
  });

  test('collapses duplicate CRs before LF (replay artifacts)', () => {
    expect(visibleLinesFromTerminalText('line\r\r\nnext')).toEqual(['line', 'next']);
  });

  test('backspace and DEL erase the previous character', () => {
    expect(visibleLinesFromTerminalText('ab\bc')).toEqual(['ac']);
    expect(visibleLinesFromTerminalText('ab\u007fc')).toEqual(['ac']);
  });
});

describe('visibleLinesFromTerminalText — cursor addressing (issue #3039)', () => {
  // Cursor-addressed rows must reconstruct into DISTINCT lines, not collapse
  // onto one. These are the escapes stripTerminalControls used to delete.
  test('CUP (ESC[<row>;<col>H) places writes on distinct rows without newlines', () => {
    const frame = '\x1b[1;1Halpha\x1b[2;1Hbravo\x1b[3;1Hcharlie';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  test('CUP column addressing overwrites in place; SGR between cells is ignored', () => {
    const frame = '\x1b[1;1H\x1b[31mhello\x1b[1;1HJ';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['Jello']);
  });

  test('EL (ESC[K) erases from the cursor to end of line', () => {
    const frame = '\x1b[1;1Habcdef\x1b[1;4H\x1b[KXY';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['abcXY']);
  });

  test('VPA (ESC[<row>d) and CHA (ESC[<col>G) address row and column', () => {
    const frame = '\x1b[1;1Hone\x1b[3d\x1b[2Gtwo';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['one', '', ' two']);
  });

  test('DEC private modes and OSC titles are consumed, not printed', () => {
    const frame = '\x1b]0;window title\x07\x1b[?2004hpayload\x1b[?25l';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['payload']);
  });

  test('malformed / private-marker CSI on a row-moving final does not throw', () => {
    // A non-numeric private/leading param (< = > :) must not propagate NaN into
    // the cursor and index lines[NaN]. It is skipped or defaulted, never a throw.
    for (const bad of ['\x1b[>Hx', '\x1b[<Bx', '\x1b[=Gx', '\x1b[:Hx']) {
      expect(() => visibleLinesFromTerminalText(bad)).not.toThrow();
    }
    // Skipped private-marker leaves the text: ESC[>H is ignored, "x" prints.
    expect(visibleLinesFromTerminalText('\x1b[>Hx')).toEqual(['x']);
  });

  test('relative cursor moves (CUU/CUD/CUF/CUB) reposition the cursor', () => {
    // Two rows via newlines, then: up one (CUU), right three (CUF), left one
    // (CUB), write X on row 0; down one (CUD), write Y on row 1.
    const frame = 'row0\nrow1\x1b[1A\x1b[3C\x1b[1DX\x1b[1BY';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['row0  X', 'row1   Y']);
  });

  test('CNL / CPL move to column 0 of a following / preceding row', () => {
    const frame = '\x1b[1;1Halpha\x1b[Ebravo\x1b[Echarlie\x1b[2Fdelta';
    // CNL twice: rows 2 then 3; CPL 2 back to row 1 col 0.
    expect(visibleLinesFromTerminalText(frame)).toEqual(['delta', 'bravo', 'charlie']);
  });

  test('EL mode 1 erases from line start to the cursor; mode 2 erases the whole line', () => {
    expect(visibleLinesFromTerminalText('\x1b[1;1HABCDEF\x1b[1;4H\x1b[1K')).toEqual(['    EF']);
    expect(visibleLinesFromTerminalText('\x1b[1;1Habcdef\x1b[2K\x1b[1;1HXY')).toEqual(['XY']);
  });

  test('ED mode 2 clears the screen; mode 0 clears from the cursor to end of display', () => {
    expect(visibleLinesFromTerminalText('hello\x1b[2Jworld')).toEqual(['world']);
    // Height 2 forces scrolling; ED 0 at the last row drops content below the cursor.
    expect(visibleLinesFromTerminalText('\x1b[1;1Hr1\nr2\nr3\nr4\x1b[2;1H\x1b[0J')).toEqual([
      'r1',
      'r2',
      'r3',
      '',
    ]);
  });

  test('absolute addressing scrolls the visible screen once content overflows the inferred height', () => {
    // Height 3 (from ESC[3;…H). After five rows the screen shows rows 3-5, so a
    // later "go to screen row 1" (ESC[1;1H) lands on buffer line 2, not line 0.
    const frame = '\x1b[3;1Hx\x1b[1;1Ha\nb\nc\nd\ne\x1b[1;1HZ';
    expect(visibleLinesFromTerminalText(frame)).toEqual(['a', 'b', 'Z', 'd', 'e']);
  });

  test('a bogus absolute row is clamped instead of allocating an unbounded grid', () => {
    const res = visibleLinesFromTerminalText('\x1b[1;1Hfirst\x1b[99999;1HX');
    expect(res.length).toBeLessThanOrEqual(1000);
    expect(res[0]).toBe('first');
    expect(res[res.length - 1]).toBe('X');
  });

  // Safety (independent-review finding): a large RELATIVE row move (CUD/CNL) in
  // the raw PTY ring must not amplify a few bytes into a giant grid.
  test('a huge CUD / CNL count is bounded, not allocated', () => {
    // Non-scrolling: a downward move grows by at most one row per move.
    expect(visibleLinesFromTerminalText('start\x1b[5000000BX').length).toBeLessThanOrEqual(1000);
    expect(visibleLinesFromTerminalText('start\x1b[5000000EX').length).toBeLessThanOrEqual(1000);
    // Scrolling (height inferred from ESC[3;…H): clamped to the screen bottom.
    expect(visibleLinesFromTerminalText('\x1b[3;1Ha\x1b[5000000By').length).toBeLessThanOrEqual(1000);
  });

  // Safety: a large COLUMN move (CUF/CHA/CUP col) must not force a giant space pad.
  test('a huge column move is clamped, not padded into a giant string', () => {
    for (const frame of ['\x1b[1;1Ha\x1b[5000000CX', '\x1b[1;1Ha\x1b[5000000GX', '\x1b[1;5000000HX']) {
      const res = visibleLinesFromTerminalText(frame);
      expect(res.every((l) => l.length <= 1001)).toBe(true);
    }
  });

  test('a truncated CSI at end of stream leaves no stray bracket', () => {
    expect(visibleLinesFromTerminalText('done\x1b[')).toEqual(['done']);
    expect(visibleLinesFromTerminalText('done\x1b[2')).toEqual(['done2']);
  });

  test('separates a Codex-style composer frame (prompt / blank / footer)', () => {
    // Prompt at row 2, footer at row 4 — no newlines between them, the exact
    // shape that collapsed onto one line before #3039.
    const frame =
      '\x1b[1;1H─ Worked for 27m 45s ─'
      + '\x1b[2;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything'
      + '\x1b[4;1H  gpt-5.6 xhigh · ~/proj · Main [default]';
    expect(visibleLinesFromTerminalText(frame)).toEqual([
      '─ Worked for 27m 45s ─',
      '› Ask Codex to do anything',
      '',
      '  gpt-5.6 xhigh · ~/proj · Main [default]',
    ]);
  });
});

describe('analyzePaneSemantics', () => {
  test('returns unknown for empty / whitespace-only panes', () => {
    expect(analyzePaneSemantics('')).toEqual({ state: 'unknown', confidence: 'low' });
    expect(analyzePaneSemantics('   \n\t  ')).toEqual({ state: 'unknown', confidence: 'low' });
  });

  test('classifies Claude input prompt (❯ on its own line)', () => {
    const result = analyzePaneSemantics('Agent finished.\n❯\n');
    expect(result.state).toBe('input_prompt');
    expect(result.confidence).toBe('high');
    expect(result.matchedText).toBe('❯');
  });

  test('classifies Codex idle composer as input_prompt when footer present', () => {
    const pane = ['› ', '', '  gpt-5.4 xhigh fast · 100% left · /tmp/project'].join('\n');
    const result = analyzePaneSemantics(pane);
    expect(result.state).toBe('input_prompt');
    expect(result.confidence).toBe('high');
  });

  test('classifies Claude Allow/Deny permission dialog as high confidence', () => {
    const result = analyzePaneSemantics('● Bash(ls)\n  Allow  Deny  allow-always');
    expect(result.state).toBe('permission_dialog');
    expect(result.confidence).toBe('high');
  });

  test('classifies Grok row-menu permission (allow + reject rows) as high confidence', () => {
    const pane = ['Grok wants to run a command', '❯ Allow once', '  Reject'].join('\n');
    const result = analyzePaneSemantics(pane);
    expect(result.state).toBe('permission_dialog');
    expect(result.confidence).toBe('high');
    expect(result.matchedText).toBe('❯ Allow once');
  });

  test('classifies shell prompt when no agent status bar is present', () => {
    const result = analyzePaneSemantics('Claude Code exited.\njean@host:~/git/kookr$');
    expect(result.state).toBe('shell_prompt');
    expect(result.confidence).toBe('high');
  });

  test('classifies streaming / thinking indicators', () => {
    const result = analyzePaneSemantics('context\n✢ Thinking…');
    expect(result.state).toBe('streaming');
    expect(result.confidence).toBe('low');
  });

  test('strips control sequences before classifying (CSI does not block prompt match)', () => {
    // CSI-wrapped ❯ prompt must still resolve to input_prompt.
    const pane = `\x1b[2J\x1b[HAgent done.\n\x1b[1m❯\x1b[0m\n`;
    const result = analyzePaneSemantics(pane);
    expect(result.state).toBe('input_prompt');
    expect(result.confidence).toBe('high');
  });

  test('returns unknown for ordinary non-prompt tool output', () => {
    const result = analyzePaneSemantics('Some random tool output\nLine 2 of many');
    expect(result.state).toBe('unknown');
    expect(result.confidence).toBe('low');
  });

  // Issue #3039: a cursor-addressed idle Codex composer (prompt + placeholder on
  // one row, footer on another, drawn with absolute CUP escapes and no
  // newlines) classifies as input_prompt through the empty-composer + footer
  // detector alone — no collapsed-line placeholder+footer workaround.
  test('classifies a raw cursor-addressed idle Codex composer as input_prompt', () => {
    const frame =
      '\x1b[1;1H─ Worked for 12m 03s ─'
      + '\x1b[2;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything'
      + '\x1b[4;1H  gpt-5.6-luna xhigh · ~/git/proj · Main [default]';
    const result = analyzePaneSemantics(frame);
    expect(result.state).toBe('input_prompt');
    expect(result.confidence).toBe('high');
  });

  // The same cursor-addressed frame while the model is still working: the
  // collapse can no longer hide the `esc to interrupt` status row, and it must
  // keep the composer from reading as idle.
  test('does not classify a cursor-addressed frame with a live status row as idle', () => {
    const frame =
      '\x1b[1;1H• Working (2m 50s • esc to interrupt)'
      + '\x1b[2;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything'
      + '\x1b[4;1H  gpt-5.6-luna xhigh · ~/git/proj · Main [default]';
    // The active `esc to interrupt` status row gates out the idle-composer
    // branch, so a mid-turn frame is `unknown` (watchdog: not needs_input),
    // never input_prompt.
    expect(analyzePaneSemantics(frame).state).toBe('unknown');
  });
});

describe('normalizePaneForActivity', () => {
  test('strips volatile status/footer lines and control sequences', () => {
    const pane = [
      '• Working (16s • esc to interrupt)',
      '',
      '\x1b[32mFound the root cause\x1b[0m',
      '',
      '  gpt-5.4 high · 64% left · ~/git/kookr',
    ].join('\n');

    expect(normalizePaneForActivity(pane)).toBe('Found the root cause');
  });

  test('returns empty string for blank panes', () => {
    expect(normalizePaneForActivity('')).toBe('');
    expect(normalizePaneForActivity('\x1b[2J\x1b[H')).toBe('');
  });

  // Issue #3039 acceptance: pane-change activity detection must stay unchanged
  // for providers that do not cursor-address multi-row frames. A pane that uses
  // only SGR colour and newlines (Claude / Grok output) reduces to the same
  // newline reconstruction as before — the SGR-stripped text, byte-for-byte.
  describe('per-provider activity-hash regression', () => {
    test('Grok row-menu pane normalizes to its SGR-stripped rows', () => {
      // Real Grok pane shape: bracketed-paste DECSET + SGR, one row per line.
      const grokPane = '\x1b[?2004h\x1b[1m❯ Allow once\x1b[0m\n  \x1b[31mReject\x1b[0m';
      expect(normalizePaneForActivity(grokPane)).toBe('❯ Allow once\n  Reject');
    });

    test('Claude SGR + newline output normalizes to the plain rows', () => {
      const claudePane = '\x1b[2J\x1b[H\x1b[32mFound it\x1b[0m\nnext line';
      expect(normalizePaneForActivity(claudePane)).toBe('Found it\nnext line');
    });

    test('an elapsed-time-only status redraw is not seen as activity', () => {
      const at16s = ['• Working (16s • esc to interrupt)', '', 'Step 1 done'].join('\n');
      const at22s = ['• Working (22s • esc to interrupt)', '', 'Step 1 done'].join('\n');
      expect(normalizePaneForActivity(at16s)).toBe(normalizePaneForActivity(at22s));
    });

    test('a real content change is still seen as activity', () => {
      const before = ['• Working (16s • esc to interrupt)', '', 'Step 1 done'].join('\n');
      const after = ['• Working (16s • esc to interrupt)', '', 'Step 2 done'].join('\n');
      expect(normalizePaneForActivity(before)).not.toBe(normalizePaneForActivity(after));
    });

    // Cursor-addressed provider output (Ink-style repaint with CUP + EL) flows
    // through the same reconstruction on every tick, so change detection stays
    // self-consistent: a status-only redraw is not activity, a content change is.
    test('raw cursor-addressed redraws: status-only is quiet, content change is activity', () => {
      const render = (content: string, elapsed: string) =>
        `\x1b[1;1H\x1b[K${content}\x1b[2;1H\x1b[K• Working (${elapsed} • esc to interrupt)`;
      const a = render('Analyzing files', '16s');
      const bSameContent = render('Analyzing files', '23s');
      const cNewContent = render('Writing output', '16s');
      expect(normalizePaneForActivity(a)).toBe(normalizePaneForActivity(bSameContent));
      expect(normalizePaneForActivity(a)).not.toBe(normalizePaneForActivity(cNewContent));
      expect(normalizePaneForActivity(a)).toBe('Analyzing files');
    });
  });
});
