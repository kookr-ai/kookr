# README scoring rubric

Use this to score a README before and after a round, so the operator sees movement in one table.
The pattern IDs point at `evidence.md`, which holds the counts and their caveats. The scores are a
reviewing aid, not a measurement: nothing shows that a higher score causes adoption.

**Scoring.** Score each of the 13 dimensions 0, 1, 2 or N/A:

- **2** = the "Pass" column holds in full.
- **1** = partly met: some of the pass description holds, or it holds on one of two surfaces (for
  example on GitHub but not on npm).
- **0** = absent or contradicted.
- **N/A** = the "Applies when" condition in `evidence.md` of the pattern the dimension cites fails
  for this project, or the dimension's surface does not exist (for example the npm parts of
  dimensions 8 and 13 for a project not on npm). Say why.

Report the total as points over 2 × the number of scored dimensions (26 when all 13 are scored),
and list the N/A ones, so a before/after pair stays comparable. Dimension 5 is never N/A.

**The honesty cap.** Dimension 5 scores 0 or 1 when any sample is unlabelled and not from a real
run, or any claim is false at HEAD. A dimension-5 score of 0 or 1 caps the total at half the
possible points, whatever the other scores.

**Not all points carry the same evidence.** Dimension 2 rests on P12 (weak), the audience-routing
part of dimension 9 on P13 (a category convention), and dimension 13 on no corpus evidence at
all. Do not present their points as evidence-backed.

"First screen" is defined in `SKILL.md` (Terms): the rendered page when you can view it, otherwise
the first 30 source lines plus a count of their media blocks (both working conventions, not
measured); say which you used. "Two screens" is twice that measure (about 60 source lines).

| # | Dimension | Pass (2) looks like | How to check | Common failure |
|---|---|---|---|---|
| 1 | What and who, first screen | One plain sentence says what it is and does; a second says who it is for. Both come before badges or promo content | Read only the first screen. Can you say what it is, who it is for and how to try it, in one breath? | A three-word tagline; a category label with no picture; a superlative instead of a definition |
| 2 | Problem and mental model | A concrete problem or worked example first, then a short loop (no measured threshold) or one small pre-rendered diagram (P12) | Does a concrete scenario (who hits what, when) appear before mechanism words? | Opening on the mechanism; a diagram that shows only on GitHub |
| 3 | Visible result | Real output is visible without running anything: text under the command, or a visual of real output (P2) | Is every command in the first two screens followed by its output or a visual of it? | Commands with no output |
| 4 | Time to first success | Install, the first command and its shown result sit within about two screens. A step install does not cover is called out at the install point (P1, P10). Command-only blocks carry no `$` prompt characters (a convention, not corpus-backed); where a block mixes command and output, either keep the prompt marker, or use one fence for the command and a second for the output. Do not remove `$` from a mixed block | Count steps from install to the first visible result. Look for the "install alone is not enough" note beside the install command | No install; a required hook mentioned 40 lines later |
| 5 | Honesty and accuracy (gate) | Every shown output is verbatim from a real run of the current version, or marked abridged or illustrative. Every capability claim matches the code. Scope caveats sit next to the claim | Run each safe sample (`SKILL.md` hard rule 1) in a scratch directory and diff it against the README block; mark the others "not run". Grep claim words (always, never, remembers, automatically) and check each against the code. Run the tests that pin README text | Omitted output lines; stale "may add" wording for a shipped feature; a claim true only with optional setup (A6, A11) |
| 6 | Proof | Any number names its workload or method, is dated, or links a way to reproduce it. A demo links its source. Having no numbers is fine (P8, P14) | For each number or superlative, find the method or link. None: delete it | "blazing", "#1" with no data (A5); a joke badge as proof |
| 7 | Positioning and limits | Says what it is not for and when to use something else, naming the alternative (P6, P7) | Is there a "when not to use this" passage that names the alternative? | Implicit differentiation only; defensive positioning before the reader knows what the tool does |
| 8 | Scope and length | Neither a signpost nor a manual (P4): pitch, quick start, a short usage reference and a docs map. Operator and integrator reference is linked out (an inference from Diátaxis, not P4). For an npm package, under 65,536 characters (treated as binding until observed otherwise; the largest good README is 42,726 bytes) | `wc -m README.md`. Tag each section by audience | A manual-length README (A1); a thin signpost with no code (A2) |
| 9 | Navigation and routing | A doc map with one line per guide. Audience routes where readers really differ (P13). Headings nest cleanly; inbound anchors stay stable or their linkers are updated. License, contributing path and (if it handles untrusted input) a security contact are linked | Click every in-page and inbound anchor. `git grep -nE 'README(\.md)?#'` across the repo | Renamed headings that break docs links |
| 10 | Render portability and accessibility | Absolute image URLs. No meaning carried only by mermaid, video, alerts or `<details>` (A7; see `two-renderers.md`). Every image that carries a fact has alt text that states it (A10) | Run the checks in `two-renderers.md` | A bare video URL as the only demo; a raw mermaid block; a cut-off code fence |
| 11 | First-screen hygiene | No sponsor, promo, news or hiring block and no badge wall above the pitch. Badges show real, live data only, from a service that exists for this repo; a CI badge points at the default branch and is green (A3, A4; hygiene, and the 8-badge threshold is a convention) | Count badges and promo lines before the first pitch sentence | A3, A4 |
| 12 | Freshness and maintainability | No hard-coded versions or model names in prose. Samples pinned by tests or generated from source. No duplicated blocks (A8, A9) | Grep version-like strings and model names. Check which samples a test covers | A8, A9 |
| 13 | Discovery metadata | The GitHub About line, topics, homepage link and npm `description` and `keywords` name the problem in the words a searcher would use, and claim no more than the README does. Not corpus-backed: a convention, see `evidence.md` | `gh repo view --json description,repositoryTopics,homepageUrl,openGraphImageUrl,usesCustomOpenGraphImage` and `npm view <pkg> description keywords repository homepage bugs`. `repositoryTopics: null` means no topics | No About line or topics; an npm description that copies the title or overclaims |
