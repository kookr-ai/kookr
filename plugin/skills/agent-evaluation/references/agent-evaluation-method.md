# Agent evaluation method

Use when: choosing between two agent configurations (model, harness, prompt, skill or tool set) from
benchmark numbers, before publishing or acting on a benchmark claim, or when a result looks too good.

Run the four checks before acting on a gap; skip one only when being wrong is cheap and easy to undo. No
study gives a proven run count: the figures are starting points from specific studies, so say so when you
report. Keep gate inside a loop: [autonomous experiment loops](autonomous-experiment-loops.md).

## Check 1: the instrument works and is the same for both arms

- **Grade every episode.** A leaderboard scaffold was graded in only 51% of episodes because its closing
  messages never triggered the grader; re-grading turned a published 13-point gap into a tie and reversed
  48 of 351 pairwise orderings (2611.04399). Count graded, failed and errored episodes per arm and put
  the counts next to the score. None of 50 audited agent repositories reported failed rollouts, and
  changing only the reporting rule moved scores by up to 20.9 points (2605.12131).
- **Freeze everything except the thing under test.** Same model gave 93.1% on one harness and 76.7% on
  another with the same retriever (2605.15184). Pin harness, tool versions, turn and time limits, grader
  model and grader prompt, and write them into the result.
- **Run a canary.** Include one task whose answer you know, and confirm both arms get it right. A run with
  no errors can still carry no signal, for example when the grader never ran (operator note).
- **Re-run apparatus failures; do not score them as agent failures or drop them silently.** A token counter
  that included thinking tokens aborted a 22k-token run as too large (operator incident). Run one live call
  per decoding mode before trusting counts.

## Check 2: the tasks are sound

- **Scan transcripts.** An LLM transcript scanner surfaced verified quality issues in five widely used
  agent benchmarks, with F1 from 0.14 to 0.74 depending on the flaw type, so use it to triage, then
  have a human check. About 75 human-graded transcripts rule out a violation rate under 5% (2607.27518).
- **Check the oracle.** Hardening the official KernelBench check moved scores by 8.5 points (2609.22220).
  7.8% of resolved SWE-bench patches fail developer tests and 32.67% of issue texts leak the solution, as
  reported by one position paper (2606.17799). Audit method: [output verification](agent-output-verification.md).
- **Hide the visible score** from the agent (evidence in [output verification](agent-output-verification.md)).

## Check 3: repeat, pair and report consistency

- **3 to 6 runs per arm on the same tasks.** Variance rose in 71% of self-improvement experiments; best
  and worst runs differed by up to 10.4 points; a +1.5% gain had p = 0.23 at 3 runs and p = 0.07 at 6;
  one memory method moved from +1.5% to -4.5% when task order was shuffled (2608.18066).
- **Report Mean@k and Pass^k** (share of tasks solved in all k runs), not pass rate only. Mean@5 was 77%
  while Pass^5 was 53% on AppWorld (2609.08832).
- **Look for lucky passes.** 10.7% of passing OpenHands runs on SWE-bench Verified got there through
  regression cycles (fixes that break earlier fixes), blind retries or skipped verification; the rate was
  0.5% to 23.2% per model, ranks shifted by up to 5 positions on quality score, and lucky passes cost up to
  40x the tokens (2605.12925). Token cost per pass is a cheap proxy.
- **Never compare against an earlier run's baseline.** A control delta went from +0.37 SD to -0.24 SD
  across two runs (n = 15, operator incident). Rerun the control in the same run.
- **A/A control**: two identical arms through the same gate (evidence under **Noise floor** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).

## Check 4: fix the decision rule before looking

- **No greedy "keep if higher"**; use a paired test (evidence under **Paired keep** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).
- **Fix metric, interval, margin and stopping rule up front.** Report the margin with the verdict; a
  threshold passed by a hair is a decision, not a discovery.
- **Say "gate unreachable," not "no effect," when ties dominate.** A gate needing 6 decided pairs can
  never fire when 50-75% of pairs tie (operator note).
- **Apply it to agents that judge themselves** (evidence under **Verifier the loop cannot edit** in
  [autonomous experiment loops](autonomous-experiment-loops.md)).

## When an LLM grades

- Hold the judge model and judge prompt fixed across arms. Rewording the judge prompt shifted a rate by up
  to 24.2 points with the judge fixed (2604.24074); judge identity was over 94% of MT-Bench variance at
  default settings, and round-robin judging cut variance 27-40% (2603.01865).
- Use several judge families. Single judges agreed at rho 0.47-0.63; a 5-judge ensemble is projected near
  0.84 (2605.27914).
- Calibrate with human labels; the more LLM ratings track human ones, the fewer human reviews you need:
  with 200 items to settle and R² = 0.7, 2,000 LLM ratings need 65 human reviews (2605.16354). That is a
  formula, not an agent study.
- Judge studies here mostly cover safety and chat benchmarks; agent-trajectory graders are less measured.

## Spend less once the instrument is trusted

- A 10% task subset kept median resolve-rate error under 5% and cut tokens about 90%; plain stratified
  sampling was competitive at 20-30% (2609.24928). Use subsets for regression checks, the full set for
  decisions.
- Report cost beside accuracy: a trained model router resolved 75 of 100 tasks, the same as always using
  Opus 4.6, at 53.1% lower API cost (2605.18859).

## Gaps

- No recommended k for Pass^k; no minimum detectable difference or tasks-versus-repeats rule for agents.
- No measured effect of timeouts, turn limits or tool-version pinning.
- No leaderboard re-scored after removing flagged tasks; no agent-benchmark case where only the grader changed.
- No study shows a few in-house tasks predict real usefulness better than a public benchmark.
- Several operator figures come from single incidents with n of 15 or fewer.
