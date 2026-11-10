# Review: Add slugify(input, { maxLength }) helper

No defects found. I traced the change against every acceptance criterion and
probed edge cases beyond the issue's examples; all behaved correctly.

## Verification performed

- `npm test`: 10/10 pass (both `clamp` and all `slugify` tests).
- Ran every issue example manually via `node -e`:
  - `"  Hello, World!  "` -> `"hello-world"` (no leading/trailing dash).
  - `"Café Crème"` -> `"cafe-creme"` (NFKD + combining-mark strip).
  - `""`, `"!@#$%^&*()"`, `"   "` -> `""`.
  - `slugify("hello world", { maxLength: 6 })` -> `"hello"` (no trailing dash).
  - Non-string (`null`, `42`, `undefined`) -> `TypeError`.
  - `maxLength` `0`, `-1`, `1.5`, `"3"` -> `RangeError`.

## Areas checked that are correct

- **Lowercase + non-alphanumeric collapse** `src/index.js:78-79`: applies
  `toLowerCase()` before `fold`, then `[^a-z0-9]+ -> '-'` and strips edge
  dashes. Matches criterion 1/2.
- **Accent folding** `src/index.js:50-55` / `LATIN_FOLDS``: NFKD then strips
  combining diacritic ranges; the explicit map covers precomposed-only letters
  (`ß`->`ss`, `æ`->`ae`, `œ`->`oe`, `ø`->`o`, `ł`->`l`, `đ`/`ð`->`d`,
  `þ`->`th`, `ı`->`i`, `ŋ`->`n`, `ĸ`->`k`, `ĳ`->`ij`, `ŧ`->`t`). Verified
  `Café`, `Straße`, `Æther`, `Œuvre`, `Łódź`, `Đorđe`, `Smørrebrød Þingvellir`,
  `ﬁle` all fold as the extra tests claim.
- **Order of operations**: fold happens *before* the `[^a-z0-9]` filter, so
  multi-character expansions (`ß`->`ss`, ligatures) survive instead of being
  dropped — correct.
- **Truncation** `src/index.js:57-64,81-83`: only applied when
  `slug.length > maxLength`; the `atBoundary`/`lastIndexOf('-')` logic never
  leaves a trailing dash (tested `hello-world`/6 ->`hello`, `abc def ghi`/5
  ->`abc-d`, `a b`/1 ->`a`, `ab cd`/2 ->`ab`). Every `truncate()` branch is
  reachable and correct.
- **Astral input**: emoji/non-BMP runes are removed by the non-alphanumeric
  filter before truncation, so `.length`-based slicing cannot emit a lone
  surrogate (verified `😀abc`/1 -> `"a"`, no dangling high surrogate).
- **Validation precedence**: non-string input throws `TypeError` even when
  `maxLength` is also invalid (`slugify(null,{maxLength:0})` -> `TypeError`);
  `NaN`, `Infinity`, `true`, `null`, numeric-string `maxLength` all reject with
  `RangeError` (`Number.isInteger` handles them).
- **Options handling** `src/index.js:70`: `options ?? {}` safely tolerates
  `null`/`undefined`; a non-object truthy `options` (e.g. `5`) destructures to
  `undefined` and behaves as no options — acceptable, no crash.
- **Scope**: only `slugify` (and file-private helpers) added; `clamp` untouched.
- **Tests**: `test/slugify.test.js` asserts real outputs (not tautologies), and
  each claimed behavior (`strass` at 6, `oeuvr` at 5, `abc-d` at 5) was
  independently confirmed. The duplicated assertion on lines 129-130 is
  redundant but harmless (not a defect).

FINDINGS: 0
