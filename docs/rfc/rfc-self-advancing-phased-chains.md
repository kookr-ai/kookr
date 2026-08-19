# RFC: Self-Advancing Phased-Decomposition Chains & RFC-First Refactor Front-End

## Status

**Draft (v2 — post round-1 restructure)**

**Date:** 2026-08-19
**Author:** Jean Ibarz (with Claude)

> v2 note: round-1 review (5 critics) **empirically falsified three load-bearing safety
> claims** in v1 (ledger tick atomicity, "file-exists = merged", scoped merge authority — see
> Critic Feedback Incorporated). Per `rfc-iterative-review`, the correct response to falsified
> load-bearing claims is to **restructure around reality**, not iterate on the broken premise.
> v2 therefore (a) splits delivery into three sequential, independently-shippable phases with
> **D1 — the minimal real fix — first**; (b) **defers** the periodic advancer (D2) and the
> RFC-first front-end (D3) behind pre-specified safety/observability acceptance criteria; and
> (c) hardens the authority and satisfaction model against the verified defects.

---

## Problem

Kookr decomposes large work into an ordered set of *dependent phases* driven by a
`self-continuation-task` chain — each phase a PR, each phase's prerequisite being that the
**previous phase merged to `origin/main`**. This is the intended shape for god-module
decomposition, staged migration, and any refactor that must land incrementally.

**It deadlocks on the first merge boundary.** Reproduced live on `jeanibarz/lucy#3272`
(decompose `product-metric-alerts.js`, 9 phases P1..P9):

1. Phase P1 opened PR #3295, wrote a `blocked-on: merge of #3295` marker into the issue
   ledger, and **completed** (correctly releasing its slot).
2. The parent orchestrator task also **completed**.
3. #3295 later merged. **Nothing spawned P2** — no task, no cron, no hook was watching.
4. The chain is frozen permanently at P1 even though every remaining phase is fully specified
   and P1's file is on `main`.

### Root cause (two independent gaps, both required)

- **Snapshot-at-start continuation, no re-arm.** `src/core/continuation-envelope.ts`
  `resolveContinuationState` (~:222-263) resolves the next unit from a point-in-time
  `StateResolver` snapshot; a `blocked` next-unit with no other eligible unit collapses to
  `selectedUnit = null` = "chain complete". No dependency edge, no merge-triggered
  re-evaluation. The `blocked-on: … resume when: #N merged` marker the skill prescribes is
  written to durable state but **nothing reads it** (confirmed: dead signal).
- **Phase tasks are authorized only through "open PR".** `src/server/worktree-guardrails.ts`
  (`deliveryGateSentence`, :58-63) injects a delivery preamble ending at "open the PR and
  report the URL — the PR is the review gate". Merge authority is never granted, so the actor
  that could advance the chain (merge phase N → phase N+1 becomes eligible) never exists.

The surrounding system *does* self-merge lucy PRs (every recent `jeanibarz/lucy` PR is
`mergedBy == author ==` the automation, via `implement-github-issue` Phase 8). So the phased
chain is the *only* flow whose phases were denied the merge authority the rest of the system
exercises. Mismatch + missing re-arm = permanent silent stall.

### Why this is not a one-issue bug

`architecture-health-check` and `repository-idea-scout` keep filing exactly this shape
(decompose X in N phases). Any future multi-phase structured issue hits the same wall. The
`self-continuation-task` skill already *warns* against dependent chains, but a prose warning
prevents nothing — the chain still deadlocked. We need a **mechanical** guarantee.

Adjacent gap: the intended workflow for a *big* architecture refactor —
**draft RFC → iterate → merge RFC PR → open umbrella issue → orchestrate phased
implementation** — has no automated path. #3272's umbrella was hand-authored once, which is not
reproducible. Durable cross-phase context has no standard home.

## Goals

1. A dependent-phase chain advances to completion with no human at each merge boundary, **or
   stops with a discoverable, actionable blocker on the umbrella issue — never silently stalls.**
2. **Generic** across any multi-phase structured issue; no per-issue instructions.
3. **Merge safety preserved**: a phase self-merges only after a green local gate **and** a
   verifiably-independent review verdict, under an authority that is namespace-bound and
   rate-capped — not a blanket grant.
4. **RFC-first front-end** for big refactors (deferred to Phase 3).
5. **Durable context** lives in GitHub (umbrella issue body/comments); any cold task resumes
   from it.
