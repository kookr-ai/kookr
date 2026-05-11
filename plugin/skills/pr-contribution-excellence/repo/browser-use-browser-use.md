# browser-use/browser-use Contribution Patterns

Last updated: 2026-04-10 | Distillation #4 | Based on 35 PRs analyzed

---

## Repository Conventions

### Code style
- **Tabs for indentation** — enforced by ruff format; spaces will cause pre-commit failure
- Modern Python 3.12+ typing: `str | None`, `list[str]`, `dict[str, Any]` (not Optional/List/Dict)
- Pydantic v2 models with `ConfigDict(extra='forbid', validate_by_name=True)`
- Service pattern: `service.py` for logic, `views.py` for models, `events.py` for events
- Logging in `_log_*` prefixed methods, separated from main logic
- `uuid7str` for new ID fields: `id: str = Field(default_factory=uuid7str)`
- Runtime assertions at function boundaries

### Testing
- **Never mock** — use real objects; only exception is LLM (use conftest.py fixtures)
- **Never use real URLs** — use `pytest-httpserver` for local test servers
- CI tests in `tests/ci/test_*.py` — auto-discovered by matrix CI
- No `@pytest.mark.asyncio` needed — just `async def`
- Simple `@pytest.fixture` decorator, no arguments even for async fixtures
- Tests that pass should be moved into `tests/ci/` subdirectory

### Build and quality
- `uv` package manager exclusively — never pip
- `uv run pre-commit run --all-files` before any PR
- Pre-commit: ruff check, ruff format, pyright, codespell, pyupgrade
- Setup: `uv venv --python 3.11 && source .venv/bin/activate && uv sync --all-extras --dev`

### Commit conventions
- Conventional commits: `fix:`, `feat:`, `perf:`, `chore:`
- Scoped prefixes accepted: `fix(mcp):`, `feat(cli):`, `perf(dom):`
- No strict linting — but conventional style is strongly expected

## Trust Hierarchy (Critical for External Contributors)

The maintainer-vs-external divide is the sharpest observed across all analyzed repos:

| Tier | Merge speed | Examples |
|------|------------|---------|
| **Maintainer** (laithrw, sauravpanda, MagMueller) | Minutes to hours | #4524 (2 min), #4515 (2.2h), #4466 (1.7h), #4433 (1.5 days) |
| **Semi-internal** (ShawnPana) | Hours | #4450 (3.5h) |
| **Trusted external** (reformedot) | Days when championed | #3549 (6 days, 25+ evaluations) |
| **Unknown external** (first-time contributors) | 60+ days → stalebot | #3890 (66 days), #4030 (60 days), #3907 (62 days) |

**Implications**: New external contributors should assume zero human engagement for their first PR. Plan for the stalebot timeline and actively follow up.

## Reviewer Expectations

### Key reviewers
- **@sauravpanda**: Most active human reviewer; approves quickly for well-evidenced PRs
- **@laithrw**: Core maintainer; handles CLA, process, and most external PR closures. Will supersede external PRs with own implementation if scope is wrong.
- **@gregpr07**: Repo owner (Gregor Zunic); rare direct reviews
- **@MagMueller**: Runs evaluation benchmarks on PRs; very active for trusted contributors
- **cubic-dev-ai[bot]**: Automated review on every PR — informational, not blocking
- **cursor[bot]**: Automated bug detection — informational, not blocking

