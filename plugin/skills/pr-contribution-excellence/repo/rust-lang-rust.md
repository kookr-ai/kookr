# rust-lang/rust Contribution Patterns

Distilled from 45 PRs across 9 batches (2026-04-01). Evidence PRs: #153632, #153834, #154110, #154190, #154468, #154200, #154453, #154043, #153821, #154320, #153380, #154472, #154459, #154185, #154504, #154520, #154512, #154502, #154499, #154475, #154515, #154500, #154488, #154485, #154464, #154450, #154431, #154414, #154418, #154410, #154375, #154400, #154394, #154381, #154361, #154074, #154066, #154070, #154053, #154040, #154014, #154010, #154004, #154015, #153983.

## Process

### Bors Is the Merge System
PRs are not merged via GitHub's merge button. Maintainers use `@bors r+` (or `@bors r=name1,name2` for multi-person approval). GitHub's "Approve" review is ambiguous — `@bors r+` is the authoritative signal. Non-maintainers cannot trigger try builds (`@bors try`).

### Triagebot Auto-Assigns Reviewers
Don't manually assign reviewers with `r?` unless you have a domain-specific reason (e.g., continuity with a prior PR in a series, or domain expertise for a reworked PR). The triagebot handles load balancing based on file paths changed. Use `@rustbot reroll` if the assigned reviewer is a poor fit. When resubmitting a reworked version of a prior PR, `r?` the same reviewer who reviewed the predecessor — they have context (#154014).

### Fallback Reviewer = Wrong Repo Signal
If triagebot assigns a fallback/general reviewer (e.g., Mark-Simulacrum, jieyouxu) instead of a domain expert, check whether your changes belong in a subtree repo instead. Clippy-only → rust-lang/rust-clippy. Miri-only → rust-lang/miri. Rustfmt-only → rust-lang/rustfmt. Only submit to rust-lang/rust when the change requires non-subtool components.

### Zulip Before PR
For non-trivial changes (new features, behavioral changes, diagnostic rewrites), start a Zulip discussion before submitting a PR. Pre-alignment on approach reduces review friction. Both #153834 and #154110 used this strategy successfully.

