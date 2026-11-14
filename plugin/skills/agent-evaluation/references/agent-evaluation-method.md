# Agent evaluation method

Use when: choosing between two agent configurations (model, harness, prompt, skill or tool set) from
benchmark numbers, before publishing or acting on a benchmark claim, or when a result looks too good.

Run the four checks before acting on a gap; skip one only when being wrong is cheap and easy to undo. The
figures are starting points, not proven run counts: say so when you report. Keep gate inside a loop:
[autonomous experiment loops](autonomous-experiment-loops.md). Suite from your own history:
[in-house regression suite](in-house-regression-suite.md). Arm with growing memory or skills:
[stateful agent evaluation](stateful-agent-evaluation.md).

## Check 1: the instrument works and is the same for both arms

- **Grade every episode.** A scaffold whose closing messages never triggered the grader was graded in only
  51% of episodes; re-grading turned a 13-point gap into a tie. Report graded, failed and errored episode
  counts per arm next to the score. Changing only the failure-reporting rule moved scores up to ~20 points.
- **Freeze everything except the thing under test.** The same model scored 93% on one harness and 77% on
  another. Pin harness, tool versions, turn and time limits, grader model and grader prompt; record them.
- **Run a canary.** Include one task with a known answer and confirm both arms get it right. An error-free
  run can still carry no signal (the grader never ran).
- **Re-run apparatus failures; do not score them as agent failures or drop them.** Run one live call per
  decoding mode before trusting token counts (a counter that included thinking tokens aborted a run).

## Check 2: the tasks are sound

- **Scan transcripts for task flaws.** An LLM scanner is a triage step (F1 0.14-0.74 by flaw type); have a
  human check what it flags (~75 human-graded transcripts rule out a violation rate under 5%).
- **Check the oracle.** Hardening one benchmark's check moved scores ~8 points. Check issue/diff alignment
  and whether the issue text leaks the solution: ~14% of one coding benchmark's instances were misaligned
  and excluding them changed ~64% of rankings. Audit method: [output
  verification](agent-output-verification.md).
- **Hide the visible score** from the agent ([output verification](agent-output-verification.md)).

## Check 3: repeat, pair and report consistency

- **Run 3 to 6 times per arm on the same tasks.** Run-to-run swings reach ~10 points; a +1.5% gain was p =
  0.23 at 3 runs and 0.07 at 6, and shuffling task order flipped one memory method from +1.5% to -4.5%.
- **Report Mean@k and Pass^k** (share of tasks solved in all k runs), not pass rate only (77% vs 53% on one
  benchmark).
- **Look for lucky passes**: regression cycles, blind retries or skipped verification (~11% of passes on one
  benchmark, up to 23% per model, at up to 40x the tokens). Token cost per pass is a cheap proxy.
- **Never compare against an earlier run's baseline.** Rerun the control in the same run (a control delta
  flipped sign between two runs).
- **Run an A/A control**: two identical arms through the same gate (see **Noise floor** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).

## Check 4: fix the decision rule before looking

- **No greedy "keep if higher"**; use a paired test (see **Paired keep** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).
- **Fix metric, interval, margin and stopping rule up front.** Report the margin with the verdict; a
  threshold passed by a hair is a decision, not a discovery.
- **Say "gate unreachable," not "no effect," when ties dominate** (a gate needing 6 decided pairs never
  fires when 50-75% of pairs tie).
- **Apply it to agents that judge themselves** (see **Verifier the loop cannot edit** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).

## When an LLM grades

- **Hold judge model and judge prompt fixed across arms.** Rewording the judge prompt alone shifted a rate
  up to ~24 points; judge identity dominated variance in one chat benchmark, and round-robin judging cut
  that variance 27-40%.
- **Use several judge families**; single judges agree only moderately (rho ~0.5-0.6).
- **Calibrate with human labels**; the better LLM ratings track humans, the fewer human reviews you need
  (formula, not an agent study).
- Judge studies mostly cover chat and safety; agent-trajectory graders are less measured.

## Spend less once the instrument is trusted

- **Use a task subset for regression checks, the full set for decisions.** A selected 10% subset kept median
  resolve-rate error under 5% at ~90% fewer tokens; plain stratified sampling needed 20-30%.
- **Report cost beside accuracy**; a router matched always-Opus at about half the API cost.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-trusting-agent-benchmark-score-differences.md
