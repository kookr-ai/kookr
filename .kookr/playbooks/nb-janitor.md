---
name: Agent-Notebook Janitor Sweep
description: Run the SHIPPED read-only agent-notebook janitor (examples/nb-janitor.mjs) over NB_DIR on a weekly schedule and surface its cross-notebook hygiene report to the operator. Strictly read-only and fail-open — it never edits a notebook and a janitor error never fails the task.
tags: [maintenance, memory, read-only]
cwd: $HOME/git/kookr
parameters:
  - name: toolRepo
    description: "The agent-notebook source repo the shipped janitor is extracted from (owner/repo). The janitor lives in the source tree's examples/ and is NOT in the published npm tarball (dist/ only), so it is resolved from a clone of this repo, not node_modules."
    required: false
    default: "jeanibarz/agent-notebook"
    type: text
  - name: nbDir
    description: "The notebooks directory to scan. Blank falls back to $NB_DIR, then to ~/.kookr/notebooks (the kookr default pinned by bin/nb.js)."
    required: false
    default: ""
    type: text
  - name: days
    description: "History window (days) for the janitor's volume & silence section."
    required: false
    default: "30"
    type: text
  - name: sim
    description: "Lesson-similarity threshold 0..1 for the duplicate-lessons section."
    required: false
    default: "0.6"
    type: text
checklist:
  - Resolved the SHIPPED janitor from toolRepo origin/main (clone or shallow fetch) WITHOUT re-implementing it
  - Ran it read-only over NB_DIR with --json and as a human report; never ran a mutating nb verb and never edited a notebook
  - A janitor failure (missing clone, crash, non-zero exit) was swallowed fail-open and reported as "janitor unavailable", not raised as a task failure
  - The full human report plus a one-line headline (clean, or N suggestions across the five sections) was placed in the completion summary where the operator sees it
  - The hot nb path (bin/nb.js and any `nb` call) was not touched
---

## Objective

