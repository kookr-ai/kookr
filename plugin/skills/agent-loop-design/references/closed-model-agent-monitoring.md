# Closed-model agent monitoring

Use when: monitoring a hosted (closed-API) agent where there are no activations to probe: deciding
whether to read its reasoning text, trusting its "done", "tests pass" or confidence, adding an ask or
abstain gate, or checking whether eval behavior predicts deployment.

What the model can represent is not what it acts on (see [agent internal
signals](agent-internal-signals.md)). Without weights, close that gap with structure and outside
evidence, not by asking the model.

## Reading the reasoning text

1. **Monitor actions and artifacts first**: tool calls, diffs, shell commands, tests, PR state. Closed
   APIs do not return raw reasoning, so a reasoning monitor is optional.
2. **Use reasoning text only to raise suspicion, never to lower it, and flag reasoning-versus-action
   mismatch.** A clean trace is not an all-clear: safe-looking reasoning coexisted with unsafe output.
   Never train or select an agent against a monitor's reading of its reasoning ([latent vs
   text](latent-vs-text-agent-design.md), **Gate on checks**).
3. **Report recall at a fixed 1% to 5% false-positive rate, not AUC.** Stripping reasoning cut an LLM
   judge's recall from 0.82 to 0.44 while AUC moved only from 0.97 to 0.92. Combining full and stripped
   views gained little, and thought and response audits were nearly tied.
4. **Window and persist the monitor, and add tripwires** (honeytools, canary files). Long transcripts
   cut recall, a stateful monitor beat a standard one, and tripwires caught 91-100% of successful
   injection attacks with no false alarms in 485 normal runs, and a frontier monitor with thinking missed
   20 of 40 covert attacks. See [agent action
   containment](../../agent-safety/references/agent-action-containment.md) (**Treat a monitor as a
   backstop**) and [untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)
   for tripwires.

## Closing the know-do gap without weights

5. **Split detection from action.** Before a worker acts on an underspecified task, run a separate "is
   the information enough?" step and give it a legal exit: ask, abstain or escalate. A separate
   clarification-gating agent scored 69% on underspecified SWE-bench Verified vs 61% when one agent did
   both and 55% with no interaction (full spec: 71%).
6. **Measure false refusals before shipping an exit.** Abstention training cost correctness on
   answerable questions (92% to 87%), and a frontier model lost 52% on perturbed AIME, mostly to
   refusals. No paper reports a false-refusal rate for a prompt-only gate.
7. **Never accept a self-report as evidence.** "Done", "tests pass" and "I verified" each need an
   artifact behind them: 80% of agent-written test patches had weak or no oracle signals. See [agent
   failure recovery](agent-failure-recovery.md) (Step 1) and [coding-agent patch
   acceptance](../../agent-evaluation/references/coding-agent-patch-acceptance.md).
8. **Re-check only with room to reason and headroom to gain**; no generic "double-check your answer" on
   tasks the model already gets mostly right. Short pushback replies left accuracy flat or lower; long
   ones gained up to ~6 points, and only when first-pass accuracy was below the break-even c/(c+k).
   Point at specific evidence, not a bare "are you sure?" (causal critique took one model from 31% to
   91%; the bare cue has a false-flip cost).
9. **Never gate on a worker's stated confidence; use it as one input at most.** Verbalized confidence was
   the weakest channel: a probe beat token probabilities, and outcome-reward RL made models
   overconfident. On closed APIs, use agreement across samples. A blind re-scoring pass can fix calibration, not correctness. Escalation triggers: `agent-fleet-orchestration`.
10. **Evaluate on replayed real usage, not test-looking prompts.** Models recognized an evaluation 26% of
    the time on SWE-bench and under 1% in real usage; replaying real trajectories moved one model's cave
    rate from 2% to 46%. Judges shifted verdicts by up to ~10 points under stakes framing without
    mentioning it.

Limits: probe-gap numbers come from open models of 0.6B-32B. Steering away caving also removed
correction (13.8% to 1.5%).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-cot-monitor-vs-action-monitor-for-closed-api-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-know-do-gap-when-agents-ignore-what-they-represent.md