### Don't PR Open Design Questions
Issues labeled C-discussion or with active WG working groups are design conversations, not implementation tasks. Participate in the discussion first; only open a PR after the approach converges. "Try to fix" in a description signals premature PRing (#154400).

### Check for Existing Work Before Starting
Search the issue's linked PRs and recent closed PRs touching the same files. Duplicate work wastes both your time and reviewers' (#154499 was closed because #154461 already addressed the same issue).

### Track Your Own In-Flight PRs
Before opening a new PR, check if you already have one covering the same change. #154464 was self-closed in 6 minutes because the author realized their own #154371 already included the work.

### Stabilization Is Multi-Stage
RFC acceptance → implementation → stabilization PR → libs-api meeting → community review → possible scope reduction. Each stage can catch problems the prior missed. RFC acceptance is necessary but not sufficient.

### FCP for Language-Level Changes
Changes affecting language-level guarantees require a formal Final Comment Period with team members voting. FCP takes ~11 days.

### Beta-Nominated Urgency
Destabilizations near beta cutoff get `@bors p=1` (priority) and `beta-nominated` label.

### Beta Strategy: Revert vs Backport
Complex fixes get the nightly timeline; simple reverts get beta. When a PR causes a regression near beta cutoff, reviewers prefer reverting the original PR on beta and letting the proper fix land on nightly (#154074).

### Split Mechanical from Stabilization
Non-controversial mechanical changes (module moves, renames) should be split from controversial stabilization decisions. The mechanical PR merges quickly while the stabilization discussion continues independently (#154004 split from #153261).

### Bikeshed → Sub-Issue
When naming debates arise on a PR, create a dedicated sub-issue for the bikeshed and land the PR with the current name. Don't let naming debates block mechanical work (#154004 → #154237).

### Experiment PRs: `[EXPERIMENT]` + Draft
For optimization hypotheses, open a draft PR with `[EXPERIMENT]` prefix. No description needed, no reviewer assigned. Use `@bors try @rust-timer queue` to benchmark. Self-close with brief explanation if results are negative. Veteran-only workflow — newcomers should discuss on Zulip first (#153983).

## Review Dynamics

### Trust Tiers
| Tier | Example | Review Time | Scrutiny |
|------|---------|-------------|----------|
| Veteran compiler contributor | petrochenkov, RalfJung, nnethercote | <1 day | Near-zero — bare `@bors r+` |
| Experienced contributor | chenyukang, Zalathar | 1-2 days | Light — zero to few comments |
| Regular contributor | Lars-Schumann, cyrgani | 1-15 days | Normal — technical discussion |
| First-time contributor | N1ark, resrever | 3-16 days | Thorough — code patterns scrutinized |

Trust is earned over time and applies to specific domains. A trusted compiler contributor isn't automatically trusted for stdlib stabilizations.

**Caveat: Description quality is non-negotiable at ALL tiers.** Even veterans get blocked for insufficient descriptions. nnethercote blocked estebank's PR for 2 days: "Can you update the PR description? Links to issues aren't always helpful." The `@rustbot author` workflow was used without hesitation (#154010).

### "r=me either way" — Conditional Trust Signal
When a reviewer approves with optional suggestions ("r=me either way"), they trust the author to decide what to address now vs follow-up. estebank deferred a wording suggestion to post-merge — accepted (#154010). Newcomers should not assume this latitude.

### Reviewer Hand-Off
Initial reviewers can defer to domain experts mid-review. Mark-Simulacrum gave `r=me` on #154004, then cc'd scottmcm for domain expertise. scottmcm took over final approval. No ego about who merges.

### Perf Regressions: Rework, Don't Abandon
When a merged PR causes a perf regression, the correct response is to submit a reworked version that addresses the regression. Move expensive computation to error-only paths. Request the same reviewer for continuity (#154014 reworked #152679).

### Small Regressions Can Be Accepted
Not every perf regression blocks a merge. Reviewers make judgment calls: "the output improvement is worth it." But the contributor should not make this call — let the reviewer decide. Perf team later triages with `perf-regression-triaged` label (#154014).

### Cross-Cutting Changes Need Multi-Team Sign-Off
For changes spanning multiple components, individually ping each domain owner, collect explicit approvals, and merge with `@bors r=person1,person2,person3`.

### Rollup Strategy
- `rollup` (or `rollup=always`): Safe, low-risk changes (docs, simple bug fixes, test reorg, test fixes)
- `rollup=never`: Perf-sensitive changes (codegen, const evaluation, compiler internals)
- `p=10 rollup=never`: Urgent unblock PRs — skips rollup queue, gets CI immediately (#154485)
- Rollup failures happen even when individual PRs pass

## Bors Workflow Patterns

### Re-Approval After Changes
Bors auto-unapproves when new commits are pushed. After force-pushing to address review, use `@bors r=<original-reviewer>` to re-approve without requiring a redundant review round.

### Self-Revoke to Improve
Use `@bors r-` to pull back an already-approved PR if you want to make improvements (file tracking issues, update comments). Then `@bors r=<reviewer>` to re-approve. Shows quality discipline (#154375).

### Self-Remove from Queue
Use `@bors r-` to remove your PR from the merge queue when it would conflict with another in-flight PR. Re-approve with `@bors r=<reviewer>` after the conflict clears (#154450).

### CI Timeout Recovery
When bors times out (infrastructure flake, not your fault): targeted try job on the suspected flaky platform → confirm pass → `@bors retry`. Community members often help with this without being asked (#154361).

### Targeted Try Jobs
Use `@bors try jobs=test-various` to validate specific test suites (e.g., cross-platform MIR tests) without running the full CI matrix. Useful when you can't test a platform locally (#154004).

### CI Recovery After Approval
If CI fails after `@bors r+`: immediately `@bors r-` → fix → `@bors r=<original-reviewer>`. Entire cycle can complete in under 10 minutes without requiring the reviewer to return (#154074).

## Description Patterns

### By PR Type
| Type | Description Format |
|------|-------------------|
| **Stabilization** | Full API surface as code block, tracking issue link |
| **Correctness bug fix** | Show current code side-by-side to make inconsistency visible |
| **ICE fix** | Link issue, explain root cause technically (name exact predicates/types), add regression test |
| **Refactoring** | (1) Current state, (2) What changes, (3) Why new location is reasonable, (4) Concrete benefit, (5) Side effects. Minimal ok if tracked issue linked and reviewer has context (#154015) |
| **Revert** | Link reverted PR, enumerate specific problems, acknowledge original intent, offer path forward |
| **Simple bug fix** | "Fixes #N" is sufficient when linked issue is thorough |
| **Test fix / normalization** | "Fixes #N" acceptable for 1-line fixes |
| **Config/process change** | Brief + cc affected stakeholders |
| **Test reorganization** | One sentence explaining motivation |

### Self-Labeling
Use `@rustbot label A-{area}` in the PR body for area-specific changes.

### Scope Signals
- "I stopped here to make review a bit easier" — shows scope awareness, signals more work planned (#154410)
- "I have more changes planned..." — contextualizes the PR as part of a series
- Per-commit descriptions in multi-commit PRs help reviewers understand structure (#154500)

## Code Conventions Enforced by Reviewers

1. **Exhaustive matches** on enums — no wildcards on types like `FloatTy`
2. **`span_bug!` over `bug!`** when a span is available
3. **Preserve existing comments** during refactoring
4. **`bug!`/`span_bug!` for unreachable cases**
5. **Generic test file names** — name after what the test exercises, not the issue number
6. **Feature gates in doctests** — unstable API examples need `#![feature(...)]`
7. **Match existing normalization patterns** — check sibling test files for `normalize-stderr` conventions (#154394)
8. **Consistency with sibling types** — if Hash{Set,Map} has doc links, BTree{Set,Map} should too (#154520)
9. **No bounds on struct types** — type parameter bounds go on `impl` blocks, not the type definition. `Complex<T: Copy>` → `Complex<T>` with `impl<T: Copy>`. Core stdlib convention (#154040)
10. **`float_test!` macro for numeric tests** — stdlib numeric tests use `float_test!` to cover all float types. Reviewers enforce this (#154040)
11. **Empty match arms → use ignore list** — instead of `=> {}` catch-all arms, add attributes to the existing ignore list pattern (#154015)
12. **`#[cfg(bootstrap)]` for staged API moves** — when moving types between modules, both paths must exist during bootstrap transition (#154004)
13. **One comprehensive test file per diagnostic** — create a single dedicated test file covering all suggestion variants rather than scattering test cases across existing files (#154010)

## Local Verification

### Critical Pre-Push Checks
- **Never run `cargo fmt`** on the entire repo. Use `./x fmt` which respects project norms (#154400).
- **Always `git diff --stat`** before pushing to catch unrelated file changes.
- **Run `./x test tidy`** to catch formatting/style issues before CI.
- **For clippy changes**: `./x test src/tools/clippy --bless` to regenerate `.stderr` files.
- **Compile locally** — CI syntax errors are extremely damaging to credibility (#154499).

### Perf Validation
For compiler internals, proactively run `@bors try @rust-timer queue` before or alongside code review. Perf validation is step 1, not an afterthought. This preempts reviewer questions about performance impact (#154361).

## Contributor Success Patterns

1. **Be responsive** — address review comments within minutes/hours
2. **Accept partial scope** — incremental > comprehensive
3. **Cut controversial parts** — drop contested portions and merge the rest
4. **Handle setbacks gracefully** — reverts and pushback are normal
5. **Chain small PRs** — each linking the prior
6. **Conditional approval invocation** — when reviewer says "r=me after X", use `@bors r=reviewer` once X is met
7. **Follow up on maintainer suggestions** — when a maintainer suggests work in a PR comment, a follow-up PR that does exactly that is a high-confidence contribution (#154512)
8. **Self-review comments** — explain organizational decisions in the diff to help reviewers navigate large changes (#154475)
9. **Acknowledge code complexity honestly** — "fairly crufty" builds trust (#154410)
10. **Quick turnaround on feedback** — responding to review within hours signals engagement and earns goodwill. 18-hour response → 6-minute approval on #154015
11. **Find a productive niche** — Unique-Usman has 14 merged PRs, all diagnostics improvements. Diagnostics are self-contained, easy to test, and deliver visible user value (#154014)
12. **Rework after regression** — when your merged PR causes problems, submit a reworked version rather than abandoning. This shows ownership and builds trust (#154014)

## Revert PR Protocol

1. Link the reverted PR
2. Enumerate specific, verifiable problems (not vague "this is problematic")
3. Acknowledge the original author's effort and intent
4. Offer a concrete path forward for relanding
5. Explain what you tried before reverting (fix-forward attempts)
6. Use empathetic tone — "Sorry to be the bearer of bad news" (#154488)

## AI / LLM Moderation

### LLM Detection Signals That Trigger Bans
rust-lang/rust moderators actively ban suspected LLM-generated spam PRs. #154066 was banned and locked despite being technically correct. Signals:
1. Fork created and PR submitted within seconds — impossible human workflow
2. Zero prior engagement with the project
3. Perfectly formatted description with proactive counterarguments — textbook LLM output
4. Disproportionate polish for a newcomer (2-line fix with 110 lines of perfectly structured tests)

### Honest AI Disclosure Works
Transparent Claude usage in #154070 ("Used claude for the tedious char by char parsing parts but verified the code, I hope that's ok!") did NOT trigger negative reactions. The difference: honest disclosure + prior engagement vs. suspicious delivery pattern.

### How to Avoid LLM Detection
- Fork well in advance — don't let metadata show same-day fork-to-PR
- Establish prior engagement: issue comments, reviews on other PRs
- Write like a human: shorter, imperfect, use contractions
- File the bug report first, then reference it in the PR
- Don't include proactive defense sections — they're an LLM tell
- Don't over-polish newcomer PRs — the polish itself is suspicious

## Anti-Patterns (Rejection Signals)

1. **"Try to fix" / "try resolve issue"** in title/description — signals low confidence, discourages reviewer investment
2. **`cargo fmt` blast radius** — running `cargo fmt` instead of `./x fmt` reformats dozens of unrelated files
3. **Disproportionate changeset** — +235 lines across 7 files for a doc fix means misunderstood scope (#154499)
4. **Automated/bulk PRs** — explicitly unwelcome; CI maintainers close as a category (#154414)
5. **Marketing in PRs** — product links, install commands, company branding destroy credibility
6. **Partial fixes** — changing one pattern but leaving identical ones untouched undermines claims
7. **Escalating after polite close** — pushback after a gentle rejection damages reputation across multiple comments
8. **Machine-generated titles** — "fix: extract 1 unsafe expression(s)" with parenthetical pluralization reveals tooling
9. **"done)" as only communication** — after CI failures, explain what you fixed and why it failed
10. **Submitting to wrong repo** — check if all changes are within a single subtool directory first
11. **Git hygiene failures** — persistent merge commits despite bot warnings, never resolving rebase issues. Even acceptable code fails if delivery mechanism is broken. 19 CI failure notifications on #154040
12. **Narrow review missing broader concerns** — only one team's reviewers sign off, but the change affects another team's maintenance burden. Post-merge dissent on #154070
13. **Local perf only** — don't invest in polish based on local benchmarks alone. CI has different hardware/workloads; local improvements often don't translate (#153983)

## Low-Barrier Entry Points

1. **Consistency-gap PRs** — filling missing docs that exist for sibling types (#154520, #154407)
2. **Test reorganization** — moving tests between directories (no domain expertise needed, #154418)
3. **Config/process PRs** — triagebot.toml changes (#154515)
4. **`E-easy` label** — ~19 open issues tagged for newcomers
5. **`E-mentor` label** — ~71 open issues with available mentors
6. **`E-needs-test` label** — adding test cases for existing bugs
7. **Code cleanup** — replacing patterns like `truncate(0)` with `clear()`
8. **Test normalization fixes** — adding missing `normalize-stderr` directives (#154394)

## CI

- CI flakes retried with `@bors retry` — no investigation needed for known patterns
- Common flakes: aarch64-gnu-llvm-21-1, arm-android timeouts
- Even maintainers deal with 3+ CI attempts on complex PRs
- Proc macro tests must handle cross-compilation
- Full CI runs take hours — PR CI runs a subset
- rust-log-analyzer bot posts exact error messages on failures — read them carefully
