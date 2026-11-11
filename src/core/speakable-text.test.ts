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
  ['mid ellipsis is left as written', 'Wait... what happened', 'Wait... what happened.'],
  ['repeated punctuation is left as written', 'Really?!! Yes!!!', 'Really?!! Yes!!!'],
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
  ['leaves a spaced ellipsis alone', 'Wait ... what', 'Wait ... what.'],

  // Line-start markers: a number after "-", "*", "+" or ">" is a value, not a marker
  ['keeps a minus before a number', '- 3 degrees', '- 3 degrees.'],
  ['keeps a comparison before a number', '> 5 tests failed', '> 5 tests failed.'],
  ['keeps a plus before a number', '+ 2 files changed', '+ 2 files changed.'],
  ['keeps a star before a decimal', '* .5 seconds', '* .5 seconds.'],
  ['still strips a bullet before a word', '- fixed the bug', 'fixed the bug.'],
  ['still strips stacked word markers', '- - fixed the bug', 'fixed the bug.'],
  ['strips markers per line but keeps numeric ones', '- fixed it\n- 3 left', 'fixed it. - 3 left.'],

  // Brackets
  ['standalone brackets are left as written', 'Status [ok] and [done] today', 'Status [ok] and [done] today.'],
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

  // Commit hashes: 7-40 hex digits with a digit AND a letter a-f, delimited by non-alphanumerics,
  // and trusted only after commit/sha/hash/rev/revision (dropped), after a git verb, or at 12+ characters.
  ['hash after a git verb', 'Rebased onto 3f2a9c1 first.', 'Rebased onto a commit first.'],
  ['hash after revert', 'We revert 3f2a9c1 today.', 'We revert a commit today.'],
  ['hash of 12 characters needs no context', 'See 3f2a9c1d8e0b now.', 'See a commit now.'],
  ['hash with trailing punctuation', 'Fixed in 3f2a9c1d8e0b.', 'Fixed in a commit.'],
  ['hash in parentheses', 'Fixed (3f2a9c1d8e0b) today.', 'Fixed (a commit) today.'],
  ['short hash without context is left alone', 'Saw 3f2a9c1d8e today.', 'Saw 3f2a9c1d8e today.'],
  ['the redaction placeholder loses its brackets', 'Secret [redacted] was logged, [REDACTED].', 'Secret redacted was logged, REDACTED.'],
  ['other bracketed words keep their brackets', 'Secret [hidden] and [redacted-ish] stay.', 'Secret [hidden] and [redacted-ish] stay.'],
  ['hash after the word on', 'Tests pass on abc1234 after the refactor.', 'Tests pass on a commit after the refactor.'],
  ['hash after the word at', 'Stopped at 3f2a9c1 again.', 'Stopped at a commit again.'],
  ['day-month-year word is not a hash even after on', 'Released on 10dec2025 to users.', 'Released on 10dec2025 to users.'],
  ['day-month-year word with a feb month', 'Due on 5feb2024 or at 12FEB24.', 'Due on 5feb2024 or at 12FEB24.'],
  ['year-month-day word', 'Seen on 2024dec10 first.', 'Seen on 2024dec10 first.'],
  ['month and year without a day', 'Released on dec2025, due on feb2024 or 2025dec.', 'Released on dec2025, due on feb2024 or 2025dec.'],
  ['date-like word after commit words is not a hash either', 'Released 10dec2025 to users.', 'Released 10dec2025 to users.'],
  ['compact date is not a hash', 'Seen on 20231110 first.', 'Seen on 20231110 first.'],
  ['hex-looking prose words without context are not hashes', 'The deadbeef12 value, face2face talk.', 'The deadbeef12 value, face2face talk.'],
  ['hex-looking token glued into a word is not a hash', 'Seen on x3f2a9c1 and on 3f2a9c1x.', 'Seen on x3f2a9c1 and on 3f2a9c1x.'],
  ['all-letter 12 character word is not a hash', 'A deadbeefcafe moment.', 'A deadbeefcafe moment.'],
  ['all-digit 12 character number is not a hash', 'Read 123456789012 bytes.', 'Read 123456789012 bytes.'],
  ['hash range is left alone', 'Compared 3f2a9c1d8e0b..HEAD now.', 'Compared 3f2a9c1d8e0b..HEAD now.'],
  ['word glued to hex digits is not a hash', 'The x3f2a9c1d8e0b id.', 'The x3f2a9c1d8e0b id.'],
  ['over 40 hex digits is not a hash', `Digest a1${'b'.repeat(39)} done.`, `Digest a1${'b'.repeat(39)} done.`],

  // Regression: every example the reviewers found, and the text around them, stays as written.
  ['regression: dotfile after a word', 'Check the .env file before deploying.', 'Check the .env file before deploying.'],
  ['regression: numeric range', 'Retry pages 1..10 then stop.', 'Retry pages 1..10 then stop.'],
  ['regression: git range', 'Compared main..HEAD and found 3 commits.', 'Compared main..HEAD and found 3 commits.'],
  ['regression: three-dot git range', 'Diff origin/main...HEAD has 45 files.', 'Diff origin/main...HEAD has 45 files.'],
  ['regression: ellipsis between words', 'Building...done in 3s.', 'Building...done in 3s.'],
  ['regression: two unrelated ** are not bold', 'Grew from 2**12 to 2**16 bytes.', 'Grew from 2**12 to 2**16 bytes.'],
  ['regression: >= at line start', '>= 5 tests failed in CI.', '>= 5 tests failed in CI.'],
  ['regression: emoticon inside a sentence', 'a :) face', 'a :) face.'],
  ['regression: emoticon at the start', ':) All tests pass.', ':) All tests pass.'],
  ['regression: emoji shortcode', ':tada: Released.', ':tada: Released.'],
  ['regression: punctuation code spans keep their backticks', 'Split on `,` instead of `;`', 'Split on `,` instead of `;`.'],
  ['regression: scope operator', 'std::vector', 'std::vector.'],
  ['regression: lower-case "# of" is not a heading', '# of tests', '# of tests.'],
  ['regression: date-like word', '10dec2025', '10dec2025.'],
  ['regression: wrapped line is not a sentence end', 'does not\nwork', 'does not work.'],
  ['regression: wrapped line after a comma', 'First, we ran it,\nthen it broke', 'First, we ran it, then it broke.'],

  // Regression: more text that must survive untouched (only the final period is added).
  ['keeps a space before a lone dot after a symbol', 'C++ .', 'C++ .'],
  ['keeps U.S.', 'U.S. policy', 'U.S. policy.'],
  ['keeps e.g.', 'e.g. foo', 'e.g. foo.'],
  ['keeps a dot-led version fragment', 'v1 .2', 'v1 .2.'],
  ['keeps a spaced decimal point', '3 . 5', '3 . 5.'],
  ['keeps a spaced ratio colon', 'The ratio is 3 : 1 here', 'The ratio is 3 : 1 here.'],
  ['keeps a dot-led extension', 'file .txt', 'file .txt.'],
  ['keeps a flag', '--force', '--force.'],
  ['keeps a branch name', 'feat/x', 'feat/x.'],
  ['keeps a three-part version', '1.2.3', '1.2.3.'],
  ['keeps a clock time', '10:30', '10:30.'],
  ['keeps a percentage', '50%', '50%.'],
  ['keeps a price', '$5', '$5.'],
  ['keeps an email address', 'a@b.com', 'a@b.com.'],
  ['keeps and/or', 'and/or', 'and/or.'],
  ['keeps >=', 'x >= 5', 'x >= 5.'],
  ['keeps <=', 'x <= 5', 'x <= 5.'],
  ['keeps ||', 'a || b', 'a || b.'],
  ['keeps a power', '2**16', '2**16.'],
  ['keeps a compact date', '20231110', '20231110.'],
  ['keeps a dot before a lower-case word', 'node . is the entry', 'node . is the entry.'],
  ['keeps a dot inside quotes', 'He said "ok ." and left', 'He said "ok ." and left.'],
  ['keeps a clock with a stray colon', 'Time is 10:30 :00 sharp', 'Time is 10:30 :00 sharp.'],
  ['keeps a score with a stray colon', 'Score: 3 :1 final', 'Score: 3 :1 final.'],
  ['keeps a ternary', 'Use x ? y : z here', 'Use x ? y : z here.'],
  ['keeps a shell negation', 'Run if ! grep -q x then stop', 'Run if ! grep -q x then stop.'],
  ['keeps empty parentheses that were already in the text', 'Call init() before start().', 'Call init() before start().'],
  ['keeps a literal empty array', 'Returns [] when empty.', 'Returns [] when empty.'],
  ['keeps a literal empty call', 'Called with () here.', 'Called with () here.'],
  ['keeps square brackets around a word', 'Look at items[0] and [the note].', 'Look at items[0] and [the note].'],
  ['keeps a spaced hyphen', 'Fixed a bug - not a feature.', 'Fixed a bug - not a feature.'],
  ['keeps pipes', 'Results: 3 passed | 2 failed.', 'Results: 3 passed | 2 failed.'],
  ['keeps a plain shell pipe', 'cat a.txt | wc -l', 'cat a.txt | wc -l.'],
  ['keeps tilde pairs', 'Use ~~this~~ and ~/ now', 'Use ~~this~~ and ~/ now.'],
  ['keeps mixed exclamation marks', 'Wait!? What happened?!', 'Wait!? What happened?!'],
  ['keeps a doubled comma', 'a,, b', 'a,, b.'],
  ['keeps a leading colon after a period', 'Done. : next', 'Done. : next.'],
  ['keeps a thematic break', '---', '---.'],

  // Space before punctuation: only where the mark plainly closes a clause.
  ['closes the gap before a final question mark', 'Is it done ?', 'Is it done?'],
  ['closes the gap before a capitalised sentence', 'It works . Next step', 'It works. Next step.'],
  ['closes the gap before a semicolon', 'one ; two', 'one; two.'],
  ['closes the gap before a closing quote mark', 'He left "now" .', 'He left "now".'],

  // Arrows and ampersands rewrite only as standalone infix words.
  ['keeps an arrow at the start', '-> foo', '-> foo.'],
  ['keeps an arrow at the end', 'foo ->', 'foo ->.'],
  ['keeps a glued arrow', 'ptr->field and a=>b', 'ptr->field and a=>b.'],
  ['keeps a double-headed arrow', 'a <-> b and x <=> y', 'a <-> b and x <=> y.'],
  ['keeps Q&A', 'The Q&A page', 'The Q&A page.'],
  ['keeps a trailing background ampersand', 'run sleep 5 &', 'run sleep 5 &.'],
  ['rewrites a long arrow', 'a --> b', 'a to b.'],

  // Markdown emphasis needs a word start, a word end and one line.
  ['strips __bold__', 'The __build__ failed.', 'The build failed.'],
  ['strips _em_', 'It was _really_ slow.', 'It was really slow.'],
  ['strips bold with trailing colon inside', '**Note:** it works', 'Note: it works.'],
  ['strips nested emphasis', 'This is **very *important* indeed** now', 'This is very important indeed now.'],
  ['strips emphasis in parentheses', 'Done (*mostly*) today', 'Done (mostly) today.'],
  ['strips bold at a list bullet', '- **Fixed** the bug', 'Fixed the bug.'],
  ['keeps a dunder file name', 'Edit __init__.py now', 'Edit __init__.py now.'],
  ['keeps a dunder file name inside a path', 'Edit src/pkg/__init__.py now', 'Edit __init__.py now.'],
  ['keeps a possessive after a marker pair', "the *build*'s output", "the *build*'s output."],
  ['keeps a marker pair glued to a hyphenated word', 'a *b*-c d', 'a *b*-c d.'],
  ['strips a dunder name that stands alone', 'Call __init__ now', 'Call init now.'],
  ['strips emphasis followed by closing punctuation', 'Done (*mostly*).', 'Done (mostly).'],
  ['keeps a glob', 'Match *.ts and **/*.js files', 'Match *.ts and **/*.js files.'],
  ['keeps star arguments (a final colon becomes the period)', 'def f(*args, **kwargs):', 'def f(*args, **kwargs).'],
  ['keeps multiplication', 'Use x * y * z, not x*y*z or 2 * 3.', 'Use x * y * z, not x*y*z or 2 * 3.'],
  ['keeps parenthesised stars', 'Note (*) and (*) too', 'Note (*) and (*) too.'],
  ['emphasis that wraps over a line break pairs once the lines are joined', '**bold\ntext**', 'bold text.'],
  ['unpaired emphasis markers stay when the lines are joined', '**bold\ntext', '**bold text.'],
  ['keeps an em marker glued to a word', 'a *b*c d', 'a *b*c d.'],
  ['keeps a lone underscore', 'Use _ as a name and _ again', 'Use _ as a name and _ again.'],

  // Code spans.
  ['strips a code span that holds a word', 'Use `a | b` piping.', 'Use a | b piping.'],
  ['keeps operator code spans with their backticks', 'The `::` operator and `.` and `?` and `!`.', 'The `::` operator and `.` and `?` and `!`.'],
  ['keeps an unpaired backtick', 'A stray ` backtick', 'A stray ` backtick.'],
  ['strips a double-backtick span', 'Use ``a ` b`` here', 'Use a ` b here.'],
  ['strips a code span holding a path', 'Edit `src/core/foo.ts` now', 'Edit foo.ts now.'],
  ['a code span that wraps over a line break pairs once the lines are joined', 'a `b\nc` d', 'a b c d.'],
  ['an unpaired backtick stays when the lines are joined', 'a `b\nc d', 'a `b c d.'],

  // Line-start markers.
  ['strips a numbered marker', '1. First step\n2. Second step', 'First step. Second step.'],
  ['strips star, plus and dot bullets', '* one\n+ two\n• three', 'one. two. three.'],
  ['strips an h1 before an upper-case word', '# Summary\nDone', 'Summary. Done.'],
  ['strips a stacked quote and bullet', '> - quoted point', 'quoted point.'],
  ['keeps a hash glued to a word', '#hashtag and #12 failed', '#hashtag and number 12 failed.'],
  ['keeps a checkbox bullet', '- [x] done', '- [x] done.'],
  ['keeps a flag at the line start', '-rf and --force', '-rf and --force.'],
  ['keeps a number marker before a digit', '1.5 seconds', '1.5 seconds.'],
  ['keeps a quote marker before punctuation', '> (note) ok', '> (note) ok.'],
  ['keeps a bullet before a symbol', '* .5 seconds\n+ 2 files', '* .5 seconds + 2 files.'],

  // Joining lines.
  ['joins wrapped lines with a space', 'It is not\nready yet', 'It is not ready yet.'],
  ['a line ending in a period ends the sentence', 'Line one.\nLine two', 'Line one. Line two.'],
  ['a line ending in a colon keeps it', 'Changes:\nfixed it', 'Changes: fixed it.'],
  ['a blank line ends a sentence', 'First paragraph\n\nSecond paragraph', 'First paragraph. Second paragraph.'],
  ['a list ends the sentence before it', 'Intro\n- a\n- b', 'Intro. a. b.'],
  ['a trailing semicolon becomes the final period', 'const a = 1;', 'const a = 1.'],
  ['keeps a double colon at the end', 'std::', 'std::.'],
  ['trailing ellipsis becomes a period', 'Still thinking…', 'Still thinking.'],
  ['two trailing dots stay', 'See etc..', 'See etc..'],
  ['a trailing emoji shortcode keeps its colon', 'Great job :tada:', 'Great job :tada:.'],
  ['a trailing time keeps its colon', 'Starts at 10:30:', 'Starts at 10:30:.'],
  ['trailing ellipsis after a closing bracket', 'Still (thinking)...', 'Still (thinking).'],
  ['a lone ellipsis is left alone', '...', '...'],
  ['an ellipsis after a slash is left alone', 'Open src/..', 'Open src/..'],

  // Dropped tokens leave no gap and no empty pair behind.
  ['drops a timestamp before a comma', 'Seen at 2025-03-04T10:20:30Z, then again', 'Seen, then again.'],
  ['drops a parenthesised timestamp with its lead word', 'Updated (at 2025-03-04T10:20:30Z) fine', 'Updated fine.'],
  ['drops a parenthesised uuid', 'Task (123e4567-e89b-12d3-a456-426614174000) failed.', 'Task failed.'],
  ['drops a bracketed uuid', 'Task [123e4567-e89b-12d3-a456-426614174000] failed.', 'Task failed.'],
  ['drops the timestamp but keeps the rest of a parenthesis', '(updated at 2025-03-04T10:20:30Z)', '(updated).'],
  ['drops a hash after the word commit before a period', 'Pushed commit 3f2a9c1.', 'Pushed commit.'],
];

