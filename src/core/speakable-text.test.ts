import { describe, expect, test } from 'vitest';
import { ANOMALY_TYPES } from '../shared/contracts/anomalies.js';
import {
  FINDING_PHRASES,
  identifierToWords,
  makeSpeakable,
  spokenFindingPhrase,
  stripGeneratedPhrases,
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

  // Dotted product and library names are prose, not files
  ['keeps Next.js in a slash pair', 'Migrated from React/Next.js to Remix.', 'Migrated from React/Next.js to Remix.'],
  ['keeps Koa.js in a slash pair', 'Express.js/Koa.js servers are fast.', 'Express.js/Koa.js servers are fast.'],
  ['keeps npm/Node.js', 'Installed npm/Node.js today.', 'Installed npm/Node.js today.'],
  ['keeps owner/repo.git', 'owner/repo.git cloned.', 'owner/repo.git cloned.'],
  ['still shortens a lower-case source path', 'Edited src/foo.ts today.', 'Edited foo.ts today.'],
  ['still shortens an all-caps doc path', 'Read docs/README.md first.', 'Read README.md first.'],
  ['still shortens a path with a line suffix', 'See a/b.json:12 now.', 'See b.json now.'],

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
  ['slash-separated prose words (3 segments) left alone', 'The lint/typecheck/test job failed.', 'The lint/typecheck/test job failed.'],
  ['input/output/error left alone', 'Only input/output/error handling changed.', 'Only input/output/error handling changed.'],
  ['TCP/IP/UDP left alone', 'TCP/IP/UDP not supported.', 'TCP/IP/UDP not supported.'],
  ['read/write/execute left alone', 'Use read/write/execute perms.', 'Use read/write/execute perms.'],
  ['yes/no/maybe left alone', 'yes/no/maybe', 'yes/no/maybe.'],
  ['input/output left alone', 'Check input/output first.', 'Check input/output first.'],
  ['50/50 left alone', 'A 50/50 chance.', 'A 50/50 chance.'],
  ['version number left alone', 'Upgraded to 1.2.3 today.', 'Upgraded to 1.2.3 today.'],
  ['unanchored three-segment file path still shortened', 'Edited src/core/deep/foo.json now.', 'Edited foo.json now.'],
  ['api route with numeric id left alone', 'Not found: /api/tasks/42', 'Not found: /api/tasks/42.'],
  ['api route with trailing word left alone', 'Open /api/tasks/42/speak', 'Open /api/tasks/42/speak.'],
  ['non-api route ending in a number left alone', 'Open /tasks/42 now.', 'Open /tasks/42 now.'],
  ['anchored api file-like route left alone', 'Fetch /api/export/report.json again.', 'Fetch /api/export/report.json again.'],

  // Dot-leading words keep the space before them
  ['keeps the space before .env', 'Edit the .env file to add the key.', 'Edit the .env file to add the key.'],
  [
    'keeps the space before .gitignore and .DS_Store',
    'ignores .gitignore entries and .DS_Store files',
    'ignores .gitignore entries and .DS_Store files.',
  ],
  ['keeps the space before .314', 'Pi is roughly .314 times ten', 'Pi is roughly .314 times ten.'],
  ['keeps the space before .5', 'Add .5 cups of water', 'Add .5 cups of water.'],
  ['keeps the space before .env.local and .npmrc', 'Update the .env.local and .npmrc files', 'Update the .env.local and .npmrc files.'],
  ['shortened home dotfile keeps its leading space', 'Reading ~/.bashrc now', 'Reading .bashrc now.'],
  ['shortened rooted dotfile keeps its leading space', 'Edited /home/u/repo/.env', 'Edited .env.'],
  ['dot directory path shortens to the file', '.github/workflows/ci.yml', 'ci.yml.'],
  ['dotfile at the end of a path with a dot directory', 'Edited src/.eslintrc.json today', 'Edited .eslintrc.json today.'],
  ['still collapses a space before a sentence-ending dot', 'done .', 'done.'],
  ['still collapses a space before a clause comma', 'first , then second .', 'first, then second.'],
  ['still collapses a space before an ellipsis run', 'Wait ... what', 'Wait. what.'],

  // Line-start markers: a number after "-", "*", "+" or ">" is a value, not a marker
  ['keeps a minus before a number', '- 3 degrees', '- 3 degrees.'],
  ['keeps a comparison before a number', '> 5 tests failed', '> 5 tests failed.'],
  ['keeps a plus before a number', '+ 2 files changed', '+ 2 files changed.'],
  ['keeps a star before a decimal', '* .5 seconds', '* .5 seconds.'],
  ['still strips a bullet before a word', '- fixed the bug', 'fixed the bug.'],
  ['still strips stacked word markers', '- - fixed the bug', 'fixed the bug.'],
  ['strips markers per line but keeps numeric ones', '- fixed it\n- 3 left', 'fixed it. - 3 left.'],

  // Brackets
  ['standalone brackets unwrapped', 'Status [ok] and [done] today', 'Status ok and done today.'],
  ['index brackets left alone', 'items[0] and arr[5]', 'items[0] and arr[5].'],
  ['chained index brackets left alone', 'grid[1][2] changed', 'grid[1][2] changed.'],

  // Timestamp ranges
  [
    'timestamp range leaves no dangling from/to',
    'Ran from 2026-11-11T10:00:00Z to 2026-11-11T11:00:00Z',
    'Ran.',
  ],
  ['timestamp range inside a sentence', 'The job ran from 2026-11-11T10:00:00Z to 2026-11-11T11:00:00Z fine.', 'The job ran fine.'],
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
      'src/a/index.ts:3', '~/q', 'x/y', 'from', 'to', 'items[0]', '/api/tasks/42',
      '.env', '.314', '~/.bashrc', '.github/workflows/ci.yml', '> 5', '- 3', '+ 2', '(())', '[[x]]', ' .',
    ];
    // mulberry32: a 32-bit PRNG that stays exact (no float overflow).
    let state = 0x9e3779b9;
    const next = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const seen = new Set<string>();
    for (let i = 0; i < 3000; i += 1) {
      let input = '';
      const parts = 1 + Math.floor(next() * 8);
      for (let j = 0; j < parts; j += 1) {
        const piece = vocab[Math.floor(next() * vocab.length)];
        // Occasionally repeat a piece to produce runs like "...." or "[[[".
        input += next() < 0.2 ? piece.repeat(2 + Math.floor(next() * 5)) : piece;
        input += next() < 0.7 ? ' ' : '';
      }
      seen.add(input);
      const once = makeSpeakable(input);
      expect(makeSpeakable(once), JSON.stringify(input)).toBe(once);
    }
    expect(seen.size).toBeGreaterThan(2500);
  });

  test.each<[label: string, input: string, expected: string]>([
    ['deeply nested empty parentheses', '(((((((())))))))', '.'],
    ['deeply nested brackets', '[[[[[[[[x]]]]]]]]', 'x.'],
    ['nested brackets beside an index', 'Use [[c]] and x[[d]] and [a][b]', 'Use c and x[d] and a[b].'],
  ])('settles nested groups in one go: %s', (_label, input, expected) => {
    const start = performance.now();
    const once = makeSpeakable(input);
    expect(performance.now() - start).toBeLessThan(200);
    expect(once).toBe(expected);
    expect(makeSpeakable(once)).toBe(once);
  });

  test('stays idempotent and fast on very deep nesting', () => {
    const inputs = [
      '('.repeat(1000) + ')'.repeat(1000),
      `${'['.repeat(999)}x${']'.repeat(999)}`,
      '['.repeat(2000) + 'x' + ']'.repeat(2000),
      '(['.repeat(500) + ']);'.repeat(500),
    ];
    for (const input of inputs) {
      const start = performance.now();
      const once = makeSpeakable(input);
      expect(performance.now() - start).toBeLessThan(200);
      expect(makeSpeakable(once)).toBe(once);
    }
  });

  test('handles odd input with concrete output', () => {
    expect(makeSpeakable('[')).toBe('[.');
    expect(makeSpeakable(']()')).toBe('].');
    expect(makeSpeakable('((((')).toBe('((((.');
    expect(makeSpeakable('\u0000')).toBe('\u0000.');
    expect(makeSpeakable('😀')).toBe('😀.');
    expect(makeSpeakable('/')).toBe('/.');
    expect(makeSpeakable('//')).toBe('//.');
    expect(makeSpeakable('#')).toBe('#.');
    expect(makeSpeakable('a'.repeat(5000))).toHaveLength(2001);
    expect(makeSpeakable(undefined as unknown as string)).toBe('');
  });

  test.each<[label: string, input: string]>([
    ['dot run before a word', `a${'.'.repeat(200)} b`],
    ['ellipsis characters', '\u2026'.repeat(200)],
    ['open brackets', '['.repeat(5000)],
    ['underscores', '_'.repeat(5000)],
    ['leading spaces', `${' '.repeat(5000)}x`],
    ['slashes', '/'.repeat(5000)],
    ['segmented slashes', 'a/'.repeat(3000)],
    ['dot run longer than any backtracking budget', `a${'.'.repeat(50)} b`],
  ])('runs in linear time on %s', (_label, input) => {
    const start = performance.now();
    makeSpeakable(input);
    expect(performance.now() - start).toBeLessThan(200);
  });

  test('caps the processed input so pathological text stays fast', () => {
    const inputs = [
      '['.repeat(50_000),
      '[a'.repeat(25_000),
      '`'.repeat(50_000),
      '*a'.repeat(25_000),
      '.'.repeat(50_000),
      '/a'.repeat(25_000),
      '- '.repeat(25_000),
      'word '.repeat(10_000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      const once = makeSpeakable(input);
      expect(performance.now() - start).toBeLessThan(500);
      expect(once.length).toBeLessThanOrEqual(2100);
    }
  });

  test('keeps relative parent segments out of ellipsis handling', () => {
    expect(makeSpeakable('Edited ../shared/types.ts.')).toBe('Edited types.ts.');
  });
});

describe('stripGeneratedPhrases', () => {
  test('removes the phrases makeSpeakable generates but keeps identifier words', () => {
    expect(stripGeneratedPhrases('Tests pass on a commit after a link, pull request 7, issue 8, number 42.'))
      .toBe('Tests pass on after , , , .');
    expect(stripGeneratedPhrases('Next step is run tests.')).toBe('Next step is run tests.');
    expect(stripGeneratedPhrases('Waiting on approve request')).toBe('Waiting on approve request');
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
