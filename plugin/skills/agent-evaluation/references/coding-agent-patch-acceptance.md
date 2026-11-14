# Coding-agent patch acceptance

Use when: deciding whether a coding agent's patch is mergeable when its tests already pass, writing a brief
for a coding worker, or choosing what to check beyond the test suite.

Green tests are a necessary gate, not a sufficient one. Gate design in general (audited checks, judges,
fresh-context verifiers, fail-closed inputs) is in [output verification](agent-output-verification.md).

## Rules

1. **Audit the tests, not just the result.** 14 of 49 audited SWE-bench Verified tasks (28.5%) admit a
   verified wrong patch (2606.16062). Do not accept the agent's own new tests as proof: 80.2% of
   agent-authored test patches have a weak or no oracle (2606.18168). For changes that matter, have a test
   writer that never saw the patch, or run mutation or stronger tests, and accept on that.
2. **Put a scope contract in the brief.** List files and behaviors that must not change as negative rules,
   and add an explicit scope statement ("stop and ask before touching anything outside X"). 19.51% of
   benign tasks trigger out-of-scope actions (2605.28122); stripping the scope or consent statement raised the
   rate by 11.9 to 17.2 points (2605.18583). Negative rules lifted SWE-bench pass rate from 50.0% to about
   63.8% on 58 tasks, but random rules did the same, so treat the gain as partly generic priming (2604.11088).
3. **Re-check the contract at the end, with code, not by asking the agent.** Compliance decays inside a
   session, about 5.6% per generated function (2605.10039). Compare the final diff with the allowed-file
   list and the stated constraints in a script (the author-side counterpart is Scope Guard in the
   `pre-pr-review` skill). This check is cheap and not yet measured in the literature: log its hit rate.
4. **Keep one concern per patch.** Tangled refactors cut compilability odds by 58% (odds ratio 0.42) and,
   for method-level refactors, correctness odds by 78% (0.22) (2605.22526). Agents tangle less than humans
   (21.43% vs 36.72% of patches), so do not reject on diff size alone; split or untangle first.
5. **Pick the reviewer by evidence; a generic "review this patch" LLM pass is not a gate.** No tested model
   found more than 31% of human-flagged issues and false-alarm rates were 0.193 to 0.417 (2603.26130).
   Better-supported options: a trained small critic (+5.6 to +16.0 points resolve rate, cost per instance
   $0.07 to $0.03, 2606.21811), compile and test guards inside the repair loop (up to +13 points, 70.1% to
   88.6% lower cost, 2605.27238), or a risk-gated review (2605.30208). Give any reviewer the test results and
   the diff, and treat its output as advisory.
6. **Flag lucky passes** (many blind retries, no verification; rates under Check 3 of the
   [evaluation method](agent-evaluation-method.md)). Read the patch of any passing run with that shape
   before merging.
7. **Prefer fixed-workflow scaffolds when patch size matters.** Workflow agents made about 22-line, one-file
   patches and overfit in 4-5% of cases; open-process agents made about 474-line, five-file patches and
   overfit in 17-26% (2506.08311).
8. **Do not treat compile success as safety**: 60% of 547 confirmed agent incidents were rated high or
   critical (2605.30777).

## Gaps (do not claim more than the evidence)

No study measures a diff-scope or file-allowlist check, a lint or type-check gate, per-model rates of editing
or special-casing tests, or an LLM reviewer's false-positive rate on agent patches. Several effects above come
from one model or one language (the tangling study is Java only).

Related skills: `agent-fleet-orchestration` (batching, blind test writers, one worktree per writer),
`independent-merge-review` (exact-head merge verdict), `pre-pr-review` (self-review before opening a PR).
