# Review: Add slugify(input, { maxLength })

Reviewed `src/index.js` `slugify` and `test/slugify.test.js` against the issue
criteria. `npm test` passes (11/11). I ran every issue example plus a property
sweep (start/end dash, char class, `length <= maxLength`) across accented,
ligature, astral, Turkish-dotted-I and punctuation inputs: no wrong results,
no missing guards, correct `TypeError`/`RangeError` types.

## Findings

### 1. LOW — Test title claims word-boundary logic that the code does not implement
`test/slugify.test.js:48-53` ("maxLength keeps a whole word that ends exactly at
the cut") vs `src/index.js:29-31` (`truncate` = plain `slice` + strip trailing
dashes).

Scenario: `slugify('abc def ghi', { maxLength: 5 })`. The slug is
`abc-def-ghi`; `slice(0,5)` yields `abc-d` — a **partial** word. Likewise
`slugify('my blog post', { maxLength: 6 })` → `my-blo`. So the implementation
does not "keep whole words"; it cuts mid-word and only trims a trailing dash.

The test passes only because all four of its inputs (`hello world again` @11,
`abc def ghi` @7, `a b c` @3, `my blog post` @7) happen to place the cut
exactly on a `-`, which plain slicing already handles. The test therefore does
not exercise the "whole word" behaviour its name promises, giving false
confidence that word-boundary budgeting exists.

Observable risk: a future contributor "fixes" `truncate` to drop partial words
(believing the test enforces it) or relies on whole-word output in production
and gets truncated fragments. The issue text only requires "at most maxLength
and must not end with `-`", which the current slice satisfies, so this is a
misleading test rather than an implementation bug.

Fix: rename the test to reflect what it checks (e.g. "maxLength cut on a dash
boundary leaves no trailing dash"), or, if whole-word output is intended, add a
genuine assertion such as `slugify('abc def ghi', { maxLength: 5 })` and change
`truncate` to drop the partial trailing word.

## Checked and fine
- Lowercasing + collapsing non-`a-z0-9` runs into single `-` (`Hello, World!`,
  `a__b--c  d`).
- Leading/trailing dash stripping (`"  Hello, World!  "` → `hello-world`).
- Accented Latin folding incl. NFKD decompositions (`Café Crème`) and the
  non-decomposing map (`ß`, `æ`, `œ`, `ł`, `đ`, `þ`, `ı`, `ĳ`); map keys and the
  fold regex are in sync (13/13).
- Empty / punctuation-only / whitespace-only → `""`.
- `maxLength` truncation never ends in `-` and never exceeds the limit, incl.
  multi-char folds (`ß`→`ss`, `ĳ`→`ij`) cut at a boundary.
- `TypeError` for non-string input; `RangeError` for `0`, negative,
  non-integer, string, `NaN`, `Infinity` and `null` `maxLength`;
  `undefined` `maxLength`/`options` leaves the slug untruncated.
- Astral/non-BMP and non-Latin scripts reduce to nothing without splitting
  surrogate pairs (they become `-` then strip).

FINDINGS: 1
