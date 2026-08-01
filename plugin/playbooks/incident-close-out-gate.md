---
name: Incident Close-Out Gate
description: Verify real-world end-state before closing incident-labeled issues after a fix PR merges. Merge is inventory, not resolution (issue #1750).
repo-tags: [github]
tags: [workflow, monitoring, incident, scheduled]
deliveryPreAuthorized: true
autoCloseOnSignal: true
parameters:
  - name: repo
    description: "GitHub repo (owner/name). Blank → current git remote."
    required: false
    type: select
    source: tracked-projects
  - name: incidentLabels
    description: "Comma-separated incident labels (case-insensitive)."
    required: false
    default: "incident,p0,prod-incident"
  - name: healthUrl
    description: "Serving health URL for deploy-SHA probes. Blank → $KOOKR_API_BASE_URL/api/health or http://127.0.0.1:4800/api/health."
    required: false
    default: ""
  - name: alertMinutes
    description: "Minutes a fix-merged-but-unverified incident may sit before a standing alert."
    required: false
    default: "30"
  - name: act
    description: "true → close verified-converged incidents with a receipt comment. false → classify + alert only."
    required: false
    default: "false"
    type: select
    options:
      - { label: "Detect only (alert, no close)", value: "false" }
      - { label: "Live (close when verified)", value: "true" }
  - name: dryRun
    description: "true → classify and print; never comment, close, or alert."
    required: false
    default: "false"
    type: select
    options:
      - { label: "Live", value: "false" }
      - { label: "Dry run (print only)", value: "true" }
---

# Incident Close-Out Gate

You are a **short-lived, cheap close-out gate** for incident-labeled issues.
The harness must not treat **PR merge** as **incident resolution**. A merged fix
is inventory until an end-state probe proves the real-world outcome the
incident described.

**Companion:** `implement-github-issue` uses `Refs #N` (not `Closes #N`) for
incident-labeled issues so GitHub merge cannot auto-close them. This playbook
is the verification + closure edge.

**Schedule (recommended):** every 15–30 minutes for repos that file incidents.
Silent when there is nothing to do.

## §0 Hard rules

- **Cheap only.** List open incident-labeled issues, find merged fix PRs, run
  the checked-in classifier. No deep reasoning, no improvement-portfolio filing.
- **Merge alone never closes.** Only `verified-converged` may close, and only
  when `{{act}}` is `true`.
- **Standing alert on stale unverified.** Exit code 3 / `staleUnverified: true`
  for longer than `{{alertMinutes}}` must surface as an operator-visible alert
  (task finding comment, Discord, or stdout that a schedule captures). Quiet
  ticks print a receipt and exit.
- **Probe the process that does the work** for deploy-stuck incidents: serving
  SHA from live health (`sha` / `gitSha` / `build.commitHash`), not the git
  worktree tip.
- `{{dryRun}}` = `true` → classify/print only.

## Documented states (explicit contract)

Pure classifier: `src/core/incident-close-out.ts`. CLI:
`scripts/incident-close-out-check.ts`.

| State | Meaning | Action |
| --- | --- | --- |
| `open-unfixed` | No fix PR yet | none |
| `fix-open` | Fix PR open, not merged | none |
| `fix-merged-unverified` | Fix merged, end-state not proven | watch; **alert if stale** |
| `verified-converged` | End-state holds | close with receipt when `act=true` |
| `re-escalated` | Verification failed after merge | alert / re-open deploy path |
| `not-incident` / `already-closed` | Gate N/A | none |

Default stale threshold: **30 minutes** (`{{alertMinutes}}`).

## Phase 0 — Resolve targets

```bash
REPO="{{repo}}"
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi
LABELS="{{incidentLabels}}"
HEALTH="{{healthUrl}}"
if [ -z "$HEALTH" ]; then
  HEALTH="${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}/api/health"
fi
ACT="{{act}}"
DRY="{{dryRun}}"
ALERT_MIN="{{alertMinutes}}"
STATE_DIR="${HOME}/.kookr/playbook-state/incident-close-out/${REPO//\//_}"
mkdir -p "$STATE_DIR"
```

## Phase 1 — List open incident-labeled issues

```bash
# GitHub OR label filter: build a search for each label.
QUERY=""
IFS=',' read -ra LABEL_ARR <<< "$LABELS"
for L in "${LABEL_ARR[@]}"; do
  L=$(echo "$L" | xargs)
  [ -z "$L" ] && continue
  if [ -z "$QUERY" ]; then QUERY="label:$L"; else QUERY="$QUERY OR label:$L"; fi
done

gh issue list --repo "$REPO" --state open --search "$QUERY" --limit 50 \
  --json number,title,labels,url > "$STATE_DIR/open-incidents.json"
```

If the list is empty, print `incident-close-out: no open incidents` and go to
Phase 4.

## Phase 2 — For each open incident, classify

For every issue `N` in `open-incidents.json`:

1. Find referencing PRs (merged + open):

```bash
N=<issue-number>
gh pr list --repo "$REPO" --state merged --search "$N" --limit 20 \
  --json number,title,mergedAt,body,url > "$STATE_DIR/pr-merged-$N.json"
gh pr list --repo "$REPO" --state open --search "$N" --limit 20 \
  --json number,title,body,url > "$STATE_DIR/pr-open-$N.json"
```

Treat a PR as a *fix* PR when its body/title references `#N` (or the issue URL)
and looks like a fix (merged PR that mentions the issue is enough for this gate;
prefer PRs that used `Refs #N` / `Closes #N` / `Fixes #N`).

2. Build evidence JSON and run the classifier. For **deploy-stuck** incidents
   (body/title mentions `GIT_SHA`, deploy, serving SHA, prod runtime stuck),
   include a health probe + `origin/main` target:

```bash
TARGET_SHA=$(git -C "$(gh repo view "$REPO" --json url -q .url | sed 's|.*github.com/||;s|.git||')" \
  rev-parse origin/main 2>/dev/null || git rev-parse origin/main 2>/dev/null || true)

# Prefer the repo checkout when available; otherwise skip ancestry and use
# exact SHA compare via the classifier defaults.
node --import tsx scripts/incident-close-out-check.ts --json \
  --issue-state open \
  --labels "$(jq -r '[.labels[].name] | join(",")' <<<"$ISSUE_JSON")" \
  --merged-fix \   # only if a merged fix PR exists
  --fix-merged-at "$MERGED_AT" \
  --health-url "$HEALTH" \
  --target-sha "$TARGET_SHA" \
  --issue-number "$N" \
  --fix-prs "$FIX_PR_CSV" \
  --alert-minutes "$ALERT_MIN" \
  > "$STATE_DIR/class-$N.json"
```

For non-deploy incidents without a clear probe, classify **without**
verification so the state stays `fix-merged-unverified` (and goes **stale**
into a standing alert) rather than false-closing.

Interpret exit codes:

| Exit | Meaning | Next |
| --- | --- | --- |
| `0` | ok / converged / not applicable | Phase 3 close if `mayClose` |
| `2` | unverified within grace | log; no alert |
| `3` | **STALE** unverified | Phase 2b standing alert |
| `4` | re-escalated | Phase 2b standing alert |
| `1` | probe failure | log; do not close |

## Phase 2b — Standing alert (stale or re-escalated only)

When exit is 3 or 4 (and `{{dryRun}}` is false), surface **one** alert per
issue per tick — do not spam:

- Prefer a short comment on the incident issue if the last close-out comment is
  older than the alert window:

```
**Incident close-out gate — standing alert**

- State: `<state>`
- Message: <classification.message>
- Fix PR(s): <list>
- Verification: <receipt or "not probed">
- Action: verify the real end-state (for deploy-stuck: serving SHA must include main) then re-run this gate with act=true, or re-escalate the fix path.
```

- If a schedule/Discord channel is wired for this repo, post the same one-liner
  there. Otherwise the issue comment **is** the standing alert surface.

## Phase 3 — Close when verified (only if act=true)

When `classification.mayClose === true` and `{{act}}` is `true` and not dry-run:

```bash
RECEIPT=$(jq -r '.closeReceipt // empty' "$STATE_DIR/class-$N.json")
if [ -n "$RECEIPT" ]; then
  gh issue close "$N" --repo "$REPO" --comment "$RECEIPT"
fi
```

Never close without a receipt. Never close on exit 2/3/4.

## Phase 4 — Complete

Print a one-line summary:

```
incident-close-out: repo=$REPO scanned=<n> stale=<n> closed=<n> reEscalated=<n>
```

Then `kookr signal completion-ready` (after the post-task lesson decision if
this session launched tools).

## Anti-patterns

- **Don't** put `Closes #N` on a fix PR for an incident-labeled issue — use
  `Refs #N` (enforced in `implement-github-issue`).
- **Don't** close an incident because CI is green or the PR merged.
- **Don't** deep-reason or file portfolio issues from this playbook.
- **Don't** probe a git worktree tip as "deployed" — probe the live process
  health endpoint.
