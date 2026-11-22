# Evidence behind readme-excellence

Counts live in this file. Other files may restate one with its pattern ID; if they differ, this
file wins. Before you quote a count in a report, read its caveat here. Recount before you reuse a
number in public: READMEs change, so counts age.

## How the counts were made

Two AI agents did all the reading; no human judged the READMEs, and neither judgement is
independent of the other.

- **The extracting agent** read each README, listed its features and gave it a verdict, good or
  not-good.
- **The skeptic**, a second AI agent, rechecked every pattern against the files and corrected
  counts that were too strong. Where it did, the table shows its corrected count and the claim is
  worded more softly. It did not re-derive the good/not-good split for corrected counts; those
  splits are marked "as extracted" or "not rechecked".
- **Anti-patterns (A1-A12) were not separately audited** by the skeptic. Treat their counts as one
  agent's reading.

## The corpus

- **Fetched 2026-11-22.** 40 files in three groups plus one list:
  - **npm-top (15):** express, zod, vite, prettier, commander, chalk, axios, dotenv, hono,
    drizzle-orm, vitest, zx, execa, ora, tailwindcss.
  - **cli-acclaimed (12):** ripgrep, fzf, bat, httpie, uv, ruff, lazygit, zoxide, atuin, gum,
    vhs, starship.
  - **ai-agent-peer (12; 11 scored, cognee excluded):** mem0, letta, ollama, aider, repomix,
    browser-use, graphiti, cognee, supermemory, modelcontextprotocol/servers, claude-code, codex.
  - **curated (1):** matiassingers/awesome-readme. It is a list of examples, not a product README,
    and was not scored.
- **The counts below use 38 READMEs.** cognee was fetched but never classified, so it is outside
  the good/not-good split. Where a verdict says so, a count "with cognee" is out of 39.
