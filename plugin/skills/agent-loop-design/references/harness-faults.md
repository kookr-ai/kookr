# Harness faults: is it the harness or the model?

Use when: an agent fails and you are about to blame the model (switch models, add reasoning, add a
retry loop), when an agent's output looks right but the state is wrong, when building or auditing the
scaffolding around a model (tool wrappers, error handling, validators, provider calls), or when an
optimizer or self-improvement loop proposes harness edits.

**Rule out the harness before the model.** No study measures a general "X% harness, Y% model" split,
but harness faults are common enough that skipping the check wastes the fix. With the same 8 model
backends, one harness scored 76.2% and another 52.4% across 106 tasks (2605.27922). Repairing only the
harness raised gpt-5-mini from 45.0% to 57.0% on SWE-bench Verified and from 43.3% to 61.7% on GAIA
(2606.06324). Counted as bugs, harness-triggered faults are a minority: 8.4% of issues in four agent
projects (2607.15684).

Recovering inside a task once a failure is found: [agent failure recovery](agent-failure-recovery.md).
Tool schemas, descriptions and error wording: [tool surface design](agent-tool-surface-design.md).
Code-level retry, backoff and idempotency: `error-handling-patterns`.

## Step 1: triage the harness first

Harness faults are mostly quiet wrong behaviour, not crashes: 76.00% of agent-framework bug reports
showed incorrect functionality and 5.50% crashes (5,669 reports, 2602.21806). They sit at
configuration and integration seams: data schema mismatches were 28.0% and dependency drift 21.9% of
385 agentic-software faults (2603.06847). Check, in this order:

1. **Did the tool's effect happen?** Re-read the state it should have changed. Do not trust its return
   value: 91 silent failures turned up in 198 test cases across 15 tools, mostly missing fields
   (2609.26836).
2. **Did the error reach the model?** Look for a swallowed exit code (`|| true`, `cmd | tail`, a trailing
   `echo` in a backgrounded gate), an error returned as narrative text, or a "launched" result for a task
   that was terminated.
3. **Did the validator see real input?** In one production runtime, 67 governance checks ran on empty
   strings for months and passed (2606.14589).
4. **What changed since it last worked?** Configuration, schema, dependency version, auth token,
   provider. In 409 framework bugs, 92% of triggers involved configuration (2604.08906).

Only when all four come back clean is it worth changing the model or the prompt.

## Step 2: make harness failures loud

- Never suppress the exit code of a step whose success a later step depends on. Keep the real command's
  status, not that of a pipe or wrapper.
- Return tool failures as typed errors (`is_error: true`, an error class, a non-zero code), never as
  prose the model may read as success.
- Make validators fail on empty or missing input instead of passing.
- Tell the agent to check tool returns that look wrong. Agents adopted corrupted returns 35.5% to 68.0%
  of the time and warned the user in ~4% of those runs. A VERIFY instruction cut adoption on every tool
  while mostly keeping accuracy on correct returns; fine-tuning gave limited or inconsistent gains
  (2609.05587).
- Keep a check on what the user actually sees. Prevention layers stopped 0% of incidents ahead of time
  and caught 87% after the fact as regressions, and about 70% of silent failures were found by a human
  looking at the output (22 incidents, one runtime, 2606.14589).

## Step 3: fix the harness from traces, behind a gate

- Collect failed trajectories, classify each failure, make a scoped edit per class, and accept it only if
  a held-out set does not regress. Typed diagnosis repaired 114/120 controlled harness failures against
  4/120 for regenerating (2608.28363). Typed routing with a non-regression gate transferred in 18/20
  model-language pairs (2608.10178).
- The gate is not optional: greedy acceptance committed 30-42% false modifications (2606.08106), and
  self-improving harnesses added guards for failures that never happened in 25% of runs (2607.13083).
- Fix upstream of the blamed module. Injecting correction examples into the module the diagnosis blamed
  raised failure by 0.243 and 0.683 on two models; patching the module upstream of it cut failure by
  0.191 and 0.659 (2605.21958).

## Step 4: handle provider and runtime faults in code

- Classify the error before acting: auth expired, quota, provider outage, timeout, disk full. Each needs
  a different move, and none needs an LLM turn. Deterministic rerouting on tool failure used 9
  control-plane LLM calls against 123 for ReAct, on simulated failures (2603.01548).
- Back off exponentially; plain retries can sustain an outage (2606.00942). Retry alone is not recovery:
  automated retry chains succeeded 33.3% of the time on a 504-GPU training cluster (2605.09370).
- Fail over to another provider with hysteresis (a margin and a cooldown) so the switch does not flap
  (2605.26404, analytical model and one case study).
- A client-side timeout is "unknown", not "failed": check server state before retrying anything that is
  not idempotent.

## When harness work does not pay

- **Weak models.** On a 35B model, a 5,200-character procedure was neutral or harmful, while one
  sentence ("verify your writes") doubled pass@1 from 2/20 to 4/20 (2609.05531). Weak models loaded the
  skills they were given as rarely as 25.1% of the time, against ~96% for strong models (2605.30621).
  Give small models one short instruction and measure it.
- **More orchestration.** Adding retries and orchestration on GAIA level 1 lowered accuracy from 54.72%
  to 50.94% and raised tracebacks from 62 to 141 (2605.14102).
- **Long-horizon reasoning failures.** Planning errors, forgetting and error accumulation are model-side,
  and model gaps narrow once they dominate (2604.11978). A harness fix will not cure them; chunking and
  replanning might ([long-horizon planning](long-horizon-planning.md)).

## Gaps (not found in the surveyed literature)

- No harness-vs-model failure share on a general benchmark; no model-fixed, harness-swapped ablation
  broken down by failure layer.
- No controlled ablation of typed vs untyped tool errors, or of exit-code propagation.
- No measured LLM API 429 or 5xx rate per agent-hour; the recovery numbers come from training clusters.
- No equal-cost comparison of upgrading the model against fixing the harness.