6. **Idempotent & safe under races**: never double-spawn, never work an already-merged phase,
   never advance past a red gate or an unmerged/reverted base.

Non-goals: replacing human review for ordinary single-issue PRs; non-linear (DAG) phase graphs;
parallel phase execution; cross-repo dependency edges.

## Design — three sequential phases

Round-1 review showed the v1 "ship D1 + D2 together" plan unsafe: D1 (a live phase task that
self-merges then spawns the next) and D2 (a 60s sweep that also spawns phases from a shared
mutable ledger) **overlap at every merge boundary** and both write an unguarded shared ledger,
reproducing the very duplicated-ownership defect that caused #3272. We therefore phase them.

### Phase 1 (D1) — Self-advancing phase contract *(the real fix; ship first)*

A dependent-phase chain is launched with a delivery **mode** `self-advancing` (see Authority
model — it is a `DeliveryPolicy` value, **not** an open boolean toggle). Each phase task's
delivery contract extends past "open PR":

```
implement → local gate green → independent-review gate (distinct task-id) → self-merge (wrapper-only)
          → record PR# + tick the umbrella issue → spawn next phase → release slot
```

D1 alone structurally closes the reproduced bug: the merge and the next-phase spawn are two
steps of **one synchronous task run**, so the "PR merges later, nothing watching" gap cannot
occur — there is no gap. D1 needs **no** periodic sweep and **no** new fenced ledger format:
it reads the umbrella issue's phase checklist + recorded PR numbers (exactly as #3272's ledger
already encodes) and appends its result.

**Single eligibility function.** Introduce `src/core/phase-ledger.ts::nextEligiblePhase(...)`
as the *one* place that decides "what is the next workable phase" (F-boundary: v1 had two
engines). D1's `StateResolver` is implemented **in terms of it**; the generic
`ContinuationCursor` does **not** grow PR/path-shaped fields (keeps the module domain-agnostic —
git/PR semantics stay behind the injected resolver, where the module's own doc-comment says
domain specifics belong).

**Satisfaction = PR-merge reachability against a freshly-fetched base** (F2/F8/F9). The resolver
`git fetch --prune` then checks the *recorded phase PR number*'s merge state via
`worktree-merge-status.ts` reachability — **never bare file-existence** (a move-and-reexport
facade leaves the file present after a revert; an unrelated PR can create the same path). The
phase's PR number is recorded in the ledger **at branch-open**, before merge, so a crash between
merge and tick recovers by querying that exact PR, not an ambiguous path.

**Contract change, not a local patch** (F-final): `resolveContinuationState` returning
`null` = "complete" is consumed by callers that treat `null` as terminal. Adding a distinct
`waiting`/`blocked` outcome changes `ResolvedContinuation`; Phase 1 includes a **full caller
audit** so "blocked, dependency unmerged" is never conflated with "chain complete".

### Phase 2 (D2) — Umbrella-chain advancer backstop *(deferred; hardened acceptance criteria)*

D1 has one residual gap: if a phase task dies **after** self-merge but **before** spawning the
next (crash, OOM, killed), the chain stalls again — smaller blast radius than #3272 but the same
class. D2 is the backstop: a driver that re-arms a chain whose tasks have all exited. It is
**deferred** because round-1 showed it carries almost every critical race (F1/F2/F5/F6/F11) and
must not ship until each is provably closed. **D2 may not be implemented until all of the
following are acceptance-tested:**

- **Single-writer ledger (F1).** Only D2 mutates the umbrella-issue body; D1 (and phase tasks)
  emit **append-only comments** ("Pn merged as PR #N") that D2 reconciles into the body. If both
  ever write, every read-modify-write is wrapped in the same cross-process file lock
  `cross-project-cleanup-sweep.ts` already uses (`~/.kookr/*.lock`). Ledger modeled as an
  append-only event log; body rendered from it. Round-trip validate (serialize→parse→deep-equal)
  before every post (F10).
- **Fetch-then-reachability satisfaction (F2).** D2 `git fetch --prune` before evaluating any
  chain; satisfaction keyed to recorded PR numbers, scoped to the chain (never global path
  existence, which can cross-satisfy sibling chains — F11).
- **Spawner-side atomic claim + idempotency key (F5).** The **spawner** synchronously acquires
  the `(issue, phase)` claim *before* POSTing to `/api/tasks`, and every phase spawn carries a
  deterministic `--idempotency-key = chain:<issue>:phase:<id>`, so concurrent spawns collapse in
  the atomic idempotency ledger rather than racing the seconds-long spawn→claim window.
