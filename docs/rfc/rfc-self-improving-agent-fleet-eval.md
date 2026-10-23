# Evaluation Plan — Does the Notebook Actually Pay Off?

**Status:** Draft (v1.1 — companion to the Self-Improving Agent Fleet RFC; v1.1 makes the corrective
feedback signal the central variable and adds the repeated-complex-task improvement-curve mode)
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
  mid-run), and — most importantly — **ran a learning loop with no corrective feedback**.
- The real flaw: v1's write recorded run 1's *approach* regardless of outcome, so repetition could
  only **amplify run 1** (hence "0/4"). That feedback-less case never happens in practice — tests
  fail, a reviewer objects, a human corrects. **With** a signal, repeating a *complex* task is a
  virtue: it should get cheaper/more reliable over runs (the Reflexion pattern). v1 broke that two
  ways at once — trivial tasks (5–14 turns) **and** no outcome fed back.
- What v1 *did* establish, and we keep: the machinery works end-to-end (record → inject → reuse →
  vote; scores climbed +1 → +3), and it surfaced the real downside — **an unverified first lesson
  gets entrenched**.
- v2 makes the **feedback signal** the central variable and measures two modes: **(A)** iterative
  improvement on a *repeated complex task* with feedback (the improvement curve), and **(B)**
  capitalization across *different* tasks (warm vs cold). Both with 10–100+ tool-call tasks, the
  official grader, the confounds controlled, real power, and entrenchment controls (POISONED /
  no-feedback). A cheap Tier‑0 pilot reuses evidence we *already have* on disk.

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

### 2.1 The loop had no corrective feedback signal (the real flaw)

Memory only *learns* when the write is driven by an **outcome signal** — the task's tests passing or
failing, a reviewer's verdict, a human correction. v1's ON arm recorded run 1's *approach*
regardless of whether it worked, and the vote loop had no ground-truth fed back into it. So
repetition could do only one thing: **amplify run 1.** When run 1 was weak, every later run
faithfully inherited the weakness — hence "0/4." That is not "memory hurts"; it is "a feedback-less
loop entrenches whatever it saw first."

This matters because the feedback-less case essentially **never occurs in practice** — someone or
something eventually tells the agent it was wrong (failing tests, a PR review, a human). With that
signal wired in, repeating a task is a *virtue*: run 1 fails the hidden test → record "approach X
fails F2P, try Y" → run 2 improves. That is the Reflexion pattern (write a self-reflection on
failure, condition the next attempt on it), and it is exactly what a notebook should enable.

So the honest statement is narrower than "same-task replay is the wrong question." Same-task replay
**with a corrective signal** is a legitimate and important learning mode (§3.2, Mode A); v1 ran its
**broken, feedback-less** version on a trivially short task, where it could only entrench. The fix is
two-fold: longer tasks that contain expensive reusable knowledge, **and** an outcome signal the write
is conditioned on. The companion product thesis — capitalization across *different* tasks (Mode B) —
was not tested at all.

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

## 3. v2 — an evaluation that measures whether memory pays off

### 3.1 The decisive variable: a corrective feedback signal

The one variable v1 should have isolated and did not: **is there an outcome signal in the write
loop?** Every v2 run must close that loop — the agent runs the tests (or receives the reviewer
verdict / human correction), and the lesson it records is *conditioned on that result*. "FEEDBACK vs
NO-FEEDBACK" is itself a worthwhile contrast (it predicts whether memory improves or entrenches), but
the realistic world is the FEEDBACK one, so that is the default; NO-FEEDBACK is the control that
reproduces v1's entrenchment.

With the loop closed, two learning modes are both worth measuring. They compose: Mode A produces the
lessons; Mode B is where they pay off again.

### 3.2 Mode A — iterative improvement on a *repeated complex task*

This is the scenario the user named: give the agent the **same hard task** (10–100+ tool calls, an
objective test-based pass/fail) **N times in a row**, with a feedback-conditioned reflect-then-write
between runs.

- **ON arm:** notebook persists across runs; after each run the F2P/P2P result drives the write.
- **OFF arm:** notebook wiped each run (the memory-less baseline).

