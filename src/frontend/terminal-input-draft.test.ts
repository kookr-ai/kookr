import { describe, expect, it } from 'vitest';
import {
  looksLikeInteractiveMenu,
  looksLikeVisibleComposerDraft,
  stripTerminalReports,
  terminalContentTail,
  updateTerminalInputDraft,
} from './terminal-input-draft.js';

describe('stripTerminalReports', () => {
  it.each([
    ['primary device attributes', '\u001b[?1;2c'],
    ['secondary device attributes', '\u001b[>0;276;0c'],
    ['device status report', '\u001b[0n'],
    ['private device status report', '\u001b[?6n'],
    ['cursor position report', '\u001b[12;34R'],
    ['SGR mouse press report', '\u001b[<0;12;34M'],
    ['SGR mouse release report', '\u001b[<0;12;34m'],
    ['bracketed-paste open marker', '\u001b[200~'],
    ['bracketed-paste close marker', '\u001b[201~'],
  ])('strips a %s', (_name, report) => {
    expect(stripTerminalReports(`before${report}after`)).toBe('beforeafter');
  });

  it('strips multiple reports while preserving user input', () => {
    expect(stripTerminalReports('\u001b[Ihello\u001b[12;34R\u001b[O')).toBe('hello');
  });

  it('preserves keystroke-driven CSI sequences', () => {
    expect(stripTerminalReports('\u001b[A')).toBe('\u001b[A');
  });
});

describe('updateTerminalInputDraft', () => {
  it('appends ordinary input after stripping terminal reports', () => {
    expect(updateTerminalInputDraft('hello', '\u001b[?1;2c world')).toBe('hello world');
  });

  it('applies backspace and delete one character at a time', () => {
    expect(updateTerminalInputDraft('abc', '\b\u007f')).toBe('a');
  });

  it('clears the draft on ctrl-U', () => {
    expect(updateTerminalInputDraft('stale', '\u0015fresh')).toBe('fresh');
  });

  it.each(['\r', '\n', '\u0003'])('clears the draft on %j', (control) => {
    expect(updateTerminalInputDraft('stale', control)).toBe('');
  });
});

describe('looksLikeInteractiveMenu', () => {
  it.each([
    ['Claude selection row', '❯ 2. Dark mode ✔'],
    ['Codex selection row', '› 1. Yes, continue'],
    ['selection footer', 'Enter to select · Esc to cancel'],
    ['continue footer', 'Press enter to continue'],
  ])('recognizes a %s', (_name, tail) => {
    expect(looksLikeInteractiveMenu(tail)).toBe(true);
  });

  it.each([
    ['idle composer', '❯'],
    ['composer placeholder', '❯ Try "write a test"'],
    ['markdown blockquote', '> 1. First do the thing'],
    ['ordinary output', 'Tests passed'],
  ])('does not mistake a %s for a menu', (_name, tail) => {
    expect(looksLikeInteractiveMenu(tail)).toBe(false);
  });
});

describe('looksLikeVisibleComposerDraft', () => {
  it.each([
    ['Claude composer', '❯ run tests'],
    ['Codex composer', '› explain this failure'],
  ])('recognizes a non-empty %s', (_name, tail) => {
    expect(looksLikeVisibleComposerDraft(tail)).toBe(true);
  });

  it('uses the most recent composer row', () => {
    expect(looksLikeVisibleComposerDraft('❯ old submitted prompt\nWorking complete\n❯ ')).toBe(false);
  });

  it.each([
    ['empty composer', '❯ '],
    ['Try placeholder', '❯ Try "write a test"'],
    ['rule placeholder', '❯ ──────────'],
    ['ordinary output', 'Tests passed'],
  ])('does not treat a %s as a visible draft', (_name, tail) => {
    expect(looksLikeVisibleComposerDraft(tail)).toBe(false);
  });
});

describe('terminalContentTail', () => {
  const tailOf = (rows: string[], screenRows: number) =>
    terminalContentTail(rows.length, screenRows, (index) => rows[index] ?? '');
  const blank = (count: number) => Array.from({ length: count }, () => '');
  const numbered = (count: number) => Array.from({ length: count }, (_, i) => `row ${i}`);

  it('ends at the last row with content, not at the bottom of the screen', () => {
    expect(tailOf(['output', '❯ 1. Yes', '  2. No', ...blank(21)], 24)).toBe('output\n❯ 1. Yes\n  2. No');
  });

  it('treats a whitespace-only row as blank', () => {
    expect(tailOf(['❯ 1. Yes', '   ', ''], 24)).toBe('❯ 1. Yes');
  });

  it('keeps blank rows that sit between rows of content', () => {
    expect(tailOf(['question', '', '❯ 1. Yes', ...blank(5)], 24)).toBe('question\n\n❯ 1. Yes');
  });

  it('returns the last 15 rows when the screen is full', () => {
    expect(tailOf(numbered(40), 24).split('\n')).toEqual(numbered(40).slice(25));
  });

  it('returns the 15 rows above the blank area when content is longer than that', () => {
    expect(tailOf([...numbered(20), ...blank(4)], 24).split('\n')).toEqual(numbered(20).slice(5));
  });

  it('is empty when the live screen is blank, even if scrollback holds an old menu', () => {
    expect(tailOf(['❯ 1. Yes', 'Enter to select', ...blank(24)], 24)).toBe('');
  });

  it('never reaches above the live screen, even when it holds fewer than 15 content rows', () => {
    // Scrollback (rows 0-1) holds an old menu; the live screen was cleared and
    // redrawn with a short idle composer. The old menu must not leak into the
    // tail, or Enter would be forwarded instead of advancing.
    expect(tailOf(['❯ 1. Yes', 'Enter to select', '───', '❯ ', '───', ...blank(21)], 24)).toBe('───\n❯ \n───');
  });

  it('yields at most a screenful for a pane shorter than 15 rows', () => {
    expect(tailOf(numbered(40), 10).split('\n')).toEqual(numbered(40).slice(30));
  });

  it('is empty for an empty buffer', () => {
    expect(tailOf([], 24)).toBe('');
  });

  it.each([0, 5.5, Number.NaN])('still skips blank rows when the screen height is %s', (screenRows) => {
    expect(tailOf(['❯ 1. Yes', ...blank(10)], screenRows)).toBe('❯ 1. Yes');
  });
});
