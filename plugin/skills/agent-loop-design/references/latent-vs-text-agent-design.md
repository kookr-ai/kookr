# Latent vs text agent design

Use when: someone proposes latent reasoning, latent or KV-cache handoffs, looped / recurrent-depth
models or a diffusion language model (dLLM) for an agent fleet, or when shrinking the cost of
inter-agent handoffs.

Default for hosted Claude-class fleets: keep reasoning and handoffs as text, shrink them at the text
level, gate on checked outputs. For open-weight fleets the latent gains are narrow and unreplicated.

## Rules

1. **Check access before reading further.** Every latent method surveyed needs model internals, and
   eight of the nine needed training (SFT+RL, LoRA on KV caches, a trained head, pre-training from
   scratch); the ninth passes KV caches between two driving models. A hosted API exposes no hidden
   states, so none of this applies to it, and a latent-handoff project for a hosted fleet is a
   non-starter. (The access requirement is read from the method descriptions; no paper states it.)
2. **Revisit only for self-hosted open-weight fleets of one model family, with a measured bottleneck.**
   The case is serial text decoding between agents. Start from the two handoff papers (2604.21794,
   2605.22504) and run a token-matched text baseline first.
3. **Vet every latent claim with five questions:** trained, and on whose weights? Compared with a tuned
   text method at the same token budget? On a task like yours (logic, arithmetic or agentic)? Replicated
   on a second backbone? Checked that the latent state is actually used? Quote no token-saving or
   speedup figure without its token-matched text baseline.
4. **Keep handoffs as text artifacts** (files, structured reports with verbatim quotes), not narrative
   prose. Real-run failures were a lead cutting off the end of a worker's message and a successor
   skipping the handoff file; both are discipline fixes, not medium problems.
5. **Shrink handoffs at the text level and measure accuracy with tokens**; never compress context with
   no accuracy check (the best measured summarizer lost about 4 points). Retrieved reasoning "skill
   cards" cut thinking tokens 20.6-59.1% with accuracy +1.8% on math with one model, but one open model
   went +4.1% accuracy at +1.9% tokens (2604.21764). Measured on non-Claude models. For summarizer and
   prefix-stability evidence (2611.06445, 2606.17016) see the `token-efficiency` skill.
6. **Gate on checks, never on reading the reasoning.** Visible reasoning is evidence, not proof.
   Penalizing outputs taught Qwen3 models to hide hacking: hacking stayed near 100% while CoT detection
   fell to near 0% on held-out tasks (2601.23086). Do not train against a reasoning monitor or treat it
   as a safety control. Forged reasoning raised agent exfiltration from 0-2% to 56-70% (2603.12277):
   treat reasoning text as untrusted input.
7. **Do not add loops or thinking budget blindly.** A looped 7B coder peaked at two loops (SWE-bench
   Verified 43.0% to 64.4%, then 27.6% and 22.4% with three and four; 2606.18023). For thinking-length
   peaks see [inference budget allocation](inference-budget-allocation.md) rule 3.

## Diffusion decoders (dLLMs)

For a closed-weight fleet, not worth planning around as an agent backbone; rule 1 extends to them.

8. **Do not change decoder or model family to save money until you have split a real run's cost.** In
   the author's runs agent sessions were about 96% cache-read tokens and about 1% output tokens, so a
   faster decoder addresses a small share of the bill. Measure cache-read, cache-write, output and
   tool-wait first ([agent inference efficiency](agent-inference-efficiency.md)).
9. **Read "Nx faster" as tokens per forward pass (TPF), not latency.** dLLM speed figures are TPF, mostly
   against vanilla dLLM decoding: cluster-level parallel commit 1.77x-8.47x (2605.29607), parallel
   speculative decoding up to 5.5x TPF (2605.15609). The only AR baseline is an AR model with a
   diffusion head, up to 7.8x, which needs custom kernels (2605.12825). No surveyed paper gives
   wall-clock tokens per second, batch above 1 or long context, so adopt none without a same-hardware
   tokens-per-second comparison against a tuned AR baseline.
10. **The dLLM is not the agent.** In every surveyed agent system using diffusion, the diffusion part is a
    separate generator (topology design 2510.07799, trajectory planning 2605.16863, offline-evaluation
    world model 2606.05558). No dLLM has been run as a tool-calling or multi-turn agent, and a
    non-diffusion topology prior got similar gains (2605.17359).
11. **Borrow the repair idea, but verify it.** Constraint correction inside denoising edited a median of
    12 to 35 tokens where AR re-prompting regenerated 98 to 123 (2605.16829). With an API model, ask for
    a targeted diff on the violated lines; this is untested on AR models.
12. **Assume attackers use dLLMs.** A dLLM attacker reached 100% attack success on three open models and
    53% transfer to ChatGPT-5 vs 13% for best-of-N (2511.00203); another reached 87.50% under Llama Guard
    (2606.15531). Do not rely on perplexity or prefix filters alone (see [untrusted-content
    defense](../../agent-safety/references/untrusted-content-defense.md)).
13. **Keep the monitor on a text-reasoning model**: chain-of-thought monitorability under parallel or
    any-order decoding is unmeasured.

## Evidence in brief

| Claim | Number | Source | Limit |
|---|---|---|---|
| Latent CoT saves tokens at small accuracy cost | 11.6x fewer tokens, MATH-500 90.8% vs 92.6% | 2604.22709 | needs SFT+RL |
| Savings are not automatic | visible tokens 1,733 to 1,721 by default | 2606.13106 | brevity bonus gives 1,276 |
| Latent chains can be placeholders | deleting changed at most 3 of 300 answers (logic) | 2610.21182 | arithmetic used the chain (0.333 to 0.103); GPT-2 and 1B only |
| Latent handoff cuts latency | about 20x (382 vs 1,300 ms) | 2605.22504 | two-vehicle driving, not LLM agents |
| Latent handoff lifts accuracy | AIME24 50.0% to 76.7% | 2604.21794 | against a single agent; needs LoRA |

## Gaps (not found in the surveyed literature)

- No compute-matched latent-vs-text comparison; no token counts for latent vs text multi-agent messages.
- No monitor result on latent messages.
- No prompt-only thinking-budget measurement on accuracy and tokens together.
- No measurement of how much detail a worker summary loses.
- No dLLM serving, KV-cache or long-context measurements; no dLLM agent benchmark; no CoT
  monitorability result under parallel or any-order decoding.
