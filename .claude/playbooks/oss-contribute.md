# OSS Contribution Pipeline

> **Requires the optional OSS extension** — this playbook depends on user-global tooling that is not bundled in this repo: `~/.claude/hooks/oss-registry-check`, `~/.claude/oss-contribution-tracking-template.json`, `~/.claude/reviewer-specialists/`, and the `pr-contribution-excellence` skill. See `docs/hooks-setup.md` for status. If the extension is not installed, the playbook will hit broken references in Phase 0/1 and should not be run — stop and report the missing dependency rather than attempting partial execution.

## Objective

Fully autonomous end-to-end OSS contribution: scout an issue, validate it, implement a fix, iteratively self-review until high quality, and create an upstream PR — all following the target repo's conventions.

## Parameters

- `repo`: GitHub owner/repo (e.g., `grafana/grafana`)

## Workflow

### Phase 0: Registry Eligibility Check

Before any work begins, check if the target repo is eligible for AI contributions:

```bash
REPO="{repo}"
RESULT=$(~/.claude/hooks/oss-registry-check "$REPO" 2>&1)
RC=$?
echo "$RESULT"

case $RC in
  0) ;; # Eligible — proceed
  1) # Ineligible — hard stop
     echo "Stopping: repo is not eligible for AI contributions."
     exit 0
     ;;
  2) # Unknown — not in registry
     echo "Repo not in registry. Run oss-repo-recon first to assess eligibility."
     exit 0
     ;;
  126|127) # Resolver script missing or not executable
     echo "ERROR: oss-registry-check not found or not executable. Run migration step 2."
     exit 0
     ;;
esac
```

If the resolver is unavailable (exit 126/127) or the repo is unknown (exit 2), stop. Autonomous playbooks block by default — run `oss-repo-recon` to add the repo to the registry first.

### Phase 1: Recon

```
SLUG=$(echo "{repo}" | tr '/' '-')
RECON_DIR=~/.claude/${SLUG}-recon
```

Check if `${RECON_DIR}/recon-report.md` exists. If not, run the `oss-repo-recon` skill on `{repo}` first.

Re-read `${RECON_DIR}/recon-report.md` to understand: build commands, test commands, lint commands, commit message conventions, PR template, CLA requirements, default branch, reviewer assignment process.

If `${RECON_DIR}/conventions.md` does not exist, distill conventions from the recon report:
- Extract language-specific style rules, test conventions, import/export patterns
- Extract PR requirements, naming conventions, CI expectations
- Write to `${RECON_DIR}/conventions.md`
- Structure with `##` sections by language/concern area

If `~/.claude/${SLUG}-pr-lessons/patterns.md` exists, append it to the conventions context.

Initialize contributions.json if missing:

```bash
if [ ! -f ${RECON_DIR}/contributions.json ]; then
  sed "s|OWNER/REPO|{repo}|" ~/.claude/oss-contribution-tracking-template.json \
    > ${RECON_DIR}/contributions.json
fi
```

### Phase 2: Scout (subagent) → Claim (caller posts)

Spawn the `kookr-oss-issue-scout` subagent. It runs in an isolated context with narrow instructions and returns a **ready-to-claim top candidate** (with a draft claim comment body and a one-shot `gh api` command) — or an explicit `ABORTED`. You do not re-verify competition or reproducibility after it returns; the subagent's contract is that every gate has been cleared. But you DO post the claim comment yourself — the subagent deliberately stops short of that to give the user a review checkpoint and to keep the public-action blast radius in the caller's hands.

```
Agent(
  subagent_type: "kookr-oss-issue-scout",
  prompt: "Scout an issue in {repo}. Focus: {contributionFocus or 'any'}. Return the top candidate with score, root cause, fix sketch, reproducibility evidence note path, recommended branch name, draft claim comment, and the gh command to post the claim."
)
```

**What the subagent does** (you don't need to do any of this yourself — it's documented here only so you know what to expect in the return value):
1. Loads the recon report and dedup state (`~/.kookr/oss-attempts.json` + per-recon `contributions.json`)
2. Searches for candidates using repo-specific label queries
3. Hard-excludes candidates whose labels say the team owns them (`team-assigned`, `in-progress`, `in-review`, `wip`, `needs-team`) — see Step 3.5 in the scout agent. Note: `in-linear` *alone* is a soft flag, not a hard exclude — see the 2026-04-14 calibration note.
4. Scores each candidate on **six** dimensions: clarity / size / acceptance / competition / match / **verifiability** (total out of 30, with a hard floor of `verifiability ≥ 3`)
5. Runs a **three-way competition check** on every surviving candidate:
   - `gh pr list -R {repo} --state all --search "{issue_num}"` (reliable)
   - GraphQL `closedByPullRequestsReferences` (catches explicit `closes #N` linkages)
   - `gh api .../issues/{N}` assignees check