- **Drift-advance only when the owning task is terminal** + a grace window (F6): D2 never
  drift-ticks/advances a phase merged < N minutes ago whose claim is still live.
- **Strict sequential order (F12):** stop at the first non-merged phase regardless of a later
  phase's individual dependency; forbid non-adjacent `dependsOn`. Validate the phase list is a
  simple chain (no cycles/self-edges — F13) at parse.
- **Cross-process lock on the sweep itself (F11):** the schedule-runner `firing` guard is
  in-memory/single-process; the advancer takes the shared file lock so two runs cannot overlap.
- **Observability (operability panel):** a committed per-tick structured log line per scanned
  issue (`ledger=ok|malformed`, `next=<phase>`, `depSatisfied`, `inFlight`, `claim`,
  `decision=spawn|skip`, `reason=<code>`) + a tick summary; a `blockedReason`+`blockedSince`
  field pair in the ledger set by whichever actor detects the block; an aggregated chain-health
  surface (`!bot chains` / dashboard row) listing every open umbrella chain's phase/status/
  staleness; a defined staleness threshold + documented unstick procedure for a stuck claim; a
  **post-merge audit** verifying every automation-merged PR carried a passing, independent review
  verdict timestamped before merge, paging on violation.

### Phase 3 (D3) — RFC-first refactor front-end *(deferred)*

A playbook `plugin/playbooks/architecture-refactor-rfc.md` (invoked by `repository-idea-scout` /
`architecture-health-check` on a "large refactor" finding, or directly) chains existing skills:
draft+iterate the RFC via `rfc-iterative-review` → open+self-merge the RFC PR (docs-only, low
blast radius, same independent-review guardrail) → open an **umbrella issue** with the phase
checklist + `dependsOn` edges + reference commit → launch the Phase-1 self-advancing chain. The
umbrella issue is the durable context store. Deferred until D1 (+ D2 backstop) are proven; noted
here so the end-state is designed, not bolted on. **Bootstrap note:** the mechanism cannot build
itself — this RFC's own umbrella (below) is driven by the *pre-existing* manual self-advancing
contract until D1 lands.

## Authority & merge-safety model (F3/F4 — load-bearing)

Self-merge is the sharpest new power; v1 secured it with an open boolean toggle, which review
proved leaky. v2:

- **Not an `AuthorizationToggles` boolean.** `self-advancing` is a third `DeliveryPolicy` value
  (alongside `pre-authorized` / `ask-first`), threaded from the composition root into
  `worktree-guardrails.ts` — the module that already owns delivery-mode. This avoids the
  verbatim-copied-open-map leak (F3) and the boundary conflation of "authorization" vs.
  "delivery-shape".
- **Grant is verified at merge time, not merely carried.** The merge step checks the PR's
  head branch matches the chain namespace (`refactor/<...>-#<issue>` / recorded branch) **and**
  the umbrella issue carries the chain marker. A stray policy value on an unrelated child
  therefore authorizes nothing.
- **Circuit breaker (F3):** a hard cap of N self-merges per chain per hour; exceeding it stops
  and pages. Guards against a runaway ledger/mis-tick self-merging many PRs in minutes.
- **Independent review is unforgeable and unskippable (F4):** the verdict must come from a task
  whose task-id differs from the implementer's lineage, verified against the task registry; the
  **merge wrapper is the only merge path** (the non-lucy fallback routes through it, never raw
  `gh pr merge`); re-review attempts are capped (2) then hard-block to a human; "reviewer failed
  to run" (retry/alert) is distinguished from "reviewer returned BLOCK" (stop).
- **Global kill switch outside the data path (delivery):** an env flag
  (`KOOKR_SELF_ADVANCING_DISABLED`) that halts all self-advancing merges/spawns regardless of any
  issue's content, plus a canary allowlist of N operator-chosen chains for first activation.

## Durable-state contract

Phase 1 needs only what #3272's ledger already has: a per-phase checklist with recorded PR
numbers and status, in the umbrella issue body, plus append-only result comments. The
machine-readable fenced `kookr-phase-ledger` block (with `blockedReason`/`blockedSince`,
versioned, checksummed) is introduced **with D2** (the first component that needs a parser), not
before — avoiding a bespoke format with no consumer. Status ∈ {pending, in-flight, blocked,
merged}; `blockedReason` ∈ {dependency-unmerged, gate-red, review-block, stuck-claim, malformed}.

