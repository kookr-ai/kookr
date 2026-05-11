# Codex-Specific Contribution Patterns

Last updated: 2026-03-27 | Distillation #4 | Based on 50 PRs analyzed

---

## Repository Conventions

### Build & Validation
- **Dual build system**: Both `cargo` and `bazel` must be updated when dependencies change. Include `just bazel-lock-update` and `just bazel-lock-check` when touching Cargo.toml. (Evidence: #15903, #15784)
- **Per-crate testing**: Run `cargo test -p {crate}` on each affected crate, not just a workspace-wide test. List each command in the PR's Verification section. (Evidence: #15897, #15903, #15900, #15067, #15835, #15791, #15789, #15909, #15707)
- **Lint commands**: `just fix -p {crate}`, `just fmt`, `just argument-comment-lint` are the standard lint gates. Include them in verification steps. (Evidence: #15897, #15903, #15900, #15791, #15789, #15909, #15707)
- **Rust checks**: `cargo clippy --tests` and `cargo fmt` are expected. (Evidence: contributing.md)

### Code Style
- **Conventional commits used but not enforced.** bolinfest uses `fix:`, `feat:` prefixes; jif-oai uses `fix:`, `feat:`, `chore:`; fcoury uses `fix(scope):` with parenthesized scope; viyatb-oai uses `fix(scope):`. No PRs were rejected for commit message format, but internal commit messages can be very loose ("update", "nits", "changes lot of stuff"). External contributors should use conventional commits with descriptive messages. (Evidence: #15835, #15903, #15897, #15881, #15759, #15513, #15820, #15691)
- **Branch naming varies**: `pr{number}` (bolinfest), `username/description` (rreichel3-oai), `codex/username/description` (viyatb-oai), `dev/username/description` (mzeng-openai), `username/codex-description` (euroelessar), `stack/{name}` (aibrahim-oai for stacked PRs). No enforced convention. (Evidence: #15897, #15067, #15811, #15791, #15891, #15748)

### Testing Expectations
- **Security changes require cross-crate test coverage.** Tests across protocol, sandboxing, AND exec crates — not just the crate you modified. (Evidence: #15067)
- **Security fix tests should use deterministic inputs.** Use `.invalid` TLD for DNS failure tests (RFC 2606), IP literals instead of hostnames to avoid ambient DNS behavior. (Evidence: #15909)
- **Test-only PRs explicitly state "does not change how existing code works."** This phrase is a reviewer fast-track signal. (Evidence: #15813)
- **Include exact `cargo test` commands in Verification section.** Every merged PR with tests listed the exact commands to reproduce. (Evidence: 18+ of 50 merged PRs with tests)
- **Codex-generated PRs should list exact test commands** to compensate for the "did a human run this?" concern. (Evidence: #15789)
- **Test replacement, not just removal.** When removing old test code, replace with focused tests asserting the new behavior. (Evidence: #15812 — 783 lines of old tests replaced with 29 lines of new tests)
- **Honest about test limitations.** Document pre-existing unrelated failures and suites you didn't run. (Evidence: #15659 — "cargo test -p codex-core still hits existing unrelated failures")

### Dual-TUI Consistency
- Both `tui/` and `tui_app_server/` paths must be updated together for any UI/widget change. Missing one path will be flagged in review. (Evidence: #15802, #15758)

## The Fcoury Template (Gold Standard for External Contributors)

fcoury's PR description structure produced the cleanest external contributor merges — one PR (#15759, +457/-89) got ZERO inline comments and a one-line approval. This 7-section structure should be copied exactly:

### Template

```markdown
## TL;DR
{One paragraph: what and why}

## Problem
{What's broken and why it matters}

## Mental model
{Explain the conceptual framework — two tiers, three states, etc.
This is what pre-answers reviewer "why?" questions.}

## Non-goals
{What this PR explicitly does NOT attempt to do.
Pre-empts "why didn't you also fix X?" questions.}

## Tradeoffs
{What downsides did you accept and why they're acceptable.
Shows engineering maturity.}

## Architecture
{Structure of the change: new modules, modified paths, method tables.
Replace reviewer's need to reverse-engineer the diff.}

## Tests
{List each test by name with what it verifies.
Not just "added tests" — describe the scenario each test covers.}
```

### Why it works
- The "Mental model" section does the work that 10 inline reviewer comments would normally do
- The "Non-goals" section prevents scope-expansion suggestions
- The "Tradeoffs" section prevents "have you considered the downsides?" questions
- The description is longer than the code changes — that's the RIGHT ratio for external contributors

(Evidence: #15759 zero inline comments; #15513 approved after addressing 4 scope questions)

### Security Fix Template (Gold Standard)

For security fixes, use this 4-section structure (from #15909):

```markdown
## Summary
{What changed — fail-closed instead of fail-open, etc.}

## Root cause
{Why the old behavior was wrong — explain the threat model.
This is the section that distinguishes good security PRs.}

## Changes
{Specific behavioral changes, listed concisely}

## Validation
{Exact cargo test/clippy/fmt/lint commands run}
```

(Evidence: #15909 — approved in 15 minutes with one readability nit)

## Reviewer Expectations

### Key Reviewers

**bolinfest (Primary Gatekeeper / Architecture Reviewer)**
- Most active reviewer — appeared in 15+ of 50 PRs as reviewer or author
- Uses and expects Why/What Changed/Testing description structure
- Asks probing design questions ("Is there a reason X?", "Can/should we also handle Y?")
- Architecturally focused: concerns about module boundaries, code placement, and comprehensibility ("apply-patch should have no knowledge of this", "I feel like this needs a comment to explain why")
- Suggests follow-up work as inline comments — expects authors to defer, not expand scope
- Reviews both internal and external PRs with equal rigor
- **Co-authors commits on contributor branches** — pushes fixes directly when it's faster than commenting. (Evidence: #15693 — pushed 5 commits to viyatb's branch)
- **Cross-checks Codex bot changes with domain owners** — flags ordering changes the bot introduced and pings the right person to verify. (Evidence: #15693)
- Provides exact `suggestion` blocks for comment wording — adopt verbatim. (Evidence: #15707)
- Reviews the full 4-deep crate extraction stacks as single architecture decisions. (Evidence: #15748, #15749)
(Evidence: #15835, #15897, #15067, #15791, #15661, #15900, #15903, #15898, #15910, #15693, #15691, #15707, #15748)

**etraut-openai (TUI/App-Server Reviewer)**
- Primary reviewer for TUI and app-server changes
- Focuses on SCOPE DISCIPLINE — 4 of 4 inline comments on #15513 were "is this related to this PR?"
- Approves quickly when scope is clean: "Good analysis and fix" on #15759 (zero inline comments)
- Reviews external contributor PRs in TUI area
(Evidence: #15759, #15513, #15798, #15839, #15806)

**shijie-oai + owenlin0 (Plugins/MCP/Metrics reviewers)**
- Dual sign-off pattern in plugins/MCP area
- owenlin0 gives substantive pushback on code quality ("this is messy, can we simplify?")
- shijie-oai asks domain clarification questions
(Evidence: #15891, #15885, #15805, #15659)

**pakrym-oai (Exec-server/Infrastructure reviewer)**
- Asks design-level questions about protocol decisions ("do we need a generic method level error mechanism?", "why we need seq considering the protocol is ordered")
- Expects concise technical justifications
(Evidence: #15691, #15785)

**rreichel3-oai (Security reviewer)**
- Gives quick approvals for security fixes with readability nits
- Reviews network-proxy, sandbox, and trust-boundary changes
(Evidence: #15909, #15707)

**aibrahim-oai (Core infrastructure reviewer)**
- Reviews large infrastructure changes silently (silent approval)
- Primary reviewer for crate extraction work
(Evidence: #15785, #15749, #15748, #15747, #15746, #15744)

**xl-openai (Auth/Login reviewer)**
- Reviews auth, login, plan type changes
- Catches unnecessary code: "Do you need this?" (#15789)
(Evidence: #15789, #15829)

### Review Dynamics
- **Single approval is sufficient** for focused, non-security changes (majority of 50 merged PRs)
- **Dual approval** appears in: plugins/MCP area, feature flag toggles (launch gating), and cross-cutting changes
- **Feature flag toggles require 2+ approvals** — even trivial boolean flips get dual sign-off as launch gating (Evidence: #15820)
- **Security changes get multi-round review**: expect 8+ days and 15+ inline comments for trust-boundary changes
- **"Does not change behavior" triggers fast-path review**: Reviewers skip behavioral analysis
- **Scope discipline is THE #1 reviewer concern for external PRs**: etraut-openai's 4 questions on #15513 were ALL "is this related to this PR?"
- **Review depth scales with change scope**: Small PRs get 0-1 inline comments; large architectural PRs get 10-22 inline comments (#15693: 22 comments)
- **Different reviewer can approve than the one who gave feedback**: bolinfest commented on #15707, rreichel3-oai approved it
(Evidence: all 50 PRs)

### What Reviewers Value
- **Honesty about testing limitations.** Documenting "I couldn't run X because Y" is valued over faking completeness. (Evidence: #15897, #15903, #15805, #15659)
- **Scope discipline.** Respond to scope-expansion suggestions with "would prefer to keep this PR focused" and suggest follow-up PRs. (Evidence: #15067, #15791, #15513)
- **Constructive responses to every comment**, even when disagreeing. No defensiveness. (Evidence: #15067, #15791, #15513, #15798)
- **Concise answers to reviewer questions.** "No, this was never a PID actually." / "This is for ws reconnection." — direct, satisfying. (Evidence: #15691)
- **Adopting reviewer-provided suggestion blocks verbatim.** Don't rephrase; use the exact wording they gave. (Evidence: #15707)
- **Screenshots for CLI/system-level changes**, not just UI changes. Terminal output proving real-world testing builds confidence. (Evidence: #15693 — bwrap compat with Ubuntu 20.04 screenshots)
- **Follow-up sections listing intentionally deferred work.** De-risks large changes by showing scope awareness. (Evidence: #15691)
- **Domain knowledge when pushing back** on testing requests. Only works when you can explain why the premise is flawed. (Evidence: #15885)

## Process & Workflow

### Contributor Trust Tiers

| Tier | Contributors | Description Required | Human Review | Commit Discipline | Example |
|------|-------------|---------------------|-------------|-------------------|---------|
| **Core** | jif-oai, pakrym-oai | No/Minimal | 0-1 silent approval | "update", "nits" OK | #15881, #15785, #15861, #15851, #15691 |
| **Established** | bolinfest, etraut-openai | Excellent (self-imposed) | 1 approval | Clean conventional commits | #15897, #15661, #15798, #15825 |
| **Team** | viyatb-oai, mzeng-openai, arnavdugar-openai, nicholasclark-openai, evawong-oai, canvrno-oai | Good/Minimal | 1-2 approvals + address comments | Varies | #15791, #15885, #15789, #15909, #15693, #15659 |
| **External** | fcoury | Exceptional required (7-section template) | Full review + all scope scrutiny | Must be clean conventional commits | #15759, #15513 |

**For external contributors**: You must operate at the bottom tier. Provide exceptional descriptions, include comprehensive tests, and expect multi-round review. Scope discipline is scrutinized more than code quality. Your descriptions should be 3-5x more detailed than internal equivalents.

### Issue Links
- **Not required for internal PRs.** 0 of 50 analyzed PRs had explicit GitHub issue links (except bug fix #15693 which referenced #15283).
- **Bug fixes SHOULD link the issue**: #15693 used "Fixes #15283" — this is the correct pattern for bug fixes.
- **Branch names reference internal trackers**: `bugb-15553` suggests internal bug IDs.
- **External contributions SHOULD link issues**: Per CONTRIBUTING.md, features require pre-approved issues.
- **Codex-generated PRs link to Codex tasks**: #15789 linked its Codex task URL.
(Evidence: all 50 PRs)

### The Follow-Up PR Pattern
When reviewers suggest adjacent improvements:
1. Acknowledge the suggestion
2. Say "Moved to follow-up PR #NNNN to keep this PR focused"
3. Actually create the follow-up PR
(Evidence: #15067, #15791, #15898 — three independent instances confirm this is convention)

### The Prep-Work + Execution PR Pair
Decompose large changes into safe prep + meaningful execution PRs:
1. First PR: refactor/consolidate/simplify (net-negative or neutral LOC)
2. Second PR: the actual feature/change
(Evidence: #15810 → #15811, #15812 → #15906)

### Stacked PRs for Crate Extraction
For multi-crate restructuring, use bottom-up merge order:
- Branch naming: `stack/instructions`, `stack/utils-plugins`, `stack/plugin`, `stack/analytics`
- Each PR in the stack is independently reviewable
- Merge bottom-up: dependencies first, dependents last
- bolinfest reviews the full stack as a single architecture decision
(Evidence: #15744 → #15746 → #15747 → #15748)

### Comment-Only Follow-Up PRs
When a reviewer asks for a clarifying comment in a previous PR, create a dedicated follow-up PR for just the comment. These are legitimate PRs. (Evidence: #15707 — entire PR is a code comment requested by bolinfest in #15351)

### Bot Interaction Protocol

**Codex Review Bot (`chatgpt-codex-connector[bot]`)**
- Runs automatically on PRs; can also be triggered with `@codex review`
- Assigns priority badges: P0 (compile errors — often false positives), P1 (real issues), P2 (nice-to-haves)
- Bot compile-error findings (P0) are unreliable — CI is the authority. In 50 PRs, multiple P0s were false positives. (Evidence: #15749, #15784, #15691)
- Used for self-review by contributors before requesting human review
- Team members trigger bot review on each other's PRs, not just their own (Evidence: #15806)
- Bot approval does NOT substitute for human approval
(Evidence: #15791, #15881, #15067, #15811, #15513, #15806, #15691, #15784)

**Codex Bot Co-Authorship**
- Internal teams use Codex for implementation assistance and credit it in commits: "Co-authored-by: Codex <noreply@openai.com>"
- Multiple commits per PR may be Codex-assisted (Evidence: #15659 — 9 of 11 commits, #15748 — multiple)
- External contributors should similarly disclose AI assistance

**Iterative Bot Self-Review (fcoury pattern)**
- fcoury invoked `@codex review` 5 TIMES on #15513, re-triggering after each push
- This iterative self-review pattern addresses bot feedback before human review
- Declining bot suggestions: "We want to keep this PR scoped to [X] rather than add [Y] here. Will track as follow-up if [condition]."
(Evidence: #15513 — 5 invocations, 8+ substantive responses to bot suggestions)

**Copilot Code Review**
- Also runs automatically, generates inline suggestions
- Suggestions tend to be algorithmic (complexity optimization, unnecessary operations)
- Useful for catching mechanical issues, less useful for design feedback
(Evidence: #15513 — 5 Copilot suggestions, all addressed by fcoury)

## PR Types by Merge Speed (Fastest to Slowest)

| PR Type | Expected Time | Description Depth | Evidence |
|---------|--------------|-------------------|----------|
| Dead code removal | <1 hour | Why + What Removed | #15900 (34 min) |
| Own-regression fix | ~1 hour | Minimal (checklist OK) | #15885 (57 min) |
| Dependency cleanup | ~1 hour | Why + What Rewired | #15903 (1h) |
| Prompt polishing | ~1 hour | Task checklist | #15891 (1h) |
| Core self-merge | ~1.5 hours | None required | #15881 (1.5h), #15861 (33m) |
| Feature flag toggle | ~1.5 hours | Title is sufficient | #15820 (1.5h) |
| Pure additive feature wiring | ~2 hours | One bullet OK | #15806 (2h) |
| Type refactor | ~2 hours | Why old type was wrong | #15897 (2h) |
| Security fix (small, focused) | ~2 hours | Summary/Root cause/Changes/Validation | #15909 (2h) |
| UI polish | ~2 hours | Bullet list of changes | #15802 (2h) |
| Race condition fix | ~2.5 hours | Root cause + fix approach | #15798 (2.5h) |
| Comment-only follow-up | ~3 hours | Link to originating PR | #15707 (3h) |
| Plan type mapping | ~5 hours | Motivation + Testing | #15789 (5h) |
| Large feature port | ~5 hours | Exceptional: Non-goals, Tradeoffs | #15860 (5h, external) |
| External bug fix (clean) | ~8 hours | 7-section template | #15759 (8.3h, external) |
| Crate extraction | ~9-10 hours | 2-bullet Summary + CI | #15748 (9h) |
| Dependency replacement | ~17 hours | One sentence | #15784 (17h, core self-merge) |
| Test-only | <1 day | "Does not change behavior" + test cmd | #15813 (18h) |
| File split refactor | ~1 day | Minimal (one sentence OK) | #15811 (20h) |
| MCP span/observability | ~28 hours | Summary + Included Changes + Notes | #15659 (28h) |
| Bug fix (cross-platform compat) | ~32 hours | Full summary + VM validation screenshots | #15693 (32h) |
| Large arch refactor (core team) | ~40 hours | Structured sections + Follow-ups | #15691 (40h) |
| External feature restoration | ~2 days | 7-section template | #15513 (2d) |
| Feature flag enable | ~2 days | None (title self-documents) | #15661 (2d) |
| Security fix (trust boundary) | 1-8 days | Problem/Scope/Why-this-shape/Validation | #15067 (8d), #15796 (23h) |

## Common Rejection Reasons

- **Duplicate of existing PR**: Self-closed with "duplicate of #N" note. (Evidence: #15892)
- **Scope creep from rebase**: Unrelated changes introduced during rebase trigger reviewer questions. (Evidence: #15513 — 4 scope questions from etraut-openai)
- *Note: No maintainer-rejected external PRs in 50-PR sample yet. Need to analyze rejected external contributions.*

## Success Patterns for External Contributors

1. **Use the 7-section fcoury template**: TL;DR → Problem → Mental Model → Non-goals → Tradeoffs → Architecture → Tests
2. **For security fixes, use the 4-section template**: Summary → Root cause → Changes → Validation
3. **Run `@codex review` iteratively**: Push changes, trigger bot review, address feedback, repeat until clean
4. **Check `git diff main...HEAD` after every rebase**: Unrelated changes are the #1 scope concern
5. **Match existing patterns**: Port from established crate, follow existing conventions
6. **Comprehensive tests with deterministic inputs**: Use `.invalid` TLD, IP literals, avoid ambient DNS
7. **Address bot comments proactively**: Engage substantively with every P1/P2 suggestion
8. **For bot suggestions you decline**: "We want to keep this PR scoped to [X]. Will track as follow-up if [condition]."
9. **Include exact verification commands**: `cargo test -p {crate} {test_name} --lib`
10. **Never put unrelated changes in the same PR**: Even trivially correct test fixture fixes from rebase — drop them
11. **Proactive debugging narratives earn goodwill**: "I investigated X and found Y" frames the PR as detective work
12. **Adopt reviewer suggestion blocks verbatim**: Don't rephrase reviewer-provided comment wording
13. **Include screenshots for CLI/system-level testing**: Terminal output proving behavior on target platforms
14. **List follow-ups explicitly**: "Follow-up: unify thread ID, FD handling, zsh-fork compat" shows scope awareness
15. **Use conventional commit messages**: `fix(scope):`, `feat:`, `chore:` — internal commits can be sloppy; yours cannot
16. **Disclose AI assistance**: Credit Codex or other AI tools in co-author lines