6. Runs the **Reproducibility Gate** (Step 5.5 of the scout agent) on the top candidate: must prove ONE of — failing-test reproducer on the checkout, existing integration/E2E test on the buggy path, faithful UI render for frontend issues, or authoritative external documentation for backend contract changes. Mocks that simulate the *previous* design or invent undocumented external-service behavior do not satisfy the gate. Evidence note is written to `/tmp/scout-repro-{slug}-{num}.md`.
7. Deep-dives the top candidate (reads full body, all comments, greps for the buggy code in a checkout)
8. Records the candidate in `~/.claude/{slug}-recon/contributions.json` with `status: "scouted"`
9. Returns a structured summary including the reproducibility evidence note path, the draft claim comment body, and a ready-to-run `gh api` command

**You then post the claim comment** by running the `gh api` command from the return value verbatim. The PreToolUse `claim-gate` hook at `~/.claude/hooks/claim-gate.sh` re-runs all three competition queries on the POST and is your second line of defense — if it blocks, the world has changed since the scout's check and you should re-scout instead of forcing through.

**Critical:** the subagent is forbidden from using the `gh api /issues/N/timeline` endpoint for competition checks — that endpoint silently drops late cross-reference events past the first 30 timeline entries and caused a duplicate-PR incident in the past.

**If the subagent returns "ABORTED"**, respect the decision. Do not try to pick a different issue yourself — spawn the subagent again with different focus parameters, or report to the user that no safe candidate is available.

**If the subagent returns a top candidate**, post the claim comment using the gh command from the return value, then proceed to Phase 4. Record the issue number and branch name from the return value.

### Phase 4: Fork + Worktree Setup

Use the `oss-fork-manager` skill:
1. Ensure fork exists (`gh repo fork {repo} --clone=false` if needed)
2. Clone or update the fork locally
3. Sync with upstream: `git fetch upstream && git rebase upstream/{defaultBranch}`
4. Create feature branch: `git checkout -b fix/{issueNumber}-{slug}`
5. Set up as a git worktree (never work on main)

Record:
- `WORKTREE_PATH` — the worktree directory
- `BRANCH` — the feature branch name
- `FORK` — the fork owner/repo
- `DEFAULT_BRANCH` — upstream default branch (from recon)

### Phase 5: Implement Fix

Work in the worktree to resolve the issue:
1. Read the issue description carefully
2. Explore the relevant code areas using Read/Grep/Glob
3. Implement the fix
4. Run the build command from recon: `{buildCommand}`
5. Run tests from recon: `{testCommand}` (scoped to changed areas if possible)
6. Commit following the repo's commit message conventions from recon

### Phase 6: Push to Fork

```bash
git push origin {BRANCH} --force-with-lease
```

Update contribution status to in-progress:

```bash
cat ${RECON_DIR}/contributions.json | jq \
  --arg num "${issueNumber}" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg branch "${BRANCH}" \
  '.issues[$num].status = "in-progress" | .issues[$num].branch = $branch | .issues[$num].updated_at = $now' \
  > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ${RECON_DIR}/contributions.json
```

### Phase 7: Iterative AI Review (max 3 rounds)

