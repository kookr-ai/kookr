import { describe, expect, test } from 'vitest';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import { cleanTaskText, stripTerminalControl } from './task-text.js';

const ESC = '\u001b';
const BEL = '\u0007';
const TOKENS = {
  github: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  // 18 characters after "sk-": recognised by its prefix only, not by the "32 or more characters" rule.
  shortKey: 'sk-shortkey1234567890',
  // No known prefix: recognised only as a long run.
  longRun: 'QWxhZGRpbjpvcGVuIHNlc2FtZSBhbmQgbW9yZQ12',
} as const;
type TokenKind = keyof typeof TOKENS;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const chars = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => String.fromCharCode(from + i));

/** True when a piece of the token long enough to matter (12 characters) is still readable in `output`. */
function leaks(output: string, token: string): boolean {
  for (let i = 0; i + 12 <= token.length; i++) {
    if (output.includes(token.slice(i, i + 12))) return true;
  }
  return false;
}

/** Every shape of terminal code the grammar allows, as [code, takes no room on screen]. */
function everyCode(): Array<[code: string, zeroWidth: boolean]> {
  const codes: Array<[string, boolean]> = [];
  const cursorMoves = new Set('@ABCDEFGHIZ`adefsu');
  // Control sequences: opener, parameters (including the less common : < = > ?), intermediates, every final byte.
  for (const opener of [`${ESC}[`, '\u009b']) {
    for (const parameters of ['', '35', '1;2', '?25', '>4;2', '4:3', '<', '=1']) {
      for (const intermediates of ['', ' ', '$']) {
        for (const final of chars(0x40, 0x7e)) codes.push([`${opener}${parameters}${intermediates}${final}`, !cursorMoves.has(final)]);
      }
    }
  }
  // Short escapes: intermediates, every final byte. The ones that open a longer code are listed with those.
  const opensLongerCode = new Set(['[', ']', 'P', 'X', '^', '_']);
  for (const intermediates of ['', '(', ' ', '#']) {
    for (const final of chars(0x30, 0x7e)) {
      if (intermediates === '' && opensLongerCode.has(final)) continue;
      codes.push([`${ESC}${intermediates}${final}`, false]);
    }
  }
  // String codes: every opener, with and without content, every terminator.
  for (const opener of [`${ESC}]`, `${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`, '\u009d', '\u0090', '\u0098', '\u009e', '\u009f']) {
    for (const content of ['', '0;window title', '8;;https://example.test/a']) {
      for (const terminator of [BEL, `${ESC}\\`, '\u009c']) codes.push([`${opener}${content}${terminator}`, true]);
    }
  }
  // Lone control characters, 7-bit and 8-bit (tab and line feed are ordinary text; ESC and the openers are above).
  const openers8bit = new Set(['\u009b', '\u009d', '\u0090', '\u0098', '\u009e', '\u009f']);
  for (const control of [...chars(0x00, 0x08), ...chars(0x0b, 0x1a), ...chars(0x1c, 0x1f), '\u007f', ...chars(0x80, 0x9f)]) {
    if (!openers8bit.has(control)) codes.push([control, false]);
  }
  return codes;
}

