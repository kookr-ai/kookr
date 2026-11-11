import { describe, expect, test } from 'vitest';
import { ANOMALY_TYPES } from '../shared/contracts/anomalies.js';
import {
  FINDING_PHRASES,
  identifierToWords,
  makeSpeakable,
  spokenFindingPhrase,
} from './speakable-text.js';

const CASES: Array<[label: string, input: string, expected: string]> = [
  // Markdown
  ['strips inline code backticks', 'Run `pnpm test` again.', 'Run pnpm test again.'],
  ['strips bold', 'The **build** failed.', 'The build failed.'],
  ['strips italic asterisks', 'It was *really* slow.', 'It was really slow.'],
  ['strips heading marker', '## Summary\nAll good.', 'Summary. All good.'],
  ['strips bullet markers and joins lines', '- fixed auth\n- added tests', 'fixed auth. added tests.'],
  ['keeps link text only', 'See [the docs](https://example.com/docs/page) now.', 'See the docs now.'],
  ['keeps image alt text', '![diagram](https://x.io/a.png) shows flow.', 'diagram shows flow.'],
  ['strips code fence markers', '```ts\nconst a = 1;\n```', 'const a = 1.'],
  ['strips blockquote marker', '> quoted line', 'quoted line.'],

  // URLs
  ['generic url', 'See https://example.com/a/b for details.', 'See a link for details.'],
  ['url with query string and trailing period', 'Open https://example.com/search?q=a&b=c#frag.', 'Open a link.'],
  ['url in parentheses', 'Docs (https://example.com/x) are out.', 'Docs (a link) are out.'],
  ['github pull request url', 'Merged https://github.com/kookr-ai/kookr/pull/3608 today.', 'Merged pull request 3608 today.'],
  ['github issue url', 'Fixes https://github.com/kookr-ai/kookr/issues/3605.', 'Fixes issue 3605.'],
  ['github pr url with files suffix', 'Look at https://github.com/o/r/pull/12/files please.', 'Look at pull request 12 please.'],
  ['www url', 'Visit www.example.com now.', 'Visit a link now.'],

  // Numbers and refs
  ['hash number', 'Opened PR #3608 for review.', 'Opened PR number 3608 for review.'],
  ['hash number with comma', 'See #12, #13.', 'See number 12, number 13.'],

  // Paths
  ['absolute file path', 'Edited /home/jean/git/kookr/src/core/foo-bar.ts today.', 'Edited foo-bar.ts today.'],
  ['absolute file path at end', 'Edited /home/jean/git/kookr/src/core/foo-bar.ts', 'Edited foo-bar.ts.'],
  ['absolute directory', 'Working in /home/jean/git/kookr/', 'Working in kookr.'],
  ['home path', 'Wrote ~/notes/todo.md.', 'Wrote todo.md.'],
  ['relative file path', 'Changed src/core/foo.ts and src/bar.ts.', 'Changed foo.ts and bar.ts.'],
  ['dot-relative path', 'Moved ./lib/util.js.', 'Moved util.js.'],
  ['path with line number', 'Error at src/core/foo.ts:42:7.', 'Error at foo.ts.'],
  ['index file keeps its folder', 'Edited src/core/index.ts.', 'Edited core index.ts.'],
  ['windows path', 'Edited C:\\Users\\jean\\proj\\src\\main.rs now.', 'Edited main.rs now.'],
  ['windows directory', 'Open C:\\Users\\jean\\proj.', 'Open proj.'],

  // Hashes
  ['commit sha after the word commit', 'Pushed commit 3f2a9c1 to main.', 'Pushed commit to main.'],
  ['bare sha', 'Reverted 3f2a9c1d8e to main.', 'Reverted a commit to main.'],
  ['long sha', 'At a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 it broke.', 'At a commit it broke.'],
  ['uuid dropped', 'Task 123e4567-e89b-12d3-a456-426614174000 failed.', 'Task failed.'],

  // Timestamps
  ['iso timestamp dropped with lead word', 'Updated at 2025-03-04T10:20:30Z.', 'Updated.'],
  ['iso timestamp with millis dropped', 'Seen 2025-03-04T10:20:30.123+01:00 here.', 'Seen here.'],

  // Identifiers
  ['known finding type snake_case', 'The agent is in needs_input state.', 'The agent is in needs input state.'],
  ['deprecated alias is canonicalized', 'Saw tmux_unresponsive twice.', 'Saw backend unreachable twice.'],
  ['unknown snake_case', 'Set max_retry_count higher.', 'Set max retry count higher.'],
  ['screaming snake', 'Raise MAX_RETRIES now.', 'Raise max retries now.'],
  ['known kebab type', 'Hit needs-input again.', 'Hit needs input again.'],
  ['known camel type', 'Hit needsInput again.', 'Hit needs input again.'],
  ['generic kebab left alone', 'A well-known fix.', 'A well-known fix.'],
  ['generic camel left alone', 'Uses JavaScript and iPhone apps.', 'Uses JavaScript and iPhone apps.'],

  // Symbols and punctuation
  ['arrow', 'main -> feature', 'main to feature.'],
  ['fat arrow', 'a => b', 'a to b.'],
  ['unicode arrow', 'old → new', 'old to new.'],
  ['ampersand', 'Lint & test pass', 'Lint and test pass.'],
  ['double ampersand', 'build && deploy', 'build and deploy.'],
  ['trailing ellipsis', 'Thinking about it...', 'Thinking about it.'],
  ['mid ellipsis', 'Wait... what happened', 'Wait, what happened.'],
  ['repeated punctuation', 'Really?!! Yes!!!', 'Really? Yes!'],
  ['trailing colon becomes period', 'Changes:', 'Changes.'],
  ['adds final period', 'Task is running', 'Task is running.'],
  ['trims whitespace', '   hello   world  ', 'hello world.'],

  // Unchanged prose
  ['plain prose unchanged', 'The build passed and all tests are green.', 'The build passed and all tests are green.'],
  ['question unchanged', 'Is the agent done?', 'Is the agent done?'],
  ['and/or left alone', 'Use this and/or that.', 'Use this and/or that.'],
  ['dates left alone', 'Due 2025/03/04.', 'Due 2025/03/04.'],
  ['plain numbers left alone', 'Read 1234567 lines.', 'Read 1234567 lines.'],
  ['dictionary words made of hex letters left alone', 'It was a deadbeef decade.', 'It was a deadbeef decade.'],
  ['slash command left alone', 'Type /compact now.', 'Type /compact now.'],
  ['owner/repo left alone', 'In kookr-ai/kookr today.', 'In kookr-ai/kookr today.'],
  ['empty', '', ''],
  ['whitespace only', '  \n ', ''],
];

