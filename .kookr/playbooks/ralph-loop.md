---
name: Ralph Wiggum Loop
description: Drive an agent through a fixed-prompt iteration loop with a stop predicate and an iteration cap, using Kookr's first-class Ralph mode (issue #440)
tags: [workflow, loopable]
loop:
  iterationCap: 6
  costCapUsd: 5
checklist:
  - Ralph loop attached to the right task via POST /api/tasks/:id/ralph-loop
  - Standalone ralph-wiggum plugin not enabled (would double-fire on Stop)
  - Iteration cap chosen — generous enough for the work, low enough to bound cost
  - Stop predicate defined (or skipped if iteration cap is the only stop signal)
  - Optional zero-diff convergence threshold chosen when no-file-change iterations should stop automatically
  - Optional cost cap chosen only as a best-effort guard, never as the only hard ceiling
  - Dashboard Ralph badge shows "N/cap" advancing on each Stop
  - Pause/resume/cancel controls tested from the dashboard or `kookr ralph`
  - Dashboard Ralph panel shows iteration rows from the audit trail
  - Iteration audit trail at <task-cwd>/ralph-iterations.jsonl growing as expected
  - Loop terminates with the right exit reason (predicate_satisfied, iteration_cap, zero_diff_convergence, cost_cap, or cancelled)
---

## Objective

Run the same prompt against an agent in a tight loop, with the controller deciding after each agent turn whether to keep going or stop. This is Kookr's first-class implementation of the [Ralph Wiggum technique](https://ghuntley.com/ralph/), tracked in #440.

Use this playbook when you want a coding agent to grind on the same problem until either:
- a user-supplied shell predicate exits 0, or
- a configured number of consecutive iterations produce a zero git diff, or
- a best-effort cumulative cost cap is reached, or
- a hard iteration cap is reached, or
- you cancel the loop manually.

## Loop Safety

- **Durable progress location:** task prompt, issue/PR state, claim leases, and `<task-cwd>/ralph-iterations.jsonl`.
- **Idempotency check:** each iteration should inspect the durable state and skip external mutations that already exist.
- **Ownership/conflict behavior:** issue-driven loops should acquire or respect issue-claim leases before acting.
- **Terminal state:** stop predicate success, iteration cap, zero-diff convergence when configured, best-effort cost cap, or manual cancellation.
- **Known side effects:** launches and stops managed agent sessions; may create issue comments, labels, PRs, or local files when the prompt instructs the agent to do so.

## What Kookr does for you

- **Launches a fresh runtime on every continuing Stop event.** No external loop runner needed; the cycler rides Kookr's hook pipeline and starts the next iteration with the loop prompt as the first actionable instruction (see `src/core/ralph-cycler.ts`).
- **Suppresses cross-iteration noise.** While the loop runs, `repeated_error` anomalies and the `needs_input → "yes"` auto-proceed are silenced. Within-iteration signals (stale_agent, permission_blocked, hook_disconnected, …) still surface — a stuck single iteration is real.
- **Stops on built-in convergence.** If `zeroDiffConvergence.consecutiveIterations` is configured, Kookr stops after that many consecutive completed iterations have `diffStats` exactly equal to zero files, insertions, and deletions. A `null` diff means "unknown", not "zero", and resets the streak.
- **Stops on best-effort cost.** If `costCapUsd` is configured, Kookr stops when a Stop event reports `cumulativeCostUsd >= costCapUsd`. If the cost source is unavailable and reports `null`, Kookr does not stop solely on cost. Keep `iterationCap` as the hard ceiling.
- **Persists the loop state.** Crash recovery on Kookr restart: alive session → loop continues; dead session → loop is marked `failed` with a final `kookr_crash` audit record.
- **Exposes manual controls.** Running loops can be paused, resumed, or cancelled from the dashboard, HTTP API, or `kookr ralph` CLI. Resume only succeeds while a live agent session remains; if the session is gone, the conversation context is gone too and you should start a new task/loop.
- **Refuses to start on plugin coexistence.** If the standalone `ralph-wiggum@*` Claude Code plugin is enabled in any settings file, the launch returns 409 — both controllers firing on the same Stop event would corrupt the audit and double-inject.
- **Audit trail.** One JSONL line per iteration at `<task-cwd>/ralph-iterations.jsonl` with iteration number, start/end timestamps, exit reason, optional cumulative cost, and per-iteration git diff stats. The dashboard reads this through `GET /api/tasks/:id/ralph-loop/iterations`.

