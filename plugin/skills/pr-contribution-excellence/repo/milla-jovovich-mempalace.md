# milla-jovovich/mempalace — Repo-Specific PR Patterns

Distilled from 10 closed PRs (4 merged, 6 closed/superseded). Last updated: 2026-04-09.

## Key Players

| Role | Who | Style |
|------|-----|-------|
| Primary maintainer | @milla-jovovich | Deep technical reviews with "good parts" section. Warm, encouraging. Uses 💜 emoji. |
| Co-maintainer | @bensig | Fast approvals (often empty body). Handles rebasing, cherry-picks, conflict resolution. |
| Bot reviewer | Octocode MCP (@bgauryy) | Structured 8-section review on every PR. Not blocking but maintainers read them. |
| Third reviewer | @igorls | Occasional "LGTM" — not a primary reviewer. |

## What Gets Merged Fast

1. **Single-issue fixes with tests** — #324 (MCP protocol negotiation) merged in 13h with silent approval. One bug, one fix, 4 tests, clear "what broke" section.
2. **Co-maintainer targeted fixes** — #399 (3 bug fixes) merged in 55 min. Issue refs for each bug. No tests but co-maintainer privilege.
3. **Cherry-picks of community work** — #387 (security hardening) merged in 66 min. Cleaned up #252 with attribution. Lint fixes applied on top.

## What Gets Rejected/Superseded

1. **Unresponsive to rebase requests** — #252 asked to rebase twice, no response → cherry-picked into #387.
2. **Competing PRs lose on diff size** — #306 (65 additions) lost to #261 (54 additions) for same fix. Smaller wins.
3. **Feature PRs with fundamental bugs** — #282 (bloom filter) had false-positive logic bug, worse perf than what it replaced. Bot-flagged, never responded.
4. **PRs superseded by fast-moving upstream** — #44 (SQLite safety) and #157 (tests) self-closed when upstream solved the problems differently.

## Contribution Checklist (mempalace-specific)

- [ ] **Conventional commit prefix**: `fix:`, `feat:`, `test:`, `docs:`, `chore:`, `bench:` (required)
- [ ] **Issue reference**: `Closes #N` or `Refs #N` in PR body
- [ ] **PR template filled**: "What does this PR do?", "How to test", Checklist
- [ ] **"What broke" section**: For bug fixes, explain the real-world failure scenario
- [ ] **Run locally before submitting**: `ruff check .` + `ruff format --check .` + `pytest tests/ -v`
- [ ] **Check for competing PRs**: This is a 34K-star repo — popular issues attract multiple PRs
- [ ] **Tests strongly recommended**: PRs with tests get silent approval; PRs without face more scrutiny
- [ ] **Respond to rebase requests within 24h**: Two ignored requests → maintainer takes over
- [ ] **AI disclosure**: `Co-authored-by:` trailer or `🤖 Generated with [tool]` — accepted without prejudice

## PR Description Template That Works

```markdown
## Summary
[1-3 sentences: what changed and why]

## What broke
[For bug fixes: describe the real-world failure. "Claude Code's MCP client sends X, server responds Y, causing Z."]

Closes #N.

## Changes
[File-by-file summary if >2 files changed]

## Test plan
- [x] `ruff check .` + `ruff format --check .` clean
- [x] `pytest tests/ -v` — N passed, 0 failed
- [x] [specific verification step for this fix]
```

## Review Culture

- **milla-jovovich reviews are deep**: Catches regressions, dead code, semantic bugs, Python-specific issues (IOError/OSError alias, __del__ cleanup). Always includes "good parts" section praising what was done right.
- **bensig reviews are binary**: Empty-body APPROVED or brief comments. Handles operational work (cherry-picks, conflict notes).
- **Bot reviews are comprehensive**: 8-section structured analysis with correctness/security/performance/maintainability scores. Finds real bugs (not just style nits). Worth reading before submitting — address high-priority items preemptively.
- **Follow-up PRs accepted**: Fix first, address review feedback in a separate PR (#165→#405).
- **Self-closing is respected**: When upstream supersedes your work, close with a clear explanation of why. Builds trust for future contributions.

## Anti-Patterns Specific to This Repo

1. **Don't add new dependencies** — Project values minimal deps (only chromadb + pyyaml). Discuss first.
2. **Don't lower CI coverage thresholds** — 85% local, 80% CI. Lowering it gets flagged.
3. **Don't replace proven mechanisms with unproven alternatives** — #282's bloom filter was worse than ChromaDB dedup.
4. **Don't submit broad security/refactor PRs** — #252 mixed 6 concerns and got cherry-picked. Split into focused PRs.
5. **Don't ignore bot review findings** — PRs with unaddressed high-severity bot findings die quietly.

## Timing Considerations

- This is a fast-moving repo (414+ PRs as of April 2026). PRs can be superseded within days.
- Two-tier merge speed: co-maintainer PRs merge in <2h; external PRs take 13-25h.
- Popular issues (MCP fixes, security) attract multiple competing PRs. Check before starting.
