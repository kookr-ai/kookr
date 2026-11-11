import { describe, expect, test } from 'vitest';
import { ANOMALY_TYPES } from '../shared/contracts/anomalies.js';
import {
  FINDING_PHRASES,
  identifierToWords,
  makeSpeakable,
  settleSpeakable,
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
  ['keeps a blockquote marker (a quote is also a comparison)', '> quoted line', '> quoted line.'],

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
  ['commit sha after the word commit keeps the word and says ID', 'Pushed commit 3f2a9c1 to main.', 'Pushed commit ID to main.'],
  ['bare sha', 'Reverted 3f2a9c1d8e to main.', 'Reverted a commit to main.'],
  ['long sha', 'At a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 it broke.', 'At a commit it broke.'],
  ['uuid after a label keeps the label and says ID', 'Task 123e4567-e89b-12d3-a456-426614174000 failed.', 'Task ID failed.'],

  // Timestamps
  ['iso timestamp is a set time and its lead word stays', 'Updated at 2025-03-04T10:20:30Z.', 'Updated at a set time.'],
  ['iso timestamp with millis and offset is a set time', 'Seen 2025-03-04T10:20:30.123+01:00 here.', 'Seen a set time here.'],

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
    'timestamp range keeps from/to and says a set time for each end',
    'Ran from 2026-11-11T10:00:00Z to 2026-11-11T11:00:00Z',
    'Ran from a set time to a set time.',
  ],
  [
    'timestamp range inside a sentence',
    'The job ran from 2026-11-11T10:00:00Z to 2026-11-11T11:00:00Z fine.',
    'The job ran from a set time to a set time fine.',
  ],
  ['empty', '', ''],
  ['whitespace only', '  \n ', ''],

  // Commit hashes: 7-40 hex digits with a digit AND a letter a-f, delimited by non-alphanumerics,
  // and trusted only after commit/sha/hash/rev/revision ("ID"), after a git verb ("a commit"), or at 12+ characters.
  ['hash after a git verb', 'Rebased onto 3f2a9c1 first.', 'Rebased onto a commit first.'],
  ['hash after revert', 'We revert 3f2a9c1 today.', 'We revert a commit today.'],
  ['a long hex token with no git word is only an ID', 'See 3f2a9c1d8e0b now.', 'See an ID now.'],
  ['a long hex token with trailing punctuation is an ID', 'Fixed in 3f2a9c1d8e0b.', 'Fixed in an ID.'],
  ['a long hex token in parentheses is an ID', 'Fixed (3f2a9c1d8e0b) today.', 'Fixed (an ID) today.'],
  ['a 24 character ObjectId is an ID, not a commit', 'Deleted 507f1f77bcf86cd799439011 today.', 'Deleted an ID today.'],
  ['a long hex token after a git word is still a commit', 'Reverted 3f2a9c1d8e0b today.', 'Reverted a commit today.'],
  ['a long hex token after an id label keeps the label and says ID', 'Request id 3f2a9c1d8e0b failed.', 'Request id ID failed.'],
  ['a uuid after a preposition is an ID, not a dangling word', 'Retry for 123e4567-e89b-12d3-a456-426614174000 failed.', 'Retry for an ID failed.'],
  ['a uuid at the start of the text is an ID', '123e4567-e89b-12d3-a456-426614174000 failed.', 'an ID failed.'],
  ['a uuid after a label colon says ID', 'Task: 123e4567-e89b-12d3-a456-426614174000 failed.', 'Task: ID failed.'],
  ['a uuid after a label noun says ID', 'Task 123e4567-e89b-12d3-a456-426614174000 failed.', 'Task ID failed.'],
  ['a uuid after "the" says ID, not "an ID"', 'The 123e4567-e89b-12d3-a456-426614174000 task failed.', 'The ID task failed.'],
  ['a uuid before "and" is an ID', 'Fixed 123e4567-e89b-12d3-a456-426614174000 and 123e4567-e89b-12d3-a456-426614174000.', 'Fixed an ID and an ID.'],
  ['a uuid bullet list keeps one ID per item', 'Failed tasks:\n- 123e4567-e89b-12d3-a456-426614174000\n- 123e4567-e89b-12d3-a456-426614174000', 'Failed tasks: an ID. an ID.'],
  ['a sha256 digest is an ID', 'Digest sha256:a1b2c3d4e5f60718293a4b5c6d7e8f9012345678a1b2c3d4e5f60718293a4b5c matched.', 'Digest an ID matched.'],
  ['an md5 digest is an ID', 'Digest md5:a1b2c3d4e5f60718293a4b5c6d7e8f90 matched.', 'Digest an ID matched.'],
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
  ['keeps numbered markers (a number is also a count)', '1. First step\n2. Second step', '1. First step 2. Second step.'],
  ['strips star, plus and dot bullets', '* one\n+ two\n• three', 'one. two. three.'],
  ['strips an h1 before an upper-case word', '# Summary\nDone', 'Summary. Done.'],
  ['keeps a quote marker in front of a bullet', '> - quoted point', '> - quoted point.'],
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
  ['a list after a line that ends a sentence ends the sentence before it', 'Intro.\n- a\n- b', 'Intro. a. b.'],
  ['a list after a lead-in colon keeps the colon', 'Intro:\n- a\n- b', 'Intro: a. b.'],
  ['a list after a line that stops mid-sentence is that sentence wrapping, so nothing is stripped', 'Intro\n- a\n- b', 'Intro - a - b.'],
  ['a trailing semicolon becomes the final period', 'const a = 1;', 'const a = 1.'],
  ['keeps a double colon at the end', 'std::', 'std::.'],
  ['trailing ellipsis becomes a period', 'Still thinking…', 'Still thinking.'],
  ['two trailing dots stay', 'See etc..', 'See etc..'],
  ['a trailing emoji shortcode keeps its colon', 'Great job :tada:', 'Great job :tada:.'],
  ['a trailing time keeps its colon', 'Starts at 10:30:', 'Starts at 10:30:.'],
  ['trailing ellipsis after a closing bracket', 'Still (thinking)...', 'Still (thinking).'],
  ['a lone ellipsis is left alone', '...', '...'],
  ['an ellipsis after a slash is left alone', 'Open src/..', 'Open src/..'],

  // An identifier is never dropped: it keeps its brackets and its label, and is "ID" or "an ID".
  ['a parenthesised uuid keeps its brackets and says ID', 'Task (123e4567-e89b-12d3-a456-426614174000) failed.', 'Task (ID) failed.'],
  ['a bracketed uuid keeps its brackets and says ID', 'Task [123e4567-e89b-12d3-a456-426614174000] failed.', 'Task [ID] failed.'],
  ['a hash after the word commit before a period says ID', 'Pushed commit 3f2a9c1.', 'Pushed commit ID.'],

  // A timestamp is NEVER dropped. It becomes "a set time" ("A set time" where it opens a sentence) in every
  // position, and every word, label, colon, bracket and mark around it stays exactly as written. Dropping a
  // timestamp and its lead changes what a sentence says (review rounds 1 to 5).
  ['a negated update keeps its time', 'No files were updated at 2025-11-10T10:00:00Z.', 'No files were updated at a set time.'],
  ['a negated log keeps its time', 'Nothing was logged at 2025-11-10T10:00:00Z.', 'Nothing was logged at a set time.'],
  [
    'a not-yet-completed job keeps its time',
    'The nightly backup had not yet completed at 2025-11-10T10:00:00Z.',
    'The nightly backup had not yet completed at a set time.',
  ],
  ['a prohibition after "@" keeps its time', 'Do not deploy @ 2025-11-10T10:00:00Z', 'Do not deploy @ a set time.'],
  [
    'a prohibition on a dated snapshot keeps its time',
    'Do not restore the snapshot dated 2025-11-10T10:00:00Z.',
    'Do not restore the snapshot dated a set time.',
  ],
  [
    'an "only" restriction keeps its time',
    'Delete only files modified on 2025-11-10T10:00:00Z.',
    'Delete only files modified on a set time.',
  ],
  [
    'a "not the latest" contrast keeps its time',
    'Use the backup dated 2025-11-10T10:00:00Z, not the latest one.',
    'Use the backup dated a set time, not the latest one.',
  ],
  ['"as of" at the start keeps its lead', 'As of 2025-11-10T10:00:00Z the build is green.', 'As of a set time the build is green.'],
  ['"as of" mid-sentence keeps its lead', 'Status as of 2025-11-10T10:00:00Z is green.', 'Status as of a set time is green.'],
  ['"as of" at the end keeps its lead', 'Green as of 2025-11-10T10:00:00Z.', 'Green as of a set time.'],
  ['"as of" before a comma keeps both', 'As of 2025-11-10T10:00:00Z, the build is green.', 'As of a set time, the build is green.'],
  ['"as at" keeps its lead', 'Stock as at 2025-11-10T10:00:00Z is low.', 'Stock as at a set time is low.'],
  ['a parenthesised "as of" keeps its brackets', 'Green (as of 2025-11-10T10:00:00Z) now.', 'Green (as of a set time) now.'],
  ['until keeps its lead', 'Do not merge until 2025-11-10T10:00:00Z.', 'Do not merge until a set time.'],
  ['since keeps its lead', 'No failures since 2025-11-10T10:00:00Z.', 'No failures since a set time.'],
  ['till keeps its lead', 'Frozen till 2025-11-10T10:00:00Z please.', 'Frozen till a set time please.'],
  ['before keeps its lead', 'Nothing runs before 2025-11-10T10:00:00Z today.', 'Nothing runs before a set time today.'],
  ['after keeps its lead', 'Retried after 2025-11-10T10:00:00Z, then stopped.', 'Retried after a set time, then stopped.'],
  ['by keeps its lead', 'Finish by 2025-11-10T10:00:00Z or stop.', 'Finish by a set time or stop.'],
  ['through and within keep their lead', 'Valid through 2025-11-10T10:00:00Z and within 2025-11-10T10:00:00Z only.', 'Valid through a set time and within a set time only.'],
  ['from and to keep both leads', 'Ran from 2025-11-10T10:00:00Z to 2025-11-10T10:00:00Z.', 'Ran from a set time to a set time.'],
  ['between and keeps both leads', 'Ran between 2025-11-10T10:00:00Z and 2025-11-10T10:00:00Z fine.', 'Ran between a set time and a set time fine.'],
  ['a dash range keeps both ends', 'Ran 2025-11-10T10:00:00Z - 2025-11-10T10:00:00Z fine.', 'Ran a set time - a set time fine.'],
  ['a parenthesised limiting lead keeps its brackets', 'Green (since 2025-11-10T10:00:00Z) now.', 'Green (since a set time) now.'],
  ['a time-bearing word keeps a time', 'Token expires 2025-11-10T10:00:00Z.', 'Token expires a set time.'],
  ['a time-bearing word before "at" keeps a time', 'Token expires at 2025-11-10T10:00:00Z.', 'Token expires at a set time.'],
  ['of before a timestamp keeps the word', 'The build of 2025-11-10T10:00:00Z failed.', 'The build of a set time failed.'],
  ['at after a label stays', 'Updated at 2025-11-10T10:00:00Z.', 'Updated at a set time.'],
  ['on after a label stays', 'Created on 2025-11-10T10:00:00Z by hand.', 'Created on a set time by hand.'],
  ['dated stays', 'The report dated 2025-11-10T10:00:00Z is old.', 'The report dated a set time is old.'],
  ['timestamped stays', 'The log timestamped 2025-11-10T10:00:00Z is old.', 'The log timestamped a set time is old.'],
  ['@ stays', 'Deployed @ 2025-11-10T10:00:00Z fine.', 'Deployed @ a set time fine.'],
  ['a bare "at" keeps its time after a sentence', 'Done. At 2025-11-10T10:00:00Z, it failed.', 'Done. At a set time, it failed.'],
  ['a bare "at" keeps its time before the final period', 'Done. At 2025-11-10T10:00:00Z.', 'Done. At a set time.'],
  ['a bare "at" keeps its time at the start', 'At 2025-11-10T10:00:00Z, it failed.', 'At a set time, it failed.'],
  ['"as of" and its comma stay after a sentence', 'Done. As of 2025-11-10T10:00:00Z, it failed.', 'Done. As of a set time, it failed.'],
  ['"as of" in the middle of a sentence stays', 'Wait. Status as of 2025-11-10T10:00:00Z is green.', 'Wait. Status as of a set time is green.'],
  ['a lead before a capitalised word stays', 'As of 2025-11-10T10:00:00Z iOS 17 is out.', 'As of a set time iOS 17 is out.'],
  ['a lower-case lead stays', 'Fine, as of 2025-11-10T10:00:00Z it works.', 'Fine, as of a set time it works.'],
  ['a parenthesised timestamp with a word before it', '(updated 2025-11-10T10:00:00Z)', '(updated a set time).'],
  ['a label before a timestamp stays', 'Seen 2025-11-10T10:00:00Z here.', 'Seen a set time here.'],
  ['a bracketed timestamp keeps its brackets', 'Seen [2025-11-10T10:00:00Z] here.', 'Seen [a set time] here.'],
  ['a colon after "as of" stays', 'As of 2025-11-10T10:00:00Z: 3 failing tests.', 'As of a set time: 3 failing tests.'],
  ['a semicolon after "as of" stays', 'As of 2025-11-10T10:00:00Z; 3 failing tests.', 'As of a set time; 3 failing tests.'],
  ['a label colon stays', 'Last seen: 2025-11-10T10:00:00Z.', 'Last seen: a set time.'],
  ['a bare range keeps both ends', 'Window: 2025-11-10T10:00:00Z to 2025-11-10T11:30:00.000+01:00', 'Window: a set time to a set time.'],
  ['a bare "and" pair keeps both ends', 'Seen 2025-11-10T10:00:00Z and 2025-11-10T11:30:00.000+01:00 in the log.', 'Seen a set time and a set time in the log.'],
  [
    'a list of timestamps keeps every end',
    'The dates are 2025-11-10T10:00:00Z, 2025-11-10T11:30:00.000+01:00 and 2025-11-10T10:00:00Z.',
    'The dates are a set time, a set time and a set time.',
  ],
  ['a lead before a range stays', 'As of 2025-11-10T10:00:00Z - 2025-11-10T11:30:00.000+01:00 the queue was empty.', 'As of a set time - a set time the queue was empty.'],
  ['a bracketed log timestamp is a set time', '[2025-11-10T10:00:00Z] ERROR build failed in 3s', '[A set time] ERROR build failed in 3s.'],
  ['separate sentences each keep their timestamp', 'Created 2025-11-10T10:00:00Z. Updated 2025-11-10T11:30:00.000+01:00.', 'Created a set time. Updated a set time.'],
  [
    'a timestamp bullet list loses only the bullets',
    'Deploy log:\n- 2025-11-10T10:00:00Z started\n- 2025-11-10T11:30:00.000+01:00 finished',
    'Deploy log: a set time started. A set time finished.',
  ],
  [
    'a log line after a sentence keeps its timestamp',
    'This is what the build is stuck on. 2025-11-10T10:00:00Z ERROR build failed.',
    'This is what the build is stuck on. A set time ERROR build failed.',
  ],
  ['a hash after a sentence end has no git word before it', 'Reverted. 3f2a9c1d8e0b failed.', 'Reverted. an ID failed.'],
  ['a dash pair around a timestamp phrase stays', 'All green - as of 2025-11-10T10:00:00Z - really.', 'All green - as of a set time - really.'],
  ['an em dash pair around a timestamp phrase stays', 'Summary — as of 2025-11-10T10:00:00Z — all green.', 'Summary — as of a set time — all green.'],
  ['a time-bearing verb keeps a time before a dash range', 'Expires 2025-11-10T10:00:00Z - renew by 2025-11-10T11:30:00.000+01:00.', 'Expires a set time - renew by a set time.'],
  ['"on" keeps its time', 'Do not deploy on 2025-11-10T10:00:00Z.', 'Do not deploy on a set time.'],
  [
    'two "at" times are both kept',
    'Tests failed at 2025-11-10T10:00:00Z but passed at 2025-11-11T11:30:00Z.',
    'Tests failed at a set time but passed at a set time.',
  ],
  [
    'a contrast keeps both times',
    'It broke at 2025-11-10T10:00:00Z, not at 2025-11-11T11:30:00Z.',
    'It broke at a set time, not at a set time.',
  ],
  ['"on ... only" keeps its time', 'Merging is blocked on 2025-11-10T10:00:00Z only.', 'Merging is blocked on a set time only.'],
  ['"until at least" keeps its time', 'The lock is held until at least 2025-11-10T10:00:00Z.', 'The lock is held until at least a set time.'],
  [
    'a list of "at" times keeps its colons',
    'Errors at 2025-11-10T10:00:00Z: 3, at 2025-11-11T11:30:00Z: 0.',
    'Errors at a set time: 3, at a set time: 0.',
  ],
  ['a sentence that opens with "At" keeps its time', 'Wait. At 2025-11-10T10:00:00Z the lock is released.', 'Wait. At a set time the lock is released.'],
  ['"on" at the start keeps its time', 'On 2025-11-10T10:00:00Z the lock was released.', 'On a set time the lock was released.'],
  ['"by" and "after" keep their time', 'Retry by 2025-11-10T10:00:00Z, not after 2025-11-11T11:30:00Z.', 'Retry by a set time, not after a set time.'],
  ['a bare timestamp inside a sentence is a set time', 'The build 2025-11-10T10:00:00Z failed.', 'The build a set time failed.'],
  ['a label is kept with a contrast: both times stay', 'Started at 2025-11-10T10:00:00Z, not at 2025-11-11T11:30:00Z.', 'Started at a set time, not at a set time.'],
  ['two labels in one sentence keep both times', 'Seen at 2025-11-10T10:00:00Z and updated on 2025-11-11T11:30:00Z.', 'Seen at a set time and updated on a set time.'],
  ['a negated label keeps its time', 'Not updated at 2025-11-10T10:00:00Z.', 'Not updated at a set time.'],
  ['a negated contraction keeps its time', "It wasn't updated at 2025-11-10T10:00:00Z.", "It wasn't updated at a set time."],
  ['two "dated" timestamps are both kept', 'A dated 2025-11-10T10:00:00Z vs b dated 2025-11-11T11:30:00Z.', 'A dated a set time vs b dated a set time.'],
  ['two "as of" timestamps are both kept', 'As of 2025-11-10T10:00:00Z it failed, as of 2025-11-11T11:30:00Z it passed.', 'As of a set time it failed, as of a set time it passed.'],
  ['"last run at" keeps its words', 'Last run at 2025-11-10T10:00:00Z by CI.', 'Last run at a set time by CI.'],
  ['a log line prefix is a set time', '2025-11-10T10:00:00Z ERROR build failed', 'A set time ERROR build failed.'],
  ['a log line prefix after a sentence is a set time', 'Done. 2025-11-10T10:00:00Z ERROR build failed.', 'Done. A set time ERROR build failed.'],
  ['a bracketed log level after a sentence keeps everything', 'Done. 2025-11-10T10:00:00Z [WARN] retrying', 'Done. A set time [WARN] retrying.'],
  [
    'a bare timestamp after a sentence end is a set time with a capital',
    'Wait. 2025-11-10T10:00:00Z the lock is released.',
    'Wait. A set time the lock is released.',
  ],
  [
    'a bare timestamp before an ordinary word after a sentence end is a set time',
    'Do not deploy. 2025-11-10T10:00:00Z maintenance starts.',
    'Do not deploy. A set time maintenance starts.',
  ],
  ['a bare timestamp before a contraction is a set time', "2025-11-10T10:00:00Z wasn't the last good build.", "A set time wasn't the last good build."],
  ['a bare timestamp before an article at the start is a set time', '2025-11-10T10:00:00Z the lock is released.', 'A set time the lock is released.'],
  ['a timestamp on a line of its own after a sentence is a set time', 'Wait.\n2025-11-10T10:00:00Z started deploy', 'Wait. A set time started deploy.'],
  ['a label value with a colon and a trailing word', 'Last seen: 2025-11-10T10:00:00Z by Bob.', 'Last seen: a set time by Bob.'],
  ['a label value with a colon at the end of the text', 'Updated: 2025-11-10T10:00:00Z', 'Updated: a set time.'],
  ['a prefix that is part of the sentence is a set time with a capital', '2025-11-10T10:00:00Z was the last good build.', 'A set time was the last good build.'],
  ['a prefix with a comma is a set time', '2025-11-10T10:00:00Z, it failed', 'A set time, it failed.'],
  ['a prefix before a preposition is a set time', '2025-11-10T10:00:00Z at the gate', 'A set time at the gate.'],
  ['a text that is only a timestamp is a set time', '2025-11-10T10:00:00Z', 'A set time.'],
  ['a timestamp on its own in parentheses keeps its brackets', 'Build (2025-11-10T10:00:00Z) failed.', 'Build (a set time) failed.'],
  ['"at" inside parentheses stays', 'Build (at 2025-11-10T10:00:00Z) failed.', 'Build (at a set time) failed.'],
  [
    'a semicolon keeps both clauses whole',
    'Edited a.ts as of 2025-11-10T10:00:00Z; do not merge until 2025-11-11T11:30:00Z.',
    'Edited a.ts as of a set time; do not merge until a set time.',
  ],
  [
    'a comma keeps a contrast whole',
    'Green as of 2025-11-10T10:00:00Z, red as of 2025-11-11T11:30:00Z.',
    'Green as of a set time, red as of a set time.',
  ],
  ['a parenthesised timestamp after "on" keeps its lead', 'Do not deploy on (2025-11-10T10:00:00Z) again.', 'Do not deploy on (a set time) again.'],
  ['a parenthesised timestamp after a label keeps its brackets', 'Updated (2025-11-10T10:00:00Z) fine.', 'Updated (a set time) fine.'],
  [
    'a wrapped line does not change the timestamp',
    'Do not merge until\n2025-11-10T10:00:00Z because CI is red.',
    'Do not merge until a set time because CI is red.',
  ],
  ['a timestamp after a blank line is a set time', 'Deploys:\n\n2025-11-10T10:00:00Z started', 'Deploys: a set time started.'],
  ['"A set time" at the start is left alone', 'A set time was fine. Then a set time failed.', 'A set time was fine. Then a set time failed.'],

  // What is left of a redacted long path: "a redacted path", nothing else. A bare placeholder is "redacted".
  ['a redacted path with a test extension', 'Tests keep failing in /[redacted].test.ts', 'Tests keep failing in a redacted path.'],
  ['a redacted path with a dash name', 'Open /[redacted]-routes.ts now.', 'Open a redacted path now.'],
  ['a redacted directory before a file', 'Open [redacted]/foo.ts now.', 'Open a redacted path now.'],
  ['a redacted route', 'Open /[redacted] now.', 'Open a redacted path now.'],
  ['a redacted path cut before an underscore name', 'Open /[redacted]use_speak_agent.ts now.', 'Open a redacted path now.'],
  ['a redacted path keeps the punctuation around it', 'See (/[redacted].ts), then stop.', 'See (a redacted path), then stop.'],
  ['a redacted path at the end of a sentence', 'It failed in /[redacted].test.ts.', 'It failed in a redacted path.'],
  ['a bullet before a redacted path is still a bullet', 'Updated:\n- /[redacted].ts\n- [redacted]/foo.ts', 'Updated: a redacted path. a redacted path.'],
  ['a bare placeholder is redacted', 'Seen [redacted] now.', 'Seen redacted now.'],
  ['a quoted placeholder is redacted', 'Seen "[redacted]" now.', 'Seen "redacted" now.'],
  ['a placeholder after = is not a path', 'Set key=[redacted] now.', 'Set key=[redacted] now.'],
  ['a placeholder after a dash is not a path', 'Set token-[redacted] now.', 'Set token-[redacted] now.'],
  ['a placeholder glued to an unknown extension is left as written', 'Saw [redacted].Then continue.', 'Saw [redacted].Then continue.'],

  // Paths: an unanchored token is shortened only when it is clearly a location.
  ['keeps d3.js/three.js', 'Compare d3.js/three.js now.', 'Compare d3.js/three.js now.'],
  ['keeps express.js/koa.js', 'Compare express.js/koa.js now.', 'Compare express.js/koa.js now.'],
  ['keeps react/next.js', 'Migrated react/next.js today.', 'Migrated react/next.js today.'],
  ['keeps npm/node.js', 'Updated npm/node.js today.', 'Updated npm/node.js today.'],
  ['keeps before/after.png', 'Attached before/after.png today.', 'Attached before/after.png today.'],
  ['keeps old/new.json', 'Diffed old/new.json today.', 'Diffed old/new.json today.'],
  ['keeps a three-segment path with a library directory', 'See three.js/lib/x.ts now.', 'See three.js/lib/x.ts now.'],
  ['shortens src/index.js', 'Edited src/index.js today.', 'Edited src index.js today.'],
  ['shortens docs/README.md', 'Read docs/README.md first.', 'Read README.md first.'],
  ['shortens a/b/c.json', 'Read a/b/c.json now.', 'Read c.json now.'],
  ['shortens packages/core/src/x.ts', 'Edited packages/core/src/x.ts now.', 'Edited x.ts now.'],
  ['shortens a dot-directory path', 'Edited .github/workflows/ci.yml now.', 'Edited ci.yml now.'],
  ['shortens an npm scope path', 'Read @scope/pkg/index.ts now.', 'Read pkg index.ts now.'],
  ['shortens a hyphenated first directory', 'Open my-pkg/x.ts now.', 'Open x.ts now.'],
  ['shortens a first directory with an underscore', 'Open my_pkg/x.py now.', 'Open x.py now.'],
  ['shortens a CamelCase component under a common directory', 'Edited src/components/Avatar.tsx now.', 'Edited Avatar.tsx now.'],
  ['shortens a CamelCase file in a deep path', 'Edited three/examples/jsm/loaders/GLTFLoader.js now.', 'Edited GLTFLoader.js now.'],
  ['keeps a CamelCase product name in a pair', 'Moved Node.js/Express.js to a monorepo.', 'Moved Node.js/Express.js to a monorepo.'],
  ['keeps word pairs whose first word is a plain directory-like noun', 'See model/view.png and data/model.json and out/in.txt.', 'See model/view.png and data/model.json and out/in.txt.'],
  ['keeps home/work.md and release/debug.json', 'Moved home/work.md and release/debug.json today.', 'Moved home/work.md and release/debug.json today.'],
  ['keeps a CamelCase product name after a common directory', 'Moved frontend/Next.js, server/Node.js and backend/Express.js.', 'Moved frontend/Next.js, server/Node.js and backend/Express.js.'],
  ['shortens a CamelCase file with a line number', 'See src/Avatar.tsx:12 now.', 'See Avatar.tsx now.'],
  ['shortens a path with a line range', 'Looked at src/core/foo.ts:42-50 now.', 'Looked at foo.ts now.'],
  ['shortens a path with a GitHub line anchor', 'Looked at src/core/foo.ts#L42 and src/core/bar.ts#L10-L20.', 'Looked at foo.ts and bar.ts.'],
  ['a bullet before an absolute path is still a bullet', 'Updated:\n- /home/jean/git/kookr/src/a.ts\n- ./b.ts\n- ~/c.md', 'Updated: a.ts. b.ts. c.md.'],
  ['a bullet before a dotfile is still a bullet', '- .env handling\n- .gitignore entries', '.env handling. .gitignore entries.'],
  ['a bullet before a pull request number is still a bullet', 'Merged:\n- #12 fixed the cache\n- #13 renamed things', 'Merged: number 12 fixed the cache. number 13 renamed things.'],
  ['a bullet before the redaction placeholder is still a bullet', 'Seen:\n- [redacted]\n- [redacted]', 'Seen: redacted. redacted.'],
  ['a shell redirect before a path keeps its angle bracket', 'pnpm test \\\n  > /tmp/out.log', 'pnpm test \\ > out.log.'],
  ['keeps a minus before a slash-led number', 'Result: /5 of 10 passed', 'Result: /5 of 10 passed.'],

  // Markdown tables: only a pipe-line run with a separator row is a table.
  [
    'table rows become comma-separated sentences',
    '## Summary\n- Fixed the login bug in session.ts\n- Added 3 tests\n| Check | Result |\n|---|---|\n| lint | ✅ |',
    'Summary. Fixed the login bug in session.ts. Added 3 tests. Check, Result. lint, ✅.',
  ],
  ['table with alignment markers and several rows', '| Name | Count |\n|:---|---:|\n| a | 3 |\n| b | 4 |', 'Name, Count. a, 3. b, 4.'],
  ['an empty table cell is blank, not dropped', '| a |  | c |\n|---|---|---|\n| 1 |  | 3 |', 'a, blank, c. 1, blank, 3.'],
  ['table after an intro line', 'Results:\n| Check | Result |\n| --- | --- |\n| lint | ok |', 'Results: Check, Result. lint, ok.'],
  ['an escaped pipe stays inside its cell', '| a | b |\n|---|---|\n| 1 \\| 2 | 3 |', 'a, b. 1 | 2, 3.'],
  ['table cells lose their emphasis and code marks', '| **Check** | `Result` |\n|---|---|\n| _lint_ | ok |', 'Check, Result. lint, ok.'],
  ['a table inside a code fence is still a table', 'Ran:\n```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\ndone', 'Ran: a, b. 1, 2. done.'],
  ['a table with no edge pipes is left as written', 'Tests | Result\n--- | ---\nlint | ok', 'Tests | Result --- | --- lint | ok.'],
  ['pipes around prose are not a table', '|x| + |y|', '|x| + |y|.'],
  ['a lone double pipe line stays', '||', '||.'],
  ['a lone empty-cell line stays', '| |', '| |.'],
  ['a pipe line without a separator row stays', '| a | b |', '| a | b |.'],
  ['two pipe lines without a separator row stay', '| a | b |\n| c | d |', '| a | b | | c | d |.'],
  ['a pipe-or in prose stays', 'Use x || y, not a | b.', 'Use x || y, not a | b.'],

  // An identifier is NEVER dropped (review round 6): dropping it changes a negated, "only" or "except" sentence.
  ['a negated agent id keeps the word agent', 'No agent 123e4567-e89b-12d3-a456-426614174000 is running.', 'No agent ID is running.'],
  ['a missing commit keeps the word commit', 'There is no commit 3f2a9c1d on the release branch.', 'There is no commit ID on the release branch.'],
  ['an exception keeps its id', 'Every task except 123e4567-e89b-12d3-a456-426614174000 passed.', 'Every task except an ID passed.'],
  ['a missing request id keeps both words', 'No request id 3f2a9c1d4e5b6a7 in the logs.', 'No request id ID in the logs.'],
  [
    'two ids in one sentence both stay',
    'Kill 123e4567-e89b-12d3-a456-426614174000 but keep 123e4567-e89b-12d3-a456-426614174000.',
    'Kill an ID but keep an ID.',
  ],
  ['a commit that main lacks keeps the word commit', 'Main does not contain commit 3f2a9c1.', 'Main does not contain commit ID.'],
  ['a labelled hash after a colon keeps the label', 'Commit: 3f2a9c1 is not on main.', 'Commit: ID is not on main.'],
  ['a long hex id after "only" is an ID', 'Delete only 3f2a9c1d8e0b.', 'Delete only an ID.'],
  ['a uuid at the start of a negated sentence is an ID', '123e4567-e89b-12d3-a456-426614174000 is not running.', 'an ID is not running.'],
  ['a hash after a git verb is still a commit', 'Never revert 3f2a9c1 on main.', 'Never revert a commit on main.'],
  ['a short hex word after a plain label is left as written', 'No task deadbeef12 ran.', 'No task deadbeef12 ran.'],

  // Numbered and quote markers are never stripped; bullets and headings only after a sentence end, a blank line or another marker.
  ['a wrapped limit keeps its number', 'I will keep at most\n2. Older backups get deleted.', 'I will keep at most 2. Older backups get deleted.'],
  [
    'a wrapped comparison keeps its angle bracket',
    'Fail the job if the error count\n> limit. Otherwise continue.',
    'Fail the job if the error count > limit. Otherwise continue.',
  ],
  ['a wrapped number before a heading mark keeps both', '3\n## Results', '3 ## Results.'],
  ['a wrapped number before a bullet keeps both', '42\n- tests failed', '42 - tests failed.'],
  ['a task named with a number keeps it', '12. working.', '12. working.'],
  ['a quote mark before a timestamp is not lost', '> 2025-11-10T10:00:00Z started', '> a set time started.'],
  ['a quote mark before an id is not lost', '> 123e4567-e89b-12d3-a456-426614174000 failed', '> an ID failed.'],
  ['a bullet after a sentence end is stripped', 'Done.\n- tests failed', 'Done. tests failed.'],
  ['a heading after a blank line is stripped', 'Done\n\n## Results\nall green', 'Done. Results. all green.'],
  ['a heading after a heading is stripped', '## A\n## B', 'A. B.'],
  ['a bullet after a lead-in semicolon is stripped', 'Steps;\n- first', 'Steps. first.'],
  ['a first line that is only a marker joins the next one and is stripped in the same pass', '-\nfixed it', 'fixed it.'],
  ['stacked bare markers on the first line', '- -\nx', 'x.'],
  ['a bare heading mark on the first line', '#\nResults', 'Results.'],
  ['a code span that holds a bullet at a line start is a bullet', '`- x` foo', 'x foo.'],
  ['a bullet before a hex id with no letter first stays a dash', 'Failed:\n- 3f2a9c1d8e0b passed.', 'Failed: - an ID passed.'],
  ['a bullet before a uuid is stripped', 'Failed:\n- 123e4567-e89b-12d3-a456-426614174000 passed.', 'Failed: an ID passed.'],

  // Tables: an empty cell is spoken, not dropped.
  ['an empty table cell is blank', '| suite | passed | failed |\n|---|---|---|\n| e2e | | 3 |', 'suite, passed, failed. e2e, blank, 3.'],
  ['an all-empty table row is blank cells', '| a | b |\n|---|---|\n| | |', 'a, b. blank, blank.'],

  // Links and images: the text stays; with no text they are named, never vanish.
  ['an image with no alt text is an image', 'Do not use ![](https://x.io/y.png) here.', 'Do not use an image here.'],
  ['a link with no text is a link', 'See [](https://x.io) now.', 'See a link now.'],
  ['a link whose text is blank is a link', 'See [ ](https://x.io) now.', 'See a link now.'],
  ['a call after an index is code, not a link, and keeps its argument', 'Do not call handlers[0](event).', 'Do not call handlers[0](event).'],
  ['an exclamation glued to a bracket is prose, not an image', 'Stop![x](u)', 'Stop![x](u).'],
  ['a link right after a link is still a link', 'See ([a](u) [b](v)).', 'See (a b).'],
  ['a link with a title is left as written, because the title is words', 'Open [docs](https://x.io/a "Docs home") now', 'Open [docs](https://x.io/a "Docs home") now.'],
  ['a link inside link text resolves in one pass', 'See [[a](u)](v) now', 'See a now.'],
  ['an image inside an image alt resolves in one pass', 'See ![![a](u)](v) now', 'See a now.'],
  ['a code fence info string needs a letter, so a number line is text', '```42', '```42.'],
  ['a code fence with a language tag is dropped', 'x\n```ts\ncode\n```', 'x. code.'],

  // The file name left by a path is finished in the same pass.
  ['a path that ends in a snake_case name is spoken as words', 'Open /a/b/needs_input now.', 'Open needs input now.'],
  ['a path that ends in a hex id is an ID', 'Open /a/b/3f2a9c1d8e0b now.', 'Open an ID now.'],
  ['a path with no letter or digit in its last segment is left alone', 'Open /a/- now.', 'Open /a/- now.'],

  // Nested markup settles in one pass.
  ['nested emphasis', 'A **bold *and italic* text** and *(*x*)*', 'A bold and italic text and (x).'],
  ['nested code spans of different widths', 'a ``b `c` d`` e', 'a b c d e.'],
  ['mixed star and underscore markers around one word', 'say *_x_* now', 'say x now.'],
  ['nested placeholder brackets', 'Key [[[redacted]]] leaked', 'Key redacted leaked.'],
  ['an unbalanced placeholder bracket keeps its extra bracket', 'Key [[redacted] leaked', 'Key [redacted leaked.'],

  // Code is literal, and a span the token rewrite will turn into words is not a "symbol only" span.
  ['a star inside a kept code span closes no emphasis', '*a ` ->* `', '*a ` ->* `.'],
  ['a code span around a spaced arrow is spoken as the word', 'Go from a ` -> ` b now', 'Go from a to b now.'],
  ['a code span around an arrow that wraps over lines settles in the same way', 'x `\n->\n` y', 'x to y.'],
  ['a code span around a glued arrow keeps its backticks', 'Use `->` and `&` here', 'Use `->` and `&` here.'],
  ['a link destination with a space in it is left as written', '[a](see (this) note) and [b](u_(x))', '[a](see (this) note) and b.'],
  ['a marker that only becomes strippable once the token is rewritten is stripped in the same pass', '- @scope/pkg/x.ts and more', 'x.ts and more.'],
  ['a dash before a hex id that becomes "an ID" is stripped in the same pass', '- 3f2a9c1d8e0b failed', 'an ID failed.'],
  ['a marker followed by a no-break space is a marker', '-\u00a0fixed it', 'fixed it.'],
  ['a marker followed by a no-break space is a marker on a later line too', 'Done.\n-\u00a0fixed it', 'Done. fixed it.'],
  ['a bullet whose text wraps ends the run, so the next bullet stays', '- a long\n  item\n- b', 'a long. item - b.'],
  ['a list of short hashes after a colon keeps its dashes', 'Commits:\n- 3f2a9c1\n- abc1234', 'Commits: - 3f2a9c1 - abc1234.'],
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
  // Word and library pairs that look like paths but are prose.
  pair: [
    'd3.js/three.js', 'express.js/koa.js', 'react/next.js', 'npm/node.js', 'before/after.png', 'old/new.json',
    'input/output.csv', 'read/write.sh', 'three.js/lib/x.ts', 'owner/repo.git', 'model/view.png', 'data/model.json',
    'home/work.md', 'out/in.txt', 'release/debug.json', 'frontend/Next.js', 'server/Node.js', 'backend/Express.js',
  ],
  pipe: ['|x|', 'a | b', 'x || y', '|x| + |y|', '||', '| |', '| a | b |'],
  word: ['the build', 'tests', 'the parser', 'CI', 'the deploy', 'auth', 'the cache', 'the migration', 'the agent', 'a worker'],
};
type PlainKind = keyof typeof PLAIN;

