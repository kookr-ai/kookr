import { describe, expect, test } from 'vitest';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import { cleanTaskText, stripTerminalControl } from './task-text.js';

const ESC = '\u001b';
const GH = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const SK = 'sk-shortkey1234567890'; // 18 characters after "sk-": under the 32-character catch-all

describe('stripTerminalControl', () => {
  test('colours vanish, cursor moves become a gap, words, tabs and line breaks stay', () => {
    const raw = `${ESC}]0;window title\u0007${ESC}[1;32mPASS${ESC}[0m src/a.test.ts\r\n${ESC}[2K${ESC}[1Gline\ttwo\u0007\nname${ESC}[20Gvalue`;
    expect(stripTerminalControl(raw)).toBe('PASS src/a.test.ts\n  line\ttwo \nname value');
  });

  test('a mark character arriving in the text is dropped, not trusted', () => {
    expect(stripTerminalControl('abc')).toBe('abc');
  });
});

describe('cleanTaskText', () => {
  test('plain text with a secret behaves like the ordinary redaction', () => {
    const text = `token ${GH} and ${SK}, then words`;
    expect(cleanTaskText(text)).toBe(redactSpeechSecrets(text));
    expect(cleanTaskText(text)).toBe('token [redacted] and [redacted], then words');
  });

  test.each([
    ['a cursor jump', `Bearer${ESC}[35G${GH}`, 'Bearer [redacted]'],
    ['a colour code', `Bearer${ESC}[32m${GH}${ESC}[0m`, 'Bearer[redacted]'],
    ['a carriage return', `token\r${SK}`, 'token [redacted]'],
    ['an erase-line code', `KEY=${ESC}[K${SK}`, 'KEY= [redacted]'],
    ['a window-title code', `x${ESC}]0;t\u0007${SK}`, 'x[redacted]'],
  ])('a token standing right after %s is hidden', (_label, raw, expected) => {
    expect(cleanTaskText(raw)).toBe(expected);
  });

  test.each([
    ['a GitHub token', `${GH.slice(0, 12)}${ESC}[1m${GH.slice(12)}${ESC}[0m`],
    ['an sk- key', `sk-${ESC}[33mshortkey${ESC}[0m1234567890`],
    ['a long base64 run', `QWxhZGRpbjpvcGVu${ESC}[2mIHNlc2FtZSBhbmQgbW9yZQ${ESC}[0m`],
  ])('%s that a colour code runs through is hidden whole', (_label, raw) => {
    const cleaned = cleanTaskText(`before ${raw} after`);
    expect(cleaned).toBe('before [redacted] after');
  });

  test('ordinary words placed with cursor jumps are not mistaken for one long token', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const raw = words.map((word, i) => `${ESC}[${i * 10 + 1}G${word}`).join('');
    expect(cleanTaskText(raw).trim()).toBe(words.join(' '));
  });

  test('coloured ordinary words are left alone', () => {
    const raw = `${ESC}[32mPASS${ESC}[0m ${ESC}[1msrc/core/lucy-operator/turn.test.ts${ESC}[0m (17 tests)`;
    expect(cleanTaskText(raw)).toBe('PASS src/core/lucy-operator/turn.test.ts (17 tests)');
  });

  test('stays fast on a megabyte of terminal output', () => {
    const line = `${ESC}[2K${ESC}[1G${ESC}[32m✓${ESC}[0m some test name ${ESC}[90m12ms${ESC}[0m <   \n`;
    const big = line.repeat(Math.ceil(1_000_000 / line.length));
    const started = performance.now();
    const cleaned = cleanTaskText(big);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(cleaned).not.toContain(ESC);
  });

  test('several secrets in one coloured line are each hidden, and the text between them is kept', () => {
    const raw = `a ${ESC}[1m${GH}${ESC}[0m b sk-${ESC}[4mshortkey1234567890${ESC}[0m c`;
    expect(cleanTaskText(raw)).toBe('a [redacted] b [redacted] c');
  });
});