// --- oracle begin ---
// Forward-built oracle for the "never loses or glues words" property. Every sentence is
// composed from parts that carry BOTH the text fed to makeSpeakable (`raw`) and the text the
// module is ALLOWED to produce (`spoken`). A plain string means raw === spoken, so any word
// difference that is not one of the listed rewrites is a bug. The parts where raw !== spoken
// are exactly the entries of REWRITES, the gap/wrap/marker helpers and the two end helpers
// below: that is the whole exception list, and it is deliberately small.
type Part = string | { raw: string; spoken: string };
interface Sentence {
  raw: string;
  spoken: string;
  template: number;
}
type Pair = readonly [raw: string, spoken: string];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tokens that must come out exactly as they went in, wherever they sit in a sentence. */
const PLAIN = {
  file: ['package.json', 'README.md', '.env', '.gitignore', '.DS_Store', 'Dockerfile', 'tsconfig.json', 'main.go', '.env.local', '.npmrc', 'Next.js', 'Node.js', '__init__.py', '_private.py', '*.py'],
  dotted: ['.txt', '.md', '.5', '.314', '.env', '.gitignore', '.DS_Store', '.npmrc'],
  flag: ['--force', '--no-verify', '-rf', '--dry-run', '-v', '--force-with-lease', '-n'],
  ref: ['feat/x', 'fix/login-bug', 'main', 'release/1.2', 'origin/main', 'main..HEAD', 'origin/main...HEAD', 'HEAD~3', 'v1.2.3-beta.1', 'a/b'],
  version: ['1.2.3', 'v2.0.0', '0.9', '3.11', '1.2.x', 'v1'],
  percent: ['50%', '99.9%', '0%', '12.5%', '100%'],
  clock: ['10:30', '9:05', '23:59', '10:30:15', '10:30am'],
  money: ['$5', '$1,200.50', '€30', '£2.99', '$0.75'],
  email: ['jean@example.com', 'ops-team@corp.io', 'a.b@c.org', 'a@b.com'],
  number: ['3', '42', '1,024', '0.5', '-7', '1e3', '2x', '10k', '5ms', '30s', '2.5GB', '.5', '.314'],
  range: ['1..10', '0..n', 'a..b', '1...10', 'Building...done', 'wait...ok'],
  datelike: ['10dec2025', '20231110', '2025/03/04', '2025-03-04', '5feb2024', '2024dec10', 'dec2025', 'feb2024', '2025dec'],
  hexlike: ['deadbeef12', 'face2face', '3f2a9c1d8e', '1e1000000', 'abc1234', 'deadbeef', 'cafebabe'],
  compare: ['>=', '<=', '<', '>', '==', '!=', '||', '|', '<>'],
  negation: ["didn't", 'does not', 'never', "isn't", "won't", 'cannot', "can't", 'not'],
  emoticon: [':)', ':(', ';)', ':D', ':tada:', ':-)', ':P', ':/', ':rocket:', '<3', ':]'],
  loose: ['...', '…', '!!', '?!', '!?', '??', '--', '—'],
  bang: ['!?', '?!', '!!', '??'],
  opcode: ['`,`', '`;`', '`.`', '`::`', '`?`', '`!`', '`|`', '`()`', '`[]`', '`<=`', '`->`'],
  lang: [
    'C++', 'C#', 'std::vector', 'U.S.', 'e.g.', 'i.e.', 'etc.', 'Mr.', 'a/b', 'and/or', 'w/o', '24/7', '50/50',
    'TCP/IP', 'items[0]', 'init()', '[]', '()', '{}', '(parenthetical)', '[bracketed]', '"quoted"', "'single'",
    "it's", 'x::y', 'foo.bar', 'a.b.c', '3.14', '~~strike~~',
  ],
  star: ['2**16', 'a*b*c', '**kwargs', '*args', '*.ts', '**/*.ts', 'x * y * z', '5 * 3', 'a ** b', '(*)', '(*) and (*)'],
  under: ['_', '__', '_x', 'x_'],
  hash: ['# of', '#hashtag', '#'],
  odd: ['3 . 5', 'v1 .2', 'C++ .', 'file .txt', 'node . is', 'x ? y : z', 'if ! grep -q x', '3 : 1', '10:30 :00', '3 :1'],
  word: ['the build', 'tests', 'the parser', 'CI', 'the deploy', 'auth', 'the cache', 'the migration', 'the agent', 'a worker'],
};
type PlainKind = keyof typeof PLAIN;