**Primary signal = the improvement *curve* over run index**, not a single number: if memory works,
the ON arm's success rate rises and its cost/turns fall across runs 1→N, while OFF stays flat. A
monotone ON gain that OFF does not show is direct evidence of learning. (Expect a plateau once the
task is solved — that is fine and expected; it is also why Mode B matters.) A NO-FEEDBACK ON arm is
the entrenchment control: it should *not* improve, reproducing v1.

### 3.3 Mode B — capitalization across *different* tasks (warm vs cold)

- **COLD arm:** the role starts each target task with an **empty** notebook.
- **WARM arm:** the role starts the *same* target task with a notebook **pre-populated by prior,
  *different* tasks in the same repo** — ideally the lessons Mode A just produced (real lessons, not
  the answer to this task).

The WARM − COLD difference on a **held-out** task is the capitalization value. Crucially, the warm
notebook must never contain this task's solution; it contains lessons from *sibling* tasks
(build/test/env/convention knowledge that is reusable but not task-specific).

### 3.4 Tasks: long enough to hold reusable knowledge

Three tiers by cost/fidelity, mapped to the modes in §3.2–3.3. Start at Tier 0. (The sequencing and
rough cost of each tier are in §5.)

**Tier 0 — Mode A improvement curve (cheapest, most direct).**
One complex `knowledge-base-mcp-server` task with an objective test signal (its real `npm test` /
`KB_RUN_E2E=1 npm run test:serial` suite is the feedback), run ~8–10× **ON+feedback vs OFF**, plotted
vs run index per §3.2. Answers "does a repeated complex task get better over runs?" with no SWE-bench
plumbing. This is where the live Kookr notebooks already show the shape of the lessons memory
captures — e.g. `~/.kookr/notebooks/patch-author@jeanibarz-knowledge-base-mcp-server.md`: "worktrees
have no node_modules; `npm ci` to build faiss-node before tests", "`madge --circular` counts
type-only imports as cycle edges". That is the substrate memory is *for*.

**Tier 1 — Mode B transfer (warm vs cold).**
First in-repo: 6–10 **different** `knowledge-base-mcp-server` issues that none of the warm lessons
solve directly but that *benefit* from them; run each COLD and WARM (warm = the Tier-0 lessons, any
this-issue-specific line removed). Then SWE‑bench Lite grouped by repo (django, sympy, sphinx…): per
repo, run instances in sequence, WARM carrying the notebook across *different* instances, COLD wiping
between them. The natural analogue of Kookr's `<role>@<repo>` notebooks.

**Tier 2 — SWE‑bench Verified, curriculum (the headline number).**
Human-validated, solvable tasks that genuinely take tens of steps. Same per-repo warm/cold protocol,
larger N. Only worth it if Tier 0/1 show a signal.

### 3.5 Arms (ablations that answer the questions that matter)

| Arm | Mode | Notebook / loop | Question it answers |
|---|---|---|---|
| **OFF** | A | wiped each run | memory-less baseline — the flat line Mode A must beat |
| **ON + feedback** | A | persists; write conditioned on F2P/P2P | **does a repeated complex task get better over runs?** (primary) |
| **ON − feedback** | A | persists; write *not* conditioned on outcome | entrenchment control — reproduces v1 (should *not* improve) |
| **COLD** | B | empty | baseline |
| **WARM** | B | sibling-task lessons (same repo) | **does capitalization transfer to a new task?** |
| **POISONED** | B | one deliberately wrong high-scored lesson + real ones | **how bad is entrenchment?** (the v1 risk, bounded) |
| **WARM‑CROSS** (optional) | B | lessons from a *different* repo | does irrelevant memory just add noise/context rot? |

### 3.6 Metrics (end-state, not path)

- **Mode A primary — the improvement curve:** success rate and cost/turns **as a function of run
  index** (1→N). ON+feedback should trend up/down; OFF and ON−feedback should stay flat. Report the
  slope and a test that ON+feedback ≠ OFF, not just an endpoint.
