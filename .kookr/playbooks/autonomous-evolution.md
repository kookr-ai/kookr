---
name: Autonomous Evolution
description: Iteratively mutate, evaluate, and keep the best version of a project artifact under explicit budgets and stop criteria
tags: [workflow, loopable]
parameters:
  - name: projectCwd
    description: "Directory of the project to evolve (must contain .kookr/evolution/config.json). Leave empty to use the task cwd."
    required: false
    default: ""
    type: textarea
  - name: targetScore
    description: "Stop when the champion score crosses this threshold (overrides config.targetScore). Leave empty to use config or disable."
    required: false
    default: ""
    type: text
    gatedBy: evolution-config
  - name: patience
    description: "Stop after this many consecutive evaluated trials with no promotion (overrides config.patience). Leave empty to use config or disable."
    required: false
    default: ""
    type: text
    gatedBy: evolution-config
  - name: deadlineMinutes
    description: "Wall-clock budget in minutes from the first iteration. Leave empty for no wall-clock budget."
    required: false
    default: ""
    type: text
    gatedBy: evolution-config
loop:
  iterationCap: 20
  costCapUsd: 25
  stopPredicate: 'test -f .evolution-stop && grep -qE "^STOP:" .evolution-stop'
checklist:
  - Pinned the run cwd and cleaned any stale .evolution-stop
  - Loaded and validated .kookr/evolution/config.json against kookr-evolution-config.v1
  - Checked every budget and stop criterion before spending a trial
  - Established a valid baseline champion before proposing challengers
  - Proposed exactly one challenger this iteration (project propose or agent)
  - Ran the project evaluate command and read a kookr-evolution-trial.v1 result
  - Distinguished a regressed trial from a failed (unscored) trial
  - Promoted atomically only on a real improvement past minImprovementDelta
  - Appended one trial record and refreshed champion.json + evolution-summary.md
  - Wrote a Ralph verdict (progress / stalled / complete) every iteration
  - Wrote STOP: <reason> to .evolution-stop when a stop criterion fired
---

## Objective

Run an autonomous *evolution* loop: each iteration proposes one mutation of a
project artifact, scores it with a project-supplied evaluation command, and
keeps it as the new **champion** only if it beats the current champion. The run
stops on an explicit, reported stop reason — never silently.

This is the first implementation slice of the contract in
[`docs/rfc/issue-1061-autonomous-evolution-playbook/RFC.md`](../../docs/rfc/issue-1061-autonomous-evolution-playbook/RFC.md).
It is a Ralph-loop specialization: the [Ralph engine](./ralph-loop.md) supplies
the fresh runtime per iteration, the hard `iterationCap`, the best-effort
`costCapUsd`, the per-iteration verdict file, and the iteration audit trail.
This playbook adds the champion/challenger discipline, the budget/stop logic,
and the durable evolution artifacts.

Kookr core stays domain-agnostic. The only interface to the project is the
declared **evaluation contract** (`.kookr/evolution/config.json`) and the
**trial-result JSON** the project's `evaluate` command emits. The artifact under
evolution is opaque — this playbook never parses strategy code, weights, or
domain data, only the scalar `score` in the trial result.

## Loop Safety

- **Durable progress location:** `champion.json`, `evolution-trials.jsonl`, and
  `evolution-summary.md` in the run cwd, plus the Ralph audit trail at
  `<task-cwd>/ralph-iterations.jsonl`. A fresh runtime reconstructs position from
  these files, never from conversation memory.
- **Idempotency:** every iteration appends exactly one trial record. Reading the
  trial log length is how the run knows how many trials have happened.
- **Terminal state:** any mandatory or configured stop criterion writes
  `STOP: <reason>` to `.evolution-stop`; the `stopPredicate` ends the loop on the
  next Stop hook. The Ralph `iterationCap` is the always-present hard ceiling.
- **Known side effects:** writes evolution artifacts in the run cwd; runs the
  project's declared `evaluate` / `propose` / `apply` commands; may commit a
  promoted champion if the project `apply` command does so.

## State files (run cwd)

