# Agent inference efficiency

Use when: an agent run is too slow or too expensive, when choosing llama.cpp / vLLM / SGLang serving
options for an agent, or before trusting an efficiency claim made on a perplexity or LongBench result.

An agent loop costs roughly **context size times turns**, so the cheapest wins come from the loop, not
the server, and which levers you may pull depends on who runs the model. To spend *more* compute for a
better answer instead, see [inference budget allocation](inference-budget-allocation.md).

## Step 1: who owns the serving stack?

| You | Levers you have |
|---|---|
| Call a hosted API (Claude API, Claude Code) | Byte-stable prefix, fewer tokens, effort and model choice. Nothing else. Do Steps 2, 3 and 5; skip Step 4. |
| Run the model (llama.cpp, vLLM, SGLang, Ollama) | All of the above, plus server prefix caching, speculative decoding, KV quantization. KV eviction and weight quantization have no agent-level evidence; try them only with your own agent benchmark. |

## Step 2: make the prefix byte-stable (hosted and local)

Any change early in the prompt (a timestamp, a tool-list reorder) invalidates the cache after it. Keep
the system prompt and tool list frozen and in a fixed order, keep history append-only, and put
timestamps and IDs after the last cache breakpoint. Check cache-read tokens per call. Evidence:
"Long-session context policy" in the `token-efficiency` skill; cache-write pricing in
`agent-fleet-orchestration`.

## Step 3: cut tokens before touching the server

- **Thinking tokens and turn count decide price.** In 32% of model pairs the cheaper-listed model cost
  more, by up to 28x. Over 95% of single-turn cost gaps came from thinking tokens; multi-turn gaps came
  from turn count and cached tokens (2603.23971).
- **Adaptive effort beats a fixed low effort** (evidence in [inference budget
  allocation](inference-budget-allocation.md) rule 5).
- **Fewer model calls in the agent's own control logic** (deciding the next step, recovering from
  errors): one study made 93% fewer such calls than ReAct (9 vs 123) across 19 scenarios, mock tools
  only (2603.01548).
- Context-pruning savings can shrink with a stronger model (see `token-efficiency`); measure on yours.

## Step 4: self-hosted levers, in order of risk

1. **Server prefix caching: keep it on, know the cost.** On BFCL (multi-turn tool use), cache-hit and
   recompute runs generated different text in 36.2% to 91.2% of episodes, more with quantization (37.4%
   at F16 to 82.5% at Q4_K_M). GSM8K accuracy did not move (single-turn; +0.46 points, 95% CI -0.15 to
   +1.15), so this is a reproducibility hazard; agent success was not measured. Turning the server cache
   off cost about 5% latency per request (0.290 to 0.305 s); recomputing everything took 0.871 s
   (2609.04748). Turn it off for A/B comparisons and audits.
2. **Speculative decoding (a small draft model proposes tokens the main model verifies): re-measure at
   your batch size**; a batch-1 speedup does not hold on a loaded server. Qwen3-Coder-Next got 1.51x,
   1.23x, 0.94x at batch 1, 8, 32 (2602.06932). Acceptance of drafted tokens decays on long outputs
   (2605.09329). Locally, multi-token prediction (MTP) on Gemma-4 E4B in llama.cpp gave about 1.9x to
   2.0x faster decode and about 1.3x end to end, with slightly different text (operator run notes).
3. **KV quantization (store the attention cache at fewer bits): only with an agent result for your
   model.** TriAxialKV mixed precision stayed within 1.1 points of BF16 on BFCL Memory and 1.8 on
   OSWorld, with 4.5x less KV memory and 1.26x to 1.52x throughput; uniform SGLang FP4 lost 4 to 5
   points. It needs calibration and an SGLang fork (2605.17170).
4. **KV eviction (drop cached tokens to save memory): avoid on multi-turn agents, and never without
   protecting prompt-boundary tokens.** Unprotected eviction at 13% retention scored F1 of 0.064 or
   less; reserving 10% of the cache at each end recovered 69% to 90% of full-cache F1 (2605.18053). At
   small budgets all seven mechanisms tested failed (2605.14292). Eviction raised jailbreak success from
   0.299 to 0.632 for one method (2606.17872).
5. **Weight quantization: do not trust aggregate scores.** 4-bit NF4 weights fell from 81.0% to 68.3% on
   a test where earlier facts are overwritten by later ones, while aggregate accuracy moved only 1 to 2
   points (2608.18578).

## Step 5: judge by cost per solved task

Tokens per second misleads: one method cut output tokens up to 70% but wall-clock only about 35%
(2605.01111), and diffusion-decoding "5x" claims are often tokens per forward pass, not latency (see
2605.15609). Perplexity, MMLU, LongBench and GSM8K are single-turn or non-agent scores and do not show
an agent keeps its success rate. Compare dollars and seconds per solved task on your own tasks. When
benchmarking serving throughput, switch warm-cache features off (cache reuse inflates tokens per
second); keep them on in production.

## Gaps (no evidence found)

- Cost per solved task for any lever; a head-to-head comparison of these levers on one workload.
- Multi-turn tests of KV eviction; 4-bit weight quantization measured on agent success.
- Speculative decoding on structured tool-call JSON; what invalidates a provider prompt cache.
