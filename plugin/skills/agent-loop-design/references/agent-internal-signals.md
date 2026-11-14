# Agent internal signals

Use when: someone proposes linear probes, activation steering vectors or SAE features to monitor or
steer an agent, when designing a stuck or drift detector, or when choosing between white-box and
black-box (tests, fresh-context judge, live output text) monitoring.

A probe that reads a property from hidden states does not show the model uses it to act, nor that
pushing it changes behavior as wanted: treat probes and steering vectors as hypotheses until an
intervention test supports them.

## Rules

1. **Check access first.** Probes, steering and SAE features need activations; a hosted Claude-class
   model exposes none. For those agents use output-level checks only: tests, a fresh-context verifier,
   live output text ([closed-model agent monitoring](closed-model-agent-monitoring.md)). Reach for
   internal signals only for open-weight models you host.
2. **Do not gate on probe accuracy alone.** Run an intervention test: ablate, patch or steer along the
   direction and check that behavior changes as predicted, with a random-direction control. If injecting
   the direction moves behavior but removing it does not, the direction is a correlate.
3. **Probe the trajectory, pool with max.** Final-token probes missed 27.8%-36.4% of jailbreaks across
   three 7-8B models, and a trajectory readout recovered 97.0%-98.1% of the misses (2605.12726). Average
   pooling collapsed to random while max-pooling reached AUROC 94-97% on harmfulness detection
   (2605.18549).
4. **Test off-distribution before trusting a number.** Static probes degraded on an out-of-distribution
   set (2605.18549) and persona-subspace probes generalized only partly (2605.09391).
5. **Measure side effects of steering on neighbours, not on MMLU or one harm benchmark.** A steering
   vector from one narrow task lifted misaligned-answer probability from about 0% to 23-35% on
   Qwen3.5-27B (2606.08682). A jailbreak repair kept MMLU within 0.07 points yet lost 26.3
   benign-preservation points (2610.10276). Side effects follow the model's defaults, not vector
   geometry: geometry predicted at most about 15% of interference (2609.06951).
6. **Do not store facts in a steering vector (one small-model study).** Facts were used cleanly at most
   15% of the time vs 96-98% when placed in context (2610.14958). Use steering for dispositions at most.
7. **Keep an output-level check as the tiebreaker.** Never let a probe alone kill, accept or merge work.
   But no surveyed study compares probes with output checks on one agent task, so don't assume output
   checks suffice. Reasoning-text monitors are weak too: [latent vs
   text](latent-vs-text-agent-design.md) rule 6 and [closed-model agent
   monitoring](closed-model-agent-monitoring.md).
8. **Validate any detector on real captured runs; synthetic tests passing is not done.** In local runs a
   pane-state detector passed all synthetic fixtures and failed on live raw bytes, and a reaper killed a
   finished session. Silence timers, heartbeats and a lone `completion_ready` signal gave false stalls;
   the dependable tiebreaker was the live output tail. Require all liveness channels to be silent before
   acting. (For heartbeat semantics in supervisors see `automation-design` and `autonomous-watch-loop`.)

## Evidence

| Claim | Number | Source |
|---|---|---|
| Value is decodable but the policy ignores it | probe right on 34.2-58.3% of Grid states where the policy chose worse | 2611.10457 |
| Discovery scores do not predict intervention | gradient attribution 91-97% sign match vs probes 17-35% | 2610.15850 |
| Steering direction can be injectable but not necessary | injection changes 3.8% of actions; removal 1.8% at base, 19.3% after RL | 2609.22850 |
| Probe-direction steering null; layer patching works | 0 change at all magnitudes; +0.37 with patching | 2609.29848 |
| SAE attribution is a weak causal guide | importance faithfulness rho about 0.26; deletions AUROC 0.520 | 2610.17898 |
| Gated SAE clamping works on benchmarks | WMDP-Bio 29.64% vs RMU 50%, MMLU about 99% kept | 2504.08192 |

## Gaps (not found in the surveyed literature)

- No false-positive rate for an internal-signal gate on benign agent traffic; no calibration protocol.
- No probe-predicted tool-call failure on an agent benchmark.
- No GPU cost of steering vs LoRA on one task.
