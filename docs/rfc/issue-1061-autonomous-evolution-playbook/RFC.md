# RFC: Autonomous Evolution Playbook with Budget and Stop Criteria

## Status

**Draft (v1)**

**Date:** 2026-06-20
**Author:** Jean Ibarz (with Claude)
**Issue:** [#1061](https://github.com/kookr-ai/kookr/issues/1061)
**Implementation branch:** `feat-issue-1061-autonomous-evolution-playbook`

---

## Problem

Autonomous *evolution* chains — long runs that repeatedly mutate an artifact,
score it, keep the best, and try again — are now a recurring Kookr usage
pattern. The 2026-06-20 task store held **45** `autotrader-evol` tasks, mostly
completed within a few hours, with hand-rolled names like `Evolve trading
agent...`, `evolve after iter...`, and `chain heartbeat`. The work was real and
useful, but the *orchestration* was ad hoc: an operator re-prompted by hand,
budgets lived in someone's head, "is it actually improving?" was eyeballed from
task names, and there was no durable record of which trial won or why the run
stopped.

This is the same shape as the [Ralph loop](../../../.kookr/playbooks/ralph-loop.md)
(one runtime, one unit of work, durable external state, stop on an observable
condition), but with an extra contract the Ralph loop does not encode:

- A **champion** artifact that persists across iterations and only changes when
  a challenger beats it on a project-defined metric.
- **Budgets** that bound a *search*, not just a task list — wall-clock, trial
  count, and cost matter as much as iteration count.
- **Stop criteria** beyond "no work left": target metric reached, improvement
  plateaued, or the budget is spent.
- **Summary artifacts** an operator can read after the fact: what was the best
  result, how did the metric move, why did the run stop.

Kookr already ships the loop substrate. The Ralph engine
(`src/server/ralph-loop-service.ts`, `src/core/ralph-cycler.ts`) provides a
fresh runtime per Stop event, an `iterationCap` hard ceiling, a best-effort
`costCapUsd`, per-iteration cost caps, a per-iteration **verdict file**
(`$RALPH_VERDICT_FILE`), and a JSONL **audit trail**
(`<task-cwd>/ralph-iterations.jsonl`). What is missing is a *playbook* that
turns that generic loop into a safe, legible evolution run — and a small,
project-agnostic contract for plugging in "how do I score a trial?" without
baking `autotrader-evol` into Kookr core.

This RFC defines that playbook contract. It does **not** implement the full
playbook, and it does **not** touch the autotrader project or evaluate any
trading strategy (both explicitly out of scope on the issue).

## Goals

- Define a first-class **autonomous evolution playbook contract**: required
  inputs, default budgets, stop criteria, and the artifacts each iteration and
  each run must emit.
- Reuse the existing Ralph loop engine as the execution substrate. Add a
  playbook and a thin project-evaluation convention, not a second loop engine.
- Make project-specific metrics pluggable through a declared **evaluation
  contract**, so `autotrader-evol` is one *instance* of the pattern, not a
  special case in Kookr.
- Identify the minimal first implementation slice that delivers a usable run
  without new engine code.

## Non-goals

- Implementing the full playbook in this issue. This RFC is the design note;
  acceptance is the contract, not running code.
- Evaluating trading performance or changing the autotrader project.
- A new loop engine, scheduler, or cron surface. Evolution runs on the existing
  Ralph mode.
- Distributed / parallel trial evaluation. V1 is one trial per iteration,
  sequential, matching Ralph's one-runtime-one-unit discipline.
- A hosted leaderboard, cross-run comparison UI, or hyperparameter-search
  framework. Those are future work, noted at the end.

## Requirements

Inputs and configuration:

- The playbook SHALL accept a **project evolution directory** (default
  `.kookr/evolution/` in the target repo) that declares the evaluation
  contract and optional propose/apply hooks.
- The playbook SHALL require a project-supplied **evaluate** command that emits
  a versioned JSON **trial result** to a known path.
- The playbook SHALL treat the artifact under evolution as **opaque**: Kookr
  core never parses strategy code, model weights, or domain data. It only reads
  the trial-result JSON.
- The playbook MAY accept project-supplied **propose** and **apply** commands.
  When absent, the agent itself proposes the next mutation and applies it.

Budgets (see [Budget dimensions](#budget-dimensions)):

- The playbook SHALL enforce a hard **iteration cap** via the Ralph engine's
  `iterationCap`. This is the always-present backstop.
- The playbook SHALL support a **wall-clock deadline**, a **trial count**
  budget, and a **cumulative cost** budget (USD).
- Cost-based stops SHALL be fail-closed: an unknown cost (`null`) MUST NOT, on
  its own, stop the run — the iteration cap remains the hard ceiling. This
  matches existing Ralph cost-cap semantics.

Stop criteria (see [Stop criteria](#stop-criteria)):

- The playbook SHALL stop when **any** mandatory stop condition fires and report
  a single, unambiguous **stop reason**.
- The playbook SHALL support a project-configurable **target metric threshold**
  ("good enough → stop") and a **plateau / patience** window ("no meaningful
  improvement for N trials → stop").
- The playbook SHALL never silently keep running after a budget is exhausted.

Artifacts (see [Summary artifacts](#summary-artifacts)):

- Each iteration SHALL append one **trial record** to a durable, append-only
  trial log.
- The run SHALL maintain a single **champion record** that is updated only when
  a challenger wins.
- The run SHALL emit (and keep current) a human-readable **run summary** so an
  operator can see best-so-far, metric trajectory, budget consumption, and the
  eventual stop reason without replaying the log.

Safety and legibility:

- Every iteration SHALL write a Ralph **verdict** (`progress` / `stalled` /
  `complete`) so the engine's stall/burn machinery and clean-termination path
  work unchanged.
- The playbook SHALL be idempotent across crash/restart: champion and trial log
  are the durable state; a fresh runtime reconstructs position from them, not
  from conversation memory.
- The playbook SHALL distinguish a **regressed trial** (evaluated, worse than
  champion) from a **failed trial** (could not be evaluated). They feed
  different stop logic.

## Design

### Layering: a playbook on top of Ralph, not a new engine

The evolution playbook is a **specialization** of the Ralph loop. It adds a
champion/challenger discipline and a project-evaluation contract on top of the
generic per-iteration loop. Concretely:

| Concern | Provided by | Notes |
|---|---|---|
| Fresh runtime per iteration | Ralph engine | `ralph-cycler` re-fires on each Stop |
| Hard iteration ceiling | Ralph `iterationCap` | always present |
| Best-effort cost ceiling | Ralph `costCapUsd` + `stallConfig.iterationCostCapUsd` | fail-closed on `null` |
| Per-iteration verdict | Ralph `$RALPH_VERDICT_FILE` | `progress`/`stalled`/`complete` |
| Iteration audit | Ralph `ralph-iterations.jsonl` | engine-owned, one line/iteration |
| Champion / trial log / metric stop | **this playbook** | new, file-based, in task cwd |
| Project metric scoring | **project evaluation contract** | new, repo-supplied command |

The deliberate consequence: the **minimal first slice ships zero engine code**.
It is a playbook markdown file plus a documented project-evaluation convention.
Everything that needs to be durable already has a home (Ralph's audit + the new
champion/trial files in the task cwd).

### The evolution contract (one iteration)

Each Ralph iteration performs exactly one evolution step:

1. **Read durable state.** Load `champion.json` (the best artifact + its score)
   and `evolution-trials.jsonl` (all prior trials) from the task cwd. If none
   exist, this is iteration 0 — establish a baseline (see below).
2. **Check budgets and stop criteria first.** If any mandatory stop condition is
   already satisfied, write the run summary, emit `verdict: complete` with the
   stop reason, and stop. (Budgets are checked at the *start* so a fresh runtime
   never wastes a trial it cannot afford.)
3. **Propose a challenger.** Run the project's `propose` command if declared;
   otherwise the agent proposes a mutation guided by the champion and recent
   trial history. The proposal mutates the opaque artifact in an isolated trial
   workspace, never the champion in place.
4. **Evaluate.** Run the project's `evaluate` command. It MUST write a trial
   result JSON (schema below) to the agreed path and exit non-zero only on
   *evaluation failure* (the trial could not be scored), not on a poor score.
5. **Compare and (maybe) promote.** Read the trial result. If it is valid and
   beats the champion per the result's `higherIsBetter` flag and the configured
   minimum-improvement delta, promote: atomically replace `champion.json` and
   archive the winning artifact. Otherwise leave the champion untouched.
6. **Record.** Append a trial record to `evolution-trials.jsonl`, refresh
   `evolution-summary.md`, and write the Ralph verdict (`progress` when a trial
   was evaluated — win or lose; `stalled` when the trial could not be evaluated;
   `complete` when a stop condition fired).
7. **Stop.** Ralph re-fires the next iteration unless a stop condition was met.

Baseline (iteration 0): evaluate the project's starting artifact once and record
it as the initial champion. A run with no valid baseline cannot decide
improvement, so a failed baseline is a hard `stalled` + eventual burn, not an
infinite retry.

### Trial result schema (the project boundary)

This JSON is the **only** interface between Kookr and the project. Kookr writes
nothing domain-specific; the project writes nothing Kookr-specific. Versioned so
the contract can evolve:

```jsonc
{
  "schemaVersion": "kookr-evolution-trial.v1",
  "ok": true,                       // false ⇒ evaluation failed (failed trial, not a regression)
  "score": 1.834,                   // primary scalar the run optimizes
  "higherIsBetter": true,           // direction; the project owns this
  "metrics": {                      // optional secondary metrics, for the summary only
    "sharpe": 1.834,
    "maxDrawdown": 0.12,
    "trades": 412
  },
  "artifactRef": "trials/iter-7/strategy.json", // opaque pointer Kookr archives on promotion
  "notes": "widened the entry band; fewer whipsaws",
  "evaluatedAt": "2026-06-20T19:30:00Z"
}
```

Rules:

- `ok: false` (or a non-zero exit, or a missing/malformed file) ⇒ **failed
  trial**. No promotion. Counts toward the *failure* budget, not the plateau
  window.
- `ok: true` with `score` worse-or-equal to champion ⇒ **regressed/neutral
  trial**. No promotion. Counts toward the *plateau* window.
- `ok: true` with `score` better than champion by at least
  `minImprovementDelta` ⇒ **promotion**. Resets the plateau window.

`metrics`, `notes`, and `artifactRef` are passed through verbatim into the trial
log and summary. Kookr never interprets them beyond display.

### Budget dimensions

A budget bounds the *search*. The playbook supports five dimensions; an
operator sets any subset. The first to trip stops the run.

| Dimension | Source | Default | Mandatory? |
|---|---|---|---|
| **Iteration cap** | Ralph `iterationCap` | `20` | **Yes** (hard ceiling) |
| **Cumulative cost (USD)** | Ralph `costCapUsd` | `25` | Best-effort (fail-closed) |
| **Per-iteration cost (USD)** | Ralph `stallConfig.iterationCostCapUsd` | unset | Best-effort |
| **Wall-clock deadline** | playbook (`evolution.deadlineAt`) | unset | Optional |
| **Trial count** | playbook (`evolution.maxTrials`) | = iteration cap | Optional |

The iteration cap is the only dimension that is *always* enforced and is the
true safety backstop, exactly as in the base Ralph playbook. Cost dimensions
inherit Ralph's fail-closed rule: an unknown cost never stops the run by itself.
Wall-clock and trial-count budgets are checked by the playbook at step 2 of each
iteration against durable state (deadline timestamp; trial-log length).

### Stop criteria

Two tiers, matching the issue's "mandatory vs project-configurable" question:

**Mandatory (always active, cannot be disabled):**

- `iteration_cap` — Ralph hard ceiling reached.
- `budget_exhausted` — any configured budget dimension tripped (cost, wall-clock,
  trial count).
- `failure_budget_exhausted` — too many consecutive **failed trials**
  (evaluation could not run/score). Default: `maxConsecutiveFailedTrials = 3`.
  This protects against burning the whole budget on a broken evaluate command,
  and dovetails with the Ralph engine's own burned-target machinery.

**Project-configurable (opt-in, off by default):**

- `target_reached` — champion `score` crossed a project-supplied threshold
  (`evolution.targetScore`, honoring `higherIsBetter`). "Good enough, stop."
- `plateau` — no promotion for `evolution.patience` consecutive *evaluated*
  trials (default off; typical value 5). Distinct from failures.
- `manual` — operator pause/cancel via the existing Ralph controls.

Every stop writes exactly one `stopReason` into the run summary and the final
Ralph verdict, so the audit answers "why did this run end?" unambiguously.

### Handling failed iterations, missing metrics, no improvement

This is design question 4 from the issue, made explicit:

- **Failed trial** (evaluate errored / missing / `ok:false` / malformed JSON):
  record it with `outcome: "failed"` and the captured error, do **not** promote,
  increment the consecutive-failure counter, and write Ralph `verdict: stalled`
  with a blocker like `["evaluation_failed"]`. `maxConsecutiveFailedTrials`
  consecutive failures stop the run with `failure_budget_exhausted`; the Ralph
  engine's per-target stall→burn path is the secondary guard.
- **Missing metric** (`score` absent but `ok:true`): treat as a *failed* trial —
  an un-scored trial cannot be compared. Surface prominently in the summary; a
  project that legitimately has no score for a trial should set `ok:false` with
  a `notes` explanation.
- **No champion improvement** (valid trial, score ≤ champion): record
  `outcome: "regressed"` or `"neutral"`, keep the champion, increment the
  plateau counter. If `patience` is configured and exceeded, stop with
  `plateau`; otherwise keep searching until a budget trips.
- **Promotion**: record `outcome: "promoted"`, reset the plateau counter,
  atomically swap the champion (write temp + rename, mirroring the verdict-file
  write discipline) and archive the prior champion under `champions/`.

### Project-specific metrics without hardcoding

This is design question 5, and the load-bearing decision. Kookr core must stay
domain-agnostic — no `autotrader-evol` strings in the engine. Two existing
Kookr patterns combine to achieve this:

1. **Declared evaluation contract** (like the Ralph verdict file): the project
   owns a directory (`.kookr/evolution/`) with a small manifest:

   ```jsonc
   // .kookr/evolution/config.json
   {
     "schemaVersion": "kookr-evolution-config.v1",
     "evaluate": "./evaluate.sh",       // required; writes the trial-result JSON
     "propose":  "./propose.sh",        // optional; emits the next challenger
     "apply":    "./apply.sh",          // optional; installs a promoted champion
     "artifact": "strategy.json",        // opaque path the project mutates
     "higherIsBetter": true,
     "targetScore": 2.0,                 // optional project stop threshold
     "patience": 5,                      // optional plateau window
     "minImprovementDelta": 0.01
   }
   ```

   Kookr reads only this manifest and the trial-result JSON. It executes the
   declared commands with the artifact path and trial workspace in the
   environment, and consumes their JSON output. The domain logic — backtesting a
   trading strategy, scoring a prompt, benchmarking a kernel — lives entirely in
   the project's scripts.

2. **Capability gating** for the launch form, reusing the mechanism in
   [`rfc-capability-gated-playbook-params.md`](../rfc-capability-gated-playbook-params.md):
   the evolution playbook's project-specific parameters are gated by the
   presence of a valid `.kookr/evolution/config.json`. A repo without the
   manifest simply cannot launch an evolution run (or the run self-degrades to
   "agent proposes + agent judges", explicitly weaker).

`autotrader-evol` then becomes **one instance**: an `.kookr/evolution/` dir in
the autotrader repo whose `evaluate.sh` runs the backtest and prints the Sharpe
ratio as `score`. Kookr learns nothing about trading; the autotrader repo learns
nothing about Ralph internals. (Worked example below.)

### Summary artifacts

Three durable files in the task cwd, alongside Ralph's `ralph-iterations.jsonl`:

- **`champion.json`** — the current best: `{score, metrics, artifactRef,
  iteration, promotedAt, runId}`. Updated only on promotion, atomically.
- **`evolution-trials.jsonl`** — append-only, one line per trial:
  `{iteration, outcome, score, delta, metrics, notes, durationMs, costUsd?,
  evaluatedAt}` where `outcome ∈ {baseline, promoted, neutral, regressed,
  failed}`. This is the optimization curve, machine-readable.
- **`evolution-summary.md`** — refreshed every iteration: best-so-far, the score
  trajectory (sparkline / table), budget consumption per dimension, count of
  each outcome, and — once stopped — the single `stopReason`. This is the
  operator-facing artifact called for in design question 3.

These three plus Ralph's iteration audit are sufficient to reconstruct the
entire run and to resume after a crash.

## Minimal first implementation slice

Design question / acceptance criterion: *identify the minimal first
implementation slice.* The smallest thing that delivers a real, safe run:

**Slice 1 — playbook + convention only, no engine changes:**

1. `.kookr/playbooks/autonomous-evolution.md` — a loopable Ralph playbook that
   encodes the per-iteration contract above (read state → check budgets/stops →
   propose → evaluate → compare/promote → record → verdict). Mirrors the
   existing `ralph-loop.md` and `implement-github-issue.md` structure.
2. Documented **trial-result** (`kookr-evolution-trial.v1`) and
   **evolution-config** (`kookr-evolution-config.v1`) JSON schemas in
   `docs/schemas/`.
3. The playbook drives budgets via the Ralph loop's existing `iterationCap` /
   `costCapUsd` frontmatter, and the playbook-level wall-clock / trial-count /
   plateau / target stops via file checks. Champion + trial log + summary are
   plain files written by the agent.

Slice 1 ships entirely as docs + a playbook; it is exercisable today against any
repo that adds `.kookr/evolution/config.json`. No `src/` changes.

**Slice 2 — first-class surfacing (separate issue):** a typed launch-form
parameter set gated on `.kookr/evolution/config.json`, a dashboard "champion +
trajectory" panel reading `champion.json` / `evolution-trials.jsonl`, and
validation of the manifest at launch.

**Slice 3 — convenience (separate issue):** helpers for atomic champion swap and
trial-log append so projects don't reimplement them; optional cross-run
comparison.

This RFC commits only to defining the contract (the acceptance criteria). Slices
1–3 are follow-up issues.

## Worked example: `autotrader-evol`

Included as evidence per the issue, without making the design repo-specific. In
the autotrader repo:

```
.kookr/evolution/
  config.json        # evaluate=./evaluate.sh, artifact=strategy.json,
                     # higherIsBetter=true, targetScore=2.0, patience=8
  evaluate.sh        # runs the backtest, prints kookr-evolution-trial.v1 JSON
                     # with score = out-of-sample Sharpe
  propose.sh         # (optional) perturbs strategy.json params
```

A run launched with `iterationCap: 40`, `costCapUsd: 30`, `patience: 8`,
`targetScore: 2.0` would: establish the baseline Sharpe, then each iteration
perturb the strategy, backtest, promote on a ≥0.01 Sharpe gain, and stop at the
first of — Sharpe ≥ 2.0 (`target_reached`), 8 evaluated trials with no gain
(`plateau`), 40 iterations (`iteration_cap`), or \$30 spent (`budget_exhausted`).
The operator reads `evolution-summary.md` for the winning strategy and the curve.
Kookr core contains zero trading logic; it only ran declared commands and
compared scalar scores.

## Alternatives considered

- **A bespoke evolution engine in `src/`.** Rejected for V1: it duplicates the
  Ralph engine's fresh-runtime / cap / verdict / audit machinery, which already
  solves the hard parts (crash recovery, cost caps, stall handling). Build the
  thin layer first; promote to engine code only if the playbook proves the
  contract and the file-based approach hits real limits.
- **Hardcoding metric extraction in Kookr** (e.g. a `--metric sharpe` flag).
  Rejected: couples core to one domain and one metric name. The trial-result
  JSON with a single opaque `score` keeps Kookr domain-free.
- **Letting the agent self-judge every trial with no project command.**
  Retained only as the *degraded* fallback when no `.kookr/evolution/config.json`
  exists. Self-judged scores are not reproducible and invite reward-hacking, so
  a declared `evaluate` command is the supported path.
- **Parallel trials per iteration.** Deferred: conflicts with Ralph's
  one-runtime-one-unit model and complicates champion arbitration. Sequential
  first.

## Open questions

- Should the champion archive be pruned (keep last N) or retained fully for
  provenance? Leaning: keep full in V1, revisit if disk pressure appears.
- Should `minImprovementDelta` be absolute, relative, or project-selectable?
  Leaning: project-selectable in `config.json`, default small absolute.
- How should a plateau interact with cost — e.g. raise the proposal "temperature"
  before giving up? Out of scope for the contract; a project `propose.sh`
  concern.
- Do we need a `seed` / determinism field in the trial result for reproducible
  evaluation? Likely yes for serious use; deferred to Slice 2 schema revision.

## Acceptance criteria (issue #1061)

- [x] Add an RFC/design note for an autonomous evolution playbook contract.
      — *this document.*
- [x] Define required inputs, default budgets, stop criteria, and expected
      output artifacts. — *Requirements, Budget dimensions, Stop criteria,
      Summary artifacts.*
- [x] Identify the minimal first implementation slice. — *Minimal first
      implementation slice (Slice 1: playbook + schemas, no engine code).*
- [x] Include `autotrader-evol` as evidence/example without making the design
      repo-specific. — *Problem (evidence) and Worked example (kept behind the
      project evaluation contract).*