Give the agent-notebook store a **periodic, low-noise hygiene pass**. `nb stats`
reports how *one* notebook is doing right now; the shipped janitor
(`examples/nb-janitor.mjs`) takes the cross-notebook view `nb stats` cannot —
eviction loss, near-duplicate shelf names, paraphrase-duplicate lessons, volume
& silence, and shelf co-access — and prints each finding with a concrete
suggested `nb` command. Today that pass only happens when an operator invokes
the janitor by hand (issue #3471). This playbook runs it on a weekly schedule
and delivers the human report to the operator.

**This job makes no changes.** It is strictly read-only: it runs the janitor
(which only READS notebooks, the usage log, and git history) and surfaces the
output. It never edits a notebook and never runs a mutating `nb` verb. Acting on
the janitor's suggestions (`nb merge` / consolidating near-duplicate shelves) is
a reviewed, human-invoked follow-up — see **Scope** below.

## Context — tools you rely on

- The **shipped janitor**: `examples/nb-janitor.mjs` in `{{toolRepo}}` — a
  read-only cross-notebook report:
  `NB_DIR=<dir> node nb-janitor.mjs [--json] [--days N] [--sim 0.6]`.
  **Run this; do NOT re-implement its analysis by hand** (a hand-rolled version
  invents alarms the real tool calls normal — e.g. a full shelf is the *normal*
  state, not a problem). It is NOT in the published npm tarball (which ships only
  `dist/`), so it is resolved from a clone of `{{toolRepo}}`, mirroring the
  resolution the `Agent-Notebook Reflection & Improvement` playbook already uses.
- `NB_DIR` — the notebooks directory. kookr pins the default to
  `~/.kookr/notebooks` (see `bin/nb.js`); the package default is
  `~/.agent-notebook/notebooks`. Always pass `NB_DIR` explicitly so the janitor
  scans the kookr store.
- `nb path` — prints the live `NB_DIR` if you need to confirm it.

## Steps

### 1. Resolve the shipped janitor (fail-open)

Extract `examples/nb-janitor.mjs` from `{{toolRepo}}` `origin/main` into a
scratch dir. Read it from git rather than the working tree, which can be checked
out to a branch that lacks `examples/`. Everything lands in `$WORK` so nothing
touches the checkout:

```bash
WORK="$(mktemp -d)"                               # scratch dir; cleaned up in step 3
JANITOR="$WORK/nb-janitor.mjs"                    # fixed name (no mktemp -t suffix quirk)
REPO="$HOME/git/$(basename '{{toolRepo}}')"       # e.g. ~/git/agent-notebook
if [ -d "$REPO/.git" ] \
     && git -C "$REPO" fetch --quiet origin main \
     && git -C "$REPO" show origin/main:examples/nb-janitor.mjs > "$JANITOR"; then
  :                                               # resolved from the local clone
elif git clone --quiet --depth 1 "https://github.com/{{toolRepo}}" "$WORK/clone" \
     && cp "$WORK/clone/examples/nb-janitor.mjs" "$JANITOR"; then
  :                                               # resolved via a shallow clone
fi

# Detect failure EXPLICITLY — do NOT trust exit codes. A failed fetch/clone
# leaves $JANITOR empty (0 bytes), and `node <empty>.mjs` exits 0, which would
# otherwise be misreported as a clean store. A non-empty file is the only
# success signal.
if [ ! -s "$JANITOR" ]; then
  echo "nb-janitor unavailable: could not resolve examples/nb-janitor.mjs from {{toolRepo}} origin/main"
  rm -rf "$WORK"
  # Read-only hygiene job — a miss is a no-op the next weekly run retries, never
  # a breakage. Put the one line above in the completion summary and stop here.
fi
```

A local clone at `~/git/$(basename {{toolRepo}})` is the expected prerequisite;
the shallow-clone fallback keeps an unattended run self-sufficient when none
exists. If **every** path fails (no clone, no network, file moved upstream), the
`[ -s ]` guard reports `nb-janitor unavailable: <reason>` and stops — the task
still completes successfully.

### 2. Resolve NB_DIR

Use `{{nbDir}}` if set; else `$NB_DIR`; else `~/.kookr/notebooks`. Confirm with
`nb path` when unsure.

### 3. Run the janitor (read-only)

Only when `$JANITOR` resolved (step 1). Write all output into `$WORK` so nothing
lands in the checkout:

```bash
NB_DIR="<resolved>" node "$JANITOR" --days {{days}} --sim {{sim}} --json > "$WORK/janitor.json"
NB_DIR="<resolved>" node "$JANITOR" --days {{days}} --sim {{sim}}        > "$WORK/janitor.txt"
rm -rf "$WORK"   # once both are captured into the summary
```

The janitor only reads — there is no mutating mode. Treat a crash, a non-zero
exit, OR an empty/invalid `janitor.json` exactly like step 1's unavailable case
(fail-open). `$WORK` is a temp dir, so the janitor writes nothing to the
repository.

### 4. Surface the report to the operator

Put **both** of these in the completion summary (the operator-facing channel
for a scheduled task — it reaches the digest):

- **A one-line headline** derived from `janitor.json` — "clean" when every
  actionable list is empty, otherwise a count of the janitor's *suggestions*:
  `lostLessons` + `shelfDups` + `lessonDups` + `coAccess.highPairs`. These are
  exactly the findings the janitor pairs with a concrete `→ nb …` command. The
  other fields are informational context — surfaced in the full report but NOT
  counted, because the janitor offers no command for them: `fullShelves` (a full
  shelf is normal, by design), and `silentShelves` / `coAccess.isolated`
  (observations that hint "look here", not actions). Example:
  `nb-janitor: 3 suggestions (2 co-access, 1 near-dup shelf)`.
- **The full human report** (the text form from step 3), so the operator can
  read the concrete suggested `nb` commands without parsing JSON.

## Scope — read-only by design

This scheduled job **surfaces** hygiene findings; it does not act on them.
Consolidating near-duplicate shelves (`nb merge`) or splitting a shelf is a
destructive-under-review edit, which belongs to the human-invoked
`Agent-Notebook Reflection & Improvement` playbook (which also grounds findings
in the KB and files issues), not to an unattended weekly pass. Keeping this job
read-only is what makes it safe to schedule and safe to fail-open.

## Schedule

Register on the schedule surface at a weekly cadence. The schedule itself is
operator state (`~/.kookr/schedules.json`), not a repository file — the
reproducible definition (cron rationale, exact parameters, acceptance checks)
lives in `docs/reference/nb-janitor-schedule.md`. Summary:

| Field | Value |
| --- | --- |
| `cron` | `17 6 * * 1` (Mondays 06:17, server-local; staggered off every other window) |
| `cwd` | `$HOME/git/kookr` |
| `playbook.path` | `nb-janitor.md` (project scope) |

Weekly is deliberate: the evidence (issue #3471) is that this store is healthy,
so the value is quiet, accruing hygiene, not firefighting — a heavier cadence
would only add noise.

## Safety

- **Read-only.** Never run a mutating `nb` verb (`add`/`vote`/`merge`/`rm`/
  `split`/`describe`) and never edit a notebook file. The janitor only reads.
- **Fail-open.** Any janitor error (missing clone, crash, non-zero exit, moved
  file) is swallowed and reported as "unavailable" — it never fails the task.
- **Do not touch the hot `nb` path.** `bin/nb.js` and every `nb` call stay
  exactly as they are; this job runs the janitor out-of-band.
- **No network side effects** beyond the read-only `git fetch`/`git clone` used
  to resolve the janitor script.