## Phase 1: Prepare the prompt

Decide what the agent should do every iteration. The prompt must be self-contained: the agent should not rely on transient model memory from prior iterations. It should read durable, inspectable state at the start of every turn, advance that state idempotently, and stop on an observable condition.

A good Ralph prompt typically:
- Reads durable state at the start, such as a local state file, issue/PR state, CI/check status, an API-backed queue, or a database row
- Does one unit of work
- Writes back to the durable state only when needed
- Optionally writes a done marker, label, status field, or other observable completion signal when the work is complete

Local file-state example:

> Read `prompt.md`. If it contains `<promise>DONE</promise>`, exit. Otherwise, continue the work described there, then update `prompt.md` with progress and remaining steps. Be concrete and minimal.

External issue/PR-state example:

> Read GitHub issue #123, active issue-claim leases for `owner/repo#123`, recent claim comments, and the current PR state. If another live lease or winning unexpired claim comment owns the issue, exit. If the issue already has label `ralph:done` or the PR is merged, release the claim as completed and exit. Otherwise, acquire or heartbeat the claim lease, do exactly one missing delivery step, check whether any comment/label/branch/PR action already exists before mutating external state, post concrete evidence only when needed, then stop.

For Kookr-managed GitHub issue queues, use `POST /api/issue-claims/acquire`, `POST /api/issue-claims/heartbeat`, `POST /api/issue-claims/release`, and `GET /api/issue-claims?provider=github&repo=owner/repo` together with a machine-readable claim comment. The claim key is provider + canonical `owner/repo` + issue number, so `jeanibarz/kookr#503` and `jeanibarz/codex#503` are different. Do not use GitHub assignees as the machine lock; assignment may remain a human workflow signal, but the Ralph coordination source of truth is the lease plus durable claim comment.

## Phase 2: Choose a stop predicate (optional)

The iteration cap is always enforced. The shell predicate is the *content* signal.

- `exit 0` → loop stops with reason `predicate_satisfied`
- non-zero exit → loop continues
- 5s timeout → loop continues with reason `predicate_timeout` recorded for that iteration
- spawn / exec failure → loop continues with reason `predicate_error`

Common patterns:

```bash
# Check for a marker the agent writes when done
grep -q "<promise>DONE</promise>" prompt.md

# Check for a GitHub issue label used as external durable state
gh issue view 123 --json labels --jq '.labels[].name' | grep -qx 'ralph:done'

# Check PR state, mergeability, and review decision
gh pr view 456 --json state,mergeStateStatus,reviewDecision \
  --jq '.state == "MERGED" or (.mergeStateStatus == "CLEAN" and .reviewDecision == "APPROVED")'

# Check that a test passes
pnpm test --run path/to/spec.test.ts

# Check that a build artifact exists
test -f dist/bundle.js
```

The predicate runs in the task's cwd with `RALPH_ITERATION` and `RALPH_LAST_OUTPUT_FILE` exposed as env vars.

The launched agent runtime also receives `RALPH_VERDICT_FILE` (absolute path to the per-iteration verdict file) and `RALPH_ITERATION` (current iteration number, 0-based). Agents writing verdict files in bash should use `${RALPH_ITERATION}` directly without a `:-0` fallback — an unset value should fail loudly (malformed JSON or `iteration_mismatch` warning) rather than silently report `iteration:0` every iteration, which leaves stall counts at 1 and the loop runs to its iteration cap. The `{{ralph.iteration}}` template token in the prompt is the equivalent prompt-side mechanism.