## Files to change (by phase)

**Phase 1 (D1):**
- `src/core/phase-ledger.ts` **(new, pure)** — `nextEligiblePhase(...)`: single eligibility
  function (strict-sequential, PR-reachability satisfaction). Codec/audit split into separate
  pure modules only when D2 adds them (avoid welding stable format to iterating policy — boundary).
- `src/core/continuation-envelope.ts` — teach `resolveContinuationState` the blocked-vs-complete
  distinction **without** PR/path fields on the cursor (resolver-side); **caller audit** for the
  new outcome. Unit tests per transition.
- `src/server/worktree-guardrails.ts` + composition root — add `DeliveryPolicy = 'self-advancing'`
  and emit the extended self-merge+spawn-next contract; namespace-verified, rate-capped merge.
- The merge wrapper path — enforce wrapper-only merge + independent-verdict identity check.
- `plugin/skills/self-continuation-task/SKILL.md` — document the self-advancing variant and point
  the dependent-chain warning at the mechanism that now enforces it.
- Acceptance gate: **existing non-self-advancing chains produce byte-identical guidance /
  continuation output** (snapshot test) — additive, no behavior change until opt-in (delivery).

**Phase 2 (D2):** `src/server/use-cases/umbrella-chain-advancer.ts` (new, I/O, file-locked),
`phase-ledger.ts` codec + drift-audit modules, `schedule-runner.ts` registration (or bundled
scheduled playbook), the fenced ledger format, observability surfaces, post-merge audit.

**Phase 3 (D3):** `plugin/playbooks/architecture-refactor-rfc.md` (new); route "large refactor"
findings in `repository-idea-scout.md` / `architecture-health-check.md`; `rfc-iterative-review`
tail (converge → self-merge RFC → open umbrella → launch chain).

## Edge cases (from the failure-mode panel)

- **Phase gate red / reviewer BLOCK:** record `blocked` + a blocker comment; never force-merge;
  cap review retries then escalate to a human.
- **Crash after merge, before tick (F8):** recover via the recorded PR number's merge state, not
  file-exists.
- **Reverted dependency (F9):** reachability against freshly-fetched `origin/main`; a
  previously-merged phase that becomes unsatisfied flips back to `blocked` and halts downstream
  with an alert; the base is re-verified at the successor's own merge gate, not only at start.
- **Hung/crashed phase, no claim TTL (F7):** a max-phase-duration watchdog fails a stuck phase to
  `blocked` (discoverable) instead of holding its claim forever; the registry reclaims
  terminal/orphaned holders.
- **Malformed/half-written ledger (F10):** round-trip validation before write; on parse failure
  **comment an actionable blocker**, never guess a phase.
- **Non-adjacent / cyclic phases (F12/F13):** strict-sequential selection; DAG/simple-chain
  validation at parse.
- **Migrating #3272 while P2 is in-flight (delivery — present-tense):** see Rollout — **do not**
  bring #3272 under D2 while the manual P2 chain runs; that would double-spawn P2.

## Rollout

1. **Phase 1, additive & opt-in.** Ship D1; verify byte-identical output for non-opted chains
   (CI snapshot). #3272 continues under its **existing manual self-advancing contract** (the P2
   task already running) — D1 changes nothing for it until it is deliberately adopted.
2. **Canary.** First real self-advancing activations = an explicit operator allowlist of 1–2
   chains, behind `KOOKR_SELF_ADVANCING_DISABLED` (default-off flip is deliberate). Soak an entire
   chain end-to-end through **multiple** merge boundaries in a sandbox before enabling on a live
   repo (a one-cycle/60s dry-run validates nothing — the race is at merge boundaries).
3. **Phase 2 (D2)** only after its acceptance criteria above are met; dry-run against a
   **synthetic canary umbrella** across several merge boundaries with a per-run "what I touched"
   audit log, log-would-spawn before spawn-for-real.
4. **#3272 adoption is explicitly gated:** migrate #3272 into D2's ownership only once its manual
   chain has no in-flight claim/open phase branch, or by first marking the running phase
   `in-flight` in the new ledger so D2's own in-flight check no-ops on it. Keep the old prose
   ledger as a fallback read path for N days (dual-read), no one-shot cutover.
5. **Phase 3 (D3)** last.