| File | Shape | Written when |
|---|---|---|
| `champion.json` | `{score, metrics, artifactRef, iteration, promotedAt, runId}` | baseline + each promotion (atomic) |
| `evolution-trials.jsonl` | one trial record per line | every iteration |
| `evolution-summary.md` | human-readable run summary | every iteration |
| `champions/` | archived winning artifacts | each promotion |
| `.evolution-stop` | `STOP: <reason>` | when a stop criterion fires |

Trial record line (`evolution-trials.jsonl`):

```jsonc
{"iteration":7,"outcome":"promoted","score":1.83,"delta":0.06,"metrics":{...},
 "notes":"...","durationMs":40213,"costUsd":0.42,"evaluatedAt":"2026-06-20T19:30:00Z"}
```

`costUsd` is optional (omit when the per-iteration cost is unknown).

`outcome` is one of `baseline`, `promoted`, `neutral`, `regressed`, `failed`.

## Phase 0: Pin cwd and clean stale stop file

The Ralph predicate runs in the task's cwd, so all state files MUST live there.

```bash
RUN_CWD="$(pwd)"
rm -f "$RUN_CWD/.evolution-stop"
```

`rm -f` is unconditional: a stale `.evolution-stop` is leftover from a prior or
aborted run — a satisfied predicate would have stopped the loop before this
iteration started.

## Phase 1: Load and validate the evolution config

Resolve the project directory: use `{{projectCwd}}` if set, else `$RUN_CWD`.
Store as `PROJECT_DIR`. Read `$PROJECT_DIR/.kookr/evolution/config.json`.

Launch parameters reach the playbook as **textual `{{name}}` substitutions** in
this prompt, not as environment variables — substitute the token directly:

```bash
PROJECT_DIR='{{projectCwd}}'            # textual launch-param substitution
[ -n "$PROJECT_DIR" ] || PROJECT_DIR="$RUN_CWD"
CONFIG="$PROJECT_DIR/.kookr/evolution/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "STOP: FAILED — no .kookr/evolution/config.json at $PROJECT_DIR" > "$RUN_CWD/.evolution-stop"
  # Write a permanent stalled verdict (Phase 7), then exit 0. The stopPredicate
  # ends the loop on the next Stop hook; the exit prevents this iteration from
  # falling through to Phase 2 with a CONFIG that does not exist.
  exit 0
fi
```

Validate the manifest against
[`docs/schemas/kookr-evolution-config.v1.json`](../../docs/schemas/kookr-evolution-config.v1.json):
`schemaVersion` must equal `kookr-evolution-config.v1`; `evaluate` and `artifact`
are required. A malformed manifest is a permanent failure — write
`STOP: FAILED — invalid evolution config: <reason>` and a permanent `stalled`
verdict, then stop. Do not fall back to agent self-judging in this slice; an
explicit evaluation command is the supported path.

Resolve effective settings, launch params (substituted as `{{name}}` tokens)
overriding the manifest:

- `higherIsBetter` ← config (default `true`)
- `targetScore` ← `{{targetScore}}` else config (else disabled)
- `patience` ← `{{patience}}` else config (else disabled)
- `minImprovementDelta` ← config (default `0`)
- `maxConsecutiveFailedTrials` ← config (default `3`). Keep this **at or below**
  the Ralph engine's single-target stall-termination threshold
  (`consecutiveStallsForSingleTargetTermination`, default `3`) so the playbook's
  own `failure_budget_exhausted` reason fires before the engine's generic
  `target_stalled` — see Phase 7.
- `maxTrials` ← config (else the Ralph iteration cap)
- `deadlineAt` ← now + `{{deadlineMinutes}}` if set, else config (else disabled).
  Persist the resolved deadline to `champion.json` on the baseline iteration so
  a fresh runtime reads the same absolute deadline.

Also fix a **stable target id** for this run — `EVOLUTION_TARGET`, the
`artifact` basename (e.g. `strategy.json`). Use it as the `target` field in
*every* Ralph verdict so the engine accrues stall/progress counts on one
coherent key across iterations.

## Phase 2: Check budgets and stop criteria FIRST

