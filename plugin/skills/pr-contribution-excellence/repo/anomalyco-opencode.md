# anomalyco/opencode Contribution Patterns

Last updated: 2026-04-08 | Distillation #2 | Based on 30 PRs analyzed

---

## Repository Conventions

- Preserve the PR template headings exactly or automation will close the PR before a human review happens. Even trivial 2-line doc fixes get bot-closed for empty verification sections.
  - Evidence: `#20714`, `#20866`, `#21091`, `#21168`, `#20925`
- Put `Closes #...` or `Fixes #...` in a GitHub-recognized place and verify the PR is not carrying the `needs:issue` label after opening. The bot fires within seconds.
  - Evidence: `#21042`, `#21091`, `#12093`, `#20272`
- Conventional-commit titles are enforced, but title compliance alone is not enough. Body compliance and issue linkage are separate gates. PR title and commit message prefix should match (`fix` vs `feat` inconsistency signals unclear intent).
  - Evidence: `#20714`, `#21042`, `#21091`, `#12093`, `#12236`
- For first-time or external contributors, assume bot compliance is the first reviewer. Human correctness never matters if the bot closes the PR first. The 2-hour remediation window is strict — monitor immediately after submission.
  - Evidence: `#20714`, `#20866`, `#21089`, `#21091`, `#21168`, `#20925`
- Use the correct conventional commit prefix. "docs:" for a code change or "fix:" for a feature erodes changelog trust.
  - Evidence: `#12236` (used "docs:" for runtime logic change)
- Create the issue BEFORE the PR, not after. `needs:issue` is a hard gate that blocks human review entirely.
  - Evidence: `#12093` (never created issue, never reviewed, stale-closed)

## Reviewer Expectations

- Small bug-fix PRs that include exact commands in the verification section are the safest path to merge.
  - Evidence: merged `#21040`, `#20959`, `#21054`
- A tiny regression test or narrowly targeted change is highly mergeable when it directly proves the bug.
  - Evidence: merged `#21053`, `#20959`, `#19953`
- Maintainers can merge terse PRs with empty or minimal bodies because they already have trust. External contributors should not imitate that style.
  - Evidence: merged `#21053`, `#21047`, `#21138` versus closed external PRs `#20714`, `#20866`
- If maintainers ask for broader test coverage or docs, the quickest path is usually to supersede the PR with a tighter replacement instead of arguing.
  - Evidence: `#15852` replaced by `#21112`
- Copilot bot feedback is substantive — it catches real correctness issues, regression introductions, and parity mismatches. Iterate on Copilot feedback the same way you would human feedback.
  - Evidence: `#12236` (valid parity mismatch), `#12170` (caught regression), `#21138` (4 iteration rounds)
