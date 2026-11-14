# Latent vs text agent design

Use when: someone proposes latent reasoning, latent or KV-cache handoffs, looped / recurrent-depth
models or a diffusion language model (dLLM) for an agent fleet, or when shrinking the cost of
inter-agent handoffs.

Default for hosted Claude-class fleets: keep reasoning and handoffs as text, shrink them at the text
level, gate on checked outputs. For open-weight fleets the latent gains are narrow and unreplicated.

## Rules

1. **Check access before reading further.** Every latent method surveyed needs model internals, and most
   need training. A hosted API exposes no hidden states, so a latent-handoff project for a hosted fleet
   is a non-starter.
2. **Revisit only for self-hosted open-weight fleets of one model family, with a measured bottleneck**
   (serial text decoding between agents). Run a token-matched text baseline first.
3. **Vet every latent claim with five questions:** trained, and on whose weights? Compared with a tuned
   text method at the same token budget? On a task like yours (logic, arithmetic or agentic)? Replicated
   on a second backbone? Checked that the latent state is actually used? Quote no token-saving or
   speedup figure without its token-matched text baseline.
4. **Keep handoffs as text artifacts** (files, structured reports with verbatim quotes), not narrative
   prose. Real failures were a lead cutting off the end of a worker's message and a successor skipping
   the handoff file; both are discipline fixes, not medium problems.
5. **Shrink handoffs at the text level and measure accuracy with tokens**; never compress context with
   no accuracy check (the best measured summarizer lost ~4 points). Retrieved reasoning "skill cards"
   cut thinking tokens 21-59% on math, though one open model gained accuracy at slightly more tokens
   (non-Claude models). Summarizer and prefix-stability evidence: `token-efficiency`.
6. **Gate on checks, never on reading the reasoning.** Visible reasoning is evidence, not proof.
   Penalizing outputs taught models to hide hacking (hacking stayed near 100% while CoT detection fell to
   near 0%). Do not train against a reasoning monitor or treat it as a safety control. Forged reasoning
   raised agent exfiltration from 0-2% to 56-70%: treat reasoning text as untrusted input.
7. **Do not add loops or thinking budget blindly.** A looped 7B coder peaked at two loops (43% to 64% on
   SWE-bench Verified, then 28% and 22% at three and four). For thinking-length peaks see [inference
   budget allocation](inference-budget-allocation.md) (**Cap thinking per attempt**).

## Diffusion decoders (dLLMs)

For a closed-weight fleet, not worth planning around as an agent backbone; rule 1 extends to them.

8. **Do not change decoder or model family to save money until you have split a real run's cost.** In the
   author's runs agent sessions were ~96% cache-read tokens and ~1% output, so a faster decoder
   addresses a small share of the bill. Measure cache-read, cache-write, output and tool-wait first
   ([agent inference efficiency](agent-inference-efficiency.md)).
9. **Read "Nx faster" as tokens per forward pass (TPF), not latency.** dLLM speed figures are TPF, mostly
   against vanilla dLLM decoding (1.8-8.5x; up to ~8x for an AR model with a diffusion head, needing
   custom kernels). None gives wall-clock tokens per second, batch above 1 or long context, so adopt
   none without a same-hardware tokens-per-second comparison against a tuned AR baseline.
10. **The dLLM is not the agent.** In every surveyed agent system using diffusion, the diffusion part is a
    separate generator (topology design, trajectory planning, a world model). No dLLM has been run as a
    tool-calling or multi-turn agent.
11. **Borrow the repair idea, but verify it.** Constraint correction inside denoising edited a median of
    12-35 tokens where AR re-prompting regenerated 98-123. With an API model, ask for a targeted diff on
    the violated lines; this is untested on AR models.
12. **Assume attackers use dLLMs.** A dLLM attacker reached 100% attack success on three open models and
    53% transfer to ChatGPT-5 vs 13% for best-of-N. Do not rely on perplexity or prefix filters alone
    (see [untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md)).
13. **Keep the monitor on a text-reasoning model**: chain-of-thought monitorability under parallel or
    any-order decoding is unmeasured.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-latent-reasoning-and-handoffs-vs-text-for-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-diffusion-llm-vs-autoregressive-agent-backbone.md
