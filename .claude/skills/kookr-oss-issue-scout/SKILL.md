---
name: kookr-oss-issue-scout
description: Find the best contribution opportunity in an external repository — scores issues by clarity, size, acceptance likelihood, competition, match, and local reproducibility
keywords: issue, triage, scout, contribute, good first issue, help wanted, open source, oss, find issue, contribution opportunity, performance, optimization, reproducibility, verifiability
related: [[oss-repo-recon]], [[oss-fork-manager]], [[oss-pr-critic]]
---

# OSS Issue Scout

> **Requires:** per-repo recon at `~/.claude/{org}-{repo}-recon/recon-report.md` (created by `[[oss-repo-recon]]`) and, optionally, distilled patterns at `${KOOKR_PLUGIN_DIR:-$HOME/git/kookr/plugin}/skills/pr-contribution-excellence/repo/{slug}.md` (part of the optional OSS extension — see `docs/hooks-setup.md`). If recon is missing, stop and run `[[oss-repo-recon]]` first rather than scouting blind. If only the patterns are missing, proceed but do not invent substitutes.

Find the best issue to contribute to in an external repository. Not just "good first issue" — intelligent triage of what an external contributor can realistically fix and get merged.

## When to Use

- After recon is complete and PR patterns are distilled
- When looking for a contribution opportunity in a specific repo
- When re-scouting after a previous contribution

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Load recon report before scouting | Guessing repo conventions | `cat ~/.claude/{repoSlug}-recon/recon-report.md` |
| 2 | Load distilled patterns if available | Ignoring PR analysis insights | `cat ${KOOKR_PLUGIN_DIR:-$HOME/git/kookr/plugin}/skills/pr-contribution-excellence/repo/{repoSlug}.md` |
| 3 | Check for competing PRs on each issue | Duplicating work someone else started | Search for linked PRs before selecting |
| 4 | Score every candidate on all 5 dimensions | Picking based on gut feeling | Use the scoring matrix below |
| 5 | Present 3-5 candidates, not just 1 | Forcing a single choice | Give options with rationale |
| 6 | Check BOTH the Kookr-wide OSS attempt store AND the per-recon contributions.json before scoring | Re-investigating an already-attempted issue | Secondary-index lookup on `(repo, issueNumber)` in `~/.kookr/oss-attempts.json` + the per-recon file |
| 7 | Check if issue is already fixed on main | Submitting a no-op PR | Search merged PRs with related keywords before implementing |
| 8 | Check for recent refactors (last 14 days) on the target files before trusting the issue's "small fix" scoping | Claiming a perf bug whose fix path was invalidated by a refactor merged 2 days before the bug was filed | `git log --since="14 days ago" -- <file>` + read each PR that touched it |
| 9 | Pass the Reproducibility Gate before claiming | Claiming a Telegram webhook bug that needs live ingress infrastructure; claiming a "remove End node guard" fix when existing tests assert the opposite | See [Reproducibility Gate](#reproducibility-gate) — failing-test reproducer OR existing integration/E2E coverage OR faithful UI render OR authoritative external docs |
| 10 | Hard-exclude candidates whose labels say someone else owns the issue | Claiming n8n #28378 which carries `status:in-linear` + `status:team-assigned` (n8n team owns it via Linear GHC-7713) | See [Pre-Scout: Label-Based Hard Exclusion](#pre-scout-label-based-hard-exclusion). Any label matching team-assigned / in-progress / in-review / wip / needs-team → drop before scoring, do not comment. `in-linear` *alone* is a soft flag (n8n auto-triage applies it broadly — see calibration note). |

## Parameters

- **repoFullName**: `owner/repo`
- **repoSlug**: URL-safe slug for state directory
- **contributionFocus**: `performance` / `bugs` / `any` (default: `any`)

## Pre-Scout: Registry Eligibility Check

Before scouting, check if the repo is eligible for AI contributions:

```bash
REPO="{{repoFullName}}"
RESULT=$(~/.claude/hooks/oss-registry-check "$REPO" 2>&1)
RC=$?
echo "$RESULT"

case $RC in
  0) ;; # Eligible — proceed to scouting
  1) # Ineligible (anti-ai or blocked)
     echo "Cannot scout: repo is not eligible for AI contributions."
     # Stop here — do not scout issues for ineligible repos
     exit 0
     ;;
  2) # Unknown — not in registry
     echo "Repo not in registry. Would you like to run oss-repo-recon first, or proceed anyway?"
     # Interactive callers may override; autonomous playbooks should stop
     ;;
  126|127) # Resolver missing
     echo "WARNING: oss-registry-check not found. Proceeding without eligibility check."
     ;;
esac
```

## Pre-Scout: Label-Based Hard Exclusion

Some repositories use labels to signal that a team or contributor has already picked up an issue. The scout MUST filter these out **before scoring**, because they are the single strongest "don't touch this" signal a maintainer team can emit. Missing it produces exactly the failure mode this gate was added to prevent: scouting n8n-io/n8n #28378 which carried `status:in-linear` + `status:team-assigned` (n8n team owned it via Linear `GHC-7713`), claiming it, and then having to retract after the user flagged the labels.

These signals are more reliable than "no assignee, no linked PR" because many teams track work internally in Linear / Jira / ClickUp without touching GitHub assignees or opening a draft PR. The only visible GitHub surface is the label.

### Hard-exclude patterns

For each candidate, fetch its labels and drop it if **any** label name contains (case-insensitive) any of these substrings:

- `team-assigned` / `team_assigned` / `team assigned`
- `in-progress` / `in_progress` / `in progress`
- `in-review` / `in_review` / `in review`
- `wip`
- `assigned` (by itself, not as part of `unassigned`)
- `needs-team` / `needs_team` / `needs team`
- `pending-assignment` / `pending_assignment` / `pending assignment` (n8n auto-triage uses this for "team will pick this up next")

`in-linear` / `in_linear` is **not** in this list — see [soft flags](#soft-flag-patterns-warn-but-allow-with-extra-evidence) below for the 2026-04-14 calibration note.

The pattern match is intentionally broad because label schemes vary per repo (`status:team-assigned`, `team-assigned`, `Status: Team Assigned`, etc.). When in doubt, drop the candidate and look for one without these labels.

### Soft-flag patterns (warn but allow with extra evidence)

These labels **demote** a candidate but do not hard-exclude. If surfaced, the candidate card MUST include the flag reason and the scout MUST confirm no maintainer activity in the last 30 days before recommending the candidate as the top pick:

- `in-linear` / `in_linear` — n8n auto-triage applies this to ~99% of open issues to mark "tracked in Linear". Alone it does NOT mean "team owns this"; it just means there's a Linear ticket. Hard-excluding it (the original 2026-04-13 patch) emptied the entire scoutable pool on n8n. It is now a soft flag: in the deep-dive, verify the issue is not *also* labeled with `team-assigned` / `in-progress` / `in-review` / `wip` / `needs-team` — any of those still hard-excludes via the rules above. If `in-linear` appears alone, the candidate is fair game.
- `triage` / `needs-triage`
- `backlog`
- `waiting` / `waiting-for-reporter` / `waiting-for-reply`
- `stale` / `inactive`
- `blocked` / `blocked-by-*`

### Implementation

```bash
HARD_EXCLUDE=(
  "team-assigned" "team_assigned" "team assigned"
  "in-progress" "in_progress" "in progress"
  "in-review" "in_review" "in review"
  "wip"
  "needs-team" "needs_team" "needs team"
  "pending-assignment" "pending_assignment" "pending assignment"
  # in-linear / in_linear was removed on 2026-04-14 — was ~99% of n8n issues.
  # See soft flags above; team-assigned still catches the original #28378 case.
)

label_is_hard_excluded() {
  local labels_lower="${1,,}"
  for pattern in "${HARD_EXCLUDE[@]}"; do
    if [[ "$labels_lower" == *"$pattern"* ]]; then
      echo "$pattern"
      return 0
    fi
  done
  # `assigned` as a whole word, but not inside `unassigned`
  if echo "$labels_lower" | grep -Eq '(^|[^a-z])assigned([^a-z]|$)'; then
    echo "assigned"
    return 0
  fi
  return 1
}

# For each candidate
ISSUE_NUM=<candidate>
CANDIDATE_LABELS=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '[.labels[].name] | join(" ")')
HIT=$(label_is_hard_excluded "$CANDIDATE_LABELS" || true)
if [ -n "$HIT" ]; then
  echo "SKIP #${ISSUE_NUM}: label hard-exclude match '${HIT}' in '${CANDIDATE_LABELS}'"
  # Record in the skipped-candidates list with reason; do NOT proceed to scoring
  continue
fi
```

### Recording skips

Skipped candidates MUST appear in the Output Format's "Skipped" section with the label reason visible. This is not optional — it's how the user audits whether the filter is too aggressive or correctly catching real "don't touch" signals.

```markdown
### Skipped (label-based hard exclusion)
- #28378 — labels: `team:nodes, status:in-linear, status:team-assigned` — reason: team-assigned
```

Also mark the skipped issue in `~/.claude/{slug}-recon/contributions.json` with `status: avoid_forever` and a reason pointing at the label, so future scouts don't re-evaluate it:

```bash
jq --arg num "$ISSUE_NUM" \
   --arg title "$TITLE" \
   --arg reason "Label hard-exclude: $HIT ($CANDIDATE_LABELS)" \
   --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.issues[$num] = {
    "number": ($num | tonumber),
    "title": $title,
    "status": "avoid_forever",
    "reason": $reason,
    "selected_at": (.issues[$num].selected_at // $now),
    "updated_at": $now,
    "branch": null,
    "pr_number": null
  }' ~/.claude/${SLUG}-recon/contributions.json > /tmp/contrib-tmp.json \
  && mv /tmp/contrib-tmp.json ~/.claude/${SLUG}-recon/contributions.json
```

## Pre-Scout: Load Contribution History

Two independent dedup sources are consulted before scoring. The scout MUST check both.

### 1. Kookr-wide OSS attempt store (`~/.kookr/oss-attempts.json`)

This is the authoritative cross-repo record of every external OSS attempt tracked by Kookr. It uses a `(repo, issueNumber)` secondary index so historical PR records (keyed by PR number, not issue number) still block scouting by their originating issue.

```bash
REPO="{{repoFullName}}"
OSS_STORE="$HOME/.kookr/oss-attempts.json"

OSS_EXCLUDED=""   # (repo, issueNumber) pairs in state pr_open or merged — skip entirely
OSS_DEMOTED=""    # most-recent state is closed — surface with a warning, don't silently skip

if [ -f "${OSS_STORE}" ]; then
  # Extract every record for this repo; for each unique issueNumber, compute the decision.
  # allow  → absent from both lists
  # exclude → in OSS_EXCLUDED (any record in state pr_open or merged)
  # demote  → in OSS_DEMOTED (most recent is closed; no pr_open/merged for the same issue)
  OSS_EXCLUDED=$(jq -r --arg repo "$REPO" '
    [ .attempts[]
      | select(.repo == $repo)
      | select(.issueNumber != null)
      | select(.state == "pr_open" or .state == "merged")
      | .issueNumber
    ] | unique | .[]?
  ' "$OSS_STORE" 2>/dev/null || true)

  OSS_DEMOTED=$(jq -r --arg repo "$REPO" '
    . as $root
    | [ .attempts[]
        | select(.repo == $repo)
        | select(.issueNumber != null)
        | .issueNumber
      ] | unique | .[] as $issue
    | select(
        [ $root.attempts[]
          | select(.repo == $repo and .issueNumber == $issue and (.state == "pr_open" or .state == "merged"))
        ] | length == 0
      )
    | select(
        [ $root.attempts[]
          | select(.repo == $repo and .issueNumber == $issue and .state == "closed")
        ] | length > 0
      )
    | "\($issue)"
  ' "$OSS_STORE" 2>/dev/null || true)

  echo "OSS store: excluding $(echo "$OSS_EXCLUDED" | wc -w) issue(s), demoting $(echo "$OSS_DEMOTED" | wc -w) closed attempt(s)"
else
  echo "OSS store not found at $OSS_STORE — Kookr-wide dedup unavailable"
fi
```

**Scoring rules:**
- Any candidate whose issue number appears in `OSS_EXCLUDED` MUST be dropped (there is already an open or merged PR).
- Any candidate whose issue number appears in `OSS_DEMOTED` MAY still be surfaced, but MUST include the prior-closure reason in the candidate card. Fetch the closing comment verbatim from the store with:
  ```bash
  jq -r --arg repo "$REPO" --arg issue "$ISSUE_NUM" '
    .attempts[]
    | select(.repo == $repo and .issueNumber == ($issue | tonumber) and .state == "closed")
    | .closing.closingComment // empty
  ' "$OSS_STORE" 2>/dev/null
  ```

### 2. Per-recon contribution log (`~/.claude/{repoSlug}-recon/contributions.json`)

Legacy per-recon file tracking single-session decisions (e.g., "already fixed on main by PR #X"). Keep consulting it for reasons the Kookr-wide store does not capture.

```bash
SLUG="{{repoSlug}}"
CONTRIB_FILE=~/.claude/${SLUG}-recon/contributions.json

if [ -f "${CONTRIB_FILE}" ]; then
  # All previously attempted issues (any status) — dedup
  EXCLUDED_ISSUES=$(jq -r '.issues | keys[]' "${CONTRIB_FILE}" 2>/dev/null)
  # Top-level never_scout list — issues flagged "do not scout again" with a durable reason
  # (e.g. label-based hard exclusion from a prior run). Both sources MUST be unioned.
  NEVER_SCOUT=$(jq -r '.never_scout[]?.number // empty' "${CONTRIB_FILE}" 2>/dev/null)
  # Also pull anything with status=avoid_forever — same semantics as never_scout,
  # kept for backward compat with the per-issue record.
  AVOID_FOREVER=$(jq -r '[.issues[] | select(.status == "avoid_forever") | .number] | .[]' "${CONTRIB_FILE}" 2>/dev/null)
  EXCLUDED_ISSUES=$(printf '%s\n' $EXCLUDED_ISSUES $NEVER_SCOUT $AVOID_FOREVER | sort -u | grep -v '^$' || true)
  echo "Excluding previously attempted issues: ${EXCLUDED_ISSUES}"
else
  EXCLUDED_ISSUES=""
  echo "No contribution history found — all issues eligible"
fi
```

### 3. Emit a `scouted` event for every candidate you surface to the user

After scoring, for each candidate you present in your 3-5 shortlist, POST a `scouted` event so future scout runs can see them:

```bash
KOOKR_URL="${KOOKR_API_BASE_URL:-http://localhost:4800}"
curl -fsS -m 2 -X POST \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg repo "$REPO" \
    --argjson issueNumber "$ISSUE_NUM" \
    --arg issueUrl "https://github.com/${REPO}/issues/${ISSUE_NUM}" \
    '{kind: "scouted", repo: $repo, issueNumber: $issueNumber, issueUrl: $issueUrl}'
  )" \
  "$KOOKR_URL/api/oss-attempts/events" >/dev/null 2>&1 || true
```

Emit failures are silently ignored — dedup is best-effort, never blocking.

When scoring candidates, skip any issue whose number appears in `EXCLUDED_ISSUES`. Report skips:

```markdown
### Skipped (previously attempted)
- #120918 — status: skipped, reason: Already fixed on main by PR #118412
```

Also check if the issue is already fixed on main by searching for merged PRs:

```bash
gh api "search/issues?q=repo:${REPO}+is:pr+is:merged+{keywords}+created:>YYYY-MM-DD" \
  --jq '.items[] | {number, title}'
```

If a merged PR already fixes the issue, mark it as skipped in contributions.json with the reason.

## Search Strategy

Search in priority order (higher priority = more likely to get merged):

### Tier 1: Explicitly Welcomed Contributions

```bash
REPO="{{repoFullName}}"

# Good first issue + help wanted (unassigned)
gh api "repos/${REPO}/issues?labels=good+first+issue,help+wanted&state=open&per_page=20&assignee=none" \
  --jq '.[] | {number, title, labels: [.labels[].name], created_at, comments}'

# Help wanted only (broader)
gh api "repos/${REPO}/issues?labels=help+wanted&state=open&per_page=30&assignee=none" \
  --jq '.[] | {number, title, labels: [.labels[].name], created_at, comments}'
```

### Tier 2: Performance-Related Issues (if contributionFocus = performance)

```bash
# Search for performance issues
gh api "search/issues?q=repo:${REPO}+is:issue+is:open+label:performance,optimization,perf,slow,benchmark&per_page=20" \
  --jq '.items[] | {number, title, labels: [.labels[].name], created_at, comments}'

# Text search for perf keywords
gh api "search/issues?q=repo:${REPO}+is:issue+is:open+slow+OR+performance+OR+optimize+OR+benchmark&per_page=20" \
  --jq '.items[] | {number, title, created_at, comments}'
```

### Tier 3: Recently Confirmed Bugs With Repro Steps

```bash
# Bugs with reproduction steps
gh api "search/issues?q=repo:${REPO}+is:issue+is:open+label:bug+created:>$(date -d '60 days ago' +%Y-%m-%d 2>/dev/null || date -v-60d +%Y-%m-%d)&sort=reactions-+1&per_page=20" \
  --jq '.items[] | {number, title, reactions: .reactions.total_count, comments, created_at}'
```

### Tier 4: Documentation and Test Gaps

```bash
# Documentation issues
gh api "search/issues?q=repo:${REPO}+is:issue+is:open+label:documentation,docs&per_page=10" \
  --jq '.items[] | {number, title, created_at}'

# Test coverage requests
gh api "search/issues?q=repo:${REPO}+is:issue+is:open+label:testing,test,coverage&per_page=10" \
  --jq '.items[] | {number, title, created_at}'
```

### Tier 5: Abandoned PRs (Takeover Opportunities)

```bash
# Stale PRs that could be taken over
gh api "search/issues?q=repo:${REPO}+is:pr+is:open+updated:<$(date -d '60 days ago' +%Y-%m-%d 2>/dev/null || date -v-60d +%Y-%m-%d)&per_page=10" \
  --jq '.items[] | {number, title, user: .user.login, updated_at}'
```

## Scoring Matrix

For each candidate issue, score on 6 dimensions (1-5 each). **Verifiability is a hard minimum — a candidate with Verifiability ≤ 2 cannot be claimed regardless of its total score.**

### Clarity (1-5): How clear are the requirements?

| Score | Meaning |
|-------|---------|
| 5 | Exact steps to reproduce, expected vs actual, clear scope |
| 4 | Good description, some ambiguity but workable |
| 3 | Understandable but needs investigation to scope |
| 2 | Vague, multiple interpretations possible |
| 1 | Unclear what the issue even is |

### Size (1-5): How small is the expected change?

| Score | Meaning |
|-------|---------|
| 5 | One file, <50 lines |
| 4 | 2-3 files, <150 lines |
| 3 | Moderate — 3-5 files, <300 lines |
| 2 | Large — multiple files, significant logic |
| 1 | Very large — architectural change, many files |

### Acceptance (1-5): How likely is the PR to be accepted?

| Score | Meaning |
|-------|---------|
| 5 | Maintainer explicitly requested a fix, issue pre-approved |
| 4 | Bug confirmed by maintainer, clear acceptance criteria |
| 3 | Community-reported, reasonable fix, aligned with roadmap |
| 2 | Unclear if maintainers want this change |
| 1 | Controversial, rejected before, or conflicts with roadmap |

### Competition (1-5): How uncontested is this issue?

| Score | Meaning |
|-------|---------|
| 5 | No assignee, no open PRs, no recent comments claiming it |
| 4 | Someone commented interest but no PR opened (>14 days ago) |
| 3 | An open PR exists but is stale (>30 days no activity) |
| 2 | Active PR exists from another contributor |
| 1 | Assigned to someone who is actively working on it |

### Match (1-5): How well does it match the contributor's goals?

| Score | Meaning |
|-------|---------|
| 5 | Perfect match for stated focus (e.g., performance optimization) |
| 4 | Good match, relevant skills apply |
| 3 | Tangentially related |
| 2 | Outside core interest but doable |
| 1 | Poor match |

### Verifiability (1-5): Can you reproduce the bug or prove the fix works without inventing reality?

This is the dimension that blocks AI slop contributions. See the [Reproducibility Gate](#reproducibility-gate) for the operational pass/fail criteria. Anchors:

| Score | Meaning |
|-------|---------|
| 5 | You can write a failing unit test on the current checkout that reproduces the bug in seconds. Fix and re-run proves the fix. No external services, no flaky infra. |
| 4 | Existing integration/E2E test already exercises the buggy code path, covers the real behavior (not just mocks of the dependency being fixed), and you can run it locally. OR: narrow backend contract change with quoted authoritative external docs + existing contract test you can update. |
| 3 | Faithful UI reproduction possible in a real dev server / Storybook / Playwright run — not a mockup that simulates the previous design. You can produce before/after screenshots. |
| 2 | Only theoretical reproduction (code reading, grep, docs) — you cannot run it. **BELOW THE BAR. Do not claim.** |
| 1 | Requires external infrastructure you don't have (live webhook ingress, credentialed third-party API, specific hardware, container stack you haven't built). **BELOW THE BAR. Do not claim.** |

### Priority Score

```
priority = clarity + size + acceptance + competition + match + verifiability
```

| Range | Meaning |
|-------|---------|
| 24-30 | Excellent opportunity — pursue immediately |
| 20-23 | Good opportunity — strong candidate (minimum claimable total) |
| 15-19 | Below bar — only pursue if verifiability ≥ 4 and nothing else is available |
| <15 | Skip — too risky or too far from goals |

**Hard minimum:** `verifiability ≥ 3`. A candidate with `verifiability ≤ 2` cannot be claimed even if the total score is 25/30. The trade-off is explicit: skipping 10 unverifiable candidates is cheaper than submitting one AI-slop PR that burns maintainer goodwill or — worse — gets the contributor flagged as an LLM-driven spam account.

## Competition Check

**PREFERRED EXECUTION PATH: use the `kookr-oss-issue-scout` subagent** (`.claude/agents/kookr-oss-issue-scout.md`). It runs the full scout flow in an isolated context, returns a **ready-to-claim top candidate** (with a draft claim comment and a one-shot `gh api` command), and guarantees the competition check cannot be forgotten or skipped. The subagent does NOT post the claim itself — the caller reviews the candidate and runs the `gh api` command verbatim. The PreToolUse `claim-gate` hook at `~/.claude/hooks/claim-gate.sh` re-runs all three competition queries on the caller's POST as a second line of defense, and also fires for manual claims that bypass the subagent.

The following is the canonical check for anyone running the scout workflow manually or auditing the subagent's behavior.

### ⚠️ DO NOT use the `/issues/{N}/timeline` endpoint for competition checks

The GitHub timeline API paginates events in chronological order. On any issue with stacked-up labels, comments, and subscribe events (which is ~every issue older than a few days on an active repo), the `cross-referenced` events for later-opened PRs fall past the default first page of ~30 entries and **are silently dropped**. This previously caused a duplicate-PR incident where the scout returned "no competition" on issue #26450 while PR #28048 had been open against it for 5 days.

The following endpoint is **banned** for competition purposes:

```bash
# ❌ BROKEN — silently drops late cross-reference events
gh api "repos/${REPO}/issues/${ISSUE_NUM}/timeline" --jq '.[] | select(.event == "cross-referenced") ...'
```

### ✅ Correct competition check (use all three)

Before finalizing selection, run **all three** of these checks. If any returns a non-empty result, skip the candidate. Do not weigh them against other scoring factors.

```bash
ISSUE_NUM={number}

# Check 1: gh pr list --search — returns all PRs that reference the issue number,
# regardless of timeline position. Most reliable single signal.
COMPETING_PRS=$(gh pr list -R "$REPO" --state all --search "$ISSUE_NUM" \
  --json number,state,title,createdAt --limit 20 \
  --jq '[.[] | select(.state == "OPEN" or (.state == "CLOSED" and (.createdAt | fromdateiso8601) > (now - 2592000)))]')

# Check 2: GraphQL closedByPullRequestsReferences — catches explicit
# "closes #N" / "fixes #N" linkages, including PRs still open.
LINKED_PRS=$(gh api graphql -f query="query {
  repository(owner: \"${REPO%/*}\", name: \"${REPO#*/}\") {
    issue(number: ${ISSUE_NUM}) {
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
        nodes { number state title }
      }
    }
  }
}" --jq '.data.repository.issue.closedByPullRequestsReferences.nodes')

# Check 3: assignees — never work on issues assigned to another user.
ASSIGNEES=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '[.assignees[].login]')

# Check 4: soft-claims in recent comments (heuristic, not authoritative)
gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" \
  --jq '.[] | select(.body | test("I.ll take|working on|I.m on it|assigned to me|taking this"; "i")) | {user: .user.login, date: .created_at, body: (.body[:100])}'
```

**Skip decision (any one → drop the candidate):**
- `COMPETING_PRS` is non-empty → PR exists (open or recently closed)
- `LINKED_PRS` contains an `OPEN` entry → linked via closes reference
- `ASSIGNEES` is non-empty and doesn't contain `jeanibarz` → assigned elsewhere
- Any soft-claim comment within the last 14 days from a non-OP user

When in doubt, skip. False positives cost a few minutes; false negatives cost maintainer goodwill.

### File-Level Overlap Check (for umbrella issues)

For large umbrella issues where many contributors work on different files, the issue-level check is insufficient. **Before creating a branch**, also check for open AND closed PRs that touch the same files you plan to modify — with NO time cutoff.

The issue-number-anchored queries in Competition Check above are necessary but not sufficient for umbrella refactors. Two things escape them:

1. **PRs that use "Relates to #N" instead of a closing keyword.** GraphQL `closedByPullRequestsReferences` only indexes closing keywords (close/closed/closes/fix/fixed/fixes/resolve/resolved/resolves). A comprehensive PR that said "Relates to #24494" in the body will NOT appear in that GraphQL query.
2. **Old closed PRs filtered out by the 30-day cutoff.** `COMPETING_PRS` from Competition Check drops CLOSED PRs older than 30 days. For chore/refactor umbrellas, a 6-month-old comprehensive PR that covered your planned files is still a strong "this slice is spoken for" signal — especially if it was closed *voluntarily* by its author, not rejected by a maintainer.

```bash
# (a) Issue-anchored check with NO time cutoff (catches old closed PRs)
gh pr list -R ${REPO} --state all --search "${ISSUE_NUM}" --json number,title,state,files,createdAt,closedAt \
  --jq '.[] | {number, state, title, files: [.files[].path], createdAt, closedAt}'

# (b) File-path check — for each file in your planned fix, search ALL PR history
for FILE in "${PLANNED_FILES[@]}"; do
  gh pr list -R ${REPO} --state all --search "${FILE}" --limit 20 \
    --json number,title,state,files \
    --jq --arg f "$FILE" '.[] | select(.files[]?.path == $f) | {number, state, title}'
done

# (c) Pattern-keyword check — for chore/refactor umbrellas, search the actual pattern
#     being removed/changed, not just the issue number. Pick 2-3 distinctive tokens
#     from the issue title or the planned diff (e.g. "type ignore", "SimpleNamespace",
#     "match case ToolProviderType").
gh pr list -R ${REPO} --state all --search "${PATTERN_KEYWORDS}" --limit 30 \
  --json number,title,state,body,files \
  --jq '.[] | {number, state, title, files: [.files[].path]}'
```

**Decision:**
- ANY open PR touches your planned files → pick different files or coordinate in the issue
- ANY closed PR (regardless of age) overlaps >50% of your planned files AND was closed *voluntarily* (not rejected) → **drop the slice**, your work is redundant. Look at why it was closed: "author focusing on other work" and "maintainer approved but author stopped" are both "someone already did this, don't re-do it" signals.
- Closed PR overlaps your files BUT was closed because the maintainer rejected the pattern → the whole cleanup is off-limits, not just your slice. Drop the entire candidate.

**Special rule for chore/refactor umbrella issues** (labels like `chore`, `refactor`, or issue title `Chore: …` / `[Chore/Refactor]`):

Umbrella cleanup issues attract comprehensive "kitchen sink" PRs. If such a PR exists — open OR closed — and covers your planned files with the same pattern, the slice is claimed. A voluntarily-closed comprehensive PR doesn't free up the work; it just means the specific author chose not to ship it. The fact that a Gemini / Copilot / human reviewer approved the pattern across those files is the signal that matters.

The 2026-04-16 incident on langgenius/dify #24494: the scout missed agent-steven's closed PR #32189 (26 files, 55 comments, closed voluntarily 2026-02-13 saying "focus on other contributions") because the GraphQL query only matched closing keywords and the 30-day cutoff filtered it out. The scout proposed to re-do 8 of those 55 comments on `statistic.py` — a file agent-steven had already covered.

## Reproducibility Gate

This gate exists because on 2026-04-13 two concurrent scout runs (langgenius/dify #34827 and n8n-io/n8n #28378) both claimed issues that scored 22+/25 on the original 5-dimension rubric but were unverifiable in practice. The dify fix contradicted existing test assertions and had been self-reverted by the original author 90 days prior; the n8n fix required live Telegram webhook infrastructure and the scout never attempted any reproduction. The user had to retract one claim and reluctantly accept the other as a learning opportunity.

**The rule is now: no reproducibility evidence, no claim.** This gate runs between the competition check and the claim POST. Mocks that simulate the *previous* design of the system, or mocks that invent undocumented behavior of external services or framework versions you haven't opened, do **not** satisfy this gate — they pass tests while lying about reality.

### Pass conditions (any ONE is sufficient — prefer the earliest)

1. **Failing-test reproducer on the checkout.** You wrote (or identified) a unit/integration test that runs on the current `upstream/<default>` branch and fails in a way that matches the issue. Include the test path + the failing assertion or error output in the evidence note.

2. **Existing integration/E2E test on the buggy code path.** A real integration or E2E test already exercises the code path the fix will change. You grep-verified it, read the test body, and confirmed it covers the scenario (not just the file). A generic unit test that mocks the dependency the bug is *in* does **not** count — the test must exercise the real behavior.

3. **Faithful UI reproduction (frontend issues only).** You can build + run the component in a real environment (Storybook, dev server, Playwright) and produce a screenshot of the current wrong state AND a specification of the expected fixed state. A mock/mockup that simulates the *previous* design is not acceptable — the gate requires the real running code or a faithful-enough render. Screenshots go in the evidence note.

4. **Authoritative external documentation (backend contract changes only).** The fix is a narrow contract change to an external API/service (e.g. Todoist sync v9 → v1) AND you have linked, current, authoritative documentation for the target contract AND the checkout contains existing tests that exercise the old path. Documentation must be fetched via WebFetch and quoted in the evidence note — not reconstructed from training data. No "I assume the framework behaves X" without a doc quote.

### Hard fails (any ONE = drop the candidate)

- The proposed fix contradicts existing test assertions that enforce the opposite behavior. Rewriting existing assertions is a semantic change that needs maintainer sign-off, not a claim-and-PR. Always grep the test files that cover the target module for the identifiers the fix touches.
- Reproduction requires external infrastructure you don't have: live webhook ingress (Telegram, Slack, Stripe), credentialed third-party API, specific hardware, a CI-only database, a container stack you have not built and run.
- The issue premise cannot be confirmed by reading the code. Example: the issue says "Output node retains End restrictions after rename" but there is no `BlockEnum.Output` in the repo — the premise is unverified.
- A prior commit that attempted the same fix was reverted in the last 90 days and no public rationale exists. **Read the reverted diff; do not assume the revert was unrelated bundling.** If the revert removes the exact guard/assertion/shape your fix would touch, that is a semantic signal and the candidate is dead.
- The bug report is one screenshot or one sentence with no reproduction environment and no stack trace. "Clarity=5" on this is optimism, not evidence.
- You find yourself about to write mocks that simulate the *previous* design of the system, or that invent undocumented behavior of an external service or a framework version you haven't opened. Stop — those mocks will pass the tests but lie about reality.

### Evidence note

Write a short note to `/tmp/scout-repro-${SLUG}-${ISSUE_NUM}.md` containing:

```markdown
# Reproducibility evidence — {repo} #{issue}

## Pass path
{which of the four pass conditions: 1 / 2 / 3 / 4}

## Evidence
- {path to failing test, or existing integration test path, or screenshot path, or doc URL + quote}
- {command run and its output, OR grep result, OR WebFetch quote}

## Verifiability score
{1-5 with justification}

## Hard-fail check
- Existing test assertions do NOT contradict the fix: {grep output}
- No prior-90-day self-revert on the target: {git log output}
- Issue premise confirmed in code: {grep output}
```

The evidence note is required in the scout return value, not optional. The `claim-gate` hook can be extended to check for its existence before allowing the claim POST.

### Calibration question

Before every claim, ask yourself:

> *"If the maintainer replies 'what exact command did you run to confirm this bug?', can I paste a real command + real output?"*

If the honest answer is "no, I reasoned about it" — drop the candidate.

### The explicit trade-off

**Prefer skipping more issues to claiming one you cannot verify.** Risking AI-slop reputation with maintainers is worse than a day without a PR. A single rejected-as-LLM-spam PR can get the contributor blocklisted on a repo forever; a day without finding a suitable issue costs nothing but time.

## Recent-Refactor Check

Issue authors write bug reports against the version they are running. When a major refactor landed between that version and `upstream/<default-branch>`, the file:line pointers, the call graph, and — most dangerously — the data contracts the fix depends on may have changed. A "just skip the expensive computation" suggestion can be invalid if a recent refactor made the expensive computation's output first-class storage that downstream consumers now depend on.

**Run this check for every shortlisted candidate before claiming:**

```bash
LOCAL=$HOME/git/${REPO_NAME}
cd "$LOCAL" && git fetch upstream >/dev/null 2>&1

# Identify likely target files from the issue (file paths, stack traces, error messages)
TARGETS=(packages/foo/src/bar.ts packages/foo/src/baz.ts)

for FILE in "${TARGETS[@]}"; do
  echo "=== $FILE ==="
  git log --since="14 days ago" --oneline upstream/${DEFAULT} -- "$FILE" 2>/dev/null
done
```

**Red-flag keywords in recent commit messages:** `refactor`, `rewrite`, `restore`, `replace`, `migrate`, `store … as`, `extract`, `move`, `split`, `unify`. Any of these on a target file in the last 14 days means the fix scope may have silently changed.

**For each red-flag commit, read the PR:**

```bash
PR_NUM=<from commit message (#NNNN)>
gh pr view $PR_NUM -R ${REPO} --json title,body,files --jq '{title, body: .body[:1500], files: [.files[].path]}'
```

Look specifically for:
- Changes to persisted data shapes or storage keys (breaks "just skip the computation" fixes)
- New frontend/UI consumers of fields the issue author proposes to remove or make lazy
- Signature changes on the functions the issue targets
- Reverts or re-lands of prior work (churn zones)

**Scoring adjustment:**
- Recent refactor on a target file → demote candidate Size to ≤2 and Acceptance to ≤3, and surface the risk in the candidate card (e.g., "⚠️ PR #21244 merged 3 days ago made unified patches first-class storage — fix scope may be larger than the issue suggests").
- Recent refactor that directly conflicts with the issue author's proposed fix → drop the candidate from the shortlist and pick a different one. If the candidate was already claimed, stop implementation, comment the findings on the issue, and abandon.

**Before writing any code in Phase 4, re-run this check on the *actual* files you intend to touch** — not just the ones the issue mentions. If you discover a contract conflict mid-implementation, stop and re-evaluate rather than forcing the fix through.

## Output Format

```markdown
## Issue Scout Results: {owner}/{repo} ({date})

### Candidate 1: #{number} — {title}
- **Scores**: Clarity={c} Size={s} Acceptance={a} Competition={comp} Match={m} Verifiability={v} → **Total: {sum}/30**
- **Labels**: {labels}
- **Age**: {days since created}
- **Comments**: {count}
- **Competing PRs**: {none / PR #{n} by @{user} (status)}
- **Reproducibility**: {pass path 1/2/3/4 OR FAIL reason} — evidence note `/tmp/scout-repro-{slug}-{num}.md`
- **Why this issue**: {1-2 sentence rationale}
- **Estimated effort**: {small/medium/large}

### Candidate 2: ...

### Recommendation
{Which candidate to pursue and why — must have verifiability ≥ 3}
```

## After Selection

Once an issue is selected:

1. **Snapshot issue state before claiming** — record the current `state`, `updated_at`, and comment count:
   ```bash
   PRE_STATE=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '{state, updated_at, comments}')
   ```

2. Comment on the issue requesting assignment:
   ```bash
   COMMENT_URL=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}/comments" -X POST \
     -f body="I'd like to work on this. I have a fix approach in mind based on [brief description]. May I be assigned?" \
     --jq '.url')
   ```

3. **Verify issue state after claiming** — re-check the issue immediately after posting. If the issue was closed, assigned, or received new comments between the pre-check and your comment, delete your comment and skip to the next candidate:
   ```bash
   POST_STATE=$(gh api "repos/${REPO}/issues/${ISSUE_NUM}" --jq '{state, updated_at, comments}')
   PRE_COMMENTS=$(echo "$PRE_STATE" | jq '.comments')
   POST_COMMENTS=$(echo "$POST_STATE" | jq '.comments')
   POST_ISSUE_STATE=$(echo "$POST_STATE" | jq -r '.state')

   # Expected: exactly 1 new comment (ours). If more, someone else posted too.
   # Also check if the issue was closed between our check and our comment.
   EXPECTED_COMMENTS=$((PRE_COMMENTS + 1))
   if [ "$POST_ISSUE_STATE" != "open" ] || [ "$POST_COMMENTS" -gt "$EXPECTED_COMMENTS" ]; then
     echo "RACE DETECTED: issue state changed while claiming. Removing comment and skipping."
     gh api "${COMMENT_URL}" -X DELETE 2>/dev/null
     # Move to next candidate
   fi
   ```

4. Record selection in contributions.json:
   ```bash
   SLUG="{{repoSlug}}"
   NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   TODAY=$(date -u +%Y-%m-%d)

   cat ~/.claude/${SLUG}-recon/contributions.json | jq \
     --arg num "${ISSUE_NUM}" \
     --arg title "${TITLE}" \
     --arg now "${NOW}" \
     --arg today "${TODAY}" \
     '.issues[$num] = {
       "number": ($num | tonumber),
       "title": $title,
       "status": "selected",
       "reason": null,
       "selected_at": $now,
       "updated_at": $now,
       "branch": null,
       "pr_number": null
     } | .daily_log[$today].issues_attempted += [($num | tonumber)]' \
     > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ~/.claude/${SLUG}-recon/contributions.json
   ```

## Anti-Patterns

- [ ] Don't pick issues without checking for competing PRs first
- [ ] Don't pick issues that maintainers have explicitly deprioritized
- [ ] Don't pick issues requiring access you don't have (internal tools, specific hardware, live webhook ingress, credentialed third-party APIs)
- [ ] Don't pick issues in areas under active refactoring (high merge conflict risk)
- [ ] Don't trust the issue's file:line pointers or "small fix" framing without running `git log --since="14 days ago"` on the target files first — recent refactors can silently invalidate the proposed fix path
- [ ] Don't ignore closed issues — check if the issue was closed as won't-fix (don't reopen)
- [ ] Don't start working before requesting assignment on repos that require it
- [ ] For umbrella issues (many files, many contributors): don't just check issue-level competition — check for open PRs touching the same files you plan to modify
- [ ] Don't assume the issue is still open after posting a claim comment — always re-check the issue state immediately after posting to detect races (closed, new comments, assignment changes)
- [ ] **Don't claim before passing the Reproducibility Gate** — theoretical analysis is not evidence. Skipping more candidates is cheaper than claiming one you can't verify. See [Reproducibility Gate](#reproducibility-gate).
- [ ] **Don't write mocks that simulate the *previous* design** of the system to make reproduction "work" — those mocks lie about reality and the resulting PR is AI slop. For frontend, use the real dev server or Storybook. For backend, use real integration tests or authoritative external docs.
- [ ] **Don't invent framework or external-service behavior from training data** — if you don't have a real command output, a real test run, or a quoted authoritative doc, it doesn't exist. The scout must cite evidence, not speculate.
- [ ] **Don't wave away prior self-reverts** as "probably unrelated bundling" without reading the reverted diff. A self-revert on the exact code path your fix would touch is a semantic decision, not noise.
- [ ] Don't submit a PR with only theoretical analysis — always verify the fix locally (build, run, test) and include real pass/fail output in the PR Evidence section. (This rule now applies at *claim* time, not just at submit time — see Reproducibility Gate.)
- [ ] **Don't score a candidate whose labels say someone else owns it.** Labels like `status:team-assigned`, `in-progress`, `in-review`, `wip`, `in-linear` are the maintainer team's explicit "don't touch" signal — hard-exclude before scoring. See [Pre-Scout: Label-Based Hard Exclusion](#pre-scout-label-based-hard-exclusion). Missing this signal wastes your effort AND the maintainer's goodwill.

## See Also

- [[oss-repo-recon]] — Must run before scouting
- [[oss-fork-manager]] — Set up fork for the selected issue
- [[oss-pr-critic]] — Learn what PRs succeed in this repo
