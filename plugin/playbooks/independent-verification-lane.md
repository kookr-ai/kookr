---
name: Independent Verification Lane
description: Clean-checkout full-suite execution signal on merged SHAs, isolated from the authoring task. A red run files an incident routed through the close-out gate. Flag/incident only — never merges or loosens (issue #1847).
repo-tags: [github]
tags: [workflow, monitoring, incident, scheduled, verification]
deliveryPreAuthorized: true
autoCloseOnSignal: true
parameters:
  - name: repo
    description: "GitHub repo (owner/name). Blank → current git remote."
    required: false
    type: select
    source: tracked-projects
  - name: cadence
    description: "per-merge (verify one SHA) or rolling-sweep (walk a bounded window, file on first red)."
    required: false
    default: "rolling-sweep"
    type: select
    options:
      - { label: "Rolling sweep (bounded window)", value: "rolling-sweep" }
      - { label: "Per-merge (single SHA)", value: "per-merge" }
  - name: sha
    description: "per-merge only: the merged SHA to verify."
    required: false
    default: ""
  - name: limit
    description: "rolling-sweep only: max SHAs per tick (bounded 1..20)."
    required: false
    default: "5"
  - name: suite
    description: "Full-suite command run in the clean checkout."
    required: false
    default: "pnpm test"
  - name: dryRun
    description: "true → print the plan; never clone, run, or file."
    required: false
    default: "false"
    type: select
    options:
      - { label: "Live", value: "false" }
      - { label: "Dry run (print plan only)", value: "true" }
---

# Independent Verification Lane

You are a **short-lived, independent execution signal** for merged commits.

After GitHub Actions was disabled (lucy#1890, "local verification is the merge
gate"), the merge gate degraded to **100% same-context local verification** —
the authoring agent's own environment validating the authoring agent's own work,
with **zero independent execution signal**. Acceptable as an emergency bridge;
dangerous as steady state, because a bad merge that passes locally but is
genuinely broken stays invisible until it reaches prod.

This lane restores an independent execution signal **without** re-enabling GH
Actions or re-litigating the #1890 decision: a fresh-context worker clean-clones
a merged SHA, installs from scratch, and runs the full suite in an environment
distinct from the authoring task. It is **additive and tightening-only**.

**Companion, not replacement.** This lane *executes*; `independent-merge-review`
(plugin/skills) *reviews a diff*; local verification runs same-context. All three
compose. This lane does not re-enable CI and does not gate the merge itself — it
watches what already merged.

## §0 Hard rules

- **Flag/incident only.** The lane can open an `incident`-labeled issue or a
  flag comment. It can **never** approve, merge, close an issue, or loosen a
  gate. This is enforced in code (`assertTighteningOnlyAction`,
  `LANE_CAPABILITIES` in `src/core/independent-verification-lane.ts`).
- **Bounded cost.** Never re-create the resource pressure that motivated #1890.
  `rolling-sweep` is capped at `{{limit}}` (hard max 20) and stops at the first
  red; per-merge verifies exactly one SHA. Green SHAs are recorded so they are
  never re-run.
- **Red files an incident — never silently passes.** A genuine suite failure
  (tests ran and failed) opens an `incident`-labeled issue routed through the
  close-out gate (#1750/#1802).
- **Infra flakes do not cry wolf.** A clone/install failure *before* tests run
  is an `error`, not a red: no incident is filed and the SHA is retried next
  tick.
- **Isolation is the point.** The clone lives in a fresh temp dir, installs from
  scratch (`pnpm install --frozen-lockfile`), and never reuses the authoring
  task's `node_modules`, caches, or worktree.
- `{{dryRun}}` = `true` → print the plan; do not clone, run, or file.

## Documented contract

Pure decision logic: `src/core/independent-verification-lane.ts`. CLI (clone /
install / test / gh I/O): `scripts/independent-verification-lane.ts`.

| Run status | Meaning | Action |
| --- | --- | --- |
| `green` | Suite passed on the clean checkout | record SHA as verified |
| `red` | Suite ran and failed | **file `incident` issue** (dedup by SHA) |
| `error` | Clone/install failed before tests | log; retry next tick; **no incident** |

Exit codes: `0` all green / nothing to do · `3` red (incident filed) · `4` infra
error only · `1` usage/runtime.

## Phase 0 — Resolve targets

```bash
REPO="{{repo}}"
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
fi
CADENCE="{{cadence}}"
SUITE="{{suite}}"
LIMIT="{{limit}}"
SHA="{{sha}}"
DRY="{{dryRun}}"
```

## Phase 1 — Run the lane

The checked-in CLI does the clone / install / full-suite run and files the
incident. Prefer it over ad-hoc shell so the dedup state and receipts stay
consistent.

Rolling sweep (default):

```bash
node --import tsx scripts/independent-verification-lane.ts --sweep \
  --repo "$REPO" --limit "$LIMIT" --suite "$SUITE" --json \
  $( [ "$DRY" = "true" ] && echo --dry-run )
```

Per-merge:

```bash
node --import tsx scripts/independent-verification-lane.ts \
  --sha "$SHA" --repo "$REPO" --suite "$SUITE" --json \
  $( [ "$DRY" = "true" ] && echo --dry-run )
```

Interpret the exit code:

| Exit | Meaning | Next |
| --- | --- | --- |
| `0` | all green / nothing to do | Phase 3 |
| `3` | **RED** — incident filed | Phase 2 confirm, then Phase 3 |
| `4` | infra error only | log; the SHA retries next tick |
| `1` | usage / runtime | fix invocation and re-run |

## Phase 2 — Confirm the incident (on exit 3 only)

The CLI files the incident and dedups by SHA (`iv-lane:<shortsha>`). Confirm it
landed and is `incident`-labeled so the close-out gate owns its lifecycle:

```bash
gh issue list --repo "$REPO" --state open --search '"iv-lane:" in:body' \
  --json number,title,labels
```

Do **not** close it here. It stays `fix-merged-unverified` under the close-out
gate until an independent green re-run of the suite converges the end state.

## Phase 3 — Complete

Print a one-line summary (the CLI already does when `--json` is omitted):

```
independent-verification-lane: repo=$REPO cadence=$CADENCE scanned=<n> green=<n> red=<n> error=<n> incidents=<n>
```

Then `kookr signal completion-ready` (after the post-task lesson decision if this
session launched tools).

## Scheduling

Cheap enough to run per-merge for small suites; otherwise schedule the rolling
sweep (e.g. every 30–60 min). It is silent when there is nothing un-verified to
check, and self-bounds via `{{limit}}` + first-red stop.

## Anti-patterns

- **Don't** let the lane merge, approve, close, or loosen anything — it is
  flag/incident only by construction.
- **Don't** file an incident for a clone/install failure — that is an `error`,
  not a red.
- **Don't** re-run green SHAs — the processed-state file dedups them.
- **Don't** reuse the authoring task's checkout, `node_modules`, or caches —
  the isolation is the whole point of the signal.
- **Don't** re-enable GH Actions or re-open the #1890 decision from this
  playbook; this lane is the additive check that sits on top of local
  verification.