## Phase 3: Choose built-in stop guards (optional)

The iteration cap is always enforced first. Built-in guards are evaluated after the optional shell predicate:

- `zeroDiffConvergence.consecutiveIterations` stops repeated no-op file iterations with exit reason `zero_diff_convergence`.
- `costCapUsd` stops with exit reason `cost_cap` only when `cumulativeCostUsd` is a concrete number.
- `stallConfig.iterationCostCapUsd` is a per-iteration spend cap, decoupled from stall machinery: when the iteration's cost delta exceeds the cap for `consecutiveIterationCostCapHits` (default 2) iterations in a row, the loop terminates with `iteration_cost_cap`. Single hits emit a `ralph_iteration_cost_warning` event but don't terminate.

`zeroDiffConvergence` only measures local git-file no-op convergence. It is useful for file-backed implementation loops, but may be irrelevant when progress lives in external issue labels, PR state, CI checks, queues, or databases. For those loops, prefer a shell predicate that queries the external state directly.

Cost caps are deliberately fail-closed: `cumulativeCostUsd: null` means the source is unknown, so Kookr keeps looping unless another stop condition fires. The same applies to per-iteration cost cap when the prior iteration's cost was unknown.

## Phase 3.5: Stall handling (optional, recommended for batch loops)

The Ralph engine has two complementary stall channels: the **agent verdict file** (richer; agent-cooperative) and the **`stallPredicate`** shell command (engine-only; legacy- or third-party-agent-friendly). Both feed the same per-target stall counter.

### Agent verdict file (`$RALPH_VERDICT_FILE`)

Kookr injects `$RALPH_VERDICT_FILE` as an env var pointing to an absolute path (default: `<task.cwd>/.ralph-verdict-<taskIdShort>.json`). The agent writes a JSON document there before emitting Stop, then the engine reads, deletes, and acts on it:

```json
{"verdict":"progress","iteration":3,"target":"154"}
{"verdict":"stalled","iteration":3,"target":"154","reason":"tests fail to compile","blockers":["missing-dep:foo"]}
{"verdict":"stalled","iteration":3,"target":"154","reason":"umbrella tracking issue","blockers":["umbrella_tracking_issue_no_implementable_unit"],"permanent":true}
{"verdict":"complete","iteration":3,"reason":"all candidates shipped"}
```

- **`progress`** for a canonicalized target resets that target's stall counter and removes it from the burned-out list.
- **`stalled`** with a target increments that target's `consecutiveStallCount`. After `stallConfig.consecutiveStallsPerTarget` (default 2) it's burned out.
- **`stalled`** with `permanent: true` (optional, boolean) burns the target at `consecutiveStallCount=1`, bypassing the count threshold. For single-target loops the engine also terminates immediately with `target_stalled`.
  - Reserved for structurally-unfit targets where retry cannot help: umbrella issues, malformed bodies, unrecoverable worktree collisions.
  - The flag is sticky — `applyDecay` skips permanent burns so they don't silently revert. A subsequent `progress` verdict for the same target still un-burns (agent self-correction), and operator `PATCH /ralph-loop/burned-targets` clears it like any other burn.
  - Don't set on transient blockers (CI red, claim contention, network 5xx) — the count threshold is the retry-tolerance for those.
- **`complete`** terminates the loop with `predicate_satisfied` — unless an explicit `stopPredicate` is configured AND its clean exit code is non-zero, in which case the engine logs a `ralph_predicate_disagree` interaction-log event and continues.

Atomic-write contract: the agent should write `${RALPH_VERDICT_FILE}.tmp` then rename, so a Stop firing mid-write doesn't expose partial JSON. Malformed / oversize (>16KB) / wrong-iteration files are recorded as warnings on `RalphLoopState.verdictWarningCount` and treated as legacy `continued`.

