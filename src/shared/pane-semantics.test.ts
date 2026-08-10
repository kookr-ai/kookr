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
});
