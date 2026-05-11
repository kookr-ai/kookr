# microsoft/vscode Contribution Patterns

Last updated: 2026-04-10 | Distillation #1 | Based on 15 PRs analyzed (Batches 1-3)

External contributors face a **hard gating layer** that internal Microsoft team members bypass routinely. What you observe in the "recently merged" stream is mostly insider merges with very different expectations than what will be applied to your PR. Calibrate accordingly.

---

## Repository Conventions

### Title prefixes (observed, non-exhaustive)
- `fix:` — bug fix
- `feat(area):` / `feat:` — new feature, sometimes scoped
- `chore:` — mechanical changes
- `hygiene:` — lint/style/formatting/consistency checks (e.g. #309087)
- `Revert "..."` — standard git revert format (e.g. #309055)
- Bare area-first phrasing is also common: `chat: route ...`, `sessions: show ...`, `inlineChat: ...`, `fix: exclude source annotations ...`
- No strict Conventional Commits enforcement — bare descriptive titles merge fine

### Issue-closing syntax
- `Fixes #NNNN` and `fix #NNNN` both accepted — the team uses both forms
- Multi-issue PRs link each one on its own line: `fixes https://github.com/microsoft/vscode/issues/NNN` repeated 3-6 times (e.g. #308339, #309050)
- Internal issues live at `microsoft/vscode-internalbacklog` which is **private** — external contributors cannot view them. Do not reference internal issues; only reference public `microsoft/vscode` issues.

### Description structure (gold standard for external PRs)
Observed in the fastest-merged external PR (#308925, same-day silent merge by `yogeshwaran-c`):
```markdown
## Summary
<1-2 sentences of what and why>

## Root cause
<the actual cause — CSS flex interaction, regex bug, race condition, etc.>

## Test plan
- [x] step 1 with exact command
- [x] step 2

Fixes #NNNNNN
```
The root cause section is the key differentiator from novice contributions. Description size should be **inversely proportional** to code change size — a 2-line CSS fix with a full root-cause explanation merged same-day.

### Copyright header
Every new source file must start with the Microsoft copyright header. The `hygiene` check enforces this.

### Testing expectations
- **Surgical fixes get a pass on automated tests.** CSS-only fixes, CLI argparse tweaks, config changes, fixture updates all merged with zero new tests across the batches analyzed.
- **Behavioral/logic changes need either tests or `on-testplan` label.** Accessibility and UI behavior changes use the `on-testplan` label (e.g. #308339) to defer validation to a manual QA round instead of inline tests.
- **Large feature PRs from insiders sometimes ship without tests** (e.g. #309050: +442/-27, 19 files, zero tests). **Do not emulate this as an external contributor** — reviewer bots flag it and the Community PR Approvals gate applies stricter standards.

### Engineering-system lockdown (hard block for externals)
External PRs **cannot** modify:
- `.github/workflows/**`
- `build/**`
- `package.json` / `package-lock.json` at root or in any workspace

Attempting to change these files triggers an automated workflow that **blocks the PR before humans look at it**. Insiders can modify `build/hygiene.ts` (e.g. #309087) but you cannot. If your fix requires a build-script change, open an issue and tag the area owner instead of submitting the patch.

---

## Reviewer Expectations

### Bot reviewers (expect every PR to get these)
- **`copilot-pull-request-reviewer[bot]`** — reviews every PR and leaves real inline suggestions. In the batches analyzed it caught: undisposed `Disposable`, ignored `CancellationToken`, duplicate JSDoc, stale doc comments, ID collisions, grammar bugs in shipped LLM prompts, generic-constraint mismatches, tautological tests, race conditions. **Address its feedback before requesting a human** — external PRs that ignore bot findings will be held up. Internal contributors frequently ignore it and merge anyway, but you cannot assume that privilege.
- **`github-actions[bot]` screenshot-diff bot** — posts a visual regression report on any PR that touches UI. Don't be surprised by an N-image diff comment; it's informational.
- **`vs-code-engineering[bot]` via CODENOTIFY** — routes notifications based on changed file paths. VS Code uses **CODENOTIFY, not CODEOWNERS** — maintainers are auto-pinged by file pattern. Don't @-mention reviewers manually; let CODENOTIFY work.

### Human reviewers (the rotating set seen merging PRs)
`lszomoru`, `joshspicer`, `jrieken`, `deepak1556`, `connor4312`, `roblourens`, `mjbvz`, `meganrogge`, `sandy081`, `aeschli`, `vijayupadya`. Approvals are almost always **empty-body** — reviewers don't write "LGTM" or justifications; they just click Approve. Don't mistake an empty-body approval for a drive-by merge; it often follows a deep read.

### Area ownership (path-based, inferred from CODENOTIFY + merge activity)
- `src/vs/workbench/contrib/terminal*/**` → `meganrogge`, `Tyriar`, `anthonykim1`
- `src/vs/code/electron-main/**`, `src/vs/platform/launch/**` → `bpasero`, `deepak1556`
- `src/vs/workbench/contrib/chat/**`, `src/vs/workbench/contrib/inlineChat/**` → `jrieken`, `roblourens`, `connor4312`
- `src/vs/workbench/contrib/debug/**` → `connor4312`
- `src/vs/code/node/cli.ts` → `bpasero`, `deepak1556`
- `src/vs/sessions/**` → `osortega`, `joshspicer`

---

## Process & Workflow

### CLA is mandatory
Microsoft's CLA bot (`license/cla`) runs on every PR. New contributors must sign before review happens. Reply `@microsoft-github-policy-service agree` in the PR when prompted.

### Two review gates for external PRs
1. **`license/cla`** — CLA signed
2. **`Community PR Approvals`** — **separate check that requires explicit team member approval for external PRs**. Internal PRs skip this gate entirely. This is why insider PRs merge in 22 minutes with empty-body approvals while external PRs wait for someone on the team to actively approve via this check.

### Always verify the bug still exists on `main` before writing a PR
The single most costly failure mode observed (#303333): a contributor wrote a +242/-227 shell-integration fix for an issue that had **already been closed 9 months earlier** by a different PR. No one reviewed it. The author's account went `ghost`, 3 terminal maintainers were cycled through assignment, the PR was milestoned/demilestoned/remilestoned, and it auto-closed after 22 days of silence.

**Before opening any PR**, confirm:
1. The issue is still reproducible on current `main`
2. No merged PR already references the same issue number (check both "mentioned by" and the issue's timeline)
3. No open PR touches the same files (even if different issue)

Triage-assignment churn (a single PR cycling through 3+ assignees without review) is a leading indicator of rot — close your own stale PR if you see this pattern rather than letting it ghost-close.

### Large refactors without tests get abandoned
Observed in #308626 (joshspicer, insider): +859/-782 refactor introducing an abstraction layer. The Copilot reviewer left 9 substantive inline comments; the author replied once with "resuming this in another change" and closed the PR to re-open elsewhere. **Ship refactors in tested slices**, not as one mega-PR. External contributors have even less slack than insiders on this.

### Batching multiple related issues is acceptable
#308339 fixed six issues in one PR (all in the same accessibility-in-Sessions-window area). That's fine **when they share the same area and theme**. Don't batch unrelated issues.

### Reverts need a reason (for externals)
Internal reverts merge with just `This reverts commit <sha>` as the body (e.g. #309055). Externals submitting a revert should state: what broke, where it was reported, and the customer/user impact. Context that insiders hold implicitly needs to be made explicit for external PRs.

---

## Common Rejection / Close-Unmerged Reasons

Observed across the 15 PRs:

1. **Already-fixed bug.** The single biggest waste. Verify on `main` first. (#303333)
2. **Superseded by a better PR that centralizes the fix.** When Copilot bot flags your fix as incomplete, don't patch it — open a new PR that unifies the call sites. (#308836 was superseded by #308840 that merged the same day before #308836 was closed.)
3. **Large refactor without tests.** Author gives up when bot review floods the diff with comments. (#308626)
4. **Tautological tests + CI regression after rebase.** Even with 2 approvals, a PR can be closed if its new test bypasses the path it claims to exercise, AND a rebase exposes a TS redeclaration error. (#308857). AI-authored PRs especially: **rebase before claiming local verification** — validating on your own HEAD is not the same as validating on a rebased state.
5. **Scope pivot mid-review.** When a maintainer says "instead of fixing the code, change the model instruction instead", the original PR approach is dead. Abandon the branch and open a new one. (#308857)

---

## Success Patterns (for external contributors)

These are the patterns in merged PRs that an external contributor can actually copy:

1. **Root-cause description + surgical diff + `Fixes #N` + manual test plan** — this is the dominant pattern for fast-merged external bug fixes. See #308925.
2. **Cite authoritative upstream sources** (Node/Electron/Chromium docs) when reviewers push back, and it's safe to push back politely with evidence. See #307849: `"Yep, let me get to that on Wednesday :)"` + later `"Chromium source link"` evidence → reviewer conceded.
3. **Focused scope + responsive author engaging bot feedback** — #309058 is the gold standard for a clean merge. Before/After table in the description, `Fixes #N`, 3 files touched, author actually fixed the reactive-transition bug that the Copilot bot flagged.
4. **Scope new keybindings to a context.** Never ship a global keybinding; always add `when: SomeContextKey` or the Copilot bot will flag it as a conflict with an existing global chord (seen in #308339 where `Cmd+Shift+U` conflicted with the global Output toggle before it was scoped).
5. **Use `on-testplan` label** for UI/accessibility changes that can't practically be unit-tested — this is VS Code's manual QA pathway and substitutes for inline tests on UI work.

---

## Anti-Patterns Specific to VS Code

- **Don't benchmark your PR against insider merges.** A 22-minute empty-body merge with unaddressed Copilot bot findings is the insider fast-path, not what your PR will experience.
- **Don't link `microsoft/vscode-internalbacklog` issues.** The tracker is private; the link is useless to reviewers reading your PR from outside the team.
- **Don't submit build-system or workflow changes as an external PR.** The CI hard-blocks them. Open an issue instead.
- **Don't ignore the Copilot reviewer bot.** Internal contributors do; you cannot. Every flagged issue is something a human reviewer would ask you to fix anyway — fix it before requesting human review so the Community PR Approvals gate flips faster.
- **Don't ship a PR with an unfilled PR template body.** The 3 internal PRs in the batch that did this merged anyway; any external PR with boilerplate-only body gets immediate pushback.
- **Don't add new tests that pass `parameters: {}`** (or any sentinel input) to a code path whose early-return logic means the test never reaches the behavior it claims to cover. The Copilot bot catches these and calls them out as tautological. Write a test that would fail without your fix.
