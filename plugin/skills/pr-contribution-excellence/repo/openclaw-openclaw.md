# openclaw/openclaw Contribution Patterns

Distilled from 20 closed PRs across three batches (2026-04-10). Merged and rejected PRs included. Full detail in `~/.claude/openclaw-openclaw-pr-lessons/patterns.md`.

## Hard Gates (fail any → auto-close by bot)

1. **≤10 active PRs per author.** `openclaw-barnacle[bot]` auto-closes the 11th within 5–13 minutes regardless of quality. Evidence: #64431 (5/5 Greptile confidence) and #64482 both killed by this rule. Count `gh pr list -R openclaw/openclaw --author @me --state open` before pushing.
2. **"Dirty branch" heuristic.** Same bot auto-closes PRs carrying "unrelated or unexpected changes." Stacked PRs from a fork trip this because external contributors can only target `main`. Evidence: #64266 (umbrella PR with 756 files from cross-sibling commits). Land leaf-by-leaf; get maintainer write access for true stacks.
3. **Conventional commit title required.** Contributors cannot label PRs, so `type(scope): summary` in the title is the sole PR-side signal for automation. Beta-blocker PRs require `fix(<plugin-id>): beta blocker - <summary>` and a linked `Beta blocker: ...` issue.

## Automated Review Layer (runs 1–2 min after push)

| Bot | Role | How to respond |
|-----|------|----------------|
| `greptile-apps[bot]` | Summary + `Confidence Score: N/5` + P1/P2 inline findings | Address P1s; confidence 5/5 = safe-to-merge signal |
| `chatgpt-codex-connector[bot]` | Codex Review with P1/P2 badges, strong on security + cross-cutting | Address or explicitly defer P1s in PR body |
| `openclaw-barnacle[bot]` | Hard-gate enforcer (PR cap, dirty branch) | No override |
| `copilot-pull-request-reviewer` | Appears on larger/umbrella PRs; catches doc drift + path-resolution bugs | High signal — fix or explain |
| `cursor` bugbot / `aisle-research-bot` | Appear on maintainer XL refactors; tolerated as debt on self-merges only | External contributors do not get the same tolerance |

**Unresolved P1 rule**: Merging with an unresolved bot P1 is legal for trusted contributors when the finding is out of scope, but **only if the PR body explicitly acknowledges the deferral** ("Known limitation: ..., tracked separately"). #64459 merged with an unresolved Codex P1 about queue-recovery session context, but the merge would have been cleaner with an explicit acknowledgment.

## Merge-Speed Signals

