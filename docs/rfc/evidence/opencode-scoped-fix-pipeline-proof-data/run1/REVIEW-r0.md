# Review: Add slugify(input, { maxLength }) helper

`npm test` passes (9/9). The issue's stated examples all behave as required:
`"  Hello, World!  "` -> `"hello-world"`, `"Café Crème"` -> `"cafe-creme"`,
`slugify("")`/punctuation -> `""`, `slugify("hello world", { maxLength: 6 })` -> `"hello"`,
non-string -> `TypeError`, invalid `maxLength` -> `RangeError`. The defects below are
cases where the acceptance criterion "accented Latin letters are reduced to their base
letter" silently produces a wrong slug instead of the base letter.

## 1. HIGH - Non-decomposing accented Latin letters are dropped, not folded

`src/index.js:6-12` (`fold`), consequence at `src/index.js:24`.

`fold` only strips combining marks after NFD (plus two manual maps for `Ð`/`Þ` and the
mark ranges). Latin letters whose accent is part of the precomposed codepoint and which
NFD does not decompose are then deleted by `.replace(/[^a-z0-9]+/g, '-')`.

Concrete scenario / observed outcomes (verified against the built module):

| input | actual | expected |
|---|---|---|
| `slugify("Straße")` | `"stra-e"` | `"strasse"` |
| `slugify("Æther")` | `"ther"` | `"aether"` |
| `slugify("Œuvre")` | `"uvre"` | `"oeuvre"` |
| `slugify("Łódź")` | `"odz"` | `"lodz"` |
| `slugify("Đorđe")` | `"or-e"` | `"dorde"` |
| `slugify("ﬁle")` | `"le"` | `"file"` |

Note `Đ`/`đ` (U+0110/U+0111) is not covered by the existing `\u00d0\u00f0` map, so the
handler that was meant to fix this class of letter misses the lowercase Đ/đ it logs as
handled. Result: user-supplied names like "Straße" or "Łódź" become truncated slugs
(`stra-e`, `odz`), which is a wrong result, not just a stylistic difference.

Fix: map these letters explicitly (`ß`->`ss`, `æ`/`Æ`->`ae`, `œ`/`Œ`->`oe`, `ø`->`o`,
`ł`/`Ł`->`l`, `đ`/`Đ`->`d`, `ð`/`Ð`->`d`, `þ`/`Þ`->`th`, `ı`->`i`, `ŋ`->`n`, and NFKD
handles ligatures like `ﬁ` if used instead of NFD), or switch `fold` to `NFKD` plus an
explicit map before the run-collapse. At minimum correct the `\u00d0\u00f0` map to also
cover U+0110/U+0111 so the intended behavior is actually applied.

## 2. MEDIUM - Tests do not cover the accent criterion beyond combining marks

`test/slugify.test.js:12-15`.

The "folds accented Latin letters" test only uses `é`, `è`, `Ü`, `ï` - all NFD-decomposable.
It therefore passes despite the `Straße`/`Łódź`/`Æther` failures above, so it does not test
what its title claims ("accented Latin letters" generally). A correct implementation that
handles precomposed-only letters would still pass unchanged, but a buggy one (this one) also
passes. Add at least `ß`, `æ`/`œ`, `ł`, `đ` cases.

## 3. LOW - `maxLength` truncation can return a slug shorter than intended but leaves interior dash

`src/index.js:28-30`.

`slug.slice(0, maxLength).replace(/-+$/, '')` only trims trailing dashes. For input where the
cut lands on a dash this is fine, but it cannot re-close an interior run; combined with
finding 1, a removed letter turns a run boundary into a dash that survives truncation, e.g.
`slugify("Œuvre test", { maxLength: 5 })` yields `"uvre"` after losing the `œ` and then
finding the leading dash. This is a consequence of finding 1 rather than an independent
algorithm bug; listed so a fix validating `maxLength` behavior includes an accented+truncated
case.

## Checked and fine

- `maxLength` validation: zero, negative, non-integer, string all throw `RangeError`
  (`Number.isInteger` correctly rejects `"3"` and `1.5`).
- `options ?? {}` handles `slugify("x")` and `slugify("x", null)`.
- Empty / whitespace / punctuation-only input -> `""`; leading/trailing dash trim works.
- Truncation to exactly `maxLength` after stripping trailing dash (`"hello world"`, 6 -> `"hello"`).
- `TypeError` for `null`, `number`, `undefined` inputs.
- Existing `clamp` tests still pass; no cross-call shared state in `slugify`.

FINDINGS: 3