### What reviewers look for
1. **Production evidence** — crash logs, metrics, benchmarks get immediate attention (PR #4577: 19-min merge)
2. **Clear problem statement** — code snippets showing the bug, not just description
3. **Focused scope** — 1-4 files, single concern
4. **CI compliance** — pre-commit must pass; proactively explain pre-existing failures
5. **Edge case analysis** — #4479 was closed because it didn't handle `state=None`

### What they don't care about
- Bot review findings (cubic/cursor) — merged despite open bot issues in #4587, #4515, #4450
- Formal PR template — no template exists; clear prose is sufficient
- Tests for config/schema-only changes — PRs #4212, #4489 merged without tests

## Process & Workflow

1. **CLA is mandatory** — CLA Assistant bot checks within seconds of PR creation. Sign proactively at cla-assistant.io.
2. **Fork → feature branch → PR** — standard GitHub flow
3. **Agent eval on PRs** — evaluate_tasks.py runs 2 browser tasks; fork PRs skip (no API keys) → shows "Skipped" = pass
4. **Stale bot** — 45 days → stale label; 59 days → auto-closed. Keep PRs active.
5. **@claude available** — Claude Code agent responds to `@claude` in issues/PR comments

### Merge speed factors
| Factor | Impact | Evidence |
|--------|--------|----------|
| Production incident evidence | Fastest (minutes) | PR #4577 |
| Security crisis response | Fast (hours) | PR #4515 |
| Benchmarks + eval results | Fast (hours) | PR #4587 |
| External authoritative reference | Fast (days) | PR #4489 |
| Clean but non-urgent fix | Slow (weeks) | PR #4464, #4212 |
| Infrastructure/chore from external | Never merges | PR #3907, #4614 |

## Competitive Dynamics (New Patterns from 30 PRs)

### First-mover advantage
Popular issues attract multiple duplicate PRs. Only the first viable one wins.
- **Evidence**: Issue #4385 (SignalHandler) attracted 7 PRs from 3 contributors. #4387 (first viable) merged; 6 duplicates closed.
- **Action**: Always search `gh pr list -R browser-use/browser-use --state open --search "#{issue}"` before starting work.

### Maintainer supersession
Maintainers will open their own PR if yours has scope issues, even if they use your commits. The pattern is now observed 5 times across 35 PRs (~14% of closed external fixes).
- **Evidence**: #4401 (external, +241 lines, 6 files) → laithrw cherry-picked commits into #4528, merged in 5 min. #4507 (external, pinned litellm) → MagMueller wrote #4515 (removed litellm entirely). #4524 (maintainer, +3/-15) superseded 3 external Bedrock PRs that used manual schema builders (#4442, #4421, #4415). #4512 (laithrw, +6/-2) superseded #4448 (external passionworkeer, +121/-1, same issue #4443) — maintainer closed 4448 and merged 4512 within the same minute.
- **Signature**: External PR opens → maintainer quiet for days → maintainer opens own PR with smaller approach → maintainer self-merges in minutes → maintainer closes external with polite technical reason ("I instead used SchemaOptimizer", "manually copying over individual schema fields seems brittle").
- **Action**: Keep scope minimal — 6-line maintainer beats 121-line external every time. Before writing any fix in LLM/browser/profile code, grep for existing utilities (SchemaOptimizer, `get_chrome_profile_path`). Assume the maintainer already knows a helper you haven't found yet. When multiple external PRs already exist for the same issue (e.g., #4411 → #4442/#4421/#4415), the maintainer is likely drafting their own version — don't add a fourth.

### Internal knowledge moat
Maintainers have access to internal utilities, issue trackers, and telemetry that external contributors don't.
- **Evidence**: #4524 used existing `SchemaOptimizer` (external PRs built manual solutions). #4433 referenced AGI-* internal tickets with production occurrence counts.
- **Action**: Deep codebase exploration before proposing solutions. Search for existing utilities.

### Crisis PR dynamics
During security incidents, the most decisive fix wins. Maintainers almost always beat external contributors.
- **Evidence**: #4515 (remove litellm, 2.2h merge) beat #4507 (pin litellm, closed). #4507 was well-structured with CLA signed, but less decisive.
- **Action**: For crisis PRs, match maintainer urgency. Remove > pin > mitigate. Pick up follow-up work after the crisis merge.

## Common Rejection/Closure Reasons

| Reason | Frequency | Evidence |
|--------|-----------|---------|
| **Stale-closed** (45+14 day pipeline) | Most common | #3890, #3907, #3926, #4030, #4035, #4051 |
| **CLA not signed** | Hard gate | #4595, #4522 |
| **Maintainer supersession** | Common | #4401→#4528, #4507→#4515, #4524 superseded 3 PRs |
| **Duplicate PR** (not first-mover) | Common | 6 duplicates closed for #4385 |
| **Unsolicited infrastructure** | Always rejected | #3907, #4614 |
| **Deferred platform** (Windows) | Always rejected | 14 of passionworkeer's 30 PRs |
| **Incomplete diff** | Instant rejection | #4522 (forgot source files) |
| **Volume-over-quality spam** | Ignored | passionworkeer: 30 PRs, 0 merged |

## The Two-Ping Rule (New in Distillation #4)

After opening a PR, the appropriate follow-up escalation is at most two polite pings. After the second ping, the PR is functionally dead — continued waiting just costs you time.

- **Evidence**: PR #4292 (giulio-leone, Windows tunnel fix) was technically excellent — clear description, issue link (#3912), root-cause analysis, proactively addressed 2 cubic bot findings with code+commentary. Author pinged on day 2 ("CI is green, rebased") and day 5 ("all review feedback addressed"). Zero human response in 18 days. Author closed their own PR without comment on day 18.
- **Pattern**: The second ping is the last signal maintainers will engage with. If a PR has no human interaction 3-4 days after two polite pings, the right move is to self-close or mirror to an alternative (ask via issue comment, ping via Discord, tag the maintainer's linked issue).
- **Platform dead-zone signal**: Windows/cross-platform PRs from external contributors hit this dead-zone most often because the core maintainer team is macOS/Linux-centric. Before investing on a cross-platform fix, check merged PRs in the same area over the past 90 days — if none exist, the area has no maintainer champion.
- **Action**: Set a "PR budget" — how many days am I willing to spend championing this? Don't let sunk cost turn 2 days of work into 18 days of waiting. A self-closed PR with a clean explanation ("closing — will revisit when the CLI platform-support roadmap changes") preserves your reputation and frees attention for contributions with actual maintainer interest.

## Bot Approval Is Not Design Approval (New in Distillation #4)

Cubic-dev-ai's "no issues found" verdict reflects static analysis — type safety, null handling, obvious bugs. It does NOT reflect whether your approach matches the maintainer's mental model of the correct fix.

- **Evidence**: PR #4442 (Bedrock schema fix) got a clean cubic review ("No issues found across 1 file") but was still rejected by @laithrw because the approach (pass raw schema) had a semantic issue cubic couldn't see ("passing the raw schema still confuses the model because of unresolved references"). The maintainer's preferred fix used `SchemaOptimizer` to flatten references — a utility cubic had no knowledge of.
- **Action**: Treat cubic/cursor approval as a necessary-but-not-sufficient gate. Before submitting a PR in LLM/schema/browser-core areas, explicitly check for existing helper utilities (`grep -r SchemaOptimizer`, `grep -r '_normalize'`, `grep -r 'flatten'`). When in doubt, open a brief issue comment asking "I see `SchemaOptimizer` handles X — is using it the right approach here?" before writing code.

## Anti-Patterns to Avoid

### The serial re-submitter (passionworkeer pattern)
- 30 PRs in 26 days, 0 merged
- Created new PRs for each review iteration instead of amending (5 PRs for one issue)
- 14/30 PRs targeted Windows — explicitly out of scope per project decisions
- **Lesson**: Read project scope decisions. Amend PRs, don't create new ones. Quality >>> quantity.

### The incomplete diff
- #4522: Description claimed fixes in 2 source files, but only the test file was committed
- **Lesson**: Run `git diff --stat` before submitting. Verify diff matches description.

### The over-scoped crisis response
- #4507: Pinned litellm + added README security notice + modified install script (3 changes for a 1-change problem)
- **Lesson**: During crises, make the smallest decisive fix. Don't add documentation/tooling changes.

## Success Patterns

1. **Data-driven PRs win** — Include benchmarks, crash metrics, or authoritative references
2. **Small is beautiful** — The fastest external merges were +4/-3 (#4478, 21h) and +24/-2 (#4387, 8 days)
3. **Conventional commit prefix** — Every merged PR used fix:, feat:, or perf:
4. **Problem-first description** — Start with what's broken and why, then explain the fix
5. **Proactive CLA** — Sign before pushing; don't wait for maintainer prompt
6. **AI disclosure accepted** — Claude Code attribution merged without friction
7. **Follow-up fix PRs** — Reviewing recently merged PRs and fixing issues found builds trust (#4590: 3h merge)
8. **Security framing accelerates review** — Root cause + threat model in description (#4598: 17h merge)
9. **Docs as trust-building** — Low-risk docs PRs build relationship for higher-risk future work (#4450: 3.5h merge)
10. **Study the codebase first** — Know what utilities exist before building new solutions
11. **First-mover advantage** — Be the first to submit for popular issues; later duplicates die

## Gold Standard Description Template

Based on merged PRs from all tiers, this structure gets the fastest review:

```markdown
## Summary
{Root cause of the problem — explain the threat model or failure mode}
{What the fix does — specific behavioral changes}

## Test plan
- [ ] {Exact verification step 1}
- [ ] {Exact verification step 2}
- [ ] {CI command: `uv run pytest -vxs tests/ci`}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

## External Contributor Survival Guide

1. **CLA first** — Sign at cla-assistant.io before opening any PR
2. **Check for existing PRs** — Search open AND closed PRs on your issue; be the first mover
3. **Have a demand signal** — Link an existing issue; never submit unsolicited work
4. **Read project scope** — Windows is deferred; don't contribute deferred-platform fixes
5. **Study the codebase** — Grep for existing utilities before building solutions
6. **Keep scope minimal** — 1-4 files, single concern, net-negative lines preferred
7. **Actively seek review** — Comment on your PR, join Discord after 1 week
8. **Respond to stalebot** — Every 45 days, add a comment to reset the timer
9. **Amend, don't re-create** — When a PR needs revision, push to the same branch
10. **Start with docs/small fixes** — Build trust before attempting large features

## AI Contribution Policy

- **Explicitly AI-friendly** — repo has CLAUDE.md, AGENTS.md, @claude bot
- **No anti-AI policy** — AI-generated PRs merged with disclosure (PR #4598, #4590)
- **cubic-dev-ai and cursor bots** review every PR — AI tooling is normalized
- **Recommended disclosure**: `🤖 Generated with [Claude Code](https://claude.com/claude-code)` in PR body or `Co-Authored-By:` trailer
