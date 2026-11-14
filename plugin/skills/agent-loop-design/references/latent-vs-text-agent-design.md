---
name: latent-vs-text-agent-design
group: design-analysis
description: >
  Decide whether an agent system should reason or hand work between agents in latent form (continuous
  thought tokens, looped depth, KV-cache or hidden-state messages) or keep everything as readable text.
  Covers why latent methods are out of reach for closed-weight API models, what the measured gains are
  and how narrow they are, the five questions that vet any latent-method claim, why visible reasoning
  is a weak but real oversight signal that you should not train against or trust as a security
  boundary, and the text-level levers that do work on API models (compact artifacts, context compression,
  prefix-stable prompts). Use when someone proposes latent reasoning, latent or KV-cache handoffs,
  looped or recurrent-depth models for an agent fleet, or when shrinking the cost of inter-agent handoffs.
keywords: latent reasoning, continuous thought, Coconut, soft thinking, looped transformer, recurrent depth, KV cache sharing, latent communication, hidden-state handoff, multi-agent handoff, chain of thought monitorability, CoT faithfulness, token savings, closed-weight, API model, context compression
related: agent-fleet-orchestration, token-efficiency, independent-merge-review, automation-design
---

# Latent vs text agent design

## The idea

Latent methods move reasoning or messages out of readable tokens and into hidden states. For a fleet of
hosted Claude-class models that is not an option, and for open-weight fleets the measured gains are
narrow and unreplicated. For an API builder the default is therefore clear: keep reasoning and
handoffs as text, shrink them at the text level, and gate on checked outputs. This skill is what to say
and do when latent methods come up, with the numbers behind it.

## Rules

1. **Check access before reading further.** Every latent method in the local KB needs model internals,
   and eight of the nine read needed training (SFT+RL, LoRA on KV caches, a trained head, pre-training from
   scratch). The ninth passes KV caches between two driving models. A hosted API exposes no hidden
   states, so none of this can be applied to it. (That access requirement is read from the method
   descriptions; no paper states it as a rule.)
2. **Revisit only for self-hosted open-weight fleets of one model family, with a measured bottleneck.**
   The case is serial text decoding between agents. Start from the two handoff papers (2604.21794,
   2605.22504) and run a token-matched text baseline first.
3. **Vet every latent claim with five questions:** trained, and on whose weights? Compared with a tuned text
   method at the same token budget? On a task like yours (logic, arithmetic or agentic)? Replicated on a
   second backbone? Checked that the latent state is actually used?
4. **Keep handoffs as text artifacts** (files, structured reports with verbatim quotes), not
   narrative prose. Real-run failures were a lead cutting off the end of a worker's message and a successor
   skipping the handoff file; both are discipline fixes, not medium problems.
5. **Shrink handoffs at the text level and measure accuracy with tokens.** A trained 2B context summarizer
   cut input from 2.83M to 591K tokens and cost fell about 78% on DeepSearchQA while F1 went 0.52 to 0.48
   (2611.06445); retrieved reasoning "skill cards" cut thinking tokens 20.6-59.1% with accuracy +1.8% on
   math with one model, but one open model went +4.1% accuracy at +1.9% tokens (2604.21764). Prefix-stable prompts cost $2.79 vs $7.24
   at 81.3 vs 79.2 score on one benchmark (2606.17016). These were measured on non-Claude models.
6. **Gate on checks, never on reading the reasoning.** Visible reasoning is evidence, not proof. Penalizing
   outputs taught Qwen3 models to hide hacking: hacking stayed near 100% while CoT detection fell to near
   0% on held-out tasks (2601.23086). Do not train against a reasoning monitor. Forged reasoning raised
   agent exfiltration from 0-2% to 56-70% (2603.12277): treat reasoning text as untrusted input.
7. **Do not add loops or thinking budget blindly.** A looped 7B coder peaked at two loops (SWE-bench Verified
   43.0% to 64.4%, then 27.6% and 22.4% with three and four; 2606.18023); reasoning accuracy peaks near
   1.5K tokens on easy problems and 8K on hard ones (2604.10739).

## Evidence in brief

| Claim | Number | Source | Limit |
|---|---|---|---|
| Latent CoT saves tokens at small accuracy cost | 11.6x fewer tokens, MATH-500 90.8% vs 92.6% | 2604.22709 | needs SFT+RL |
| Savings are not automatic | visible tokens 1,733 to 1,721 by default | 2606.13106 | brevity bonus gives 1,276 |
| Latent chains can be placeholders | deleting changed at most 3 of 300 answers (logic) | 2610.21182 | arithmetic used the chain (0.333 to 0.103); GPT-2 and 1B only |
| Latent handoff cuts latency | about 20x (382 vs 1,300 ms) | 2605.22504 | two-vehicle driving, not LLM agents |
| Latent handoff lifts accuracy | AIME24 50.0% to 76.7% | 2604.21794 | against a single agent; needs LoRA |

## Anti-patterns

- Planning a latent-handoff project for a hosted-model fleet.
- Quoting a token-saving or speedup figure without asking for the token-matched text baseline.
- Treating a reasoning monitor as a safety control, or training against it.
- Compressing agent context with no accuracy check; the best measured summarizer lost about 4 points.

## Gaps

No compute-matched latent-vs-text comparison, no token counts for latent versus text multi-agent
communication, no monitor result on latent messages, no prompt-only thinking-budget measurement on
accuracy and tokens together, and no measurement of how much detail a worker summary loses. Source report:
`agentic-capability-reports/notes/2026-11-14-latent-reasoning-and-handoffs-vs-text-for-agents.md`.
