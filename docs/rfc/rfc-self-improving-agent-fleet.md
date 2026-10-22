# RFC: Self-Improving Agent Fleet with Bounded, Measured Memory

**Status:** Draft (v2 — post brainstorm-swarm + consensus attack + delivery/operability review; pre user review)
**Date:** 2026-10-22
**Author:** Jean Ibarz (with Claude)

> Companion evidence pack: [`rfc-self-improving-agent-fleet-evidence.md`](./rfc-self-improving-agent-fleet-evidence.md) — the shared, source-tagged research all claims trace back to. An ultra-pedagogical rendering of this RFC ships as `rfc-self-improving-agent-fleet.html` next to this file.

---

## Problem

The operator wants, from today, for Kookr's agents to **use multi-agent more**, and specifically wants a system where:

1. a **main orchestrator** launches **specialized sub-agents**, each able to act **across different repositories**;
2. each agent has **its own memory** and can **capitalize its experience** — reflect on what it did and self-improve by updating that memory automatically;
3. the orchestrator has **clear tools and instructions** to launch a sub-agent on a unit of work and get back **a work product, an artifact, or constructive feedback** that moves things forward — **reducing the back-and-forth**;
4. **above all**, memory stays **small and auto-purgeable** — because memory tends to only ever grow, and unbounded memory is a serious problem: it slows agents down, costs more, and *degrades reasoning* (noise, stale and contradictory entries, "context rot").

### Why this is not a greenfield build

Kookr already contains almost every part. The honest gap is narrow and specific. Two facts frame everything below.

**Fact 1 — Kookr has two different "agent" layers, and they bound memory *oppositely*.**

| | **Layer A — the fleet** | **Layer B — the swarm** |
|---|---|---|
| What it is | a *task-level process* (`claude-code`/`codex`/…) in a dtach/tmux session, in a git worktree | an *in-process* `Agent`-tool sub-agent (`plugin/agents/*.md`) |
| Launched by | `POST /api/tasks` → `src/server/launch-service.ts`, `bin/kookr-spawn.js` | `Agent({subagent_type: "kookr-toolkit:<name>"})` |
| Lifetime | long-lived, cross-repo, persistent | one fresh context window, returns a summary, vanishes |
| Memory | a durable store that **must be purged** | a context window that **must never be persisted** |

The user's "orchestrator launches persistent cross-repo sub-agents with their own memory" is **Layer A**. The "specialized lenses" (critics, reviewers) are **Layer B**. *Welding them into one "sub-agent" abstraction is the single biggest design risk* — one abstraction over both yields either persisted scratch context (poisoned memory) or a purge actuator aimed at ephemeral state.

**Fact 2 — the memory asymmetry is already shipped and already hurting.**