Check before spending a trial so a fresh runtime never wastes a trial it cannot
afford. Read durable state: `champion.json` (current best) and the line count of
`evolution-trials.jsonl` (trials so far). Evaluate, in order, and on the first
match write `STOP: <reason>` to `.evolution-stop`, refresh the summary, write a
`complete` verdict (Phase 7), and stop:

Mandatory (always active):

- `budget_exhausted` — trial-log line count `>= maxTrials` (the baseline trial
  counts as one line), or the current time `>= deadlineAt`.
- `failure_budget_exhausted` — the last `maxConsecutiveFailedTrials` trial
  records are all `outcome:"failed"`. Checked here so a *resuming* runtime stops
  without spending another doomed trial; the live iteration that first reaches
  the threshold also stops itself in Phase 7.
- (`iteration_cap` is enforced by the Ralph engine itself, not here.)

Configured (opt-in):

- `target_reached` — champion exists and its `score` has reached `targetScore`:
  `score >= targetScore` when `higherIsBetter`, else `score <= targetScore`.
- `plateau` — `patience` is set and the last `patience` *evaluated* trials
  (`outcome` in `neutral`/`regressed`/`promoted`) contain no `promoted`.

If no stop criterion fires, continue.

## Phase 3: Establish the baseline (iteration 0 only)

If `champion.json` does not exist, this is the baseline. Evaluate the project's
current artifact once to anchor "improvement":

1. Prepare a trial workspace `trials/iter-0/` and copy the artifact into it.
2. Run the evaluate command (Phase 4 mechanics) on the unmodified artifact.
3. If the baseline evaluation fails, this run cannot define improvement: write
   `STOP: FAILED — baseline evaluation failed` and a permanent `stalled` verdict,
   then stop. Do not retry forever.
4. On success, write `champion.json` with the baseline score and
   `outcome:"baseline"` trial record, refresh the summary, write a `progress`
   verdict, and stop. The next iteration proposes the first challenger.

## Phase 4: Propose a challenger

Prepare an isolated trial workspace for this iteration
(`trials/iter-$RALPH_ITERATION/`) and copy the **champion** artifact into it —
never mutate the champion in place.

- If the config declares `propose`, run it with the environment contract below.
  It mutates the artifact copy in the trial workspace.
- Otherwise, the agent proposes one focused mutation, guided by `champion.json`
  and the recent tail of `evolution-trials.jsonl` (what was already tried, what
  regressed). Keep the mutation small and reversible.

Environment contract for the project commands (`propose`, `evaluate`, `apply`):

| Variable | Meaning |
|---|---|
| `KOOKR_EVOLUTION_TRIAL_DIR` | absolute path to this iteration's trial workspace |
| `KOOKR_EVOLUTION_ARTIFACT` | absolute path to the artifact copy to mutate/evaluate |
| `KOOKR_EVOLUTION_CHAMPION` | absolute path to the current champion artifact |
| `KOOKR_EVOLUTION_TRIAL_OUT` | absolute path the `evaluate` command MUST write the trial-result JSON to |

## Phase 5: Evaluate

Run the project's `evaluate` command from `$PROJECT_DIR/.kookr/evolution/` with
the environment contract set. It must write a
[`kookr-evolution-trial.v1`](../../docs/schemas/kookr-evolution-trial.v1.json)
JSON to `$KOOKR_EVOLUTION_TRIAL_OUT` and exit non-zero only on *evaluation
failure*, not on a poor score.

Classify the outcome:

- **failed** — evaluate exited non-zero, OR the output file is missing/malformed,
  OR `ok` is `false`, OR `ok` is `true` but `score` is absent. No promotion.
- **evaluated** — `ok:true` with a numeric `score`. Proceed to compare.

## Phase 6: Compare, promote, and record

For an evaluated trial, compute `delta` against the champion in the better
direction (`higherIsBetter` ? `score - champion.score` : `champion.score - score`):