describe('makeSpeakable', () => {
  test.each(CASES)('%s', (_label, input, expected) => {
    expect(makeSpeakable(input)).toBe(expected);
  });

  test('is idempotent over every case and extra tricky inputs', () => {
    const extra = [
      'Wait... what?!! See [x](http://a.b/c) -> #12 at /a/b/c.ts:3 & 3f2a9c1d.',
      '**bold** __init__ and snake_case_name\n- item one\n- item two:',
      'C:\\a\\b\\c.txt → ../up/../x.md …',
      '`a` `b` ``c`` ```fence```',
      '...',
      '!!!',
      'a , b ; c :',
    ];
    for (const input of [...CASES.map((c) => c[1]), ...extra]) {
      const once = makeSpeakable(input);
      expect(makeSpeakable(once)).toBe(once);
    }
  });

  test('stays idempotent on pseudo-random mixes of markup, paths and punctuation', () => {
    const vocab = [
      'a', 'Task', 'needs_input', '#12', '/a/b/c.ts', '../x', '...', '\u2026', '->', '&', '**', '`', '- ', '\n',
      '# ', '3f2a9c1', 'https://github.com/o/r/pull/9.', '(', ')', '[', ']', '!?', '::', ',', '.',
      '2025-01-01T00:00:00Z', 'at', 'commit', 'C:\\x\\y.md', '__init__', 'needsInput', '*', '_', '|', '>',
      'src/a/index.ts:3', '~/q', 'x/y',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 3000; i += 1) {
      let input = '';
      const parts = 1 + Math.floor(next() * 8);
      for (let j = 0; j < parts; j += 1) {
        input += vocab[Math.floor(next() * vocab.length)] + (next() < 0.7 ? ' ' : '');
      }
      const once = makeSpeakable(input);
      expect(makeSpeakable(once), JSON.stringify(input)).toBe(once);
    }
  });

  test('never throws on odd input', () => {
    for (const input of ['\u0000', '😀', '[', ']()', '((((', '\\\\', '/', '//', '~', '#', 'a'.repeat(5000)]) {
      expect(() => makeSpeakable(input)).not.toThrow();
    }
    expect(makeSpeakable(undefined as unknown as string)).toBe('');
  });

  test('does not make ordinary text longer in words, except where a number prefix is required', () => {
    const input = 'We fixed the flaky test in the scheduler and the build is green now.';
    expect(makeSpeakable(input).split(/\s+/).length).toBeLessThanOrEqual(input.split(/\s+/).length);
  });

  test('keeps relative parent segments out of ellipsis handling', () => {
    expect(makeSpeakable('Edited ../shared/types.ts.')).toBe('Edited types.ts.');
  });
});