- Bot `/review` "lgtm" is NOT human approval. Multiple PRs with bot lgtm stale-closed without any human ever looking.
  - Evidence: `#12127`, `#9854` (both bot-lgtm'd, both stale-closed)

## Communication & Attention

- **Discord is the real communication channel** — a maintainer said explicitly that GitHub notifications are overwhelming. Use Discord for follow-up, not more GitHub pings.
  - Evidence: `#20272` (maintainer: "GH notifications are overwhelming")
- **Target maintainer-neglected areas** for fast-track merges. Contributions to areas maintainers feel guilty about get enthusiastic, rapid review.
  - Evidence: `#21134` (ACP support — maintainer: "I love merging things for ACP support because I've been lackluster at maintaining it myself" — merged in 3.5h)
- **Repeat contributors earn faster domain-expert reviews.** Building a track record within a specific area (e.g., Cloudflare provider) leads to faster engagement from domain-affiliated reviewers.
  - Evidence: mchenco's `#20589` (merged silently) then `#20399` (LGTM from Cloudflare team member in 18h)
- **Polite single nudge after a few days is acceptable.** Don't wait 37 days — ping after 2 weeks max.
  - Evidence: `#19953` (nudged at day 3, merged at day 8), `#13748` (waited 37 days before pinging, wasted 5 weeks)
- **Silent merge with zero comments is the normal success path** in this high-volume repo. Don't interpret absence of feedback as a problem.
  - Evidence: `#19953`, `#20589`, `#20399`

## Process & Workflow

- Check for duplicate or competing PRs AND for fixes already on `dev` before coding. The repo runs duplicate-detection comments. Fixes can also land via direct maintainer commits without any PR.
  - Evidence: `#20714`, `#20866`, `#21178` (duplicate detected in 60s), `#17170` (fix landed independently on dev), `#19351` (fix landed via direct commit)
- Keep the first PR narrowly scoped to an existing issue, not a speculative feature or a multi-thousand-line subsystem rewrite.
  - Evidence: merged `#21040`, `#20959` versus closed `#20866`, `#21091`, `#10340`
- Novel UI/core feature work needs prior buy-in. Even technically correct code can stall or get replaced if it jumps ahead of design/process alignment.
  - Evidence: `#15852`, `#20866`, `#21082`
- If you open a PR and automation comments on compliance, fix it immediately. The closure window is about two hours.
  - Evidence: `#21042`, `#20866`, `#21089`, `#21168`
- **Validate technical feasibility of the core mechanism BEFORE opening a PR.** Research existing forks and upstream API status.
  - Evidence: `#21082` (self-closed after discovering Anthropic deprecated assistant prefill)
- **Search for existing PRs on the same issue BEFORE forking.** Zero pre-flight triage wastes high-quality work.
  - Evidence: `#21178` (38 minutes fork-to-PR, but duplicate existed for 3 weeks)
- **60-day stale bot is active.** Contributors must stay responsive — unanswered feedback or silence leads to automatic closure regardless of code quality.
  - Evidence: `#12236`, `#12170`, `#12093`, `#12127`, `#9854`

## Branch & Commit Discipline

- **Rebase, don't merge upstream.** Repeated merge-from-dev commits (5, 6, 56 merge commits observed) are noise. In this squash-merge repo, branch history is disposable, but excessive merge commits still make PRs harder to review.
  - Evidence: `#19953` (5 merge commits), `#17170` (56 merge commits), `#19351` (6 merge commits), `#13748`
- Single clean commits with conventional messages are ideal. The commit body can include problem/solution narrative.
  - Evidence: `#21134`, `#21178`, `#12127`, `#20272`
- Squash-merge means branch commit history is disposable — but the PR title becomes the commit message. Get the title right.
  - Evidence: `#20399` (8 messy branch commits, clean squash title)

## AI Contribution Patterns

- **AI co-author trailers survive squash and don't trigger policy violations.** Transparent disclosure is safe.
  - Evidence: `#20272` (Claude Opus trailer survived squash), `#12127` (Claude Opus 4.5 trailer included without issue)
- **AI-generated walls of text are explicitly unwelcome.** CONTRIBUTING.md warns they "may be ignored or closed."
- **Self-closing gracefully preserves reputation** and is the professional response to duplicates, technical infeasibility, or supersession.
  - Evidence: `#21082`, `#21178`, `#17170`, `#19351`

## Common Rejection Reasons

- Missing PR-template sections (especially verification)
  - Evidence: `#20714`, `#20866`, `#21091`, `#21168`, `#20925`
- Missing or non-recognized linked issue
  - Evidence: `#21042`, `#21091`, `#12093`, `#10340`
- Duplicate/superseded work
  - Evidence: `#20714`, `#15852`, `#21178`
- Overscoped or mixed-concern changes
  - Evidence: `#21091`, `#10340` (11 files, 4+ concerns)
- Large AI-styled summaries without matching process compliance
  - Evidence: `#20866`
- Unresponded bot/review feedback leading to stale closure
  - Evidence: `#12236`, `#12170`, `#12093`, `#12127`, `#9854`
- Template placeholders left verbatim (`Fixes #<ISSUE_ID>`)
  - Evidence: `#10340`
- Committed debug artifacts or `any[]` type widening
  - Evidence: `#10340`

## Success Patterns

- Small, surgical fixes on top of an existing issue
  - Evidence: `#21040`, `#21054`, `#21134`, `#20272`
- Regression tests or focused CI fixes with exact verification commands
  - Evidence: `#21053`, `#20959`, `#19953`
- Clear root-cause description tied to the touched files, with causal explanation tracing the execution path
  - Evidence: `#21040`, `#20399`, `#20272`
- Quantified bug impact with real measurements (FD counts, timing, memory)
  - Evidence: `#19953` (194k→16k FDs), `#9854` (4.93s→1.20s)
- Purely additive patches (0 deletions) that face zero regression objections
  - Evidence: `#21134`, `#20272`
- Verification with real consumers, not just unit tests — naming the actual client/tool that validated
  - Evidence: `#21134` (codecompanion), `#20272` (HTTP inspection)
- Pinged maintainer by name with one-sentence business case
  - Evidence: `#21134` (3.5h merge for external contributor)
- Docs PRs anchored to upstream code changes with before/after state
  - Evidence: `#20589`
- Single commit + single file + full template + named ping = fastest merge path for external contributors
  - Evidence: `#21134` (3.5h), `#20589` (4 days silent merge)
