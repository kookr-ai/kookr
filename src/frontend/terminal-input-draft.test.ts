import { describe, expect, it } from 'vitest';
import {
  looksLikeInteractiveMenu,
  looksLikeVisibleComposerDraft,
  stripTerminalReports,
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