describe('spokenFindingPhrase', () => {
  test('has a phrase for every anomaly type', () => {
    for (const type of ANOMALY_TYPES) {
      expect(spokenFindingPhrase(type)).toBeTruthy();
      expect(FINDING_PHRASES[type].phrase).not.toMatch(/[_]/);
    }
  });

  test.each([
    ['needs_input', 'needs your input'],
    ['permission_blocked', 'is waiting for your permission'],
    ['repeated_error', 'keeps hitting the same error'],
    ['merge_conflict', 'has a merge conflict'],
    ['stale_agent', 'has gone quiet'],
    ['hook_disconnected', 'lost its hook connection'],
    ['hook_missing', 'is missing its hooks'],
    ['hook_parse_degraded', 'is having trouble reading its hook events'],
    ['backend_unreachable', 'cannot be reached'],
    ['api_error', 'hit an API error'],
    ['budget_exceeded', 'went over its budget'],
  ])('%s -> %s', (type, phrase) => {
    expect(spokenFindingPhrase(type)).toBe(phrase);
  });

  test('maps the deprecated alias like its canonical type', () => {
    expect(spokenFindingPhrase('tmux_unresponsive')).toBe(spokenFindingPhrase('backend_unreachable'));
  });

  test('severity only changes wording when it adds information', () => {
    expect(spokenFindingPhrase('needs_input', 'info')).toBe('needs your input');
    expect(spokenFindingPhrase('needs_input', 'warning')).toBe('needs your input');
    expect(spokenFindingPhrase('needs_input', 'critical')).toBe('urgently needs your input');
    expect(spokenFindingPhrase('api_error', 'critical')).toBe('hit an API error');
  });

  test('returns null for unknown types, including prototype keys', () => {
    expect(spokenFindingPhrase('something_new')).toBeNull();
    expect(spokenFindingPhrase('constructor')).toBeNull();
    expect(spokenFindingPhrase('')).toBeNull();
  });

  test('every phrase is already speakable', () => {
    for (const type of ANOMALY_TYPES) {
      const phrase = spokenFindingPhrase(type, 'critical') ?? '';
      expect(makeSpeakable(phrase)).toBe(`${phrase}.`);
    }
  });
});

describe('identifierToWords', () => {
  test('converts snake, screaming, kebab and camel identifiers', () => {
    expect(identifierToWords('hook_parse_degraded')).toBe('hook parse degraded');
    expect(identifierToWords('MAX_RETRIES')).toBe('max retries');
    expect(identifierToWords('needs-input')).toBe('needs input');
    expect(identifierToWords('needsInput')).toBe('needs input');
  });
});
