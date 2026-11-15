# Harness faults: is it the harness or the model?

Use when: an agent fails and you are about to blame the model (switch models, add reasoning, add a
retry loop), its output looks right but the state is wrong, you build or audit the scaffolding around a
model (tool wrappers, error handling, validators, provider calls), or an optimizer or self-improvement
loop proposes harness edits.

Rule out the harness before the model: the same model backends scored 76% in one harness and 52% in
another, and repairing only the harness lifted one model 6-18 points across four benchmarks.
Recovering inside a task once a failure is found: [agent failure recovery](agent-failure-recovery.md).
Tool schemas, descriptions and error wording: [tool surface design](agent-tool-surface-design.md).
Code-level retry, backoff and idempotency: `error-handling-patterns`.

## Triage the harness first

Harness faults are mostly quiet wrong behavior at configuration and integration seams, not crashes.
Check in this order, and change the model or the prompt only when all four come back clean:

1. **Did the tool's effect happen?** Re-read the state it should have changed; a return value is a
   claim. Silent failures cluster in the API and wrapper layers, most often as missing data or fields.
2. **Did the error reach the model?** Look for a swallowed exit code (`|| true`, `cmd | tail`, a trailing
   `echo` in a backgrounded gate), an error returned as narrative text, or a "launched" result for a task
   that was terminated.
3. **Did the validator see real input?** One production runtime's governance checks ran on empty strings
   for months and passed.
4. **What changed since it last worked?** Configuration, schema, dependency version, auth token,
   provider. Nearly all framework-bug triggers involved configuration, mostly model settings.

## Make harness failures loud

1. **Never suppress the exit code of a step a later step depends on.** Keep the real command's status,
   not that of a pipe or wrapper.
2. **Return tool failures as typed errors** (`is_error: true`, an error class, a non-zero code), never as
   prose the model may read as success.
3. **Make validators fail on empty or missing input** instead of passing.
4. **Tell the agent to check tool returns that look wrong.** Agents adopted corrupted returns a third to
   two thirds of the time and almost never warned the user. A VERIFY instruction cut adoption while
   mostly keeping accuracy on correct returns; fine-tuning gave limited or inconsistent gains.
5. **Keep a check on what the user actually sees.** In one runtime, prevention layers stopped no incident
   ahead of time, and about 70% of silent failures were found by a human looking at the output.

## Repair the harness from traces, behind a gate

1. **Classify each failed trajectory, make one scoped edit per class, and accept it only if a held-out
   set does not regress.** Typed diagnosis repaired 114 of 120 controlled harness failures, against 4 for
   regenerating.
2. **Never skip the non-regression gate.** Greedy acceptance committed 30-42% false modifications (small
   models), and self-improving harnesses added guards for failures that never happened in a quarter of
   runs. The keep gate itself: `agent-evaluation` (autonomous experiment loops).
3. **Fix upstream of the blamed module.** Patching the module a diagnosis blamed raised failure on two
   of three models; patching the module upstream of it cut failure on all three.

## Handle provider and runtime faults in code

1. **Classify the error before acting**: auth expired, quota, provider outage, timeout. Each
   needs a different move, and none needs an LLM turn: deterministic rerouting used about 14x fewer
   control-plane LLM calls than ReAct (simulated failures).
2. **Back off and retry through one limiter** (the transient row in [agent failure
   recovery](agent-failure-recovery.md)); plain retries can sustain an outage. Retry alone is not
   recovery: on a GPU training cluster, automated retry chains beat manual recovery yet still failed
   two times in three.
3. **Fail over to another provider with hysteresis** (a margin and a cooldown) so the switch does not
   flap.
4. **Treat a client-side timeout as unknown, not failed** ([tool surface
   design](agent-tool-surface-design.md)): check server state before retrying anything that is not
   idempotent.

## When harness work does not pay

- **Weak models.** On a 35B model a long procedure was neutral or harmful while one sentence ("verify
  your writes") helped, and weak models loaded the skills they were given as rarely as a quarter of
  the time. Give small models one short instruction and measure it.
- **More orchestration.** Adding retries and orchestration lowered accuracy and more than doubled
  tracebacks.
- **Long-horizon reasoning failures.** Planning errors, forgetting and error accumulation are model-side;
  a harness fix will not cure them, chunking and replanning might ([long-horizon
  planning](long-horizon-planning.md)).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-harness-vs-model-fault-share-and-harness-defenses.md