Kookr has a rich, *gated, forced* self-**write** path: the post-task lesson gate (issue #1538) returns **409** on `kookr signal completion-ready` unless the hook trail shows a `kb remember` or an explicit skip marker. It has **no self-prune path at all** for memory. The result is on the record and measured:

- `agent-task-lessons` = **1,319 notes**, `_wisdom` = **342**, both **monotonically growing** (verified 2026-10-22).
- `kb superseded` and the Repository Pruning Scout playbook only **propose**; nothing deletes, demotes, or expires a note. Most `agent-task-lessons` notes have **no frontmatter**, so even the staleness *proposer* is blind to them.
- The one in-house *measurement* of injected accumulated memory is **negative**: `kb-scout-evol` retired a closed axis ("do not reopen") because the judge **measurably devalues injected `_wisdom` chunks**. External evidence agrees — "context rot" (Chroma, 18 models) shows every family scores higher on ~300-token focused prompts than on ~113k-token ones.

So Kookr forces memory *up* with a gate, has evidence that injecting it *down-weights* quality, and has **no mechanism to push volume back down**. That is the actual problem. It is not "we lack a memory store"; it is "**we never decided whether a given memory earns its context cost, and we can't take it back when it doesn't.**"

---

## Requirements

**R1 — Two layers, never welded.** Persistent memory and the brief→artifact→feedback contract ride **Layer A** only. Layer B stays ephemeral.

**R2 — Memory is a *measured liability*, default-off for semantic injection.** An agent does **not** get a standing semantic memory store by default. The primary way it capitalizes experience is **procedural** (promoting a verified lesson to a `SKILL.md`, loaded by metadata only) plus **just-in-time re-derivation** from the non-lossy source of truth (git history, PRs, the diff, the task ledger, the review-verdict trail). Standing semantic memory is switched **on per-scope only where it is *measured* to raise task outcome.**

**R3 — Every write has a symmetric down-step; the *injected* budget is bounded.** For every forced-write gate there is a prune/demote counterpart. The read-time budget (~1–2K tokens, top-k) is a hard cap. *(The injection path is already conservative — see D6-note: the read hook is opt-in and already injects nothing on error — so this requirement is about adding the missing down-step and tightening the one unconservative branch, not about fixing a live over-injection leak.)*

**R4 — "Purge" means *demote from the hot/injected tier*, with retrievability retained — not destructive delete — and the fleet's memory is a different resource from the shared human/`kb-scout` commons.** Autonomous *apply* touches only fleet-owned scoped shelves. The existing shared shelves (`agent-task-lessons`, `_wisdom`) are a **commons**; anything that would mutate them runs **propose-only, human-gated**. Contradictions **invalidate (timestamp), not delete**; consolidation is **reversible** over a non-lossy backing store; every demotion is undoable by run id.

**R5 — The orchestrator↔worker contract is *typed in, typed out by reference*.** A worker receives a complete self-contained brief and returns a small structured result pointing at an artifact — not the artifact's contents, and not a conversation. Feedback loops close with an **evaluator**, not chat. The orchestrator must have a defined behaviour for a *missing or malformed* result, and must not rely on worker-asserted facts it can verify independently.

**R6 — Spawning is disciplined, not reflexive.** A sub-agent is a purchase (~15× single-agent tokens). It is spawned only when the work is **parallelizable AND bounded/verifiable AND worth ≥ the multiplier**. A lens that needs neither its own memory scope nor its own tool/isolation boundary is a **prompt, not an agent**.

**R7 — Reuse over build.** Prefer a playbook + skill + hook + one thin CLI verb over any new `src/` service, registry, or schema — *except* where reuse is only skin-deep (D4 shows `kb demote` is a genuine cross-package change, not a thin verb).

**R8 — Every autonomous mutation is observable before, during, and after.** A wrongful demotion or a budget breach must be detectable by a *signal*, not only by its downstream consequence ("later tasks score worse", "the invoice"). Dry-run diff, per-note ledger, blast-radius cap, regret tripwires, and a real-time metered cost total are part of the design, not follow-ups.

---

## Design

### The shape in one picture

```
                         ┌──────────────────────────────────────────┐
                         │           ORCHESTRATOR  (Layer A lead)     │
                         │  • applies the Spawn-Decision Rule (R6)    │
                         │  • writes a TYPED BRIEF per unit (R5)      │
                         │  • reads TYPED RESULTS by reference        │
                         │  • verifies worker claims; never trusts    │
                         │    cost/verdict/artifact unchecked         │
                         └───────────────┬────────────────────────────┘
          typed brief (objective,        │          typed result (status, artifact_ref,
          repo_scope, acceptance,        │          verdict, head_sha, cost_usd, summary≤2K,
          tools, boundaries,             ▼          started_at, last_progress_at)
          artifact_path, memory_scope,
          brief_id)
   ┌─────────────────────┬───────────────────────────┬──────────────────────┐
   ▼                     ▼                           ▼                      ▼
┌────────────┐   ┌──────────────────┐   ┌─────────────────────┐   ┌──────────────────┐
│ Layer-A    │   │ Layer-A worker    │   │ Layer-B lens swarm  │   │ Layer-A          │
│ worker     │   │ (repo-2, parallel)│   │ (critics/reviewers, │   │ MEMORY-JANITOR   │
│ (repo-1,   │   │                   │   │  ephemeral, return  │   │ (scheduled,      │
│  worktree) │   │                   │   │  1–2K summaries)    │   │  owns no memory) │
└─────┬──────┘   └─────────┬─────────┘   └─────────────────────┘   └────────┬─────────┘
      │ reflect-then-write (gated)        promote across ≥2 repos            │ demote / consolidate
      ▼                                        ▼                 (fleet shelves: apply;
┌─────────────────────────────────────────────────────────────────  commons: propose-only)
│                         MEMORY  (filesystem + KB, Layer A only)        │                │
│  PROCEDURAL  skills/<capability>.md ── metadata-only load, fitness-capped (primary)      │
│  SEMANTIC    fleet shelves <capability>/<repo> ── DEFAULT OFF; on per-scope by measure   │
│  EPISODIC    git / PRs / task ledger / hook JSONL ── the non-lossy source of truth       │
│              (never a second hot copy; re-derived just-in-time)                          │
│  ─────────── SHARED COMMONS (agent-task-lessons, _wisdom; humans + kb-scout) ───────────│
│              autonomous APPLY never touches it — propose-only, human-gated               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### D1 — The orchestrator↔worker contract (kills the back-and-forth)

Workers have no shared memory, so **the brief is the entire contract** (Anthropic's multi-agent lesson: vague briefs cause duplicated work). The result returns **by reference** (write the artifact to disk/PR; return a pointer), extending the one machine-readable return Kookr already parses — the independent-review verdict triple (`src/core/independent-review.ts`, parsed by `scripts/kookr-merge.sh`).

**Typed brief (in):** `objective` (one sentence) · `repo_scope` (project id `github.com/owner/repo`) · `cwd` (worktree) · `output_format` (`pr|patch|report|verdict`) · `acceptance` (the rubric the evaluator checks) · `allowed_tools` (least privilege) · `boundaries` (out-of-scope) · `artifact_path` (where to write) · `memory_scope` (shelf tag, read-only, **absent by default**, R2) · `brief_id` (correlation key, propagated into task records, hook JSONL, audit rows, and KB write provenance so one fan-out is debuggable across N repos).

**Typed result (out, by reference):**

```
kookr-worker-verdict: pass | block | input_required
kookr-artifact-ref:   <path | pr-url>      # pointer, NOT contents
review-head-sha:      <full sha>            # verified by kookr-merge.sh
kookr-brief-id:       <id>
kookr-cost-usd:       <number>              # CROSS-CHECK only — authoritative cost is metered (D6)
summary:              <=2000 chars
started_at / last_progress_at:  <ts>        # so a hung worker is a state, not silence
```

**Verify, don't trust (R5/R8).** `review-head-sha` is already verified by `kookr-merge.sh`; the supervisor must likewise verify that `artifact_ref` resolves and that reported cost matches the metered cost (D6), and raise an `anomaly-detector` event on mismatch. A **missing/malformed/contradictory** result (e.g. `pass` with no `artifact_ref`, `block` on an already-merged PR, or no result past a timeout) is a defined state (`result_missing`), not silence.

**Close the loop with an evaluator, not a conversation.** Worker emits artifact → a rubric-driven evaluator (reuse `autonomous-review-loop`, default 10 iterations, exact-head binding) returns `pass/block` + structured feedback. The orchestrator reads **summary + verdict only**.

**Do not claim victory over the inference tax yet.** Today the supervisor infers outcomes from hook JSONL + PR scraping + completion sweeps. The typed return is designed to *replace* that — but only after its delivery reliability is **measured**. Until then the typed return and the hook-JSONL path run as **cross-checks**, and the sweeps/TTLs stay. (Both reviewers flagged that deleting the second truth source before the first is proven is how you end up with none.)

### D2 — The Spawn-Decision Rule (use multi-agent *more*, but where it pays)

Spawn a Layer-A worker **iff all three hold**: (1) **parallelizable** — independent of sibling work, no shared mutable context; (2) **bounded + verifiable** — closes on a machine-checkable artifact, returns by reference, needs no mid-run steering; (3) **value ≥ the multiplier** — multi-agent ≈ 15× tokens, so the unit must buy that back in parallelism, isolation, or avoided re-derivation.

Apply Anthropic's **effort ladder** as a dial: simple → 1 agent / 3–10 calls; comparison → 2–4 workers; complex/fan-out → more. Where "use multi-agent more" genuinely pays: **the Layer-B critic/lens swarm** (this RFC was written by one), **fan-out of one mechanical change across N repos**, **blind independent review**. Where it is a 15× waste: single-repo features with cross-file dependencies ("most coding tasks").

**Worth-a-specialist test.** A capability earns its own agent **iff** it needs its own *persistent memory scope* **or** its own *tool/isolation boundary*. Otherwise it is a prompt. A capability-shaped starter roster (not human job titles): Repo-Cartographer (A, per-repo map, if measured) · Reproduction-Harness-Builder (B, procedural skill) · Patch-Author (B, `isolation: worktree`, **no** persistent memory) · Cross-Repo-Pattern-Spotter (A, the only legitimate cross-repo store) · Memory-Janitor (A, scheduled, **owns no memory**).

### D3 — Memory model: procedural-first, semantic default-off, episodic as source of truth

Three *typed* stores (CoALA), deliberately unequal in status:

- **Procedural — the primary capitalization path.** A verified lesson that recurs (and, for cross-repo value, recurs across **≥2 repos**) is promoted to a `SKILL.md`, loaded by **metadata only** (progressive disclosure → *zero idle context cost*). Added **only after self-verification + behaviour dedup** (Voyager), so growth is sublinear.
- **Semantic — default OFF, earned per-scope by measurement (R2).** When enabled for a scope, the hot store is **hard-capped (50–200 facts/scope)**; writes go through **Mem0 four-op reconciliation** (ADD / UPDATE / INVALIDATE / NOOP), never blind append; retrieval scores **recency × importance × relevance** into a ~1–2K-token top-k budget. Enabled only where P0 (below) shows injection raises outcome.
- **Episodic — never a second hot copy.** The raw trajectory already lives, non-lossy and versioned, in git/PRs/the task ledger/hook JSONL. Re-derive it just-in-time; do not maintain a parallel episodic shelf.

**Decays-out-of-hot ≠ truly-forgotten.** Dropping below the injected top-k budget is *invisible but recoverable* (still on disk, still reachable by explicit `kb search`). That is the only forgetting enabled by default. A demotion is *hidden-but-flagged*, undoable by run id (D6). Deleting a backing row is not a default operation at all.

### D4 — The missing piece: a self-prune **actuator** (demote, don't delete)

This is the one genuinely new capability. It is composed from proven in-repo loops, but it is **not** a thin verb — the delivery review established three corrections that change its shape.

**Two separate problems, do not conflate them:**

- **The commons problem (the live defect).** `agent-task-lessons` (1,319) and `_wisdom` (342) are **shared** shelves read by humans and `kb-scout`. Bounding them is real and urgent, but it is a **propose-only, human-gated** job — autonomous `--apply` on the commons is forbidden (R4). It also needs a one-time decision for the frontmatter-less legacy notes (leave out of scope, or a human-gated tagging migration).
- **The fleet problem (greenfield).** Fleet-owned `<capability>/<repo>` shelves hold nothing today. They are where `--apply` can eventually run, because the fleet owns them.

**`kb demote` is a cross-package change, not a `src/` subcommand.** The KB is the external `@jeanibarz/knowledge-base-mcp-server`; shelves are plain `~/knowledge_bases/<shelf>/*.md` indexed by FAISS + BM25. "Demote while staying retrievable by explicit search" requires the *package* to gain a per-note **exclusion from the default index/gate** — it does not exist yet. So `kb demote` is a **prerequisite capability in the external package**, version-pinned, and `--apply` is gated on it.

**Ship order (propose before apply):**
1. **`plugin/skills/kb-prune/SKILL.md`** + **`plugin/playbooks/kb-prune-schedule.md`** running **`--propose` only**, producing a **dry-run diff** (N notes, % of shelf, top reasons, oldest/newest) and a per-note manifest. Classify by the Repository Pruning Scout taxonomy (keep / condense-superseded / remove-orphaned / consolidate-duplicated); reuse `kb superseded` for staleness. No new scoring engine.
2. **`kb demote --kb=<shelf> --propose`** then, later and separately, **`--apply`** — gated on: the external package's per-note exclusion support; a **`kb undemote --run=<id>`** restore verb with a reindex-completion signal; an **enforced shelf allowlist** (the CLI refuses any shelf without a `fleet/` ownership marker — this makes the R4 namespace split a *checked entry criterion*, not a convention); and a **restore drill** run once before `--apply` is enabled.

**Safety invariants reused, recovery model NOT reused.** The `prune-aged-task-records.ts` invariants — predelete snapshot, archive-before-mutate (`archive_failed` ⇒ abort), tree-integrity, mandatory audit — are reused as a **checklist**, with concrete equivalents named: a pre-run copy of the affected shelf, the `kb undemote` inverse, and a tested abort-on-failure path. Its *recovery model* (snapshot-union read of an owned, 1-day-TTL buffer) is **not** reused — a knowledge commons has no retention contract.

**Consolidation uses distill→reset only on a fleet-owned *private* buffer.** `codex-pr-distill`'s reset-raw (Rule 4: reset to a 6-line header) is destructive by construction; it is safe only because its raw file is a private accumulation buffer (`~/.claude/codex-pr-lessons/learnings-raw.md`) whose distilled output is preserved. The janitor applies this pattern to a **fleet-owned raw buffer**, never to the shared commons.

**The promoted store is bounded too (the Forgetter's catch).** Promotion to `SKILL.md` must not become the new unbounded pile. The skill library gets a **fitness score** (how often a skill fires *and* succeeds) and low-fitness demotion — *contingent on a telemetry source existing* (today skill-firing is not observed per task; see Open Questions). No skill is permanent.

**The symmetric down-step is its own slice, off the hot path.** Wherever the #1538 gate forces a write up, a down-step fires `kb demote --propose`. But wiring it into the `completion-ready` hot path couples it to the `kb` spool shim (proposals lost/duplicated during a degraded/spool state) and adds latency. So it ships as a **separate, out-of-band slice** (e.g. the scheduled janitor reads the write ledger), not an inline hook, and proposals land in one durable, reviewable, bounded queue — not an unbounded backlog.

### D5 — Delivery phases (measurement before machinery)

The consensus attack's decisive point: *the benefit of standing semantic memory was never measured, and the one in-house measurement is negative.* So we build the **measurement first**, as a *designed experiment*, and every later phase is conditional on it.

| Phase | Deliverable | Depends on | Notes from review |
|---|---|---|---|
| **P0 — Measure (designed experiment)** | Add per-chunk injection logging to `kb-context-injection` with an **injection-state tag** `{injected \| suppressed \| off}` + reason; a **randomized injection-off holdout** arm (observational on/off is confounded by task difficulty); an outcome join via the **terminal-task archive** (live state is pruned at 1 day); a **report surface** (`kookr` report verb / panel: per-scope outcome rate on-vs-off, n, "insufficient data" under a min-n), reusing the existing outcome ledger. Also add a 3-state flag `KOOKR_KB_CONTEXT_FAILCLOSED=off\|log\|on` tightening only the `low_confidence`/judge-failed branch, default **`log`** (records what it *would* drop). | nothing | The hook is opt-in and already injects nothing on error, so P0 must **create a population** (enable an arm) — passive logging yields an uninterpretable dataset. This is the correction to v1's "fix an active leak" framing. |
| **P1 — Typed contract + spawn rule** | The brief/result grammar as a **doc milestone**, then its first real slice: a **parser/consumer** so the fields do work; the Spawn-Decision Rule + effort ladder; reuse Claude per-session caps; **server-side metered** fleet `cost_usd` roll-up (D6). | nothing | "Doc-only" delivers no back-and-forth reduction until a consumer parses it. Keep the hook-JSONL cross-check; do not retire sweeps yet. |
| **P2 — Self-prune actuator (`--propose` only)** | `kb-prune` skill + schedule playbook in **propose-only** mode; dry-run diff; per-note manifest; blast-radius cap. Addresses the **commons** defect by surfacing proposals for human review. | P0 (outcome signal) **and** P1 (metered cost ceiling for the scheduled LLM job) | v1 wrongly listed "P0 only" and wrongly scoped the janitor to empty fleet shelves. |
| **P2a — `--apply` on fleet shelves** | `kb demote --apply` + `kb undemote`, gated on external-package support, shelf allowlist, restore drill, quarantine period. | P2 + external package capability | Separate, later slice. Never on the commons. |
| **P3 — Earn semantic memory + procedural fitness cap** | Turn on fleet-owned semantic shelves **only for scopes P0 shows benefit**; Mem0 four-op writes; promote ≥2-repo lessons to `SKILL.md`; fitness-cap the skill library (if telemetry exists). | P0 data + P2a | Only build the store apparatus where measurement justifies it. |

**P0, P1, P2 are worth doing even if P3 never happens** — i.e. even if the honest answer turns out to be "no standing semantic memory." P0 is the measurement, P1 is the contract, P2 surfaces the commons leak for human review. Only P2a/P3 depend on the store being worth keeping.

### D6 — Observability, recovery, and cost truth

Both reviewers found the same gap: the autonomous demotion path and the lights-out cost integral were, in v1, detectable only by consequence. This section makes them observable. Everything here reuses an existing Kookr surface where one exists.

**Janitor ledger + dry-run + blast radius.** Every run writes a `kb.demote` audit row to the existing `<dataDir>/audit.jsonl` (run id, mode, shelf, counts, abort reason) **plus a per-note manifest** (path, shelf, content hash, classification, score inputs, archive path). The audit write is **mandatory for `--apply`: no row, no apply** (the borrowed `prune-aged-task-records` row holds only ids+count and is best-effort — insufficient here). `--propose` emits a reviewable **diff**. A **per-run blast-radius cap** (e.g. abort if > 10% of a shelf would be demoted) is the cheapest guard against a bad classifier.

**Recovery.** `kb undemote --run=<id>` ships **in the same slice as `kb demote --apply`**, with a documented reindex step and a completion signal (FAISS/BM25 must rebuild). A **quarantine period** (demoted = hidden-but-flagged for N days before the demotion is final) gives the tripwires time to fire.

**Wrongful-demotion tripwires (the regret signal).** Because credit assignment is unsolved, do not rely on outcome drift alone. Log, cheaply and directly: every explicit `kb search` that **hits a demoted note**, and every `kb remember` that **near-duplicates a demoted note** (an agent re-learning what was demoted). Report these as a **"regret rate per janitor run"**; a rising rate is the alarm. Start every demotion rule as a **canary slice** (demote a fraction first) so regret is comparable.

**Run-state legibility.** The janitor has explicit outcomes — `ran:noop` / `ran:proposed N` / `ran:applied N` / `aborted:archive_failed` / `skipped:degraded` / `did-not-run` — surfaced in `kookr status` (reuse schedule-runner run-history), so a skipped night is not indistinguishable from a healthy one. A note's tier (`hot` / `demoted` / `decayed-below-top-k`) is queryable, so "absent" is never ambiguous.

**Cost truth (server-side, metered, real-time).** Worker-self-reported `kookr-cost-usd` is a **cross-check only**; a stuck/crashed worker reports nothing, and Claude's `maxBudgetUsd` is per-session and does **not** span separate Layer-A processes. The authoritative integral is computed **server-side from adapter metering** (`completion-metadata.ts`, rollout metering), keyed by `brief_id`/`parentTaskId`, and exposed in `GET /api/orchestration/status` and `kookr orchestration status` (spent, ceiling, burn rate, projected exhaustion, top tasks by spend). Add a **`cost-ceiling`** pause source alongside the existing `human|soft-quota`: soft thresholds (50/80%) feed the anomaly detector; the hard stop refuses new spawns, signals in-flight workers, and leaves a visible reason in pause status.

---

## Files to change

- **New (plugin):** `plugin/playbooks/kb-prune-schedule.md`, `plugin/skills/kb-prune/SKILL.md`.
- **New (external package, prerequisite):** per-note index/gate exclusion in `@jeanibarz/knowledge-base-mcp-server`, surfaced as `kb demote` / `kb undemote` (version-pinned; `--apply` gated on it).
- **Extend (src):** `src/core/kb-context-injection.ts` (3-state fail-closed flag on the `low_confidence` branch + per-chunk injection-state logging); server-side cost roll-up + `cost-ceiling` pause source in the orchestration status route and `kookr-orchestration.ts`; supervisor claim-verification + `result_missing` state; `brief_id` propagation into task records / hook JSONL / audit / KB provenance.
- **Extend (doc/contract):** the worker verdict-triple grammar, then a parser slice that consumes it.
- **Reuse unchanged:** `launch-service.ts`, `bin/kookr-spawn.js`, `repo-policy-resolver.ts`, worktree guardrails, `independent-review.ts` + `scripts/kookr-merge.sh`, `autonomous-review-loop`, `codex-pr-distill` (pattern, on a private buffer only), `prune-aged-task-records.ts` (invariants as a checklist), `repository-pruning-scout.md` (taxonomy), the KB CLI + FAISS/BM25/RRF, the `audit.jsonl` + outcome-ledger surfaces.
- **Explicitly NOT built:** a bespoke memory fabric; a new agent registry; a Layer-A/Layer-B unified sub-agent class; any autonomous `--apply` on the shared commons; any claim that the hook-JSONL inference path is deleted before the typed return's reliability is measured.

## Edge cases

- **KB degraded / spooling** (`kb-spool-shim`): read gate in `log`/`on` mode records a `suppressed:degraded` tag (and does not inject on that branch); janitor emits `skipped:degraded` and never runs `--apply`.
- **Scheduled run with no human present:** propose-only by definition; proposals land in the bounded review queue; `--apply` never runs unattended on any shelf in P2, and only on allowlisted fleet shelves in P2a.
- **Blast-radius exceeded:** abort the run, escalate via anomaly detector, demote nothing.
- **Contradiction that is actually a refinement:** INVALIDATE with a temporal-overlap check, keep the row.
- **False-dedup** at cosine > 0.85: require LLM confirmation before a merge.
- **Hung/crashed worker:** `last_progress_at` staleness → `result_missing`; metered cost still accrues to the ceiling even though the worker self-reports nothing.
- **Mid-flight budget breach:** the next spawn is refused with a visible `cost-ceiling` reason; in-flight workers are signalled.
- **Legacy frontmatter-less commons notes:** out of scope for auto-classification until a human-gated tagging migration runs.

## Alternatives considered

- **A bespoke "memory fabric."** Rejected — duplicates the KB's FAISS+BM25+RRF, shelf scoping, and spool-degradation handling, and would rot next to the real KB. The gap is a *write-side actuator*, not a store.
- **Weld Layer A and Layer B into one "sub-agent."** Rejected — they bound memory oppositely (R1).
- **Keep the standing semantic store as the default and just bound it** (the pre-attack framing). Demoted to P3, conditional on P0 data — the only in-house measurement is negative and the benefit is unmeasured. The option stays alive so measurement can turn it on where it earns its place.
- **Pure Forgetter (empty memory, delete cold rows by age).** Rejected — risks a *permanently-junior* fleet via silent false-dedup / over-eager invalidation; retirement must be driven by **outcome**, not age (Forgetter and Archivist converged here independently).
- **Pure Fleet-first (concurrency 20, specialist per capability).** Tempered — concurrency starts at 4; a specialist must pass the Worth-a-specialist test.
- **`kb demote` as a thin in-repo subcommand** (v1). Rejected — "demote while retrievable" needs an index-exclusion state the external KB package does not have; it is a cross-package prerequisite, propose-first, apply gated.
- **Flip the read gate fail-open→fail-closed as a plain fix** (v1). Rejected as mis-specified — the hook is opt-in and already injects nothing on error. Replaced by a 3-state flag on the one unconservative branch, default `log`.

## Critic feedback incorporated

Drafted *after* a 5-agent adversarial brainstorm swarm (invented, deliberately-conflicting roles, blind + parallel) + a consensus attack — `adversarial-swarm-analysis`, used in place of the standard critic roster per the task's request for "agents inédits" — then hardened by a targeted 2-critic panel on the two lenses the swarm did not carry.

- **Swarm panel (blind, parallel):** The Forgetter ⟷ The Archivist; The Economist ⟷ The Fleet Maximalist; The Dark-Factory Mechanic.
- **Agreement across opposed incentives (strong signal):** keep Layer A/B separate; the #1538 forced-write gate has no down-step (the live defect); reuse KB + distill/prune templates over a bespoke fabric; bound what is *injected*, not only what is stored; invalidate-not-delete over a non-lossy backing store; typed brief→artifact-by-reference→verdict with an evaluator not chat; the Worth-a-specialist test; **decide retention by outcome, not age**.
- **Conflicts preserved as decisions:** default memory posture → default-off semantic + outcome-driven retirement; default agent posture → Spawn-Decision Rule, concurrency start 4; the Forgetter's catch that *promotion-to-skill relocates the leak* → fitness cap on the skill library.
- **adversarial-swarm consensus attack (general-purpose, 2026-10-22): FINDING — did not survive.** The framing presupposed a standing semantic store *should exist* while the sole in-house measurement is negative. **Incorporated** by making memory a *measured liability* (R2), a measurement-first **P0**, and reframing `kb prune`→`kb demote` (shared-commons model).
- **delivery-pragmatist (2026-10-22):** verified against source. Corrected v1's **fail-closed mis-specification** (hook is opt-in; errors already inject nothing) → 3-state flag on the `low_confidence` branch; exposed the **namespace contradiction** (janitor scoped to empty fleet shelves can't fix the 1,319-note commons defect; scoping it to the commons breaks R4) → split commons (propose-only) from fleet (apply); `kb demote` is a **cross-package** change, propose-first, apply-gated; **P2 depends on P1** cost roll-up; P1 typed contract needs a parser slice; `codex-pr-distill` reset-raw is destructive → private-buffer only.
- **operability-reviewer (2026-10-22):** verified against source. Added **D6** — per-note demotion ledger + mandatory audit, dry-run diff, blast-radius cap, `kb undemote` + quarantine + restore drill, regret tripwires, run-state legibility, and **server-side metered** real-time cost (worker self-report is cross-check only; Claude `maxBudgetUsd` doesn't span Layer-A processes) with a `cost-ceiling` pause source; made the typed result verify claims and define `result_missing`; kept the hook-JSONL cross-check until the typed return's reliability is measured.
- **Empirical validation (orchestrator, 2026-10-22):** `prune-aged-task-records.ts` invariants, `codex-pr-distill` Rule 4, `kb-context-injection.ts` behaviour, `repository-pruning-scout.md` on `origin/main` (proposal-only), KB scale (1,319 / 342) all confirmed against source.

## Open questions

1. **Retrieval-outcome attribution.** Crediting one of 5–20 injected chunks for a task's success is unsolved. P0 starts with the *coarse, randomized* signal (per-scope injection on/off vs outcome), not per-chunk attribution.
2. **External package as load-bearing mutation infra.** `kb demote`/`undemote` live in `@jeanibarz/knowledge-base-mcp-server`. Pin versions; keep `--apply` human-gated and behind a contract test; the restore drill is a hard entry criterion.
3. **Commons ownership & migration.** Who owns `agent-task-lessons`/`_wisdom`, and how are the ~1,300 frontmatter-less legacy notes handled — left out of scope, or a one-time human-gated tagging migration?
4. **Skill-fitness telemetry.** Low-fitness skill demotion needs a per-task skill-firing + outcome signal that does not exist today; defer the fitness cap until it does.
5. **Concurrency default.** Start at 4 (Economist) vs 20 (Fleet Maximalist) — resolve with P1's metered-cost evidence from a real lights-out run.