/** The intended rewrites, and the only places where the spoken text may differ from the raw text. */
const REWRITES = {
  path: [
    ['src/core/foo.ts', 'foo.ts'], ['lib/util.js', 'util.js'], ['~/notes/todo.md', 'todo.md'], ['./x/y.sh', 'y.sh'],
    ['/home/jean/git/kookr/', 'kookr'], ['C:\\Users\\jean\\main.rs', 'main.rs'], ['src/.eslintrc.json', '.eslintrc.json'],
    ['a/b.json:12', 'b.json'], ['~/.bashrc', '.bashrc'], ['docs/README.md', 'README.md'], ['src/core/index.ts', 'core index.ts'],
    ['src/pkg/__init__.py', '__init__.py'],
  ],
  url: [
    ['https://example.com/a/b', 'a link'], ['https://github.com/o/r/pull/12', 'pull request 12'],
    ['https://github.com/o/r/issues/7', 'issue 7'], ['www.example.com', 'a link'],
    ['https://example.com/search?q=a&b=c#frag', 'a link'],
  ],
  hash: [['3f2a9c1d8e0b', 'a commit'], ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'a commit']],
  snake: [
    ['max_retry_count', 'max retry count'], ['needs_input', 'needs input'], ['MAX_RETRIES', 'max retries'],
    ['tmux_unresponsive', 'backend unreachable'], ['hook_parse_degraded', 'hook parse degraded'],
  ],
  pr: [['#12', 'number 12'], ['#3608', 'number 3608']],
  placeholder: [['[redacted]', 'redacted'], ['[REDACTED]', 'REDACTED']],
  gitword: [['on 3f2a9c1', 'on a commit'], ['onto abc1234', 'onto a commit'], ['at 3f2a9c1d8e', 'at a commit'], ['reverted abc1234', 'reverted a commit']],
  arrow: [['->', 'to'], ['=>', 'to'], ['→', 'to'], ['-->', 'to']],
  amp: [['&', 'and'], ['&&', 'and']],
  md: [
    ['**bold**', 'bold'], ['__strong__', 'strong'], ['*em*', 'em'], ['_em_', 'em'], ['`code`', 'code'],
    ['**Note:**', 'Note:'], ['*not (maybe)*', 'not (maybe)'],
  ],
  mdlink: [['[docs](https://example.com/d)', 'docs'], ['[the note](https://x.io/n)', 'the note'], ['![alt](https://x.io/a.png)', 'alt']],
  // Code spans holding a letter or digit lose their backticks; the content then meets the other
  // rules as bare text, so these deliberately contain *, _, a leading "- " and a spaced ".".
  code: [
    ['`npm test`', 'npm test'], ['`a*b*c`', 'a*b*c'], ['`x_y_z`', 'x y z'], ['`2**16`', '2**16'],
    ['`a * b * c`', 'a * b * c'], ['`git add .`', 'git add .'], ['`- x`', '- x'], ['`--force -v`', '--force -v'],
    ['`_x`', '_x'], ['`*args`', '*args'], ['`src/core/foo.ts`', 'foo.ts'], ['`needs_input`', 'needs input'],
  ],
} satisfies Record<string, readonly Pair[]>;
type RewriteKind = keyof typeof REWRITES;