/** The intended rewrites, and the only places where the spoken text may differ from the raw text. */
const REWRITES = {
  path: [
    ['src/core/foo.ts', 'foo.ts'], ['lib/util.js', 'util.js'], ['~/notes/todo.md', 'todo.md'], ['./x/y.sh', 'y.sh'],
    ['/home/jean/git/kookr/', 'kookr'], ['C:\\Users\\jean\\main.rs', 'main.rs'], ['src/.eslintrc.json', '.eslintrc.json'],
    ['a/b.json:12', 'b.json'], ['~/.bashrc', '.bashrc'], ['docs/README.md', 'README.md'], ['src/core/index.ts', 'core index.ts'],
    ['src/pkg/__init__.py', '__init__.py'], ['src/components/Avatar.tsx', 'Avatar.tsx'], ['tests/unit/cache.json', 'cache.json'],
    ['src/core/foo.ts:42-50', 'foo.ts'], ['src/core/foo.ts#L42', 'foo.ts'], ['@scope/pkg/lib/x.ts', 'x.ts'],
    ['my-pkg/x.ts', 'x.ts'],
  ],
  url: [
    ['https://example.com/a/b', 'a link'], ['https://github.com/o/r/pull/12', 'pull request 12'],
    ['https://github.com/o/r/issues/7', 'issue 7'], ['www.example.com', 'a link'],
    ['https://example.com/search?q=a&b=c#frag', 'a link'],
  ],
  // A long hex token with no git word beside it is only an ID; the same token after a git word is a commit.
  hash: [['3f2a9c1d8e0b', 'an ID'], ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'an ID'], ['507f1f77bcf86cd799439011', 'an ID']],
  uuid: [['for 123e4567-e89b-12d3-a456-426614174000', 'for an ID'], ['by 123e4567-e89b-12d3-a456-426614174000', 'by an ID']],
  // A timestamp is "a set time" after any lead word (or none); the lead word stays.
  time: [
    ['at 2025-11-10T10:00:00Z', 'at a set time'], ['on 2025-11-10T10:00:00Z', 'on a set time'],
    ['until 2025-11-10T10:00:00Z', 'until a set time'], ['since 2025-11-10T10:00:00Z', 'since a set time'],
    ['before 2025-11-10T10:00:00Z', 'before a set time'], ['after 2025-11-10T10:00:00Z', 'after a set time'],
    ['by 2025-11-10T10:00:00Z', 'by a set time'], ['to 2025-11-10T10:00:00Z', 'to a set time'],
    ['of 2025-11-10T10:00:00Z', 'of a set time'], ['until at least 2025-11-10T10:00:00Z', 'until at least a set time'],
    ['expires at 2025-11-10T10:00:00Z', 'expires at a set time'],
    ['from 2025-11-10T10:00:00Z to 2025-11-10T11:00:00Z', 'from a set time to a set time'],
    ['between 2025-11-10T10:00:00Z and 2025-11-10T11:00:00Z', 'between a set time and a set time'],
    ['(since 2025-11-10T10:00:00Z)', '(since a set time)'],
  ],
  // The leads and labels that used to be dropped with the timestamp: now every one of them stays.
  timeLabel: [
    ['status as of 2025-11-10T10:00:00Z', 'status as of a set time'], ['report dated 2025-11-10T10:00:00Z', 'report dated a set time'],
    ['log timestamped 2025-11-10T10:00:00Z', 'log timestamped a set time'], ['deploy @ 2025-11-10T10:00:00Z', 'deploy @ a set time'],
    ['updated at 2025-11-10T10:00:00Z', 'updated at a set time'], ['created on 2025-11-10T10:00:00Z', 'created on a set time'],
    ['updated: 2025-11-10T10:00:00Z', 'updated: a set time'],
    ['modified on 2025-11-10T10:00:00Z', 'modified on a set time'], ['seen 2025-11-10T10:00:00Z', 'seen a set time'],
    ['last run at 2025-11-10T10:00:00Z', 'last run at a set time'], ['build (2025-11-10T10:00:00Z)', 'build (a set time)'],
    ['check [2025-11-10T10:00:00Z]', 'check [a set time]'], ['last seen: 2025-11-10T10:00:00Z', 'last seen: a set time'],
  ],
  // Two timestamps in one sentence: each becomes "a set time" and the contrast around them stays.
  timeContrast: [
    ['seen at 2025-11-10T10:00:00Z and updated on 2025-11-11T11:30:00Z', 'seen at a set time and updated on a set time'],
    ['created on 2025-11-10T10:00:00Z, not updated on 2025-11-11T11:30:00Z', 'created on a set time, not updated on a set time'],
    ['as of 2025-11-10T10:00:00Z and dated 2025-11-11T11:30:00Z', 'as of a set time and dated a set time'],
    ['not updated at 2025-11-10T10:00:00Z', 'not updated at a set time'],
    ['never logged at 2025-11-10T10:00:00Z', 'never logged at a set time'],
    ['only files modified on 2025-11-10T10:00:00Z', 'only files modified on a set time'],
    ['nothing changed at 2025-11-10T10:00:00Z, without 2025-11-11T11:30:00Z', 'nothing changed at a set time, without a set time'],
  ],
  // What is left of a redacted long path.
  redactedPath: [
    ['/[redacted].test.ts', 'a redacted path'], ['/[redacted]-routes.ts', 'a redacted path'],
    ['[redacted]/foo.ts', 'a redacted path'], ['/[redacted]', 'a redacted path'],
    ['/[redacted]use_speak_agent.ts', 'a redacted path'],
  ],
  digest: [
    ['sha256:a1b2c3d4e5f60718293a4b5c6d7e8f9012345678a1b2c3d4e5f60718293a4b5c', 'an ID'],
    ['md5:a1b2c3d4e5f60718293a4b5c6d7e8f90', 'an ID'],
  ],
  snake: [
    ['max_retry_count', 'max retry count'], ['needs_input', 'needs input'], ['MAX_RETRIES', 'max retries'],
    ['tmux_unresponsive', 'backend unreachable'], ['hook_parse_degraded', 'hook parse degraded'],
  ],
  pr: [['#12', 'number 12'], ['#3608', 'number 3608']],
  placeholder: [['[redacted]', 'redacted'], ['[REDACTED]', 'REDACTED']],
  gitword: [
    ['on 3f2a9c1', 'on a commit'], ['onto abc1234', 'onto a commit'], ['at 3f2a9c1d8e', 'at a commit'],
    ['reverted abc1234', 'reverted a commit'], ['reverted 3f2a9c1d8e0b', 'reverted a commit'],
  ],
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
  (p) => ['Got ', p.rw('hash'), ' on ', p.plain('ref'), '.'],
  (p) => ['Retry ', p.rw('uuid'), ' failed ', p.rw('time'), '.'],
  (p) => ['Results', { raw: '\n| Check | Result |\n|---|---|\n| lint | ok |', spoken: '. Check, Result. lint, ok' }, { raw: '\nAll done', spoken: '. All done' }, '.'],
  (p) => ['Compared ', p.plain('pair'), ' and ', p.plain('pair'), ' today.'],
  (p) => ['Seen ', p.plain('pipe'), ' in prose.'],
  (p) => ['Pinned ', p.rw('digest'), ' for ', p.plain('word'), '.'],
  (p) => ['Waiting ', p.rw('time'), ' on ', p.plain('word'), ' now.'],
  (p) => ['Edited ', p.rw('path'), ' while ', p.plain('pair'), ' stayed put.'],
  (p) => ['The agent is in ', p.rw('snake'), ' state, not ', p.rw('snake'), '.'],
  (p) => ['Opened ', p.rw('pr'), ', ', p.rw('pr'), ' and ', p.rw('pr'), ' today.'],
  (p) => ['Lint ', p.rw('amp'), ' test ', p.rw('amp'), ' build pass.'],
  (p) => ['Moved ', p.plain('ref'), ' ', p.rw('arrow'), ' ', p.plain('ref'), ' safely.'],
  (p) => ['Fixed ', p.plain('word'), gap(','), ' then ', p.plain('word'), ' ok', gap('.')],
  (p) => ['Is ', p.plain('word'), ' done', gap('?')],
  (p) => ['Retry ', p.plain('word'), wrap, 'on ', p.plain('ref'), wrap, 'and ', p.plain('number'), ' more.'],
  // A list is stripped after a lead-in that ends in a colon; after a line that stops mid-sentence it is that
  // sentence wrapping onto a dash, and every dash stays.
  (p) => ['Changes made:', { raw: '\n- ', spoken: ' ' }, 'fixed ', p.plain('file'), item('- '), 'added ', p.plain('word'), '.'],
  (p) => ['Changes made', { raw: '\n- ', spoken: ' - ' }, 'fixed ', p.plain('file'), { raw: '\n- ', spoken: ' - ' }, 'added ', p.plain('word'), '.'],
  (p) => [marker('## '), 'Summary', item(''), 'All good with ', p.plain('file'), '.'],
  // Numbers and quote marks are never markers: a wrapped number or comparison is part of the sentence.
  (p) => ['1. Run ', p.plain('flag'), wrap, '2. Check ', p.plain('ref')],
  (p) => ['> Quoted ', p.plain('word'), ' here.'],
  (p) => ['At most', wrap, '2. Older ', p.plain('word'), ' get deleted.'],
  (p) => ['Fail if the count', wrap, '> ', p.plain('number'), '. Otherwise go on.'],
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
  (p) => ['Tests failed ', p.rw('time'), ' but passed ', p.rw('time'), '.'],
  (p) => ['It broke ', p.rw('time'), ', not ', p.rw('time'), '.'],
  (p) => ['Errors ', p.rw('time'), ': 3, ', p.rw('time'), ': 0.'],
  (p) => ['Do not deploy ', p.rw('time'), ' only.'],
  (p) => [p.rw('time'), ' the lock was held.'],
  (p) => ['The ', p.rw('timeLabel'), ' is old.'],
  (p) => ['Logs ', p.rw('timeContrast'), ' differ.'],
  (p) => ['Note: ok.', { raw: ' As of 2025-11-10T10:00:00Z the build is green', spoken: ' As of a set time the build is green' }, '.'],
  (p) => ['Opened ', p.rw('redactedPath'), ' and ', p.rw('redactedPath'), ' today.'],
  (p) => ['Edited ', p.rw('redactedPath'), ', then ', p.plain('file'), '.'],
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