### `stallPredicate` (engine-only)

A sibling of `stopPredicate` — same shell-command shape, same 5s timeout. Exit 0 = treat the iteration as a stall (single-target attribution under a synthetic `__stall_predicate__` key). Useful when the agent doesn't write verdicts: e.g. a third-party agent or a legacy playbook you can't easily modify. Verdict-from-file beats `stallPredicate` when both fire in the same iteration.

### `loopShape`, `consecutiveStallsForSingleTargetTermination`, `declaredTargets`

- `stallConfig.loopShape` defaults to `'single-target'` (the production-observed failure shape — fail safe). Set to `'multi-target'` for batch loops over multiple work items.
- `'single-target'` loops terminate with `target_stalled` once any one target reaches `consecutiveStallsForSingleTargetTermination` (default 3).
- `'multi-target'` loops keep running on stall alone. To enable an "all targets exhausted" safety net, set `stallConfig.declaredTargets: ['149','153',...]` — the loop terminates with `all_targets_stalled` when every declared target is burned.
- `stallConfig.burnedTargetDecayIterations` (optional) auto-un-burns a target after N iterations without an attempt — useful for transient blockers (CI flake) where you want the loop to retry the target later in the run.

### Per-iteration prompt template

When the prompt body contains any `{{ralph.<token>}}` marker, the engine substitutes per-iteration values at iteration-launch time. Tokens:

- `{{ralph.iteration}}` — current iteration number (0-based).
- `{{ralph.cumulativeIterations}}` — across resumes.
- `{{ralph.burnedOutTargets}}` — comma-separated canonicalized target ids; the literal `(none)` when the list is empty.
- `{{ralph.lastStallReason}}` — the most recent stall reason, or empty.
- `{{ralph.recentVerdicts}}` — last 5 verdicts as a one-line summary.

Substitution is unconditional with empty-string / `(none)` fallback. There is no `{{#if}}` syntax — write the surrounding prose so it reads naturally either way (e.g. `Burned: {{ralph.burnedOutTargets}}` reads as `Burned: (none)` when none are burned). A prompt with no `{{ralph.x}}` markers is forwarded unchanged — opt-in by marker presence.

### Operator unblock

To retry a burned target without restarting the loop:

```bash
curl -X PATCH http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/burned-targets \
  -H 'Content-Type: application/json' \
  -d '{"remove": ["154"]}'
```

`{ "clear": true }` empties the entire burned list. Every PATCH fires a `ralph_burned_targets_modified` interaction-log event with the prior state snapshot for audit.

The dashboard's Ralph panel shows the burned-targets row, a Clear button, the verdict-warning count, and the effective `stallConfig` (defaults merged) so operators can verify the live values without inspecting the loop request.

## Phase 4: Launch a task

Launch a normal task first (any prompt — Ralph will replace the per-turn prompt below). Note the task ID returned in the response.

```bash
curl -X POST http://localhost:4800/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Initial bootstrap", "cwd": "/path/to/workdir"}'
```

## Phase 5: Attach the Ralph loop

```bash
curl -X POST http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Read prompt.md and continue the work...",
    "iterationCap": 20,
    "stopPredicate": "grep -q \"<promise>DONE</promise>\" prompt.md",
    "zeroDiffConvergence": { "consecutiveIterations": 3 },
    "costCapUsd": 10
  }'
```

Success returns `200 {ok: true, ralphLoop: {...}}`.

Common failures:
- `404` — task ID not found
- `409 task already has an active Ralph loop` — resume or cancel the existing running/paused loop first
- `409 standalone ralph-wiggum plugin detected` — body lists the matched settings files; disable the plugin entry there before retrying
- `400 ...` — prompt empty, iterationCap not a positive integer, stopPredicate non-string, zeroDiffConvergence invalid, or costCapUsd not a positive finite number

## Phase 6: Watch it run

