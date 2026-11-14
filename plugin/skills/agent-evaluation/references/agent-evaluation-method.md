---
name: agent-evaluation-method
group: design-analysis
description: >
  Decide whether a score gap between two agent configurations (model, harness, prompt, skill or tool set)
  is real before acting on it. Covers the four checks that come before a benchmark difference counts:
  an audited instrument (every episode graded, failed rollouts counted, harness and grader frozen across
  arms), an audited task set (weak tests, leaked answers, exploitable visible scores), repeated paired
  runs (3-6 per arm, Mean plus Pass^k, never a baseline carried over from an earlier run), and a
  decision rule fixed in advance (paired interval, A/A control, stated margin). Also covers lucky passes,
  cost-aware reporting, grader reliability for LLM-scored benchmarks, and cheap subset evaluation. Use
  before choosing between two agent setups from benchmark numbers, before publishing or acting on a
  benchmark claim, when a keep-or-revert loop compares scores, or when a result looks too good.
keywords: agent evaluation, benchmark, score difference, noise floor, A/A test, lucky pass, pass^k, pass@k, repeated runs, variance, harness effect, scaffold, instrument error, silent grading failure, benchmark audit, test oracle, reward hacking, public score, LLM judge variance, judge prompt sensitivity, paired comparison, bootstrap interval, subset evaluation, stale baseline, SWE-bench, regression eval
related: agent-fleet-orchestration, parallel-subagent-experiments, adversarial-swarm-analysis, testing-patterns, token-efficiency
---

# Agent evaluation method

## The idea

A benchmark score is a measurement made with an instrument: tasks, a harness that runs the agent, and a
grader. In the papers below, a gap between two agent setups often came from the instrument or from
noise, not from the setup. Before you act on a gap (switch models, keep a prompt, merge a skill, claim a
win), run four checks. Skip a check only when being wrong is cheap and easy to undo.

