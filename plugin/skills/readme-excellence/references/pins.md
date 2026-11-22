# Pins: finding what depends on README text, and moving text without breaking it

A **pin** is anything outside the README that depends on its exact text: a sentence, a heading, an
anchor, a fenced block, an image path, a token list. Find every pin before anyone rewrites a line.
In the run this skill came from, seven test files read the README and pinned text in it, and a
plain `grep readme` missed several of the strings they required.

## Kinds of pin

**Hard pins** fail a test or a script when the text changes:

- **Direct reads.** A test reads `README.md` and checks it with `toContain`, `toMatch`, `includes`,
  a regex `exec` or `match`, or `indexOf` plus `slice` to cut out a section. An `indexOf('## Usage')`
  pins the first occurrence of that string, so an earlier `### Usage tips` or a prose mention
  silently hijacks the slice.
- **Reads through a list or a helper.** `for (const file of ['README.md', 'docs/x.md'])`, or a
  helper such as `const readme = () => readFileSync(...)` whose result goes through another
  function (`imageSources(readme())`). The pinned strings sit inside the helper, not beside the read.
- **Code-derived pins.** A test collects tokens from the source (every environment variable name,
  every `--help` usage line, every key of a JSON report) and requires each one to appear in the
  README, sometimes in both directions (the README may not mention a token the code lacks).
  Reading the test is the only way to see these.
- **Fence and sample-id tests.** A test parses fenced blocks and checks, for example, that an id
  shown in a sample equals what the code computes for the sample's text, or that at least one such
  pair exists. Deleting the "last" sample block can fail it.
- **Anchor resolvers.** A test follows links from other docs (`../README.md#some-anchor`) and
  checks that the README has a heading that slugs to it or an explicit `<a id="…">`.
- **Generated README.** The README, or a marked region of it, is written by a tool or a template
  (cog, doctoc, all-contributors, markdown-magic, embedme, a `README.md.tpl`). An edit inside the
  generated part is overwritten on the next build: edit the generator or its source instead, and
  say so in the finding.
- **Doctest and include couplings.** Another build reads the README: Rust
  `#![doc = include_str!("../README.md")]` compiles its Rust code blocks as doctests; Python
  `readme =` in `pyproject.toml` or `long_description` in `setup.py` makes it the PyPI page; a
  docs site includes it; a link or lint check (markdown-link-check, markdownlint, lychee) runs on
  it in CI.

**Soft pins** break nothing automatically, but a rename leaves them wrong:

- Inbound links and anchors from docs, examples and other READMEs.
- Code comments, CHANGELOG lines, and test `describe` names that cite a README section by name
  ("update the README's 'Machine-readable stats' section", "a film at the top of the README").
- Other docs that cite a test by its `describe` name; renaming the describe block breaks the
  citation.
- PR templates, skills and agent files that name the README as a source.
- A test that reproduces a README recipe without reading the README: it does not pin text, but the
  recipe's commands and outputs must stay true.

## Discovery recipe

Run from the repository root. Each pass narrows where to read; none of them replaces reading the
hits. Tested on a 72,431-character README whose repository had seven test files that read it: passes
1-3 listed every one of them, and pass 4 listed the inbound anchors, the comments that cite a
section by name, and the CHANGELOG line that described the README's top.

Passes 0 and 5 were added later and tested only on a small fixture repository (one file per
marker or coupling) and on a repository with none; they cover common tools, not every one.