/** A space before a mark that closes a clause is closed up: "done ." -> "done.". */
const gap = (mark: string): Part => ({ raw: ` ${mark}`, spoken: mark });
/** A line break inside a sentence is a space, never a sentence end. */
const wrap: Part = { raw: '\n', spoken: ' ' };
/** A list item or heading line stands alone: its marker goes and the line ends a sentence. */
const item = (marker: string): Part => ({ raw: `\n${marker}`, spoken: '. ' });
const marker = (raw: string): Part => ({ raw, spoken: '' });
/** A trailing "..." glued to a word becomes ".". */
const trailOff: Part = { raw: '...', spoken: '.' };

interface Picker {
  plain(kind: PlainKind): string;
  rw(kind: RewriteKind): Part;
  int(max: number): number;
}

const TEMPLATES: ReadonlyArray<(p: Picker) => Part[]> = [
  (p) => ['Updated ', p.plain('file'), ' and ran with ', p.plain('flag'), ' on ', p.plain('ref'), '.'],
  (p) => ['Bumped version to ', p.plain('version'), ', which is ', p.plain('percent'), ' faster.'],
  (p) => ['Today ', p.plain('word'), ' ', p.plain('negation'), ' pass at ', p.plain('clock'), '; cost was ', p.plain('money'), '.'],
  (p) => ['Emailed ', p.plain('email'), ' about ', p.plain('word'), ' (', p.plain('number'), ' failures).'],
  (p) => ['Latency is ', p.plain('compare'), ' ', p.plain('number'), ' ms and memory ', p.plain('compare'), ' ', p.plain('number'), '.'],
  (p) => ['It said "', p.plain('word'), ' ', p.plain('negation'), ' work" and/or crashed.'],
  (p) => [p.plain('number'), ' of ', p.plain('number'), ' tests passed; ', p.plain('number'), ' skipped, e.g. ', p.plain('word'), '.'],
  (p) => ['Waiting for review on ', p.plain('ref'), ' - ', p.plain('negation'), ' merge yet!'],
  (p) => ['Fixed the off-by-one in ', p.plain('word'), ': ', p.plain('number'), ' vs ', p.plain('number'), '.'],
  (p) => ['Moved ', p.plain('file'), ' to ', p.plain('ref'), ', then retried ', p.plain('number'), ' times', trailOff],
  (p) => ['Q3 revenue: ', p.plain('money'), ' (+', p.plain('percent'), '), U.S. only.'],
  (p) => ['The ratio ', p.plain('number'), ':', p.plain('number'), ' ', p.plain('negation'), ' change; see section 4.2.'],
  (p) => ['Agent asked: "Should I use ', p.plain('flag'), '?" ', p.plain('word'), ' ', p.plain('negation'), ' know.'],
  (p) => ['Rolled back from ', p.plain('version'), ' to ', p.plain('version'), ' at ', p.plain('clock'), ' UTC.'],
  (p) => ['Mr. Smith opened PR ', p.rw('pr'), ' to update ', p.plain('file'), ' ', p.rw('amp'), ' ', p.plain('file'), '.'],
  (p) => ['Between ', p.plain('number'), ' and ', p.plain('number'), ', i.e. roughly ', p.plain('percent'), ', ', p.plain('word'), ' failed.'],
  (p) => ['Math: ', p.plain('star'), ' and ', p.plain('star'), ' both matter.'],
  (p) => ['Range ', p.plain('number'), '-', p.plain('number'), ' (inclusive)', gap(';'), ' ', p.plain('word'), ' OK.'],
  (p) => ['TODO: ', p.plain('word'), ' — ', p.plain('negation'), ' ship before ', p.plain('clock'), '!!'],
  (p) => [p.plain('word'), ' took ', p.plain('number'), ' (p95: ', p.plain('number'), ') on node 20.x.'],
  (p) => ['Check the ', p.plain('file'), ' file, then edit ', p.plain('file'), ' too.'],
  (p) => ['Retry pages ', p.plain('range'), ' then stop.'],
  (p) => ['Compared ', p.plain('ref'), ' and found ', p.plain('number'), ' commits.'],
  (p) => ['Step ', p.plain('range'), ' finished in ', p.plain('number'), '.'],
  (p) => ['Grew from ', `2**${p.int(30)}`, ' to ', `2**${p.int(30)}`, ' bytes.'],
  (p) => [p.plain('compare'), ' ', p.plain('number'), ' tests failed in CI.'],
  (p) => ['A ', p.plain('emoticon'), ' face appeared today.'],
  (p) => [p.plain('emoticon'), ' All tests pass.'],
  (p) => ['Great job ', p.plain('emoticon')],
  (p) => ['Split on ', p.plain('opcode'), ' instead of ', p.plain('opcode'), ' in the parser.'],
  (p) => ['Uses ', p.plain('lang'), ' for storage.'],
  (p) => [p.plain('hash'), ' tests failed is ', p.plain('number'), '.'],
  (p) => ['Released on ', p.plain('datelike'), ' to users.'],
  (p) => ['We saw ', p.plain('hexlike'), ' in the log today.'],
  (p) => ['Secret ', p.rw('placeholder'), ' was logged for ', p.plain('word'), '.'],
  (p) => ['Tests pass ', p.rw('gitword'), ' after the refactor.'],
  (p) => ['It ', p.plain('negation'), ' work', wrap, 'when ', p.plain('word'), ' runs.'],
  (p) => ['First we ran ', p.plain('file'), ',', wrap, 'then it broke.'],
  (p) => ['Rename file ', p.plain('dotted'), ' to ', p.plain('dotted'), '.'],
  (p) => ['Tests passed ', p.plain('loose'), ' mostly.'],
  (p) => ['See ', p.plain('odd'), ' in the log today.'],
  (p) => ['Release ', p.plain('version'), ' shipped ', p.plain('percent'), ' faster for ', p.plain('money'), ' per user.'],
  (p) => ['Email ', p.plain('email'), ' or ', p.plain('email'), ' about it.'],
  (p) => ['Read ', p.plain('lang'), ' and ', p.plain('lang'), ' carefully.'],
  (p) => ['Coverage went from ', p.plain('percent'), ' ', p.rw('arrow'), ' ', p.plain('percent'), '.'],
  (p) => ['Value is x ', p.plain('compare'), ' ', p.plain('number'), ' and y ', p.plain('compare'), ' ', p.plain('number'), '.'],
  (p) => ['Wait', p.plain('bang'), ' What happened', p.plain('bang')],
  (p) => ['Look at ', p.plain('lang'), ' and ', p.plain('lang'), '.'],
  (p) => ['The ', p.rw('md'), ' step failed.'],
  (p) => ['Run ', p.rw('code'), ' before the build.'],
  (p) => ['Then ', p.rw('code'), ' again and ', p.rw('code'), ' once more today.'],
  (p) => ['See ', p.rw('mdlink'), ' for details.'],
  (p) => ['Edited ', p.rw('path'), ' and ', p.rw('path'), ' today.'],
  (p) => ['Open ', p.rw('url'), ' for details.'],
  (p) => ['Merged ', p.rw('url'), ', then ', p.rw('url'), '.'],
  (p) => ['Reverted ', p.rw('hash'), ' on ', p.plain('ref'), '.'],
  (p) => ['The agent is in ', p.rw('snake'), ' state, not ', p.rw('snake'), '.'],
  (p) => ['Opened ', p.rw('pr'), ', ', p.rw('pr'), ' and ', p.rw('pr'), ' today.'],
  (p) => ['Lint ', p.rw('amp'), ' test ', p.rw('amp'), ' build pass.'],
  (p) => ['Moved ', p.plain('ref'), ' ', p.rw('arrow'), ' ', p.plain('ref'), ' safely.'],
  (p) => ['Fixed ', p.plain('word'), gap(','), ' then ', p.plain('word'), ' ok', gap('.')],
  (p) => ['Is ', p.plain('word'), ' done', gap('?')],
  (p) => ['Retry ', p.plain('word'), wrap, 'on ', p.plain('ref'), wrap, 'and ', p.plain('number'), ' more.'],
  (p) => ['Changes made', item('- '), 'fixed ', p.plain('file'), item('- '), 'added ', p.plain('word'), '.'],
  (p) => [marker('## '), 'Summary', item(''), 'All good with ', p.plain('file'), '.'],
  (p) => [marker('1. '), 'Run ', p.plain('flag'), item('2. '), 'Check ', p.plain('ref')],
  (p) => [marker('> '), 'Quoted ', p.plain('word'), ' here.'],
  (p) => ['First ', p.plain('word'), ' done', { raw: '\n\n', spoken: '. ' }, 'Second ', p.plain('word'), ' next.'],
  (p) => ['Changes:', wrap, 'fixed ', p.plain('file'), '.'],
  (p) => ['Task is running ', p.plain('word')],
  (p) => ['Status ', p.plain('percent'), ' done'],
  (p) => ['Changes', { raw: ':', spoken: '.' }],
  (p) => ['Set a = ', p.plain('number'), { raw: ';', spoken: '.' }],
  (p) => [p.plain('emoticon'), ' Released ', p.plain('version'), '.'],
  (p) => ['Edited ', p.rw('path'), ' with ', p.plain('flag'), ' and ', p.rw('snake'), ' at ', p.plain('clock'), '.'],
  (p) => ['Deployed ', p.plain('version'), ' to ', p.plain('ref'), ' (', p.rw('hash'), ') ', p.rw('arrow'), ' ', p.plain('percent'), '.'],
  (p) => ['Use ', p.plain('star'), ' not ', p.plain('star'), ' here.'],
  (p) => ['Name it ', p.plain('under'), ' for now.'],
  (p) => ['Compare ', p.rw('code'), ' with ', p.plain('opcode'), ' and ', p.plain('lang'), ' please.'],
  (p) => ['Please ', p.rw('md'), ' and ', p.rw('md'), ' ', p.plain('emoticon'), ' now.'],
];

