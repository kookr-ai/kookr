# Coding-agent patch acceptance

Use when: deciding whether a coding agent's patch is mergeable when its tests already pass, writing a brief
for a coding worker, choosing what to check beyond the test suite, or deciding whether a bug fix needs a
reproduction test first.

Green tests are a necessary gate, not a sufficient one. General gate design (audited checks, judges,
fresh-context verifiers, fail-closed inputs): [output verification](agent-output-verification.md).

## Rules

1. **Audit the tests, not just the result.** ~28% of audited SWE-bench Verified tasks admit a verified wrong
   patch. Do not accept the agent's own new tests as proof: ~80% of agent-authored test patches have a weak
   or no oracle. For changes that matter, use a test writer that never saw the patch, or mutation or
   stronger tests, and accept on that.
2. **Put a scope contract in the brief.** List files and behaviors that must not change as negative rules,
   and add an explicit scope statement ("stop and ask before touching anything outside X"). ~20% of benign
   tasks trigger out-of-scope actions; stripping the scope statement raised that 12-17 points. Negative
   rules lifted pass rate ~14 points, but random rules did too, so the gain is partly generic priming.
3. **Re-check the contract at the end, with code, not by asking the agent.** Compliance decays inside a
   session (~5.6% per generated function). Compare the final diff with the allowed-file list and the stated
   constraints in a script (author-side counterpart: Scope Guard in the `pre-pr-review` skill). Not yet
   measured: log its hit rate.
4. **Keep one concern per patch.** Tangled refactors cut compilability odds 58% and method-level
   correctness odds 78%. Agents tangle less than humans, so do not reject on diff size alone; split or
   untangle first.
5. **Pick the reviewer by evidence; a generic "review this patch" LLM pass is not a gate.** No tested model
   found over 31% of human-flagged issues, with false alarms of 19-42%. Better supported: a trained small
   critic (+6 to +16 points resolve rate at lower cost), compile and test guards inside the repair loop (up
   to +13 points, ~70-89% lower cost), or a risk-gated review. Give any reviewer the test results and the
   diff, and treat its output as advisory.
6. **Flag lucky passes** (many blind retries, no verification; Check 3 of the [evaluation
   method](agent-evaluation-method.md)). Read the patch of any passing run with that shape before merging.
7. **Prefer fixed-workflow scaffolds when patch size matters.** Workflow agents made ~22-line, one-file
   patches and overfit in 4-5% of cases; open-process agents made ~474-line, five-file patches and overfit
   in 17-26%.
8. **Do not treat compile success as safety**: 60% of confirmed agent incidents were rated high or critical.
9. **For a reported bug, gate on a reproduction seen failing; do not mandate test writing to raise a score.**
   Try a cheap reproduction (one or two attempts). It counts only if it fails on the unpatched code for the
   reason named in the issue; the fix is done only when it passes and the existing suite still passes.
   Forcing test writing moved resolved tasks by 0 to -13 of 500 at up to 49% more tokens, so on a
   hidden-grader benchmark it is mostly a cost, while in a real repo the reproduction is often the only
   evidence the symptom is gone.
   - **Expect failure and say so.** Strong pipelines reproduce ~70-82% of issues, ~52% on C++, ~14% for open
     7B-32B models. When no valid reproduction appears within budget, fall back to stack traces, logs or a
     runtime check on the real path, and mark the patch as not verified against the symptom instead of
     looping (lucky passes cost up to 40x the tokens).
   - **Write the test from the issue text, not from the buggy code.** LLM oracles mirror the code's actual
     behavior (accuracy 60% vs 47% on buggy code), and an expected value read from the system under test
     cannot fail. Print-only tests are not reproductions.
   - **A reproduction does not pick between patches.** Reproducing tests accepted the correct and rejected
     the wrong candidates in only ~9% of tasks. To choose among candidates, generate tests that pass on some
     and fail on others (84% vs 79% single-agent, where an LLM judge did not beat a single agent, at
     670K-1.7M tokens per instance).

Related skills: `agent-fleet-orchestration` (batching, blind test writers, one worktree per writer),
`independent-merge-review` (exact-head merge verdict), `pre-pr-review` (self-review before opening a PR).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-mergeable-patches-beyond-passing-tests-coding-agents.md, kb://agentic-capability-reports/notes/2026-11-14-reproduction-test-first-for-coding-agent-bug-fixes.md
