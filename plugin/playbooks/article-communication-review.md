---
name: Article Communication Review
description: Iteratively drive a paper/article to expert-quality communication — fan out lens-focused reviewer subagents over rounds, triage, apply rigor-preserving edits, converge
parameters:
  - name: articlePath
    description: "Path to the canonical source document to improve (e.g. analysis/article-v2/manuscript.md). Relative to the launch CWD, or absolute."
    required: true
  - name: rounds
    description: "Maximum review rounds before stopping for user review"
    required: false
    default: "3"
    type: select
    options:
      - label: "2 (quick)"
        value: "2"
      - label: "3 (recommended)"
        value: "3"
      - label: "4 (thorough)"
        value: "4"
  - name: maxLensesPerRound
    description: "Hard cap on reviewer subagents (lenses) launched per round. 3–5 is the sweet spot; more is diminishing returns and multiplied cost."
    required: false
    default: "5"
  - name: buildCommand
    description: "Optional command to regenerate rendered outputs (HTML/PDF) after edits, run from the document's directory (e.g. 'python3 src/build.py all'). Leave blank if the source needs no build."
    required: false
    default: ""
  - name: audience
    description: "Who the document must land for (free text). Default assumes a technical paper that must also be graspable by a smart non-specialist skimming in seconds."
    required: false
    default: "The paper's technical peers AND a smart non-specialist who must grasp the message and main result in seconds."
checklist:
  - Read the document and assembled a shared pack (thesis, audience, load-bearing claims/scope)
  - Ran at least two rounds of parallel lens-focused reviewers, covering the lens catalog with overlap across the scheduled rounds (full coverage at rounds ≥ 3)
  - Triaged findings, applied only rigor-preserving edits, routed claim concerns to the user
  - Ran the rigor-sentinel pass — confirmed no edit weakened a claim or dropped a caveat/scope tag
  - Rebuilt rendered outputs (if a build command was given) and verified they build
  - Opened or updated a PR and stopped for user review (no auto-merge of the manuscript)

---

## Objective

Make `{{articlePath}}` **excellent to read** — clear and skimmable for its
audience, well signposted, concise, and visually communicative — **without
changing a single claim or how far it reaches.** Do this by fanning out
independent, lens-focused reviewers over several rounds, triaging their
feedback, and applying only the fixes that preserve meaning.

The reviewer each subagent uses is the `kookr-toolkit:communication-quality-review`
skill. Its **prime directive governs this whole loop**: clarity relocates and
sharpens facts; it never drops, weakens, or strengthens them. Any proposed
change that would shift a claim's strength or scope is **not** applied here —
it is surfaced to the user as a claim concern.

## Context

- **Document:** `{{articlePath}}` — the *canonical source*. If the project
  renders other formats (HTML/PDF/LaTeX) from it, those are regenerated, never
  hand-edited.
- **Audience:** `{{audience}}`
- **Build command (optional):** `{{buildCommand}}`
- **The reviewer skill:** `kookr-toolkit:communication-quality-review` — read its
  lens catalog and output contract; this playbook orchestrates it.
- **Model:** this is quality-critical reading and editing. Launch with a capable
  default agent; **do not** use the small model tier.

### The lens catalog (from the reviewer skill)

`first-contact`, `narrative-arc`, `structure-signposting`, `cohesion-flow`,
`hard-ideas-intuition`, `jargon-notation`, `concision-load`,
`rigor-accessibility`, `visuals-figures`, `audience-tone`,
`high-leverage-parts` (title/abstract/intro-close/conclusion),
`coherence-consistency`.

## Phase 0 — Setup and the shared pack

1. **Work in a branch, and resolve the document inside it.** If the launch CWD
   is a git repo, work in a dedicated worktree:
   - **First run:** `git fetch origin <default-branch>` then
     `git worktree add ../<repo>-commq-review -b article/communication-review origin/<default-branch>`.
   - **Resume** (the branch already exists from an earlier run — see idempotency):
     attach to it instead of recreating it:
     `git worktree add ../<repo>-commq-review article/communication-review`
     (no `-b`). Do **not** re-run the `-b` form; it fails when the branch exists.

   From here on, **resolve `{{articlePath}}` inside that worktree** — every read,
   edit, reviewer prompt, build, and the rigor-sentinel diff operates on the
   worktree copy, never the original checkout, so the edit target and the review
   target are always the same file. If `{{articlePath}}` is not in a git repo,
   edit in place and skip the worktree and PR steps.
2. **Read `{{articlePath}}` completely.** Note the rendered outputs and how they
   are built (look for a build script near the document).
3. **Assemble the shared pack** (reuse it verbatim for every reviewer, every
   round). It contains:
   - **Thesis & audience** — the paper's one real message, and `{{audience}}`.
   - **Load-bearing claims & scope tags** — the handful of claims the paper
     stakes itself on, each with its exact reach ("proved any-n", "measured at
     n=2", "conjecture", "theory-only"). This list is what reviewers must
     protect: it tells them which words are caveats, not clutter.
   - **Figure inventory** — what each figure/diagram is and the message it
     carries.
   The pack is **orientation to verify, not settled fact** — reviewers re-read
   the source for anything they rely on.

## Phase 1..N — Review rounds (repeat up to `{{rounds}}` times)

Each round:

1. **Select the round's lenses.** Launch **3–5** reviewers (hard cap
   `{{maxLensesPerRound}}`). Across rounds, **rotate** with deliberate overlap on
   the highest-leverage lenses (`first-contact`, `rigor-accessibility`,
   `high-leverage-parts`). A **full run (`rounds` ≥ 3) exercises every lens at
   least once**; the default schedule:
   - **Round 1:** `first-contact`, `narrative-arc`, `structure-signposting`,
     `concision-load`, `rigor-accessibility`.
   - **Round 2:** `cohesion-flow`, `jargon-notation`, `hard-ideas-intuition`,
     `visuals-figures`, `high-leverage-parts`.
   - **Round 3+:** `coherence-consistency`, `audience-tone`, plus a re-run of
     `first-contact` and `rigor-accessibility` on the *revised* document to
     confirm the edits landed and nothing regressed.

   **If `rounds` is 2** (or a round converges early, below), full catalog
   coverage is not reached by this schedule. To still cover it, fold
   `coherence-consistency` into Round 2 (drop one lower-priority Round-2 lens to
   respect the cap); `audience-tone` may then go unrun — accept that narrower
   coverage, or raise `rounds` to 3+. State in the round log which lenses the run
   did and did not reach.
