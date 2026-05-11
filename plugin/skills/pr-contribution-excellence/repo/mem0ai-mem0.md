# mem0ai/mem0 — Repo-Specific PR Patterns

Last updated: 2026-04-09 | Distillation #3 | Based on 25 PRs analyzed (16 merged, 9 closed without merge)

---

## Repository Conventions

- **Language**: Python (primary SDK), TypeScript (secondary — mem0-ts, cli/node, vercel-ai-sdk, openclaw)
- **Build tool**: hatch (Python), pnpm + tsup (TypeScript)
- **Linter**: ruff (Python, line-length 120 for SDK, 100 for CLI), biome/eslint (TS varies by package)
- **Import sorting**: isort with profile=black
- **Test framework**: pytest (Python), jest/vitest (TypeScript)
- **Pre-commit hooks**: ruff + isort — install with `pre-commit install`
- **Commit style**: Conventional Commits with optional scope: `feat:`, `fix:`, `docs:`, `refactor:`
- **Scope convention**: parenthesized module name: `fix(azure_openai):`, `feat(bedrock):`, `fix(ts):`
- **New dependencies**: MUST go in optional dependency groups in pyproject.toml, NEVER in core dependencies

## PR Template (Mandatory)

Every PR must fill out all sections from `.github/PULL_REQUEST_TEMPLATE.md`:
1. **Linked Issue** — `Closes #<number>` (create issue first if none exists)
2. **Description** — What and why
3. **Type of Change** — Check exactly one box
4. **Breaking Changes** — Describe or write N/A
5. **Test Coverage** — Check what applies, explain manual testing
6. **Checklist** — All boxes checked before merge

PRs that leave template sections as HTML comments or delete them are deprioritized.

## CLA Requirement (Soft Gate)

