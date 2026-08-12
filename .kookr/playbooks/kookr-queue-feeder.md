---
name: kookr-queue-feeder
description: >
  When Kookr has idle capacity and an empty queue, shred one product umbrella
  into spawnable leaf issues — or secondary-emit open unassigned idea-scout /
  ready issues when product leaves are exhausted (#2044). Optionally spawn
  implementers. Fills the idle_capacity gap left when reflection ideas already
  landed.
version: 4
schedule:
  defaultCron: "7,37 * * * *"
parameters:
  freeThreshold:
    type: number
    default: 3
  emit:
    type: boolean
    default: true
  spawnLeaves:
    type: boolean
    default: true
    description: After filing leaves (or secondary emit), spawn implement GitHub Issue tasks (capped).
  maxSpawns:
    type: number
    default: 3
  dryRun:
    type: boolean
    default: false
  authorLeaves:
    type: boolean
    default: true
    description: >
      When the selected product umbrella has needsAuthoring (no curated plan in
      kookr), author 3–5 leaves from the umbrella body, prefer landing them in
      kookr CURATED_LEAF_PLANS, and emit/spawn this run. Never invent for harness-only umbrellas.
---

# Kookr Queue Feeder (idle-capacity shredder)

You fill **idle task slots** by turning open **product umbrellas** into shreddable leaf issues, or — when product leaves are exhausted — by pulling open **unassigned idea-scout / ready** issues into the implement set (#2044). You optionally spawn implementers. You do **not** implement product code yourself.

## §0 Hard rules

- Read-only for product repos except: `gh issue create` for leaves (when emit=true and action=shred) and `kookr-spawn` for implementers (when spawnLeaves=true).
- **Never** merge, deploy, force-push, or edit product source (Lucy). Kookr harness changes that only extend `CURATED_LEAF_PLANS` / product-metric ranking are allowed when `authorLeaves=true` and needsAuthoring blocked emit — use a fresh kookr worktree, PR, and Jean-owned merge path.
- Prefer **product-metric-blocking** umbrellas (SEC anchors, acquisition, detection metrics) over harness polish.
- One umbrella per run for shred. Cap secondary ready-issue emit and spawns at `maxSpawns` (CLI secondary cap defaults to 3).
- Always use `--idempotency-key` on spawns: `queue-feeder-<repo-slug>-<issue>-$(date -u +%Y%m%d%H)`.
- If capacity free < freeThreshold or pendingQueueDepth > 0: log and exit (no emit).
- `dryRun=true` → plan only, no issue create, no spawn.
- **Do not re-file** a leaf title that already exists as an open **or closed** issue in the same repo (idempotent shred / invent). The CLI now enforces this at plan time (#2145): before returning `action=shred` it refetches existing titles (open **and** closed) for the selected umbrella and, when **every** curated leaf title already exists, excludes that umbrella and re-evaluates — advancing to the next-ranked umbrella, `invent-product-wave` (an exhausted **product** umbrella refills the belt), or `skip-invent`. A partially-exhausted plan still shreds and files only the genuinely-new titles.
- When counting children for `openChildrenCount`, count **only OPEN** non-umbrella children whose body contains `Leaf of umbrella …#N` (or the queue-feeder backref). **Closed children must not be counted** (#2069) — they do not permanently block re-author. The CLI skips shred/invent under an umbrella only when `openChildrenCount > 0` (use those open leaves first).
- **Never auto-claim** issues assigned to someone else. Secondary emit only considers unassigned ready issues.
- Trust CLI `decision.action`: `shred` | `invent-product-wave` | `emit-secondary` | `skip-invent` | `not-triggered`. Do not free-form invent when the CLI says `skip-invent`. When `invent-product-wave`, author 1–`inventLeafCap` product-metric leaves under the selected umbrella only.

## Phase 1 — Capacity

```bash
CAP=$(curl -sS --max-time 8 http://127.0.0.1:4800/api/health)
FREE=$(echo "$CAP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("capacity",{}).get("free",0))')
PENDING=$(echo "$CAP" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("capacity",{}).get("pendingQueueDepth",0))')
```

If `FREE < freeThreshold` or `PENDING > 0`: write a one-line ledger note under `~/.kookr/playbook-state/queue-feeder/` and `kookr signal completion-ready`.

## Phase 2 — Candidate umbrellas + ready issues

List open umbrella issues on `jeanibarz/lucy` (and optionally `kookr-ai/kookr`):

```bash
gh issue list -R jeanibarz/lucy --label umbrella --state open --limit 20 \
  --json number,title,labels,assignees
```

For each candidate, count **OPEN** children only whose body mentions `Leaf of umbrella …#N` or the queue-feeder backref. Do **not** include closed children in `openChildrenCount` (#2069). Prefer candidates with `openChildrenCount == 0` and product-facing titles (SEC, anchor, acquisition, reaction, detection).

When building the snapshot, set `priority` higher for product-facing titles (acquisition, product-surface-ux / control-room, detection, metric, SEC, reaction) than harness/docs/reflection umbrellas so ranking does not pick idea-scout residuals first. When `pipelineStarvation[repo].consecutiveBlockedEmpty ≥ 3`, also pass `consecutiveBlockedEmpty` in the snapshot so the CLI suppresses micro-hardening secondary emit while product invent runway remains (#2358).

### Ready issues (secondary path — #2044)

Also gather open, unassigned idea-scout / ready-labeled issues that implementers can take immediately. Include kookr and lucy as relevant:

```bash
# idea-scout / ready — open, any assignee field (CLI filters assigned)
gh issue list -R kookr-ai/kookr --label idea-scout --state open --limit 20 \
  --json number,title,labels,assignees
gh issue list -R jeanibarz/lucy --label idea-scout --state open --limit 20 \
  --json number,title,labels,assignees
```

Mark `alreadyEmitted: true` for refs that already appear in recent ledger rows with `action=emit-secondary` (idempotent re-fires). Count open product-metric leaf issues for `openProductMetricIssues` (0 when the belt is empty of product leaves).

Build JSON:

```json
{
  "capacity": { "free": FREE, "pendingQueueDepth": PENDING },
  "openProductMetricIssues": 0,
  "candidates": [
    { "repo": "jeanibarz/lucy", "number": N, "title": "...", "labels": [], "openChildrenCount": C, "priority": P }
  ],
  "readyIssues": [
    { "repo": "kookr-ai/kookr", "number": 2032, "title": "...", "labels": ["idea-scout"], "assignees": [] }
  ]
}
```

## Phase 3 — Plan (+ emit)

```bash
kookr queue-feeder plan --input /tmp/qf-input.json --free "$FREE" --pending "$PENDING" \
  $( [ "{{emit}}" = "true" ] && [ "{{dryRun}}" != "true" ] && echo --emit ) --json
```

Read `decision.action` from the JSON envelope:

| `decision.action` | What to do |
|---|---|
| `not-triggered` | Capacity gate closed — report and complete. |
| `shred` | Primary path: leaf issues filed (if `--emit`) from the selected umbrella plan. On the happy path the plan contains ≥1 genuinely-new title — fully-exhausted curated plans are excluded upstream (#2145); a gh failure while verifying titles fails open to the un-verified plan and, under `--emit`, exits 4 before any implementer spawns. Continue to Phase 4 for spawned implementers. |
| `invent-product-wave` | Product belt empty (`openProductMetricIssues=0`); selected product umbrella has no open children and no curated plan. **Author 1–`decision.inventLeafCap` (default 3) product-metric leaves** under that umbrella (#2069). Prefer over idea-scout secondary. Ledger `action=invent-product-wave` + umbrella ref + leaf titles. |
| `emit-secondary` | Product leaves empty and invent not authorized; CLI selected `decision.secondaryEmitted` ready issues (source=`idea-scout`). **Do not invent.** Spawn implementers for those refs (Phase 4). Never re-assign assignees. |
| `skip-invent` | No shreddable plan, no invent-product-wave, and no safe ready issues — report and complete. **Do not invent** leaves for harness/docs residuals. |

### invent-product-wave / needsAuthoring + authorLeaves (#2069)

If the plan returns `action=invent-product-wave` (or legacy `skip-invent` with `selected.needsAuthoring: true` **and** the selected umbrella is product-metric / product-facing) **and** `authorLeaves=true`:

1. Read the umbrella issue body. List Children / acceptance bullets.
2. Drop work already open **or** closed as GitHub issues (by number or matching title). Keep residual acceptance gaps for the **next** product leaf wave.
3. Author **1–`inventLeafCap`** (default 1–3) leaf specs: `title`, one-sentence `goal`, ≥2 testable acceptance criteria, optional file/test hints, labels (`product-metric` and domain labels). Prefer product-metric leaves over Discord slash / docs residual.
4. **Durable path (preferred):** in a **fresh kookr worktree** off `origin/main`, add the plan to `CURATED_LEAF_PLANS` in `src/core/umbrella-decomposer.ts`, extend tests, push, open PR, merge (Jean-owned default). If kookr-prod is still behind, still **emit leaves this run** via `gh issue create` so idle capacity is not wasted waiting for deploy.
5. **Immediate path (always when emit=true):** create the leaf issues with `Leaf of umbrella jeanibarz/lucy#N — emitted by the queue-feeder` backref (same body shape as `buildLeafIssueBody`), apply labels (create missing labels once via `gh api` if needed).
6. Append ledger row `action=invent-product-wave` with umbrella ref + leaf titles when the CLI did not already.
7. Continue to Phase 4 for newly created leaves.
8. Never invent leaf plans for harness-only umbrellas even when `authorLeaves=true`. Open children under a product umbrella mean **use those leaves** — do not invent under that umbrella.

If labels fail on create: create missing labels via `gh api -X POST repos/.../labels` once, then retry emit once.

## Phase 4 — Spawn implementers (optional)

Targets, in order:

1. Newly shredded leaf issue URLs from `action=shred` (if any).
2. `decision.secondaryEmitted` refs from `action=emit-secondary` (idea-scout / ready).
3. Open ownerless leaves of the selected umbrella (max `maxSpawns` total).

For each target (max `maxSpawns`):

```bash
# Derive REPO / NUM / CWD from the ref (kookr-ai/kookr → $HOME/git/kookr, jeanibarz/lucy → $HOME/git/lucy)
node "$HOME/git/kookr/bin/kookr-spawn.js" \
  --cwd "$CWD" \
  --prompt-file "$PROMPT" \
  --criteria "Issue #<n> in $REPO has an open PR implementing it" \
  --idempotency-key "queue-feeder-$(echo $REPO | tr / -)-${NUM}-$(date -u +%Y%m%d%H)" \
  --auto-close-on-signal
```

Prompt: Implement GitHub issue #N in REPO end-to-end following the Implement GitHub Issue playbook — fresh worktree off origin/main, tests, PR that closes #N. Run fully autonomously: do not stop to ask, do not call AskUserQuestion. If ambiguous, take the safe default and note it in the PR body.

Skip targets that already have an open PR, assignee, or running task.

## Phase 5 — Record + complete

Append one line to `~/.kookr/playbook-state/queue-feeder/decisions.jsonl` if the CLI did not (or summarize). Prefer the CLI ledger row (`action`, `source`, `secondaryEmitted`, `emitted`). One-line receipt: free, action, selected umbrella, emitted N, spawned M. Then `kookr signal completion-ready`.
