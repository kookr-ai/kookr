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
   the direction moves behavior but removing it does not, the direction is a correlate (one probe was
   right on ~34-58% of states where the policy still chose worse).
3. **Probe the trajectory, pool with max.** Final-token probes missed 28-36% of jailbreaks; a trajectory
   readout recovered 97-98% of the misses. Average pooling collapsed to random while max-pooling reached
   AUROC 94-97%.
4. **Test off-distribution before trusting a number.** Static and persona-subspace probes degraded or
   generalized only partly out of distribution.
5. **Measure side effects of steering on neighbours, not on MMLU or one harm benchmark.** A steering
   vector from one narrow task lifted misaligned-answer probability from ~0% to 23-35%; a jailbreak
   repair kept MMLU within 0.1 point yet lost 26 benign-preservation points. Side effects follow the
   model's defaults, not vector geometry.
6. **Do not store facts in a steering vector (one small-model study).** Facts were used cleanly at most
   15% of the time vs 96-98% in context. Use steering for dispositions at most.
7. **Keep an output-level check as the tiebreaker.** Never let a probe alone kill, accept or merge work.
   But no study compares probes with output checks on one agent task, so don't assume output checks
   suffice. Reasoning-text monitors are weak too: [latent vs text](latent-vs-text-agent-design.md)
   (**Gate on checks**) and [closed-model agent monitoring](closed-model-agent-monitoring.md).
8. **Validate any detector on real captured runs; synthetic tests passing is not done.** In local runs a
   pane-state detector passed all synthetic fixtures and failed on live raw bytes, and a reaper killed a
   finished session. Silence timers, heartbeats and a lone `completion_ready` signal gave false stalls;
   the dependable tiebreaker was the live output tail. Require all liveness channels to be silent before
   acting (heartbeat semantics: `automation-design`, `autonomous-watch-loop`).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-white-box-probes-steering-vs-output-checks-for-agents.md