describe('cleanTaskText: every terminal code, every token kind, every position', () => {
  const codes = everyCode();

  test('the matrix really covers the grammar', () => {
    expect(codes.length).toBeGreaterThan(3000);
  });

  test('a token standing right after a code, or right before one, is hidden and no control character remains', () => {
    const failures: string[] = [];
    for (const [code] of codes) {
      for (const kind of Object.keys(TOKENS) as TokenKind[]) {
        const token = TOKENS[kind];
        for (const [label, raw] of [['after', `Authorization: Bearer${code}${token} and more`], ['before', `KEY=${token}${code}word`]] as const) {
          const cleaned = cleanTaskText(raw);
          if (leaks(cleaned, token) || CONTROL.test(cleaned)) failures.push(`${kind} ${label} ${JSON.stringify(code)} -> ${JSON.stringify(cleaned)}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test('a token with a known prefix is hidden whatever code runs through it, wherever it is split', () => {
    const failures: string[] = [];
    for (const [code] of codes) {
      for (const kind of ['github', 'shortKey'] as const) {
        const token = TOKENS[kind];
        for (const at of [2, 3, 4, 8, 13, 16, token.length - 1]) {
          const cleaned = cleanTaskText(`value ${token.slice(0, at)}${code}${token.slice(at)} end`);
          if (leaks(cleaned, token) || CONTROL.test(cleaned)) failures.push(`${kind} split at ${at} by ${JSON.stringify(code)} -> ${JSON.stringify(cleaned)}`);
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test('a long run with no known prefix is hidden when a code that takes no room on screen runs through it', () => {
    const failures: string[] = [];
    const token = TOKENS.longRun;
    for (const [code, zeroWidth] of codes) {
      if (!zeroWidth) continue;
      for (const at of [3, 12, 20, 33]) {
        const cleaned = cleanTaskText(`value ${token.slice(0, at)}${code}${token.slice(at)} end`);
        if (leaks(cleaned, token) || CONTROL.test(cleaned)) failures.push(`split at ${at} by ${JSON.stringify(code)} -> ${JSON.stringify(cleaned)}`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test.each([
    ['a lone escape', ESC],
    ['a control sequence with no final byte', `${ESC}[`],
    ['a control sequence cut off after its parameters', `${ESC}[35;1`],
    ['a control sequence cut off after an intermediate', `${ESC}[35 `],
    ['the 8-bit control-sequence opener', '\u009b'],
    ['a short escape cut off after an intermediate', `${ESC}(`],
  ])('a token straight after %s is hidden even though its first letter could be read as the end of the code', (_label, prefix) => {
    for (const token of Object.values(TOKENS)) {
      const cleaned = cleanTaskText(`Bearer ${prefix}${token} end`);
      expect(leaks(cleaned, token)).toBe(false);
      expect(CONTROL.test(cleaned)).toBe(false);
    }
  });

  test.each([`${ESC}]`, `${ESC}P`, `${ESC}_`, '\u009d'])('a token inside a string code that is never terminated is dropped with the code', (opener) => {
    for (const token of Object.values(TOKENS)) {
      const cleaned = cleanTaskText(`before ${opener}0;${token}\nthe next line`);
      expect(leaks(cleaned, token)).toBe(false);
      expect(cleaned).toContain('before ');
      expect(cleaned).toContain('the next line');
    }
  });

  test('a string code with no terminator does not swallow the rest of the text, and what follows is still checked', () => {
    const filler = 'title words '.repeat(300); // 3,600 characters, no line break
    const cleaned = cleanTaskText(`${ESC}]0;${filler}${TOKENS.github} tail`);
    expect(leaks(cleaned, TOKENS.github)).toBe(false);
    expect(cleaned.endsWith(' tail')).toBe(true);
  });
});

describe('cleanTaskText: ordinary text is left alone', () => {
  test('text with no control characters gets exactly the ordinary redaction', () => {
    // A small deterministic generator, so a failure can be reproduced.
    let seed = 20261112;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = ['alpha', 'bravo', 'task-speech-summary', 'risk-', 'Bearer', 'KEY=', TOKENS.github, TOKENS.shortKey, TOKENS.longRun, ' ', '\n', '\t', '.', '/', ':', '-', '_', '=', '<<<TASK_CONTEXT>>>', '[31m', 'é', '日本', '0;title'];
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join('');
      expect(cleanTaskText(text)).toBe(redactSpeechSecrets(text));
    }
  });

  test('ordinary words placed with cursor jumps are not mistaken for one long token', () => {
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const raw = words.map((word, i) => `${ESC}[${i * 10 + 1}G${word}`).join('');
    expect(cleanTaskText(raw).trim()).toBe(words.join(' '));
  });

  test('coloured test output keeps its words', () => {
    const raw = `${ESC}[2K${ESC}[1G${ESC}[32m✓${ESC}[0m ${ESC}[1msrc/core/lucy-operator/turn.test.ts${ESC}[0m ${ESC}[90m(17 tests)${ESC}[0m\r\n`;
    expect(cleanTaskText(raw)).toBe(' ✓ src/core/lucy-operator/turn.test.ts (17 tests)\n');
  });

  test('a hyphenated name next to a code is not taken for a key', () => {
    expect(cleanTaskText(`${ESC}[1mtask-${ESC}[0mmanagement-systems-overview`)).toBe('task-management-systems-overview');
    expect(cleanTaskText(`risk-${ESC}[5Gassessment-for-the-quarter`)).toBe('risk- assessment-for-the-quarter');
  });
});

describe('cleanTaskText: what it does not do', () => {
  test('a long run with no known prefix that a cursor move splits is read as two pieces, as on screen', () => {
    const token = TOKENS.longRun;
    expect(cleanTaskText(`${token.slice(0, 20)}${ESC}[40G${token.slice(20)}`)).toBe(`${token.slice(0, 20)} ${token.slice(20)}`);
  });
});

describe('cleanTaskText: stays fast on hostile input', () => {
  // Generous limits: the machine may be busy. The quadratic behaviour this guards against took tens of seconds.
  const within10s = (run: () => void): void => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(10_000);
  };

  test('a megabyte of coloured terminal output', () => {
    const line = `${ESC}[2K${ESC}[1G${ESC}[32m✓${ESC}[0m some test name ${ESC}[90m12ms${ESC}[0m <   \n`;
    within10s(() => {
      const cleaned = cleanTaskText(line.repeat(Math.ceil(1_000_000 / line.length)));
      expect(CONTROL.test(cleaned)).toBe(false);
    });
  });

  test.each([
    ['escape characters only', ESC.repeat(300_000)],
    ['control-sequence openers only', `${ESC}[`.repeat(300_000)],
    ['a control sequence with endless parameters', `${ESC}[${'1;'.repeat(300_000)}`],
    ['string codes that never end', `${ESC}]`.repeat(300_000)],
    ['one string code that never ends', `${ESC}]${'x'.repeat(600_000)}`],
    ['carriage returns only', '\r'.repeat(300_000)],
  ])('%s', (_label, hostile) => {
    within10s(() => {
      expect(CONTROL.test(cleanTaskText(hostile))).toBe(false);
    });
  });
});

describe('stripTerminalControl', () => {
  test('colours, erases and titles vanish; cursor moves and stray control characters become a gap; words, tabs and line breaks stay', () => {
    const raw = `${ESC}]0;window title${BEL}${ESC}[1;32mPASS${ESC}[0m src/a.test.ts\r\n${ESC}[2K${ESC}[1Gline\ttwo${BEL}\nname${ESC}[20Gvalue`;
    expect(stripTerminalControl(raw)).toBe('PASS src/a.test.ts\n line\ttwo \nname value');
  });

  test('text with no codes is returned as it is', () => {
    expect(stripTerminalControl('plain text, with <angle brackets> and é')).toBe('plain text, with <angle brackets> and é');
  });
});