2. **Spawn the reviewers in parallel.** Use the Agent tool, one `general-purpose`
   subagent per lens, all in one message. Each prompt must:
   - name the single lens (from the catalog);
   - instruct: *"Load the `kookr-toolkit:communication-quality-review` skill and
     review the document at `{{articlePath}}` through the `<lens>` lens only.
     Return exactly the skill's output contract."*;
   - paste the **shared pack** verbatim, marked "orientation to verify, not
     settled fact";
   - state the audience `{{audience}}`.
3. **Collect** every reviewer's output-contract block.
4. **Triage** (you, the orchestrator):
   - **Cluster** overlapping findings across lenses into one item each (overlap
     is a *confidence signal*, not duplication to pad the list).
   - **Rank** by severity × reader-payoff (blockers and majors first).
   - For each item, decide **apply / defer / reject-with-reason / route-to-user**.
   - **Apply only meaning-preserving edits** directly to `{{articlePath}}`.
     Before applying, run the prime-directive check on the edit itself.
   - **Route to the user, do NOT apply,** any finding whose fix would change a
     claim's strength or scope, or any reviewer `out-of-lens: claim concern`.
     Collect these in a "Claim concerns for the author" list.
5. **Rebuild & verify.** If `{{buildCommand}}` is set, run it from the document's
   directory and confirm the rendered outputs build cleanly. If edits added or
   changed figures, regenerate them too.
6. **Record the round** — a short note (round N: lenses run, which catalog lenses
   are still unreached, items applied, deferred, routed; build status). Append it
   to a review log beside the document and **commit it** each round, so the log
   survives a fresh worktree and a resume can continue from it.
7. **Convergence check.** Stop iterating early if a round surfaces **no blocker
   or major** finding across all its lenses (polish-only). Otherwise continue to
   the next round, up to `{{rounds}}`.

## Phase N+1 — Rigor-sentinel pass (MANDATORY, runs once at the end)

Before presenting, run **one** final `rigor-accessibility`-lens reviewer whose
sole job is to **audit the cumulative edits against the shared pack's
load-bearing claims**: did any round's clarity edit drop a scope tag, soften an
"only", strengthen a "suggests" into a "shows", or quietly widen a result's
reach? Give it the *diff* (`git diff origin/<default-branch>...HEAD --
{{articlePath}}`) plus the pack. Treat any confirmed regression as a **blocker**:
fix it to restore the exact original claim strength before presenting. This pass
is the honesty gate — it is not optional and it never counts against the
per-round lens cap.

## Phase N+2 — Present to the user (STOP here)

1. **Summarize the run:** rounds, lenses per round, the top improvements made,
   what the rigor-sentinel found, and what was deferred.
2. **List "Claim concerns for the author"** — every finding routed out as a
   possible claim/scope issue, for the user to judge. These were **not** applied.
3. If working in a git repo: **commit, push, and open (or update) a PR**, then
   **stop**. **Do not merge** — a manuscript's claims are the author's call.
4. Point the user at the rendered output (and build status) so they can read the
   result.

Wait for the user's direction (approve, request more rounds, or hand-apply the
claim-concern items) before merging or taking any further action.

## Idempotency Rules

1. **Re-runnable:** re-launching resumes on the same `article/communication-review`
   branch and PR if they exist (match by branch name); it does not open a second
   PR. Continue from the recorded round log rather than restarting at round 1.
2. **Source is canonical:** only ever hand-edit `{{articlePath}}`; regenerate all
   rendered formats with `{{buildCommand}}`. Never edit generated HTML/PDF/TeX
   directly.
3. **Deterministic figures:** if the project's figure scripts embed timestamps or
   random ids, prefer regenerating through the project's own build so diffs stay
   meaningful; do not hand-edit figure files.

## Anti-Patterns

- **Don't let clarity cost rigor.** The prime directive is the whole point. A
  cleaner sentence that reaches further than the evidence is a regression — route
  it to the user, never ship it.
- **Don't auto-merge the manuscript.** Claims are the author's call; stop at the PR.
- **Don't exceed the lens cap for breadth.** 3–5 lenses per round; rotate to cover
  the catalog over rounds. More reviewers at once is cost, not quality.
- **Don't collapse useful overlap into "duplicate".** Two lenses flagging the same
  passage is a strong signal to fix it, not noise to trim.
- **Don't rubber-stamp reviewer output.** Each finding is evaluated; reject the
  inapplicable ones with a reason. Reviewers can be wrong or out of scope.
- **Don't iterate forever.** Converge when a round is polish-only; run the
  rigor-sentinel pass; present. Re-launch for more rounds only if the user asks.
- **Don't use the small model tier** for this loop — it is quality-critical
  reading and editing.
