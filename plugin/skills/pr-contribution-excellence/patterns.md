# PR Contribution Excellence — Patterns

Companion to `SKILL.md` (rules + index). Numbered patterns (P*) and
anti-patterns (AP*) with inline evidence; IDs are stable and unique —
distillation updates an entry in place (and bumps its citation count in
`evidence.md`) rather than appending a near-duplicate.

> **Renumbering note (2026-06-10):** before this split, numbering had drifted —
> duplicate "pattern 21/22" and "anti-pattern 8/9/10/16" headings existed from
> years of appends. Entries were renumbered sequentially in file order;
> pre-split references in the chronological log use the OLD ambiguous numbers.

## Patterns

### P1. Description Structure by PR Type

Match your description sections to the type of change. More behavioral risk demands more explanation:

| PR Type | Required Sections | Example |
|---------|------------------|---------|
| **Dead code removal** | Why + What Removed + Testing | "This code lies about what the system does — removing misleading surface area" |
| **Own-regression fix** | Minimal (checklist OK) | You broke it in a prior PR — context is already known |
| **Refactor / file split** | Why + What Changed (1 sentence OK) | "File getting large, splitting into modules" |
| **Test addition** | Summary + Why + "Does not change behavior" | Include exact test command |
| **Bug fix** | Symptoms/Problem/Solution OR 7-section template | Explain WHY the old code was wrong |
| **Race condition fix** | Root cause analysis + Fix approach | Explain both issues separately if multiple |
| **Security fix** | Summary + Root Cause + Changes + Validation | Pre-empt "why not redesign?" questions |
| **Large feature** | Full 7-section template | Document what you chose NOT to do |
| **Feature flag toggle** | Title is sufficient | "Enable X by default" is self-documenting |
| **Cross-platform compat fix** | Summary + Approach + VM Validation screenshots | Terminal screenshots proving real-world testing |
| **Comment-only follow-up** | Link to originating PR + validation commands | Reference the reviewer request |

(Evidence: 50 PRs across all types)

### P2. Behavioral Risk Drives Review Effort, Not Line Count

Reviewers assess risk of behavioral change, not diff size. Pure deletion (-517 lines) merged in 34 minutes. A +1455 line feature port merged in 5 hours because it matched an existing pattern. A +571 line security fix took 8 days because every line touched a trust boundary. An external +457 line bug fix merged in 8 hours with zero comments because the description was exceptional.

**Risk spectrum (fastest to slowest review):**
1. Dead code removal (pure deletion, no behavior change)
2. Own-regression fixes (author knows the context)
3. Import/dependency rewiring (mechanical transformation)
4. Prompt/text polishing (small scope, domain-specific)
5. Type changes at internal boundaries
6. Race condition / flaky test fixes (root cause analysis valued)
7. File-split refactors (code movement, no logic change)
8. Test-only additions
9. Bug fixes with clear root cause
10. Feature flag enablement (may wait on dependencies)
11. Cross-platform compatibility fixes (deep review, VM validation expected)
12. Large architectural refactors (substantive design review)
13. Security/trust-boundary changes

