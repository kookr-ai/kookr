---
name: agent-internal-signals
group: design-analysis
description: >
  Decide whether to monitor or steer an LLM agent with internal-model signals (linear probes on hidden
  states, activation steering vectors, sparse-autoencoder features) or with output-level checks (tests,
  a fresh-context judge, live output text). Covers the access requirement (open weights only), why a
  probe-readable signal is not proof the model uses it, the intervention test to run before gating on
  a probe, steering side effects (emergent misalignment, collateral damage), and how to validate any
  failure detector on real captured runs. Use when someone proposes probes, steering vectors or SAE
  features for an agent, when designing a stuck or drift detector, or when choosing between white-box
  and black-box monitoring.
keywords: linear probe, activation steering, steering vector, sparse autoencoder, SAE, interpretability, white-box monitor, black-box monitor, hidden states, represented but not used, causal validation, ablation, activation patching, emergent misalignment, collateral damage, chain-of-thought monitor, drift detector, stuck detector, liveness, open weights
related: agent-fleet-orchestration, automation-design, autonomous-watch-loop, independent-merge-review, token-efficiency
---

# Agent internal signals

## The idea

An internal signal is a sensor reading, not a verdict. A linear probe can often read a property such as
harmfulness, task value or valence from a model's hidden states. That does not show the model uses the
property to choose its next action, and it does not show that pushing the property changes behavior the
way you want. Treat probes and steering vectors as hypotheses until an intervention test supports them.

## Rules

1. **Check access first.** Probes, steering and SAE features need the model's activations. A hosted
   Claude-class model exposes none. For those agents use output-level checks only: tests, a fresh-context
   verifier, live output text. Reach for internal signals only for open-weight models you host.
2. **Do not gate on probe accuracy alone.** Run an intervention test: ablate, patch or steer along the
   direction and check that behavior changes as predicted, with a random-direction control. If injecting
   the direction moves behavior but removing it does not, the direction is a correlate.
3. **Probe the trajectory, pool with max.** Final-token probes missed 27.8%-36.4% of jailbreaks across three
   7-8B models, and a trajectory readout recovered 97.0%-98.1% of the misses (2605.12726). Average pooling
   collapsed to random while max-pooling reached AUROC 94-97% on harmfulness detection (2605.18549).
4. **Test off-distribution before trusting a number.** Static probes degraded on an out-of-distribution
   set (2605.18549) and persona-subspace probes generalized only partly (2605.09391).
5. **Measure side effects of steering on neighbours, not on one aggregate benchmark.** A steering vector
   from one narrow task lifted misaligned-answer probability from about 0% to 23-35% on Qwen3.5-27B
   (2606.08682). A jailbreak repair kept MMLU within 0.07 points yet lost 26.3 benign-preservation
   points (2610.10276). Side effects follow the model's defaults, not vector geometry: geometry predicted
   at most about 15% of interference (2609.06951).
6. **Do not store facts in a steering vector (one small-model study).** Facts were used cleanly at most 15% of the time vs 96-98%
   when placed in context (2610.14958). Use steering for dispositions at most.
7. **Keep an output-level check as the tiebreaker.** Never let a probe alone kill, accept or merge work.
8. **Validate any detector on real captured runs.** In local runs a pane-state detector passed all synthetic
   fixtures and failed on live raw bytes, and a reaper killed a finished session. Silence timers, heartbeats
   and a lone `completion_ready` signal gave false stalls; the dependable tiebreaker was the live output tail.
   Require all liveness channels to be silent before acting.

## Evidence

| Claim | Number | Source |
|---|---|---|
| Value is decodable but the policy ignores it | probe right on 34.2-58.3% of Grid states where the policy chose worse | 2611.10457 |
| A learned value-to-hidden map helped; direction steering did not | Grid success 0.140 to 0.300 | 2611.10457 |
| Discovery scores do not predict intervention | gradient attribution 91-97% sign match vs probes 17-35% | 2610.15850 |
| Steering direction can be injectable but not necessary | injection changes 3.8% of actions; removal 1.8% at base, 19.3% after RL | 2609.22850 |
| Probe-direction steering null; layer patching works | 0 change at all magnitudes; +0.37 with patching | 2609.29848 |
| SAE attribution is a weak causal guide | importance faithfulness rho about 0.26; deletions AUROC 0.520 | 2610.17898 |
| Gated SAE clamping works on benchmarks | WMDP-Bio 29.64% vs RMU 50%, MMLU about 99% kept | 2504.08192 |
| CoT monitoring can be trained away | CoT detection near 0% on held-out tasks | 2601.23086 |

## Anti-patterns

- Shipping a probe because its accuracy is high, with no ablation or patch test.
- Steering with a vector validated only on MMLU or one harm benchmark.
- Calling a detector done because synthetic tests pass.
- Assuming a hosted model can be probed.
- Treating "no probe baseline" as "output checks are enough": no note compares the two on one agent task.

## Gaps

No KB note gives a false-positive rate for an internal-signal gate on benign agent traffic, a calibration
protocol, probe-predicted tool-call failure on an agent benchmark, or the GPU cost of steering vs LoRA on
one task. Report: `agentic-capability-reports/notes/2026-11-14-white-box-probes-steering-vs-output-checks-for-agents.md`.
