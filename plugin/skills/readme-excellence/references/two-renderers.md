# Two renderers: GitHub and npmjs.com

A package's README is read in at least two places. GitHub renders the file in the repository.
npmjs.com renders a copy stored in the registry when the package is published. They differ, and a
README that only looks right on GitHub fails the npm reader without anyone noticing.

Everything below is about npm only. Other registries (PyPI, crates.io, and so on) were not
researched: check them yourself before claiming anything about them.

## Evidence levels used here

- **Observed:** someone looked at the real artifact and saw it.
- **Documented:** an official source says so, possibly years ago.
- **Practitioner:** a blog, issue or third-party README says so.
- **No source:** nothing found either way. Assume the worst until you check.

## Behaviour table

| Construct | GitHub | npmjs.com | Evidence level | Safe practice |
|---|---|---|---|---|
| Length | Shows up to 500 KiB [documented, [GitHub docs][gh-readme]] | The registry's README copy is cut at **65,536 characters** | **Observed once** (2026-11, one package: the registry copy held exactly 65,536 characters, 66,053 UTF-8 bytes, and ended inside an unclosed code fence; see `evidence.md`, "Run figures"). **Documented** by npm in 2017 as 64 KB ([npm blog][npm-2017]). A July 2024 GitHub changelog announced removing README content from per-version metadata ([changelog][npm-2024]); that is a different field from the top-level README, and its effect on the website is unknown | Stay under 65,536 characters (treated as binding until observed otherwise; the largest good README in the corpus is 42,726 bytes). Count with `wc -m` under a UTF-8 locale, or with the script below. Put everything an npm reader needs early |
| How npmjs.com displays the cut copy | n/a | **Not observed.** A third-party client, npmx, falls back to a jsDelivr copy when it detects truncation, which suggests truncation still happens. Its code comment says 65,536 characters, but its constant is 64,000 ([npmx commit][npmx]) | Practitioner, weak | After publishing, open the npm page and read the end |
| Mermaid code blocks | Rendered as a diagram | Probably shown as raw source | No source found that npm renders it; leaning no | Pre-render to SVG or PNG, reference it with an absolute URL, and add one line of text that says the same thing |
| A bare video attachment URL (`user-attachments`) on its own line | Rendered as a player | Probably a plain link, or nothing | Practitioner: the undated README of `markdown-it-github-video` says GitHub video links do not work on the npm website ([npm page][mgv]); not observed | Use a poster image (absolute URL) wrapped in a link to the video, plus a one-line caption; see "Video: poster or inline player" below |
| `<video>` tag | Rendered | Unknown | No source | Same as above. Never make video the only carrier of a fact |
| Relative links and images (`./assets/x.png`, `docs/guide.md`) | Resolve against the file and branch [documented, [GitHub docs][gh-readme]] | npm appears to rewrite them to the repository URL | Practitioner ([npm/www#272][www272]). Images break when the `repository` field is missing or wrong, the repo is private, or the package's `files` list leaves the images out ([fenix-cli#40][fenix]) | Use absolute URLs for images (raw.githubusercontent.com or a CDN) and for links to files outside the package |
| In-page anchors (`[x](#section)`, `<a id="…">`) | Headings get ids, and in-page links jump to them [documented, [GitHub docs][gh-readme]] | Unknown | **No source found**; not observed | Check one in-page link on the live npm page after the next publish. Never make an in-page link the only route to an install step or a caveat |
| Which version's README is shown | The file on the default branch | The README of the **last published version**, so a fix reaches npm only after the next release | **Observed once** (2026-11, one package: `npm view <pkg> readme` returned the published copy, which differed from the README at HEAD although both carried the same version number in `package.json`). No official statement found | Read the registry copy with `printf %s "$(npm view <pkg> readme)" > npm-copy.md` (this drops the newline the CLI appends) and run the cut script on it. A copy of exactly 65,536 characters was almost certainly cut; read its "fence OPEN" line. In the report, say which fixes reach npm only after a release |
| GitHub alerts (`> [!NOTE]`, `> [!IMPORTANT]`) | Rendered as coloured callouts | Unknown; may show the literal `[!NOTE]` text | **No source at all**; not observed | Write the warning as a plain bold sentence that reads correctly either way |
| `<details>` / `<summary>` | Rendered as a collapsible block | Unknown | No source | Never hide the only copy of an install step or a caveat inside it |
| `<picture>` with light and dark sources | Supported [documented, [GitHub blog][gh-picture]] | One community post implies npm honours the sources (inferred, not stated): npm sets no color-scheme, so dark images show on a dark OS ([discussion][picture-npm]) | Practitioner, single source | Make the fallback `<img>` readable on both light and dark backgrounds |
| `#gh-dark-mode-only` image fragments | Deprecated | May show both variants | Practitioner ([blog post][darkmode]) | Do not use |
| Which HTML tags survive | Sanitized; not covered by this research | Unknown | No source | Check on a real npm page before relying on raw HTML |

[gh-readme]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
[npm-2017]: https://blog.npmjs.org/post/153186129005/zero-one-infinity-readmes.html
[npm-2024]: https://github.blog/changelog/2024-07-09-leaner-npm-packument-metadata-contents
[npmx]: https://tangled.org/davidwindham.com/npmx.dev/commit/6a4aa00dc4f08e974a2e0979133d6be48c55ac8b
[mgv]: https://www.npmjs.com/package/markdown-it-github-video
[www272]: https://github.com/npm/www/issues/272
[fenix]: https://gitlab.com/FeniXEngineMV/fenix-cli/issues/40
[gh-picture]: https://github.blog/developer-skills/github/how-to-make-your-images-in-markdown-on-github-adjust-for-dark-mode-and-light-mode/
[picture-npm]: https://github.com/orgs/community/discussions/61789
[darkmode]: https://www.stefanjudis.com/blog/how-to-define-dark-light-mode-images-in-github-markdown

## Checks to run

```bash
wc -m README.md                       # npm budget, in characters (UTF-8 locale only; see below)
grep -nE '```mermaid|<video|user-attachments|\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]|<details' README.md
grep -nE '\]\((\./|\.\./|[a-z][a-z0-9_-]*/)[^)]*\)|src="(\./|\.\./|[a-z][a-z0-9_-]*/)' README.md   # relative links and images
```

`wc -m` counts characters only under a UTF-8 locale. Under `LC_ALL=C` it returns the byte count
(checked 2026-11-22 with GNU coreutils: a 64,541-character README read as 65,086). `wc -c` always
counts bytes. The script below counts characters itself.

Then find where the npm cut falls. The cut is in characters, so do not use `head -c`, which counts
bytes and cuts non-ASCII text too early. The script prints the size, the line and column where
character 65,536 falls, whether a code fence is still open there (or at the end of the file when
nothing is cut), and the headings lost past the cut:

```bash
python3 - README.md <<'EOF'
import re, sys
CUT = 65536  # characters npm keeps
path = sys.argv[1]
text = open(path, encoding="utf-8", newline="").read()
def scan(t):  # CommonMark-style fences -> (fence still open at the end, headings outside fences)
    fence, heads = None, []
    for i, l in enumerate(t.split("\n"), 1):
        m = re.match(r" {0,3}(`{3,}|~{3,})(.*)$", l)
        if fence is None and m and not (m[1][0] == "`" and "`" in m[2]):
            fence = (m[1][0], len(m[1]), i, l.strip())
        elif fence and m and m[1][0] == fence[0] and len(m[1]) >= fence[1] and not m[2].strip():
            fence = None
        elif fence is None and re.match(r" {0,3}#{1,6} ", l):
            heads.append((i, l.strip()))
    return fence, heads
n, kept = len(text), text[:CUT]
print(f"{path}: {n} characters, {len(text.encode())} bytes; npm cut {CUT}: "
      + (f"CUT, {n - CUT} characters lost" if n > CUT else f"not cut, {CUT - n} to spare"))
if n == CUT:
    print(f"exactly {CUT} characters: if this is the registry copy, npm probably cut it")
if n > CUT:
    line = kept.count("\n") + 1
    full = text.split("\n")[line - 1]
    col = CUT - kept.rfind("\n") - 1
    print(f"character {CUT}, the last one kept, is line {line} column {col}"
          + (" (the line is cut mid-way)" if col < len(full) else "") + f": {full[:80]!r}")
fence = scan(kept)[0]
where = "cut" if n > CUT else "end of the file"
print(f"fence OPEN at the {where}, opened on line {fence[2]}: {fence[3]!r}" if fence
      else f"no fence open at the {where}")
if n > CUT:
    lost = [h for h in scan(text)[1] if h[0] > line]
    print(f"headings past the cut ({len(lost)}):", "; ".join(f"L{i} {h}" for i, h in lost) or "none")
EOF
```

On the 72,431-character README of the run this skill came from, it printed:

```
README.md: 72431 characters, 72986 bytes; npm cut 65536: CUT, 6895 characters lost
character 65536, the last one kept, is line 601 column 79: '// addEntry never throws on a *content* rejection and never silently truncates:'
fence OPEN at the cut, opened on line 571: '```ts'
headings past the cut (4): L683 ## Status; L687 ## Changelog; L691 ## Contributing; L701 ## License
```

It does not track fences inside blockquotes or indented four or more spaces.

Ask of that cut: does any code fence open and never close? Is the license, the status or the
contributing section past it?

**Before claiming anything about the npm page, look at it.** Either view the live page after the
next publish, or publish a prerelease under a non-latest dist-tag and view that. Until then, every
npm statement in a report is "expected", not "observed".

## Length band and the cut

- **The band** is a corpus observation, not a rule: the 25 good READMEs had a median of 17,242
  bytes, 23 of them were 5 KB or more, and the largest was 42,726 bytes; 9 of the 13 not-good ones
  were under 5 KB (P4 in `evidence.md`). Aim for roughly 5-43 KB and treat a README outside it as
  a question, not a defect.
- **The 65,536-character cut is the rule** for a package published to npm.
- **A README already over the cut takes no net additions.** Every line a rewrite adds is paid for
  by a larger cut in the same change, until the README is under the cut. Report the character
  count before and after.

## Video: poster or inline player

GitHub plays a `user-attachments` video inline when the bare URL sits on its own line
(practitioner: widely reported and seen in the run this skill came from; no official statement found). npmjs.com is
expected to show that line as a plain link or nothing. A poster image wrapped in a link works on
both, but on GitHub it opens the video on a separate page instead of playing it in place. Pick
one:

- **Poster (the portable default)**, for a package published to npm:

  ```markdown
  [![<what the film shows, in one sentence>](https://raw.githubusercontent.com/<owner>/<repo>/<branch>/assets/film-poster.png)](https://github.com/user-attachments/assets/<id>)

  <one plain-text line that carries the film's main claim, for readers who do not play it>
  ```

  Take the poster from a real frame of the film (a frame grab, or the storyboard's own thumbnail
  if it has one). Commit it, and if the package's `files` list ships `assets/`, make sure the image
  is in it.
- **Inline player**, when GitHub is the main surface: keep the bare URL on its own line and put the
  same plain-text line under it, so npm readers still get the claim.

Either way the film carries no beat on its own: the text around it must say what it says.

## Files outside the package

This section is an inference from the rewriting behaviour above, not something observed. Links to
files that the package's `files` list does not ship (a `docs/` folder, say) only work on npm if
npm's rewriting points them at the repository, which depends on the `repository` field. Use
absolute GitHub URLs for them so they work everywhere.