- **Good vs not-good.** 25 READMEs got a positive verdict from the extracting agent ("good
  subset") and 13 did not ("not-good subset"). The same agent wrote both the verdicts and the
  features, and some "thin" verdicts cite a missing install command, so P1 is partly circular.
  Borderline calls: hono and modelcontextprotocol/servers were counted good; prettier and httpie
  were counted not-good.
- **What the not-good subset is.** It is not one kind of failure. 9 are thin signposts under 5 KB
  (prettier, vite, drizzle, vitest, tailwind, httpie, letta, claude-code, codex), 2 are manuals
  over 64 KB (axios, repomix), and 2 are neither (express, mem0).
- **Top tier (9):** the READMEs rated "Yes", "Very good", "Strong" or "Excellent": zod, commander,
  chalk, ripgrep, fzf, uv, ruff, zoxide, gum.
- **Tier labels come from the extractor's ranking**, not from the corrected counts. That is why
  P11 (6/38) sits under Moderate while P10 (at most 10/38) sits under Weak.

## What this evidence cannot tell you

- **Everything here is correlational.** Popular, well-maintained projects may simply have the time
  to write good READMEs. No study found (see the literature below) tested whether improving a
  README raises stars or downloads. Never promise an operator that a rewrite will.
- **The patterns describe what good READMEs share, not what makes them good.** Use them as a
  checklist of what readers of good READMEs are used to finding, not as a formula.
- **Category confounds.** Terminal tools show GIFs because they have visible output; agent tools
  route audiences because they serve several. Check the "applies when" column before applying a
  pattern.
- **Discovery metadata** (GitHub About line, topics, social preview, npm `description` and
  `keywords`) was not part of the corpus study. Nothing here supports or refutes advice about it.

## Patterns, ranked by evidence strength

"Overall" is out of 38. "Good vs not-good" is out of 25 and 13.

### Strong: rechecked by the skeptic, and the good and not-good subsets differ sharply

| ID | Pattern | Overall | Good vs not-good | Skeptic | Applies when |
|---|---|---|---|---|---|
| P1 | The README itself has an install command and at least one code or command sample; it does not defer both to a docs site | 32/38 | 25/25 vs 7/13 | holds (partly circular: some not-good verdicts cite the missing install) | Always, unless the brand and a docs site already do the selling (tailwind, vite) |
| P2 | The reader sees a real result without running anything: text output under the command, or a screenshot, GIF or video of real output | 22/38 strict, 23/38 lenient (about 5 text, about 17 visual) | 20/25 vs 3/13 as extracted | holds, count softened | Always. For a library or text CLI, text output under the command is enough |
| P4 | Length in a middle band: substantive, not a manual | 2/38 over 64 KB; 11/38 under 5 KB | over 64 KB: 0/25 vs 2/13; under 5 KB: 2/25 vs 9/13; median 17,242 B vs 3,416 B; good range 1,724-42,726 B | holds, recomputed from file sizes | Always; essential for anything published to npm |
| P6 | Positions the tool against a named alternative or approach and says when to pick the other | 13/38 lenient, about 10-11 strict | 12/25 vs 1/13 as extracted (lenient) | holds, count softened | Readers already use something in the category |

P4 units: corpus sizes are **bytes** on disk. The npm cut (see `two-renderers.md`) is counted in
**characters**. For ASCII text they match; for text with non-ASCII characters, bytes exceed
characters. Measure with `wc -m` for the npm budget.

### Moderate: counts corrected; P8 and P9 did not hold as first stated

| ID | Pattern | Overall | Good vs not-good | Skeptic | Applies when |
|---|---|---|---|---|---|
| P3 | The first visual is a demo of the product working, not just a logo | 18/38 (19/39 with cognee) | 16/25 vs 2/13 | holds; strongly confounded by category (cli-acclaimed 12/12, npm-top 2/15) | The product has visible output. A library uses code with shown output instead |
| P5 | A usage sample comes before the Install section | 9/38 (10 if repomix's run line counts) | 8/25 vs 1/13; top tier 4/9 | holds | Core usage fits in 5-15 lines |
| P7 | States its own limits or non-goals next to the claim | about 9/38 lenient, about 7 strict | 8/25 vs 1/13 as extracted | holds, count softened | Always; most of all when the design is small on purpose |
| P8 | A quantitative claim names its workload or method, is dated, or links a way to check it | 9/38 (corrected: ruff removed) | split not rechecked | **did not hold as first stated**: "every claim" was too strong | Only when a real, reproducible number exists. Having no numbers is fine |
| P9 | A repeatable unit per feature: claim, snippet, real output or visual, docs link | 9/38 (10 if httpie counts; aider removed) | split not rechecked | **did not hold as first stated** | Whatever reference stays in the README |
| P11 | A FAQ or troubleshooting section titled with the user's literal symptom | 6/38 (about 5 strict) | 6/25 vs 0/13 as extracted (not-good split not rechecked) | holds | Known recurring support questions exist |

### Weak: small counts or a category convention; P10 and P14 did not hold as first stated

| ID | Pattern | Overall | Good vs not-good | Skeptic | Applies when |
|---|---|---|---|---|---|
| P10 | The step install does not do (a shell hook, a harness hook, a prerequisite) is called out at the install point | at most 10/38 (corrected; 9 without express) | split not rechecked | **did not hold as first stated**: evidence list was padded | Install alone does not give the promised outcome. Weak as a quality signal, strong as a scope-honesty rule |
| P12 | A concrete problem or worked example before the mechanism | 4 clear cases of 38 (supermemory, graphiti, browser-use, lazygit); prettier unconfirmed; zx fails the "before" test; not all 38 scanned | as extracted 5/25 vs 1/13; the skeptic confirmed only 4 cases (supermemory, graphiti, browser-use, lazygit), all in the good subset; the other extracted counts (including prettier, the 1 not-good) are unconfirmed. Quote only the 4 | holds, as a lower bound | Abstract categories (agent memory, knowledge graphs). 3 of the 4 clear cases are agent tools |
| P13 | Routes different audiences near the top | 7/38 | 4/25 vs 3/13 | holds; all 7 are ai-agent-peer (7/11 there); 0 of the 16 non-agent READMEs the skeptic scanned (the other 11 not checked) | The README serves distinct readers. A category convention, not a quality signal |
| P14 | Demos and proof are generated from source in the repo and link that source | 3/38 by the skeptic's count, but only 2 are demos (vhs, gum); the third is aider's cog-generated badges, not demos; lazygit removed | split not rechecked | **did not hold as first stated** | Samples or demos could go stale |

## Anti-patterns (counts not audited by the skeptic)

| ID | Anti-pattern | Count and examples | Why it costs readers |
|---|---|---|---|
| A1 | A full manual that exceeds the npm cut | 2/38 over 64 KB: axios (108,135 B), repomix (86,534 B); both not-good | npm readers lose the end of the file; everyone scrolls past reference to find the pitch |
| A2 | A signpost with no install command and no example | 6/38 have no install (vite, prettier, drizzle, vitest, tailwind, httpie); all not-good | The README cannot answer "what does it look like, and how do I try it?" |
| A3 | Sponsor, promo, hiring or news blocks above the pitch | 8/38 (axios, repomix, mem0, execa, lazygit, zoxide, fzf, graphiti); flagged as a weakness in all 8, including 5 good ones | Pushes what/why/try below the first screen |
| A4 | A badge wall (8 or more) | 7/38 (hono, axios, atuin, httpie, prettier, repomix, browser-use) | Noise before the value sentence; weak proof passing as evidence |
| A5 | Unsupported superlatives | flagged in 10/38, including good ones ("blazing-fast", "ultrafast", "#1" with no scores) | Skeptical readers discount the whole page |
| A6 | Samples with no output, or output that differs from a real run | no or implied output in 7; ripgrep shows a placeholder version string | The first real run looks like a bug |
| A7 | GitHub-only constructs as the only carrier of meaning | relative image with no alt (claude-code), a demo only as a bare video URL (dotenv), many `<video>` demos (lazygit), alerts in 7 READMEs | On npm or a mirror the reader may get a dead link or raw syntax |
| A8 | Hard-coded versions and model names in prose | 6/38 | The page dates itself; copy-paste commands break |
| A9 | Duplicated content | 4/38 | Wastes length; copies drift apart |
| A10 | Hero image with no alt text | 3/38 | Inaccessible, and meaningless when the image fails |
| A11 | Scope overclaim: implying install gives the outcome | mem0's headline benchmark covers the managed platform while the README installs the open-source SDK | The first run contradicts the pitch |
| A12 | Operator or edge-case detail on the quick path | codex, axios, browser-use, starship | Delays the first success for new users |

## What good looks like (corpus quotes)

Verbatim from the corpus files fetched 2026-11-22, with Markdown link and code markup stripped.
Check them before reusing: READMEs change. No README is good at everything: ripgrep's build
section shows `rg --version` printing `0.1.3`, a version long out of date (A6), and zoxide puts
two sponsor blocks above its title (A3).

- **Limits with named alternatives** (ripgrep, https://github.com/BurntSushi/ripgrep). A section
  headed "Why shouldn't I use ripgrep?" begins its list with: "You need a portable and ubiquitous
  tool. While ripgrep works on Windows, macOS and Linux, it is not ubiquitous and it does not
  conform to any standard such as POSIX. The best tool for this job is good old grep."
- **A captioned benchmark** (uv, https://github.com/astral-sh/uv). The hero chart carries the
  caption "Installing Trio's dependencies with a warm cache." The highlight "10-100x faster than
  pip" links to the benchmark page, and the first highlight names what it replaces: "A single tool
  to replace pip, pip-tools, pipx, poetry, pyenv, twine, virtualenv, and more."
- **A cheat sheet before install** (zoxide, https://github.com/ajeetdsouza/zoxide). Under "Getting
  started", one short code block where each command carries its effect as a comment: `z foo` is
  followed by "# cd into highest ranked directory matching foo", and `z -` by "# cd into previous
  directory".
- **A limit stated plainly, with named alternatives** (ora, https://github.com/sindresorhus/ora).
  Its FAQ asks "Can I display multiple spinners simultaneously?" and answers: "No. Ora is designed
  to display a single spinner at a time. For multiple concurrent progress indicators, consider
  alternatives like listr2 or spinnies."
- **Regenerable proof** (vhs, https://github.com/charmbracelet/vhs). Under the hero GIF: "The
  above example was generated with VHS (view source)", linking the tape file that produced it.
- **Scope honesty** (modelcontextprotocol/servers, https://github.com/modelcontextprotocol/servers).
  A stdio server run by hand "appears to hang. That is expected: it is waiting for a client to send
  it messages on stdin."

## Run figures (agent-notebook, 2026-11)

The skill was distilled from one run on the README of agent-notebook, a command-line store of
one-line lessons for coding agents. These figures come from that run's baseline and gap notes, not
from the corpus:

- The README at HEAD was 72,431 characters (72,986 bytes), over the 65,536-character npm cut.
- The copy already on npm, from an older version, was exactly 65,536 characters (66,053 UTF-8
  bytes) and ended inside an unclosed code fence; Status, Changelog, Contributing and License were
  past the cut in the registry copy.
- The first screen (lines 1-29) landed about 1.5 of the launch film's 11 beats: no beat landed
  fully and three landed partly, counting a full landing as 1 and a partial one as 0.5.
- The pitch said the agent remembers, while the tool is a store a harness must drive (hard rule 3).
- Sample output left out two lines that a real run prints.
- Several tests pinned README text (environment variable names, image paths, an anchor id), which
  shaped the plan before any rewrite.

## Literature (tags: empirical, official doc, practitioner, unverified)

- **Correlational studies. None tested causation.**
  - Prana et al. 2018 classified 4,226 README sections from 393 repos [empirical]
    https://arxiv.org/abs/1802.06997
  - Venigalla and Chimalakonda 2022 (1,950 READMEs) linked organization, images and external links
    to popularity [empirical, correlational] https://arxiv.org/abs/2206.10772
  - Liu, Noei and Lyons 2022 (14,901 Java repos) linked following GitHub's guidance, usage,
    install, code snippets and images to more stars [empirical, correlational]
    https://enoei.github.io/papers/liu2022readme.pdf
  - Wang et al. 2023 found most README factors related to popularity; only a snippet was read
    [empirical] https://petertsehsun.github.io/papers/jss_2023_readme.pdf
- **GitHub** says a README should cover what the project does, why it is useful, how to start,
  where to get help and who maintains it, and should link out to longer docs [official doc]
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes
- **Standard Readme** requires a short description, install, usage, contributing and license
  [official doc for the spec; no evidence it affects adoption]
  https://github.com/RichardLitt/standard-readme/blob/main/spec.md
- **Make a README** says "too long is better than too short" [practitioner]
  https://www.makeareadme.com/. GitHub and Standard Readme push the other way. The corpus is
  consistent with the middle band (P4, as extracted), which is why this skill recommends it; it is
  not proof.
- **Diátaxis** separates tutorials, how-to guides, reference and explanation [practitioner]
  https://diataxis.fr/. It says nothing about READMEs; using it to decide what leaves the README is
  this skill's inference.
- **Show HN rules**: something people can run, easy to try without sign-up, explain how and why
  you built it [official doc] https://news.ycombinator.com/showhn.html. Launch-day advice (a demo
  in the first seconds, a terminal GIF under about 1 MB) is practitioner opinion, not measured.
  Nothing links a README or launch tactic to Hacker News rank or stars.