| Signal | Typical outcome |
|--------|-----------------|
| Trusted contributor + pure docs + references existing doc | 60–90 seconds (#64479: "Add IRP" body, merged in 69s) |
| XS fix + strong silent-failure framing | ~50 min; maintainer adds regression test on your branch (#64469) |
| Trusted contributor + M-L fix + full Summary/Changes/Validation | ~30 min even with unresolved bot P1 (#64459) |
| XL maintainer refactor | Same-day self-merge via rebase with gate commands in merge comment (#64298) |
| External small fix, stale 3+ days | Superseded by direct maintainer commit on main (#62723) |
| External XS PR, stale 21 days with unresolved nits | Self-closed under PR-cap pressure (#51089) |

Once a PR reaches 3+ days without maintainer engagement, assume supersession risk — run `git log origin/main --oneline --grep <affected-symbol>` to check for direct landings.

## Template Conventions

Full template sections: Summary (Problem / Why it matters / What changed / What did NOT change), Change Type (checklist), Scope (checklist), Testing/Validation with exact commands. Use the literal template headings — the `copilot-pull-request-reviewer` on larger PRs checks them.

**Verification commands maintainers expect to see:**
- `pnpm tsgo` (type check — a P1 duplicate-property bug would have been caught by this in #64482)
- `corepack pnpm test <file>` for targeted unit tests
- `pnpm exec vitest run --config vitest.config.ts --project unit <file> --maxWorkers=1`
- `pnpm run lint:tmp:no-raw-channel-fetch` for channel-fetch boundary work
- `pnpm install --frozen-lockfile && pnpm build && pnpm check && pnpm test <file>` as a full gate

**AI disclosure is normalized and welcomed.** Merged maintainer PRs use `[AI-assisted]` title suffixes (#64377, #64376). External PRs use `🤖 Generated with Claude Code` body trailers. The repo is not anti-AI. **But** disclose factually, not narratively — "quizzed Gemini" / "got it to scan historical commits" language (#57984) signals lack of understanding and loses maintainer confidence even after a correct force-push fix.

## Key Patterns That Accelerate Merge

1. **Count your active PR slot before opening a new one.** Binding constraint for high-output contributors.
2. **Run `pnpm tsgo` locally.** The type-check gate catches cheap P1s bots will flag within 2 minutes otherwise.
3. **Cover all related failure modes in one PR.** #63876 beat #63391 by covering both `idempotencyKey` AND non-atomic append. Minimal fixes lose to comprehensive ones when competing PRs exist.
4. **Explain silent-failure modes at the system level.** For XS fixes, frame *why it matters* ("skills can silently disappear from discovery") not *what changed*. Gives maintainers the context to push a regression test to your branch themselves (#64469).
5. **Declare scope boundaries with "What did NOT change".** Pre-answers scope questions.
6. **Test-to-impl ratio 2:1 or higher** for lifecycle/async bugs (#59606 3:1, #63929 2.6:1, #54840 85% tests).
7. **Threat-model wire inputs.** PRs that forward caller-supplied fields through gateway/delivery paths must reason about input trust in the PR body. Codex bot flags arbitrary-path trust as P1 security (#64482 `mediaLocalRoots` from gateway wire request).
8. **Grep the docs tree for every claim you're invalidating.** Feature PRs that add config knobs must update every doc that says the knob isn't configurable. Copilot will catch it (#64266 — three docs still said subagents AGENTS source was not configurable).

## Anti-Patterns (observed failures)

1. Unfilled template + placeholder diff + meaningless title → closed in 3 min (#64356 "my new feature").
2. Silently opening PRs while a race is in progress → superseded by comprehensive alternative (#63391, #56411, #62723).
3. Changing boolean operators without tracing all paths (#57984 `||` → `&&` regression).
4. Testing against patched `dist/` binaries instead of building from source (#63391).
5. Stacked PRs from a fork (no write access → can only target main → dirty-branch heuristic fires) (#64266).
6. Letting a PR go stale 3+ days on main-moving work (#62723).
7. Opening an 11th PR in the same repo (#64431, #64482 — both high quality, killed by cap).
8. Feature PR that contradicts existing docs without updating them (#64266).

## Pre-Push Checklist for openclaw/openclaw

- [ ] Active PR count < 10 (`gh pr list -R openclaw/openclaw --author @me --state open | wc -l`)
- [ ] `pnpm tsgo` passes
- [ ] Targeted vitest filter passes with `--maxWorkers=1`
- [ ] Conventional commit title with correct scope; beta-blocker format if applicable
- [ ] Template filled: Summary (Problem/Why/What/Scope boundary), Change Type, Scope, Testing
- [ ] `Closes #<issue>` / `Fixes #<issue>` on its own line (not embedded in prose)
- [ ] No recent direct maintainer landing: `git log origin/main --oneline --grep <symbol>`
- [ ] No open PRs touching the same files: `gh pr list -R openclaw/openclaw --state open --search "<path>"`
- [ ] Wire-input trust reasoning if the PR touches gateway/delivery/forwarded fields
- [ ] Doc-tree grep for every claim the PR invalidates
- [ ] AI disclosure is factual (`[AI-assisted]` suffix or `🤖 Generated with Claude Code` trailer), not narrative
- [ ] I will monitor the PR for 5–15 min after push to fix bot P1s immediately