function generateSentences(count: number, seed: number): Sentence[] {
  const random = mulberry32(seed);
  const choose = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const picker: Picker = {
    plain: (kind) => choose(PLAIN[kind]),
    rw: (kind) => {
      const [raw, spoken] = choose(REWRITES[kind] as readonly Pair[]);
      return { raw, spoken };
    },
    int: (max) => 1 + Math.floor(random() * max),
  };
  const sentences: Sentence[] = [];
  for (let i = 0; i < count; i += 1) {
    const template = Math.floor(random() * TEMPLATES.length);
    let raw = '';
    let spoken = '';
    for (const part of TEMPLATES[template](picker)) {
      raw += typeof part === 'string' ? part : part.raw;
      spoken += typeof part === 'string' ? part : part.spoken;
    }
    sentences.push({ raw, spoken, template });
  }
  return sentences;
}

/** Whitespace-separated words, with NO punctuation stripped: a lost ">" or ":)" is a lost word. */
function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** The allowed output: the spoken text plus the closing period the module adds when it is missing. */
function allowedWords(spoken: string): string[] {
  const words = wordsOf(spoken);
  if (words.length > 0 && !/[.!?]["')\]”’]?$/u.test(spoken.trim())) words[words.length - 1] += '.';
  return words;
}

/** Null when `speak` kept every word; otherwise a printable description of the difference. */
function findWordLoss(speak: (text: string) => string, sentence: Pick<Sentence, 'raw' | 'spoken'>): string | null {
  const output = speak(sentence.raw);
  const got = wordsOf(output);
  const want = allowedWords(sentence.spoken);
  if (got.length === want.length && got.every((word, index) => word === want[index])) return null;
  return `${JSON.stringify(sentence.raw)} => ${JSON.stringify(output)} (allowed: ${JSON.stringify(want.join(' '))})`;
}
// --- oracle end ---

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

  test('stays idempotent, never throws and never glues a word on 20,000 pseudo-random mixes', () => {
    const vocab = [
      'a', 'Task', 'needs_input', '#12', '/a/b/c.ts', '../x', '...', '\u2026', '->', '&', '&&', '**', '`', '- ', '\n',
      '# ', '## ', '1. ', '3f2a9c1', '3f2a9c1d8e0b', 'commit', 'revert', 'onto', '10dec2025', 'https://github.com/o/r/pull/9.',
      '(', ')', '[', ']', '()', '[]', '(())', '[[x]]', '!?', '::', ',', '.', ';', ':', ' .', ' ,', ' :', '?',
      '2025-01-01T00:00:00Z', 'at', 'from', 'to', 'C:\\x\\y.md', '__init__', 'needsInput', '*', '_', '__', '|', '||',
      '>', '>=', '<=', 'src/a/index.ts:3', '~/q', 'x/y', 'items[0]', '/api/tasks/42', '.env', '.gitignore',
      '.DS_Store', '.314', '.5', '~/.bashrc', '/home/u/repo/.env', '.github/workflows/ci.yml', 'src/.eslintrc.json',
      '-v', '--force', '@user', '$5', '50%', '10:30', '1..10', 'main..HEAD', 'Building...done', '2**16', 'a*b*c',
      '*args', '*em*', '_em_', '**bold**', '`,`', '`;`', '`x`', '`a b`', 'std::vector', ':)', ':tada:', ',x', ';)',
      '> 5', '- 3', '+ 2', '* 4', '-3', '> ', '+ ', '* ', '"', "'", 'word', 'done', 'Fixed', '123e4567-e89b-12d3-a456-426614174000',
    ];
    // Tokens that start with punctuation and must never end up glued to the word before them.
    const glueSensitive = ['.env', '.gitignore', '.DS_Store', '.314', '.5', ':)', ':tada:', ',x', ';)', '--force', '-v', '$5', '@user'];
    const random = mulberry32(0x9e3779b9);
    const seen = new Set<string>();
    const problems: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      let input = '';
      const parts = 1 + Math.floor(random() * 9);
      for (let j = 0; j < parts; j += 1) {
        const piece = vocab[Math.floor(random() * vocab.length)];
        // Occasionally repeat a piece to produce runs like "...." or "[[[".
        input += random() < 0.15 ? piece.repeat(2 + Math.floor(random() * 5)) : piece;
        input += random() < 0.75 ? ' ' : '';
      }
      seen.add(input);
      const once = makeSpeakable(input);
      if (makeSpeakable(once) !== once) problems.push(`not idempotent: ${JSON.stringify(input)} => ${JSON.stringify(once)}`);
      for (const token of glueSensitive) {
        // A token may only end up attached to a word if it was already attached to something in the input.
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const gluedInOutput = once.match(new RegExp(`[A-Za-z0-9_]${escaped}`, 'g'))?.length ?? 0;
        const attachedInInput = input.match(new RegExp(`\\S${escaped}`, 'g'))?.length ?? 0;
        if (gluedInOutput > attachedInInput) problems.push(`glued ${token}: ${JSON.stringify(input)} => ${JSON.stringify(once)}`);
      }
      if (problems.length >= 5) break;
    }
    expect(problems).toEqual([]);
    expect(seen.size).toBeGreaterThan(15_000);
  }, 60_000);

  test.each<[label: string, input: string, expected: string]>([
    ['deeply nested empty parentheses are content', '(((((((())))))))', '(((((((()))))))).'],
    ['deeply nested brackets are not unwrapped', '[[[[[[[[x]]]]]]]]', '[[[[[[[[x]]]]]]]].'],
    ['nested brackets beside an index', 'Use [[c]] and x[[d]] and [a][b]', 'Use [[c]] and x[[d]] and [a][b].'],
  ])('leaves nested groups as written and settles at once: %s', (_label, input, expected) => {
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
    expect(makeSpeakable(']()')).toBe('](' + ').');
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
      '**a '.repeat(10_000),
      '_a '.repeat(10_000),
      '`a '.repeat(10_000),
      '``a ```b ````c '.repeat(2_000),
      '[x]('.repeat(10_000),
      '![x]('.repeat(10_000),
      '- > # '.repeat(10_000),
      ' , ; '.repeat(10_000),
      'commit abc1234 '.repeat(5_000),
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

describe('makeSpeakable never loses or glues words', () => {
  test('uses at least 60 templates and every one of them is exercised', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(60);
    const used = new Set(generateSentences(6000, 0x5eed).map((sentence) => sentence.template));
    expect(used.size).toBe(TEMPLATES.length);
  });

  test('keeps the words of 4,000 generated sentences apart from the listed rewrites', () => {
    const sentences = generateSentences(4000, 0x5eed);
    expect(new Set(sentences.map((sentence) => sentence.raw)).size).toBeGreaterThanOrEqual(500);
    const losses: string[] = [];
    for (const sentence of sentences) {
      const loss = findWordLoss(makeSpeakable, sentence);
      if (loss) losses.push(loss);
      const once = makeSpeakable(sentence.raw);
      if (makeSpeakable(once) !== once) losses.push(`not idempotent: ${JSON.stringify(sentence.raw)}`);
    }
    // Print the first few offenders so a failure names the sentence.
    expect(losses.slice(0, 5)).toEqual([]);
  });

  test('plain sentences come back byte for byte except for the closing period', () => {
    const plainKinds = Object.keys(PLAIN) as PlainKind[];
    for (const kind of plainKinds) {
      for (const token of PLAIN[kind]) {
        // Placed mid-sentence, between ordinary words, with a lower-case word after it.
        const input = `We saw ${token} in the log today.`;
        expect(makeSpeakable(input), `${kind}: ${token}`).toBe(input);
      }
    }
  });

  test('the oracle flags every wrong rewrite the reviewers found', () => {
    const reviewerFindings: Array<[input: string, wrongOutput: string]> = [
      ['Check the .env file before deploying.', 'Check the.env file before deploying.'],
      ['Retry pages 1..10 then stop.', 'Retry pages 1.10 then stop.'],
      ['Compared main..HEAD today.', 'Compared main.HEAD today.'],
      ['Building...done', 'Building.done.'],
      ['Grew from 2**12 to 2**16 bytes.', 'Grew from 212 to 216 bytes.'],
      ['>= 5 tests failed', '= 5 tests failed.'],
      ['a :) face', 'a:) face.'],
      [':) All tests pass.', ') All tests pass.'],
      [':tada: Released.', 'tada: Released.'],
      ['Split on `,` instead of `;`', 'Split on, instead of;.'],
      ['Uses std::vector here.', 'Uses std:vector here.'],
      ['# of tests', 'of tests.'],
      ['10dec2025', 'a commit.'],
      ['does not\nwork', 'does not. work.'],
      ['[[x]] and [y]', 'x and y.'],
    ];
    for (const [input, wrong] of reviewerFindings) {
      expect(findWordLoss(() => wrong, { raw: input, spoken: input }), input).not.toBeNull();
    }
    // And it accepts the right answers, so it is not simply failing everything.
    expect(findWordLoss(makeSpeakable, { raw: 'a :) face', spoken: 'a :) face' })).toBeNull();
    expect(findWordLoss(makeSpeakable, { raw: 'does not\nwork', spoken: 'does not work' })).toBeNull();
  });

  test('the explicit rewrite table matches what the module really does', () => {
    for (const [kind, pairs] of Object.entries(REWRITES) as Array<[RewriteKind, readonly Pair[]]>) {
      for (const [raw, spoken] of pairs) {
        // Arrows and ampersands rewrite only between two words; everything else anywhere mid-sentence.
        const input = `We saw ${raw} here today.`;
        expect(makeSpeakable(input), `${kind}: ${raw}`).toBe(`We saw ${spoken} here today.`);
      }
    }
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
