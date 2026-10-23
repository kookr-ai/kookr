# Evaluation Plan — Does the Notebook Actually Pay Off?

**Status:** Draft (v1 — companion to the Self-Improving Agent Fleet RFC)
**Date:** 2026-10-23
**Author:** Jean Ibarz (with Claude)

> Companion to [`rfc-self-improving-agent-fleet.md`](./rfc-self-improving-agent-fleet.md) and its
> [evidence pack](./rfc-self-improving-agent-fleet-evidence.md). The v4 RFC deliberately shipped
> **no measurement phase** (KISS). This document is the measurement we now owe ourselves *because*
> a first evaluation was run (overnight 2026‑10‑22→23) and its headline finding does not survive
> scrutiny. It re-reads that first evaluation honestly, explains why its result is not trustworthy,
> and specifies a second evaluation that measures the thing the notebook is actually for.

---

## 0. TL;DR

- The first evaluation ("v1") concluded that memory **lowered** the SWE‑bench solve rate (0/4 with
  memory vs 2/4 without). **Retract that as a finding.** It is underpowered (n=4), confounded (patch
  size vs resolve), rests on a hand-rolled resolve check (the official harness was abandoned
  mid-run), and — most importantly — **measured the wrong thing**.
- v1 was a *same-task replay* ("Groundhog Day") on *trivially short* tasks (5–14 agent turns). That
  design can only measure **consistency amplification** (does run *k* copy run 1?), not the
  notebook's actual thesis: **cross-task capitalization** — carrying an expensive, reusable lesson
  from one task to a *different* later task.
- What v1 *did* establish, and we keep: the machinery works end-to-end (record → inject → reuse →
  vote; scores climbed +1 → +3), and it surfaced the real downside — **a wrong first lesson gets
  entrenched**.
- v2 fixes the bias: **different** tasks that share reusable knowledge, each **10–100+ tool calls**,
  a **warm-vs-cold** contrast (not same-task replay), real statistical power, the official grader,
  the confounds controlled, and a **poisoned-lesson** arm to bound the downside. A cheap Tier‑0
  pilot reuses evidence we *already have* on disk.

---

## 1. What v1 actually did (recovered context)

Reconstructed from the orchestrating session, the `nb` usage log, and the emailed report
(`nb-memory-eval-report.html`, 2026‑10‑23 07:24).

**Tool under test.** `agent-notebook` (`nb`), the bounded/voted/one-line per-role memory from the
RFC — published to npm as `agent-notebook@0.1.3`, and merged into Kookr (CLI + two hooks).

**Shared design of both experiments.** Same task, same model (Sonnet), same repo; the *only*
variable is the notebook: **ON** = it persists across runs, **OFF** = wiped before every run.

| | Exp 1 — "Groundhog Day" | Exp 2 — "gotcha positive-case" |
|---|---|---|
| Task | one real SWE‑bench Lite bug, **`pytest-dev__pytest-7220`** | a tiny synthetic repo with a hidden test runner |
| The "lesson" | whatever run 1 discovered about the fix | tests run only via a non-obvious `make test`; bare `pytest` fails cryptically ("environment not prepared") |
| Runs/arm | 4 | 3 |
| Agent length | **~10–14 turns**, ~49–61 s, ~$0.18/run | **~5 turns**, ~19 s/run |
| Cost (ON vs OFF) | **$0.181 vs $0.185** — within noise | flat ~5‑turn baseline both arms |
| Grading | intended: official SWE‑bench Docker harness | fix-applied check |
| Headline result | **ON 0/4, OFF 2/4** resolved | no measurable ON advantage |

**Author's honest v1 takeaway (kept):** the mechanism works; *memory amplifies consistency*, so its
value hinges on first-lesson quality and task type, not repetition; and **there is a real risk it
entrenches a wrong early lesson.**

---

## 2. Why the v1 result is not trustworthy

In descending order of importance.

### 2.1 It measured the wrong question (the category error)