CLA Assistant bot comments on every PR immediately. CLA should be signed promptly — PRs with unsigned CLA face delays or closure (#4437). However, enforcement is inconsistent: #4314 merged with CLA still "pending" for a small SDK change. Safe practice: sign immediately on first PR, but know that small changes can sometimes slip through.

## Reviewer Expectations

### kartik-mem0 (Primary Reviewer)
- Asks substantive technical questions before approving
- Questions focus on: reusability of existing helpers, reasoning behind parameter exclusions, scope of tool support
- Example (#4609): asked 3 specific questions (helper reuse, missing comment, tool support) — all required answers before merge
- Graceful about closing competing/superseded PRs — always credits the author's work
- **Co-commits refinements** directly onto contributor branches rather than requesting changes (#4659, #4656) — the bar for "request changes" is high; he prefers to fix small issues himself
- Merge decision maker — responds within 1-7 days

### whysosaket (Secondary Reviewer)
- Provides detailed inline code comments — precise, educational, explains *why* something is a problem
- Focuses on: correctness regressions, resource leaks, misleading function signatures, test quality (asyncio loop leaks)
- Example (#4535): identified potential correctness regression in singleton pattern, flagged asyncio event loop leak, noted edge case in atexit ordering
- **Batch-review pattern**: approved and merged #4374 within 8 seconds — processes multiple PRs in a single sweep
- Approves after discussion is resolved, even with minor open nits

## Process & Workflow

1. **Issue-first is strongly preferred** — all merged PRs referenced an existing issue; filing issue + fix together is the fastest path (~15 hours for #4659)
2. **CLA signing is the first gate** — sign immediately, don't wait
3. **Resolve merge conflicts proactively** — reviewers will ask you to resolve before reviewing (#4437)
4. **Respond to review comments with technical reasoning** — contributors who explain WHY their approach is correct get merged faster (#4609 norrishuang, #4535 utkarsh240799)
5. **Update code after review** — don't just reply; push new commits addressing feedback
6. **Address all review comments in a single commit** — avoids multi-round ping-pong (#4535 addressed 3 maintainer comments in one push)
7. **Expect co-commits, not change requests** — maintainers often push fixes directly onto your branch rather than asking for changes (#4659, #4656)
8. **Silent approval is the norm** — empty-body approvals are standard; don't interpret silence as a negative signal
9. **Review latency is the bottleneck** — 75 min to 84 days (median ~7 days for bug fixes, ~29 days for features); quality bar is not the constraint, reviewer bandwidth is
10. **Community reviews accelerate merges** — detailed community approvals (running tests locally, explaining the bug) attract maintainer attention (#4178)
11. **Submit PRs one at a time** — batch submissions (4+ PRs on same day from same author) trigger batch cleanup, not individual review (#4411 + 3 siblings)
12. **Don't change base interfaces without discussion** — adding params to VectorStore.search() or similar cross-cutting changes requires prior issue/discussion (#4411)

## AI Disclosure Policy

mem0 is **AI-contribution-friendly**. Evidence:
- #4535 included `Co-Authored-By: Claude Opus 4.6` trailer and merged without any pushback
- #4314 disclosed "Generated with Claude Code" and merged without comment
- No anti-AI policy in CONTRIBUTING.md or recon report
- Safe practice: include `Co-authored-by` trailer for transparency; no need to hide AI assistance

## CI Notes

- **Vercel preview failures are NOT merge-blocking** — #4656 merged despite Vercel preview failure
- **build_mem0 on Python 3.10/3.11/3.12 IS the blocking CI check** — must pass
- **build_embedchain is skipped** for changes outside embedchain/ — safe to ignore
- **No auto-labeling bots** — maintainers don't consistently label external PRs

## Common Rejection Reasons

### 1. Superseded by competing PR (MOST COMMON — 6/9 rejections)
The repo has HIGH duplicate PR volume. Examples:
- Issue #3931 (hallucinated IDs): 3 competing PRs (#4437, #3992, #4674) — only #4674 merged
- Issue #3376 (memory leak): 6 competing PRs (#4239, #4319, #4423, #4506, #4557, #4535) — only #4535 merged
- MiniMax provider: PR #4321 (standalone provider) superseded by #4431 (Bedrock integration)
- Datetime filtering: 4-way pileup on #4591, only #4659 merged
- #4655 superseded by internal maintainer fix #4686

**Lesson**: Before starting work, search for ALL open PRs on the same issue AND for PRs touching the same files. Also check if maintainers are working it internally (look at recent commits by maintainers).

### 2. No linked issue + no pre-discussion for features
- #4280 invested 401 lines in Novita provider with no issue → "internal team decision" rejection
- #4411 had good tests + 4-day prod validation but no issue and changed base interface → batch-closed with zero interaction

**Lesson**: Features REQUIRE pre-discussion via issue. Bug fixes can file issue + fix together.

### 3. Batch PR submission triggers batch cleanup
- jamebobob submitted 4 PRs (#4409-4412) on same day — all 4 batch-closed simultaneously 11 days later with zero interaction

**Lesson**: Space PRs out. One at a time, wait for engagement before submitting more.

### 4. Scope mismatch (approach too broad)
- #4498 added new API surface — closed in favor of #4659 which fixed at adapter layer
- #4321 added standalone provider (9 files) — closed in favor of #4609 (2 files within existing provider)
- #4592's unsolicited doc changes cited negatively by maintainer

**Lesson**: Prefer minimal-surface-area. Don't add unsolicited docs.

### 5. CLA not signed + merge conflicts + CI failures left broken
- #4437: asked to sign CLA + resolve conflicts, didn't respond, closed when competitor merged
- #4655: CLA unsigned, author never returned — signals abandonment
- #4557: CI failure never fixed, author didn't respond to maintainer request within 24h

## Success Patterns

### 1. Thorough problem description with production evidence
- #4674: Quoted actual error messages from production, explained the root cause (LLM hallucination), described the fix pattern
- #4535: Listed 3 specific resource leaks, cited user OOM reports on v1.0.4, provided full test output (481 passed)

### 2. Tests that match the fix scope
- #4674: +255 lines, mostly tests — tests for hallucinated IDs in UPDATE/DELETE/NONE branches
- #4609: 4 targeted unit tests covering exact scenarios (text-only, reasoning model, inference config)
- #4535: 43 new tests organized by concern (telemetry close, singleton, memory lifecycle, async lifecycle)
- #4533: 17 tests covering 12 LLM response formats — triple maintainer approval
- #4565: 8 unit tests + E2E against live Qdrant Cloud + full 562-test regression
- #4122: 21 tests in 5 categories, 4.8:1 test-to-code ratio — zero review comments on 478-line feature

### 3. Follow the existing provider pattern exactly
- #4609: Added MiniMax to existing Bedrock provider, matched method signatures and config structure
- #4461: Added reasoning_effort to existing config hierarchy (BaseLlmConfig -> OpenAIConfig -> AzureOpenAIConfig)

### 4. Respond thoughtfully to review questions
- #4609 (norrishuang): Answered all 3 reviewer questions with specific technical details, added inline comments, pushed follow-up commit
- #4535 (utkarsh240799): Rebutted potential regression concern with code-level analysis of get_or_create_user_id behavior

### 5. Small, focused changesets
- #4689: 1 commit, +46/-0, 2 files — merged same day with zero review comments
- #4461: 1 commit, +131/-1, 8 files — merged in 6 days with simple approval
- #4674: 5 commits, +255/-8, 2 files — merged in 2 days
- #4374: 1 commit, +1/-0, 1 file — the ultimate minimal fix (still waited 15 days for review)
- #4178: 1 commit, +30/-5, 2 files — 3 approvals including community review

### 6. File issue + fix together
- #4659: Author filed issue #4591 with root cause analysis, then submitted the fix — merged in 15 hours, fastest external merge observed
- Reduces triage overhead: maintainers can validate the bug and approve the fix in one review session

### 7. Pattern conformity with existing code
- #4595: Introduced `MemoryUpdate` Pydantic model following the exact pattern of existing `MemoryCreate` and `SearchRequest` — zero review friction
- #4656: Systematic config consistency sweep following the same approach as predecessor PR #4646 — merged in 20 hours
- #4515: Centralized duplicated logic across 4 graph backends into shared utility — DRY refactoring with tests got silent approval

### 8. Reference prior work and production evidence
- #4535: Cited real OOM kills on v1.0.4, referenced prior failed attempt (#4497) — grounded urgency and preempted reviewer from suggesting same flawed approach
- #4656: Referenced prior accepted PR by same author — built trust for systematic sweep
- #4565: Linked upstream bug (qdrant/qdrant-js#59), documented E2E validation against live Qdrant Cloud cluster
- #4122: Discovered ASGI double-response bug during implementation, documented both feature and bug fix

### 9. "Superseding PR" pattern — credit predecessors while extending
- #4515: Extended #4184's Neo4j-only fix to all 4 graph backends, credited original author — merged with silent approval
- #4635: Referenced prior merged PR #4608, applied same pattern to different provider — merged in 75 min

### 10. Community reviews accelerate merge timing
- #4178: Himanshu-Sangshetti wrote detailed approval (explained bug, confirmed local test pass, tagged maintainers) — two more maintainer approvals followed same day
- First PR in dataset where community review clearly influenced merge timing

### 11. E2E / live validation beyond unit tests
- #4565: Live Qdrant Cloud free-tier cluster CRUD validation
- #4122: Manual curl verification against real uvicorn server (4 commands with expected output)
- #3888: External MongoDB CI test suite (spruce.mongodb.com) — accepted in lieu of in-repo tests

## Contribution Opportunities

- **Provider additions**: Most structured path — follow existing base.py pattern, add tests, register in configs.py and __init__.py
- **Bug fixes on open issues**: 35 open bugs, many in Core/Python SDK and TypeScript SDK
- **Fix consistency bugs across providers**: The response_format forwarding bug appeared in vllm, deepseek, and azure_openai — pattern bugs affecting multiple providers are high-value
- **No "good first issue" labels currently open** — look at recent bug reports with clear reproductions

## Anti-Patterns to Avoid

1. **Don't add standalone providers when Bedrock/LiteLLM already covers it** — maintainers prefer using existing meta-providers
2. **Don't add core dependencies** — always use optional dependency groups
3. **Don't touch embedchain/** — it has its own build system (Poetry)
4. **Don't modify CI/CD workflows** without explicit approval
5. **Don't use npm or yarn** — pnpm exclusively for all TypeScript packages
6. **Don't leave PR template sections empty** — fill everything out or write N/A
7. **Don't start work on popular issues without checking for competing PRs first**
8. **Don't submit multiple PRs on the same day** — 4 PRs from jamebobob (#4409-4412) all batch-closed with zero interaction
9. **Don't change base interfaces without linked issue and prior discussion** — #4411 added a param to VectorStore.search() → rejected
10. **Don't add unsolicited doc changes** — #4592's doc additions cited negatively by maintainer as scope creep
11. **Don't mass-ping multiple maintainers** — #4557 pinged 5 maintainers; signals unfamiliarity with review culture
