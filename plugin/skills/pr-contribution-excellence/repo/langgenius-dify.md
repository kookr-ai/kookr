# langgenius/dify — PR Contribution Patterns

Distilled from 60 closed PRs.
Last updated: 2026-04-05.

## Repo Profile

- **Stars**: ~135k | **Open issues**: ~800 | **Language**: Python (backend) + TypeScript/React (frontend)
- **Merge strategy**: Merge commit (no squash enforcement)
- **Review bar**: 1 approval sufficient, org members self-merge
- **Bot ecosystem**: Copilot reviewer, Gemini Code Assist, Pyrefly type checker, dosubot labeler, autofix-ci, anti-slop checker
- **CI hard gate**: `needs-revision` auto-label on CI failure — blocks merge
- **Commit convention**: Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `perf:`, `chore:`)
- **PR template**: Summary, Screenshots (Before/After table), Checklist — expected but loosely enforced
- **Issue linking**: Required. Use `Fixes #N` for standalone bugfixes/features that should auto-close the issue; `Part of #N` is accepted for refactor/migration slices. CONTRIBUTING.md explicitly says "Don't forget to link an existing issue"
- **Test expectations**: CONTRIBUTING.md says "add tests for your changes accordingly" — backend uses pytest, frontend requires comprehensive test coverage per `web/docs/test.md`
- **Plugins**: New model runtimes/tools go to `dify-plugins` repo, not main
- **Existing tools**: Existing model runtimes/tools → `dify-official-plugins` repo

## Dify-Specific Patterns

### 1. Bot Reviews Are Advisory, Not Blocking

Bot review comments (Copilot, Gemini) are routinely merged past without addressing them. However, engaging seriously with bot feedback produces better code — PR #34226 turned a partial fix into a complete one by addressing Copilot's cross-layer integration gap. **Best practice**: evaluate bot feedback on merit and address explicitly either way. QuantumGhost sometimes endorses bot comments, making them effectively maintainer feedback.

**Exception**: For core infrastructure changes (Redis, concurrency), bot feedback that identifies architectural flaws should be taken seriously — it often predicts the exact concern the maintainer will raise.

