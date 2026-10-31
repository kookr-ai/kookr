# RFC: Finish the Agent-Notebook shelf migration (instrument, de-duplicate, seed)

## Status

**Draft v2 — post-round-1 critic panel (design-minimalist, boundary-critic,
delivery-pragmatist, socratic-challenger, failure-mode-analyst)**
**Date:** 2026-10-31
**Author:** Jean Ibarz (with Claude)

**Major revisions in v2 (round-1 incorporation):**
- **Reframed the thesis.** The root cause is not a stale *value* (the `200`-line
  cap) but **duplication**: tool-owned facts (the cap, the eviction rule, the word
  for the unit) are copied into ~30 harness files, so they drift. The fix removes
  the copies, it does not correct them in place. (design-minimalist, boundary-critic)
- **New Slice A — set `NB_SESSION`.** Three critics independently found that
  `NB_SESSION` is unset everywhere, so co-access is **never computed** and every
  session-aware signal the redesign added (surfacing coverage/recall-miss,
  browse-without-use, failed-search, voted-eviction attribution) is dark. Without
  it the whole "group by co-access" premise is unmeasurable and the old Slice 3
  evidence gate is vacuous. Verified a one-line, safe fix exists. (socratic-challenger,
  delivery-pragmatist, failure-mode-analyst)
- **Consolidation (old Slice 3) is DEFERRED, not scheduled.** failure-mode-analyst
  proved there is **no cross-shelf move primitive** (`nb merge` is single-shelf);
  the only path, add+rm, **resets a lesson's score to +1**, so FR-3 "no loss of a
  voted lesson" is violated by the only available mechanism. delivery-pragmatist
  proved a folded `@project` shelf is **silently recreated** by exact-string
  callers in `reviewer-fanout.ts`/`agent-launch-context.ts`. Consolidation now has
  explicit unblock-conditions instead of a hand-wavy `nb stats` gate.
- **Widened the docs scope.** The role/cap text also lives in **6
  `plugin/reviewer-specialists/*.md`** and a prompt string in
  **`reviewer-fanout.ts`** — not just the 23 agent docs. (delivery, boundary)
- **Descriptions come from a versioned seed** (`plugin/notebooks/shelves.json` +
  idempotent apply), not hand-typed `nb describe` calls — because `nb describe`
  **exits 0 and creates a described orphan on a typo**, polluting the very index
  we are cleaning. (boundary-critic, failure-mode-analyst)