(Evidence: #15900 34min, #15885 57min, #15903 1hr, #15891 1hr, #15897 2hr, #15909 2hr, #15798 2.5hr, #15789 5hr, #15860 5hr, #15759 8.3hr, #15811 20hr, #15659 28hr, #15693 32hr, #15691 40hr, #15513 2d, #15067 8d)

### P3. Scope Discipline Is the #1 External Contributor Concern

When reviewers review external contributor PRs, their primary concern is scope — not code quality, architecture, or test coverage. Every inline question on the most-reviewed external PR (#15513) was a variant of "is this related to this PR?"

**How to maintain scope discipline:**
- Run `git diff main...HEAD` after every rebase to catch unrelated changes
- Drop rebase-introduced fixture/format changes into a separate PR
- If the final diff no longer matches the title, stop and repair the branch before asking for review
- For bot suggestions you're declining: "We want to keep this PR scoped to [X] rather than add [Y] here. Will track as follow-up if [condition]."
- Never put unrelated test fixture fixes in the same PR, even if they're trivially correct
- List explicitly deferred work in a "Follow-ups" section to show scope awareness

(Evidence: #15513, #15067, #15791, #15691, plus `anomalyco/opencode` `#6170`)

### P4. Iterative Bot Self-Review Before Human Review

Run automated review tools (Codex bot, Copilot, CI) iteratively before requesting human review. Push changes → trigger bot → address feedback → repeat until clean. This demonstrates thoroughness and prevents humans from finding issues bots would catch.

**Bot feedback response patterns:**
- For suggestions you implement: just push the fix, no explanation needed
- For suggestions you decline: "We want to keep this PR scoped to [scope]. [Reason it's out of scope]. Will track as follow-up if [condition]."
- Never ignore bot suggestions — always respond, even to decline
- Note: Bot compile-error findings (P0) are often false positives — CI is the authority

(Evidence: #15513 — fcoury invoked @codex review 5 times, engaged with every P2 suggestion)

### P5. Transparency About Testing Limitations Builds Trust

Document what you couldn't test and why: "cargo test ran out of disk while linking test binaries", "noted unrelated test failures in other packages — not caused by these changes", or "full workspace cargo test was not run." Reviewers value honesty about limitations over fake completeness. No PR was rejected for admitting testing gaps.

(Evidence: #15897, #15903, #15805, #15789, #15659 — all honestly documented gaps, all merged promptly)
(Additional evidence from `mem0ai/mem0`: #4565 disclosed bug didn't reproduce on latest client version but kept fix as defensive code → merged in 29h; #4122 documented ASGI double-response bug discovered during implementation → merged with zero comments)

### P6. "Does Not Change Behavior" Is a Reviewer Accelerator

When your PR genuinely doesn't change runtime behavior (test additions, refactors, infrastructure fixes), say so explicitly in the first paragraph. This phrase lets reviewers skip behavioral analysis and focus on correctness of the transformation.

(Evidence: #15813, #15835, #15811, #15661, #15900)

### P7. Frame Removals as Eliminating Misleading Behavior

Don't frame dead code removal as "cleanup" or "tech debt." Frame it as: "This code makes it look like X is possible when it isn't — removing it so the model matches reality." This creates urgency and prevents "we might need that someday" pushback.

(Evidence: #15900 — 517 lines deleted, merged in 34 minutes with this framing)

### P8. Balanced Review Response: Defend and Concede Appropriately

When reviewers question your decisions:
- **Defend** where you're right: "Yes, it's still needed because [reasoning]" — clear, factual, not defensive
- **Concede** where they have a point: "Good point. I'll refactor to eliminate the redundancy."
- **Answer concisely**: "No, this was never a PID." / "This is for ws reconnection." — terse, direct, satisfying
- Never be purely agreeable (signals you haven't thought deeply) or purely defensive (signals you can't accept feedback)

(Evidence: #15798, #15691)

### P9. Proactive Debugging Narratives Earn Goodwill

Frame bug fix PRs as investigation stories: "I've seen several intermittent failures of [test name] today. I investigated, and I found a couple of issues." This narrative structure positions you as a problem-solver, not just a patch-submitter. It's especially effective for race conditions and flaky tests where the root cause isn't obvious.

(Evidence: #15798 — framed as proactive investigation, merged in 2.5 hours)

### P10. Root Cause Over Symptom Fix

PRs that explain WHY the previous approach was wrong — not just what changed — get faster approval. Reference the original PR/issue that introduced the workaround to show historical awareness. Net-negative-line PRs that remove workarounds are especially valued. When the churn comes from an obsolete generated artifact or compatibility layer, deleting it outright is often stronger than adding another ignore/suppression rule.

(Evidence: #15835, #15909, plus `anomalyco/opencode` `#20929` contrasted with `#20928`; n8n-io/n8n #26898 — cited 3 prior failed fix attempts by PR number, explained why each was insufficient → reviewer approved without questions in 4h)

### P11. Match Existing Patterns to Reduce Review Burden

When your change mirrors an existing pattern in the codebase, explicitly call out the pattern match. "This follows the same approach as {existing code}" lets reviewers verify by comparison rather than from-scratch analysis.

(Evidence: #15860 — 1455-line port merged in 5 hours because it matched the classic `tui` crate pattern)

### P12. Trust Tiers Determine Review Speed

Reviewer scrutiny scales inversely with the author's reputation in the specific domain. Veterans with proven track records in a particular area (e.g., compiler internals, stdlib) get near-instant approval with zero comments. First-time contributors face thorough review of code patterns, naming, and approach. This is not bias — it's earned trust. As a new contributor, expect more scrutiny and use it as a learning opportunity. Build trust through small, well-crafted PRs before proposing large changes.

(Evidence: rust-lang/rust — petrochenkov's 7-line compiler change merged in 1.5 days with zero comments; chenyukang's bug fix in 2 days with zero comments; first-time contributor N1ark's PR took 16 days with 45+ review comments)

### P13. Cut Scope to Unblock Merges

When part of a PR becomes controversial during review, drop the contested part and merge the rest. "Perfection blocks progress" — shipping 80% of the value now and deferring 20% to a follow-up is better than blocking the entire PR for weeks of debate. Offer the split proactively: "I can drop X from this PR to unblock the rest."

(Evidence: rust-lang/rust #153380 — stabilization PR dropped `remainder` method mid-review to unblock the rest of the API; #154320 — only implemented `trim_prefix` without `trim_suffix`, accepted as-is)

### P14. Show the Bug Inline in Descriptions

For correctness bugs, include enough surrounding code context in the PR description that reviewers can see the inconsistency themselves without reading the diff. Show the current implementation of all related functions side-by-side so the bug is visually obvious.

(Evidence: rust-lang/rust #154185 — showed read/try_read/write/try_write implementations with inline comments highlighting the inconsistency)

### P15. Handle Setbacks and Rejections Gracefully

Reverts, reviewer corrections, and process pushback are normal in active projects. Respond without defensiveness: acknowledge, plan the fix, and move forward. A constructive response to a revert builds more long-term trust than the original PR. Never argue with process corrections — apologize briefly and adapt.

When a PR reaches a clear dead end (architecture-level rejection, KEP/RFC required, fundamental design disagreement), self-close with a clear signal rather than letting it rot. Use a "[wontfix]" prefix in your closing comment or the project's `/close` command. Explain in plain language why you're closing, what you learned, and what the right next step is (e.g., "filing a KEP"). A graceful self-close signals maturity, keeps the discussion visible as a reference for others, and preserves your reputation for future contributions.

(Evidence: rust-lang/rust #154200 — first-time contributor's PR was reverted for perf; their response was "I'm learning a lot about the process!" with an immediate plan for improvement; k8s #137986 — author self-closed cleanly after KEP requirement, left a clear pointer for future contributors)

### P16. Exact Verification Commands Are Table Stakes

Every merged PR in the sample included exact test/lint commands. Include:
- The exact test command: `cargo test -p {crate} {test_name} --lib`
- The exact lint command: `cargo clippy --tests -p {crate}`
- Any format check: `cargo fmt --check`

Reviewers copy-paste these to verify. Vague "I tested it locally" gives them nothing.

(Evidence: 50 of 50 merged PRs included verification commands)

### P17. Screenshots for CLI/System-Level Changes

Include terminal screenshots showing real-world behavior, not just for UI changes. Cross-platform compatibility fixes, sandbox changes, and system-level behavior should include screenshots proving the fix works on target platforms. Reviewers may explicitly request this: "update the PR body to explain what you tested."

(Evidence: #15693 — 4 terminal screenshots of bwrap behavior on Ubuntu 20.04; #15758 — annotated screenshot of duplicate reasoning)

### P18. Follow-Up Sections De-Risk Large Changes

For large PRs, include an explicit "Follow-ups" or "Deferred work" section listing what you intentionally left for future PRs. This tells reviewers you thought about scope boundaries and chose this cut point deliberately. Format as a bullet list of specific items.

(Evidence: #15691 — 5 follow-ups for a +1926 line change)

### P19. The Prep-Work + Execution PR Pair

Decompose large changes into a safe prep PR followed by the actual change:
1. **Prep PR**: Refactor, consolidate, simplify. Should be net-negative or neutral LOC.
2. **Execution PR**: The actual feature or behavioral change, building on the clean foundation.

This pattern is universally faster to review than a single large PR.

(Evidence: #15810 → #15811, #15812 → #15906)

### P20. Cross-Boundary Cleanup Must Be Atomic

### P21. In Bot-Gated Repos, Process Compliance Comes Before Code Quality

Some repositories auto-close low-quality or non-compliant PRs before maintainers ever read the diff. In those projects, the first review is the automation layer, not a human. Template sections, issue links, and title format are not “polish”; they are admission criteria.

Practical rule:
- After opening the PR, immediately confirm no automation labels/comments indicate `needs:issue`, missing template sections, or similar process failures.
- Do not assume a good diff will buy you time to fix the description later.

(Evidence: anomalyco/opencode `#20714`, `#20866`, `#21091`)

### P22. Do Not Copy Trusted-Insider Shortcut Patterns As An External Contributor

Trusted maintainers, collaborators, and vouched contributors can merge terse PRs, omit issue links, or land tiny fixes without the same scrutiny applied to first-time contributors. Those shortcut patterns are a trust artifact, not a repo norm for newcomers.

Practical rule:
- Copy the repo’s published process, not the trusted tier’s exceptions.
- If insider PRs are terse or skip issue links, still use the full template, explicit issue reference, and concrete verification for your own PR.

(Evidence: anomalyco/opencode merged `#20956`, `#21047`, `#21053`, `#21054`, `#21016`, `#21070` versus externally closed `#20714`, `#21042`, `#21089`, `#11626`, `#7772`, `#7425`)

When removing a field, type, or API, update ALL consumers in the same PR. Don't leave dangling references for follow-up PRs. If a field is removed from the core, every protocol schema, test, and downstream crate that references it must be updated atomically.

(Evidence: #15906 — 30 files across multiple crate boundaries updated for one field removal)

### P23. Process Compliance Before Code Quality

In projects with automated contribution gates (bots that check issue links, assignment, title format), no amount of code quality can compensate for process violations. A PR with excellent code, tests, and description will be auto-closed identically to a PR with nothing if the process gate isn't cleared.

**Pre-submission checklist:**
1. Is there an approved issue? (Not self-filed without maintainer response)
2. Am I assigned to it?
3. Does my PR title match the project's format? (type, scope, case)
4. Does my PR body include the required issue link format? (`Fixes #N`, not just mentioning the number)
5. Does the project require an AI/co-author disclaimer?

(Evidence: langchain-ai/langchain — 7/8 rejected PRs auto-closed by bots within 30 seconds for process violations, despite several having high-quality code and tests)

### P24. Description Brevity Scales with Change Size

For small changes (<50 lines), one sentence is the correct description length. For medium changes, 1-3 sentences. Reserve structured multi-section descriptions for complex features or security fixes. Description length that exceeds the code change size signals AI-generated boilerplate.

**Red flags in descriptions:**
- Marketing language ("high-impact", "significantly improving")
- IDE artifacts (CCI links, local file paths like `cci:2://file:///e:/...`)
- Parameter tables for unchanged APIs
- Usage guides in a bug fix PR

(Evidence: langchain-ai/langchain — merged PRs averaged 1-sentence descriptions; the 600+ word rejected PR had parameter tables and marketing language)

### P25. Claim the Issue Before Writing Any Code

**This is non-negotiable.** Opening a PR without first commenting on the issue to announce your intent is the fastest way to get rejected. Maintainers and other contributors need visibility into who is working on what.

Before writing a single line of code:
1. **Read the full issue thread** — check if someone has already claimed it or has an open PR
2. **Check the assignee field** — if the issue is assigned to someone, **do not work on it**, not even partially. Pick a different issue.
3. **Comment on the issue** to announce your intent (e.g., "I'd like to work on this" or "I can take this on")
4. **Wait for acknowledgment** if the project requires explicit assignment before starting

When multiple contributors race to fix the same issue, most PRs get wasted. Silently starting work without discussion catches maintainers and other contributors off guard, especially when someone is already actively working on it.

(Evidence: langchain-ai/langchain #36194 — two contributors raced to submit fixes, both auto-closed)
(Evidence: PR refused with "Comment on the issue first to let others know you're planning to work on it")

### P26. Subtool Changes Go to Subtool Repos

Many large repos have subtool directories that are synced from separate repositories (clippy, miri, rustfmt in rust-lang/rust; similar patterns in other monorepos). If all your changes are within a single subtool directory, submit to that subtool's repo instead. Signals you're in the wrong repo: fallback/general reviewer assigned instead of domain expert; bot notifications cc'ing subtool teams.

(Evidence: rust-lang/rust #154381 — clippy-only change closed and redirected to rust-lang/rust-clippy)

### P27. Use Project-Specific Formatting Tools

Don't run generic formatters (`cargo fmt`, `prettier`, `black`) on a project that has its own formatting pipeline. Large projects often have custom formatting that generic tools will destructively reformat. Check the build system for project-specific format commands first.

(Evidence: rust-lang/rust #154400 — `cargo fmt` instead of `./x fmt` reformatted 30+ unrelated files, forcing author to abandon PR)

### P28. Revert PRs Need Empathy and Structure

When reverting someone else's work: (1) link the reverted PR, (2) enumerate specific verifiable problems, (3) acknowledge the original author's effort, (4) offer a concrete path forward, (5) explain what you tried before reverting. Empathetic reverts preserve relationships; brusque ones create enemies.

(Evidence: rust-lang/rust #154488 — exemplary revert with "Sorry to be the bearer of bad news" + 4 specific problems + path forward)

### P29. Automated/Bulk PRs Are Unwelcome

Don't submit PRs generated by automated scanning tools, especially with marketing content (product links, install commands, company branding). Maintainers close these as a category. Partial fixes from scanners (changing one instance but leaving identical ones) further undermine credibility.

(Evidence: rust-lang/rust #154414 — automated security PR closed immediately: "we prefer to not receive automated PRs like this")

### P30. Follow Up on Maintainer Suggestions

When a maintainer suggests work in a PR comment ("could you also..."), a follow-up PR that does exactly that is a high-confidence contribution. Cross-reference the original discussion as motivation — the reviewer already has context and will approve quickly.

(Evidence: rust-lang/rust #154512 — followed suggestion from prior PR, approved with "Sure, seems fine" in 17 hours)

### P31. Survive Stale Bots Through Persistence

Large projects use stale bots (30 days inactive → stale, +14 days → auto-close). This is NOT rejection. Community PRs can survive 6+ months if you respond to each stale notice. Even a brief "This is not stale" or "Still needed" resets the timer. Plan for multiple stale cycles on backend PRs in niche subsystems.

(Evidence: grafana/grafana #111735 — went stale twice, auto-closed once, contributor persisted for 6 months until merge; #114047 — auto-closed TWICE, still merged after 4 months)

### P32. Search for Duplicate PRs AND the Target Branch Before Submitting

Before submitting a fix, search both open and recently merged PRs for the same issue, AND check whether the fix has already landed on the target branch via direct commit (no PR). Even an excellent PR with screenshots and tests will be closed if the fix already landed. In large repos, maintainers sometimes land fixes directly without any PR, making your well-crafted contribution obsolete.

(Evidence: grafana/grafana #121041 — perfect PR description with screenshots, closed because fix already merged in #120096; anomalyco/opencode #21178 — high-quality duplicate detected by bot in 60 seconds; #17170 — fix landed independently on dev after 25 days; #19351 — fix landed via direct commit)

### P33. Squash-Merge Repos: PR Title IS the Commit Message

In projects that squash-merge (Grafana, many others), your commit count and commit messages are irrelevant — they vanish on merge. What matters: (1) PR title follows the project's format, (2) PR description is thorough, (3) final diff is clean. Don't waste time crafting atomic commits for squash-merge repos.

(Evidence: grafana/grafana — PRs with 8, 18, 50, and 59 commits all merged fine; title format `<Area>: Description` used for changelog)

### P34. Before/After Visual Evidence Accelerates Review

For UI changes, include before/after screenshots in side-by-side markdown tables. For CI/tooling changes, show quantitative metrics (variance, pass rates). For features, record short video demos. Visual evidence lets reviewers verify correctness without running the code.

(Evidence: grafana/grafana #120880 — 1-line CSS change with before/after table merged in 2.5 days; #121382 — CI fix with quantitative metrics merged in 2.5 days; #119572 — feature with video demos merged with "Tremendous work, well done 💯")

### P35. Expect Both Bot and Human Review

Large repos increasingly use automated code review (GitHub Copilot, CodeQL, zizmor). Copilot finds real issues: missing tests, type mismatches, namespace inconsistencies, stale error state. Don't dismiss automated findings as noise — address them before human reviewers see them. Human reviewers then focus on semantic correctness and architectural concerns that bots miss.

(Evidence: grafana/grafana #120560 — Copilot found 6 real issues; human reviewer found deeper semantic edge cases; #119572 — Copilot found missing analytics calls and test gaps)

### P36. Feature Toggle / Feature Gate Discipline in Large Projects

When contributing features behind feature toggles: (1) reviewers will test with toggle both enabled AND disabled, (2) data serialization should work regardless of toggle state, (3) UI should be fully gated but data integrity should not depend on the toggle. Expect specific questions about toggle edge cases.

In projects with feature gates (Kubernetes feature flags, Go build tags, etc.), gates should control **wiring** — whether a code path is registered or enabled — never **runtime execution** (if-checks inside handlers). An if-check inside a handler means the gate no longer cleanly removes the code path, and the handler now has conditional behavior that reviewers must reason about even when the gate is off. Three independent k8s reviewers flagged this pattern independently on the same PR.

(Evidence: grafana/grafana #119572 — reviewer asked "what happens when toggle disabled after data saved?"; led to explicit serialization/toggle decoupling; k8s #137032 — feature gate if-check inside handler flagged by 3 independent reviewers, forced handler registration to be gated instead)

### P37. Self-Annotate Critical Diff Lines

For multi-fix PRs or changes where the key line is buried in a larger diff, leave inline comments on your own PR pointing to the critical changes: "this is the key to the fix for X." This guides reviewers directly to what matters, cutting review time from hours to minutes. Especially valuable when the PR bundles related fixes discovered in the same session.

(Evidence: grafana/grafana #121275 — author self-annotated two critical lines, reviewer approved within 35 minutes of annotations)

### P38. Split Cross-Layer Changes into Paired PRs

When a change spans backend and frontend (or two distinct subsystems), split into paired PRs with matching naming conventions. Merge the foundation layer first (backend/schema), then the consumer layer (frontend/client). This keeps each PR reviewable by a single domain team. Reference the pair implicitly through naming or explicitly in the description.

(Evidence: grafana/grafana #121236 + #121238 — paired backend/client schema PRs merged sequentially; #121521 + #121550 — prerequisite instrumentation merged before dependent feature)

### P39. Link to External Evidence When Correcting Documented Drift

When code contradicts official documentation, release announcements, or public-facing statements, link directly to the authoritative source in your PR description. This turns your PR from "I think this is wrong" into "the official announcement says X, the code says Y." Include a screenshot of the current state for visual impact.

(Evidence: grafana/grafana #121475 — feature flags set to "experimental" contradicted a public "public preview" announcement; PR linked to the whats-new page, got 4 approvals including CTO in 21 hours)

### P40. Batch-Address All Review Comments in One Session

When returning to a PR after review feedback, address all comments in a single focused session rather than trickling responses over days. Respond concisely to each: "good call out, done" / "ack, changed it." Reference commit SHAs so reviewers can verify: "Does this capture what you had in mind: <sha>?" This shows respect for reviewer time and avoids multi-round notification fatigue.

(Evidence: grafana/grafana #118631 — 9 inline comments addressed in ~7 hours after 18-day gap; #120994 — reviewer-preferred approach implemented with commit reference)

### P41. Number Stacked PRs with "(1/N)" Convention

When decomposing a large feature into a series of PRs, number them explicitly in the title: "Extract UI toggles hook (1/3)". This sets reviewer expectations about scope boundaries, signals the work is intentionally partial, and enables faster approval. Reviewers don't ask "why didn't you also do X?" when they know X is in PR 2/3.

(Evidence: grafana/grafana #120136 — "(1/3)" refactor approved in 2 days despite 655 additions; reviewer understood it was intentionally incomplete)

### P42. Document Design Tradeoffs in "Implementation Notes"

For PRs with non-obvious design choices, include an "Implementation notes" section listing alternatives considered and why they were rejected. This collapses review rounds to zero by front-loading the "why not?" answers. Especially valuable for database migrations, API changes, and cross-cutting features.

(Evidence: grafana/grafana #121501 — 3 design tradeoffs documented, two silent approvals within 5h; #121034 — NOTE section flagging known limitation prevented confusion; n8n-io/n8n #27688 — "Key decisions for reviewers" section pre-empted bot objections about custom CodeMirror, library choice, and layout; author had crisp "won't fix" answers ready)

### P43. Show Migration Evidence for Every Supported Platform

For database migration PRs, include screenshots of the migration running successfully on ALL supported databases (e.g., MySQL, SQLite, Postgres). Abstract claims ("the migration is idempotent") don't carry the same weight as concrete evidence. This also catches platform-specific SQL dialect issues that unit tests miss.

(Evidence: grafana/grafana #121501 — migration screenshots for 3 DBs contributed to zero-comment approval)

### P44. Over-Test to Eliminate Review Comments

The highest test-to-code ratios produce the shortest review cycles. A 14:1 ratio (219 lines of table-driven tests for 16 lines of handler change) gets zero comments and instant approval. A 2.4:1 ratio for a config fix gets 24-minute approval. When in doubt, add more test cases — especially edge cases, invalid inputs, and boundary conditions.

(Evidence: grafana/grafana #121572 — 14:1 ratio, zero comments, 3h to merge; #121498 — 2.4:1 ratio, zero comments, 24min approval)

### P45. Close Superseded PRs with Thread Context

When closing a PR in favor of a new one (after reviewer feedback, design pivot, or scope rework), reply in the review thread explaining what changed before closing. "Closing in favor of #N — reworked per [reviewer]'s suggestion to [description of change]." Silent closes leave watchers confused and waste the reviewer's investment in providing feedback. The new PR should also reference the original.

(Evidence: grafana/grafana #121474 — closed after torkelo's UX feedback without a thread reply; the replacement PR #121636 lost review context)

### P46. Get Design Alignment Before Coding Non-Trivial Changes

For features that change user-facing workflows (not just implementation details), socialize the design with senior maintainers before writing code. A senior maintainer who disagrees with the fundamental UX direction will require a full rework — not incremental fixes. This is different from code-level approach pivots (Pattern 78/SDK study); it's about product direction.

In governance-heavy projects (Kubernetes SIGs, Apache PMCs, large open-core products), this means getting explicit SIG or team discussion before writing code for any feature that changes observable behavior or API surfaces. Submitting code before design buy-in is disqualifying — a PR that skips SIG discussion can be held on day 2 and rot for 10 months before eventual closure. The cost is not "some review comments"; it is total abandonment.

(Evidence: grafana/grafana #121474 — 2 days of work discarded because a maintainer proposed a fundamentally different UX pattern; k8s #132181 — feature PR held day 2 for missing SIG discussion, rotted 10 months without resolution)

### P47. Fix Regression Side-Effects In-PR

When your change causes a secondary regression discovered during review (diagnostic quality, error message wording, test output), fix it in the same PR with a clean additional commit rather than filing a separate issue. The separate issue will go stale; the in-PR fix is atomic and shows ownership. Use a descriptive commit message for the fix so the history tells the story.

(Evidence: rust-lang/rust #154074 — reviewer flagged diagnostic regression, author fixed in second commit within same PR, approved same day)

### P48. Stabilization/Mechanical PRs Are High-Confidence Entry Points

Every project has mechanical follow-up work that's been approved in principle but nobody's done yet: stabilization PRs, feature flag flips, approved deprecations, config migrations. These are 4-10 line changes with near-zero review friction because the design decision was already made elsewhere. Find the tracking issue, verify consensus exists, and do the mechanical step. A 4-line attribute swap merged in 10 hours with "Thanks!" as the only reviewer comment.

(Evidence: rust-lang/rust #152253 — stabilization PR, 1 file, +4/-4, approved in 5 hours; #154459 — destabilization, approved after Zulip consensus link)

### P49. CC Domain Experts Alongside Assigned Reviewers

When you know a specific person owns the code area but they weren't auto-assigned, use `cc: @expert` in addition to `r? @assigned`. The cc'd expert may catch critical bugs the assigned reviewer would miss. This is especially important for niche subsystems (lints, diagnostics, platform-specific code) where the auto-assigned reviewer may lack deep context.

(Evidence: rust-lang/rust #154592 — cc'd chenyukang caught a critical correctness bug (Span-as-key fails with macro expansions) that the `r?`-assigned shepmaster might have missed)

### P50. Stale CI = Abandoned PR in High-Velocity Repos

In repos with many active contributors (dify, langchain), a PR with failing CI unfixed for >24 hours is treated as abandoned. Another contributor may supersede it with a more thorough fix. If you need time, communicate explicitly ("fixing CI tonight" or "will address by [date]"). Radio silence after CI failure is the #1 way to lose a PR to supersession. The faster contributor wins — they don't need to be first, just more complete.

(Evidence: langgenius/dify #34227 — CI failures unfixed for 50h, superseded by #34265 which fixed 10 files vs 4 and merged in 6h)

### P51. Bot-Delegated Review Culture

Some projects have maintainers who explicitly delegate review to automated reviewers (Copilot, Gemini Code Assist). In these repos, bot suggestions ARE the primary review — maintainers validate with "This is a valid point" or "ditto" rather than writing independent feedback. Address bot comments with the same urgency as human comments. Proactively fixing bot-flagged issues before human review starts eliminates round-trips.

(Evidence: langgenius/dify #32648 — QuantumGhost endorsed Copilot suggestions 3 times; #33044 — Copilot drove 22 comments across 8 review cycles, both Copilot and Gemini feedback drove real code changes)

### P52. Verify "Unnecessary" Code Before Removing It

Code with safety/invariant comments may encode behavior that isn't test-visible (pointer width, provenance, memory model guarantees). Before proposing removal: (1) read the comment explaining why it exists, (2) verify the claim against actual behavior (not just your interpretation), (3) check with domain experts if the comment seems wrong. Even experienced contributors misread abstractions — a 29-line "simplification" PR can be blocked by a single soundness concern.

(Evidence: rust-lang/rust #154399 — expert author misread a comment about extern types, proposed removal, got blocked by 5 domain experts on provenance concerns; gracefully self-closed and filed a comment-improvement PR instead)

### P53. Get Policy Buy-In Before Behavioral or Architecture-Level Changes

For standard library changes that alter API semantics (not just implementation), check prior design discussions and get explicit team buy-in before writing code. Code quality is irrelevant if the design direction is rejected. Search for existing issues and discussions about the approach — someone may have already argued against it. When rejected, "submit a docs PR instead" is a recovery opportunity.

More broadly: when a maintainer tells you the fix requires a design proposal first (KEP in Kubernetes, RFC in many projects, ADR in others), accept it. Code-level fixes for architecture-level problems will always be rejected regardless of implementation quality. The maintainer is not saying "your code is bad" — they're saying "this problem requires design consensus before any code." Filing the design proposal is the correct next step, not refining the PR.

(Evidence: rust-lang/rust #153603 — well-implemented argv[0] fallback for current_exe() rejected on principle by libs-api team; prior issue #152269 had already debated this approach; k8s #137986 — kubelet fix rejected because the correct solution required a KEP; maintainer explicitly said "this needs a KEP first")

### P54. Build a "Pattern Franchise" for Fast Review

Repeating the same well-scoped refactoring pattern across multiple PRs builds trust that compounds dramatically. The reviewer recognizes the same safe transformation, skips deep analysis, and approves quickly. Pick a repeatable, low-risk improvement pattern (enum migration, type narrowing, test reorganization, sessionmaker migration), execute excellently once, then scale it across the codebase. Reference the parent tracking issue and prior PRs so reviewers can quickly verify you're following the established pattern.

(Evidence: langgenius/dify #33696 — 3rd EnumText PR merged in 2.2h; #34414 — 19th SQLAlchemy migration PR merged in 1.7h (down from 14h on the 1st); #34379 — sessionmaker migration merged in 9h by referencing 6+ prior PRs in the series)

### P55. Parity Fixes Are Low-Friction Entry Points

Finding a gap between two API surfaces (Console vs Service API, creation vs update path) and replicating the existing pattern is one of the safest contribution types. Zero code-level feedback — reviewers only care about CI. The fix is self-evidently correct because you're copying an existing proven pattern.

(Evidence: langgenius/dify #34221 — replicated Console API pattern to Service API, zero code concerns; #33637 — replicated creation-time sync to update-time)

### P56. CI Responsiveness > First-Push Perfection

Speed of response to CI failures and review feedback correlates more with merge speed than initial code quality. A PR that needs 2 style fixup commits but responds within 6 hours merges faster than a clean PR whose author iterates against CI over days. The message: fix CI fast, don't make it perfect upfront.

(Evidence: langgenius/dify #34221 — 2 fixup commits, 6h turnaround, merged in 2.3 days; #33704 — correct code, slow iteration, took 11 days)

### P57. In Template-Gated Repos, Equivalent Content Does Not Count As Compliance

Some repositories do not merely require that you include the right information; they require that you present it using the exact PR template headings and checklist structure. A freeform summary plus verification section can still be treated as "missing required sections" even when the substance is good. If the repo is bot-gated, copy the template verbatim and then fill it in succinctly.

(Evidence: anomalyco/opencode `#21089`, `#21091`, `#21094`)

### P58. Eligibility Is Not Maintainer Priority In Stale-Bot Repos

In repositories with both compliance bots and stale bots, clearing automation only gets your PR into the queue; it does not get it reviewed. To survive, tie the change to an active maintainer priority, an issue with visible maintainer pull, or a repo-listed contribution area. This matters most for UI polish, performance work, ecosystem docs, and optional configuration.

Practical rule:
- Ask "why should upstream prioritize this now?" before you code.
- Prefer issues with maintainer labels, assignments, or recent maintainer comments.
- If the work is peripheral, make the upstream value explicit in the first paragraph of the PR body.

(Evidence: anomalyco/opencode `#11961`, `#11626`, `#10190`, `#10282`, `#12040`, `#12007`)

### P59. Clean Branch History Is A Reviewability Signal

External contributor PRs are judged not only by the final diff but by how controlled the branch history looks. Repeated merge-from-main commits, stray unrelated commits, and branch churn weaken the claim that the PR is "small and focused," especially when the change itself is tiny.

Practical rule:
- Rebase or squash before requesting review.
- Remove unrelated commits introduced while syncing with upstream.
- For small fixes, aim for one topical commit or a very short linear stack.

(Evidence: anomalyco/opencode `#11976`, `#10332`, `#10282`, `#10271`, `#10190`)

### P60. Use Hardware-Normalized Metrics for Performance PRs

Raw throughput numbers (tokens/second, requests/second) vary by model size, hardware, and configuration. Including a hardware-normalized metric — like memory bandwidth utilization percentage — gives reviewers an independent validation axis. "3x speedup" is impressive but hard to evaluate; "BW utilization went from 21% to 66%" is self-consistent and defensible because reviewers can compute the theoretical maximum independently.

Practical rule:
- For SIMD/GPU/memory-bound PRs, include both raw numbers AND a utilization metric.
- A 3x speedup at 3x BW utilization is self-consistent. A 3x speedup at the same BW utilization suggests a different kind of improvement (algorithmic, not memory-access).
- Pin the exact hardware, driver, compiler version, and commit SHA — makes results reproducible.

(Evidence: ggml-org/llama.cpp `#21527` — 3x tg speedup with 21%->66% BW util merged in 12h; `#21562` — excellent benchmarks but wrong file location still caused rework)

### P61. Hardware-Owner Reviewers Substitute for Automated CI

In projects with hardware-specific backends (GPU, SYCL, Metal, Vulkan), automated CI often cannot exercise all targets. The reviewer who owns the hardware IS the CI. Getting a domain expert with the actual target hardware to independently reproduce your numbers is more important than any green check mark. Identify the module maintainer and ensure they are aware of the PR.

Practical rule:
- Find the module maintainer for the specific backend you are changing (check CODEOWNERS, recent merge authors).
- Your PR description should make it trivial for them to reproduce: exact build flags, model, benchmark command.
- Honestly disclose hardware you did NOT test on — inviting community testing builds trust rather than inviting skepticism.

(Evidence: ggml-org/llama.cpp `#21527` — arthw tested on Arc 770 and confirmed; `#21273` — disclosed "not tested on other backends" and deferred GPU to future PRs)

### P62. Before/After Examples Are the Strongest Bug-Fix Description Pattern

For bug fix PRs, showing concrete before/after output makes the bug viscerally clear to reviewers. Include the actual garbled/wrong output (before) and the correct output (after). This is significantly more effective than abstract descriptions of what went wrong.

Structure:
```
**Before:** `My name is <PERSON>th, my email i<EMAIL_ADDRESS>com` (PII remnants leaking)
**After:** `My name is <PERSON>, my email is <EMAIL_ADDRESS>` (clean masking)
```

This pattern correlates with faster merge times because reviewers immediately understand the impact without reading the code.

(Evidence: berriai/litellm `#24998` — before/after PII output → silent merge in 2.5 days with zero human comments)

### P63. Include Production Error Frequency to Add Urgency

When you have access to production metrics, include them in the PR description. "~62 errors/hour in production" converts an abstract bug into concrete urgency that moves PRs up the merge queue. Even without exact numbers, "frequently seen in prod logs" is better than nothing.

(Evidence: berriai/litellm `#20261` — production frequency mentioned, merged after community bump; contrast with `#24961` — perfect PR but no urgency signal, silently closed)

### P64. You Can Argue With Bots Using Design-Intent Reasoning

When an automated reviewer (Greptile, CodeRabbit, etc.) flags a finding you disagree with, explain your design intent rather than silently ignoring it. Bots often acknowledge valid reasoning and withdraw their concern. This is more effective than adding workarounds (feature flags, suppression comments) to satisfy the bot score.

However, when a human maintainer contradicts the bot's guidance, always follow the human. Don't chase bot scores at the expense of what maintainers want.

(Evidence: berriai/litellm `#24988` — author pushed back on P1, Greptile acknowledged; `#24440` — author added feature flag for bot score, maintainers told him to remove it)

## Anti-Patterns

### AP1. Scope Creep from Rebase
Including unrelated changes introduced during rebase (fixture updates, format changes). Always `git diff main...HEAD` and drop anything not relevant to your PR.

### AP2. Hiding Testing Gaps
Claiming full test coverage when you haven't run all affected suites. Better to document limitations honestly.

### AP3. Expanding Scope During Review
When a reviewer asks "can we also handle X?", adding X to the current PR instead of creating a follow-up. Risks re-review cycles and confused diffs.

### AP4. Minimal Description for High-Risk Changes
A one-liner is fine for a file split. It's insufficient for a security fix. Scale description to behavioral risk.

### AP5. Defensive Responses to Review Feedback
Even when you disagree, respond with reasoning, not defensiveness. Address every comment, including nits.

### AP6. Ignoring or Dismissing Bot Feedback
Automated reviewers catch real issues. Engage substantively with every suggestion, even if declining: explain why it's out of scope.

### AP7. Leaving Duplicate Branches Open
Multiple PRs for the same fix create confusion. Pick one, close the others with "duplicate of #N" notes.

### AP8. AI-Generated PR Detection Signals
Projects actively moderate for suspected LLM-generated spam. Detection signals: same-day fork-to-PR, zero prior engagement, suspiciously polished descriptions with proactive counterarguments, disproportionate test polish for a newcomer. Fork well in advance, establish credibility through issue comments first, write imperfectly like a human, and don't over-polish newcomer PRs. Honest AI disclosure ("Used Claude for X but verified the code") is far safer than suspected concealment.

(Evidence: rust-lang/rust #154066 — technically correct PR banned as spam due to delivery pattern; #154070 — honest Claude disclosure accepted without issue)

### AP9. Rework After Regression, Don't Abandon
When a merged PR causes a regression (perf, behavior), submit a reworked version that addresses the root cause rather than abandoning the feature. Move expensive computation to error-only paths. Request the same reviewer for context continuity. This shows ownership and builds long-term trust.

(Evidence: rust-lang/rust #154014 — reworked #152679 after perf regression, moved computation to error path, same reviewer approved)

### AP10. Split Mechanical Changes from Controversial Decisions
When a large change bundles non-controversial mechanical work (renames, module moves) with controversial decisions (API stabilization, naming bikesheds), split them. The mechanical PR merges quickly while the decision discussion continues independently. Create sub-issues for bikesheds rather than blocking the PR.

(Evidence: rust-lang/rust #154004 — module move split from stabilization; bikeshed deferred to sub-issue #154237)

### AP11. AI-Generated Code Without Manual Review
Codex/AI-generated PRs may include unnecessary imports, redundant code, or unused constructs. Always manually review before submitting.

### AP12. Rephrasing Reviewer-Provided Wording
When a reviewer provides exact comment text via a `suggestion` block, use it verbatim. Rephrasing signals you think you know better what the reviewer wants to say.

### AP13. Sloppy Commit Messages as an External Contributor
Internal contributors can merge with "update" and "nits" commit messages because they squash-merge. External contributors' commit messages are scrutinized — use conventional commits with descriptive messages.

### AP14. Large Features as First Contributions
Submitting 600+ lines of new feature code as a first contribution to a project. Start with small bug fixes to build trust, then propose larger features after establishing a track record.

### AP15. Self-Filing Issues to Satisfy Process
Creating your own issue and immediately opening a PR for it doesn't satisfy contribution requirements in most projects. The issue needs maintainer triage and explicit approval/assignment. **Exception:** Some projects (dify) explicitly encourage this pattern — self-filed issues are accepted as long as they're linked in the PR. Check the project's CONTRIBUTING.md for guidance.

### AP16. Massive PRs Without Description
Opening a 55-file, 2600+ line PR with placeholder template text guarantees either closure or supersession by a maintainer's own smaller PR. If the scope is large, the description must be proportionally thorough.

### AP17. Pinging Maintainers Without Escalation Plan
In large repos, @-mentioning a single maintainer and waiting passively leads to stale closure. If no review after 2 weeks, escalate through community channels (Slack, forums, mailing lists) — not just more GitHub pings.

### AP18. Drive-By PRs Without Claiming the Issue First
Opening a PR without first commenting on the issue thread is the single most common reason for wasted contributions. Maintainers explicitly ask: "Comment on the issue first to let others know you're planning to work on it." A technically valid fix submitted without prior discussion catches everyone off guard and will be refused — especially if the issue is assigned to someone else and you decided to do "part of the work."

**Mandatory steps before any implementation:**
1. Read the full issue thread — check if someone claimed it or has an open PR
2. If the issue is assigned to someone else, **stop** — pick a different issue
3. Comment on the issue to announce your intent
4. Only then start writing code

(Evidence: langgenius/dify #33653 — correct fix closed 13 seconds after competing PR merged; author hadn't read thread where someone claimed the issue 3h earlier)
(Evidence: PR refused with "Comment on the issue first to let others know you're planning to work on it, this avoids duplicate effort and PR conflicts")

### AP19. Touching Infrastructure Maintainers Want to Own
For project-wide infrastructure changes (Python/Node version bumps, typing modernization, framework migrations), maintainers may close your PR — even if it's correct — and redo the work with broader scope. Before touching project-wide infrastructure, check with maintainers in the issue thread whether they have a broader plan. Narrow, incremental changes to configuration/metadata are safer than scope-defining ones.

(Evidence: langgenius/dify #34399 — QuantumGhost's narrow Python 3.12 bump closed by maintainer WH-2099, replaced by 97-file modernization PR)

### AP20. Broken Diffs from Botched Rebases
A rebase that deletes function bodies or guts files is an instant disqualifier. No maintainer will read further. Always verify `git diff` after rebase and ensure the build passes before requesting review.

(Evidence: langgenius/dify #33334 — sound concept, died because final diff deleted entire function bodies)

### AP21. Enterprise/License-Sensitive Areas Are Off-Limits
Don't touch code that controls enterprise features, licensing, workspace management, or feature flags in open-core projects. Even a 6-line change will be instantly closed if it bypasses enterprise controls. Before modifying permission/auth/workspace code, check whether it's part of the paid offering. This applies to any open-core project (dify, GitLab, Grafana Enterprise, etc.).

(Evidence: langgenius/dify #29070 — hardcoded `is_allow_create_workspace = True`, bypassing enterprise config, closed in 3 minutes by maintainer: "Please read our License first")

### AP22. Design Correctness > CI Status for Core Infrastructure
CI green doesn't validate that your design achieves its goals. For concurrency, caching, pub/sub, or other infrastructure changes, maintainers evaluate whether the design is semantically correct — not just whether tests pass. Both automated reviewers and maintainers catch architectural flaws independently.

(Evidence: langgenius/dify #33884 — CI green, tests passed, but XREADGROUP with per-subscription unique groups is functionally equivalent to XREAD. Gemini, Copilot, and QuantumGhost all identified the same flaw → superseded)

### AP23. Structured Change Tables for Mechanical Refactors
For mechanical refactoring PRs (enum migration, query pattern migration, deprecation removal), include a table in the description showing: file, occurrence count, and pattern applied. This lets reviewers assess scope at a glance without reading the diff. Combine with progress metrics against the umbrella issue.

(Evidence: langgenius/dify #34027 — change table showing 15 queries migrated across 4 files, "zero occurrences remaining in this directory", merged in 14h; #34300 — enumerated columns/write/read sites)

### AP24. Use Non-Closing Issue Links for Series Work
If your PR is one slice of a larger refactor or migration, link the parent issue from the first push without auto-closing it. Use wording like `Part of #N` or `Relates to #N` instead of `Fixes #N` when more slices still need to land. This preserves reviewer context and avoids falsely signaling completion.

(Evidence: langgenius/dify #34547, #34548, #34503, #34528, #33633, #34527, #34561, #34562, #34563)

### AP25. Split Mechanical Series by Review Unit, Not by Narrative
When a mechanical PR starts spanning multiple files, classes, or subsystems, a longer description will not compensate for excess review surface. Split by the smallest coherent unit a reviewer can verify quickly, and use the PR body to name exactly what is deferred to follow-up slices. Reviewability beats completeness.

(Evidence: langgenius/dify #34412 blocked at 16 files despite a strong write-up; successors #34561, #34562, #34563 merged in about 80 minutes each. Same pattern reinforced by #34503 and #34528.)

### AP26. Simpler Fix Wins When Competing PRs Exist
When multiple contributors race to fix the same issue, the simpler implementation wins regardless of who submitted first. Over-engineering the solution (redundant checks for unreachable code paths, handling cases the bug doesn't trigger) makes your PR more fragile, harder to review, and more likely to be superseded. Write the minimal change that fixes the actual bug path, then stop.

(Evidence: n8n-io/n8n #27796 — 242-addition fix with helper checking headers+null+undefined superseded by #27793's 102-addition one-liner targeting only the actual bug path. Maintainer cited "slightly more elegant fix" when closing.)

### AP27. Quantitative Metrics in Performance PR Descriptions
For performance fixes, put before/after measurements (memory, latency, throughput, query count) in the PR Summary section, not in review comment threads. Reviewers may never find metrics hidden in inline discussions. Include: measurement methodology, environment, and magnitude of improvement.

(Evidence: n8n-io/n8n #27188 — ~250MB memory reduction (1GB→750MB) only surfaced in a reply thread, not the description; grafana/grafana #121382 — quantitative CI metrics in description merged quickly)

### AP28. Hiding a Feature Branch Under a Bug-Fix Title
If the title/body promise a small fix but the diff actually ships a WIP subsystem, a feature train, or multiple unrelated concerns, reviewers treat the PR as unreviewable at best and misleading at worst. Split the safe fix into its own PR, then stage the larger feature separately with issue or design approval.

(Evidence: anomalyco/opencode `#21091`, `#21094`, `#20456`)

### AP29. Maintainer Takeover Is a Positive Outcome

When a community PR has good substance but convention gaps, maintainers may push directly to your branch or absorb your work into an internal branch. This is a compliment, not a rejection — it means your work was worth finishing. Accept the takeover gracefully. If offered: "Do you want to implement this, or should I push the changes?", say yes unless you have time to iterate. The alternative (months in queue) is worse.

(Evidence: n8n-io/n8n #27814 — new node absorbed into internal branch with authorship preserved; #19758 — maintainer pushed credential restructure directly after 6 months)

### AP30. Scope Is a Queue-Time Multiplier in Bandwidth-Constrained Repos

In repos where maintainer bandwidth is the bottleneck (not CI or process), each additional feature in a PR multiplies queue time non-linearly. A 3-feature PR doesn't take 3x as long — it takes 6-12x because: (1) review cost is higher, (2) it gets deprioritized against smaller PRs, (3) partial acceptance is structurally difficult. Split multi-feature work into independent PRs that can merge independently.

(Evidence: n8n-io/n8n #19758 — 3 features bundled → 6 months; similar-scope single-feature PRs merged in 1-3 weeks)

### AP31. Cite Analogous Existing Code for Instant Credibility

When your fix mirrors an existing pattern in the codebase, explicitly name the file and function: "This follows the same approach as `load-nodes-and-credentials.ts`." Reviewers verify by comparison rather than from-scratch analysis. The reviewer's response becomes "follows the same patterns as expected" — the fastest possible approval.

(Evidence: n8n-io/n8n #24517 — 10-line fix citing existing pattern, instant single-round approval; reinforces general pattern 11)

### AP32. Real Tests Over Mocked Tests

When reviewers see heavy mocking in tests, they question whether the tests actually verify anything: "This to some extent defeats the purpose of the tests." Test with real functions wherever possible. Mocks should be limited to external I/O boundaries (HTTP calls, databases), not internal logic. If your test mocks 5+ functions, reconsider whether you're testing mock wiring rather than behavior.

(Evidence: n8n-io/n8n #25810 — reviewer explicitly rejected over-mocked tests; author removed mocks and tested with real functions, approved next day)

### AP33. Production Validation from Community Accelerates Merge

When other users confirm your fix works in their production environments, their comments become powerful evidence for reviewers. If you know users are running your branch, ask them to comment with their version and deployment context. Multiple independent confirmations spanning months and versions reduce reviewer risk perception to near zero.

(Evidence: n8n-io/n8n #22859 — two production confirmations spanning 2+ months (v2.1.2 → v2.6.3) contributed to zero-code-change approval; #24517 — users sharing temp hotfixes and reporting breakage accelerated triage)

### AP34. Scope Expansion Through Review Is a Time Trap

When a reviewer suggests expanding scope ("should we support all X, not just Y?"), carefully evaluate whether the expanded scope is worth months of additional review rounds. Sometimes the minimal-scope version (your original proposal) would have merged in weeks while the expanded version takes months. If you accept scope expansion, set clear boundaries and ask the reviewer to confirm the full list upfront rather than discovering new requirements incrementally.

(Evidence: n8n-io/n8n #17297 — started as 2-file Teams-only change, expanded to 23-file all-Microsoft-Graph-nodes change through review, took 192 days instead of potential weeks; #16612 — 2-file credential change was too shallow, successor needed 35 files)

### AP35. AI Submissions Require Human Supervision During Compliance Windows

In bot-gated repos, AI agents that open PRs without monitoring bot feedback in the first minutes will consistently lose to compliance bots. The agent writes excellent code and description, submits, and moves on — but the compliance bot fires within seconds and starts a countdown (often 2 hours) to auto-close. By the time anyone notices, the PR is dead. For AI-assisted contributions: (1) monitor the PR for bot comments in the first 5 minutes after submission, (2) fix any compliance issues immediately by editing the PR description, (3) set `maintainer_can_modify: true` on the fork, (4) write tests as CI-integrated tests (e.g., Vitest), not standalone scripts.

(Evidence: anomalyco/opencode `#20704` — technically excellent AI-generated PR with 3 bug fixes, upstream coordination, 4 test artifacts, killed in 2 hours by compliance bot; `#20701` — 707-line feature with screenshots/video, same fate)

### AP36. Study Existing Integration Patterns Before Adding New Ones

Before adding a new provider, plugin, or integration, study how the 3 most recent similar additions were done. The project may have an established pattern (models.dev for provider discovery, CUSTOM_LOADERS entries, extension points) that makes 90% of your initial implementation unnecessary. A 15-minute pattern study can turn a 200-line rejected PR into a 12-line accepted one.

(Evidence: anomalyco/opencode `#13765` — initial 200-line provider PR with dynamic model fetching rejected; final 12-line CUSTOM_LOADERS entry merged after author studied existing patterns)

### AP37. Sign the CLA Before Opening the PR

In CLA-required repos, an unsigned CLA is a hard gate that prevents any human from reviewing your code. Sign it before or at PR creation time — not during review. PRs with unsigned CLAs can sit for weeks with zero human engagement regardless of code quality, because maintainers won't invest time in code they legally cannot merge.

(Evidence: n8n-io/n8n #27171 — technically perfect 1-line fix with excellent description, 0 humans looked in 17 days because CLA unsigned; #26988 — unsigned CLA + other failures = 22 days of bot-only interaction; tensorflow/tensorflow #108327 — CLA never signed, 1500-line PR stale-closed after 71 days with zero code review; #88124 — CLA failure on day 1 may have deprioritized a trivially correct 1-line fix for 12 months)

### AP38. Signal Refactor Safety with [no-op] Tags

When a PR is purely mechanical (import swaps, constant relocation, code movement with no behavior change), say so explicitly at the top of the description: `[no-op — purely moving definitions around]`. This immediately sets risk expectations and lets reviewers skip behavioral analysis. A 60-file refactor can merge in under 2 hours with this signal. Combine with historical context explaining WHY the code was structured the old way and WHY it needs to change now.

(Evidence: grafana/grafana #122041 — 60-file refactor, +624/-581 net +43, merged in 1.5h with single approval after [no-op] tag)

### AP39. Debuggability Over DRY

Reviewers in observability-conscious projects value log specificity over code deduplication. A helper function like `conflictError()` that hides call-site context in logs will be flagged — even if it reduces code duplication. Keep error construction at the call site so logs show exactly where the error originated. This extends to any code where the primary consumer is a human reading logs.

(Evidence: grafana/grafana #121814 — reviewer flagged helper hiding call-site context; consistent with grafana's observability-first culture)

### AP40. Approval ≠ Merge: Follow Up After 3-5 Days

A reviewer approving your PR does not guarantee they will merge it. Reviewers may approve and forget to click merge, or may be waiting for CI or another approval. If your PR is approved but not merged within 3-5 days, ping the thread. Don't wait for the stale bot (30 days) — by then another PR may have independently fixed the same issue, making yours redundant.

(Evidence: grafana/grafana #119180 — approved day 1, reviewer never clicked merge, sat 31 days, closed because another PR fixed the same typo first)

### AP41. Target Maintainer-Neglected Areas for Fast-Track Merges

Every repo has subsystems the maintainers feel guilty about neglecting. Contributions to these areas get enthusiastic, rapid review because the maintainer is relieved someone is doing the work. Find these areas by scanning for: maintainer self-deprecation in issue comments ("I've been lackluster at maintaining this"), stale TODO labels, issues with maintainer "help wanted" labels but no assignee. Ping the maintainer who owns the neglected area directly with a one-sentence business case naming the downstream consumer.

(Evidence: anomalyco/opencode #21134 — maintainer: "I actually love merging things for ACP support because I've been lackluster at maintaining it myself" — merged in 3.5h for an external contributor; #20399 — Cloudflare provider fix attracted domain-expert reviewer from Cloudflare team in 18h)

### AP42. Use the Project's Preferred Communication Channel for Follow-Up

Many high-traffic repos have overwhelmed GitHub notification queues. Maintainers may explicitly state that a different channel (Discord, Slack, Zulip) is where they actually respond. Using the preferred channel for polite follow-ups reaches maintainers faster than additional GitHub comments or @-mentions.

(Evidence: anomalyco/opencode #20272 — maintainer explicitly: "GH notifications are overwhelming" and pointed to Discord)

### AP43. Cross-Reviewer Coordination with "LGTM with Hold"

In multi-reviewer projects (Kubernetes, large Apache projects, CNCF repos), one reviewer can signal approval while explicitly blocking merge to wait for another reviewer's acknowledgement. The pattern: `/lgtm /approve /hold for @person to ACK`. This is a coordination signal — the held reviewer knows to look, the PR author knows what's outstanding, and the PR does not accidentally merge before the right eyes have seen it.

When you see this pattern on your PR, ping the held reviewer directly with a brief summary of what they are being asked to ACK. Do not ping the approving reviewer — they have already done their job.

(Evidence: k8s #137032, #138035 — reviewers used LGTM+hold to coordinate across SIG boundaries; held reviewer response time dropped when authors pinged them directly)

### AP44. Self-Imposed Hold with Documented Verification

For changes where manual verification is essential but not yet complete, put your own PR on hold before requesting review: add a `/hold` comment explaining what you are testing. Complete testing, document results in a follow-up comment, then cancel with `/hold cancel`. Reviewers see both the claim and the evidence in sequence rather than taking your word for testing — this earns one-pass approvals and preempts "how did you test this?" questions entirely.

(Evidence: k8s #138035 — author self-held, posted test results 48h later, reviewer approved without further questions on the verification aspect)

### AP45. Causal Chain in First Paragraph for Regression Fixes

For regression fixes, link three things in the first 3 sentences: (1) the specific commit or PR that introduced the regression, (2) the tracking issue where it was reported, (3) the alternative approaches you considered and why you rejected them. This eliminates the most common reviewer question — "what caused this?" — before it is asked, and shows archaeological work rather than symptom patching.

Format: "Regression introduced by [commit/PR link] in [version]. Tracked in [issue link]. Alternative: [X] would require [reason it is worse], so this PR uses [chosen approach] instead."

(Evidence: k8s #138178 — this structure got first-round approval; PRs without the regressing commit link required a round-trip asking "what introduced this?")

### AP46. Document CI Retests with Classification

When retesting failing CI, post a comment that: (1) names the specific failing test, (2) classifies it as related or unrelated to your change, and (3) links evidence (flaky test tracking issue, recent failures on main, or a specific log line). A bare `/retest` leaves reviewers uncertain whether the failure is a blocker. A classified retest comment — "Retesting `TestFooBaz` — unrelated flaky test, tracked in #12345, also fails on main" — removes reviewer uncertainty immediately and prevents holds on CI noise.

(Evidence: k8s #138178 — classified retest comments prevented reviewers from blocking on CI noise; unclassified retests in peer PRs led to reviewer holds pending investigation)

### AP47. Performance Awareness and Cache Safety in Subsystem Changes

Before submitting changes to performance-sensitive subsystems (kubelet, scheduler, storage controllers, hot-path handlers), profile the API call count your change introduces per unit of work. Know the cost. One reviewer caught 3-5 CRI API calls added per pod per reconcile — an order of magnitude regression — and required a complete redesign before approval.

For stateful subsystems: never mutate objects returned from caches or informers. Cache objects are shared references. Mutating them corrupts the cache and produces bugs that surface only in integration or e2e tests, not unit tests. Always deep-copy before mutating: `obj := existingObj.DeepCopy()`.

(Evidence: k8s #134660 — reviewer caught 3-5 CRI calls/pod/reconcile, forced redesign; DeepCopy violation identified in same PR, caught only in integration test suite)

### AP48. Fork-Master Contamination Kills PRs Instantly

Never push PRs from your fork's `master` (or `main`) branch. If you accumulate unrelated work on `master`, every PR will carry months of irrelevant commits, inflating a 5-line fix into a 500-line diff. Always create topic branches from upstream's default branch. If you already contaminated `master`, close the PR and open a new one from a clean topic branch — self-correction is respected.

(Evidence: tensorflow/tensorflow #115135 — 5-line TFLite fix buried in 567-line diff from 3 months of fork-master accumulation; author self-corrected to clean #115190 within minutes)

### AP49. Adopt Reviewer Design Suggestions — They Improve Outcomes

When a reviewer suggests a better approach (generalize a utility instead of point-fixing, use a different test pattern), adopt it even if your original approach "works." Reviewers who invest in design feedback are signaling they want to merge the PR — they wouldn't bother otherwise. Prompt adoption (within 24-48 hours) of design suggestions correlates with fast approval across all repos analyzed.

(Evidence: tensorflow/tensorflow #105000 — reviewer suggested generalizing `ReadStringsFromEnvVar` with custom delimiters instead of point fix; author adopted, approved; #100869 — reviewer requested `@parameterized` convention, author delivered next day, approved in 48h)

### AP50. Second Attempts Win When First Attempts Teach

A closed first PR is preparation, not failure. Open a fresh PR that: (1) references the prior attempt, (2) explicitly lists what changed based on feedback, (3) addresses every piece of prior reviewer feedback. Reviewers remember the prior attempt — showing you learned from it builds trust faster than a perfect first submission.

(Evidence: tensorflow/tensorflow #100869 — successful second attempt after #99904, itemized 4 improvements from prior feedback, merged in 17 days; #115135 → #115190 self-correction)

### AP51. Naive Mechanical Changes Without Verification Are Reputationally Toxic

Automated find-and-replace across a codebase without manually verifying each change site is worse than not contributing at all. A 13% error rate (syntax errors, corrupted docstrings) signals to reviewers that you didn't read your own diff. Run the test suite, review every hunk, and verify the build compiles before opening the PR. This applies doubly to AI-assisted contributions where the tool may not distinguish code from prose.

(Evidence: tensorflow/tensorflow #111046 — `except:` → `except Exception:` find-and-replace corrupted `if may_exit_via_except:` into syntax error and turned docstring prose "except:" into "except Exception:"; 5 of 38 replacements wrong)

### AP52. AI Co-Author Trailers Break CLA Gates

Never use `Co-Authored-By: claude`, `Co-Authored-By: copilot`, or any AI identity as a git commit co-author in CLA-required repos. CLA bots check every committer identity, and non-human accounts cannot sign. The CLA gate blocks permanently with no workaround. Use comment-level disclosure in the PR body instead ("AI-assisted PR (Claude). All tests verified locally."), or a human co-author trailer. Squash AI-paired commits to a single human-authored commit before pushing.

(Evidence: berriai/litellm #25300 — `Co-Authored-By: claude` created permanent CLA block, forced complete refile; #24268 — body-level AI disclosure merged without issue)

### AP53. Self-Correction and Refiling Is a Valid Contributor Pattern

When you discover a blocking issue after submission (0% patch coverage, CLA identity error, missing scope), self-closing and refiling with fixes is a normal, positive pattern — not a failure. Close with a brief explanation, reference the original PR number in the new one, and open the replacement immediately. Maintainers respect contributors who recognize and fix their own mistakes rather than waiting for reviewer feedback on issues they already know about.

(Evidence: berriai/litellm #25433 → #25437 — self-closed after 22 minutes when Codecov showed 0% patch coverage; #25300 → #25353 — refiled to fix CLA and cyclic imports)

### AP54. Codecov Patch Coverage 0% Is a Red Flag Even When Tests Pass

Unit tests that replicate production logic in isolation (building the URL separately instead of calling the handler) show 100% test pass rate but 0% Codecov patch coverage on the actual production lines. Codecov's patch-coverage report is the definitive signal for whether your tests exercise the code you changed. Check it before requesting review — 0% on changed production lines is a predictable rejection signal even when all test suite runs are green.

(Evidence: berriai/litellm #25433 — all tests passed but 0% patch coverage on handler lines; author self-closed to refile with proper integration tests)

### AP55. Follow-Up Fix PRs Build Trust Faster Than New Features

Reviewing recently merged PRs and submitting follow-up PRs that fix issues found (security gaps, error handling, cross-platform bugs) is one of the highest-leverage contribution patterns for external contributors. It demonstrates code review capability, builds maintainer trust, and faces lower review friction because the context is fresh and the PR author is "fixing problems" rather than "adding complexity." Bundle related fixes with clear per-issue breakdown.

(Evidence: browser-use/browser-use #4590 — reviewed merged #4514, found 3 security/correctness issues, submitted fix PR that merged in 3h; reinforces general pattern 45)

### AP56. Unsolicited Infrastructure PRs Are Dead on Arrival

Don't submit CI workflows, tooling integrations, or build system changes to repos without an existing issue, discussion, or maintainer request. Unsolicited infrastructure PRs — especially those introducing external dependencies with elevated permissions (e.g., `id-token: write`) — get silently ignored or closed. The bar for CI/tooling contributions is higher than code contributions because they affect every developer on the project.

(Evidence: browser-use/browser-use #4614 — CI workflow for external skill-publishing tool, +35/-0 across 1 file, closed in 3 days with zero human engagement; no issue, no prior discussion, no maintainer request)

### AP57. Resolve CHANGES_REQUESTED Before Merge — Or Face a Revert

A maintainer's CHANGES_REQUESTED review is a semantic objection that must be addressed before merging. Merging over an unresolved conceptual objection ("why this value?") will surface as a revert even if CI is green, bot reviews are positive, and tests pass. Mock-only tests cannot validate semantic correctness of field mappings, value choices, or business logic — they only verify plumbing. If a maintainer questions the fundamental approach, stop and answer before proceeding.

(Evidence: berriai/litellm #25340 — merged over ishaan-berri's CHANGES_REQUESTED, immediately reverted by krrish-berri-2 because the semantic value assignment was wrong; mock tests only verified the keyword arg was passed, not that the value was correct)

### AP58. Clear the Bot Round Before Humans Engage

In repos with automated code review bots (cubic-dev-ai, GitHub Copilot, CodeQL, etc.), human reviewers increasingly wait until bot comments are resolved before reviewing. The workflow is: bot posts inline issues → author responds to all → human reviewer glances and approves. Unresolved bot threads signal the PR isn't ready. Reply to every comment: "Fixed — [what changed]", "Won't fix — [design rationale]", or "Acknowledged — [risk mitigation]." A well-reasoned "won't fix" is a complete response.

(Evidence: n8n-io/n8n #27688 — 10 bot comments, all replied to within 2h, human reviewer approved same day; #28021 — @claude /review caught a real test inconsistency that the author fixed before merge; grafana/grafana #120560 — Copilot found 6 real issues before human review)

### AP59. Separate Public API Response Shapes from Internal Types

When adding public API endpoints, create an explicit mapper layer between internal service types and the public response schema. If internal types leak into the API response, any internal refactor becomes a silent breaking change. In schema-heavy projects, reviewers will escalate through rounds: raw passthrough → explicit mapper → schema-validated mapper (e.g., Zod). Start with the strictest layer to avoid 3 review rounds.

(Evidence: n8n-io/n8n #27637 — reviewer escalated through 3 rounds to get from raw passthrough to Zod-schema-validated mapper + negative-scope test)

### AP60. Issue Invitation Is Not an Open Call

When a maintainer explicitly invites a specific person to submit a PR ("PR with your proven implementation welcome"), that invitation belongs to that person. Jumping in with your own implementation — even a technically sound one — will be closed immediately on process grounds, regardless of code quality. Before implementing a feature linked to an issue where someone was invited, comment on the issue first to ask if the invited person plans to submit. If no response within a reasonable window (days, not hours), then proceed.

(Evidence: pydantic/pydantic-ai #5021 — closed in 88 minutes because a different contributor's invitation was hijacked; maintainer closed without reviewing the code)

### AP61. Match Fix Complexity to Problem Complexity

Maintainers prefer the simplest correct fix. If a bug can be fixed with a one-liner per affected file, don't introduce a new shared utility that requires migrating all consumers. A half-applied abstraction (some files migrated, some not) is actively worse than no abstraction — it creates two patterns instead of one. Before implementing a fix, ask yourself: "Could this be solved with a simpler, more localized change?" If unsure, ask the maintainer on the issue before coding.

(Evidence: pydantic/pydantic-ai #5003 — maintainer closed a shared utility PR in 4 hours, preferring a one-line `ImportError` → `ModuleNotFoundError` change per provider)

### AP62. "Right Fix, Wrong Layer" — Confirm the Fix Belongs Here

Before implementing a fix, verify that the root cause lives in the component you're patching. If a bug manifests in a server but the root cause is a protocol violation by clients, maintainers will reject the server-side workaround — even if it's technically correct and users are in pain. Ask on the issue: "Is this the right place to fix this, or should this go to [SDK/client/spec]?" A correct fix in the wrong architectural layer is still a rejection.

(Evidence: modelcontextprotocol/servers #2812 — 88-day discussion, community pain confirmed, rejected because type coercion belongs in the MCP SDK, not individual servers)

### AP63. Empirical Data in PR Descriptions Collapses Review Time

Include quantitative evidence — fuzz-test crash rates, before/after metrics, cross-system comparisons — in PR descriptions. A one-line fix backed by a data table (e.g., "61/65 crash rate → 0/65") makes the case self-evident and absorbs all reviewer questions before they're asked. The richer the description, the less time the reviewer spends.

(Evidence: modelcontextprotocol/servers #3515 — one-line fix with crash-rate data merged in 5 days with zero review comments; #3545 — threat model + test counts → 2-day merge)

### AP64. Proactively Ping Reviewers After Queue Timeout

In repos with no automated reviewer routing (no triagebot), directly @mention the maintainer after 2 weeks of silence. This is expected behavior, not rude. Cross-reference companion PRs to transfer trust from already-merged work. Passive waiting alone will not unblock your PR — the author must self-rescue.

(Evidence: modelcontextprotocol/servers #3230, #3229 — author pinged olaservo by name referencing related merged PR; batch got attention; #2609 — maintainer self-rescued their own PR after 6 months by refreshing and rebasing)

### AP65. Don't Spray-Submit Multiple Similar PRs Simultaneously

Submitting multiple PRs covering the same type of change (e.g., 3 annotation PRs for different packages) signals a bulk/automated contribution rather than coordinated engagement. If a trusted contributor already has competing PRs open, your batch gets silently bulk-closed. Submit one PR, get it merged, build trust, then expand.

(Evidence: modelcontextprotocol/servers #3643, #3655, #3664 — 3 annotation PRs by same author all bulk-closed within 1 second; competing PR by trusted contributor preferred)

### AP66. Use Review Bots as Interactive Pair Programmers

In repos with automated code review bots (Greptile, Copilot, CodeRabbit, etc.), don't just passively respond to bot feedback — actively ask the bot for help. `@botname how would you address [concern]?` or `@botname suggest a fix for [issue]` turns the bot from a critic into a collaborator. Implement the suggestions as follow-up commits with SHA references. This interactive loop is often faster than independent debugging and produces a documented reasoning trail that human reviewers can follow.

(Evidence: berriai/litellm #24135 — author used `@greptileai how would you address…` interactively, implemented suggestions as commits, merged in 10h with zero human review; #23532 — 5 interactive Greptile rounds drove quality from initial to production-ready)

### AP67. Bundle Docs-Only Changes with Code Changes in High-Volume Repos

In repositories with high PR volume and limited maintainer bandwidth, standalone docs-only PRs have very poor merge odds. They're low-priority for reviewers and easily forgotten until stale bots close them. Bundle documentation fixes with related code changes to ensure they ride the code review. If a docs fix is truly standalone, ping the specific maintainer who owns the docs area — passive submission will die from neglect.

(Evidence: berriai/litellm #16302 — technically correct, CLA-signed, 1-file docs fix stale-closed after 5 months with zero maintainer engagement; community recognized it as valid but no one had merge authority)

### AP68. The Two-Ping Rule — Set a PR Budget Before You Start

Before opening any external-contributor PR, decide in advance how many days you're willing to champion it. The operational rule: after opening the PR, you get at most **two polite pings** (~1 week apart) to request review. If the second ping also goes unanswered within 3-4 days, the PR is functionally dead. Continuing to wait is sunk-cost fallacy — the maintainer team has signaled they won't engage.

**What the signal looks like**:
- No human review comments, only bot reviews
- Author has already addressed all bot feedback
- Pings are polite and well-timed
- Zero maintainer activity on the PR thread, even a "thumbs up" reaction

**The rescue options (in order)**:
1. File an issue tagging the maintainer who owns the area: "Hi, I have PR #N waiting on review for this — happy to rework if the approach is wrong"
2. Post in the project's Discord/Slack with a one-line summary
3. Find a related active PR by the same maintainer and briefly mention your PR in its thread
4. **Self-close with a clean note** — preserve your reputation for future contributions. "Closing due to lack of review bandwidth — will revisit when the platform-support roadmap changes. Thanks anyway!"

A graceful self-close at day 10-14 beats a bitter self-close at day 40. Platform-compat fixes (Windows, BSD, niche architectures) hit this dead-zone most often because the core maintainer team doesn't run those platforms daily — before investing, check whether any similar PRs have merged in the past 90 days.

(Evidence: browser-use/browser-use #4292 — giulio-leone's technically excellent Windows tunnel fix with issue link, root-cause analysis, and proactive bot-fix commits. Author pinged twice (day 2 and day 5). Zero human response in 18 days. Author self-closed on day 18 without comment. PR scored higher on every dimension than the merged PRs in the same batch — quality wasn't the problem; attention was.)

### AP69. Bot Approval Is Not Design Approval

Automated code reviewers (cubic-dev-ai, Copilot, cursor, Greptile) perform static analysis: type checking, null handling, obvious bug patterns, style. They do NOT evaluate whether your approach matches the maintainer's mental model of the correct fix. A bot verdict of "no issues found" is a necessary gate but not a sufficient one, especially in areas with internal utilities you may not know exist.

**Before submitting a PR in any "deep-coupling" area** (LLM schema conversion, browser lifecycle, serialization formats, authentication flows), explicitly grep for existing helper utilities:
- `grep -r "Optimizer\|Normalizer\|Flatten\|Resolve" --include="*.py"`
- Look for `service.py` / `utils.py` files in the area you're touching
- Check if the module has a "hidden" helper that the public API doesn't surface

If you find a helper that looks relevant, use it — or at minimum, open an issue comment asking "I see `SchemaOptimizer` handles X — is using it the right approach here?" before writing code. This 2-minute check prevents multi-day rework.

(Evidence: browser-use/browser-use #4442 — cubic reported "No issues found across 1 file" on the Bedrock schema fix. Maintainer @laithrw still rejected the PR because the approach (pass raw schema through) had a runtime semantic issue cubic couldn't see: "passing the raw schema still confuses the model because of unresolved references." The maintainer's own superseding fix #4524 used an existing `SchemaOptimizer` utility that flattened references — a helper the external contributor never grepped for. Same pattern observed for #4421 and #4448.)