- `delta >= minImprovementDelta` and `delta > 0` → **promotion**:
  - Archive the prior champion artifact under `champions/iter-<prev>/`.
  - Run the config `apply` command if declared (else the agent installs the new
    artifact).
  - Atomically replace `champion.json` (write `champion.json.tmp`, then rename)
    with the new score, metrics, `artifactRef`, iteration, and `promotedAt`.
  - `outcome = "promoted"`.
- else → `outcome = "neutral"` (delta == 0) or `"regressed"` (delta < 0). Keep
  the champion untouched.

For a failed trial, `outcome = "failed"` and capture the error in `notes`.

Always, regardless of outcome:

1. Append one trial record line to `evolution-trials.jsonl` (atomic append).
2. Refresh `evolution-summary.md`: best-so-far score + metrics, trial count,
   per-outcome counts, the score trajectory (a compact table or sparkline),
   budget consumption per dimension, and — once stopped — the single
   `stopReason`.

## Phase 7: Report the verdict and stop

Write the Ralph verdict to `$RALPH_VERDICT_FILE` (atomic: write `.tmp`, rename)
before emitting Stop. Use `$RALPH_ITERATION` unquoted — an unset value should
fail loudly rather than silently report iteration 0.

| End state | Verdict |
|---|---|
| Trial evaluated (promoted / neutral / regressed) | `progress`, target `$EVOLUTION_TARGET` |
| Baseline established | `progress`, target `$EVOLUTION_TARGET` |
| Failed trial, consecutive failures now `< maxConsecutiveFailedTrials` | `stalled`, target `$EVOLUTION_TARGET`, blockers `["evaluation_failed"]` |
| Failed trial, consecutive failures now `== maxConsecutiveFailedTrials` | write `STOP: failure_budget_exhausted` to `.evolution-stop`, then `complete` with reason `failure_budget_exhausted` — do NOT emit a final `stalled` |
| A stop criterion fired (Phase 2) | `complete`, reason = the stop reason |
| Invalid/missing config, or baseline eval failed | `stalled` + `permanent:true` |

The last failed trial emits `complete`, not `stalled`, on purpose: it stops the
run with the playbook's own `failure_budget_exhausted` reason instead of letting
the Ralph engine's single-target `target_stalled` terminate it generically. With
`maxConsecutiveFailedTrials` ≤ the engine threshold (both default `3`), the
playbook emits at most `threshold - 1` `stalled` verdicts before this `complete`,
so the engine's stall counter never reaches its own termination point — the
recorded stop reason always matches the contract.

```bash
# progress example
cat > "${RALPH_VERDICT_FILE}.tmp" <<EOF
{"verdict":"progress","iteration":${RALPH_ITERATION},"target":"$EVOLUTION_TARGET","reason":"$REASON"}
EOF
mv "${RALPH_VERDICT_FILE}.tmp" "$RALPH_VERDICT_FILE"

# complete example (a stop criterion fired)
cat > "${RALPH_VERDICT_FILE}.tmp" <<EOF
{"verdict":"complete","iteration":${RALPH_ITERATION},"reason":"$STOP_REASON"}
EOF
mv "${RALPH_VERDICT_FILE}.tmp" "$RALPH_VERDICT_FILE"
```

When `RALPH_VERDICT_FILE` is unset (single-shot launch, no Ralph loop), skip the
verdict write and simply stop after one iteration. The `.evolution-stop` file
still records the stop reason for the operator.

## Anti-Patterns

- **Don't mutate the champion in place** — always work in a per-iteration trial
  workspace, promote by atomic replace.
- **Don't promote on a negligible gain** — respect `minImprovementDelta` or the
  run churns on noise.
- **Don't conflate a failed trial with a regression** — a failed trial could not
  be scored; it feeds the failure budget, not the plateau window.
- **Don't let the agent self-score when a project `evaluate` command exists** —
  self-judged scores are not reproducible and invite reward hacking.
- **Don't keep running after a budget is exhausted** — every budget dimension
  must write a stop reason; the iteration cap is the only implicit ceiling.
- **Don't parse the artifact under evolution** — Kookr reads only the scalar
  `score` and pass-through `metrics`/`notes` from the trial result.
- **Don't rely on conversation memory** — champion.json and the trial log are the
  durable state a fresh runtime reads.