- Dropped the heavy FR/NG scaffolding and the `plugin.json` row (that file's
  version is the plugin's own, not the dependency).

---

## Problem

The public `agent-notebook` tool changed its organising concept: it no longer
groups lessons by **agent role** but by **shelf** = lessons an agent *co-accesses*
in the same situation, chosen from an index by a one-line `# desc:` trigger
("open me when…"). `role` is a **deprecated alias** (upstream v0.4.0 / #101).

Kookr's PR #3465 (`422c98a4`, on `main`) adopted the **mechanism**: role-agnostic
`nb list` index injection at SessionStart, a role-agnostic retro hook, and a
package bump `0.1.3 → 0.3.0` (recency eviction, 50-line default cap,
list/search/describe/split). But the migration stopped at the mechanism and left
three gaps, each of which makes the adopted mechanism not actually deliver what
the redesign promises.

### Gap 1 — Tool-owned facts are duplicated across the harness, so they drift

Every one of the 23 `plugin/agents/*.md` opens with:

> *Your notebook **role** is `change-verifier` — a bounded, voted store of one-line
> lessons (**≤200 lines** × ≤200 chars; lowest-scored evicted when full).*

Three things are wrong, but the *value* ("200") is only the symptom. The **cause**
is that the tool's definition of a shelf — its cap, its eviction rule, the very
word for the unit — is **copied into the harness** instead of owned by the tool.
The default cap became **50** in 0.3.0 (the package the harness already ships), so
all 23 docs now overstate their budget 4×. The same stale `≤200`-char/line text
also lives in **6 `plugin/reviewer-specialists/*.md`** (a11y, conventions,
correctness, deadcode, docs-drift, test) and in a **prompt string in
`src/shared/contracts/reviewer-fanout.ts`**. Correcting "200→50" in ~30 places
just reloads the same gun: the next upstream cap change re-breaks all of them.

### Gap 2 — `NB_SESSION` is unset, so co-access is never computed (the instrument is missing)

The redesign's whole premise — group by *co-access*, and measure whether the
notebook is *surfacing* — is **session-aware**. The tool computes co-access and
all its diagnostic/surfacing signals only over calls that carry an `NB_SESSION`.
`NB_SESSION` is **set nowhere** in `src/`, `bin/`, or `plugin/`. Consequences,
verified against the live store:

- `nb stats` reports *"surfacing: no engaged sessions in this window (set
  NB_SESSION and vote to measure)"*.
- co-access — the grouping principle the migration is named after — **cannot be
  observed at all**.
- the signals the redesign added (coverage, recall-miss, browse-without-use,
  vote-reversal, failed-search) never fire.

So today the reorg can only ever be "words in the files": there is no instrument
to tell whether any shelf is surfacing, mis-aimed, or redundant. **This is the gap
that most makes kookr out-of-date with the redesign**, and it is the prerequisite
for deciding any consolidation on evidence rather than by eye.

### Gap 3 — The store is shaped like the role era

The live store `~/.kookr/notebooks` holds **~29** notebooks (it takes live writes
continuously — this very review added critic shelves to it mid-session) and
**none** carries a `# desc:` trigger, so every injected index row falls back to
`(auto)` (its top lesson) and the agent chooses by a lesson fragment, not by a
situation. **15** shelves are `@project`-scoped, only **2** are near the 50-line
cap, the rest hold 1–12 lessons, and two are debris (`r`="lesson", `reviewer`="-").
A store of mostly quarter-full shelves is the exact smell the upstream README
names — eviction/aging only runs on a *full* shelf, so stale lessons never leave
and the index every session reads is long and hard to choose from.

## The reframe

**A shelf named after an agent is not the bug.** `change-verifier` is a valid
*situation* ("verifying a change is actually done"); the redesign still says
"choose by task shape." The bugs are (1) the harness *duplicates* tool-owned facts,
(2) the harness never set the *instrument* (`NB_SESSION`) that makes co-access and
surfacing observable, and (3) the store has no *triggers*. None of those requires
renaming a shelf — renaming would orphan every live lesson (exact-string
resolution, no fallback) for a cosmetic gain.

## Requirements

- **FR-1 (de-duplicate)** — No harness file (agent doc, reviewer-specialist,
  skill, or TS prompt string) restates a tool-owned fact (the cap number, the
  eviction rule, or the deprecated word "role"). Each agent doc names only what the
  *harness* owns: the shelf name, the situation, `nb show <shelf>`, and a pointer
  to the one reference. A guard (grep hook/CI) fails if `role`/`≤200 lines` text
  returns.
- **FR-2 (instrument)** — The launcher sets `NB_SESSION` so the tool computes
  co-access and surfacing for kookr sessions.
- **FR-3 (seed triggers reproducibly)** — The descriptions for the stable bare
  shelves are a **versioned artifact** in kookr, applied idempotently, so a fresh
  machine reproduces them and a typo cannot create a described orphan.
- **NG-1** — No renames of the stable shelf names. (Orphans live lessons.)
- **NG-2** — No new storage model, no per-lesson schema; `.` namespace and
  `@project` scope stay exactly as the tool defines them.
- **NG-3** — Non-destructive and reversible. "No loss" is defined at **text *and*
  score**: because no primitive moves a lesson across shelves without resetting its
  score to +1, any operation that would drop vote capital is **out of scope** until
  a score-preserving move exists (see Deferred).

## Design — slices in safe order

### Slice A — Set `NB_SESSION` (code; small; unblocks everything)

In `src/adapters/agent-launch-context.ts`, where the launcher already builds the
injected env (`KOOKR_TASK_ID: opts.taskId` at ~L324, `KOOKR_REPO_SLUG` at ~L419,
inherited by the agent **and its subagents** via the backend's
`{ ...process.env, ...spec.env }` merge), add:

```ts
NB_SESSION: opts.taskId,   // group a task's nb calls so co-access & surfacing compute
```

Keying on `taskId` makes the co-access unit "one kookr task" — exactly the unit of
lessons-used-together — and subagents inherit it, so a task's main agent and its
critics/patchers share one session id. This is the change that turns "group by
co-access" from aspiration into something `nb stats` can report, and it is the
precondition for any evidence-based consolidation. Ships first; it is additive and
safe (a new env var; the tool already treats a blank session as "don't compute").

### Slice B — De-duplicate the harness docs (docs-only PR, single repo)

One mechanical, reversible PR over **23 `plugin/agents/*.md` + 6
`plugin/reviewer-specialists/*.md` + `notebook-role-reuse` + `pre-pr-review`
skills + the `reviewer-fanout.ts` prompt string + `docs/reference/agent-notebook.md`**:

- Replace the opening line with a harness-only statement, e.g.:
  > *You open Agent-Notebook shelf **`change-verifier`** for this situation:
  > verifying a change is done. Load it with `nb show change-verifier`; see
  > `docs/reference/agent-notebook.md` for how shelves, caps, and voting work.*
- **Delete** the cap number and eviction clause from every doc (state them once,
  in the reference doc, which already documents `NB_MAX_LINES`/`default 50`). Do
  **not** restate "50" per-doc (the cap is `NB_MAX_LINES`-dynamic; a hardcoded
  number re-creates the drift).
- Do **not** write a per-agent "situation" sentence that *also* lives in the seed
  (Slice C) — the situation text has one home. The agent doc may name the shelf and
  a short situation gloss, but the canonical trigger is the seed's `# desc:`.
- Move the "`nb describe` the shelf you create" reminder into the
  `notebook-role-reuse` skill **only** (not into 24 prompts).
- Add a `notebookShelf` alias to the `reviewer-fanout` contract and mark
  `notebookRole` deprecated, matching the tool's own alias policy; fix the stale
  `≤200-char` string in the prompt builder.
- Keep vocabulary to `nb list`/`nb show` (both exist on 0.3.0); don't cite
  `nb shelves` (0.4.0-only) until the bump lands.
- **Guard:** a `grep` check (pre-commit hook or CI) that no tracked harness file
  contains `notebook role` or `≤200 lines` — so the duplication cannot grow back.

No behavioural code change; `reviewer-fanout`'s `code-review@<slug>` keeps working.

### Slice C — Seed the stable shelves' descriptions (versioned data)

Add `plugin/notebooks/shelves.json` — a reviewable map of the **stable bare**
shelves to their situational triggers (the ~13 the agents and fan-out address by
name; **not** the 15 `@project` shelves, `r`, `reviewer`, or `slug-sanitization`):

```json
{ "change-verifier": "verifying a change is done: tests/scope/gate before claiming complete",
  "code-review":      "reviewing a diff for correctness, tests, conventions",
  "patch-author":     "writing a minimal fix against a known repro + acceptance criteria",
  "repo-cartographer":"mapping an unfamiliar repo: build/test/lint entry points" }
```

and a small idempotent apply step (a `scripts/` node file, run at onboarding or by
hand) that, for each entry: **pre-flights the name against `nb path`/`nb list`**
(skip + warn if the shelf file does not exist — never let `nb describe` create an
orphan), and sets the description only if the shelf currently has none. Before any
data write, `git -C ~/.kookr/notebooks tag pre-shelf-reorg`. Separately, remove the
two debris shelves by deleting their files (`nb rm` exits 0 on a typo and these are
whole-file junk, so a file delete + commit is the honest operation).

This gives the trigger text one versioned owner, makes a fresh machine reproduce
it, and is the single change that most realises the co-access model (turns ~29
`(auto)` rows into a situational menu). It is non-destructive (adds `# desc:`
comment lines; no lesson touched).

### Deferred — consolidation and the 0.4.0 bump (explicit unblock-conditions)

Not scheduled by this RFC. Each needs a prerequisite the panel showed is missing:

- **`@project` / thin-shelf consolidation** needs **all** of: (a) a **score-preserving
  cross-shelf move** — none exists today (`nb merge` is single-shelf; add+rm resets
  to +1), so this is an upstream feature request or a library-level helper; (b)
  real **co-access/eviction evidence** from Slice A (today the `eviction-while-still-voted`
  signal is window-blind and the store almost never evicts); (c) a check that **no
  retired shelf is still addressed by exact string** in `reviewer-fanout.ts`,
  `agent-launch-context.ts`, or the agent docs (else it is silently recreated); and
  (d) a **quiesce or `NB_GIT_AUTOCOMMIT=0` + one-reviewed-commit-per-slice** story,
  because the shim's `git add -A` auto-commit (outside the file lock) otherwise
  sweeps concurrent live writes into migration commits and defeats `git revert`.
  When (a)–(d) hold, consolidation gets its own small RFC/issue.
- **0.4.0 bump** needs a verified 0.3.0→0.4.0 diff showing parity and that the
  shim's hand-synced `MUTATING` verb set still covers every mutating alias (else a
  write silently skips auto-commit). It buys only renamed vocabulary today; defer.