```bash
# 0. Is the README generated? Markers in the README, a template file, a generator in the build.
#    If so, edit the generator or the template, not the generated text, and say so.
head -5 README.md
grep -niE 'AUTO-GENERATED|DO NOT EDIT|<!-- *(\[\[\[cog|START doctoc|ALL-CONTRIBUTORS|AUTO-GENERATED-CONTENT|doc-gen|embedme|BEGIN)' README.md
git ls-files | grep -iE '(^|/)readme[^/]*\.(tpl|template|in|hbs|njk|ejs|mustache)$'
git grep -nIE 'cogapp|cog -r|doctoc|all-contributors|markdown-magic|embedme|readme-md-generator' -- ':!**/node_modules/**' ':!*.md'

# 1. Every file outside the README that names it: tests, scripts, source, docs, templates.
git grep -lIiE 'readme' -- ':!README*' ':!**/node_modules/**' ':!**/dist/**'

# 2. In tests and scripts, the variables that hold README text, and the lines that use them.
#    This finds most pinned strings; regex .exec() and helper calls on other lines still need reading.
for f in $(git grep -lIiE 'readme' -- '*.test.*' '*.spec.*' 'test/**' 'tests/**' 'scripts/**' ':!**/node_modules/**'); do
  v=$(grep -oE '(const|let|var)\s+[A-Za-z_][A-Za-z0-9_]*\s*=.*README' "$f" | sed -E 's/^(const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*).*/\2/' | sort -u | paste -sd'|' -)
  [ -n "$v" ] && grep -nE "\b($v)\b.*(toContain|toMatch|indexOf|includes|startsWith|match|exec|split|slice)|(toContain|toMatch|indexOf|includes|match|exec|split|slice)\(.*\b($v)\b" "$f" | sed "s|^|$f:|"
done

# 3. README read through a list of doc files rather than a variable.
git grep -nE "\[[^]]*['\"]README\.md['\"][^]]*,|,\s*['\"]README\.md['\"]" -- ':!*.md' ':!**/node_modules/**'

# 4. Soft couplings: inbound anchors, lines that name both the README and one of its headings,
#    and lines that describe a place in the README ("the top of the README", "the README's recipe").
git grep -nE 'README(\.md)?#|blob/[^/]+/README' -- ':!README.md'
grep -E '^#{2,6} ' README.md | sed -E 's/^#+ +//' | while IFS= read -r h; do
  git grep -nIiF -e "$h" --and -e readme -- ':!README.md' ':!**/node_modules/**' | sed "s|^|[$h] |"
done
git grep -nIiE -e 'readme' --and -e 'top of|section|recipe|heading|above|below' -- ':!README.md' ':!**/node_modules/**'

# 5. Non-JavaScript couplings: doctests, package-page readers, link and lint checks in CI.
git grep -nIE 'include_str!\(.*README|doc *= *include_str|^ *readme *=|long_description|markdown-link-check|markdownlint|lychee' -- ':!**/node_modules/**' ':!*.md'
```

Then open every test file from passes 1-3 and read each test that reads the README, end to end.
Follow the variable or helper that holds the text to every use. Write down what each test
requires, verbatim.

## Hand-over format

The pin list goes into the facts pack's `Pins` section and to every critic and the writer. Readers
handle a flat list better than lettered sub-sections. Use one line per pin, in this shape:

```
PIN-<n> | hard|soft | <file>:<line> | requires: <exact string, regex or rule, verbatim> | lenses: <slugs it constrains>
```

Example:

```
PIN-3 | hard | src/cli.test.ts:4488 | requires: the first "## Usage" in the README is followed by a fence holding every `--help` usage line | lenses: structure-freshness, renderers-length, first-screen
PIN-9 | soft | docs/setup.md:42 | requires: anchor #configuration | lenses: structure-freshness
```

Tag a pin with every lens whose rewrite could break it. A pin that limits how short the README can
get (a large fenced block a test requires) constrains `renderers-length` too.

## Moving text without breaking pins

- **Hard pins: keep a pinned stub.** By default, leave the smallest text that satisfies the test in
  the README (the heading and its fence, the one required sentence, the anchor) and move the rest
  to docs. Change the test only when no honest stub can be kept: the stub would be misleading, or
  it would keep the README over the npm cut. Then change the test in the same change, and say why
  in the finding's `Pins:` line.
- **Soft pins: update the linker.** For an inbound anchor or a comment no test checks, update the
  linking file in the same change rather than keep a stub heading in the README.
- **Never** let a rewrite silently break a pin. A finding whose rewrite breaks one carries
  `Pins: RISK: breaks <PIN-n> unless <what> is updated in the same change`.