```
SPECIALISTS_DIR=~/.claude/reviewer-specialists
MAX_ITERATIONS=3
iteration=0
prev_actionable=999

while iteration < MAX_ITERATIONS:

  # 7a. Generate review context
  Write to /tmp/${SLUG}-review-context.md:
    # Code Review Task
    ## Repository: {repo}
    ## Branch: {BRANCH}
    ## Description
    {concatenated commit messages}
    ## Changed Files
    {git diff upstream/{defaultBranch}...HEAD --stat}
    ## Diff
    ```diff
    {git diff upstream/{defaultBranch}...HEAD}
    ```
  
  Append conventions:
    bash ${SPECIALISTS_DIR}/filter-conventions.sh \
      /tmp/${SLUG}-review-context.md \
      ${RECON_DIR}/conventions.md \
      >> /tmp/${SLUG}-review-context.md

  # 7b. Launch 4 specialists in parallel (max 4 agents, respects concurrency limit)
  
  Agent A (model=sonnet): Conventions specialist
    Read: ${SPECIALISTS_DIR}/conventions-specialist.md
    Context: /tmp/${SLUG}-review-context.md
    Repo checkout: {WORKTREE_PATH}
    Write to: /tmp/${SLUG}-review-iter${iteration}-conventions.md

  Agent B (model=sonnet): Correctness specialist  
    Read: ${SPECIALISTS_DIR}/correctness-specialist.md
    Context: /tmp/${SLUG}-review-context.md
    Repo checkout: {WORKTREE_PATH}
    Write to: /tmp/${SLUG}-review-iter${iteration}-correctness.md

  Agent C (model=haiku): Test specialist
    Read: ${SPECIALISTS_DIR}/test-specialist.md
    Context: /tmp/${SLUG}-review-context.md
    Repo checkout: {WORKTREE_PATH}
    Write to: /tmp/${SLUG}-review-iter${iteration}-tests.md

  Agent D (model=haiku): Dead-code specialist
    Read: ${SPECIALISTS_DIR}/deadcode-specialist.md
    Context: /tmp/${SLUG}-review-context.md
    Repo checkout: {WORKTREE_PATH}
    Write to: /tmp/${SLUG}-review-iter${iteration}-deadcode.md

  # 7c. Synthesize
  Read all 4 outputs. Semantic dedup, renumber, severity calibrate.
  Write unified review to /tmp/${SLUG}-review-iter${iteration}-unified.md

  # 7d. Count findings by severity
  blocking = count "blocking" findings
  suggestions = count "suggestion" findings
  nits = count "nit" findings
  actionable = blocking + suggestions

  # 7e. Check stopping conditions
  if actionable == 0:
    → "Only nits remain. Review complete."
    break

  if actionable >= prev_actionable:
    → "Finding count not decreasing. Diminishing returns. Stopping."
    break

  prev_actionable = actionable

  # 7f. Fix findings
  For each blocking and suggestion finding:
    Apply the fix in the worktree code.
    If unclear or requires domain knowledge, skip with a note.

  # 7g. Commit + push
  git add -A
  git commit -m "{conventionPrefix}: address review iteration ${iteration} findings"
  git push origin {BRANCH} --force-with-lease

  iteration++
```

### Phase 8: Pre-PR Quality Gate

Run these checks (commands from recon report):

1. **Build**: `{buildCommand}` — must pass
2. **Tests**: `{testCommand}` — must pass
3. **Lint**: `{lintCommand}` — must pass (if available)
4. **Diff review**: Scan `git diff upstream/{defaultBranch}...HEAD` for:
   - Secrets (API keys, tokens, passwords)
   - Debug code (console.log, fmt.Println, TODO/FIXME from the agent)
   - Accidental files (.env, node_modules, build artifacts)
5. **Commit hygiene**: Verify commit messages match repo conventions

If any gate fails, fix it, commit, push, re-run the gate.

### Phase 9: Create Upstream PR (ASK FOR PERMISSION HERE, NEVER PROCEED WITHOUT USER PERMISSION)

0. **Rate-limit check** — before anything else:
   ```bash
   TODAY=$(date -u +%Y-%m-%d)
   LIMIT=$(jq -r '.config.max_prs_per_day // 2' ${RECON_DIR}/contributions.json)
   TODAY_COUNT=$(jq -r --arg today "${TODAY}" '.daily_log[$today].prs_created // [] | length' ${RECON_DIR}/contributions.json)
   if [ "${TODAY_COUNT}" -ge "${LIMIT}" ]; then
     echo "RATE LIMIT: Already created ${TODAY_COUNT} PRs today (limit: ${LIMIT}). STOP and report to user."
     exit 1
   fi
   ```
   If the rate limit is reached, **STOP**. Do NOT proceed with PR creation. Report to user.

1. **Re-read recon**: `${RECON_DIR}/recon-report.md` — verify CLA, PR template, conventions
2. **Check for PR template**: `gh api repos/{repo}/contents/.github/PULL_REQUEST_TEMPLATE.md`
3. **Generate PR title**: Follow repo's convention (e.g., `Area: Description` for grafana, imperative for rust)
4. **Generate PR body**: Fill in PR template if one exists. Include:
   - What the PR does and why (1-3 sentences)
   - `Closes #{issueNumber}` or `Fixes #{issueNumber}`
   - Test plan (what was verified)
   - Write like a human — contractions, short sentences, no LLM tells
   - No backtick-heavy formatting in prose
