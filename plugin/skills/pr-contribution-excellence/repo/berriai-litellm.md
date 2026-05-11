# berriai/litellm Contribution Patterns

Last updated: 2026-04-23 | Distillation #4 + live-incident updates | Based on 35 PRs analyzed

---

## Repository Conventions

1. **Black formatting is the hard gate** — run `make format` before every commit. A single unresolved lint failure kills an otherwise well-written PR — #15166 died after 108 days from an unfixed formatting violation.
2. **Tests go in `tests/test_litellm/`** mirroring `litellm/` structure. **Only mocked tests — no real network calls.** Integration tests with live API calls must go elsewhere. File naming: `litellm/foo/bar.py` → `tests/test_litellm/foo/test_bar.py`. (Evidence: #25174 — Greptile P1 for live API calls in unit test folder)
3. **Linting stack**: Black + Ruff + MyPy + circular import detection + import safety. All via `make lint`. Run locally before every push — CI lint failures automatically deprioritize your PR.
4. **Module-level imports only** — no inline imports inside functions (except to break circular deps). MyPy enforced. Greptile flags inline test imports too.
5. **Cyclic imports are runtime failures** — CodeQL detects them. Validate with `python -c "import litellm"` before pushing.
6. **Build system is `uv`, not Poetry** (migrated before 2026-04-23 — older READMEs/tutorials still say Poetry). `make install-dev` → `uv sync --frozen`. Run Python with `uv run --no-sync ...`, not `poetry run ...`. The Makefile targets are authoritative.
7. **External-contributor PRs target `litellm_oss_branch`, NOT `main`** (policy added before 2026-04-23). The `Guard main branch` CI workflow rejects any fork PR targeting `main` with the error: "retarget the PR against `litellm_oss_branch` instead." Base your PR's `--base` against `litellm_oss_branch`. If an older PR targets `main`, rebase with `git rebase --onto upstream/litellm_oss_branch upstream/main <branch>` and retarget via `gh api repos/berriai/litellm/pulls/N -X PATCH -f base=litellm_oss_branch`. (Evidence: PR #26344 caught the policy on first push.) This rule is also declared in the recon's `## Policies` section (`external_pr_base: litellm_oss_branch`) and enforced at PR-creation time by `pre-pr-review` — so a mismatched `--base` is now caught by `pr-workflow-gate` before `gh pr create` lands.

## Gotchas when formatting before push

1. **Never pipe a mixed file list into `black` via `xargs`.** When Black receives an explicit file path, it bypasses its default `--include` filter and formats the file regardless of extension. Running `git diff --name-only | xargs black` on a diff that contains `model_prices_and_context_window.json` (a 5k-line JSON pricing table at the repo root) will inject Python trailing commas, producing 10k lines of invalid JSON that silently passes as "reformatted". Always filter first: `git diff --name-only | grep -E '\.pyi?$' | xargs uv run --no-sync black` — or pass Python files by name. Verify the working tree after every format pass.
2. **Prefer `make format`** for whole-project formatting — the Makefile runs `cd litellm && black .`, which respects Black's include filter and won't touch repo-root JSON.
3. **Black version drift breaks old branches.** A fork's long-standing branch may have been formatted with an older Black; after rebasing onto current `litellm_oss_branch`, re-run `make format` and re-push. (Evidence: PRs #25454 and #25520 both had `lint / Check Black formatting` failures solely from Black version drift — resolved after rebase.)

## CLA — The First Hard Gate

1. **Sign the CLA at cla-assistant.io/BerriAI/litellm before pushing.** CLA identity must match your git commit email. If your email isn't linked to your GitHub account, the CLA bot blocks permanently.
2. **Never use AI identity as a git co-author.** `Co-Authored-By: claude` or similar non-human trailers create an unsignable CLA identity. Squash to a single human-authored commit or use comment-level disclosure instead.
3. **AI disclosure via PR body is safe.** Write "AI-assisted PR (Claude). All tests verified locally." in the description. "Made with Cursor" is also accepted and normalized.

## Greptile — The Primary Review Gate

1. **Greptile is the de-facto first-pass reviewer.** Comment `@greptileai` immediately after opening. Aim for >= 4/5 confidence before requesting human review.
2. **Address findings with commit SHA references** — "Fixed in {sha} — {what changed}". This builds trust.
3. **Greptile score correlates with merge** — 3/5 = silent close, 4/5 = mergeable, 5/5 = near-instant merge. But the score is not a hard gate.
4. **P1/P2 findings are advisory, not blocking** — across 9 merged PRs in batches 5-7, every P2 was merged without being addressed. Even P0 findings (#24988 — unreachable code) don't block. The entire bot system is advisory.
5. **But P1s are prescient** — post-merge regression in #24135 validated Greptile's P1 about silent drops. Take P1s seriously for correctness, even if they don't block merge.
6. **You can argue with Greptile** — explain your design intent, and Greptile acknowledges valid reasoning and backs down. Effective for P1s you disagree with. (Evidence: #24988)
7. **When Greptile and maintainers disagree, MAINTAINER WINS** — #24440 author added a feature flag to satisfy Greptile score; maintainers told him to remove it. Don't game the bot score at the expense of what maintainers want.
8. **Interactive pair-programming** — `@greptileai how would you address [concern]?` for specific fix suggestions, then implement them. (Evidence: #24135)
9. **100-file limit** — Greptile refuses PRs with >100 changed files ("Too many files changed for review"). Stay under 100 files for full bot review coverage. (Evidence: #25141 — 358 files)

## Reviewer Expectations

1. **Human reviewers give minimal feedback** — krrish-berri-2 and ishaan-berri are primary mergers. Typical response: single targeted comment or bare "lgtm". Don't expect detailed code review. (Evidence: 25/35 PRs had zero human inline comments)
2. **krrish-berri-2 cares about security** — guards against key leaks, credential logging, command injection.
3. **Never merge over unresolved CHANGES_REQUESTED** — #25340 merged despite objection, then was immediately reverted.
4. **Repeat contributors get better treatment** — J-Byron (3 merged PRs) received actionable maintainer feedback. First-time contributors get silence. Build trust with small PRs first.
5. **Escalation path: ping maintainers by name after 3+ days** — @-mention specific maintainers in PR conversation.

## Process & Workflow

1. **Issue link in body, not comments** — use `Fixes #NNNN` in the first paragraph. PRs without issue links get less attention.
2. **Zero maintainer engagement = silent death** — contributors who don't secure early interest get deprioritized. Open the issue first.
3. **Silent closures are common and unpredictable** — ~35% of community PRs are silently closed with zero feedback, even perfect ones (#24961: 4-line change, 100% coverage, clean Greptile). Some issues get fixed internally.
4. **Duplicate-issue PRs both die** — #25091 and #25061 both targeted #25015. Both closed. Check for competing PRs before starting. Also check if maintainers already have an internal fix.
5. **Merge cadence** — Recent PRs batch-merge in ~39h. Older/complex PRs: 6-24 days. 62-day outliers exist. Staging branch cadence adds structural delay.
6. **Fork branches: use descriptive names, not `main`** — fork's `main` branch PRs are a persistent anti-pattern. Use `fix/presidio-offset` or `feat/prometheus-buckets`.
7. **Community bumps help stale PRs** — if your PR is stuck, finding other affected users who comment "bump" adds social pressure. (Evidence: #20261 — merged after bump at 2 months)
8. **Proactively explain pre-existing CI failures** — don't let red CI discourage you. Explain which failures aren't yours and wait.
9. **Docs-only PRs die from neglect** — bundle docs fixes with code changes.
10. **CI failures on main are common** — lint, proxy-infra, CodeQL, zizmor checks frequently fail. Document which failures are pre-existing.

## Coverage Requirements

1. **100% patch coverage is ideal** — every merged PR in our 20-PR merged dataset had 90%+ patch coverage.
2. **~92% is the practical floor** — 92.85% was acceptable (#24831). 75% was closed (#25091). 68% was closed (#25141).
3. **0% patch coverage on production lines = instant red flag** — even when all tests pass. (Evidence: #25433)
4. **Provide exact test commands** — `poetry run pytest tests/test_litellm/...` in the PR body helps reviewers verify trivially.

## No Tests = Guaranteed Death

This is the #1 reason community PRs die. Every merged PR in our 35-PR dataset includes at least one test file.

- "Python syntax verified" is NOT a test. (Evidence: #23875 — died after 17 days with no test)
- "I tested it locally" is NOT a test unless you include a test file.
- Even a 4-line fix needs at least 1 test in `tests/test_litellm/`.

## Common Rejection Reasons

1. **No tests** — guaranteed death. See above.
2. **CLA failure** — unlinked email or AI co-author identity.
3. **Unresolved lint/format failure** — even one red CI check permanently deprioritizes.
4. **Scope creep** — bundling multiple concerns.
5. **No maintainer buy-in** — feature PR without prior issue interest.
6. **Blank CI checklist** — reads as "not verified".
7. **Duplicate fix** — another PR or internal fix already addresses the issue.
8. **Low patch coverage** — below ~90%.

## Success Patterns

1. **Small, focused bug fixes merge fastest** — 1-3 files, clear root cause, references an issue.
2. **Before/after examples in bug fix descriptions** — #24998 showed garbled PII output before/after. Makes bugs viscerally clear. Strongest description pattern for bug fixes.
3. **Include production error frequency** — "~62 errors/hour" (#20261) converts abstract bugs into concrete urgency.
4. **Screenshots for UI and metrics changes** — visual evidence of `/metrics` output or UI renders adds credibility. (Evidence: #24831, #24440)
5. **Explain test limitations proactively** — "ideally tested against real rate limit, but hard to trigger on demand" builds trust. (Evidence: #24703)
6. **Self-correction earns respect** — self-close and refile with fixes is normal and positive.
7. **AI disclosure is welcome** — use PR body disclosure or "Made with Cursor" footer.
8. **Model new providers on existing ones** — OVHCloud is the reference for audio transcription.
9. **19 commits is fine** — heavy iteration through Greptile feedback is normal. Commit count doesn't matter.
10. **Explicitly trigger @greptileai review** — shows engagement. Do it on PR creation.
