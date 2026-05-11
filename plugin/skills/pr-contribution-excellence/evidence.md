## Evidence Base

- **Distillation #1** (2026-03-26): 10 PRs from openai/codex (#15860, #15892, #15813, #15796, #15835, #15897, #15903, #15067, #15811, #15900)
- **Distillation #2** (2026-03-26): +5 PRs (#15791, #15891, #15885, #15881, #15661). Total: 15 PRs.
- **Distillation #3** (2026-03-27): +15 PRs (#15880, #15877, #15869, #15866, #15864, #15910, #15898, #15805, #15839, #15829, #15759, #15513, #15789, #15798, #15785). Total: 30 PRs.
- **Distillation #4** (2026-03-27): +20 PRs (#15906, #15812, #15825, #15800, #15817, #15758, #15861, #15851, #15749, #15810, #15909, #15784, #15806, #15802, #15820, #15691, #15693, #15659, #15707, #15748). Total: 50 PRs. 48 merged, 2 self-closed duplicates. Includes 3 external contributor PRs (fcoury), multiple Codex-co-authored PRs, full coverage of core/established/team/external tiers.
- **Distillation #5** (2026-03-28): +10 PRs from langchain-ai/langchain (#36320, #36319, #36199, #36298, #36287, #36125, #36289, #36285, #36276, #36271). 3 merged, 7 auto-closed by bots. Added rules 17-19 and anti-patterns 11-12 from process-gate analysis. Total: 60 PRs across 2 repositories.
- **Distillation #6** (2026-03-29): +15 PRs from rust-lang/rust (#153632, #153834, #154110, #154190, #154468, #154200, #154453, #154043, #153821, #154320, #153380, #154472, #154459, #154185, #154504). 14 merged, 1 merged-then-reverted. Added patterns 12-15 (trust tiers, scope cutting, inline bug showing, graceful setback handling). Repo-specific patterns in `~/.claude/rust-lang-rust-pr-lessons/patterns.md`. Total: 75 PRs across 3 repositories.
- **Distillation #7** (2026-03-29): +20 PRs from rust-lang/rust (#154520, #154512, #154502, #154499, #154475, #154515, #154500, #154488, #154485, #154464, #154450, #154431, #154414, #154418, #154410, #154375, #154400, #154394, #154381, #154361). 15 merged, 2 closed-by-author, 2 closed-by-maintainer, 1 self-closed duplicate. Added patterns 24-28 (subtool routing, project-specific formatting, revert protocol, anti-bulk-PR, maintainer suggestion follow-ups). Total: 95 PRs across 3 repositories.
- **Distillation #8** (2026-03-30): +15 PRs from grafana/grafana (#120696, #121355, #118428, #121041, #121382, #120994, #120723, #121334, #112944, #120859, #111735, #114047, #120880, #120560, #119572). 11 merged, 3 closed without merge, 1 deep review case. Added patterns 29-34 (stale bot survival, duplicate prevention, squash-merge awareness, visual evidence, bot+human review, feature toggle discipline) and anti-patterns 13-14. Repo-specific patterns in `~/.claude/grafana-grafana-pr-lessons/patterns.md`. Total: 110 PRs across 4 repositories.
- **Distillation #9** (2026-03-30): +10 PRs from grafana/grafana (#121110, #121374, #121028, #121435, #121370, #121452, #121448, #121266, #121382, #121355). 8 merged, 1 self-closed, 1 replaced. Reinforced patterns 31-34. No new general patterns — Grafana-specific learnings (advisory coverage checks, single-approval gate, Codex bot workflow, Storybook-as-testing, internal export convention) added to repo-specific patterns at `~/.claude/grafana-pr-lessons/patterns.md`. Total: 120 PRs across 4 repositories.
- **Distillation #10** (2026-03-31): +5 PRs from grafana/grafana (#121222, #118631, #121369, #120994, #121275). 5 merged. Added patterns 35-36 (self-annotate critical diff lines, batch-address review comments). Grafana-specific patterns updated with: self-annotation, bugfix description template, post-merge label audit, SDK-study-first, approach pivot risk. Total: 125 PRs across 4 repositories.
- **Distillation #11** (2026-03-31): +10 PRs from grafana/grafana (#121241, #121484, #121473, #121552, #120282, #121550, #121238, #121475, #121521, #121487). 8 merged, 1 closed-by-author, 1 closed-by-maintainer. Added patterns 36-37 (paired cross-layer PRs, external evidence for drift correction). Grafana-specific patterns updated with: feature flag governance, paired PRs, observability PR scrutiny, pattern replication, config snippets, PR ordering dependencies. Total: 135 PRs across 4 repositories.
- **Distillation #12** (2026-04-01): +10 PRs from grafana/grafana (#121499, #119378, #121442, #121498, #121257, #121034, #121490, #121572, #121501, #120136). 9 merged, 1 CI experiment (closed intentionally). Added patterns 39-42 (stacked PR numbering, design tradeoff documentation, migration evidence, over-testing). Grafana-specific patterns updated with: known limitation flagging, fresh-install vs upgrade testing, implicit testing justification, dependency blockers, parameterized tests, manual UI testing, commit convention, docs-in-same-PR, coverage-improving refactors, performance PR causal chains, CI experiment PRs. Total: 145 PRs across 4 repositories.
- **Distillation #13** (2026-04-01): +5 PRs from grafana/grafana (#118432, #121474, #121513, #121444, #121533). 3 merged, 1 closed-by-author (superseded after UX pushback), 1 long-lived merged after stale. Added patterns 43-44 (close superseded PRs with thread context, get UX alignment before coding). Grafana-specific patterns updated with: UX alignment, thread etiquette, cross-repo descriptions, dependency bundling, stale bot paradox, Copilot advisory. Total: 160 PRs across 4 repositories.
- **Distillation #14** (2026-04-01): +10 PRs from rust-lang/rust (#154074, #154301, #148590, #141987, #153603, #154576, #154040, #152432, #153980, #154399). 5 merged, 3 closed-by-author, 2 closed-by-maintainer. Added patterns 45-47 (fix regression side-effects in-PR, verify "unnecessary" code before removing, get policy buy-in before behavioral stdlib changes). Repo-specific patterns at `~/.claude/rust-lang/rust-pr-lessons/patterns.md` (34 patterns covering bots, compiler internals, stdlib, soundness, review dynamics, CI). Total: 170 PRs across 4 repositories.
- **Distillation #15** (2026-04-01): +10 PRs from rust-lang/rust (#154356, #153018, #152935, #153207, #152584, #154459, #152253, #154655, #152492, #154592). 9 merged, 1 closed-by-author. Added general patterns 46-47 (stabilization PRs as entry points, CC domain experts). Repo-specific patterns expanded to 58 (added stability/stabilization, new API conventions, extended test/review/compiler patterns). Total: 180 PRs across 4 repositories.
- **Distillation #16** (2026-04-01): +10 PRs from langgenius/dify (#22658, #34350, #34352, #34158, #34311, #32648, #33105, #34227, #33044, #34241). 5 merged, 2 closed-by-author, 1 closed-by-maintainer, 1 superseded, 1 stale. Added general patterns 48-49 (stale CI = abandoned PR, bot-delegated review culture). Repo-specific patterns (15) at `~/.claude/langgenius-dify-pr-lessons/patterns.md`. Total: 190 PRs across 5 repositories.
- **Distillation #17** (2026-04-01): +10 PRs from langgenius/dify (#34334, #34316, #34325, #34097, #34300, #33657, #29070, #33884, #29983, #34027). 6 merged, 1 closed-by-author, 1 closed-by-maintainer, 2 superseded. Added general anti-patterns 17-19 (enterprise/license areas, design correctness > CI, structured change tables). Dify-specific patterns expanded to 25. Total: 200 PRs across 5 repositories.
- **Distillation #18** (2026-04-05): +15 PRs from langgenius/dify (#34547, #34548, #34532, #34510, #34412, #34563, #34562, #34561, #34505, #33579, #34503, #34528, #33473, #33633, #34527). 12 merged, 2 closed-by-author, 1 closed-by-maintainer. Added general patterns 20-21 (non-closing issue links for series work, split mechanical series by review unit). Dify-specific patterns expanded with refactor-series issue-linking, TypedDict fast-lane, and frontend migration-path expectations. Total: 215 PRs across 5 repositories.
- **Distillation #19** (2026-04-05): +10 PRs from anomalyco/opencode (#20714, #15852, #21042, #20866, #20788, #21104, #21089, #21091, #21094, #20456). 1 merged, 3 auto-closed by bots, 6 closed by authors or superseded. Added general pattern 55 (literal template compliance in bot-gated repos) and anti-pattern 22 (hiding a feature branch under a bug-fix title). Repo-specific patterns at `~/.claude/anomalyco/opencode-pr-lessons/patterns.md`. Total: 225 PRs across 6 repositories.
- **Distillation #20** (2026-04-06): +15 PRs from anomalyco/opencode (#11961, #11945, #11931, #11882, #11850, #11998, #11993, #11976, #11970, #11968, #11626, #10332, #10282, #10271, #10190). 15 closed without merge, mostly stale-closed after green CI but low maintainer priority. Added general patterns 56-57 (eligibility vs priority in stale-bot repos, clean branch history as a reviewability signal). Repo-specific patterns for `opencode` updated with stale-queue, UI-priority, and branch-discipline learnings. Total: 240 PRs across 6 repositories.
- **Distillation #21** (2026-04-06): +10 PRs from n8n-io/n8n (#26550, #16067, #26988, #27814, #21934, #26970, #19758, #26566, #24517, #22510). 6 merged, 4 closed without merge. Added general patterns 58-60 (maintainer takeover as positive outcome, scope as queue-time multiplier, cite analogous code for instant credibility). Repo-specific patterns at `~/.claude/n8n-io-n8n-pr-lessons/patterns.md`. Total: 265 PRs across 7 repositories.
- **Distillation #22** (2026-04-07): +8 new PRs from n8n-io/n8n (#27171, #25810, #22859, #21790, #17297, #19231, #16612, #25883). 5 merged, 3 closed. Added general patterns 61-64 (real tests over mocks, production validation, scope expansion as time multiplier, CLA-first as hard gate). Repo-specific patterns comprehensively updated with merge speed factors, 15-PR evidence base. Total: 273 PRs across 7 repositories.
- **Distillation #23** (2026-04-07): +5 PRs from n8n-io/n8n (#27796, #27947, #27188, #27853, #28110). 3 merged, 2 closed without merge. Added general patterns 22-23 (simpler fix wins in competing PRs, quantitative metrics in performance PRs). Repo-specific patterns expanded with: competing PR dynamics, maintainer community stewardship, defense-in-depth, protocol-level review, AI co-authorship acceptance, founder fast-track. Total: 278 PRs across 7 repositories.
- **Distillation #24** (2026-04-07): +5 PRs from anomalyco/opencode (#20545, #20701, #20704, #17105, #13765). 2 merged, 1 merged after discussion, 2 auto-closed by compliance bot. Added general patterns 65-66 (AI submission supervision during compliance windows, study existing integration patterns before adding new ones). Repo-specific patterns updated with: compliance bot timing (12s flag, 2h window), provider addition patterns (models.dev/CUSTOM_LOADERS), scope reduction responsiveness, AI submission monitoring. Total: 298 PRs across 7 repositories. 1 PR skipped (#20670, accidental/instant close).
- **Distillation #25** (2026-04-08): +10 PRs from ggml-org/llama.cpp (#21558, #21562, #21485, #21257, #21451, #21219, #20238, #21527, #20993, #21273). 6 merged, 4 closed without merge. Added general patterns 67-68 (hardware-normalized metrics for performance PRs, hardware-owner reviewer as CI substitute). Repo-specific patterns at `~/.claude/ggml-org-llama.cpp-pr-lessons/patterns.md` covering: module-specific conventions (webui/SYCL/ggml-cpu/quantization/server/arch), AI disclosure strategy, key maintainers, collaborative culture (direct fixup commits). Total: 308 PRs across 8 repositories. 2 PRs skipped (#21561 duplicate, #21520 accidental).
- **Distillation #25** (2026-04-08): +15 PRs from grafana/grafana (#121271, #119180, #120746, #120909, #121445, #122031, #121789, #121995, #121814, #122043, #122067, #122052, #122041, #122016, #122033). 12 merged, 3 closed without merge. Added general patterns 72-74 (no-op tags for refactors, debuggability over DRY, approval ≠ merge follow-up). Grafana-specific patterns expanded with: approval follow-up, self-review comments, vague title smell, feature toggle retirement, multi-layer deprecation, Codex self-review, debuggability priority, no-op tags, AI Co-Authored-By acceptance, golden file evidence, net-negative line trust, test-as-deliverable, commit SHA references, manual reproduction steps. Total: 313 PRs across 7 repositories.
- **Distillation #26** (2026-04-08): +20 PRs from anomalyco/opencode (#19953, #13748, #20925, #21082, #20589, #20399, #21138, #20272, #10340, #21134, #20180, #21178, #21168, #12236, #12170, #12093, #12127, #9854, #17170, #19351). 8 merged, 3 self-closed by author, 5 stale-closed by bot, 2 auto-closed for template violations, 2 bot-closed after inactivity. Added general patterns 70-71 (target maintainer-neglected areas for fast-track merges, use project's preferred communication channel). Updated pattern 30 (search target branch, not just PRs). Repo-specific patterns at `~/.claude/anomalyco-opencode-pr-lessons/patterns.md` comprehensively updated with: communication channels (Discord), attention accelerators, bot dynamics (Copilot substantive, /review lgtm ≠ approval), branch hygiene (rebase not merge), AI disclosure patterns, graceful self-closing. Total: 333 PRs across 8 repositories. 5 PRs skipped (#21136 accidental, #21118 26s close, #21109 10s close, #12188 draft, #12145 draft).
- **Distillation #27** (2026-04-08): +10 PRs from kubernetes/kubernetes (#137032, #138035, #138178, #132181, #137986, #134660, and 4 additional). Added general patterns 75-79 (LGTM-with-hold coordination, self-imposed hold with verification, causal chain for regression fixes, classified CI retest comments, performance awareness and cache safety). Merged k8s findings into existing patterns: 34 (feature gate hygiene — gates control wiring not execution), 44 (SIG discussion before feature PRs), 51 (KEP-first for architecture-level changes), 15 (graceful self-close with signal). Repo-specific patterns at `~/.claude/kubernetes-kubernetes-pr-lessons/patterns.md`. Total: 343 PRs across 9 repositories.
- **Distillation #28** (2026-04-09): +5 PRs from browser-use/browser-use (#4464, #4587, #4577, #4212, #4489). 5 merged. No new general patterns — browser-use findings reinforced existing patterns (production evidence, focused scope, CLA-first, AI disclosure acceptance). Repo-specific patterns at `~/.claude/skills/pr-contribution-excellence/repo/browser-use-browser-use.md` covering: tabs-not-spaces, no-mock testing, CLA Assistant, bot review culture (cubic-dev-ai/cursor), merge speed factors (production evidence = minutes, benchmarks = hours, clean-but-non-urgent = weeks). Total: 348 PRs across 10 repositories.
- **Distillation #29** (2026-04-09): +5 PRs from BerriAI/litellm (#24268, #24438, #25263, #25337, #25370). 5 merged. No new general patterns — litellm findings strongly reinforce existing patterns 48 (bot-delegated review culture) and 58 (scope as queue-time multiplier). Repo-specific patterns at `~/.claude/skills/pr-contribution-excellence/repo/BerriAI-litellm.md` covering: Greptile as primary quality gate (4/5+ confidence), staging branch targeting, pre-existing CI failure documentation, feature flag discipline, AI disclosure acceptance (CLAUDE.md + AGENTS.md present). Total: 353 PRs across 11 repositories.

## Distillation from pydantic/pydantic-ai (2026-04-09, 2 rounds)

### Distillation #1 (5 PRs)
- **Illustrative starting point culture** — new repo-specific pattern: maintainers rewrite large feature PRs (evidence: PR #4865)
- **Umbrella migration issues** — reinforces general pattern of picking pre-scoped tasks (evidence: PR #4945 via issue #4818)
- **Advisory bot reviews** — new repo-specific nuance: push back with evidence when wrong (evidence: PR #4911)
- **PR Guard bot enforcement** — new repo-specific: auto-closes duplicate PRs and PRs targeting closed issues
- **Reviewer-specific style** — new repo-specific: DouweM does 20+ comments on features, takes over iteration (evidence: PR #4865)

### Distillation #2 (15 PRs)
- Added general pattern 80 (issue invitation is not an open call — evidence: #5021 closed in 88 min)
- Added general pattern 81 (match fix complexity to problem complexity — evidence: #5003 over-engineered, simpler fix existed)
- Added general anti-pattern 23 (submitting code to the wrong package in a monorepo — evidence: #4802 put code in meta-package)
- Expanded repo-specific patterns: bot ecosystem taxonomy (4 bots with different authority levels), reviewer profiles (Kludex, alexmojaki), fast-close taxonomy (2 mechanisms), test convention rules, cross-cutting type change patterns, response culture (16% verbal ratio)
- Reinforced: pre-work search (now with semantic dimension), bot authority levels, 100% branch coverage

### Evidence base (20 PRs total)
- PR #5020 (Ricardo-M-L): Bug fix, merged same day. Exceptional description with per-bug examples.
- PR #4945 (1Ninad): Migration, merged 5 days. Picked umbrella issue from maintainer.
- PR #4865 (Alex-Resch): Feature, merged 8 days. 47 files, DouweM rewrote with Claude.
- PR #4860 (Spectual): Bug fix, merged 6 days. Iterated on Devin bot feedback.
- PR #4911 (majdalsado): Bug fix, merged ~2 hours. Pushed back correctly on wrong bot feedback.
- PR #4053 (otto-sellerstam): Large feature, closed after 79 days. 58 review comments. Replaced with fresh PR.
- PR #5021 (Ricardo-M-L): Feature rejected in 88 min. Wrong contributor jumped invitation.
- PR #5003 (GopalGB): Fix rejected in 4 hours. Over-engineered solution.
- PR #5018 (DougTrajano): Docs merged in 18 hours. Silent approval.
- PR #4108 (15r10nk): Test infra merged after 72 days. Library maintainer, 1 clean commit.
- PR #4123 (DougTrajano): Feature merged after 62 days. 155 review comments (42% bots).
- PR #4687 (JasonCZMeng): Fix merged after 15 days. 54 review comments. Survived duplicate-close.
- PR #4111 (mpfaffenberger): Feature abandoned after round 1. Stale-closed 60 days.
- PR #4894 (NithiN-1808): Feature bot-closed in 11 seconds. Duplicate detection.
- PR #4897 (Yuki-Imajuku): Fix superseded in 12 hours. Perfect process, lost the race.
- PR #4432 (thisisarko): Feature merged after 33 days. 57 review comments. 31-file provider fan-out.
- PR #4661 (jaiwinshah3): Fix merged after 16 days. 63 review comments. OTel semantic debates.
- PR #4402 (syumpx): Example rejected after 44 days. Third-party maintenance burden.
- PR #4802 (jhawpetoss6-collab): Feature rejected. SyntaxError, wrong package, zero tests.
- PR #4970 (Ricardo-M-L): Trivial fix merged in 3 days. Zero friction, AI disclosure accepted.

## Distillation from berriai/litellm (2026-04-09)

### Patterns added
- #84: AI co-author trailers break CLA gates (evidence: PR #25300 — permanent CLA block from `Co-Authored-By: claude`)
- #85: Self-correction and refiling is valid (evidence: PR #25433→#25437, #25300→#25353)
- #86: Codecov patch coverage 0% is a red flag (evidence: PR #25433 — all tests passed but 0% on handler lines)
- #87: Resolve CHANGES_REQUESTED before merge (evidence: PR #25340 — merged over objection, immediately reverted)

### Patterns reinforced
- #64 (Sign CLA before opening PR): now supported by litellm #24496 (unlinked email) and #25300 (AI co-author)
- #48 (Stale CI = abandoned): now supported by litellm #15166 (lint failure killed PR after 108 days)
- #21 (Process compliance before code quality): now supported by litellm #19340 (blank CI section, zero engagement)
- #49 (Bot-delegated review culture): now supported by litellm #24268 (Greptile 3 rounds), #24972 (P1 merged over)
- #66 (Study existing integration patterns): now supported by litellm #23769 (over-scoped by not reading docs)
- #5 (Scope discipline): now supported by litellm #19340 (auth + transformation bundled)

### Evidence base
- PR #25007 (stuxf): Infra migration, merged 7d. 170 files, Greptile refused (>100 files), documented verification.
- PR #25340 (michelligabriele): Fix, merged-then-reverted 1d. Merged over CHANGES_REQUESTED, semantic value wrong.
- PR #19340 (krakenalt): Feature, stale-closed 80d. Zero maintainer engagement, blank CI section, scope creep.
- PR #24268 (acebot712): Guardrail integration, merged 19d. Greptile 3 rounds, 40 tests, AI disclosure accepted.
- PR #24496 (NIK-TIGER-BILL): Fix, abandoned 6d. CLA blocked (unlinked email), no maintainer engagement.
- PR #25433 (joereyna): Fix, self-closed 22min. 0% Codecov patch coverage, refiled as #25437.
- PR #23769 (kedarthakkar): Callback integration, merged 24d. Over-scoped initially, docs requested late, JSON pattern only needed 1 file.
- PR #15166 (danielaskdd): Fix, stale-closed 108d. Lint failure unresolved, superseded by #20750.
- PR #24972 (silencedoctor): Embedding feature, merged 6d. P1 bug merged over, excellent description.
- PR #25300 (matt-greathouse): Provider integration, self-closed 23h. AI co-author CLA block + 6 cyclic imports, refiled as #25353.

## Distillation from browser-use/browser-use (2026-04-10, distillation #4)

### Patterns added
- Pattern 100 (Two-Ping Rule): evidence from PR #4292 (18-day self-close after 2 ignored pings; perfect PR quality but maintainer dead-zone)
- Pattern 101 (Bot Approval ≠ Design Approval): evidence from PR #4442 (cubic clean → laithrw rejection → #4524 using SchemaOptimizer)

### Patterns reinforced
- Competitive Dynamics / Maintainer supersession: 2 new cases (#4442+#4421 → #4524; #4448 → #4512); now 5 observed cases in 35 PRs (~14% of closed external fixes)
- Trust Tiers: 4-minute self-merges by Alezander9 (#4513) and laithrw (#4512) quantify the maintainer-vs-external gap
- Volume-Over-Quality / Platform dead-zone: #4292 reinforces #4030 and passionworkeer's Windows PRs

### Evidence base
- PR #4442: Bedrock schema fix (Thatgfsj, external), 4 days closed. Clean cubic review, but maintainer preferred SchemaOptimizer — rejected on architecture, not code quality.
- PR #4421: Bedrock + SignalHandler (Jah-yee, external), 6 days closed. Scope creep (bundled unrelated signal handler change), cubic flagged both parts with P1/P2 issues; author never responded.
- PR #4292: Windows tunnel.py process checks (giulio-leone, external), 18 days, **self-closed**. Excellent description, issue link, proactive bot-fix commits, 2 polite pings — zero human response. Reinforces that maintainer attention is the binding constraint, not PR quality.
- PR #4513: Benchmark plot update (Alezander9, org member), empty body, merged in 4 minutes. Trust-tier bypasses repo's own "clear justification" rule.
- PR #4512: Linux chromium profile fix (laithrw, maintainer), +6/-2, merged in 4 minutes. Superseded external #4448 (+121/-1) within the same minute — smaller diff wins.

## Distillation from denoland/deno (2026-04-10)

### Patterns added/updated (repo-specific → repo/denoland-deno.md)
- Conventional Commit CI gate + valid prefixes + common scopes (evidence: batches 1-4, every PR)
- Squash merge: PR title is the final commit (evidence: #33020 commit vs title divergence)
- Mandatory AI disclosure — universal even for maintainers (evidence: all 5 batch-4 PRs + #33110, #33226 etc.)
- Clippy `#[allow]` walked back in-PR toward idiomatic fix (evidence: #33224)
- `RUSTFLAGS="-D warnings"` for deletion PRs (evidence: #33222)
- Multi-platform CI matrix is the real gate (evidence: #33154 approved then CI-killed, #33225 cfg(unix) follow-up)
- Superseded-by is the dominant close reason (evidence: #33154→#33230, #33078→#33221, #32888→#33163, #33107→#33080)
- "Too much churn" as a literal close reason on reorg-only PRs (evidence: #32796)
- miracatbot catches self-review gaps on parser/security code (evidence: #33223)
- AI thoroughness = over-scoping anti-pattern; 3-in-1 PRs lose to minimal successor (evidence: #33078 vs #33221, same author)
- Negative-sum changesets merge fastest (evidence: #33222, #33221, #33179, #33196)
- Cross-PR lineage ("Supersedes", "complement to", "Closes") in description (evidence: #33221)
- Upstream reference-implementation grounding (libuv, Node.js) in descriptions (evidence: #33225, #33221)
- Node compat polyfill pattern: polyfills/ → lib.rs register → lazy load → deferred init (evidence: #33226)
- Security fix template: bypass example → enumerated changes → checked test plan (evidence: #33223)
- Grep every early-return when adding normalization (evidence: #33223 SocketAddr fast-path gap)

### Universal patterns reinforced (SKILL.md — no new additions this round)
- "Simpler Fix Wins When Competing PRs Exist" — reinforced by same-author supersede #33078 → #33221
- "Maintainer Takeover Is a Positive Outcome" — variant where author takes over from themselves
- "Match Fix Complexity to Problem Complexity" — reinforced by minimal #33221 beating thorough #33078
- "AI-Generated PR Detection Signals" — reinforced by maintainer rejecting #33094 as "AI slop"

### Evidence base (batch 4: 2026-04-10)
- PR #33225: Platform-gated test constants → CI failure → follow-up cfg(unix) gate commit
- PR #33224: Clippy `#[allow]` walked back to idiomatic struct init within same PR
- PR #33222: Deletion PR with `RUSTFLAGS="-D warnings"` in test plan; bare `refactor:` title accepted
- PR #33221: Successor to #33078; minimal surface fix wins; cross-PR lineage in description
- PR #33020: Test infra fix using uncatchable SIGKILL; commit message `fix(tests):` vs title `test:` resolved by squash

## Distillation from microsoft/vscode (2026-04-10)

### Patterns added/updated
- Repo-specific patterns file created: `repo/microsoft-vscode.md` (based on 15 PRs across 3 batches)
- Reinforced "don't benchmark against vouched-contributor fast path" rule: 14/15 vscode PRs analyzed were insider merges with empty-body human approvals in <2h
- Reinforced "always verify bug on main before coding" rule: #303333 fixed an already-closed issue (9 months stale) and rotted 22 days before auto-closing
- Reinforced "bots are gates, not noise": `copilot-pull-request-reviewer[bot]` caught real bugs on every PR in the batches (type errors, grammar bugs, race conditions, tautological tests)

### Evidence base (batches 1-3)
- **Batch 1**: #308626 (abandoned refactor), #303333 (already-fixed bug, ghost author), #309098 (insider trivial merge), #308339 (insider multi-issue batch with `on-testplan`), #309087 (insider-only `build/hygiene.ts` change)
- **Batch 2**: #307849 (external-style polite pushback with doc citations), #308925 (external gold-standard same-day merge), #308973 (Copilot agent PR with self-review), #308836 (superseded by centralizing #308840), #308857 (AI PR closed despite 2 approvals — stale-HEAD verification + tautological test + CI regression after rebase)
- **Batch 3**: #309054, #309066, #309050, #309058, #309055 — all insider merges illustrating the fast-path (empty approvals, ignored bot feedback, unfilled templates merging anyway)

### VS Code-specific insights worth propagating if seen elsewhere
- Two-gate review systems (CLA + "Community PR Approvals") create a visible velocity gap between insiders and externals
- CODENOTIFY (path-based, bot-driven) is an alternative to CODEOWNERS worth recognizing when you see `vs-code-engineering[bot]` or similar
- "Engineering system lockdown" workflows that hard-block external PRs from `.github/`, `build/`, `package-lock.json` are common in large MS repos
- `on-testplan` label as a manual-QA substitute for inline tests is a VS-Code-specific artifact, not general