5. **Create PR**:
   ```bash
   gh pr create -R {repo} \
     --head "{forkOwner}:{BRANCH}" \
     --base "{defaultBranch}" \
     --title "{title}" \
     --body "$(cat <<'EOF'
   {body}
   EOF
   )"
   ```
6. **Do NOT** manually assign reviewers — let triagebot/CODEOWNERS handle it
7. **Record PR in contributions.json**:
   ```bash
   NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   TODAY=$(date -u +%Y-%m-%d)
   cat ${RECON_DIR}/contributions.json | jq \
     --arg inum "${issueNumber}" --arg pnum "${prNumber}" --arg now "${NOW}" --arg today "${TODAY}" \
     --arg branch "${BRANCH}" --arg title "{prTitle}" --arg url "{prUrl}" \
     '.issues[$inum].status = "submitted" | .issues[$inum].pr_number = ($pnum|tonumber) | .issues[$inum].updated_at = $now |
      .prs[$pnum] = {"number":($pnum|tonumber),"issue_number":($inum|tonumber),"branch":$branch,"title":$title,"status":"open","created_at":$now,"updated_at":$now,"merged_at":null,"closed_at":null,"url":$url} |
      .daily_log[$today].prs_created += [($pnum|tonumber)]' \
     > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ${RECON_DIR}/contributions.json
   ```

### Phase 10: Post-Creation + Report

1. Check bot comments immediately:
   ```bash
   gh api repos/{repo}/issues/{prNumber}/comments --jq '.[].body' | head -30
   ```
2. If CLA bot asks for signature → warn the user
3. If bots flag issues → fix in a single amend + `--force-with-lease` push
4. Update PR lifecycle for all tracked open PRs:
   ```bash
   for PR_NUM in $(jq -r '.prs | to_entries[] | select(.value.status=="open") | .key' ${RECON_DIR}/contributions.json); do
     STATE=$(gh api "repos/{repo}/pulls/${PR_NUM}" --jq '.state')
     MERGED=$(gh api "repos/{repo}/pulls/${PR_NUM}" --jq '.merged_at')
     NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
     if [ "${MERGED}" != "null" ] && [ -n "${MERGED}" ]; then
       cat ${RECON_DIR}/contributions.json | jq --arg p "${PR_NUM}" --arg m "${MERGED}" --arg n "${NOW}" \
         '.prs[$p].status="merged"|.prs[$p].merged_at=$m|.prs[$p].updated_at=$n' \
         > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ${RECON_DIR}/contributions.json
     elif [ "${STATE}" = "closed" ]; then
       cat ${RECON_DIR}/contributions.json | jq --arg p "${PR_NUM}" --arg n "${NOW}" \
         '.prs[$p].status="closed"|.prs[$p].closed_at=$n|.prs[$p].updated_at=$n' \
         > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ${RECON_DIR}/contributions.json
     fi
   done
   ```
5. Report:
   - PR URL
   - Issue resolved: #{issueNumber}
   - Review iterations completed: {iteration}
   - Findings fixed: {total fixed count}
   - Remaining nits: {nit count} (acceptable)

## Anti-Patterns

- **DO NOT** push to upstream — always push to fork
- **DO NOT** use `--force` — always `--force-with-lease`
- **DO NOT** manually `r?` reviewers unless recon confirms it's expected
- **DO NOT** include "Generated with Claude Code" unless repo patterns show AI disclosure is expected
- **DO NOT** skip re-reading the recon report before creating the PR
- **DO NOT** exceed 3 review iterations — cap and move on
- **DO NOT** spawn more than 4 specialist agents at once (concurrency limit)
- **DO NOT** work on main branch — always use a worktree
- **DO NOT** investigate an issue without checking contributions.json first — the grafana#120918 incident wasted a full session on an already-fixed issue
- **DO NOT** create a PR if the daily rate limit has been reached — respect `config.max_prs_per_day`
- **DO NOT** skip recording skipped issues — even failed attempts must be tracked to prevent re-investigation
- **DO NOT** implement a fix without checking if it's already fixed on main — search for merged PRs with related keywords
- **DO NOT** start coding without first commenting on the issue to claim it — silent PRs get rejected
- **DO NOT** work on issues assigned to someone else — not even "part of the work"
