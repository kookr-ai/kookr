# Evidence Pack — Review-Gate Consolidation RFC

> Shared evidence pack for the `rfc-review-gate-consolidation` critic panel.
> **This is evidence to check, not settled fact.** Every claim below was
> gathered by pre-panel investigation (three parallel sonnet/high-effort
> agents over the repo, local Claude/Codex transcripts, and the last ~600
> kookr-ai/kookr PRs). Re-read any cited source before you lean on it. Line
> numbers are from `origin/main` (worktree `../kookr-review-dedup`, HEAD
> `45fd2356`).
>
> ### ⚠️ Corrections from the post-round-1 empirical checkpoint (2026-10-10)
> A `design-experimenter` probe re-sliced the 591 verdicts by *implementer*
> vendor and **falsified** the cross-vendor claim. Corrections, which override
> the original §1/§2 wording below:
> - **Cross-vendor does NOT block more.** The Codex lane's higher block rate is
>   concentrated in the **same-vendor** cell (Codex reviewing mostly
>   Codex-implemented PRs: 7.8%); on Claude-implemented PRs the Codex lane
>   blocks at 2.7% ≈ the Claude lane. Pooled same-vs-cross-vendor first-verdict
>   block rate: 5.6% vs 3.1%, Fisher p=0.20 — not significant, direction flips
>   with how mixed-authorship PRs are classed. The 11%-vs-2.4% lane gap is a
>   **lane-level** effect (reviewer strictness / PR size: Codex-lane PRs mean
>   505 vs 357 lines; blocks concentrate in large PRs), not vendor independence.
> - **#3375 was fully same-vendor** (Codex implementer, Codex pre-push panel,
>   Codex merge reviewer). What caught the bugs was **fresh context + exact
>   head + prompt/effort**, NOT cross-vendor review. The §2 "smoking gun"
>   wording ("same-vendor panel missed what the cross-vendor reviewer caught")
>   is wrong and is retracted.
> - **24 blocked PRs / 34 blocks** (not 26). ~17 (71%) are code defects a
>   correctness specialist targets; ~7 are docs/playbook/spec it does not.
>   Of the 17, roughly half were caught by a **same-vendor** reviewer; at most
>   7–8 were clearly cross-vendor.
> - **Dead code CONFIRMED:** `buildSpecialistLaunch`,
>   `createReviewerFanoutWorkflow`, `aggregateReviewerRuns` have **no non-test
>   caller** — the live spawn path is the inline `Agent({...})` template in
>   `pre-pr-review` SKILL.md:353-356.
> - **Timeouts rare:** hard-gate 2/600; advisory Lucy 18/971 (1.9%) — but 14%
>   of Lucy merges carried **no verdict and no timeout label at all** (the real
>   O3 gap).
> - **The redundancy premise remains UNPROVEN:** there is still no same-PR
>   measurement that pre-push correctness is a subset of merge-review findings.
>   (And a valid such test must run *both passes at the same head* — a
>   pre-push-caught-and-fixed defect is absent from the final merge head, so a
>   different-head comparison trivially reads "complementary".)
> - **Classifier is NOT triplicated.** There is exactly **one** shell
>   classifier using the advisory grep (`hooks/gh-pr-merge-gate.sh:60`) plus a
>   prose snippet in `independent-merge-review` SKILL.md. `scripts/kookr-merge.sh`
>   is **hard-only** (no advisory logic; it keys on `KOOKR_MERGE_REQUIRE_REVIEW`).
>   The original §1 "triplicated" framing is overstated.

---

## 1. Pipeline map — the two review stages

Kookr runs **two distinct LLM code-review passes** around an autonomous
delivery, plus a deterministic hook that is *not* a reviewer.

### Stage 1 — Pre-push reviewer panel (`pre-pr-review` §8)

- Composed by the `kookr-pre-push` skill and gated by the `.hooks/pre-push`
  git hook. `CLAUDE.md:143` tells agents to run `kookr-pre-push` before a
  non-trivial push.
- The git hook (`.hooks/pre-push`) does **not** spawn reviewers. It blocks the
  push until a valid HMAC-signed marker exists at
  `.review-state/<branch-key>.json` (SHA must equal HEAD; any amend
  invalidates it), then runs **deterministic** gates: shell-portability,
  `pnpm build:server`, `pnpm check:e2e`, `pnpm validate:*`, `pnpm test`, FAA
  gate, plugin hygiene, `plugin.json` version-bump check. The marker is
  written by `scripts/write-review-state-marker.sh` after the skill's panel
  runs.
