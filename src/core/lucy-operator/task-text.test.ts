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

/**
 * Every shape of terminal code the grammar allows, as [code, joins its neighbours].
 * "Joins" is written out here from the documented rule, not read from the implementation:
 * only cursor moves separate, and a code with a private prefix (< = > ?) is never one.
 */
function everyCode(): Array<[code: string, joins: boolean]> {
  const codes: Array<[string, boolean]> = [];
  // Up, down, forward, back, next line, previous line, column, position, tab stops, row, restore.
  const cursorMoves = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'Z', '`', 'a', 'd', 'e', 'f', 'u']);
  // Control sequences: opener, parameters (including the less common : < = > ?), intermediates, every final byte.
  for (const opener of [`${ESC}[`, '\u009b']) {
    for (const parameters of ['', '35', '1;2', '?25', '>4;2', '4:3', '<', '=1']) {
      for (const intermediates of ['', ' ', '$']) {
        const privatePrefix = /^[<=>?]/.test(parameters);
        for (const final of chars(0x40, 0x7e)) codes.push([`${opener}${parameters}${intermediates}${final}`, privatePrefix || !cursorMoves.has(final)]);
      }
    }
  }
  // Short escapes: intermediates, every final byte. The ones that open a longer code are listed with those.
  const opensLongerCode = new Set(['[', ']', 'P', 'X', '^', '_']);
  for (const intermediates of ['', '(', ' ', '#']) {
    for (const final of chars(0x30, 0x7e)) {
      if (intermediates === '' && opensLongerCode.has(final)) continue;
      // Index, next line, reverse index, restore cursor and full reset move the cursor; nothing else here does.
      codes.push([`${ESC}${intermediates}${final}`, !(intermediates === '' && ['D', 'E', 'M', '8', 'c'].includes(final))]);
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
    // Backspace, vertical tab, form feed, carriage return, and the 8-bit index, next line and reverse index move the cursor.
    if (!openers8bit.has(control)) codes.push([control, !['\u0008', '\u000b', '\u000c', '\r', '\u0084', '\u0085', '\u008d'].includes(control)]);
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

  test('a long run with no known prefix is hidden when any code that is not a cursor move runs through it', () => {
    const failures: string[] = [];
    const token = TOKENS.longRun;
    for (const [code, joins] of codes) {
      if (!joins) continue;
      for (const at of [3, 12, 20, 33]) {
        const cleaned = cleanTaskText(`value ${token.slice(0, at)}${code}${token.slice(at)} end`);
        if (leaks(cleaned, token) || CONTROL.test(cleaned)) failures.push(`split at ${at} by ${JSON.stringify(code)} -> ${JSON.stringify(cleaned)}`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test('a cursor move keeps ordinary words apart', () => {
    const failures: string[] = [];
    for (const [code, joins] of codes) {
      if (joins) continue;
      const cleaned = cleanTaskText(`alpha${code}bravo`);
      if (!/^alpha\s+bravo$/.test(cleaned)) failures.push(`${JSON.stringify(code)} -> ${JSON.stringify(cleaned)}`);
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

/**
 * What real programs emit, captured with `tput <capability>` for the terminal types in
 * brackets. The expected effect comes from what the capability is documented to do, so
 * these check the cleaner against terminals rather than against its own table.
 */
const DOES_NOT_MOVE_THE_CURSOR: Array<[capability: string, bytes: string]> = [
  ['sgr0 (xterm-256color)', `${ESC}(B${ESC}[m`],
  ['sgr0 (tmux-256color)', `${ESC}[m\u000f`],
  ['setaf 1', `${ESC}[31m`],
  ['setab 4', `${ESC}[44m`],
  ['bold', `${ESC}[1m`],
  ['dim', `${ESC}[2m`],
  ['smul', `${ESC}[4m`],
  ['rmul', `${ESC}[24m`],
  ['rev', `${ESC}[7m`],
  ['el', `${ESC}[K`],
  ['el1', `${ESC}[1K`],
  ['ed', `${ESC}[J`],
  ['civis', `${ESC}[?25l`],
  ['civis (linux)', `${ESC}[?25l${ESC}[?1c`],
  ['cnorm (xterm-256color)', `${ESC}[?12l${ESC}[?25h`],
  ['cnorm (tmux-256color)', `${ESC}[34h${ESC}[?25h`],
  ['smkx', `${ESC}[?1h${ESC}=`],
  ['rmkx', `${ESC}[?1l${ESC}>`],
  ['sc', `${ESC}7`],
  ['flash (xterm-256color)', `${ESC}[?5h${ESC}[?5l`],
  ['flash (tmux-256color)', `${ESC}g`],
  ['bel', BEL],
];
const MOVES_THE_CURSOR: Array<[capability: string, bytes: string]> = [
  ['cup 5 20', `${ESC}[6;21H`],
  ['home', `${ESC}[H`],
  ['hpa 20', `${ESC}[21G`],
  ['vpa 5', `${ESC}[6d`],
  ['cuu1', `${ESC}[A`],
  ['cuf1', `${ESC}[C`],
  ['cuf 5', `${ESC}[5C`],
  ['cub 3', `${ESC}[3D`],
  ['cub1', '\u0008'],
  ['cr', '\r'],
  ['ri', `${ESC}M`],
  ['rc', `${ESC}8`],
  ['clear', `${ESC}[H${ESC}[2J${ESC}[3J`],
];

describe('cleanTaskText: what real programs emit', () => {
  test.each(DOES_NOT_MOVE_THE_CURSOR)('a key with "tput %s" in the middle of it is hidden whole', (_capability, bytes) => {
    for (const token of Object.values(TOKENS)) {
      for (const at of [8, 20]) {
        expect(cleanTaskText(`AWS_SECRET_ACCESS_KEY=${token.slice(0, at)}${bytes}${token.slice(at)}\n`)).toBe('AWS_SECRET_ACCESS_KEY=[redacted]\n');
      }
    }
  });

  test('a key coloured the way a shell script colours it (setaf … sgr0) is hidden whole', () => {
    // printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$K" | sed "s/cGVuIHNl/$(tput setaf 1)&$(tput sgr0)/"
    const [before, match, after] = ['QWxhZGRpbjpv', 'cGVuIHNl', 'c2FtZSBhbmQgbW9yZQ12'];
    for (const reset of [`${ESC}(B${ESC}[m`, `${ESC}[m\u000f`]) {
      expect(cleanTaskText(`AWS_SECRET_ACCESS_KEY=${before}${ESC}[31m${match}${reset}${after}\n`)).toBe('AWS_SECRET_ACCESS_KEY=[redacted]\n');
    }
  });

  test('a key that grep --color prints, with erase codes inside it, is hidden whole', () => {
    // grep --color=always sk- .env
    expect(cleanTaskText(`KEY=${ESC}[01;31m${ESC}[Ksk-${ESC}[m${ESC}[Kshortkey1234567890\n`)).toBe('KEY=[redacted]\n');
  });

  test.each(MOVES_THE_CURSOR)('"tput %s" keeps ordinary words apart, and a token after it is hidden', (_capability, bytes) => {
    expect(cleanTaskText(`alpha${bytes}bravo`)).toMatch(/^alpha\s+bravo$/);
    for (const token of Object.values(TOKENS)) {
      expect(leaks(cleanTaskText(`Authorization: Bearer${bytes}${token}`), token)).toBe(false);
    }
  });
});

describe('cleanTaskText: codes a terminal accepts although they are malformed', () => {
  test.each([
    ['a parameter after an intermediate', `${ESC}[ 1m`],
    ['an intermediate between parameters', `${ESC}[1 2m`],
    ['a control character inside a control sequence', `${ESC}[1\u0000m`],
    ['a line feed inside a control sequence', `${ESC}[1\nm`],
    ['a delete character inside a control sequence', `${ESC}[3\u007f5G`],
    ['a delete character inside a short escape', `${ESC}\u007fc`],
    ['a control character inside a short escape', `${ESC}(\u0000B`],
  ])('%s is read through to its final byte, and the token after it is hidden', (_label, code) => {
    for (const token of Object.values(TOKENS)) {
      const cleaned = cleanTaskText(`Bearer ${code}${token} end`);
      expect(leaks(cleaned, token)).toBe(false);
      expect(CONTROL.test(cleaned)).toBe(false);
      expect(cleaned.endsWith(' end')).toBe(true);
    }
  });

  test('a token that straddles the point where an endless string code is given up on leaves no tail behind', () => {
    // The string code is followed for 2,048 characters. The token starts just before that point.
    const token = TOKENS.longRun;
    for (const lead of [2020, 2030, 2040, 2047]) {
      const cleaned = cleanTaskText(`${ESC}]0;${'t'.repeat(lead - 1)} ${token} after`);
      expect(leaks(cleaned, token)).toBe(false);
      expect(cleaned.endsWith(' after')).toBe(true);
    }
  });
});

describe('cleanTaskText: exact output around a hidden token', () => {
  // The matrix above only checks that no long piece of a token survives. These pin the whole
  // output, so one character too many or too few at either end of a hidden span is caught.
  test.each([
    ['a cursor jump before', `Authorization: Bearer${ESC}[35G${TOKENS.github} and more`, 'Authorization: Bearer [redacted] and more'],
    ['a colour around', `KEY=${ESC}[31m${TOKENS.shortKey}${ESC}[0m;next`, 'KEY=[redacted];next'],
    ['a colour inside', `a ${TOKENS.github.slice(0, 16)}${ESC}[1m${TOKENS.github.slice(16)} b`, 'a [redacted] b'],
    // The word that a code glues straight onto a prefixed token is hidden with it: one of the readings
    // joins across every code, and there the word is part of the token.
    ['a cursor jump after, then a word', `x=${TOKENS.shortKey}${ESC}[10Gy`, 'x=[redacted]'],
    ['a cursor jump after, then a space and a word', `x=${TOKENS.shortKey}${ESC}[10G y`, 'x=[redacted]  y'],
    ['two tokens and a code between', `${TOKENS.github}${ESC}[K ${TOKENS.shortKey}.`, '[redacted] [redacted].'],
    ['the token as the whole text', `${ESC}[32m${TOKENS.longRun}${ESC}[0m`, '[redacted]'],
    ['a token at the very start, a code at the very end', `${TOKENS.shortKey}${ESC}[0m`, '[redacted]'],
    ['a cut-off code that takes the first letter', `v ${ESC}[35;1${TOKENS.github}!`, 'v [redacted]!'],
    ['non-ASCII text on both sides', `clé ${ESC}[1m${TOKENS.shortKey}${ESC}[0m 日本語 🙂`, 'clé [redacted] 日本語 🙂'],
  ])('%s', (_label, raw, expected) => {
    expect(cleanTaskText(raw)).toBe(expected);
  });
});

describe('cleanTaskText: ordinary text is left alone', () => {
  test('text with no control characters gets exactly the ordinary redaction', () => {
    // A small deterministic generator, so a failure can be reproduced.
    // Math.imul keeps the multiplication in 32 bits; a plain `*` overflows what a number can hold exactly
    // and the generator then repeats itself.
    let seed = 20261112;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const seen = new Set<string>();
    const pieces = ['alpha', 'bravo', 'task-speech-summary', 'risk-', 'Bearer', 'KEY=', TOKENS.github, TOKENS.shortKey, TOKENS.longRun, ' ', '\n', '\t', '.', '/', ':', '-', '_', '=', '<<<TASK_CONTEXT>>>', '[31m', 'é', '日本', '0;title'];
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + random(12) }, () => pieces[random(pieces.length)]).join('');
      seen.add(text);
      expect(cleanTaskText(text)).toBe(redactSpeechSecrets(text));
    }
    expect(seen.size).toBeGreaterThan(2500);
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
  test('colours, erases, titles and bells vanish; cursor moves become a gap; words, tabs and line breaks stay', () => {
    const raw = `${ESC}]0;window title${BEL}${ESC}[1;32mPASS${ESC}[0m src/a.test.ts\r\n${ESC}[2K${ESC}[1Gline\ttwo${BEL}\nname${ESC}[20Gvalue\rnext`;
    expect(stripTerminalControl(raw)).toBe('PASS src/a.test.ts\n line\ttwo\nname value next');
  });

  test('text with no codes is returned as it is', () => {
    expect(stripTerminalControl('plain text, with <angle brackets> and é')).toBe('plain text, with <angle brackets> and é');
  });
});
