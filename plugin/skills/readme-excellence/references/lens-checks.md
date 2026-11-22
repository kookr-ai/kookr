# Per-lens checks

Recipes for the lenses that need more than their question in the Lens catalogue. They add to the
catalogue; they do not replace it. Every check obeys the hard rules in `SKILL.md`.

## proof-claims

- **Run every safe sample in a scratch directory** outside the repository and diff the output
  against the README block. Safe means local and read-only to everything outside the scratch
  directory: no global installs, no credentialed or network-writing commands, no publish, push or
  delete. Run with a scratch `HOME` and with secrets unset. For any other sample, read the source
  and mark it `Verified: not verified (not run: <reason>)`.
- **Capture stdout and stderr separately** (`cmd >out.txt 2>err.txt; echo "exit=$?"`). A README
  block that mixes them, drops a warning line, or shows a success that went to stderr does not
  match a real run. Record the exit code too.
- **Check every image that shows command or file output** (a screenshot, an SVG terminal, a GIF)
  against a real run of the current version, as you would a text block. An image cannot be
  grepped, so it drifts unnoticed.
- **Label stateful samples.** A sample whose output depends on state the README never builds (a
  shelf, a database, a history of earlier runs, a clock) is "illustrative, stateful": the reader
  cannot reproduce it by pasting the commands shown. It needs a label next to it, such as
  "illustrative output from a notebook with a few weeks of use", or the commands that build the
  state.
- **Badges.** Each badge reads live data from a service that exists for this repo today, and a
  CI badge points at the default branch and is green. This lens owns badge truth;
  `first-screen` owns only placement and count.
- **Platform claims** (owned here, not by `first-success`). "Works on Windows, macOS and Linux"
  is verified only for the platforms someone ran it on, or that CI tests (name the CI job). Mark the rest "not verified".
- **Claim words.** Check every always, never, automatically, remembers, guarantees, and every
  number, against the source at HEAD.

## first-success

- **Time-to-value recipe.** From line 1, count (a) the steps (commands to type, files to edit,
  decisions to make) and (b) the source lines a reader scrolls, to two points: the first visible
  success (a command prints its result), and the first real payoff (the outcome the pitch
  promises, which for a part-not-whole tool often needs the extra step of hard rule 3). Report both
  as "N steps, L lines". A payoff the first-run path never reaches is a finding: this lens files
  it when no launch asset exists; when one does, `launch-fidelity` owns it (see the
  launch-alignment check) and this lens routes it in Out-of-lens notes.
- **The extra step at the install point** is the lightest path the project's own docs call
  required, not the heaviest one they recommend. Find the docs' own words ("required",
  "minimum", "optional", "recommended") and cite the file and line. Name the required path at the
  install point and link the recommended one. If a pitch sentence is true only on the recommended
  path, name that path, or add the condition to the sentence (`SKILL.md`, hard rule 3): this rule
  decides which step is shown at the install point, never what the pitch may promise.
- **Copy-paste blocks** run in the order shown, and name every prerequisite (runtime version, a
  service, a key) before the first command that needs it.
- **No `$` prompts in command-only blocks** (a convention, not corpus-backed). Where a block mixes
  command and output, either keep the prompt marker, or use one fence for the command and a
  second for the output. Do not remove `$` from a mixed block.

## positioning-limits

- **Name categories and the reader's existing mechanisms freely**: "a vector store", "a notes file
  your agent reads", "grep". These cannot go stale.
- **Name a third-party product only with a dated behaviour check**: what it does, as of which date
  or version, with a link. A claim about a competitor that is wrong, or becomes wrong, is a false
  claim in your README.
- **Count caveat.** P6 (name the alternative and say when to pick it) holds for 13 of 38 corpus
  READMEs read leniently and about 10-11 strictly; 12 of the 25 good READMEs against 1 of the 13
  not-good, as extracted (lenient). Quote it with that caveat or not at all (`evidence.md`).
- **Limits by distance**: see the severity rules in `SKILL.md`.

## discovery-metadata

Not corpus-backed: every ranking or keyword effect below is convention, not measured. Say so in
any finding that relies on one.

- **Read the current values.**
  `gh repo view --json description,repositoryTopics,homepageUrl,openGraphImageUrl,usesCustomOpenGraphImage`
  (these field names were checked against `gh repo view --json` on 2026-11-22).
  `repositoryTopics: null` means the repository has no topics. `usesCustomOpenGraphImage: false`
  means GitHub's generated card is in use.
  `npm view <pkg> description keywords repository homepage bugs`.
- **Set them** (operator-applied): `gh repo edit --description "…" --homepage "…" --add-topic <t>`
  (repeat `--add-topic` per topic).
- **Social preview has no `gh` flag**; it is set in the repository's web settings. GitHub's docs ask
  for a PNG, JPG or GIF under 1 MB, at least 640 by 320 pixels, and recommend 1280 by 640 for best
  display ([GitHub docs][social], read 2026-11-22).
- **Topics**: at most 20 per repository, each 50 characters or less, lowercase letters, numbers and
  hyphens ([GitHub docs][topics], read 2026-11-22).
- **Truncation of the About line and of npm search results**: no source found for either length.
  Do not quote a number; put the key words first and say "no documented limit found".
- **README length is not this lens's finding.** If the README is over the npm cut, put it in
  Out-of-lens notes for `renderers-length`; do not raise it here.

[social]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview
[topics]: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics
