# n8n-io/n8n Contribution Patterns

Distilled from 15 closed PRs (9 merged, 6 rejected/self-closed). Last updated: 2026-04-07.

## Hard Gates (fail any one → PR dies)

1. **Sign the CLA immediately.** CLAassistant bot appears within seconds. Unsigned CLA = no human will ever review. PRs #27171 and #26988 both died with unsigned CLAs despite good/bad code respectively.
2. **Angular PR title convention.** Format: `type(scope): summary`. Types: `feat|fix|perf|test|docs|refactor|build|ci|chore`. Scopes: `core|editor|* Node` (e.g., `Perplexity Node`). CI validates this. Append `(no-changelog)` for internal changes. (#26970 — maintainer had to fix the title manually.)
3. **Include tests.** "A bug is not considered fixed, unless a test is added to prevent it from happening again." Exception: hard-to-test startup/process code with clear precedent (#24517 — 0% coverage accepted because it mirrored `load-nodes-and-credentials.ts`).

## Merge Speed Factors (fastest to slowest)

| Factor | Evidence | Typical Time |
|--------|----------|-------------|
| Reviewer already investigating same issue | #26566 (OAuth wipe) | 5 days |
| Small fix + tests + referenced issue | #26550 (process.version) | 7-20 days |
| Node improvement + responsive author | #26970 (Perplexity) | 7 days |
| Small editor fix + framework expert review | #25883 (i18n) | 8 days |
| Agent/AI node feature + good tests | #25810 (tracing) | 22 days |
| Small fix + community pressure | #24517 (NODE_PATH) | 45 days |
| Security fix + production validation | #22859 (AWS role) | 81 days |
| Large scope + review expansion | #16612 (AWS cred) | 130 days (superseded) |
| Large scope + persistence + maintainer help | #19758 (Baserow) | 172 days |
| Monster scope expansion through review | #17297 (MS Teams) | 192 days |

**Key insight:** Once a human reviewer engages, review-to-merge is typically 1-5 days. The bottleneck is always triage queue (14-75 days for first human review).

## Review Dynamics

### Bot Triage Layer (responds before humans)
1. **CLAassistant** — CLA check (seconds)
2. **cubic-dev-ai[bot]** — AI code review (minutes)
3. **n8n-assistant[bot]** — assigns internal Linear tracker ID (GHC-NNNN), posts boilerplate: "Our goal is to begin reviews within a month"
4. **codecov[bot]** — patch coverage report
5. **Aikido Security** — security scan

Bot acknowledgment is NOT human engagement. "Added to tracker" ≠ "someone will look soon."

### What Maintainers Actually Check
1. **Build passes** — `pnpm build` is the very first thing reviewers verify (#26970).
2. **Real tests, not mocks** — Heavy mocking explicitly rejected: "This defeats the purpose of the tests" (#25810). Use real functions wherever possible.
3. **Code deduplication** — Reviewers provide factory patterns when they see repetition (#26970 — 3 identical error handlers → factory).
4. **API completeness** — For node updates, reviewers push for comprehensive API coverage, not minimal viable (#26970).
5. **Pattern consistency** — "Follows the same patterns as expected" is the most frictionless approval (#24517).
6. **Type safety** — Type narrowing bugs caught in review (#25810). No `ts-ignore`, no `any`.

### Key Reviewers (as of 2026-04)
- **garritfra** — most active human reviewer (15 reviews/90 days)
- **RomanDavydchuk** — thorough, constructive, multi-round reviewer
- **elsmr** — willing to push final polish commits on stalled PRs
- **shortstacked** — deep framework knowledge, pragmatic about CI overrides
- **Joffcom** — community manager/triager, design feedback

## Patterns That Accelerate Merge

### 1. Reference the Existing Pattern
When your fix mirrors codebase precedent, explicitly call it out. "This follows the same approach as X" → reviewer verifies by comparison, not from scratch.
- Evidence: #24517 — "Same `_initPaths()` call that exists in `load-nodes-and-credentials.ts`" → "Follows the same patterns as expected. Thanks!"

### 2. Community Pressure (Polite and Substantive)
Steady stream of users reporting impact accelerates triage. Direct @-mention of assigned reviewer can break silence.
- Evidence: #24517 (6 users, @-mention → same-day approval), #19758 (6 pings + community thread links), #17297 (3 users in Dec-Jan)
- Pattern: Each ping adds new context (production breakage, workaround links, user count). Never repeat the same "please review" message.

### 3. Production Validation from Others
When community users confirm your fix works in their production, cite it explicitly. Reduces reviewer risk perception.
- Evidence: #22859 — two production confirmations spanning 2+ months and multiple n8n versions.

### 4. Collaborative Review Expansion
When a reviewer suggests an adjacent improvement, accept and implement quickly. Builds goodwill and turns a good PR into a better one.
- Evidence: #26566 — reviewer suggested empty string fix, author implemented within 75 minutes → merged same day.

### 5. Security Framing for Credential Bugs
When a bug has security implications, name them explicitly: "potential privilege escalation," "credential exposure." Accurate framing elevates priority.
- Evidence: #22859 — security framing likely helped prioritization despite 75-day triage wait.

### 6. Companion Docs PR
Prepare the n8n-docs PR alongside your code PR. Shows completeness and satisfies the "Docs updated" checklist item.
- Evidence: #19758 (n8n-docs/pull/3732), #25810 (n8n-docs/pull/4220), #17297 (n8n-docs/pull/4126).

## Anti-Patterns That Kill PRs

### 1. Unsigned CLA
Hard gate. No exceptions. Sign before opening the PR, not during review.
- Evidence: #27171 (technically perfect fix, 0 humans looked), #26988 (never signed).

### 2. No Tests + No Issue Link + Bad Title
The trifecta of silent death. No human will ever engage.
- Evidence: #26988 (title "bug fix", empty template, no CLA → 22 days of bot-only responses).

### 3. Theoretical Bugs Without Evidence
"I found this while exploring" with no linked issue = deprioritized indefinitely.
- Evidence: #21790 (140 days, zero human engagement, self-closed).

### 4. Refusing to Compromise in Architectural Debates
"I'm going to insist" shuts down collaboration and signals the PR will be contentious to merge.
- Evidence: #16612 (superseded after author refused to compromise on STS field design).

### 5. Excessive Merge Commits
Merging master daily creates CI noise and forces reviewer to re-approve workflow runs from forks.
- Evidence: #17297 (100+ merge commits → reviewer: "stop merging master into your branch").
- Fix: Rebase once before requesting review. Don't merge master between reviews.

### 6. Not Running CI Locally
Multiple "fix lint, fix typecheck" commits signal lack of preparation.
- Fix: Run `pnpm build && pnpm lint && pnpm typecheck && pnpm test` before pushing.

### 7. Force-Pushing to Fix CLA Issues
Rewriting commit history to fix author attribution is fragile and can destroy the PR.
- Evidence: #19231 (force-push included entire upstream repo → 12,905 files, 2.1M additions).
- Fix: Create a fresh fork branch and open a new PR.

### 8. Unsolicited Changes to Internal Tooling Files
CLAUDE.md, AGENTS.md, and similar AI-assistant configuration files are maintained by n8n staff. External contributions are unwelcome without coordination.
- Evidence: #21934 (silent close, zero engagement).

## n8n-Specific Technical Patterns

### Node Development
- **No new nodes in core** unless enterprise-backed or explicitly requested by n8n team. The "no new nodes" policy is a soft gate for quality enterprise submissions but a hard gate for community nodes.
- **Version nodes** as `[1, 1.1]` not `2` for backward compatibility.
- **Use `httpRequest`** (not deprecated `helpers.request`).
- **Throw `NodeOperationError`** (not return error strings).
- **Don't use `ApplicationError`** (deprecated) — use `UnexpectedError`, `OperationalError`, or `UserError`.
- **Add `ICredentialTestRequest`** for credential testing.
- **Test with `NodeTestHarness` + nock mocks** for API nodes.
- **`packages/core` is off-limits** without n8n pre-approval.

### Editor/Frontend
- **i18n pluralization requires `adjustToNumber`** in `baseText()` calls. Without it, pipe-separated plural strings render literally (e.g., "5 secret | 5 secrets" shows as text).
- **All UI text must use i18n** from `@n8n/i18n` package.
- **No hardcoded px values** — use CSS variables for spacing.
- **Enterprise features** may need reviewer testing if you don't have a license.

### Credentials
- **Split credentials** when multiple auth types share a node (UX pattern: separate credential files per auth type).
- **Add `authenticate` property** to eliminate manual token logic.
- **Security-critical credential changes** may be taken over by n8n-affiliated contributors for trust reasons.
- **Consider SaaS vs self-hosted deployment models** — n8n Cloud hides OAuth fields.

## Merge Process

- n8n squash-merges community PRs — messy commit history in the PR branch is acceptable.
- CI checks: build, unit tests (Jest backend, Vitest frontend), integration tests, typecheck, lint, format, PR title validation, CLA, E2E (conditional).
- Typical release cycle: merged PRs ship in next minor release (usually within 1-2 weeks).
- `Released` label + n8n-assistant bot notification confirms shipping version.