- The panel itself is spawned by the `pre-pr-review` skill, **diff-adaptive**
  (issue #1305, `select-specialists.sh`):
  - `correctness` — **always**, unconditional (`pre-pr-review` SKILL.md:252).
  - `lint-like` — on any change; one agent folding `conventions` + `deadcode`
    (+ `docs-drift` when active) with per-concern verdicts (L254).
  - `test` — when a non-test, non-doc source file changed (L253).
  - `--force` / `FORCE_FULL_PANEL=1` restores an un-consolidated 5-panel
    (L268-271).
  - Layer-2 `kookr-toolkit:*` architecture agents added by change type
    (L336-346); `a11y` for UI diffs.
- **Model/effort:** Layer-1 specialists are spawned as
  `Agent({ subagent_type: "general-purpose", … })` (L353-356). **No `model`
  or `effort` is set** anywhere in the skill, the specialist `.md` files,
  `select-specialists.sh`, `src/shared/contracts/reviewer-fanout.ts`, or
  `src/core/reviewer-fanout.ts` (the lone "model" hit at
  `reviewer-fanout.ts:5` is the English word in a comment). They inherit the
  harness default — **`claude-opus-4-8` in practice** across local transcripts.
- **Context loading:** each specialist re-reads independently. The spawn
  inlines a ~2KB prompt + the diff is referenced, and every specialist is
  told to explore the checkout itself — e.g. `correctness-specialist.md:5-8`
  ("full repository checkout … Read the complete file … Grep for callers …
  Trace data flow across files") plus a mandatory per-finding re-Read. There
  is **no shared context cache** between siblings in the base skill. The one
  mitigation (`kookr context-pack --review-out`, `renderReviewPack` at
  `src/core/context-pack.ts`) is wired into **only** the `parallel-issue-batch`
  playbook, not the base skill.

### Stage 2 — Independent merge review (`independent-merge-review`)

- Runs **before an autonomous self-merge** (`implement-github-issue` Phase 8,
  `parallel-issue-batch` Phase 5, `kookr-post-push` step 6).
- Origin: issue #1717 — "Autonomous batches were merging PRs in ~1 minute with
  **zero** review activity" (SKILL.md:16-21).
- Reviewer lane: **Codex primary, Claude fallback** (SKILL.md:122-135).
- Reviewer runs in a **fresh context with no shared session** with the
  implementer — sees diff + issue + repo, not the implementer's reasoning
  (SKILL.md:137-143). This is the independence pre-push lacks.
- **Reuses the same prompt file** as pre-push: "Reuse the reviewer-specialist
  prompts (`plugin/reviewer-specialists/`), **at minimum
  `correctness-specialist.md`**" (SKILL.md:145-146).
- Verdict: **BLOCK** only on a *confirmed* correctness/safety defect with a
  concrete failure scenario; nits/suggestions stay PASS (SKILL.md:156-160).
- **Bound to the exact final head** (`review-head-sha:`), posted as a PR
  comment (`src/core/independent-review.ts` literals). A fix changes the head
  and requires a fresh verdict (SKILL.md:184-188).
- **Repo policy split (issue #3027 / PR #3030):** hard gate on
  `kookr-ai/kookr` (`scripts/kookr-merge.sh` exit 4 without a `pass` for the
  exact head; also enforced by `hooks/gh-pr-merge-gate.sh`); advisory on repos
  whose CLAUDE.md/AGENTS.md says "independent review is advisory"
  (SKILL.md:23-60).
- `autonomous-review-loop` wraps it: ≤10 correction/review iterations per
  unit; a PASS counts only if machine-readable, independent, and bound to the
  exact head.

### The overlap (the redundancy)

`correctness` is run in **both** stages, from the **same** `correctness-specialist.md`
prompt, on **different heads** (pre-push head vs final merge head). No repo file
asserts this is redundant; it is an inference from the two skills reusing the
same prompt. The non-correctness pre-push lanes (`lint-like`, `test`, `docs-drift`)
are **not** duplicated by the merge review (correctness-only).

---

## 2. Telemetry / measurements

Sources: 60 reviewer-fanout subagent transcripts in the kookr project
(2026-09-10 → 10-09, 147 across all projects); 8 Claude-lane merge reviews;
41 Codex-lane reviewer sessions; `kookr-review-verdict` lines from the last
~600 kookr-ai/kookr PRs (created 2026-08-11 → 10-09). Token figures are
raw counts / unit-weighted, not dollars (Opus 4.8 prices unknown).

### Pre-push panel (Stage 1) — most token waste; parallel/off-critical-path, prevention-oriented

> ⚠️ **Commensurability caveat (consensus-attack, 2026-10-10):** the
> "expensive/low-yield" vs "cheap/high-yield" labeling below ranks the two
> stages on a single token-and-blocking-defect ruler. They are **not
> commensurable**: Stage 1 is a *parallel, off-critical-path* fan-out whose
> output is ~80% non-blocking improvement edits; Stage 2 is a *sequential,
> gated, on-critical-path* final block whose catches are conditional on Stage 1
> having run. Read the tables as token/throughput data, not as a verdict that
> one stage should replace the other — and note tokens ignore wall-clock, which
> the operator also asked about.

| Measure | Value |
|---|---|
| Panel size | **Median 3** agents/task (correctness, lint-like, test); 4 with a11y. No 5-agent panels observed in kookr — adaptive gating works. |
| Context tokens/agent | Median **451k** (correctness heaviest at 560k); output 7.8k; ~8 turns. ~90% is cache-read (the agent re-reading its own growing context). |
| Tokens/panel | Median **1.34M** context, 25k output. 17 panels = 27.5M context, 466k output. |
| Per-agent cold baseline | 28k tokens first-turn (system prompt + tools) before any work — paid **once per agent**, so a 3-agent panel pays it 3×. |
| Duplicated cross-agent context | **27.5%** of ≥400-char tool-result bytes byte-identical across sibling agents (lower bound; line-range overlaps don't byte-match). 41–53% in 5 panels; ~22% of file reads are repeats. |
| Share of task cost | Reviewers ≈ **13%** of combined parent+subagent weighted spend. |
| On PR #3375 (Codex lane) | Pre-push panel (8 agents) = **27.0M input** vs merge review (5 runs) = 5.4M — pre-push ≈ **5× the merge-review input**. |

**Value produced (Stage 1):** overwhelmingly nits/suggestions and
test-gap/stale-comment/docs-drift notes. In the kookr sample, **only 2
blocking findings** total (both on one branch, `rfc/transcript-capture`).
12 of 15 traced panels were followed by Edit/Write before push, but "almost
none were bug fixes" — mostly added tests, fixed stale comments, aria tweaks.
Siblings sometimes flag the **same** item (e.g. #3115 correctness + lint-like
both flagged the same dead export).

### Independent merge review (Stage 2) — fewer tokens, records the catches; sequential/on-critical-path (see caveat above)

| Measure | Value |
|---|---|
| Coverage | 545 / 596 merged PRs carry ≥1 verdict comment. |
| Verdicts | 591 total: **557 pass, 34 block (5.8% block rate)**. |
| By lane | claude 359 pass / 9 block (**2.4%**); **codex 192 pass / 24 block (≈11%)**; grok 6/1. Cross-vendor Codex blocks ~4.5× more often. |
| PRs blocked | 26 PRs (4.8%) got ≥1 block; ~20 of 26 are real code defects **with a reproduction** (auth bypass, crash, data loss, unbounded allocation). 3 took 3–4 blocks before pass (#3375, #3145, #2855). |
| Cost/run | Claude lane median **304k** context / 6.3k output / ~90s — ≈ **0.23× one pre-push panel**. Codex lane median 2.9M input (~95% cached) / 11.8k output. |

**Smoking gun (#3375):** the 7-agent pre-push panel + implementation-review
**passed**; the independent reviewer then found an **unauthenticated proxy
auth bypass** (list/download/export/delete private data, reproduced HTTP 200),
a **crash** (`//[` URL), and a **data-loss** bug — over 3 blocking rounds. A
same-vendor pre-push panel missed what the cross-vendor independent reviewer
caught.

**Honest caveat:** among the 16 PRs whose Claude pre-push panels were locally
inspectable, the merge reviewer passed all first time (small, mostly-Claude
population) — so "merge review routinely catches what pre-push misses" is
proven on #3375 but not established at scale; most blocked PRs were Codex
implementer sessions with encrypted/unreadable pre-push transcripts. There is
**no direct same-PR count** of pre-push findings vs merge-review findings.

---

## 3. Source pointers (for re-verification)

| Claim | Source |
|---|---|
| Pre-push panel composition / "correctness always" | `plugin/skills/pre-pr-review/SKILL.md:219-368`, esp. 252-266 |
| Panel spawned as `general-purpose`, no model/effort | `pre-pr-review` SKILL.md:353-356; grep of `select-specialists.sh`, `reviewer-fanout.ts` |
| Each specialist re-reads the repo | `plugin/reviewer-specialists/correctness-specialist.md:5-8`, `deadcode-specialist.md`, `docs-drift-specialist.md` |
| context-pack mitigation only in one playbook | `src/core/context-pack.ts` (`renderReviewPack`); `plugin/playbooks/parallel-issue-batch.md` |
| Merge review reuses `correctness-specialist.md` | `plugin/skills/independent-merge-review/SKILL.md:145-146 |
| Merge review fresh-context, exact-head, Codex-primary | `independent-merge-review` SKILL.md:122-160; `src/core/independent-review.ts` |
| Hard/advisory split | `independent-merge-review` SKILL.md:23-60 (#3027/#3030) |
| Hard-gate enforcement | `scripts/kookr-merge.sh` (`require_review_verdict`, exit 4); `hooks/gh-pr-merge-gate.sh` |
| Correction-loop cap (10) | `plugin/skills/autonomous-review-loop/SKILL.md:10-42` |
| Deterministic pre-push gates | `.hooks/pre-push` (build/test/validate/FAA/plugin hygiene) |
| CI disabled — local verification is the gate | `CLAUDE.md:50-82` |
| Prior art: layers are "complementary" | issue #1717; `plugin/playbooks/independent-verification-lane.md:60` |
