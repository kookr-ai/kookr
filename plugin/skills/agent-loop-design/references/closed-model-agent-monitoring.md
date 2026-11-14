# Closed-model agent monitoring

Use when: monitoring a hosted (closed-API) agent where there are no activations to probe: deciding
whether to read its reasoning text, trusting its "done", "tests pass" or confidence, adding an ask or
abstain gate, or checking whether eval behavior predicts deployment.

What the model can represent is not what it acts on: a probe-readable signal is not a used signal
(2611.10457, see [agent internal signals](agent-internal-signals.md)). Without weights, close that gap
with structure and outside evidence, not by asking the model.

## Reading the reasoning text

1. **Monitor actions and artifacts first**: tool calls, diffs, shell commands, tests, PR state. Closed
   APIs do not return raw reasoning, so a reasoning monitor is optional.
2. **Use reasoning text only to raise suspicion, never to lower it, and flag reasoning-versus-action
   mismatch.** A clean trace is not an all-clear: safe-looking reasoning coexisted with unsafe output
   (alignment faking in up to 53.1% of turns, DeepSeek-R1-7B, 2606.10740). Never train or select an
   agent against a monitor's reading of its reasoning ([latent vs text](latent-vs-text-agent-design.md)
   rule 6).
3. **Report recall at a fixed 1% to 5% false-positive rate, not AUC.** Stripping reasoning cut an LLM
   judge's recall from 0.82 to 0.44 while AUC moved only from 0.97 to 0.92 (2604.17596); a trained
   detector fell from TPR 0.8296 to 0.0852 at 5% FPR (2606.08893). Against: combining full and stripped
   encoders gained only +4% true positives for +13% false positives (2606.08893), and thought and
   response audits were nearly tied (AUROC 0.920 vs 0.935, 2605.19270).
4. **Window and persist the monitor, and add tripwires** (honeytools, canary files). Long transcripts
   cut recall, a stateful monitor beat a standard one, and tripwires caught 90.7% to 100% of successful
   injection attacks with no false alarms in 485 normal runs; figures in [agent action
   containment](../../agent-safety/references/agent-action-containment.md) rules 3 and 8, which also
   show a frontier monitor with thinking missing 20 of 40 covert attacks. Obfuscation results are
   single-paper and small-model.

## Closing the know-do gap without weights

5. **Split detection from action.** Before a worker acts on an underspecified task, run a separate "is
   the information enough?" step and give it a legal exit: ask, abstain or escalate. On underspecified
   SWE-bench Verified with Claude Sonnet 4.5, a separate clarification-gating agent scored 69.40%,
   against 61.20% when one agent did both, 54.80% with no interaction and 70.80% with the full spec
   (2603.26233). A prompt-only stopping playbook raised timely abstention from 26.7% to 57.4%
   (Llama-3.3-70B, 2606.28733).
6. **Measure false refusals before shipping an exit.** Abstention training cost correctness on
   answerable questions, 91.8% to 86.8% (2605.28070), and Claude 4.6 Opus lost 52% on perturbed AIME,
   mostly to refusals (2604.08571). No paper reports a false-refusal rate for a prompt-only gate.
7. **Never accept a self-report as evidence.** "Done", "tests pass" and "I verified" each need an
   artifact behind them: 80.2% of 86,156 agent-written test patches had weak or no oracle signals
   (2606.18168). More in [agent failure recovery](agent-failure-recovery.md) Step 1 and
   [coding-agent patch acceptance](../../agent-evaluation/references/coding-agent-patch-acceptance.md).
8. **Re-check only with room to reason and headroom to gain**; no generic "double-check your answer" on
   tasks the model already gets mostly right. Pushback with 96-token replies left accuracy flat or
   lower; with 1,024-token replies it gained up to 5.7 points, and only when first-pass accuracy was
   below the break-even c/(c+k) (2611.11035). Point at specific evidence, not a bare "are you sure?":
   causal critique took GPT-4 Turbo from 31.4% to 90.5%, and the bare cue has a false-flip cost
   (2602.11675).
9. **Never gate on a worker's stated confidence; use it as one input at most.** Verbalized confidence
   was the weakest channel: a probe beat token probabilities (ECE 0.089 vs 0.217, 2604.19444), and
   outcome-reward RL made models overconfident (AIME24 ECE 0.108, against 0.049 with a
   calibration-aware method, 2604.23333). On closed APIs, use agreement across samples (AUROC up to
   0.733, 2606.29090). A blind re-scoring pass cut confidence ECE by 88.4% on one benchmark
   (2604.13271), so self-checks can fix calibration, not correctness. Escalation triggers:
   `agent-fleet-orchestration`.
10. **Evaluate on replayed real usage, not test-looking prompts.** Latent recognition of an evaluation
    was 26% on SWE-bench and under 1% in real usage (2605.11496); replaying real agent trajectories
    moved Opus 4.6's cave rate from 2% to 46% (2605.26438). Judges shifted verdicts by up to 9.8 points
    under stakes framing, and their reasoning never mentioned it (2604.15224).

**Limits.** All probe-gap numbers come from open models of 0.6B-32B; the gap persisted at 14B in the one
scale series (2609.29848). Steering away caving also removed correction: caving fell from 6.1% to 0%,
correction from 13.8% to 1.5% (2611.11035).

## Gaps (not found in the surveyed literature)

- No paired reasoning-plus-action vs action-only monitor comparison on sabotage or scheming with
  reasoning visible; no measurement on summarized reasoning (what closed APIs offer); no false-positive
  rate at a realistic base rate.
- No know-do-gap measurement on frontier or closed models, nor along a multi-step agent run.
- No false-refusal rate for prompt-only gates; no same-model comparison of verbalized, logit and probe
  confidence; no measured rate of false "done" claims by coding workers.