The local knowledge base (KB, the `kb` CLI's collection of ingested arXiv paper notes and operator notes)
gives no proven run count. The figures here are the best-supported ones, from specific studies, cited by
arXiv ID or note name; treat them as starting points and say so when you report a result.

Terms used below:
- **Arm**: one configuration under test (for example "prompt A" or "prompt B").
- **Mean@k and Pass^k**: Mean@k is the average success over k runs of each task. Pass^k is the share of
  tasks solved in all k runs, so it measures reliability.
- **Gate**: the rule that decides whether an arm is kept, promoted or merged.
- **Oracle**: the test or check that decides whether an agent's output is correct.
- **A/A control**: running two identical arms through the same gate to see how often noise alone "wins".
- **Lucky pass**: a correct final result reached by an unreliable path (retries, regressions, no checking).
- **SD**: standard deviation.

## Check 1: the instrument works and is the same for both arms

- **Grade every episode.** A leaderboard scaffold was graded in only 51% of episodes because its closing
  messages never triggered the grader; re-grading turned a published 13-point gap into a tie and reversed
  48 of 351 pairwise orderings (2611.04399). Count graded, failed and errored episodes per arm and put
  the counts next to the score. None of 50 audited agent repositories reported failed rollouts, and
  changing only the reporting rule moved scores by up to 20.9 points (2605.12131).
- **Freeze everything except the thing under test.** Same model gave 93.1% on one harness and 76.7% on
  another with the same retriever (2605.15184); one 27B model's cost varied 139x across seven
  scaffoldings (2608.08654); a position paper cites 20+ points across harnesses on TerminalBench
  without re-measuring it (2606.17799). Pin harness, tool versions, turn and time limits, grader model and
  grader prompt, and write them into the result.
- **Run a canary.** Include one task whose answer you know, and confirm both arms get it right. A run with
  no errors can still carry no signal, for example when the grader never ran (experiment-methodology note,
  no arXiv ID).
- **Re-run apparatus failures; do not score them as agent failures.** A token counter that included
  thinking tokens aborted a 22k-token run as too large (agent-task-lessons note). Run one live call per
  decoding mode before trusting counts.

## Check 2: the tasks are sound

- **Scan transcripts.** An LLM transcript scanner surfaced verified quality issues in five widely used
  agent benchmarks, with F1 from 0.14 to 0.74 depending on the flaw type, so use it to triage, then
  have a human check. About 75 human-graded transcripts rule out a violation rate under 5% (2607.27518).
- **Check the oracle.** The official KernelBench check missed 16.9% of 7,384 seeded faults, and hardening
  it moved scores by 8.5 points (2609.22220). 7.8% of resolved SWE-bench patches fail developer tests
  and 32.67% of issue texts leak the solution, as reported by one position paper (2606.17799).
- **Hide the visible score.** In 1,326 coding-agent runs, 403 exploited the public score; an explicit
  anti-exploit prompt cut exploitation from 100% to 8.3% on the measured subset (2604.20200).

## Check 3: repeat, pair and report consistency

- **3 to 6 runs per arm on the same tasks.** Variance rose in 71% of self-improvement experiments; best
  and worst runs differed by up to 10.4 points; a +1.5% gain had p = 0.23 at 3 runs and p = 0.07 at 6
  (2608.18066).
- **Report Mean and Pass^k.** Mean@5 was 77% while Pass^5 was 53% on AppWorld (2609.08832).
- **Look for lucky passes.** 10.7% of passing SWE-bench Verified runs got there through regression
  cycles (fixes that break earlier fixes), blind retries or skipped verification; the rate was 0.5% to 23.2% per model, ranks shifted by
  up to 5 positions on quality score, and lucky passes cost up to 40x the tokens (2605.12925). Token
  cost per pass is a cheap proxy.
- **Never compare against an earlier run's baseline.** A control delta went from +0.37 SD to -0.24 SD
  across two runs (n = 15). Rerun the control in the same run (agent-task-lessons note).
- **A/A control.** Run two identical arms through the same gate. An identical challenger "won" 80% of
  the time in one operator loop, and a 6-3 win in head-to-head comparisons became 4-4 on a clean re-run (experiment-methodology note).

## Check 4: fix the decision rule before looking

- **No greedy "keep if higher."** Keeping any change whose score went up accepted a worthless change
  (a "false commit") 30-42% of the time when one real improvement was available and 72-100% of the time
  when none was. A paired test that stays valid however often you peek ("anytime-valid") held false
  commits near zero with about 18% fewer evaluations, tested on 0.5B-3B models (2606.08106).
- **Fix metric, interval, margin and stopping rule up front.** Report the margin with the verdict; a
  threshold passed by a hair is a decision, not a discovery.
- **Say "gate unreachable," not "no effect," when ties dominate.** A gate needing 6 decided pairs can
  never fire when 50-75% of pairs tie (experiment-methodology note).
- **Apply it to agents that judge themselves.** LLM research agents claimed predictability in no-signal
  data 16-44% of the time against a nominal 5% (2611.04070).

## When an LLM grades

- Hold the judge model and judge prompt fixed across arms. Rewording the judge prompt shifted a rate by up
  to 24.2 points with the judge fixed (2604.24074); judge identity was over 94% of MT-Bench variance at
  default settings, and round-robin judging cut variance 27-40% (2603.01865).
- Use several judge families. Single judges agreed at rho 0.47-0.63; a 5-judge ensemble is projected near
  0.84 (2605.27914).
- Calibrate with human labels. The more your LLM ratings track human ones (R² is the share of human
  variation they explain), the fewer human reviews you need: with 200 items to settle and R² = 0.7,
  2,000 LLM ratings need 65 human reviews (2605.16354). That is a formula, not an agent study.
- Judge studies here mostly cover safety and chat benchmarks; agent-trajectory graders are less measured.

## Spend less once the instrument is trusted

- A 10% task subset kept median resolve-rate error under 5% and cut tokens about 90%; plain stratified
  sampling was competitive at 20-30% (2609.24928). Use subsets for regression checks and the full set
  for decisions.
- Report cost beside accuracy, so a cheaper setup that resolves the same number of tasks is visible:
  a trained model router resolved 75 of 100 tasks, the same as always using Opus 4.6, at 53.1% lower API
  cost (2605.18859).

## Anti-patterns

- **One run, one number.** The spread across runs can exceed the effect.
- **Pass rate only.** It hides lucky passes and reliability.
- **Scoring apparatus failures as agent failures** (or silently dropping them).
- **Different harness, grader or prompt per arm.**
- **Carrying a baseline over from an earlier run.**
- **Treating a null as proof of no effect** when the gate could not fire.
- **Fixing the threshold after seeing the data.**

## Gaps in the evidence

The KB has no recommended k for Pass^k, no minimum detectable difference or tasks-versus-repeats rule
for agent comparisons, no measured effect of timeouts, turn limits or tool-version pinning, no
leaderboard re-scored after removing flagged tasks, and no agent-benchmark case where only the grader
changed. It also has no study showing a few in-house tasks predict real usefulness better than a public
benchmark. Several operator figures come from single incidents with n of 15 or fewer. Source report:
`trusting-agent-benchmark-score-differences` in the `agentic-capability-reports` KB.