// --- identifier oracle begin ---
// A second forward-built oracle, for the rule "an identifier is never dropped". Every identifier
// (UUID, long hex id, short hash, #123, path, URL, timestamp) is placed in EVERY position: first in
// the text, first after a sentence end, in the middle, last, inside brackets or quotes, after a
// bullet, and after a line break; and next to every kind of word that can come before it: a label
// (agent, task, commit, ...), a git verb (at, on, revert), a determiner, a negation (not, never,
// except, only, no, without, ...) or any other word. The oracle states the ALLOWED spoken form for
// each pair of (identifier kind, word before it), and findWordLoss compares word for word, so a
// dropped identifier is a missing word. A separate check requires that the count of content words
// (tokens with a letter or a digit) never goes down.
const ID_BEFORE = {
  filler: ['deploy', 'backup', 'files', 'tests', 'server', 'lock', 'queue', 'ran', 'failed', 'passed', 'was', 'is', 'had', 'yet', 'it', 'we', 'Ana', 'CI', 'delete', 'merge', 'green', 'stuck', 'fine', 'then', 'again', 'kept'],
  negation: ['not', 'never', 'without', 'except', 'only', 'no', 'nothing', 'neither', 'nor', 'unless', 'but', 'instead', 'cannot', 'than', 'and', 'or', 'for', 'by', 'from', 'to', 'with', 'vs'],
  labelId: ['agent', 'task', 'session', 'request', 'job', 'run', 'build', 'container', 'trace', 'id', 'uuid'],
  labelGit: ['commit', 'sha', 'hash', 'rev', 'revision'],
  verbGit: ['at', 'on', 'onto', 'revert'],
  determiner: ['the', 'this', 'that', 'its', 'their'],
};
type IdBefore = keyof typeof ID_BEFORE;
/** What stands before an identifier: a word of one of the kinds above, nothing (a text or sentence start), or a dash that stayed. */
type IdContext = IdBefore | 'start' | 'dash';
const ID_BEFORE_KINDS = Object.keys(ID_BEFORE) as IdBefore[];
/** After these the id is just "ID": the word stays, and "an ID" would stutter. */
const isLabelled = (context: IdContext): boolean => context === 'labelId' || context === 'labelGit' || context === 'determiner';

