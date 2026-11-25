import { describe, expect, it } from 'vitest';
import {
  OPERATOR_DRAFT_MAX_CHARS,
  isMeaningfulOperatorDraft,
  reduceOperatorDraft,
} from './operator-draft.js';

/** Feed chunks in order, as the terminal sends them. */
function typed(...chunks: Array<string | { paste: string }>): string {
  let draft = '';
  for (const chunk of chunks) {
    draft = typeof chunk === 'string'
      ? reduceOperatorDraft(draft, { text: chunk })
      : reduceOperatorDraft(draft, { text: chunk.paste, paste: true });
  }
  return draft;
}

describe('reduceOperatorDraft', () => {
  it('accumulates typed text, one key or one chunk at a time', () => {
    expect(typed('B', 'o', 'n', 'j', 'o', 'u', 'r')).toBe('Bonjour');
    expect(typed('Peux-tu ', 'vérifier ça ?')).toBe('Peux-tu vérifier ça ?');
  });

  it('empties on Enter (submit), Ctrl-C and Ctrl-U', () => {
    expect(typed('envoyé', '\r')).toBe('');
    expect(typed('envoyé\n')).toBe('');
    expect(typed('abandon', '\u0003')).toBe('');
    expect(typed('effacé', '\u0015')).toBe('');
    expect(typed('avant\rapres')).toBe('apres');
  });

  it('applies backspace and DEL, removing whole characters', () => {
    expect(typed('abc', '\u007f')).toBe('ab');
    expect(typed('ab', '\b', '\b', '\b')).toBe('');
    expect(typed('pizza 🍕', '\u007f')).toBe('pizza ');
  });

  it('turns the newline chords (backslash+Enter, ESC+Enter) into newlines, not submits', () => {
    expect(typed('ligne 1\\', '\r', 'ligne 2')).toBe('ligne 1\nligne 2');
    expect(typed('ligne 1', '\u001b\r', 'ligne 2')).toBe('ligne 1\nligne 2');
  });

  it('drops escape sequences: arrows, focus, device-attribute and cursor reports', () => {
    expect(typed('ab', '\u001b[D', '\u001b[A', 'c')).toBe('abc');
    expect(typed('\u001b[I', '\u001b[?1;2c', '\u001b[12;40R', '\u001b[O')).toBe('');
    expect(typed('\u001bOP', 'x')).toBe('x');
    expect(typed('\u001b]11;rgb:0000/0000/0000\u0007', 'y')).toBe('y');
  });

  it('keeps a bracketed paste literal, newlines included, and never submits on it', () => {
    expect(typed('intro: ', '\u001b[200~ligne 1\rligne 2\u001b[201~', ' fin')).toBe('intro: ligne 1\nligne 2 fin');
    expect(typed({ paste: 'a\nb\r\nc' })).toBe('a\nb\nc');
    expect(typed('x', { paste: 'y' }, '\r')).toBe('');
  });

  it('bounds the tracked draft size', () => {
    const draft = typed('x'.repeat(OPERATOR_DRAFT_MAX_CHARS + 10));
    expect(draft.length).toBe(OPERATOR_DRAFT_MAX_CHARS);
  });
});

describe('isMeaningfulOperatorDraft', () => {
  it('ignores whitespace-only drafts', () => {
    expect(isMeaningfulOperatorDraft('  \n ')).toBe(false);
    expect(isMeaningfulOperatorDraft(undefined)).toBe(false);
    expect(isMeaningfulOperatorDraft(' ab ')).toBe(true);
  });

  it('ignores the single key a menu or permission answer leaves behind', () => {
    expect(isMeaningfulOperatorDraft('1')).toBe(false);
    expect(isMeaningfulOperatorDraft(' y ')).toBe(false);
    expect(isMeaningfulOperatorDraft('🍕')).toBe(false);
    expect(isMeaningfulOperatorDraft('ok')).toBe(true);
  });
});
