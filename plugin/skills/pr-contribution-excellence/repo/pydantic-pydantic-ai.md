# pydantic/pydantic-ai Contribution Patterns

Last updated: 2026-04-09 | Distillation #3 | Based on 40 PRs analyzed

---

## Repository Conventions

- **Python 3.10+**, strict type safety (pyright + mypy), ruff formatting
- **uv workspace monorepo**: core in `pydantic_ai_slim/`, graph in `pydantic_graph/`, evals in `pydantic_evals/`, CLI in `clai/`
- **Meta-package trap**: `pydantic_ai/` is a re-export meta-package, NOT where code lives. All implementation goes in `pydantic_ai_slim/pydantic_ai/`. Putting code in the wrong package is an instant reject. (Evidence: #4802)
- **Tests**: pytest with `inline-snapshot` for assertions, `pytest-recording`/`vcrpy` for API recordings. 100% code path coverage required.
- **Test conventions** (from `tests/AGENTS.md`):
  - `snapshot()` assertions, not manual field checks (rules:86, :194)
  - Test through public APIs (`Agent.run()` + `FunctionModel`/`TestModel`), not private `_modules` (rule:177) — bot enforces across rounds, re-cites unresolved items
  - Test file naming: `test_<module_name>.py` (rule:173)
  - No inline imports in tests (rule:464) — all imports at top of file
  - `exported_spans_as_dict()` + `snapshot()` for OTel/span assertions
  - Use `retries_log` + `all_messages() == snapshot(...)` for retry test assertions
  - `test="skip"` in docs code blocks only for external services, not for uninstallable packages
- **No unnecessary `cast` or `Any`** — end-to-end type safety is core to the Pydantic brand
- **`int | None` fields**: always use `is not None`, never truthiness (`or`). Catches 0-treated-as-None. (Evidence: #4687)
- **`kind` discriminator field**: Every member of public union types (e.g., `UserContent`) must have `kind: Literal['foo'] = 'foo'`. Undocumented but strictly enforced. (Evidence: #4432)
- **`pragma: no cover`** is not allowed on reachable paths. Write a test or remove the branch. (Evidence: #4053, #4687)
- **`@deprecated` decorator** preferred over `warnings.warn` for deprecations. (Evidence: #5032)
- **mkdocs reference links for API symbols**: `[`ClassName`][module.path.ClassName]` per `.cursor/rules.mdc`. Bare backtick references are convention violations. (Evidence: #4584)
- **Read `agent_docs/index.md`** and directory-specific `AGENTS.md` files before touching code
- **Images in docs must be tinified** — CI checks this
- **Lock file hygiene**: `uv.lock` must be regenerated after any `pyproject.toml` change (run `make install`). Bloated lock diffs (+5000 lines) from stale rebases are flagged immediately. (Evidence: #4736, #4906)

## Reviewer Expectations

### @DouweM (core architecture, features)
- Extremely thorough: 20+ inline comments on large features (#4865), 68 comments on #3206, 35 on #4123
- Cares deeply about: minimizing unnecessary changes, keeping existing comments, reducing duplication, avoiding redundant serialization round-trips
- Will take over iteration with Claude if the contributor's code needs significant restructuring (#4851: 22 maintainer commits on contributor branch)
- Engages quickly on well-scoped bugs — #4911 merged in ~2 hours with his review
- Asks probing questions: "Should we consider...?", "Can we do better?", "Is an empty string appropriate?"
- For large features: stays engaged through multiple CHANGES_REQUESTED rounds (4 rounds on #4123)
- Institutional memory: cites specific prior bugs to justify test requests (Temporal serialization in #4432)
- **Architecture-first gating**: "You know I would never accept hard-coded checks like this, rather than some generic way to specify this using profile or something." (#3807)
- **Style preferences**: class methods over free functions (`FunctionSignature.from_function`), keyword-only dataclasses (`kw_only=True`), specific TypeExpr types over strings. Question-based, not demands.
- **Performance-conscious**: "I'd rather check the expected type first, to save overhead" and "Can we use `nested.provider` directly... so we don't have to dump + validate unnecessarily?" (#4528)
- **Uses Claude agent for reviews openly**: Posts comments attributed "Review by Claude (Opus 4.6), on behalf of @DouweM." (#4906)
- **Documents call outcomes publicly**: "(For context to those reading along, Aditya and I discussed this PR on a call...)" (#3865)

### @Kludex (pragmatic, minimal-fix advocate)
- Favors minimal, localized fixes. New shared utilities require strong justification.
- Closed #5003 ("I don't think the complexity justifies the issue") — preferred one-line-per-provider fix over shared utility
- Quick approvals on trivial fixes: "Thanks! :)" on #4970, #4809
- Sends "are you still interested?" pings that are re-engagement triggers — respond within a day
- **Naming precision**: "Can we call this just `_http_client`?", questioning necessity: "Why do we need both of them?" (#4421)
- **Knows Python patterns**: suggests inline `@deprecated` decorator, `snapshot()` for assertions (#5032)
- **Process enforcer**: "Please create an issue first. If it has attraction, we'll happily add the model class." (#4489)
- **Content moderation awareness**: "is the endpoint really called 'uncensored-chat'?" (#4489)

### @alexmojaki (OTel/instrumentation, deep technical review)
- Drives OTel semantic debates: `StatusCode.OK` vs `UNSET` vs `ERROR` (#4661)
- Fast feedback loop style: asks question → author explains → "put it in code" → done → "Thanks!" → merged
- Bot findings don't block if he makes a different human judgment (#4108)

### @dmontagu (API design intent)
- Guards intentionally loose public API types: "the goal is to purposely keep it loose as this is the only guarantee we want to make on the public API" (#4553)
- Pattern-matches small unmotivated PRs against AI noise: "it seems like it was just an AI generated false positive" (#4553)

### @adtyavrdhn (migrations, chore work)
- Creates umbrella issues for batch work (#4818 `RequestUsage.extract()` migration)
- Approves smaller PRs but may want a second reviewer
- Explicit about next steps: "I'll let @DouweM take a look as well"

### @dsfaccini (dominant external contributor, collaborator)
- Uses Claude transparently: mid-review "Claude here:" replies, `🤖 Generated with Claude Code` footer, `Co-Authored-By: Claude Opus 4.6` trailers
- Trusted for multi-month PRs (90 days on #3971, 44 days on #4421)
- High volume but speculative PRs get closed when design isn't validated first (#3807, #3973, #3206)
- Closes competing PRs from external contributors when overlap detected (#4951)

## Bot Review Ecosystem

**pydantic-ai has one of the most active bot review cultures observed:**

| Bot | Role | Authority | Response strategy |
|-----|------|-----------|-------------------|
| **github-actions[bot]** | Primary code reviewer. Substantive inline comments that carry maintainer weight. Tracks state across rounds — re-cites unresolved items word-for-word. | **Blocking** — re-appears on each push until addressed | Address all findings before requesting human review |
| **devin-ai-integration[bot]** | Secondary AI reviewer. Catches real bugs: architectural regressions (#4991), copy-paste errors (#4489), convention violations (#4584), promotional content (#4918). | **Substantive advisory** — increasingly accurate | Address in first round. Catches real issues that kill PRs. |
| **Copilot** | Grammar, scope-creep detection, inline suggestions | **Advisory** | Accept good suggestions but apply locally (not via GitHub UI to avoid weak co-authored commits) |
| **PR Guard bot** | Duplicate detection + stale management | **Deterministic gate** — one issue = one open PR max | **Cannot be overridden by PR quality.** Search before implementing. |

**Comment inflation:** 40-60% of review comments come from bots. When assessing review complexity, filter for human reviewers only.

**Review pattern:** Bot-heavy early, human-final review is the norm. #4528 had 51 Devin comments over 27 days, then 8 DouweM comments on merge day. Treat bot feedback as first-pass requirements.

## Process & Workflow

1. **MANDATORY pre-work check:** Run `gh pr list -R pydantic/pydantic-ai --state open --search "#NNNN"` before ANY implementation. Also search by keyword across open PRs AND stale/closed PRs on the same issue (#4528 had stale sibling #4072). (Evidence: #4894, #4528)
2. **Semantic search too:** Search by keyword (`service_tier`, `validation`) and affected files, not just issue number. Competing PRs may reference different issues for the same root bug. (Evidence: #4897 vs #4911, #4951 vs #3971)
3. **Issue invitation ≠ open call.** When a maintainer explicitly invites a specific person, that slot belongs to them. (Evidence: #5021 closed in 88 minutes)
4. **Issue-first is mandatory for non-trivial changes.** Even for providers: "Please create an issue first. If it has attraction, we'll happily add the model class." (Evidence: #4489, #4584)
5. **Trivial fixes don't need an issue.** Typos, broken links, small doc improvements — just submit. (Evidence: #4970)
6. **Bug fixes with clear scope can skip formal assignment.** (Evidence: #5020 and #4860)
7. **Features require champion + assignment.** Comment on the issue, explain your use case, wait for maintainer agreement. (Evidence: #4865)
8. **Validate approach with maintainers BEFORE implementing features.** A comment on the issue asking "should I do X or Y?" saves hours. (Evidence: #5003, #3807)
9. **Don't ship API surface without a consumer.** If nothing in-tree uses your new method/property, it won't merge. (Evidence: #4851)
10. **Mirror existing patterns.** "mirrors how WebSearch already falls back to DuckDuckGo" → merged in 3 days. (Evidence: #4906)
11. **Stale bot closes PRs after 21 days** with "awaiting author revision" label. Even "I'll get to this by [date]" pauses it.
12. **Multi-reviewer culture.** Even after one approval, a second maintainer may review.
13. **Approval ≠ immediate merge.** #4584 approved day 1, merged day 30. Auto-merge queues. Don't ping.
14. **Call-based alignment for complex features.** Both #3971 and #3865 reference design calls with DouweM. Complex features require synchronous alignment before async PR review.
15. **Draft PRs are invisible to maintainers.** Promote to ready-for-review or expect zero human engagement. (Evidence: #3973)
16. **Active rebasing is mandatory for long-lived PRs.** #3865 was days from merge but died to conflicts. #3971 survived 90 days because author kept rebasing. (Evidence: #3865, #3206)

## Common Rejection Reasons

| Pattern | Speed | Example | Prevention |
|---------|-------|---------|------------|
| **Bot duplicate detection** | 11 seconds | #4894 | Pre-work search by issue number |
| **Superseded by broader fix** | 12 hours | #4897, #4951 | Semantic search + check for collaborator PRs on same files |
| **Issue invitation hijack** | 88 minutes | #5021 | Read issue thread for social context |
| **Design philosophy** | 4 hours | #5003 | Validate approach before implementing |
| **No issue created** | 37 days | #4489 | Create companion issue first |
| **Architecture-blocked** | 3.5 months | #3807 | Validate extension point before coding |
| **No in-tree consumer** | 13 days | #4851 | Ship API with consumer in same PR |
| **AI-noise pattern match** | 33 days | #4553 | Include user-visible motivation in description |
| **Self-promotion** | 4 days | #4918 | Don't promote personal libraries in official docs |
| **Version constraint breakage** | 12 hours | #4951 | Design for backward compatibility |
| **Contributor abandonment** | 60 days | #4111 | Respond to every round; say "I'll return by [date]" |
| **Policy (maintenance burden)** | 44 days | #4402 | Check if a third-party integration page exists |
| **Code quality failure** | 13 days | #4802 | Run the code locally; understand repo layout |
| **Problem became irrelevant** | 170 days | #3206 | Validate problem persists before deep investment |

## Success Patterns

### Fast-merge (hours to 3 days)
- Small, focused bug fix with broad impact — #4911 merged in ~2 hours
- Thorough PR description with per-bug root cause analysis — #5020 merged same day
- Trivial self-evident correctness — #4970 merged in 3 days, zero friction
- Feature explicitly mirroring existing pattern — #4906 merged in 3 days
- Follow-up chore referencing parent PR — #5032 merged in 6 hours
- Key: demonstrate deep understanding and mirror existing architecture

### Standard merge (3-30 days)
- Picked up from maintainer-created umbrella issue — #4945 followed established pattern
- Docs PRs that fill navigation gaps — #5018 merged in 18 hours, #4584 in 30 days
- SDK migrations with clean description — #4736 merged in 13 days
- One-line docs additions with real URLs — #4809 merged in 13 days
- Addressed reviewer feedback quickly and constructively

### Long-running merge (1-3 months)
- Large features that survive multiple CHANGES_REQUESTED rounds — #4123 (62 days), #4432 (33 days), #4421 (44 days), #3971 (90 days)
- **Survival factors:** Persistence, declared absences (not silence), active rebasing, genuinely wanted feature, call-based alignment
- Domain credibility earns latitude — #4108 library maintainer got flexible template compliance

### Rewritten-but-credited (1-2 weeks)
- Large feature PR proves approach — maintainer takes over iteration (#4865, #4851)
- **This is expected and documented** — don't over-polish large features

## Response Culture

- **Show, don't tell.** The expected response to review comments is a code change, not a thread discussion. Verbal responses reserved for disagreements or clarifying questions. Observed ratio: ~16% verbal responses to total comments. (Evidence: #4432)
- **Don't trust bots over humans on ambiguous design.** Treat bot findings as a checklist to validate with a human. Blindly implementing Devin suggestions then reverting when the human clarifies wastes rounds. (Evidence: #4661)
- **Respond to "are you still interested?" within a day.** This is a re-engagement trigger, not a passive question. (Evidence: #4108)
- **Design decisions need explicit @maintainer ping.** Don't bury architectural pivots in code; surface them as comments on the relevant line. (Evidence: #4687)
- **Self-closing is respected.** When you discover a regression or architectural blocker, close voluntarily with analysis — better than waiting for rejection. (Evidence: #4991)
- **Consolidated replies are efficient.** Single comprehensive reply addressing all open threads at once, rather than piecemeal responses. (Evidence: #3971)
- **When bot says "it didn't work," report precisely.** Concrete technical explanation ("UndecidedValue can't be hashed by re.search"), not just "it didn't work." (Evidence: #5032)

## AI Disclosure

- AI disclosure (`🤖 Generated with Claude Code`) has no documented negative effect. Kludex approved #4970 without comment on it.
- `Co-Authored-By: Claude Opus 4.6` in commits is visible and accepted. Combined with mid-review "Claude here:" replies — two validated disclosure patterns.
- **Maintainers use AI openly**: DouweM posts reviews attributed to "Claude (Opus 4.6), on behalf of @DouweM." (#4906)
- **AI-noise risk**: Small unmotivated type/annotation PRs without user-visible problem trigger "AI generated false positive" categorization (#4553). Mitigate by including concrete use cases in description.
- Strip all tool artifacts (`[result-id: r1]`, session IDs) from PR descriptions. (Evidence: #5003)
- The "AI generated code" checkbox in the PR template must be checked by a human in the GitHub UI, not by the agent.
- Partial disclosure (Co-Authored-By in one commit but not PR body) creates ambiguity. Be consistent. (Evidence: #4528)

## Cross-cutting Type Changes

When adding to a public union type (e.g., `UserContent`):
- **Every consumer must handle it.** Fan-out to all 14+ providers is mandatory, not optional. (Evidence: #4432)
- Budget for 30+ files when the type is used across providers
- Don't defend scope boundaries that leave runtime crashes on public types
- Add `kind: Literal['...']` discriminator field
- Maintainer institutional memory may expand your test surface (e.g., Temporal serialization tests)

## Dependency & Provider Changes

- **Notability bar for providers**: If OpenAI-compatible, bar for a dedicated class is much higher — "It's already possible to connect via OpenAIChatModel." (Evidence: #4489)
- **Audit endpoint branding**: Content-moderation concerns from endpoint names alone — "is the endpoint really called 'uncensored-chat'?" (Evidence: #4489)
- **`uv.lock` regeneration mandatory**: After any `pyproject.toml` specifier change, run `make install` to regenerate. (Evidence: #4736)
- **Rebase before opening**: Stale lock files with thousands of extraneous changes are flagged immediately. (Evidence: #4906)
- **VCR cassettes**: After SDK migrations, verify cassette recordings still match wire format, not just that tests pass. (Evidence: #4736)
- **Version constraints need migration strategy**: Don't bump minimum versions without backward-compat plan. (Evidence: #4951)
- **Branch names should match final intent**: Rename `fix/cap-below-2.0` if you end up upgrading to v2. (Evidence: #4736)