(Evidence: #34299, #34226, #33884, #34379)

### 2. Fix CI Within 24 Hours or Get Superseded

Dify has high contributor velocity. A PR with failing CI for >24h signals abandonment. Maintainers will either close it or a faster contributor will supersede it. The `needs-revision` auto-label on CI failure is visible to everyone.

(Evidence: #34227 — CI failures unfixed for 50h → superseded by #34265 which merged in 6h)

### 3. Single Approval Is the Merge Gate

Despite requesting 3-8 reviewers per PR, dify merges with a single approval — often from someone who wasn't even requested. In 32 of 45 analyzed PRs, the actual approver differed from the requested reviewer(s). laipz8200 was requested 8+ times and responded zero times. Don't wait for consensus; one human LGTM is sufficient.

(Evidence: #34311, #33044, #34241, #34345, #34414, #34328, #34379, and 25+ others)

### 4. Claim Issues Before Opening PRs (First-Come-First-Served)

On easy bugs with `accepting prs` label, the first contributor to claim the issue in the thread gets priority. The CONTRIBUTING.md assignment requirement is actively enforced.

(Evidence: #33637 vs #33653 — identical bug fix, first PR wins; #33740 — reviewer asked for issue creation before review)

### 5. Search Before You Submit (The 2-Minute Rule)

Always search: (1) open PRs for same issue, (2) recently merged PRs that already fixed it, (3) dosubot comments flagging duplicates.

(Evidence: #34352, #34158, #33653, #33668, #34041)

### 6. Self-Filed Issues Are Accepted and Encouraged

Creating your own issue and then fixing it is a normal, accepted pattern at dify. Filing the issue yourself satisfies the CONTRIBUTING.md requirement.

(Evidence: #34311, #34241, #33105, #34345, #34030)

### 7. Pattern Franchising Accelerates Review

Repeating the same well-scoped refactoring pattern across multiple PRs builds trust that compounds dramatically. The more PRs in a series, the faster each subsequent one merges:
- tmimmanuel: 3rd EnumText PR merged in 2.2h
- RenzoMXD: 19th SQLAlchemy migration PR merged in 1.7h (from 14h on the 1st)
- xr843: 26 merged PRs, sessionmaker migrations merging same-day

Key enabler: reference the parent issue and prior PRs so reviewers can quickly verify you're following the established pattern.

(Evidence: #33696, #34299, #34300, #34027, #34414, #34379)

### 8. Parity Fixes Are the Lowest-Friction Contribution

Finding a gap between two API surfaces (Console vs Service API, creation vs update endpoint) and replicating the existing pattern is the safest contribution type. Zero code-level feedback.

(Evidence: #34221, #33637)

### 9. Queue Time Is the Bottleneck, Not PR Quality

Time-to-merge ranged from 1.7h to **93 days**. PRs with zero review comments still waited 14.5h to 3.8 days. Perfect PRs don't get fast-tracked — they just merge without friction when a maintainer gets to them. Even prolific contributors (295+ merged PRs) can get ghosted for 14 days.

(Evidence: #34185, #29983, #33657, #33648)

### 10. Test-Only PRs Get Size Leniency

Test PRs labeled XXL merge in 6h with bare approvals. Test-writing can also surface production bugs — be prepared for reviewers to expand your scope if you find one.

(Evidence: #32648, #33625, #32521)

### 11. Use StrEnum/EnumText, Not String Literals

The most common review feedback: use proper enum types instead of hardcoded strings.

(Evidence: #32648, #33044, #33696, #34299)

### 12. Dependency Upgrades Require Full Scope

Bumping a version in `pyproject.toml` is necessary but not sufficient. You must also: regenerate `uv.lock`, update all downstream consumers, and use the project's preferred version constraint style (`>=X,<Y` not `~=X.Y`).

(Evidence: #34227 failed vs #34265 succeeded)

### 13. "Use What Exists" Is the Primary Review Feedback Pattern

The most common maintainer feedback: pointing to existing utilities via GitHub permalink. Search for existing implementations before writing new code.

(Evidence: #33740, #34345)

### 14. Org Members Have a Completely Different Experience

MEMBER-level contributors get: fast-lane review, self-merge after one approval, minimal description requirements, tolerance for messy commit history. External contributors should NOT calibrate expectations based on org-member PRs.

(Evidence: #34241, #34325, #34334, #34009)

### 15. Honesty About Limitations Is Tolerated

Admitting testing gaps doesn't block merge. But broken diffs from botched rebases are instant disqualifiers.

(Evidence: #33853, #33334)

### 16. CI Responsiveness > First-Push Perfection

Speed of response to CI failures correlates more with merge speed than initial code quality. Follow-up "fix: api test" commits are tolerated when they arrive within minutes.

(Evidence: #34221 vs #33704, #34414)

### 17. Maintainers Handle Branch Updates

crazywoola and QuantumGhost merge main into contributor branches themselves. Dirty commit history is tolerated.

(Evidence: #33105, #32648, #34203)

### 18. Thread Safety and Broad Exceptions Are Live Review Concerns

QuantumGhost catches thread-safety issues within minutes. Broad `except Exception` is explicitly called out.

(Evidence: #34311, #33044)

### 19. Direct Reviewer Pings Work Better Than Requested Reviewers

@-mentioning a specific person in PR comments is more effective than relying on the requested reviewers list. The requested reviewers dropdown is essentially decorative. Tagging known reviewers for your domain (e.g., @asukaminato0721 for SQLAlchemy) gets faster attention.

(Evidence: #33657, #34414)

### 20. Enterprise/License-Sensitive Areas Are Instant-Close Territory

External contributors must not touch workspace management, authentication controls, feature flags, or anything that bypasses enterprise config. Before touching any permission/workspace/feature-gating code, check if it's part of the enterprise offering.

(Evidence: #29070 — closed in 3 minutes)

### 21. Design Correctness > CI Status for Core Infrastructure

CI green doesn't save a PR with a fundamentally wrong design. For Redis, concurrency, or other core infrastructure changes, maintainers evaluate whether the design achieves its stated goals, not just whether tests pass.

(Evidence: #33884 — CI green, tests passed, but XREADGROUP design was fundamentally wrong → superseded)

### 22. Structured Change Tables Accelerate Review

PR descriptions with a file-by-file change table help reviewers assess scope at a glance and approve faster. Especially effective for umbrella-issue refactoring series.

(Evidence: #34027, #34300)

### 23. Forward-Looking Reviewer Advice Doesn't Block Merge

Reviewers give constructive suggestions for future work without blocking the current PR. Engage with the advice but don't stall your PR to implement it.

(Evidence: #34027)

### 24. Old PRs Aren't Forgotten

Even after 93 days untouched, clean PRs are eventually picked up and merged without asking for rebase or code updates.

(Evidence: #29983)

### 25. Messy Commit History Is Tolerated

40 commits with 15 merge commits (#32521), 16 "tweaks" commits (#34009) — all merged without squash requests. Focus on code quality and description clarity, not commit perfection.

(Evidence: #33657, #34325, #29983, #32521, #34009)

### 26. AI-Assisted Contributions Are Openly Accepted

Dify is notably AI-friendly. Multiple PRs with explicit AI attribution have merged without objection:
- `Co-Authored-By: Claude Opus 4.5` in commit trailers (#34030, #31697)
- `Co-Authored-By: Claude Opus 4.6 (1M context)` in commit trailers (#34379)
- `codex/` branch name prefixes (#34328)
- No anti-AI policy, no anti-slop rejection of AI-attributed PRs

The quality bar is the same regardless of authorship method. AI attribution is a non-factor in review decisions.

(Evidence: #34030, #31697, #34379, #34328)

### 27. Maintainers May Take Over Scope-Expanding Changes

For infrastructure-level changes (Python version bumps, typing modernization, framework migrations), maintainers may close external PRs — even from prolific contributors — and redo the work with broader scope. This isn't a quality rejection; it's a scope disagreement. The signal is quick closure without review feedback, followed by a maintainer-authored replacement PR.

**Mitigation**: Before touching project-wide infrastructure, check with maintainers in the issue thread whether they have a broader plan. Narrow, incremental changes are safer than scope-defining ones.

(Evidence: #34399, #34397 — QuantumGhost's narrow Python 3.12 bump closed by WH-2099, replaced by 97-file modernization PR #34419)

### 28. Link Issues From the First Push

Maintainers actively enforce issue linking. crazywoola asked for an issue link on #34328 and pointed to another PR with the same problem. For standalone fixes, use `Fixes #NNN`; for refactor or migration series, `Part of #NNN` is accepted as long as the relationship is obvious from the first push.

(Evidence: #34328, #33740, #34547, #34548, #34503, #34528, #33633, #34527, #34561, #34562, #34563)

### 29. Show Validation Evidence in PR Body

Include the exact test commands you ran, the test file paths, and pass counts. This gives reviewers confidence the change was actually tested, not just written. Especially valuable for vector DB, integration, and infrastructure changes.

(Evidence: #34328 — included pytest command with 19 passed; #34030 — DevTools screenshots)

### 30. Keep PRs Laser-Focused — Scope Creep Kills

Unrelated changes (config tweaks, ESLint cleanups, dependency pins) dilute PR focus and make it easier for reviewers to skip. When changing template/interpolation strings, audit ALL call sites — incomplete migrations are a major quality gap that bots will flag and humans will notice.

(Evidence: #33648 — unrelated turbopack config + missed i18n call sites → 14-day ghosting → self-closed)

### 31. TypedDict and Contract-Hardening PRs Are a Trusted Fast Lane

Small typing PRs that tighten an existing contract merge extremely fast when they do three things well: explain why the dict/signature is foundational, enumerate the dependency chain or touched methods, and show the full Python verification stack. Maintainers will sometimes approve these even when bots raise theoretical compatibility concerns, as long as the slice is tiny and CI is green.

(Evidence: #33633, #34527, #34526, #34482, #34485, #34484, #34486, #34483, #34447)

### 32. Reviewability Beats Thoroughness for Mechanical Series

In mechanical refactor series, splitting by review unit matters more than adding more prose to a large PR. A strong description helps, but once the diff spans too many files or too much churn, maintainers will ask for a split. The winning pattern is: one file or one class per PR, explicit deferred work, exact local checks, parent issue link.

(Evidence: #34412 vs #34561/#34562/#34563, plus #34547, #34548, #34503, #34528)

### 33. Frontend PRs Must Preserve UX Details and Follow Repo Migration Paths

Frontend changes are reviewed against both user-visible behavior and Dify's current migration plan. Preserving details like line numbers, export surfaces, overlays, and selector behavior matters; so does following repo-local guidance such as `web/overlay-migration.md`. A correct-looking UI fix can still be closed if it uses an unapproved path.

(Evidence: #33473, #34505, #34508, #34501)

## Pre-Submission Checklist for Dify

1. [ ] Issue exists and is linked (`Fixes #N`, `Relates to #N`, or `Part of #N` as appropriate) — **from the first push**
2. [ ] You are assigned to the issue (claim in thread before starting work)
3. [ ] No existing open PR for the same issue (search open + recently merged)
4. [ ] dosubot hasn't flagged the issue as duplicate
5. [ ] The bug hasn't been fixed on `main` already (check recent merged PRs)
6. [ ] **Not touching enterprise/license-sensitive areas** (workspace mgmt, feature flags, auth controls)
7. [ ] **Not touching project-wide infrastructure** without maintainer alignment in the issue thread
8. [ ] CI passes locally (run `make lint`, relevant tests, basedpyright/pyrefly)
9. [ ] `uv.lock` regenerated if `pyproject.toml` changed
10. [ ] `git diff` verified clean after rebase (no broken function bodies)
11. [ ] Conventional Commit title format (`type(scope): description`)
12. [ ] PR template filled out (Summary, Screenshots if applicable, Checklist)
13. [ ] **Validation evidence included** (pytest commands, pass counts, test file paths)
14. [ ] Bot review comments addressed explicitly (fix or explain why kept)
15. [ ] No broad `except Exception` without specific justification
16. [ ] Enums used instead of string literals
17. [ ] Existing patterns referenced (search for similar implementations)
18. [ ] Tests added (pytest for backend, see `web/docs/test.md` for frontend)
19. [ ] **All call sites audited** for string/template/i18n changes
20. [ ] **For infrastructure changes**: Design semantics verified, not just tests passing
21. [ ] **No unrelated changes** (no config tweaks, lint cleanups, or dependency pins unless that's the PR's purpose)
22. [ ] **For frontend changes**: Check repo-local migration docs first (for example `web/overlay-migration.md`) and preserve visible UX details such as overlays, exports, selectors, and line numbers