- **Mode B primary — resolve rate**, via the **official** SWE‑bench harness on official images, with
  a **pinned** `swebench` version and the matching dataset. No hand-rolled resolve checks. Log
  patch-apply success/failure **separately** so §2.5 can never masquerade as a reasoning result.
- **Secondary — cost:** total USD and tokens, reported **both** cache-aware and cache-excluded
  (so caching can't silently erase the effect); wall-clock; tool-call count; number of
  "exploration" reads avoided (proxy for discovery reuse).
- **Downside (POISONED / ON−feedback):** resolve-rate drop and extra cost vs baseline — the price of
  a bad or unverified lesson.

### 3.7 Controls & rigor

- Fix model + temperature + scaffold + harness version; one variable (the notebook) at a time.
- **Pre-register** the hypothesis, the primary metric, and the decision thresholds *before* running.
- Power: enough runs for a real test — **≥10–20 runs/instance**, or many instances × a few runs;
  report CIs and a paired test (same instance, warm vs cold). Treat n=4 as a smoke test, never a
  result.
- **Blind grading** (grader never sees the arm). Counterbalance instance order to cancel learning
  curves in the suite itself.
- Isolation: each run in its own fresh worktree; warm notebook injected read-only at `SessionStart`
  via the existing hook, scrubbed of any line that leaks the target solution.

### 3.8 Decision thresholds (pre-registered)

Write these down before running, so the result can't be rationalized after:
- **Learns (Mode A):** ON+feedback improves over runs 1→N (positive success slope or ≥ 20 % cost
  drop by run N) and beats OFF at **p < 0.05**; ON−feedback does **not** improve (confirms the
  entrenchment mechanism).
- **Ship-positive (Mode B):** WARM beats COLD by **≥ 10 pts** resolve **or** **≥ 20 %** cost at
  **p < 0.05**, with no worse than flat on the other.
- **Downside-acceptable:** POISONED is no more than **≤ 5 pts** below COLD (vote/eviction contains a
  bad lesson quickly) — otherwise the curation loop needs a floor or a faster demote.
- **Kill/park:** both ON+feedback ≈ OFF and WARM ≈ COLD within noise across Tiers 0–1 → the notebook
  is cheap insurance, not a performance lever; keep it for operability, don't invest further.

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

1. **Tier 0 pilot — Mode A improvement curve** (cheapest, most direct test of the user's hypothesis):
   one complex kb-mcp-server task with an objective test signal, run ~8–10× ON+feedback vs OFF, plot
   success/cost vs run index (~tens of $). *Do this first* — it answers "does it learn over repeats?"
   without any SWE‑bench plumbing.
2. If signal → **Tier 1** — Mode B warm-vs-cold across 6–10 *different* kb-mcp-server issues (reuse
   the Mode A lessons as the warm notebook), then SWE‑bench Lite grouped by repo, +POISONED.
3. If still positive → **Tier 2** (SWE‑bench Verified curriculum) for a citable headline.

Respecting the RFC's KISS ethos: stop at the first tier that answers the question. A null at Tier 0
is itself a valid, cheap finding — "the notebook is operability insurance, not a solve-rate lever" —
and far more honest than v1's retracted headline.

---

## 6. What to tell coworkers now

> The first run proved the notebook *works mechanically* and flagged its real risk (an unverified
> lesson sticks). It did **not** measure whether memory makes agents better: it repeated one tiny
> task with **no corrective feedback**, so it could only copy run 1. Real work always has feedback
> (tests, reviews, corrections), and a *complex* task repeated with feedback should get better over
> runs — that is the first thing v2 measures (the improvement curve), before testing whether lessons
> also transfer to different tasks. The honest status is "built and plumbed, value not yet measured."

---

## Appendix A — Pilot results (2026-10-23)

First controlled runs of the v2 protocol. **Caveat up front:** synthetic tasks, small N, a single
task family, and tool-call counts self-reported by the agent harness. These **validate the harness
and demonstrate the curves; they are not generalizable effect sizes.** They do, however, already
sharpen the thesis.

**Setup.** A multi-file `minilang` repo (evaluator) with a genuinely multi-step process: a required
`make gen` codegen step, an env-gated runner (`make test` sets `MINILANG_READY=1`; bare `pytest`
aborts), and a bug to locate across files. Agent under test = Sonnet, via subagents; notebook =
the real `nb` CLI with an isolated `NB_DIR`; feedback signal = the repo's own test suite; a lesson
is written only after a verified green. Metric = tool calls per run (tokens reported separately).

### A.1 Tier 0 — Mode A (same task repeated, feedback each run)

Bug: operator-precedence fold in `parser.py`. 6 runs/arm.

| Run | ON (notebook persists) | OFF (wiped each run) |
|---|---|---|
| r1 | **8** (cold: discovers process + bug, writes lesson) | 6 |
| r2 | **3** | 6 |
| r3 | 3 | 5 |
| r4 | 3 | 6 |
| r5 | 3 | 7 |
| r6 | 3 | 5 |
| **mean** | r1=8, then **3.0** | **5.83** (flat, no trend) |

All runs in both tiers reached a verified green (every arm `pass=1`); no hidden failures. OFF run indices
carry no meaning (the notebook is wiped each run), so only the OFF distribution and mean are interpreted.

- ON drops **8 → 3 tool calls after the first run and plateaus** — a clean learning curve. OFF never
  improves (re-discovers everything every run). Warm ON = **~49% fewer tool calls** than OFF.
- **The first run paid a learning tax:** ON-r1 (8) > OFF mean (5.83). Discovering the gotchas *and*
  writing the lesson costs extra up front; the payoff starts at run 2. Memory is an investment, not
  a free lunch.
- **Tokens barely moved** (ON-warm ~39.1k vs OFF ~41.3k, ~5%): prompt-caching + fixed overhead
  dominate — v1's "cost masked by caching" finding, reproduced. At this scale the signal is in
  tool-calls / wall-clock, not token totals.
- Mechanism worked end to end: feedback-conditioned writes, persistence, and **dedup** (runs 3–6
  added nothing; the notebook self-limited to two lines).

### A.2 Tier 1 — Mode B (different task, process-only warm notebook)

Held-out task: a **different** bug (multi-digit tokenization in `lexer.py`; parser now correct),
same repo/process. WARM notebook carried **only** the reusable process lesson (`make gen` → `make
test`), scrubbed of any fix. 4 runs/arm.

| Arm | tool calls | mean |
|---|---|---|
| COLD (empty notebook) | 5, 5, 6, 5 | 5.25 |
| WARM (process lesson only) | 5, 5, 5, 5 | 5.00 |

**Transfer ≈ null here (0.25 calls, ~5%)** — and the reason is the important finding, not a
disappointment:

- The only legitimately transferable knowledge (the build/test ritual) was **cheap to rediscover**
  (~1 call), so there was almost nothing to amortize. The dominant cost — finding and fixing the
  *new* bug — is identical for both arms by construction (neither notebook contained it).
- This is the boundary condition stated three ways across this doc and v1's report, now observed:
  **transfer value ≈ (cost to rediscover the transferable knowledge) × (how often it's reused).**
  Make the transferable part cheap and transfer pays ~nothing, however long the task.
- It also means the synthetic task, though long (~8 cold calls), was the **wrong shape for Mode B**:
  its process was a single `make gen`. Real repos are where the process is genuinely expensive —
  faiss native builds, `npm ci` vs `--ignore-scripts`, multi-minute suites, non-obvious multi-step
  env (exactly the lessons already in `~/.kookr/notebooks/*@jeanibarz-knowledge-base-mcp-server.md`).
  **That** is where Mode B must be measured; a toy cannot show it.

### A.3 What the pilot establishes

1. **Mode A is real:** with a feedback signal and a task carrying expensive, directly-reusable
   knowledge, a repeated task gets markedly cheaper and stays there; the memory-less arm does not.
   This confirms the refinement in §2.1/§3.1 (the feedback signal is the crux) against live runs.
2. **Mode B needs an expensive transferable core:** process-only transfer on a cheap process is
   ~null. The decisive Mode B test must use a repo where setup/navigation is genuinely expensive —
   i.e. the real-repo Tier 1, not a synthetic one.
3. **The harness works** (inject → run → verify → feedback-conditioned write → reuse → dedup), and
   token totals are the wrong headline metric at this scale (use tool-calls / wall-clock).

**Next:** run Tier 1 on a real repo with an expensive process (`knowledge-base-mcp-server`), where
the warm notebook carries costly setup/navigation lessons and the transfer delta can actually be
large. Pre-register the thresholds in §3.8 first.

---

## Appendix B — Complex-task and real-repo results (2026-10-23)

Extends Appendix A with a bigger synthetic task and the first **real-repo** Mode B run. Same harness,
same caveats (synthetic E1–E4; Sonnet subagents; small N; tool-calls harness-reported). Raw per-run
data lives in `nb-eval-results/runs.tsv` (41 runs); this section reports means.

### B.1 Bigger synthetic task — `formula` (2-step setup + 2 bugs)

Multi-step process (`make setup` runs two codegen/vendor tools, then env-gated `make test`) and two
bugs in different modules (lexer multi-digit + parser precedence). Cold ≈ 6–8 tool calls.

- **Mode A (same task, feedback):** ON **7 → 4** and plateaus; cold baseline (empty every run, n=4)
  **6.5**. Warm ON ~38% fewer calls than the cold baseline. Confirms Appendix A's Mode A finding on
  a larger, multi-bug task.
- **Mode B (transfer, process-only warm notebook, n=4):** COLD **6.5** vs WARM **6.0** — **~null
  again.** Making the task *bigger* did not move transfer, because its process is still cheap to
  rediscover (one read of `HACKING.md`). The lever for transfer is the *expense* of the reusable
  knowledge, not task size.

### B.2 Real repo — `knowledge-base-mcp-server` Mode B (expensive setup)

The decisive test: a repo whose setup is genuinely expensive and non-obvious. A fresh git worktree
has **no `node_modules`**, so the agent must run `npm ci` (~65s–3min, builds faiss/hnswlib native
modules) before any test runs — exactly the knowledge captured in the repo's real notebooks. Task =
a controlled injected bug (`src/model-id.ts` `__`→`_` separator) caught by `src/active-model.test.ts`;
identical across arms. WARM = the real `patch-author@…kb…` notebook (which contains the `npm ci`
lesson but **not** this fix); COLD = empty. 3 runs/arm.

| Arm | tool calls | mean |
|---|---|---|
| COLD (empty notebook) | 8, 10, 12 | **10.0** |
| WARM (real repo notebook) | 5, 6, 10 | **7.0** |

**WARM used ~30% fewer tool calls than COLD** — the first positive Mode B signal. COLD agents
flailed on setup (one ran `npx jest` first → `Preset ts-jest not found`, another used
`npm ci --ignore-scripts`); WARM read the notebook and ran `npm ci` directly. (Wall-clock was not
used for inference: 6 parallel `npm ci` builds contended and agents backgrounded the install.)

### B.3 Consolidated conclusion

Across five experiments the picture is consistent and sharpens v1's retracted headline:

1. **Mode A (repeat + feedback) works at every size** — ON falls to a warm plateau (8→3 on E2, 7→4
   on E4) while the memory-less arm stays flat; the first run pays a learning tax. (The trivial E1
   smoke, n=2/arm, was non-differential — ON and OFF were both 5→3 — so it validates plumbing, not
   effect.)
2. **Mode B (cross-task transfer) pays in proportion to how expensive the shared knowledge is to
   rediscover.** Cheap synthetic setup → ~null (E3, E4). Expensive real-repo setup (`npm ci` +
   native build) → **−30%** (E5).
3. Memory's value ≈ *(cost of the knowledge it lets you skip) × (how often it's reused)*. That is
   why v1 — ≤5-turn tasks, no feedback, nothing expensive or reused — measured nothing, and why the
   real repo finally shows a signal.

**Next (pre-register §3.8 thresholds first):** scale E5 to more runs and more kb-mcp issues, add the
POISONED arm on the real repo, and report cost in wall-clock/tokens on a machine without `npm ci`
contention.