interface IdKind {
  name: string;
  samples: readonly string[];
  say(sample: string, context: IdContext, capital: boolean): string;
}
const spokenByRaw = (pairs: readonly Pair[]): Map<string, string> => new Map(pairs.map(([raw, spoken]) => [raw, spoken]));
const PATH_SPOKEN = spokenByRaw(REWRITES.path);
const URL_SPOKEN = spokenByRaw(REWRITES.url);
const ID_KINDS: readonly IdKind[] = [
  {
    name: 'uuid',
    samples: ['123e4567-e89b-12d3-a456-426614174000', 'F47AC10B-58CC-4372-A567-0E02B2C3D479', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
    say: (_sample, context) => (isLabelled(context) ? 'ID' : 'an ID'),
  },
  {
    name: 'long hex id',
    samples: ['3f2a9c1d8e0b', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', '507f1f77bcf86cd799439011', '3f2a9c1d4e5b6a7', 'deadbeef1234567890ab'],
    say: (_sample, context) => {
      if (context === 'verbGit') return 'a commit';
      return isLabelled(context) ? 'ID' : 'an ID';
    },
  },
  {
    // 7 to 11 hex characters are trusted only after a git word: anywhere else the word is left as written.
    name: 'short hash',
    samples: ['3f2a9c1', 'abc1234', '3f2a9c1d', 'f00dcafe1', '1a2b3c4d5e'],
    say: (sample, context) => {
      if (context === 'labelGit') return 'ID';
      return context === 'verbGit' ? 'a commit' : sample;
    },
  },
  { name: 'pull request number', samples: ['#123', '#7', '#3605'], say: (sample) => `number ${sample.slice(1)}` },
  { name: 'path', samples: [...PATH_SPOKEN.keys()], say: (sample) => PATH_SPOKEN.get(sample) as string },
  { name: 'url', samples: [...URL_SPOKEN.keys()], say: (sample) => URL_SPOKEN.get(sample) as string },
  {
    name: 'timestamp',
    samples: ['2025-11-10T10:00:00Z', '2025-11-11T11:30:00.000+01:00', '2026-01-02T03:04:05.678-0530', '2025-03-04T10:20:30'],
    say: (_sample, _context, capital) => (capital ? 'A set time' : 'a set time'),
  },
];
/** A sample that a bullet is stripped in front of: it starts with a letter, a UUID, #N, a path start or a timestamp. */
const bulletStrippable = (sample: string): boolean => /^(?:[A-Za-z]|[0-9a-fA-F]{8}-|#\d|[/~.]|\d{4}-\d{2}-\d{2}T)/.test(sample);

interface IdSentence {
  raw: string;
  spoken: string;
  /** The positions this sentence put an identifier in, for the coverage floor. */
  positions: Set<string>;
  kinds: Set<string>;
}

const capitalised = (word: string): string => word[0].toUpperCase() + word.slice(1);
const ID_BRACKETS: ReadonlyArray<readonly [string, string]> = [['', ''], ['', ''], ['', ''], ['', ''], ['(', ')'], ['[', ']'], ['"', '"'], ['<', '>']];
const ID_PLAIN_MARKS = ['', '', '', '', ',', ':', ';', '.', '!', '?'];
const ID_LAST_MARKS = ['', '', '.', '!', '?'];
const ID_TAILS = ['passed.', 'was not running.', 'never ran.', 'is gone.', 'failed.', 'is only a draft.'];
const SENTENCE_END_MARK = /[.!?]$/;

function generateIdSentence(random: () => number): IdSentence {
  const choose = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const positions = new Set<string>();
  const kinds = new Set<string>();

  const pickIdentifier = (context: IdContext, capital: boolean, bullet: boolean): { sample: string; spoken: string } => {
    const kind = choose(ID_KINDS);
    kinds.add(kind.name);
    const sample = choose(bullet ? kind.samples.filter(bulletStrippable) : kind.samples);
    return { sample, spoken: kind.say(sample, context, capital) };
  };

  if (random() < 0.3) {
    // A list: a lead-in line, then one to three bullets, each starting with an identifier.
    const leadCategory = choose<IdBefore>(['filler', 'filler', 'labelId', 'labelGit']);
    const leadMark = choose([':', ':', ':', '.', '']);
    let raw = `${capitalised(choose(ID_BEFORE.filler))} ${choose(ID_BEFORE[leadCategory])}${leadMark}`;
    let spoken = raw;
    const items = 1 + Math.floor(random() * 3);
    for (let item = 0; item < items; item += 1) {
      // The first bullet sees the lead-in's last word (after a colon), a sentence start (after a period), or the dash
      // that stays (no mark: its line follows a line that stops mid-sentence). Every later bullet follows a line that
      // ends in a period, so it is stripped and sees a sentence start.
      let context: IdContext = 'start';
      let dashStays = false;
      if (item === 0) {
        if (leadMark === ':') context = leadCategory;
        else if (leadMark === '') { context = 'dash'; dashStays = true; }
      }
      const id = pickIdentifier(context, context === 'start', true);
      const tail = choose(ID_TAILS);
      raw += `\n- ${id.sample} ${tail}`;
      spoken += `${dashStays ? ' - ' : ' '}${id.spoken} ${tail}`;
      positions.add(dashStays ? 'bullet kept' : 'bullet stripped');
      if (context === 'start') positions.add('after sentence end');
    }
    return { raw, spoken, positions, kinds };
  }

  let raw = '';
  let spoken = '';
  // True at the start of the text and right after a unit that ends a sentence.
  let atBoundary = true;
  let atTextStart = true;
  const append = (rawPiece: string, spokenPiece: string, separator: string): void => {
    raw += (raw === '' ? '' : separator) + rawPiece;
    spoken += (spoken === '' ? '' : ' ') + spokenPiece;
  };
  const unitCount = 3 + Math.floor(random() * 7);
  for (let unit = 0; unit < unitCount; unit += 1) {
    const last = unit === unitCount - 1;
    const separator = random() < 0.15 ? '\n' : ' ';
    if (random() < 0.45) {
      const mark = choose(last ? ID_LAST_MARKS : ID_PLAIN_MARKS);
      const [open, close] = choose(ID_BRACKETS);
      // Without a word right before it an identifier is only possible where there is no "word before": a text or sentence start.
      const withWord = !atBoundary || random() < 0.4;
      if (withWord) {
        const category = choose(ID_BEFORE_KINDS);
        const word = random() < 0.15 ? capitalised(choose(ID_BEFORE[category])) : choose(ID_BEFORE[category]);
        const id = pickIdentifier(category, false, false);
        const bracketOnWord = open !== '' && random() < 0.5;
        const wrapped = random() < 0.25;
        append(`${bracketOnWord ? open : ''}${word}`, `${bracketOnWord ? open : ''}${word}`, separator);
        const inner = bracketOnWord ? '' : open;
        append(`${inner}${id.sample}${close}${mark}`, `${inner}${id.spoken}${close}${mark}`, wrapped ? '\n' : ' ');
        positions.add(last ? 'end' : 'middle');
        if (wrapped) positions.add('wrapped');
        if (category === 'negation') positions.add('negated');
      } else {
        const id = pickIdentifier('start', true, false);
        append(`${open}${id.sample}${close}${mark}`, `${open}${id.spoken}${close}${mark}`, separator);
        positions.add(atTextStart ? 'text start' : 'after sentence end');
        if (separator === '\n' && !atTextStart) positions.add('wrapped');
      }
      if (open !== '') positions.add('bracketed');
      atBoundary = SENTENCE_END_MARK.test(mark);
    } else {
      const base = choose([...ID_BEFORE.filler, ...ID_BEFORE.negation]);
      const word = atBoundary && random() < 0.5 ? capitalised(base) : base;
      const mark = choose(last ? ID_LAST_MARKS : ID_PLAIN_MARKS);
      append(`${word}${mark}`, `${word}${mark}`, separator);
      atBoundary = SENTENCE_END_MARK.test(mark);
    }
    atTextStart = false;
  }
  return { raw, spoken, positions, kinds };
}

/** Whitespace-separated tokens that hold a letter or a digit: the words a listener would hear as content. */
function contentWordCount(text: string): number {
  return wordsOf(text).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * The input with the parts that are markup BY DESIGN taken out (see the list at the top of speakable-text.ts):
 * code-fence lines (the language tag goes with the fence) and link destinations. What is left must all be
 * spoken, so its content word count is a floor for the output's.
 */
function withoutMarkup(input: string): string {
  return input
    .split('\n')
    .filter((line) => !/^[ \t]*(?:`{3,}|~{3,})(?:[A-Za-z][\w+#-]*)?[ \t]*$/.test(line))
    .join('\n')
    .replace(/\]\((?:[^()\s]|\([^()\s]*\))*\)/g, ']');
}
// --- identifier oracle end ---

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

  test('stays idempotent, settles in three passes, never throws, never glues a word and loses no content word on 20,000 pseudo-random mixes', () => {
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
      'as', 'of', 'since', 'until', 'between', 'and', '-', '–', '| a | b |', '|---|---|', '|', 'd3.js/three.js', 'src/index.js',
      'a/b.json:12', 'src/a.ts#L4', 'react/next.js', 'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90', '3f2a9c1d8e0b', '- /x/y.ts',
      '- #12', 'for', 'expires', ':', ';',
      // Wrapped lines, markers on their own, nesting and identifiers next to negations.
      '\n- ', '\n## ', '\n> ', '\n2. ', '3\n', '42\n', '-\n', '#\n', '[a](u)', '![](u)', '[redacted]', '[[redacted]]', '](', '![',
      'No ', 'not ', 'except ', 'agent ', 'commit ', '``', '```ts\n', '*_', '_*', '\n\n', '| |', '\n|---|---|\n',
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
      const settled = settleSpeakable(input);
      if (!settled.settled || settled.passes > 3) problems.push(`passes ${settled.passes}: ${JSON.stringify(input)}`);
      if (contentWordCount(once) < contentWordCount(withoutMarkup(input))) {
        problems.push(`lost a content word: ${JSON.stringify(input)} => ${JSON.stringify(once)}`);
      }
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
    ['table rows', `| a | b |\n|---|---|\n${'| 1 | 2 |\n'.repeat(150)}`],
    ['table rows with no separator', '| a | b |\n'.repeat(180)],
    ['many pipes', `${'| a '.repeat(500)}|`],
    ['timestamps with commas', 'At 2025-11-10T10:00:00Z, '.repeat(60)],
    ['timestamp lists', '2025-11-10T10:00:00Z, '.repeat(90)],
    ['"as of" timestamps after sentence ends', 'Done. As of 2025-11-10T10:00:00Z, it failed. '.repeat(60)],
    ['label values with a colon', 'Last seen: 2025-11-10T10:00:00Z by Bob. '.repeat(60)],
    ['log line timestamps after sentence ends', 'Done. 2025-11-10T10:00:00Z ERROR build failed. '.repeat(60)],
    ['uuids', '123e4567-e89b-12d3-a456-426614174000 and '.repeat(45)],
    ['bullets before paths', '- /a/b/c.ts\n'.repeat(200)],
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

  test('a timestamp only ever becomes "a set time": 20,000 sentences with timestamps in every position', () => {
    const random = mulberry32(0x7131e5);
    const choose = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const stamps = [
      '2025-11-10T10:00:00Z', '2025-11-11T11:30:00.000+01:00', '2026-01-02T03:04:05.678-0530', '2025-03-04T10:20Z',
      '2025-03-04T10:20:30', '2024-12-31T23:59:59.9+05:30',
    ];
    const plain = [
      'deploy', 'build', 'backup', 'snapshot', 'files', 'tests', 'task', 'agent', 'server', 'lock', 'queue', 'job',
      'ran', 'failed', 'passed', 'was', 'were', 'is', 'had', 'yet', 'the', 'latest', 'one', 'it', 'we', 'Ana', 'Bob', 'CI',
      'restore', 'delete', 'merge', 'release', 'notes', 'green', 'red', 'stuck', 'stopped', 'fine', 'then', 'again',
    ];
    const negations = [
      'not', 'never', 'without', 'except', 'only', 'no', 'nothing', 'neither', 'nor', 'unless', "don't", "wasn't",
      'but', 'instead', 'cannot', 'none', 'nobody',
    ];
    const leads = [
      'at', 'on', 'until', 'till', 'since', 'before', 'after', 'by', 'from', 'to', 'between', 'through', 'within', 'of',
      'as of', 'as at', 'dated', 'timestamped', '@', 'updated', 'created', 'modified', 'started', 'finished', 'completed',
      'ended', 'generated', 'last seen:', 'last run', 'seen', 'logged', 'reported', 'recorded', 'last seen', 'updated:',
    ];
    const dashes = ['-', '–', '—'];
    const wrappers: ReadonlyArray<readonly [string, string]> = [['', ''], ['', ''], ['', ''], ['(', ')'], ['[', ']'], ['"', '"'], ['<', '>']];
    const marks = ['', '', '', ',', '.', ';', ':', '!', '?'];
    const endMarks = ['', '', '.', '!', '?'];
    const coverage = { atStart: 0, afterSentenceEnd: 0, wrapped: 0, several: 0, negated: 0, lineStart: 0 };
    const problems: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) {
      const pieces = 3 + Math.floor(random() * 10);
      let raw = '';
      let spoken = '';
      let previousRaw = '';
      let stamped = 0;
      let negated = false;
      for (let j = 0; j < pieces; j += 1) {
        const last = j === pieces - 1;
        const kind = random();
        let wordRaw: string;
        let wordSpoken: string;
        let isStamp = false;
        if (kind < 0.32) {
          const [open, close] = choose(wrappers);
          const stamp = choose(stamps);
          const mark = last ? choose(endMarks) : choose(marks);
          wordRaw = `${open}${stamp}${close}${mark}`;
          const capital = j === 0 || /[.!?]["')\]”’]?$/u.test(previousRaw);
          wordSpoken = `${open}${capital ? 'A set time' : 'a set time'}${close}${mark}`;
          isStamp = true;
          stamped += 1;
          if (j === 0) coverage.atStart += 1;
          else if (capital) coverage.afterSentenceEnd += 1;
          if (open !== '') coverage.wrapped += 1;
        } else {
          // A dash opens no sentence: "- x" at the start of the text is a bullet, which has nothing to do with timestamps.
          const base = kind < 0.58 || (kind >= 0.93 && j === 0)
            ? choose(plain)
            : kind < 0.72 ? choose(negations) : kind < 0.93 ? choose(leads) : choose(dashes);
          if (negations.includes(base)) negated = true;
          const cased = random() < 0.15 && /^[a-z]/.test(base) ? base[0].toUpperCase() + base.slice(1) : base;
          // A dash or a label that ends in a colon never takes more punctuation; a last word only gets a sentence end.
          const mark = dashes.includes(base) || base.endsWith(':') ? '' : last ? choose(endMarks) : random() < 0.12 ? choose(marks) : '';
          wordRaw = `${cased}${mark}`;
          wordSpoken = wordRaw;
        }
        // The text must not end in "," ";" or ":" (the module turns those into a period), nor in a bare dash.
        if (last && (dashes.includes(wordRaw) || /[,;:]$/.test(wordRaw))) {
          wordRaw = `${wordRaw}done`;
          wordSpoken = wordRaw;
          if (isStamp) stamped -= 1;
        }
        let separator = '';
        if (j > 0) {
          const dashWord = dashes.includes(wordRaw);
          separator = !dashWord && random() < 0.08 ? '\n' : ' ';
          if (separator === '\n' && isStamp) coverage.lineStart += 1;
        }
        raw += separator + wordRaw;
        spoken += (separator === '' ? '' : ' ') + wordSpoken;
        previousRaw = wordRaw;
      }
      if (stamped > 1) coverage.several += 1;
      if (negated && stamped > 0) coverage.negated += 1;
      seen.add(raw);
      const loss = findWordLoss(makeSpeakable, { raw, spoken });
      if (loss) problems.push(loss);
      const once = makeSpeakable(raw);
      if (makeSpeakable(once) !== once) problems.push(`not idempotent: ${JSON.stringify(raw)} => ${JSON.stringify(once)}`);
      if (problems.length >= 5) break;
    }
    expect(problems).toEqual([]);
    expect(seen.size).toBeGreaterThan(19_000);
    expect(coverage.atStart).toBeGreaterThan(2000);
    expect(coverage.afterSentenceEnd).toBeGreaterThan(500);
    expect(coverage.wrapped).toBeGreaterThan(3000);
    expect(coverage.several).toBeGreaterThan(5000);
    expect(coverage.negated).toBeGreaterThan(5000);
    expect(coverage.lineStart).toBeGreaterThan(300);
  }, 60_000);

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
    // Wrong rewrites of the later rounds: a timestamp and its lead word silently removed, which changes what the sentence says.
    const T = '2025-11-10T10:00:00Z';
    const timeFindings: Array<[raw: string, spoken: string, wrong: string]> = [
      [`As of ${T} the build is green.`, 'As of a set time the build is green.', 'The build is green.'],
      [`Status as of ${T} is green.`, 'Status as of a set time is green.', 'Status is green.'],
      [`Green as of ${T}.`, 'Green as of a set time.', 'Green.'],
      [`Do not merge until ${T}.`, 'Do not merge until a set time.', 'Do not merge.'],
      [`No failures since ${T}.`, 'No failures since a set time.', 'No failures.'],
      [`Do not deploy on ${T}.`, 'Do not deploy on a set time.', 'Do not deploy.'],
      [`Tests failed at ${T} but passed at ${T}.`, 'Tests failed at a set time but passed at a set time.', 'Tests failed but passed.'],
      [`It broke at ${T}, not at ${T}.`, 'It broke at a set time, not at a set time.', 'It broke, not.'],
      [`Merging is blocked on ${T} only.`, 'Merging is blocked on a set time only.', 'Merging is blocked only.'],
      [`The lock is held until at least ${T}.`, 'The lock is held until at least a set time.', 'The lock is held until at least.'],
      [`Errors at ${T}: 3, at ${T}: 0.`, 'Errors at a set time: 3, at a set time: 0.', 'Errors: 3,: 0.'],
      [`Wait. At ${T} the lock is released.`, 'Wait. At a set time the lock is released.', 'Wait. the lock is released.'],
      [`Wait. ${T} the lock is released.`, 'Wait. A set time the lock is released.', 'Wait. the lock is released.'],
      [`Last seen: ${T} by Bob.`, 'Last seen: a set time by Bob.', 'Last seen by Bob.'],
      // Review round 5: each of these used to lose the time and so changed the meaning.
      [`No files were updated at ${T}.`, 'No files were updated at a set time.', 'No files were updated.'],
      [`Nothing was logged at ${T}.`, 'Nothing was logged at a set time.', 'Nothing was logged.'],
      [`The nightly backup had not yet completed at ${T}.`, 'The nightly backup had not yet completed at a set time.', 'The nightly backup had not yet completed.'],
      [`Do not deploy @ ${T}`, 'Do not deploy @ a set time', 'Do not deploy.'],
      [`Do not restore the snapshot dated ${T}.`, 'Do not restore the snapshot dated a set time.', 'Do not restore the snapshot.'],
      [`Delete only files modified on ${T}.`, 'Delete only files modified on a set time.', 'Delete only files modified.'],
      [`Use the backup dated ${T}, not the latest one.`, 'Use the backup dated a set time, not the latest one.', 'Use the backup, not the latest one.'],
      ['Compare d3.js/three.js now.', 'Compare d3.js/three.js now.', 'Compare three.js now.'],
      ['Moved react/next.js today.', 'Moved react/next.js today.', 'Moved next.js today.'],
      ['Pass before/after.png along.', 'Pass before/after.png along.', 'Pass after.png along.'],
    ];
    for (const [raw, spoken, wrong] of timeFindings) {
      expect(findWordLoss(() => wrong, { raw, spoken }), raw).not.toBeNull();
      expect(findWordLoss(makeSpeakable, { raw, spoken }), raw).toBeNull();
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

describe('makeSpeakable never drops an identifier', () => {
  const IDENTIFIER_SEEDS = [0x1d5eed, 0x2b0b1e, 0x3c0ffee];

  test.each(IDENTIFIER_SEEDS)(
    'keeps every word of 7,000 sentences with identifiers in every position and next to every kind of word (seed %#)',
    (seed) => {
      const random = mulberry32(seed);
      const problems: string[] = [];
      const seenRaw = new Set<string>();
      const coverage = new Map<string, number>();
      const kinds = new Map<string, number>();
      for (let i = 0; i < 7000; i += 1) {
        const sentence = generateIdSentence(random);
        seenRaw.add(sentence.raw);
        for (const position of sentence.positions) coverage.set(position, (coverage.get(position) ?? 0) + 1);
        for (const kind of sentence.kinds) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        const loss = findWordLoss(makeSpeakable, sentence);
        if (loss) problems.push(loss);
        const output = makeSpeakable(sentence.raw);
        if (contentWordCount(output) < contentWordCount(sentence.raw)) {
          problems.push(`fewer content words: ${JSON.stringify(sentence.raw)} => ${JSON.stringify(output)}`);
        }
        if (makeSpeakable(output) !== output) problems.push(`not idempotent: ${JSON.stringify(sentence.raw)} => ${JSON.stringify(output)}`);
        if (settleSpeakable(sentence.raw).passes > 3) problems.push(`more than three passes: ${JSON.stringify(sentence.raw)}`);
        if (problems.length >= 5) break;
      }
      expect(problems.slice(0, 5)).toEqual([]);
      expect(seenRaw.size).toBeGreaterThan(6500);
      for (const position of ['text start', 'after sentence end', 'middle', 'end', 'bracketed', 'wrapped', 'bullet stripped', 'bullet kept', 'negated']) {
        expect(coverage.get(position) ?? 0, position).toBeGreaterThan(300);
      }
      for (const kind of ID_KINDS) expect(kinds.get(kind.name) ?? 0, kind.name).toBeGreaterThan(1000);
    },
    60_000,
  );

  test('the identifier oracle flags every dropped id the reviewers found, and accepts what the module says', () => {
    const U = '123e4567-e89b-12d3-a456-426614174000';
    const findings: Array<[raw: string, spoken: string, wrong: string]> = [
      [`No agent ${U} is running.`, 'No agent ID is running.', 'No agent is running.'],
      ['There is no commit 3f2a9c1d on the release branch.', 'There is no commit ID on the release branch.', 'There is no commit on the release branch.'],
      [`Every task except ${U} passed.`, 'Every task except an ID passed.', 'Every task except passed.'],
      ['No request id 3f2a9c1d4e5b6a7 in the logs.', 'No request id ID in the logs.', 'No request id in the logs.'],
      [`Kill ${U} but keep ${U}.`, 'Kill an ID but keep an ID.', 'Kill but keep.'],
      ['Main does not contain commit 3f2a9c1.', 'Main does not contain commit ID.', 'Main does not contain commit.'],
    ];
    for (const [raw, spoken, wrong] of findings) {
      expect(findWordLoss(() => wrong, { raw, spoken }), raw).not.toBeNull();
      expect(contentWordCount(wrong), raw).toBeLessThan(contentWordCount(raw));
      expect(findWordLoss(makeSpeakable, { raw, spoken }), raw).toBeNull();
      expect(contentWordCount(makeSpeakable(raw)), raw).toBeGreaterThanOrEqual(contentWordCount(raw));
    }
  });
});

describe('makeSpeakable settles every rewrite in one pass', () => {
  const sentenceOf = (...parts: string[]): string => `${parts.join('')}.`;

  /** Run `input`, require the exact output and a quick, settled run of at most three passes. */
  function settlesTo(input: string, expected: string): void {
    const start = performance.now();
    const result = settleSpeakable(input);
    const elapsed = performance.now() - start;
    expect(result.text.length).toBeLessThan(2100);
    expect(result.text).toBe(expected);
    expect(result.settled).toBe(true);
    expect(result.passes).toBeLessThanOrEqual(3);
    expect(elapsed).toBeLessThan(100);
    expect(makeSpeakable(result.text)).toBe(result.text);
  }

  test('990 nested placeholder brackets', () => {
    settlesTo(`${'['.repeat(990)}redacted${']'.repeat(990)}`, 'redacted.');
    settlesTo(`Key ${'['.repeat(990)}redacted${']'.repeat(990)} leaked`, 'Key redacted leaked.');
  });

  test('1,000 nested emphasis markers', () => {
    settlesTo(`${'*_'.repeat(400)}x${'_*'.repeat(400)}`, 'x.');
    settlesTo(`${'*a '.repeat(300)}x${' b*'.repeat(300)}`, sentenceOf('a '.repeat(300), 'x', ' b'.repeat(300)));
    settlesTo(`${'_a '.repeat(300)}x${' b_'.repeat(300)}`, sentenceOf('a '.repeat(300), 'x', ' b'.repeat(300)));
    settlesTo(`${'**a '.repeat(200)}x${' b**'.repeat(200)}`, sentenceOf('a '.repeat(200), 'x', ' b'.repeat(200)));
    settlesTo(`${'__a '.repeat(200)}x${' b__'.repeat(200)}`, sentenceOf('a '.repeat(200), 'x', ' b'.repeat(200)));
  });

  test('1,000 nested links and images', () => {
    settlesTo(`${'['.repeat(300)}x${'](u)'.repeat(300)}`, 'x.');
    settlesTo(`${'!['.repeat(300)}x${'](u)'.repeat(300)}`, 'x.');
    settlesTo(`${'[a '.repeat(250)}x${'](u)'.repeat(250)}`, sentenceOf('a '.repeat(250), 'x'));
    // A `[` right after a letter is code or prose, not a link: dropping the "(event)" would delete a word.
    settlesTo('Do not call handlers[0](event) or items[i](args).', 'Do not call handlers[0](event) or items[i](args).');
    // Open brackets with no link around them are plain text, however many there are.
    const unclosed = '[]('.repeat(600);
    settlesTo(unclosed, `${unclosed}.`);
  });

  test('1,000 nested parentheses and nested code spans', () => {
    const parens = `${'('.repeat(1000)}${')'.repeat(1000)}`;
    settlesTo(parens, `${parens}.`);
    const deepParens = `${'('.repeat(900)}x${')'.repeat(900)}`;
    settlesTo(deepParens, `${deepParens}.`);
    let spans = 'x';
    for (let width = 1; width <= 40; width += 1) spans = `${'`'.repeat(width)}a ${spans} b${'`'.repeat(width)}`;
    const result = settleSpeakable(spans);
    expect(result.text).toBe(sentenceOf('a '.repeat(40), 'x', ' b'.repeat(40)));
    expect(result.passes).toBeLessThanOrEqual(3);
  });

  test('a stack of every nesting at once settles in at most three passes', () => {
    const mixed = `**_[\`a ${'['.repeat(50)}redacted${']'.repeat(50)} b\`](u)_** and ${'*x '.repeat(40)}y${' z*'.repeat(40)}`;
    const result = settleSpeakable(mixed);
    expect(result.settled).toBe(true);
    expect(result.passes).toBeLessThanOrEqual(3);
    expect(result.text).toBe(sentenceOf('a redacted b and ', 'x '.repeat(40), 'y', ' z'.repeat(40)));
  });

  test('a line break inside a pair is joined first, so it needs one more pass and no more', () => {
    for (const [input, expected] of [
      ['a `b\nc` d', 'a b c d.'],
      ['**bold\ntext** and *x\ny*', 'bold text and x y.'],
      ['[a\nb](u) and `c\nd`', 'a b and c d.'],
      ['`**x\ny**`', 'x y.'],
    ]) {
      const result = settleSpeakable(input);
      expect(result.text, input).toBe(expected);
      expect(result.passes, input).toBeLessThanOrEqual(3);
    }
  });

  test('a pass that never settles falls back to the whitespace-collapsed input, and that answer is a fixed point', () => {
    // Never settles on its own: every pass appends to the text.
    const grows = (text: string): string => `${text}x`;
    const first = settleSpeakable('a   b\n\nc  ', grows, 4);
    expect(first).toEqual({ text: 'a b c', passes: 4, settled: false });
    // Calling again on the answer gives the same answer.
    expect(settleSpeakable(first.text, grows, 4).text).toBe(first.text);

    // Settles only once its whitespace is collapsed (a line break keeps it busy): the settled form of the
    // collapsed text is the answer, and it is a fixed point too.
    const busyWhileMultiLine = (text: string): string => (text.includes('\n') ? `${text}\n` : text);
    const second = settleSpeakable('a\nb', busyWhileMultiLine, 3);
    // The cap was hit, and the result says so even though the collapsed text settled.
    expect(second.settled).toBe(false);
    expect(second.text).toBe('a b');
    expect(settleSpeakable(second.text, busyWhileMultiLine, 3).text).toBe(second.text);

    // The cap really is small, and real text never comes near it.
    const real = settleSpeakable('See [the docs](https://example.com/a) and **bold** `code` for 123e4567-e89b-12d3-a456-426614174000.');
    expect(real.settled).toBe(true);
    expect(real.passes).toBeLessThanOrEqual(3);
  });

  test('a cut-off input settles too: expansion never loops', () => {
    for (const input of ['#1 '.repeat(900), 'a/b.ts '.repeat(400), `${'x '.repeat(999)}[[[redacted]]]`, `${'`'.repeat(1999)}a`]) {
      const result = settleSpeakable(input);
      expect(result.settled).toBe(true);
      expect(result.passes).toBeLessThanOrEqual(3);
      expect(makeSpeakable(result.text)).toBe(result.text);
    }
  });
});

describe('makeSpeakable fuzz: idempotent, settled in three passes, no content word lost', () => {
  /** Atoms for multi-line, wrapped-line and marker-heavy text. */
  const ATOMS = [
    '*', '**', '_', '__', '`', '``', '```', '[', ']', '(', ')', '](', '![', 'x', 'ab', 'Word', '\n', '\n- ', '\n# ', '\n## ', '\n> ',
    '\n1. ', '- ', '# ', '## ', '> ', '1. ', '2) ', '|', '| a |', '|---|', '| |', 'redacted', '[redacted]', '.', ',', ':', ';', '!', '?', '/',
    'u', '3', '#3', '"', '-', '+', '•', '~', '[a](u)', '![a](u)', '[](u)', '![](u)', '*em*', '_em_', '**bold**', '`code`', '\n\n', '-\n',
    '123e4567-e89b-12d3-a456-426614174000', '3f2a9c1', '3f2a9c1d8e0b', 'commit', 'agent', 'not', 'except', 'src/a.ts', '2025-11-10T10:00:00Z',
  ];

  test.each([1, 2, 3, 4])('5,000 multi-line, wrapped-line and marker-heavy inputs (seed %#, 20,000 in all)', (index) => {
    const random = mulberry32(0xf00d * (index + 1));
    const problems: string[] = [];
    let slowest = 0;
    for (let i = 0; i < 5000; i += 1) {
      let input = '';
      const parts = 1 + Math.floor(random() * 30);
      const spacing = random();
      for (let j = 0; j < parts; j += 1) {
        input += ATOMS[Math.floor(random() * ATOMS.length)];
        if (random() < spacing) input += ' ';
      }
      const result = settleSpeakable(input);
      slowest = Math.max(slowest, result.passes);
      if (!result.settled || result.passes > 3) problems.push(`passes ${result.passes}: ${JSON.stringify(input)}`);
      if (makeSpeakable(result.text) !== result.text) problems.push(`not idempotent: ${JSON.stringify(input)} => ${JSON.stringify(result.text)}`);
      if (contentWordCount(result.text) < contentWordCount(withoutMarkup(input))) {
        problems.push(`lost a content word: ${JSON.stringify(input)} => ${JSON.stringify(result.text)}`);
      }
      if (problems.length >= 5) break;
    }
    expect(problems).toEqual([]);
    expect(slowest).toBeLessThanOrEqual(3);
  }, 60_000);
});

describe('makeSpeakable settles a single line in two passes', () => {
  // One rewrite, and one more run that finds nothing left to do. A third pass is only for a pair that spans a line
  // break (its two halves meet when the lines are joined), so a text with no line break must never need one. The
  // atoms leave out two shapes that can need a third pass on a single line, both made of two rewrites that meet:
  // a path whose file name starts with `_` or `*` (it becomes an emphasis opener only once the path is gone) and a
  // URL or path glued to a backtick (the token swallows the backtick, which changes how the others pair up).
  const MARKUP = [
    '*', '**', '_', '__', '`', '``', '```', '[', ']', '(', ')', '](', '![', '[a](u)', '![a](u)', '[](u)', '![](u)', '*em*', '_em_',
    '**bold**', '`code`', '`,`', '- ', '# ', '## ', '> ', '1. ', '|', '| a |', '|---|', '| |', '[redacted]', '[[redacted]]',
    '(redacted)', '-', '+', '•', '~', '"', "'", '.', ',', ':', ';', '!', '?', '/', '...', '…', ' , ', ' . ', ' ; ', ' : ', ' ! ', ' ? ',
  ];
  const WORDS = [
    'x', 'ab', 'Word', 'the', 'not', 'except', 'only', 'no', 'commit', 'agent', 'task', 'id', 'on', 'at', 'revert', 'a', 'to', 'for',
    'snake_case', 'needs_input', 'needsInput', '__init__', '_private', 'C++', 'std::vector', '3', '42', '#3', '#12', '1.5', '10:30', '$5',
    '50%', '1..10', 'main..HEAD', '->', '=>', '&', '&&', '-->', '→',
  ];
  /** Identifiers and paths: each is kept apart from its neighbours by a space. */
  const TOKENS = [
    '123e4567-e89b-12d3-a456-426614174000', '3f2a9c1', 'abc1234', '3f2a9c1d8e0b', 'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90',
    '507f1f77bcf86cd799439011', 'deadbeef12', '10dec2025', '2025-11-10T10:00:00Z', '2025-11-10T10:00:00.123+01:00', 'src/a.ts', '/a/b/c.ts',
    '/a/b/needs_input', '/a/b/3f2a9c1d8e0b', '~/x/y.md', './lib/util.js', 'C:\\x\\y.md', '@scope/pkg/x.ts', 'src/core/index.ts:42:7',
    'a/b.json#L4', 'https://example.com/a/b', 'https://github.com/o/r/pull/9', 'www.example.com', '/[redacted].ts', '[redacted]/foo.ts',
    '/api/tasks/42', 'd3.js/three.js', '.env',
  ];

  test.each([1, 2, 3, 4, 5, 6])('30,000 single-line inputs, none needs a third pass (seed %#)', (index) => {
    const random = mulberry32(0xa11ce * (index + 1));
    const problems: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      let input = '';
      const parts = 1 + Math.floor(random() * 14);
      const spacing = 0.3 + random() * 0.7;
      for (let j = 0; j < parts; j += 1) {
        const roll = random();
        if (roll < 0.2) input += ` ${TOKENS[Math.floor(random() * TOKENS.length)]} `;
        else input += (roll < 0.6 ? MARKUP : WORDS)[Math.floor(random() * (roll < 0.6 ? MARKUP : WORDS).length)];
        if (random() < spacing) input += ' ';
      }
      const result = settleSpeakable(input);
      if (!result.settled || result.passes > 2) problems.push(`passes ${result.passes}: ${JSON.stringify(input)} => ${JSON.stringify(result.text)}`);
      if (makeSpeakable(result.text) !== result.text) problems.push(`not idempotent: ${JSON.stringify(input)} => ${JSON.stringify(result.text)}`);
      if (contentWordCount(result.text) < contentWordCount(withoutMarkup(input))) problems.push(`lost a content word: ${JSON.stringify(input)}`);
      if (problems.length >= 5) break;
    }
    expect(problems).toEqual([]);
  }, 60_000);

  test('the shapes that used to need a third pass now settle in two', () => {
    for (const input of [
      'commit , 3f2a9c1',
      'task agent no snake_case… ',
      'Open /a/b/__init__ now',
      'See __init__507f1f77bcf86cd799439011 now',
      '33f2a9c1d8e0b…',
      '• /',
      'Go from a ` -> ` b now',
      '*a ` ->* `',
      '-\u00a0fixed it',
      '- @scope/pkg/x.ts and more',
      '- 3f2a9c1d8e0b failed',
    ]) {
      expect(settleSpeakable(input).passes, input).toBe(2);
    }
  });

  test('every single-line case of the table settles in two passes, and every other one in three', () => {
    for (const [, input] of CASES) {
      if (input.length > 2000) continue;
      expect(settleSpeakable(input).passes, JSON.stringify(input)).toBeLessThanOrEqual(input.includes('\n') ? 3 : 2);
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
