# Meta Coordinator — Variant Exploration

**Companion to:** `rfc-meta-task-coordinator.md`
**Date:** 2026-05-21
**Purpose:** Compare 4 candidate UX shapes against 5 grounded scenarios from the live fleet, then synthesize.

---

## Scenarios (real situations from the live fleet at 2026-05-21)

**S1 — Self-continuing chain, mostly done.**
A self-continuing task ("Implement RFC 010 wisdom-backed scout issues") spawned 5 children (issues #266–#270). 4 are completed: PRs merged, tests green, no follow-up. 1 is still in progress.
*User question: "Do I need to do anything with the 4 done ones, or can I move on?"*

**S2 — Cross-repo critical path.**
4 KB tasks in `knowledge-base-mcp-server`: `4a203b2a` (M1 evidence-packet CLI, in progress), `712e0a5f` (tighten M1 planner), `46cd2129` (dogfood M1), `9e6bbcad` (assess KB capabilities). The latter three plausibly need M1 to ship first. Plus `b52496f7` in `local-research-agent` likely consumes M1.
*User question: "Where should I push?"*

**S3 — Silent duplicates.**
`b52496f7` ("Implement RFC 010 wisdom-backed scout issue 268") and `75c0d0c8` (unnamed, identical prompt) both running.
*User question: "Are these doing the same thing? Should I kill one?"*

**S4 — Stale task masquerading as in-progress.**
A task hasn't emitted a PostToolUse hook event in 45 minutes. Status still `inProgress`. No `PermissionRequest` pending.
*User question: "Is this stuck or just thinking?"*

**S5 — Done-but-not-cleared.**
`bad5faa1` ("Implement GitHub issue #528") completed 3 hours ago. PR merged upstream. No anomalies. Sits in the Completed pane indefinitely.
*User question: "Anything left here? Or can I forget about it?"*

---

## Variant A — Fleet Focus Banner

**Shape:** One persistent banner at the top of the dashboard. Single recommendation, one click.

**S2 mockup:**
```
┌──────────────────────────────────────────────────────────────────────┐
│ ⓘ FOCUS  Implement kb research M1 evidence-packet CLI  (4a203b2a)    │
│   Blocks 2 KB tasks + 1 inferred in local-research-agent · score 65  │
│   [Open]  [Why?]  [Snooze 30m]  [Dismiss]                            │
└──────────────────────────────────────────────────────────────────────┘
[ normal task list below — unchanged ]
```

**S1 behavior:** Banner is unhelpful — there's no single task to focus on. Either picks one arbitrarily or shows "no focus needed" which is also unhelpful.
**S3 behavior:** Banner cannot say "you have duplicates" without taking that slot away from a real focus.

**Verbs:** Open, Snooze, Dismiss. (Navigational only.)

**Pros:** Cheap to scan; one decision; non-intrusive.
**Cons:** Only one recommendation per screen — N-1 tasks get no help. Forces the system to pick a winner even when the answer is "several small actions, none individually big." Doesn't compose with the *task* you're already looking at.

---

## Variant B — Per-Task Recommendation Chip

**Shape:** Each task row gets an optional chip with a verb-led recommendation. Chip only appears when the system has something useful to say (gated).

**S1 mockup (4 children done, 1 in flight):**
```
[✓] 8a1c2d…  Implement #266 wisdom-backed scout       completed
    └─ ✅ Mark done · PR #531 merged 14h ago, no follow-up signals

[✓] 9b2d3e…  Implement #267 wisdom-backed scout       completed
    └─ ✅ Mark done · PR #532 merged 11h ago, no follow-up signals

[✓] ac3e4f…  Implement #268 wisdom-backed scout       completed
    └─ ✅ Mark done · PR #533 merged 9h ago, no follow-up signals

[✓] bd4f5a…  Implement #269 wisdom-backed scout       completed
    └─ ✅ Mark done · PR #534 merged 5h ago, no follow-up signals

[●] b52496f7 Implement #270 wisdom-backed scout       inProgress
    └─ ⏳ Let run · Last activity 4 min ago; on critical path of chain

  ✦ Batch action available: "Mark 4 sibling tasks done" → [Apply to all]
```

**S2 mockup:**
```
[●] 4a203b2a Implement kb research M1 evidence-packet CLI  inProgress
    └─ ▶ Push to completion · Blocks 2 KB tasks + 1 (inferred) in LRA

[●] 712e0a5f Tighten KB Research M1 Planner Quality        inProgress
    └─ ⏸ Snooze 24h · Blocked by 4a203b2a (inferred — accept?)

[●] 46cd2129 Dogfood KB research workflow report           inProgress
    └─ ⏸ Snooze 24h · Blocked by 4a203b2a (inferred — accept?)
```

**S3 mockup:** Both duplicate rows get a chip:
```
[●] b52496f7 Implement RFC 010 wisdom-backed scout #268    inProgress
    └─ ⚠ Compare with 75c0d0c8 · Identical prompt · [Compare] [Terminate dup]

[●] 75c0d0c8 (unnamed)                                     inProgress
    └─ ⚠ Compare with b52496f7 · Identical prompt · [Compare] [Terminate this]
```

**Verbs:** Mark done, Let run, Snooze, Push to completion, Terminate, Compare, Provide input.

**Pros:** Contextual — lives where you're looking. Scales linearly with fleet. Verbs are concrete, not navigational. Composes with the per-task `nextAction` chip from `rfc-supervision-next-actions`. Batch action emerges naturally (4 sibling chips with the same recommendation → one batch button).

**Cons:** Chip on every row = visual noise if gating is wrong. Doesn't surface fleet-level findings that aren't task-owned (e.g., orphan dependencies). Hard to answer "which one first?" if every row says something.

---

## Variant C — Chain Context Strip

**Shape:** When you open a task that's part of a chain (self-continuing parent, sibling cohort, or declared dependency), show a strip above the task detail with chain status, lineage, and a one-line summary of what's happening across siblings.

**S1 mockup (opened task is the still-running 5th child):**
```
┌─ CHAIN · RFC 010 wisdom-backed scout queue ─────────────────────────┐
│                                                                     │
│  ⓪ Parent  4f8a91…   "Implement all RFC 010 issues, one per task"   │
│                                                                     │
│   [✓] #266 → PR #531 merged 14h ago                                 │
│   [✓] #267 → PR #532 merged 11h ago                                 │
│   [✓] #268 → PR #533 merged  9h ago                                 │
│   [✓] #269 → PR #534 merged  5h ago                                 │
│   [●] #270 → in progress, you are here                              │
│                                                                     │
│  Step 5 of 5 known · 4 sibling outcomes clean · No follow-up       │
│  [Mark prior 4 done]                                                │
└─────────────────────────────────────────────────────────────────────┘

[ task detail below ]
```

**S2 mockup (opened task is `712e0a5f`, tightening M1):**
```
┌─ DEPENDENCIES ──────────────────────────────────────────────────────┐
│                                                                     │
│  Blocked by (inferred, pending accept):                             │
│   • 4a203b2a · Implement kb research M1 evidence-packet CLI         │
│     status: inProgress · last activity 8 min ago                    │
│                                                                     │
│  Blocks: none declared                                              │
│                                                                     │
│  [Accept dependency]  [Reject]  [Mark independent]                  │
└─────────────────────────────────────────────────────────────────────┘
```

**S5 behavior:** No chain → strip is absent. Variant C is silent when not applicable.
**S3 behavior:** Duplicates aren't a chain — variant C doesn't surface them.

**Verbs:** Mark prior done, Accept dependency, Reject, Mark independent, Jump to upstream.

**Pros:** Solves the "step 2 of 10" half of the user's stated problem directly. Maximally non-intrusive — invisible when not applicable. Especially useful for self-continuing chains, which Kookr already encourages via the `self-continuation-task` skill. Lets the user mark a *batch* of related tasks done with one click.

**Cons:** Only useful for tasks that *are* part of a chain or have explicit edges. Doesn't help the dashboard scan-from-cold case. Pure detail-view feature; not a fleet view.

---

## Variant D — Attention Inbox

**Shape:** A dedicated pane (collapsible or full-screen) that lists "things needing you," sorted by attention score, grouped by reason class. Each item is a worked card with inline actions. The existing task list is unchanged but secondary.

**Combined S1+S3+S4+S5 mockup:**
```
┌─ ATTENTION INBOX (6 items, sorted by score) ────────────────────────┐
│                                                                     │
│  🔴 STUCK 45m  ─────────────────────────  score 80                  │
│  ec77ab12 · Refactor cost-comparison panel selectors                │
│  No tool activity since 14:32. Likely waiting on user or stuck.     │
│  [Open transcript]  [Send "continue"]  [Terminate]                  │
│                                                                     │
│  🟠 BOTTLENECK  ────────────────────────  score 65                  │
│  4a203b2a · Implement kb research M1 evidence-packet CLI            │
│  Active, healthy. Blocks 2 KB tasks + 1 inferred in LRA.            │
│  [Open]  [Add note to push]                                         │
│                                                                     │
│  🟡 DUPLICATE  ────────────────────────  score 45                   │
│  b52496f7 & 75c0d0c8 · Identical prompt, both running               │
│  [Compare]  [Terminate 75c0d0c8]  [Keep both]                       │
│                                                                     │
│  🟢 BATCH READY  ──────────────────────  score 40                   │
│  4 sibling tasks of RFC 010 chain completed cleanly, PRs merged     │
│  [Mark all 4 done]  [Show chain]                                    │
│                                                                     │
│  ⚪ DONE-NOT-CLEARED  ─────────────────  score 25                   │
│  bad5faa1 · GitHub issue #528 — PR merged 3h ago, no follow-up      │
│  [Mark done]  [Open PR]                                             │
│                                                                     │
│  💤 12 other tasks running normally — no attention needed            │
└─────────────────────────────────────────────────────────────────────┘
```

**Verbs:** All of B + C, plus "Terminate", "Send 'continue'", "Add note", "Compare".

**Pros:** Inbox-zero model — the user works top-down through items. Strong fleet-level visibility. Items with no single owner (duplicates, batches) get first-class placement. Most actionable shape: every item has its action verb attached. Easy to answer "what now?" — start at the top.

**Cons:** Most ambitious surface, most build cost. Risk of becoming "another Linear inbox." Hides the existing per-task surface — the user might miss tasks that are running fine but worth checking. Score-ordering becomes a fight ("why is X above Y?") at scale.

---

## What ALL variants share (the model under the UI)

Regardless of which surface wins, all four sit on the same data layer:

- Declared / Detected / Inferred edges (trust tiers).
- Deterministic attention score per task.
- Duplicate detector (reuses spawn's prompt normalizer).
- Stale detector (PostToolUse-recency).
- Chain/lineage detection from existing `parentTaskId` / `childTaskIds` already in the `Task` model.
- Bounded LLM inference pass for low-confidence edges, gated by user accept/reject.

This shared substrate is the actual investment. The variant is the rendering on top.

---

## Variant comparison table

| Dimension                          | A: Banner | B: Chip | C: Chain Strip | D: Inbox |
|------------------------------------|:---------:|:-------:|:--------------:|:--------:|
| Action verb on recommendation      |    no     |   yes   |      yes       |   yes    |
| Scales to N tasks                  |    no     |   yes   |  per-chain     |   yes    |
| Helps the open-task-detail case    |    no     |   yes   |     yes        |  partial |
| Helps the dashboard-cold-scan case |    yes    |   yes   |      no        |   yes    |
| Surfaces non-task findings (dups)  |    no     |   no    |      no        |   yes    |
| Solves "where am I in the chain?"  |    no     |   no    |     yes        |  partial |
| Build cost                         |    low    |  medium |    medium      |   high   |
| Risk of being ignored              |   high    |  medium |     low        |  medium  |
| Risk of being noisy                |    low    |  high*  |     low        |   high   |

*B noise risk is fully controlled by gating (only show chip when high-confidence action exists).

---

## Hypothesis going into the critic panel

**B is the primary surface** — it sits where the user looks, says what to *do*, and composes with the existing `nextAction` chip work.
**C is a free addition for chain cases** — adds the "step 2 of 10" framing at low cost when the data already exists.
**D is overbuilt** as a primary surface but might survive as a small collapsible "fleet findings" pane for the things B/C can't carry (duplicates, orphans, batch actions).
**A is replaceable** by the sort order of B — if every task has a chip with a score, the top task IS the focus.

Open questions for the critics:
1. Is per-task chip gating reliable enough that we don't drown the user?
2. Is "step N of M" worth the build cost when most tasks aren't chained?
3. Does the inbox shape (D) cannibalize the dashboard, or strengthen it?
4. Is there a 5th shape we've missed — e.g., a contextual sidebar, a compressed digest tooltip, a periodic "morning standup" view?

---

## Critic panel synthesis

Four critics reviewed this artifact in parallel — a simulated solo-dev user, a senior UX designer, a design minimalist, and a failure-mode analyst. Their full reports are below in `Appendix: Critic Reports`. Where they agreed and disagreed:

### Convergence (all four)

- **Variant A is dead.** Banner real estate gets muted by day 7; carries no verbs; competes with the dashboard scan instead of augmenting it. Cut entirely.
- **Variant B is the primary surface.** Composes with the existing `rfc-supervision-next-actions` next-action chip — they could be the same component with a `tone` prop. Lives where the user looks.
- **Variant C is a free win where applicable.** Highest signal-to-noise of the four, invisible when not applicable, solves "step N of M" at near-zero cost.
- **Variant D is not a primary surface.** Survives only as a small "fleet findings" pane for things without a row (duplicates, orphan blockees) — and even that is debatable.

### Reframing from the UX designer

The right axis isn't *surface shape* (banner / chip / strip / pane) — it's **locus of decision**:

| Locus | What lives here |
|---|---|
| **Task** | Chip on the row (B) |
| **Relation** | Chain/dependency strip in detail (C) |
| **Fleet** | Findings pane for ownerless items (slim D) + pre-spawn dedupe (new) |

You need *one of each*, not one *instead of* the others. The variants are tiers, not alternatives.

### Veto-level safety issues from the failure-mode analyst

These four constraints are blockers — Variant E must satisfy them:

1. **Click-time re-verification on every destructive verb.** "Mark done" must re-check PR status, worktree cleanliness, and post-merge CI at click-time — not at render-time. The score is computed on cached state; the action must touch ground truth.
2. **Drop "Terminate" from PR 1.** Without per-agent-type stale thresholds, a global default guarantees false positives on legitimate long-quiet work (playwright, big LLM passes). Ship "Open transcript" and "Send 'continue'", not "Terminate."
3. **Snooze must be reason-coded with exponential backoff**, not ephemeral. Otherwise a deterministic recomputation re-fires the identical recommendation next tick.
4. **Never assert absence of signal.** Lines like "💤 12 other tasks running normally — no attention needed" are unsafe — the coordinator cannot prove a task is healthy, only that it has no negative signal. Remove or rephrase.

### High-leverage additions the critics surfaced

- **`[✕ wrong]` affordance on every recommendation** (UX designer). One-click "this was a bad call" that suppresses *this class* of recommendation for this task type for 7 days. Without it, one false positive trains the user to mute the whole feature.
- **Pre-spawn dedupe interrupt** (solo dev). The prompt normalizer is currently used on the dashboard for post-hoc detection — also use it on the spawn path. Block the spawn and ask "75c0d0c8 is already running this — focus it instead?" Cheap, high value, addresses the actual failure (spawning the duplicate), not its symptom.
- **Verb cleanup** (UX designer). "Push to completion" is ambiguous — rename to "Nudge agent" or "Open & follow." "Snooze" should pick one default granularity, not mix 30m and 24h. "Mark done" needs the click-time re-verification round-trip.
- **Score is an internal sort key, not user-facing** (UX designer + solo dev). The colored dot already encodes priority; showing "score 65" forces re-evaluation against a threshold the user doesn't carry. Drop the number from all surfaces.

### High-impact cuts the critics agreed on

- **LLM inference pass — defer indefinitely.** The minimalist's argument: it's seven paragraphs of design + a panel + accept/reject UI to serve one scenario (S2). Manual `blocks` field with a typeahead is cheaper. The failure-mode analyst's argument: accepted-inferred-becomes-declared loses provenance permanently. Combined verdict: ship manual edge declaration in PR 1; revisit inference only if 2+ weeks of dogfooding shows manual declaration is the bottleneck.
- **Three-tier trust model → two-tier.** Without inference, the trust hierarchy collapses to (declared) + (detected, never auto-acted-on). No special architecture needed.
- **Focus banner + coordinator panel duo from parent RFC → both cut.** Sort-by-chip handles fleet-level priority; per-row chips handle per-task action.
- **Score numbers, `alternatives_suppressed` field, "fleet_concentration" evidence kind, cross-repo identity section.** All over-design.

---

## Variant E — converged design

**Primary surface: per-task recommendation chip (B), with mandatory `[✕ wrong]`.**

```
[●] 4a203b2a Implement kb research M1 evidence-packet CLI    inProgress
    ▶ Nudge agent  ⛓ blocks 3   [✕]

[●] 712e0a5f Tighten KB Research M1 Planner Quality          inProgress
    ⏸ Snooze 24h   ⛓ blocked by 4a203b2a   [accept] [✕]

[●] 75c0d0c8 (unnamed)                                       inProgress
    ⚠ Compare with b52496f7  · identical prompt   [Compare] [✕]

[✓] bad5faa1 Implement GitHub issue #528                     completed
    ✅ Mark done   · PR #535 merged 3h ago, no follow-up    [✕]
```

Rules:
- Verb is always the first token. One verb per chip.
- Evidence is glyph + count (no prose). Sub-prose moves to a tooltip if at all.
- `[✕]` suppresses *this recommendation class* for this task type for 7 days.
- Chip only appears when a deterministic detector fires (stale / duplicate / done-not-cleared) OR a declared edge resolves to a meaningful state.
- No score shown. Chip presence is the priority signal; the task list sorts chip-bearing tasks to top of their repo group.

**Relation surface: chain/dependency strip in detail view (C, hardened).**

Appears only when `parentTaskId/childTaskIds` exists or a declared edge points here.

```
┌─ CHAIN · RFC 010 wisdom-backed scout queue ────────────────────────┐
│  [✓] #266 → PR #531  · [✓] #267 → PR #532  · [✓] #268 → PR #533    │
│  [✓] #269 → PR #534  · [●] #270 (you are here)                      │
│  [Mark prior 4 done] ← re-verifies each PR at click-time            │
└─────────────────────────────────────────────────────────────────────┘
```

Batch action carries an optimistic-concurrency token. Each item in the batch is re-checked against GitHub state at click-time. If any sibling changed since render (revert, post-merge CI failure, new follow-up), the batch is rejected and the strip re-renders.

**Fleet surface: small findings pane + pre-spawn dedupe.**

Findings pane (collapsed by default, badge in nav when items exist):

```
COORDINATOR FINDINGS (2)
  ⚠ Duplicate cluster · b52496f7 & 75c0d0c8         [Compare]
  ⚠ Orphan blocker · 712e0a5f waits on 4a203b2a — upstream completed  [Clear edge]
```

Items here have no row of their own. Verbs are non-destructive: `Compare`, `Clear edge`, `Open both`. Never auto-suggest "Terminate" — the user makes that call from `Compare`.

Pre-spawn dedupe (on `kookr-spawn`):

```
$ kookr-spawn --prompt "..."
WARN: prompt matches active task 75c0d0c8 (running 12 min, repo: local-research-agent)
Continue spawning a duplicate? [y/N/show diff]
```

This is the load-bearing addition — it stops duplicates at the front door, where they're cheapest to prevent.

### Locus map of Variant E

| Locus    | Surface              | Verb examples              | Build cost |
|----------|----------------------|----------------------------|------------|
| Task     | Chip on row          | Mark done, Snooze, Nudge   | medium     |
| Relation | Strip in detail view | Mark prior N done, Accept  | medium     |
| Fleet    | Findings pane + spawn interrupt | Compare, Clear edge | low |

### What ships in PR 1

- Three deterministic detectors (stale, duplicate, done-not-cleared) → emit chips.
- Manual `blocks` / `blocked_by` field on task, set from detail view with typeahead.
- Declared edges drive chip evidence (`⛓ blocks 3`).
- Chain strip rendered from existing `parentTaskId/childTaskIds`.
- Pre-spawn dedupe interrupt.
- `[✕ wrong]` suppression with 7-day expiry, persisted in `~/.kookr/coordinator-suppressions.json`.
- Sort: chip-bearing tasks float to top of their repo group.
- Click-time re-verification for `Mark done` (PR status, worktree dirtiness, post-merge CI).

### What is explicitly deferred

- LLM inference pass and "Suggested links" panel. Revisit only if manual declaration proves insufficient over 2+ weeks of real use.
- Attention scorer formula. Internal sort uses a flat priority (any chip > no chip; recency within ties); a richer score is added only when the declared-edge graph has enough data to be meaningful.
- `Terminate` verb anywhere in the coordinator. The user terminates from the existing task surface, not from a recommendation.
- GitHub-artifact-typed blockers (`gh:owner/repo#NN`). Free-text milestone strings cover the case; auto-clearing from GH state can come later.
- Per-agent-type stale thresholds. Single global default; per-type calibration is a PR 2 concern when there's data.
- "Absence of signal" claims. The coordinator never says "N tasks running normally" — silence is silence.

### Mapped to the 5 scenarios

| Scenario | What Variant E does |
|----------|---------------------|
| S1 (chain mostly done) | Chain strip in detail view + `[Mark prior 4 done]` batch action with click-time PR re-verification. Each `✓` sibling row also gets a `✅ Mark done` chip on the dashboard. |
| S2 (cross-repo bottleneck) | Manual `blocks` edge from user; bottleneck task gets `⛓ blocks 3` chip evidence; sort floats it to top. If user hasn't declared edges, fleet still functions, just without the cross-repo hint. |
| S3 (silent duplicates) | Pre-spawn dedupe catches future ones at the door. For existing dupes: chip on each row with `[Compare]` + findings-pane card. No auto-Terminate verb. |
| S4 (stale task) | `⏳ Stuck? 45m silent` chip with `[Open transcript]` and `[Send "continue"]`. No `Terminate` verb in PR 1. |
| S5 (done-not-cleared) | `✅ Mark done` chip with click-time PR re-verification. One click for routine cleanup; safe because of re-verification. |

This is what I'd ship. It is more conservative than the parent RFC and structurally simpler — three detectors, manual edges, three small UI surfaces, with safety properties (re-verification, `[✕ wrong]`, no destructive auto-suggestions) baked in from day one.

---

## Appendix: Critic Reports

The full reports from the four critic subagents are summarized in this synthesis section. Raw transcripts available on request — they include the simulated-user pre-spawn-dedupe insight, the UX designer's locus reframing and verb-clarity audit, the minimalist's "three deterministic chips is 80% of the value" argument, and the failure-mode analyst's 10-mode risk table with 4 veto-level findings.