## Files to change

| Slice | Files |
|---|---|
| A | `src/adapters/agent-launch-context.ts` (+ test) |
| B | `plugin/agents/*.md` (23), `plugin/reviewer-specialists/*.md` (6), `plugin/skills/notebook-role-reuse/SKILL.md`, `plugin/skills/pre-pr-review/SKILL.md`, `src/shared/contracts/reviewer-fanout.ts` (+ `src/core/reviewer-fanout.ts` prompt), `docs/reference/agent-notebook.md`; a grep guard (hook or CI) |
| C | **new** `plugin/notebooks/shelves.json`, **new** `scripts/apply-shelf-descriptions.mjs`; live store `~/.kookr/notebooks` (tagged, git-backed) |

Slices A and B are ordinary kookr PRs. Slice C adds versioned artifacts to kookr
*and* applies them to the data store as a tagged, reviewable git diff.

## Edge cases

- **`nb describe <typo>` / `nb rm <typo>` both exit 0** — the first creates a
  described orphan, the second silently no-ops. Slice C pre-flights every name and
  deletes debris by file, never by a trusting `nb rm`.
- **Cap is `NB_MAX_LINES`-dynamic** (default 50), not a constant — which is exactly
  why Slice B deletes the number rather than hardcoding 50.
- **Store takes concurrent writes**; `git add -A` auto-commit runs outside the file
  lock. Slice A/B don't touch the store; Slice C only *adds* descriptions (no move,
  no eviction) and tags first. All destructive moves are Deferred behind (d) above.
