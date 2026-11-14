---
name: agent-inference-efficiency
group: meta-workflow
description: >
  Pick which inference-efficiency levers to pull to make an agent loop cheaper or faster, starting from who
  owns the serving stack. On a hosted API the only levers are a byte-stable prompt prefix (prompt-cache
  hits) and fewer tokens (less carried context, adaptive reasoning effort, fewer model calls). On
  self-hosted or local models, add server prefix caching, speculative decoding and KV-cache quantization,
  and treat KV eviction and weight quantization as unproven for agents. Covers the measured effect of each
  lever, the conditions where it backfires, and why cost per solved task, not tokens per second, is the
  scoreboard. Use when an agent run is too slow or too expensive, when choosing llama.cpp / vLLM / SGLang
  serving options for an agent, or before trusting an efficiency claim made on a perplexity or LongBench
  result.
keywords: inference efficiency, prompt caching, cache hit rate, prefix stability, KV cache, KV eviction, KV quantization, quantization, speculative decoding, MTP, batch size, prefix caching, llama.cpp, vLLM, SGLang, latency, cost per task, token reduction, reasoning effort, thinking tokens, local model
related: token-efficiency, agent-fleet-orchestration
---

# Agent inference efficiency

## The idea

An agent loop costs roughly **context size times turns**. In the operator's own run telemetry (a local
analysis of agent sessions, in the `agent-task-lessons` KB), about 96% of the tokens a loop consumed were
cache reads and 1% were output. So the cheapest wins come from the loop, not the server, and which levers
you may pull depends on who runs the model. Decide that first.

## Step 1: who owns the serving stack?

| You | Levers you have |
|---|---|
| Call a hosted API (Claude API, Claude Code) | Byte-stable prefix, fewer tokens, effort and model choice. Nothing else. |
| Run the model (llama.cpp, vLLM, SGLang, Ollama) | All of the above, plus server prefix caching, speculative decoding, KV quantization. KV eviction and weight quantization have no agent-level evidence; try them only with your own agent benchmark. |

On a hosted API, do Steps 2, 3 and 5 and skip Step 4: you cannot set those knobs.

## Step 2: make the prefix byte-stable (hosted and local)

A cache matches a prefix, so any change early in the prompt invalidates everything after it. Keep the
system prompt and tool list frozen and in a fixed order, keep history append-only, and put timestamps and
IDs after the last cache breakpoint. Check cache-read tokens per call.

- On the PinchBench agent benchmark, prefix stabilization raised the prompt-cache hit rate from 38.7% to
  79.2%. The full system (it also evicts stale context, so not all of the saving is prefix work) cut cost
  61% ($7.24 to $2.79) while the benchmark score went from 79.2 to 81.3, and cut cost 87% on Claw-Eval
  ($81.52 to $10.58) (2606.17016). One framework, two benchmarks.
- A lead session mostly pays for its fixed context re-read each turn, and 1-hour cache writes bill at 2x
  the base input price (operator run notes, `agent-task-lessons` KB).

## Step 3: cut tokens before touching the server

- **Thinking tokens and turn count decide price.** In 32% of model pairs the cheaper-listed model cost
  more, by up to 28x. Over 95% of single-turn cost gaps came from thinking tokens; multi-turn gaps came
  from turn count and cached tokens (2603.23971).
- **Adaptive effort beats a fixed low effort.** Adaptive effort cut reasoning tokens 35.2% to 52.7% at
  matched or better accuracy; static low effort degraded results (2603.07915).
- **Fewer model calls in the agent's own control logic** (deciding the next step, recovering from errors).
  One study made 93% fewer such calls than ReAct (9 vs 123) across 19 scenarios (2603.01548).
- In one study, savings shrank with a stronger model: learned context pruning saved 30.5% of tokens with
  Sonnet 4.5 but 3.0% with Opus 4.6 (2605.15315). Measure on your own model.

## Step 4: self-hosted levers, in order of risk

1. **Server prefix caching: keep it on, know the cost.** On a multi-turn tool-use benchmark (BFCL), the
   output of a cache-hit run and a recompute run diverged (different generated text) in 36.2% to 91.2% of
   episodes, and more with quantization (37.4% at F16 to 82.5% at Q4_K_M, two llama.cpp weight formats).
   Accuracy did not move on GSM8K (a single-turn math set; +0.46 points, 95% CI -0.15 to +1.15), so this
   is a reproducibility hazard, and the study did not measure agent success. Turning the server cache off
   cost about 5% latency per request (0.290 to 0.305 s); recomputing everything took 0.871 s per request
   (2609.04748). Turn it off for A/B comparisons and audits.
2. **Speculative decoding (a small draft model proposes tokens that the main model verifies): re-measure
   at your batch size.** A commerce agent got 22% to 49% throughput and 18% to 33% latency gains
   (2604.19767). Gains shrink with load: Qwen3-Coder-Next 1.51x, 1.23x, 0.94x at batch 1, 8, 32
   (2602.06932). Acceptance of drafted tokens decays on long outputs (2605.09329). Locally, multi-token
   prediction (MTP) on Gemma-4 E4B in llama.cpp gave about 1.9x to 2.0x faster decode and about 1.3x end
   to end; the text differs slightly from a run without it (operator run notes, `operating-environment`
   KB).
3. **KV quantization (store the attention cache at fewer bits): only with an agent result for your
   model.** TriAxialKV mixed precision stayed within 1.1 points of BF16 on BFCL Memory and within 1.8 on
   OSWorld, with 4.5x less KV memory and 1.26x to 1.52x throughput; uniform SGLang FP4 lost 4 to 5 points.
   It needs calibration and an SGLang fork (2605.17170).
4. **KV eviction (drop cached tokens to save memory): avoid on multi-turn agents.** Unprotected eviction at
   13% retention scored F1 of 0.064 or less; reserving 10% of the cache at each end (the prompt-boundary
   tokens) recovered 69% to 90% of full-cache F1 (2605.18053). At small budgets all seven mechanisms
   tested failed (2605.14292). Eviction drops instructions unevenly (2510.00231) and raised jailbreak
   success from 0.299 to 0.632 for one method (2606.17872).
5. **Weight quantization: do not trust aggregate scores.** 4-bit NF4 weights fell from 81.0% to 68.3% on a
   test where earlier facts are overwritten by later ones, while aggregate accuracy moved only 1 to 2
   points (2608.18578).

## Step 5: judge by cost per solved task

Tokens per second misleads. One method cut output tokens up to 70% but wall-clock only about 35%
(2605.01111), and diffusion-decoding "5x" claims are often tokens per forward pass, not latency (see
2605.15609). Compare dollars and seconds per solved task on your own tasks. When you compare serving
throughput, switch warm-cache features off, or cache reuse inflates tokens per second; keep them on in
production.

## Anti-patterns

- Accepting a perplexity, MMLU, LongBench or GSM8K result (all single-turn or non-agent scores) as proof an agent keeps its success rate.
- Quoting a speculative-decoding speedup measured at batch 1 for a loaded server.
- Editing the early prompt (a timestamp, a tool list reorder) and wondering why cache hits fell.
- Using KV eviction on a multi-turn agent without protecting prompt-boundary tokens.

## Gaps (no evidence found)

Cost per solved task for any lever; multi-turn tests of KV eviction; 4-bit weight quantization measured on
agent success; speculative decoding on structured tool-call JSON; what invalidates a provider prompt cache;
a head-to-head comparison of these levers on one workload.

Full report and citations: `agentic-capability-reports` KB,
`notes/2026-11-14-agent-loop-serving-levers-cost-vs-accuracy.md`.
