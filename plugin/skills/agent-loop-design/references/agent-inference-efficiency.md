# Agent inference efficiency

Use when: an agent run is too slow or too expensive, when choosing llama.cpp / vLLM / SGLang serving
options for an agent, or before trusting an efficiency claim made on a perplexity or LongBench result.

An agent loop costs roughly **context size times turns**, so the cheapest wins come from the loop, not
the server. To spend *more* compute for a better answer instead, see [inference budget
allocation](inference-budget-allocation.md).

## Step 1: who owns the serving stack?

| You | Levers you have |
|---|---|
| Call a hosted API (Claude API, Claude Code) | Byte-stable prefix, fewer tokens, effort and model choice. Nothing else. Do Steps 2, 3 and 5; skip Step 4. |
| Run the model (llama.cpp, vLLM, SGLang, Ollama) | All of the above, plus server prefix caching, speculative decoding, KV quantization. KV eviction and weight quantization have no agent-level evidence; try them only with your own agent benchmark. |

## Step 2: make the prefix byte-stable (hosted and local)

Any change early in the prompt (a timestamp, a tool-list reorder) invalidates the cache after it. Keep
the system prompt and tool list frozen and in a fixed order, keep history append-only, and put
timestamps and IDs after the last cache breakpoint. Check cache-read tokens per call. See "Long-session
context policy" in `token-efficiency`; cache-write pricing in `claude-api`.

## Step 3: cut tokens before touching the server

- **Thinking tokens and turn count decide price.** In a third of model pairs the cheaper-listed model
  cost more, by up to 28x. Single-turn gaps came from thinking tokens; multi-turn gaps from turn count
  and cached tokens.
- **Measure the spend split before cutting reasoning.** In the author's runs agentic loops were ~96%
  cache reads and ~1% output, so a reasoning cut barely moves the bill there; it pays in single-turn
  calls and in subagents with small context.
- **Tune effort per route and per step, never one global cap.** Adaptive effort beats a fixed low effort,
  and the best thinking length differs by difficulty (see [inference budget
  allocation](inference-budget-allocation.md)).
- **Test any cap or early exit on the hardest 20% of tasks.** Headlines hide hard-item losses: one
  method reported "no degradation" yet lost 6 points on a hard benchmark.
- **Don't strip reasoning between tool calls without an A/B on your own tasks.** Per-step deliberation
  can also hurt (about 2x tokens, worse return), so the answer is selective, not blanket.
- **Fewer model calls in the agent's own control logic** (deciding the next step, recovering from
  errors): one mock-tool study made 93% fewer such calls than ReAct.
- Context-pruning savings can shrink with a stronger model (`token-efficiency`); measure on yours.

## Step 4: self-hosted levers, in order of risk

1. **Server prefix caching: keep it on, know the cost.** Cache-hit and recompute runs generated different
   text in 36-91% of multi-turn tool-use episodes, more under quantization. Single-turn accuracy did not
   move, so this is a reproducibility hazard; agent success was not measured. Turning the cache off cost
   ~5% latency per request; recomputing everything was ~3x slower. Turn it off for A/B comparisons and
   audits.
2. **Speculative decoding (a small draft model proposes tokens the main model verifies): re-measure at
   your batch size**; a batch-1 speedup does not hold on a loaded server (1.5x at batch 1, 0.9x at 32 in
   one test), and draft acceptance decays on long outputs. Locally, multi-token prediction in llama.cpp
   gave ~2x decode and ~1.3x end to end, with slightly different text.
3. **KV quantization (store the attention cache at fewer bits): only with an agent result for your
   model.** Mixed precision stayed within ~1-2 points of BF16 with 4.5x less KV memory; uniform FP4 lost
   4-5 points. It needs calibration and a forked SGLang.
4. **KV eviction (drop cached tokens to save memory): avoid on multi-turn agents, and never without
   protecting prompt-boundary tokens.** Unprotected eviction at 13% retention was near-useless; reserving
   10% of the cache at each end recovered 69-90% of full-cache F1. At small budgets all seven tested
   mechanisms failed, and eviction raised jailbreak success for one method.
5. **Weight quantization: do not trust aggregate scores.** 4-bit weights fell from 81% to 68% on a test
   where later facts overwrite earlier ones, while aggregate accuracy moved only 1-2 points.

## Step 5: judge by cost per solved task

Tokens per second misleads: one method cut output tokens up to 70% but wall-clock only ~35%, and
diffusion-decoding "5x" claims are often tokens per forward pass, not latency (see [latent vs
text](latent-vs-text-agent-design.md), **Read "Nx faster"**). Perplexity, MMLU, LongBench and GSM8K
are single-turn or non-agent scores and do not show an agent keeps its success rate. Compare dollars and
seconds per solved task on your own tasks. When benchmarking serving throughput, switch warm-cache features off;
keep them on in production.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-agent-loop-serving-levers-cost-vs-accuracy.md,
kb://agentic-capability-reports/notes/2026-11-14-reasoning-length-levers-output-token-cost.md