The dashboard's task card now shows a **N/cap** Ralph badge. The number ticks on every Stop event the agent emits. Click the task and open the **Ralph** tab in the detail panel.

The Ralph panel shows the latest iteration records, cumulative cost when the hook payload provided it, runtime/ETA when defensible, diff stats when the git baseline was available, and a count of malformed audit lines skipped. The most recent `exitReason` tells you what happened: `continued` (normal), `predicate_satisfied` (stopped), `iteration_cap` (hit the limit), `predicate_timeout` / `predicate_error` (predicate misbehaved but loop kept going), `kookr_crash` (Kookr restart killed it).

For API consumers, the same read model is available at:

```bash
curl http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/iterations
```

Each line is one completed iteration. The `exitReason` field on the most-recent line tells you what happened: `continued` (normal), `predicate_satisfied` (stopped), `iteration_cap` (hit the limit), `zero_diff_convergence` (configured no-change streak reached), `cost_cap` (reported cumulative cost reached the cap), `predicate_timeout` / `predicate_error` (predicate misbehaved but loop kept going), `kookr_crash` (Kookr restart killed it).

## Phase 7: Pause, resume, or stop early

From the dashboard, use the compact controls beside the **N/cap** Ralph badge:

- pause stops fresh iteration launches after the current iteration finishes
- resume re-enables fresh iteration launch on the next Stop event, if the agent session is still live
- cancel marks the loop cancelled and leaves the agent session alive

The Ralph panel also lets you edit the prompt used for future iterations. Prompt edits apply only to subsequent fresh-runtime launches; the currently running turn keeps the prompt it already received. The API accepts prompt edits for running and paused loops, and rejects edits after the loop reaches `completed`, `failed`, or `cancelled`.

Equivalent CLI commands:

```bash
kookr ralph status <TASK_ID>
kookr ralph pause <TASK_ID>
kookr ralph resume <TASK_ID>
kookr ralph cancel <TASK_ID>
```

Equivalent HTTP calls:

```bash
curl -X POST http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/pause
curl -X POST http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/resume
curl -X PATCH http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop/prompt \
  -H 'Content-Type: application/json' \
  -d '{"prompt": "Read CHECKPOINT.md and continue with the next missing step..."}'
curl -X DELETE http://localhost:4800/api/tasks/<TASK_ID>/ralph-loop
```

Cancel sets `status: 'cancelled'`. The cycler stops launching new iterations on the next Stop event. The agent's session is left alive — kill the agent separately with `DELETE /api/tasks/:id` if you want a clean teardown.

## Anti-patterns

- **Don't** install the standalone `ralph-wiggum@claude-code-plugins` plugin alongside Kookr's loop. The coexistence detector blocks at start, but if you enable the plugin *after* a Kookr loop is running, both controllers fire on every Stop. Disable one or the other.
- **Don't** make external-state loops non-idempotent. Prompts must check for already-done actions before commenting, labeling, assigning, creating branches, opening PRs, or merging; otherwise every iteration can duplicate side effects.
- **Don't** use GitHub issue assignment as a short-lived Ralph work lock. Use repo-scoped issue claim leases and claim comments so stale ownership can expire, release, or be reclaimed without manual unassignment.
- **Don't** rely on conversation memory from a previous iteration. Each continuing iteration starts in a fresh agent runtime; put durable state reads and writes in the prompt.
- **Don't** rely on `costCapUsd` for hard budget limits — it uses best-effort `cumulativeCostUsd` from the Stop hook payload, and `null` explicitly does not stop the loop. Use the iteration cap as the hard ceiling.
- **Don't** write predicates that take longer than 5s to evaluate. They'll timeout (the loop continues but the iteration's exit reason is `predicate_timeout`, which clutters the audit). Faster predicates → faster loop turnaround.
- **Don't** assume the predicate runs in a clean shell — it inherits Kookr's environment plus `RALPH_ITERATION` and `RALPH_LAST_OUTPUT_FILE`. Don't reference unset variables without guards.