- **A seed description must not override** a human-written one — apply only when the
  shelf has no `# desc:`.

## Alternatives considered

- **Wholesale rename to situational shelf names.** Rejected (NG-1): exact-string
  resolution orphans every live lesson for cosmetic gain; the names already *are*
  situations.
- **Correct "200→50" in place across ~30 files.** Rejected: fixes the symptom,
  keeps the duplication that caused it; the next cap change re-breaks everything.
- **Hand-typed `nb describe` calls (v1's Slice 1).** Rejected: a typo creates a
  described orphan (exit 0) that ranks *above* `(auto)` rows — the cleaning tool
  pollutes the index. A versioned seed + pre-flight apply removes the hazard.
- **Do the `@project`/thin consolidation now (v1's Slice 3).** Rejected: no
  score-preserving move exists, folded shelves are silently recreated by
  exact-string callers, and the `git`-reversibility claim is false under the
  store's live concurrency. Deferred with explicit unblock-conditions.
- **Bump to 0.4.0 now.** Rejected: unverified parity; buys only vocabulary; the
  shim's verb set is hand-synced. Deferred.

## Critic feedback incorporated

Round 1 — 5-critic panel (within the ≤5 gate), 2026-10-31:

- **design-minimalist:** cut the 0.4.0 bump and most consolidation; make the doc
  change mechanical; *delete* the cap number rather than correct it; treat
  descriptions as an operator/seed action, not a code slice. → Adopted
  (Deferred bump & consolidation; FR-1 deletes the number; Slice C is a seed).
- **boundary-critic:** the real defect is duplication — state the shelf
  definition/cap once (tool or reference doc) and have agent docs point to it;
  version the shelf→description map; add `notebookShelf` alias; the shim's
  `MUTATING` set is a hand-synced copy. → Adopted (FR-1 single-source + guard,
  Slice C seed, alias in Slice B, verb-set check in Deferred).
- **delivery-pragmatist:** Slice 2 missed 6 reviewer-specialist files +
  `reviewer-fanout.ts`; old Slice 1 depended on Slice 3's survivor set; `@project`
  folds are recreated by exact-string callers; the `nb stats` gate is vacuous
  (NB_SESSION unset); drop `plugin.json`. → Adopted (widened Slice B; Slice C
  targets only stable bare shelves; Deferred condition (c); Slice A; files table).
- **socratic-challenger:** with shelves 1:1 with agents and docs naming them,
  descriptions never drive selection and co-access is unmeasurable (NB_SESSION
  unset) — null hypothesis "nothing changes but the words." → Adopted as the
  reframe + Slice A (instrument first, so the premise is testable).
- **failure-mode-analyst:** no cross-shelf move primitive; add+rm resets score to
  +1 (FR-3 violated); `git add -A` + concurrency breaks reversibility;
  describe/rm exit 0 on typo; the voted-eviction gate is window-blind. → Adopted
  (NG-3 redefined at text+score; consolidation Deferred behind a score-preserving
  move + quiesce; Slice C pre-flights names and only adds).

Rounds 2–3 (skill default) were collapsed: the panel converged unanimously and
without internal contradiction (no ambition/minimalist split to resolve — the RFC
risk was over-scope, so `ambition-amplifier` was not seated), and the one new
load-bearing *code* claim (Slice A's `NB_SESSION` feasibility) was verified
directly against `agent-launch-context.ts` rather than debated. The Deferred items
each carry their own gate and will get a fresh review when scheduled.
