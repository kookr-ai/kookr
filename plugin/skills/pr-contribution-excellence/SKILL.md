---
name: pr-contribution-excellence
description: Patterns for excellent open-source PR contributions, distilled from analyzing real PRs across repositories
keywords: pr, contribution, review, open source, pull request, code review, upstream, fork
---

## When to Use

When preparing a PR for any open-source project. These patterns are distilled from analyzing 505+ real closed PRs in active open-source repositories (openai/codex, langchain-ai/langchain, rust-lang/rust, grafana/grafana, langgenius/dify, anomalyco/opencode, n8n-io/n8n, ggml-org/llama.cpp, kubernetes/kubernetes, tensorflow/tensorflow, browser-use/browser-use, pydantic/pydantic-ai, berriai/litellm, mem0ai/mem0, modelcontextprotocol/servers, milla-jovovich/mempalace), including external contributor PRs that were successfully merged, rejected, and reverted.

**This file contains universal patterns only.** Repo-specific patterns live alongside this SKILL.md at `repo/<slug>.md`. Distillation history is in the sibling `evidence.md`. Transient distillation state (state.json, learnings-raw.md) stays in `~/.claude/<slug>-pr-lessons/` — those dirs are working state for the per-repo distillation playbooks and are not bundled.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Read contribution guidelines before first PR | Submitting without reading CONTRIBUTING.md | Read and follow every guideline the project publishes |
| 2 | Link the motivating issue in PR body | PR body says "fixes a bug" with no reference | "Fixes #123" or "Relates to #456" in first paragraph |
| 3 | Fill out the PR template completely | Deleting template sections or leaving TODO | Answer every section; write "N/A" if truly not applicable |
| 4 | Include tests for behavioral changes | Adding a feature with no test coverage | Every bug fix and feature gets at least one test |
| 5 | Keep PRs focused on a single concern | Fixing a bug + refactoring + adding a feature | One PR per concern; split if scope grows |
| 6 | Include exact verification commands | "I tested it" with no reproducible steps | List the exact test/lint commands a reviewer can copy-paste |
| 7 | Scale description depth to behavioral risk | One-liner for a security fix; novel for a rename | Security/trust changes need full Why/Scope/Shape; pure refactors can be brief |
| 8 | State behavioral neutrality when applicable | Leaving reviewer to guess if behavior changed | "This does not change runtime behavior" when true |
| 9 | Defer scope expansion to follow-up PRs | Adding reviewer-suggested work to current PR | "Moved to follow-up PR #N to keep this PR focused" |
| 10 | Be transparent about testing limitations | Claiming full coverage when you didn't run all suites | Document what you couldn't test and why |
| 11 | Check `git diff main...HEAD` after every rebase | Accidentally including unrelated rebase changes | Drop unrelated test fixtures, format changes, etc. before requesting review |
| 12 | Run automated review tools before requesting human review | Letting reviewers find issues bots would catch | Use @codex review, CI linting, etc. iteratively before requesting humans |
| 13 | Adopt reviewer suggestion blocks verbatim | Rephrasing reviewer-provided comment wording | Use the exact text they gave; don't "improve" it |
| 14 | Disclose AI assistance in co-author lines | Hiding that Codex/AI helped write the code | "Co-authored-by: Codex <noreply@openai.com>" or similar |
| 15 | Comment on the issue BEFORE writing any code | Silently opening a PR without discussion in the issue thread | Comment to announce intent ("I'd like to work on this"), wait for acknowledgment if required |
| 16 | Never work on issues assigned to someone else | Doing "part of the work" on someone else's assigned issue | Pick a different issue entirely; don't split assigned work without the assignee's agreement |

## Automation-First Repos

Some repositories use bots as hard gates before a maintainer ever looks at the diff. In these repos:

- Treat issue-first or design-first policies as approval gates, not paperwork. Opening an issue minutes before the PR does not demonstrate maintainer buy-in for a new feature.
- Do not substitute Discord, Slack, forum chatter, or contributor-side discussion for a trackable issue/design thread. If maintainers want the decision recorded on GitHub, off-thread agreement will not save the PR.
- Use the literal PR template headings and checklist when compliance is automated. Equivalent prose can still fail the gate.
- Use the exact issue-closing syntax the bot expects. `Fixes #123` or `Closes #123` may pass where `Issue: #123` or a vague mention still fails automation. The keyword must appear as a bare standalone line — embedding `Closes #123` inside a prose sentence under a section header can fail the bot's regex even though a human would read it correctly.
- Passing automation only buys eligibility, not attention. Green CI plus a compliant body can still stale-close if the change is not on the repo's priority list.
- Search open and recently closed PRs on the same issue before coding. In crowded feature threads, a technically valid stepping-stone PR can still die if broader work is already active.
- Follow the maintainer-documented contribution venue or extension seam. A well-tested patch in the wrong repo/package/layer can still be rejected or silently closed.
- Validate the effective diff after rebases, merges, and branch syncs. A PR that claims to be a tiny fix but carries unrelated history becomes unreviewable even if the title and body are compliant.
- Do not benchmark your PR against same-day merges from vouched contributors, collaborators, or maintainers. Trusted tiers often have a separate fast path with looser issue-link and description expectations.
- Answer maintainer asks for screenshots, repro steps, or follow-up proof in the next revision cycle. Silence after a specific request often ends the PR without formal rejection.
- Screenshots and tests support UI/product changes, but they do not replace design approval or maintainer sponsorship.
- For docs and localization work, preserve the canonical source document and review terminology manually. Community reviewers often spot AI-like phrasing, wrong source-file edits, or duplicate translation work before maintainers do.
- Small green PRs are not “done” when automation passes. If you get a layout/order nit or other low-friction feedback, respond quickly or the branch may simply age out.
- For AI-assisted contributions in bot-gated repos, the compliance window (often 2 hours or less) requires active human supervision at submission time. An agent that opens a PR and walks away will always lose to a compliance bot that auto-closes before any maintainer can intervene. Monitor the first few minutes after submission and fix any bot-flagged issues immediately.

(Evidence added from `anomalyco/opencode`: `#20092`, `#21073`, `#12007`, `#12023`, `#20101`, `#20102`, `#11961`, `#11626`, `#10190`, `#20956`, `#21047`, `#21053`, `#21054`, `#21016`, `#21070`, `#20997`, `#15912`, `#11905`, `#11874`, `#11216`, `#10714`, `#10254`, `#7584`, `#6850`)
(Additional `anomalyco/opencode` evidence: `#20936`, `#20932`, `#20928`, `#20929`, `#6170`, `#20801`, `#16952`, `#11378`, `#20545`, `#20701`, `#20704`, `#17105`, `#13765`)

## Competitive Dynamics

Popular issues and crisis events create competitive pressure. Observed across multiple repos:

- **First-mover advantage on popular issues.** When an issue attracts attention from multiple contributors, the first viable PR almost always wins. Later duplicates die regardless of quality. Before starting work, search for existing PRs on the same issue AND for PRs touching the same files.
- **Maintainer supersession.** When an external PR has scope issues or uses the wrong approach, maintainers often cherry-pick useful commits into their own PR rather than requesting revisions. Keep scope minimal and use existing internal utilities (grep the codebase) to avoid being superseded.
- **Crisis PR dynamics.** During security incidents or production outages, the most decisive fix wins (remove > pin > mitigate). Maintainers almost always beat external contributors on crisis PRs because they have context, access, and merge authority. External contributors should pick up follow-up work after the crisis merge.
- **Internal knowledge moat.** Maintainers know about internal utilities, issue trackers, and telemetry that external contributors don't. Study the codebase deeply before proposing solutions — your manual implementation may be superseded by a one-liner using an existing utility.
- **Trust is per-PR, not per-contributor.** Even trusted contributors can have PRs stale-close if they don't actively champion them. Each PR must earn its own attention through sustained engagement.
- **Architecture gates precede code quality.** In repos with strong architectural opinions, PRs can be stopped at the design layer despite having extensive tests. Validate the extension point and approach before writing code. If you're extending a system (adding a new processor, capability, or provider), check that the mechanism you're using actually works the way you assume. (Evidence from `pydantic/pydantic-ai`: #3807 stopped because history_processors are pre-send only, #4851 blocked because no in-tree consumer existed)
- **Mirror existing patterns for fastest acceptance.** Explicitly framing your PR as "mirrors how [existing feature] already works" is the strongest justification for a new addition. It signals you've studied the codebase, reduces reviewer cognitive load, and pre-answers design questions. (Evidence from `pydantic/pydantic-ai`: #4906 mirrored WebSearch/DuckDuckGo → merged in 3 days)
- **Problem relevance decays.** For edge-case fixes and workarounds, validate the underlying problem is persistent before investing heavily. Fast-moving projects can make your fix irrelevant if the ecosystem evolves around you. (Evidence from `pydantic/pydantic-ai`: #3206 closed after 170 days because "small models stopped misbehaving")
- **Stale sibling PRs are free prior art.** Search for closed/stale PRs on the same issue and incorporate their work with attribution. Maintainers appreciate this and it avoids re-litigating solved problems. (Evidence from `pydantic/pydantic-ai`: #4528 incorporated stale #4072)

(Evidence from `browser-use/browser-use`: 7 duplicate PRs for issue #4385, maintainer supersession in #4401/#4507/#4524, crisis response #4515 beating #4507, trusted contributor #3926 stale-closed despite passing evaluations)
(Additional evidence from `mem0ai/mem0`: 40% of 25 analyzed PRs affected by competition; 4-way pileup on datetime filtering issue #4591; 6-PR cluster for memory leak issue #4098; "superseding PR" pattern — #4515 credited #4184 while extending to all backends → merged cleanly)

## Volume-Over-Quality Anti-Pattern

High-velocity PR submission with low quality signals bot-generated spray and gets ignored:

- Creating new PRs for each review iteration instead of amending the existing one.
- Submitting PRs for features/platforms the project has explicitly deferred or declined.
- Not reading project scope decisions, contribution guidelines, or ADRs before contributing.
- Submitting 1+ PRs per day to the same repo with no merges — maintainers recognize this pattern and disengage.
- Incomplete edge case analysis in fixes when the maintainer's version handles more cases.

A single well-researched PR beats 30 incomplete ones. Quality >>> quantity.

**Some repos enforce volume limits with bots.** A per-author hard cap on active PRs is becoming a common defense against AI-generated spray. When enforced, high-quality PRs are auto-closed purely for exceeding the cap — no human ever reviews. Before pushing a new PR, count your active PRs in that repo (`gh pr list -R owner/repo --author @me --state open | wc -l`). If the repo has a documented cap, keep at least one slot below it so you can respond to bot findings without exceeding the cap. High-output contributors (humans or AI agents) should treat the cap as the binding constraint, not quality.

(Evidence from `browser-use/browser-use`: contributor with 30 PRs, 0 merged in 26 days — 14/30 targeted Windows when the project explicitly defers Windows support)
(Additional evidence from `mem0ai/mem0`: contributor submitted 4 PRs (#4409-4412) on the same day with no linked issues — all 4 batch-closed simultaneously 11 days later with zero interaction)
(Additional evidence from `openclaw/openclaw`: `openclaw-barnacle[bot]` auto-closes any PR when the author has more than 10 active PRs. Two high-quality PRs from EronFan (#64431 5/5 Greptile confidence; #64482 clean template) were killed within 5–13 minutes of opening. An older XS docs PR from ShionEria (#51089) was also self-closed 21 days in because the author needed to free a slot for higher-priority work.)

## Pre-Submission Checklist

Before opening any PR, verify:

- [ ] **You commented on the issue thread BEFORE writing code** (non-negotiable — no silent PRs)
- [ ] **The issue is not assigned to someone else** (if it is, you should not be here)
- [ ] `git diff --stat` matches every file mentioned in your description (incomplete diffs are instantly fatal)
- [ ] No open PRs already exist for this issue (first-mover advantage is decisive)
- [ ] The feature/platform you're fixing is in-scope per project docs/ADRs (don't contribute deferred work)
- [ ] CLA/DCO is signed proactively (hard gate in many repos)
- [ ] You've grepped for existing utilities that might solve your problem more simply
- [ ] Bot-flagged issues from prior PRs are addressed (if applicable)

## The 7-Section Template (Proven for External Contributors)

This structure produced the cleanest external contributor merge observed: zero inline comments, one-line approval. Use for any non-trivial bug fix or feature:

```markdown
## TL;DR
{One paragraph: what changed and why}

## Problem
{What's broken/missing and why it matters to users}

## Mental model
{The conceptual framework for understanding the change.
Two tiers of X, three states of Y, etc.
This pre-answers "why did you make this choice?" questions.}

## Non-goals
{What this PR explicitly does NOT do.
Pre-empts "why didn't you also fix X?" suggestions.}

## Tradeoffs
{What downsides you accepted and why they're acceptable.
Shows you considered alternatives.}

## Architecture
{Structure of the change: new modules, modified paths, method tables.
Replaces the reviewer's need to reverse-engineer your diff.}

## Tests
{List each test by name with what scenario it covers.
Not "added tests" — describe what each test verifies.}
```

**Why it works**: The description is intentionally longer than the code change. For external contributors, this is the correct ratio — it front-loads the reviewer's understanding so they can focus on correctness, not comprehension.

(Evidence: #15759 +457/-89 with 7-section description → zero inline comments; #15513 +672/-32 with same structure → approved after 4 scope questions)

## The Security Fix Template

For security/trust-boundary fixes, use this 4-section structure:

```markdown
## Summary
{What changed — fail-closed instead of fail-open, etc.}

## Root cause
{WHY the old behavior was wrong — explain the threat model.
This section distinguishes good security PRs from ordinary ones.}

## Changes
{Specific behavioral changes, listed concisely}

## Validation
{Exact test/clippy/fmt/lint commands you ran}
```

(Evidence: #15909 — approved in 15 minutes with one readability nit)

## Pattern Index

Full text in `patterns.md` (same directory). IDs are stable identifiers —
distillation updates entries in place rather than appending duplicates.

**Patterns** (patterns.md):

- P1 Description Structure by PR Type
- P2 Behavioral Risk Drives Review Effort, Not Line Count
- P3 Scope Discipline Is the #1 External Contributor Concern
- P4 Iterative Bot Self-Review Before Human Review
- P5 Transparency About Testing Limitations Builds Trust
- P6 "Does Not Change Behavior" Is a Reviewer Accelerator
- P7 Frame Removals as Eliminating Misleading Behavior
- P8 Balanced Review Response: Defend and Concede Appropriately
- P9 Proactive Debugging Narratives Earn Goodwill
- P10 Root Cause Over Symptom Fix
- P11 Match Existing Patterns to Reduce Review Burden
- P12 Trust Tiers Determine Review Speed
- P13 Cut Scope to Unblock Merges
- P14 Show the Bug Inline in Descriptions
- P15 Handle Setbacks and Rejections Gracefully
- P16 Exact Verification Commands Are Table Stakes
- P17 Screenshots for CLI/System-Level Changes
- P18 Follow-Up Sections De-Risk Large Changes
- P19 The Prep-Work + Execution PR Pair
- P20 Cross-Boundary Cleanup Must Be Atomic
- P21 In Bot-Gated Repos, Process Compliance Comes Before Code Quality
- P22 Do Not Copy Trusted-Insider Shortcut Patterns As An External Contributor
- P23 Process Compliance Before Code Quality
- P24 Description Brevity Scales with Change Size
- P25 Claim the Issue Before Writing Any Code
- P26 Subtool Changes Go to Subtool Repos
- P27 Use Project-Specific Formatting Tools
- P28 Revert PRs Need Empathy and Structure
- P29 Automated/Bulk PRs Are Unwelcome
- P30 Follow Up on Maintainer Suggestions
- P31 Survive Stale Bots Through Persistence
- P32 Search for Duplicate PRs AND the Target Branch Before Submitting
- P33 Squash-Merge Repos: PR Title IS the Commit Message
- P34 Before/After Visual Evidence Accelerates Review
- P35 Expect Both Bot and Human Review
- P36 Feature Toggle / Feature Gate Discipline in Large Projects
- P37 Self-Annotate Critical Diff Lines
- P38 Split Cross-Layer Changes into Paired PRs
- P39 Link to External Evidence When Correcting Documented Drift
- P40 Batch-Address All Review Comments in One Session
- P41 Number Stacked PRs with "(1/N)" Convention
- P42 Document Design Tradeoffs in "Implementation Notes"
- P43 Show Migration Evidence for Every Supported Platform
- P44 Over-Test to Eliminate Review Comments
- P45 Close Superseded PRs with Thread Context
- P46 Get Design Alignment Before Coding Non-Trivial Changes
- P47 Fix Regression Side-Effects In-PR
- P48 Stabilization/Mechanical PRs Are High-Confidence Entry Points
- P49 CC Domain Experts Alongside Assigned Reviewers
- P50 Stale CI = Abandoned PR in High-Velocity Repos
- P51 Bot-Delegated Review Culture
- P52 Verify "Unnecessary" Code Before Removing It
- P53 Get Policy Buy-In Before Behavioral or Architecture-Level Changes
- P54 Build a "Pattern Franchise" for Fast Review
- P55 Parity Fixes Are Low-Friction Entry Points
- P56 CI Responsiveness > First-Push Perfection
- P57 In Template-Gated Repos, Equivalent Content Does Not Count As Compliance
- P58 Eligibility Is Not Maintainer Priority In Stale-Bot Repos
- P59 Clean Branch History Is A Reviewability Signal
- P60 Use Hardware-Normalized Metrics for Performance PRs
- P61 Hardware-Owner Reviewers Substitute for Automated CI
- P62 Before/After Examples Are the Strongest Bug-Fix Description Pattern
- P63 Include Production Error Frequency to Add Urgency
- P64 You Can Argue With Bots Using Design-Intent Reasoning

**Anti-Patterns** (patterns.md):

- AP1 Scope Creep from Rebase
- AP2 Hiding Testing Gaps
- AP3 Expanding Scope During Review
- AP4 Minimal Description for High-Risk Changes
- AP5 Defensive Responses to Review Feedback
- AP6 Ignoring or Dismissing Bot Feedback
- AP7 Leaving Duplicate Branches Open
- AP8 AI-Generated PR Detection Signals
- AP9 Rework After Regression, Don't Abandon
- AP10 Split Mechanical Changes from Controversial Decisions
- AP11 AI-Generated Code Without Manual Review
- AP12 Rephrasing Reviewer-Provided Wording
- AP13 Sloppy Commit Messages as an External Contributor
- AP14 Large Features as First Contributions
- AP15 Self-Filing Issues to Satisfy Process
- AP16 Massive PRs Without Description
- AP17 Pinging Maintainers Without Escalation Plan
- AP18 Drive-By PRs Without Claiming the Issue First
- AP19 Touching Infrastructure Maintainers Want to Own
- AP20 Broken Diffs from Botched Rebases
- AP21 Enterprise/License-Sensitive Areas Are Off-Limits
- AP22 Design Correctness > CI Status for Core Infrastructure
- AP23 Structured Change Tables for Mechanical Refactors
- AP24 Use Non-Closing Issue Links for Series Work
- AP25 Split Mechanical Series by Review Unit, Not by Narrative
- AP26 Simpler Fix Wins When Competing PRs Exist
- AP27 Quantitative Metrics in Performance PR Descriptions
- AP28 Hiding a Feature Branch Under a Bug-Fix Title
- AP29 Maintainer Takeover Is a Positive Outcome
- AP30 Scope Is a Queue-Time Multiplier in Bandwidth-Constrained Repos
- AP31 Cite Analogous Existing Code for Instant Credibility
- AP32 Real Tests Over Mocked Tests
- AP33 Production Validation from Community Accelerates Merge
- AP34 Scope Expansion Through Review Is a Time Trap
- AP35 AI Submissions Require Human Supervision During Compliance Windows
- AP36 Study Existing Integration Patterns Before Adding New Ones
- AP37 Sign the CLA Before Opening the PR
- AP38 Signal Refactor Safety with [no-op] Tags
- AP39 Debuggability Over DRY
- AP40 Approval ≠ Merge: Follow Up After 3-5 Days
- AP41 Target Maintainer-Neglected Areas for Fast-Track Merges
- AP42 Use the Project's Preferred Communication Channel for Follow-Up
- AP43 Cross-Reviewer Coordination with "LGTM with Hold"
- AP44 Self-Imposed Hold with Documented Verification
- AP45 Causal Chain in First Paragraph for Regression Fixes
- AP46 Document CI Retests with Classification
- AP47 Performance Awareness and Cache Safety in Subsystem Changes
- AP48 Fork-Master Contamination Kills PRs Instantly
- AP49 Adopt Reviewer Design Suggestions — They Improve Outcomes
- AP50 Second Attempts Win When First Attempts Teach
- AP51 Naive Mechanical Changes Without Verification Are Reputationally Toxic
- AP52 AI Co-Author Trailers Break CLA Gates
- AP53 Self-Correction and Refiling Is a Valid Contributor Pattern
- AP54 Codecov Patch Coverage 0% Is a Red Flag Even When Tests Pass
- AP55 Follow-Up Fix PRs Build Trust Faster Than New Features
- AP56 Unsolicited Infrastructure PRs Are Dead on Arrival
- AP57 Resolve CHANGES_REQUESTED Before Merge — Or Face a Revert
- AP58 Clear the Bot Round Before Humans Engage
- AP59 Separate Public API Response Shapes from Internal Types
- AP60 Issue Invitation Is Not an Open Call
- AP61 Match Fix Complexity to Problem Complexity
- AP62 "Right Fix, Wrong Layer" — Confirm the Fix Belongs Here
- AP63 Empirical Data in PR Descriptions Collapses Review Time
- AP64 Proactively Ping Reviewers After Queue Timeout
- AP65 Don't Spray-Submit Multiple Similar PRs Simultaneously
- AP66 Use Review Bots as Interactive Pair Programmers
- AP67 Bundle Docs-Only Changes with Code Changes in High-Volume Repos
- AP68 The Two-Ping Rule — Set a PR Budget Before You Start
- AP69 Bot Approval Is Not Design Approval