The notebook's product thesis is **capitalization across *different* tasks**: a lesson learned
fixing issue A in a repo (e.g. "this repo needs `npm ci`, not `--ignore-scripts`, or faiss-node
won't build") makes fixing *unrelated* issue B in that repo cheaper or more reliable.

v1's "Groundhog Day" design runs the **identical task** repeatedly with the notebook persisting.
That measures a different, far less valuable thing — whether run *k* reproduces run 1 — and it has a
built-in failure mode: if run 1 is wrong, every later run inherits the wrong approach. So the design
can **only** show "memory makes runs consistent," and when run 1 is below average it shows memory
*hurting*. It structurally **cannot** show capitalization, which is the point. The session even
named it "Groundhog Day" — we knew it was replay; we just can't conclude capitalization from it.

### 2.2 The tasks were far too short

Real agentic work is **10–100+ tool calls**; these tasks were **5–14 turns**. Memory pays off by
**amortizing expensive, reusable discovery** (find the build incantation, the test runner, the repo
convention, the env gotcha) over later work. If the whole task is a handful of calls, there is no
expensive discovery to amortize — and the measured cost gap was correctly ~0 (ON $0.181 vs OFF
$0.185). *This is the bias the evaluation's own author and the reader both flagged, and it is real.*
Even Exp 2, built on purpose around a "gotcha," made the discovery so cheap (~5 turns) that there
was nothing to save.

### 2.3 Underpowered

n = 4 and n = 3 per arm. **0/4 vs 2/4** is one or two coin-flips; it carries no significance. No CIs,
no test, single instance → zero task diversity.

### 2.4 The grader was improvised

The official SWE‑bench harness (swebench 5.0.2) hit a version-mismatch dead-end (the classic Lite
dataset lacks the `image` field the new harness wants). The run fell back to a **hand-rolled
"Direct F2P resolve check."** Reasonable triage under time pressure, but it means the headline number
was **not produced by the standard grader** and isn't comparable to published SWE‑bench results.

### 2.5 A patch-size confound the author flagged but could not close

The *resolved* OFF patches were the **tiny 14‑line** ones; every ON patch (and the failing OFF ones)
were **49–59 lines**. A larger patch is likelier to fail to apply cleanly and then score "unresolved"
**regardless of whether its logic is correct**. So "ON 0/4" may be measuring patch-apply mechanics,
not reasoning quality. This was explicitly suspected in-session and never ruled out.

### 2.6 The headline metric was the wrong one

Turn-count is coarse; **prompt-caching already makes near-identical repeats cheap**, which masks any
token difference on a replayed task. Cost/token deltas are the right currency, but they're ~null *by
construction* when the task is short and the runs are near-identical.

**Net:** v1 proved the plumbing and surfaced the entrenchment risk. It did **not** measure whether
the notebook helps, and its one quantitative headline should not be repeated.

---

## 3. v2 — an evaluation that measures capitalization

### 3.1 The core shift: warm-vs-cold *transfer*, not same-task replay

Replace "same task, memory ON/OFF" with:

- **COLD arm:** the role starts each target task with an **empty** notebook.
- **WARM arm:** the role starts the *same* target task with a notebook **pre-populated by prior,
  *different* tasks in the same repo** (real lessons, not the answer to this task).

The WARM − COLD difference on a **held-out** task is the capitalization value — the actual product
question. Crucially, the warm notebook must never contain this task's solution; it contains lessons
from *sibling* tasks (build/test/env/convention knowledge that is reusable but not task-specific).

### 3.2 Tasks: different, related, and long enough

Three tiers by cost/fidelity. Start at Tier 0.

**Tier 0 — Pilot on evidence we already have (cheap, days).**
Real per-repo notebooks already exist from live Kookr work, e.g.
`~/.kookr/notebooks/patch-author@jeanibarz-knowledge-base-mcp-server.md` with genuinely expensive,
reusable lessons ("worktrees have no node_modules; `npm ci` to build faiss-node before tests",
"`madge --circular` counts type-only imports as cycle edges", "full acceptance gate =
`npm run build && KB_RUN_E2E=1 npm run test:serial`"). That is the substrate memory is *for*.
- Pick 6–10 **new** issues/PRs in `knowledge-base-mcp-server` that none of those lessons solve
  directly but that *benefit* from them.
- Run each COLD and WARM (warm = the existing notebook, with any this-issue-specific line removed).
- This is the fastest honest signal and needs no SWE-bench plumbing.

**Tier 1 — SWE‑bench Lite, grouped by repo (transfer within a repo).**
Pick repos with several instances (django, sympy, sphinx, matplotlib…). For each repo: run instances
in sequence; WARM carries the notebook forward across *different* instances, COLD wipes between them.
Measures whether solving earlier issues makes later *different* issues cheaper/likelier. This is the
natural analogue of Kookr's `<role>@<repo>` notebooks.

**Tier 2 — SWE‑bench Verified, curriculum (the headline number).**
Human-validated, solvable tasks that genuinely take tens of steps. Same per-repo warm/cold protocol,
larger N. Only worth it if Tier 0/1 show a signal.

### 3.3 Arms (ablations that answer the questions that matter)

| Arm | Notebook at task start | Question it answers |
|---|---|---|
| **COLD** | empty | baseline |
| **WARM** | sibling-task lessons (same repo) | **does capitalization help?** (primary) |
| **POISONED** | one deliberately wrong high-scored lesson + real ones | **how bad is entrenchment?** (the v1 risk, bounded) |
| **WARM‑CROSS** (optional) | lessons from a *different* repo | does irrelevant memory just add noise/context rot? |

### 3.4 Metrics (end-state, not path)

- **Primary — resolve rate**, via the **official** SWE‑bench harness on official images, with a
  **pinned** `swebench` version and the matching dataset. No hand-rolled resolve checks. Log
  patch-apply success/failure **separately** so §2.5 can never masquerade as a reasoning result.
- **Secondary — cost:** total USD and tokens, reported **both** cache-aware and cache-excluded
  (so caching can't silently erase the effect); wall-clock; tool-call count; number of
  "exploration" reads avoided (proxy for discovery reuse).
- **Downside (POISONED):** resolve-rate drop and extra cost vs COLD — the price of a bad lesson.

### 3.5 Controls & rigor

- Fix model + temperature + scaffold + harness version; one variable (the notebook) at a time.
- **Pre-register** the hypothesis, the primary metric, and the decision thresholds *before* running.
- Power: enough runs for a real test — **≥10–20 runs/instance**, or many instances × a few runs;
  report CIs and a paired test (same instance, warm vs cold). Treat n=4 as a smoke test, never a
  result.
- **Blind grading** (grader never sees the arm). Counterbalance instance order to cancel learning
  curves in the suite itself.
- Isolation: each run in its own fresh worktree; warm notebook injected read-only at `SessionStart`
  via the existing hook, scrubbed of any line that leaks the target solution.

### 3.6 Decision thresholds (pre-registered)

Write these down before running, so the result can't be rationalized after:
- **Ship-positive:** WARM beats COLD by **≥ 10 pts** resolve **or** **≥ 20 %** cost at **p < 0.05**,
  with no worse than flat on the other.
- **Downside-acceptable:** POISONED is no more than **≤ 5 pts** below COLD (vote/eviction contains a
  bad lesson quickly) — otherwise the curation loop needs a floor or a faster demote.
- **Kill/park:** WARM ≈ COLD within noise across Tiers 0–1 → the notebook is cheap insurance, not a
  performance lever; keep it for operability, don't invest further.

---

## 4. Threats to validity (v2's own)

- **Lesson leakage** — the warm notebook accidentally encodes the target answer. Mitigation: sibling
  tasks only; scrub + manual review of the injected notebook per target.
- **Benchmark memorization** — SWE‑bench instances may be in pretraining. Mitigation: prefer
  Verified; include at least one private/held-out repo (e.g. a Kookr-internal issue set).
- **Scaffold interaction** — results may be specific to the Kookr/Claude-Code scaffold. Report as
  "notebook value *in this scaffold*," don't overclaim generality.
- **Context-rot from the notebook itself** — a big/irrelevant notebook can *lower* accuracy
  (the evidence pack's "injected `_wisdom` devalued" finding, Chroma context-rot). WARM‑CROSS is the
  guard; keep notebooks small per the RFC caps.

---

## 5. Cost & sequencing

1. **Tier 0 pilot** (kb-mcp-server, 6–10 issues, COLD+WARM, ~tens of $). Go/no-go on everything
   below. *Do this first.*
2. If signal → **Tier 1** (SWE‑bench Lite, 2–3 repos, +POISONED).
3. If still positive → **Tier 2** (Verified curriculum) for a citable headline.

Respecting the RFC's KISS ethos: stop at the first tier that answers the question. A null at Tier 0
is itself a valid, cheap finding — "the notebook is operability insurance, not a solve-rate lever" —
and far more honest than v1's retracted headline.

---

## 6. What to tell coworkers now

> The first run proved the notebook *works mechanically* and flagged its real risk (a wrong first
> lesson sticks). It did **not** measure whether memory makes agents better, because it replayed one
> tiny task instead of testing whether a lesson from one task helps a *different* one. The honest
> status is "built and plumbed, value not yet measured." v2 measures the value, starting with a cheap
> pilot on lessons we already captured in real work.