## Alternatives considered

- **Stacked branches (P_{n+1} off P_n):** advances without merges but rebases are fragile and
  review is harder; the skill already advises against it. Available to a human, not the default.
- **A single long-lived orchestrator task watching each PR:** what #3272 implicitly tried — it
  died when the orchestrator completed. A live watcher is the fragile state D2's durable,
  restartable design replaces.
- **Prose-only (strengthen the skill warning):** the warning already exists and the chain still
  deadlocked. Rejected.
- **Grant every task merge authority:** removes the default-deny guardrail protecting ordinary
  PRs. Rejected — authority is a namespace-bound, rate-capped, opt-in delivery mode.
- **Ship D1+D2 together (v1):** rejected — they overlap at every merge boundary over an unguarded
  shared ledger; review empirically falsified the atomicity/satisfaction/authority claims the
  co-shipping relied on.
- **Native GH task-list checkboxes as the only ledger (minimalist):** adopted for Phase 1 (no new
  format); the fenced machine-block is deferred to D2 where a parser is actually needed.

## Critic feedback incorporated

**Panel (round 1, 5 critics — Panel Selection Gate: N=5 ≤ 5, no override needed).** Selected for
an orchestration-safety RFC: `design-minimalist`, `failure-mode-analyst`, `boundary-critic`
(three of the four "always" lenses), plus `delivery-pragmatist` (self-merge rollout is the heart
of the risk) and `operability-reviewer` (an autonomous background merger must be diagnosable).
`socratic-challenger` was dropped for lens budget; `ambition-amplifier` (normally paired with
`design-minimalist` in rounds 1–2) was **not** launched — its pull is already represented by the
user's explicit ambition (RFC-first pipeline + durable context + auto-progress), so the resolution
of the minimalist's "cut D2/D3" is **defer-with-a-designed-end-state**, not delete: the ambitious
end-state is preserved in Phases 2–3 with safety gates rather than dropped.

**Empirical checkpoint (mandatory, post round-1):** load-bearing claims were probed against source.
Verified true: the deadlock root cause (`resolveContinuationState` collapse-to-null, envelope.ts
:239-248); `worktree-merge-status.ts` exists. **Verified FALSE** (drove the restructure): "ledger
tick is atomic" (no CAS/ETag anywhere — F1); "file-exists = merged" (module never fetches, checks
reachability — F2); "toggle authority is scoped" (open map, verbatim-copied, no provenance — F3);
"review gate is independent" (same lineage can post PASS; raw merge bypasses wrapper — F4).

Resolutions: **F1** → single-writer ledger / file-lock, append-only comments, deferred to D2.
**F2/F8/F9** → fetch-then-PR-reachability satisfaction keyed to recorded PR numbers, in both D1 and
D2. **F3** → `DeliveryPolicy` value not a boolean toggle; namespace-verified grant at merge time;
per-chain self-merge rate cap; global env kill switch. **F4** → distinct-task-id verdict verified
against the registry, wrapper-only merge path, capped re-reviews. **F5** → spawner-side atomic
claim before POST + deterministic idempotency key. **F6** → drift-advance only on terminal owner +
grace window. **F7** → phase watchdog → `blocked`, no infinite claim. **F10/F12/F13** →
round-trip-validated ledger, strict-sequential selection, DAG validation. **Boundary** → single
`nextEligiblePhase`; no PR/path fields on the generic cursor; single ledger writer; `phase-ledger`
codec/policy/audit split when D2 adds them. **Operability** → per-tick log format, ledger reason
codes, chain-health rollup, staleness recovery, post-merge review audit — all Phase-2 acceptance
criteria. **Delivery** → kill switch outside the data path, canary allowlist, multi-boundary soak,
and an explicit #3272-migration precondition so the RFC does not collide with the P2 task running
right now. **Minimalist** → D1-first; D2/D3 deferred; drop `dependsOnMergedPr`, DAG `dependsOn`
list, and version/pattern fields until a second consumer exists.

**Convergence:** because round-1 empirically falsified the co-shipping premise, v2 restructures
around reality (D1-first, D2/D3 deferred with hardened criteria) rather than iterating further on
the broken two-mechanism design. A **Phase-2-specific safety re-review** (single-writer ledger,
claim/idempotency, satisfaction semantics) is required before D2 is implemented — recorded as an
acceptance gate on the umbrella issue rather than run now against code that does not yet exist.
