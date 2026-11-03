# Agent-Notebook Janitor Schedule Reference

`agent-notebook` ships a read-only cross-notebook janitor
(`examples/nb-janitor.mjs`) that surfaces hygiene problems `nb stats` cannot see
— eviction loss, near-duplicate shelf names, paraphrase-duplicate lessons,
volume & silence, and shelf co-access. Until issue #3471, kookr never ran it on
a schedule: the notebook store got no periodic maintenance pass, and an operator
had to invoke the janitor by hand. This page is the source-of-truth spec for the
weekly schedule that drives the `.kookr/playbooks/nb-janitor.md` playbook, so the
schedule is reproducible and auditable from source.

The schedule itself is **operator state** (it lives in
`~/.kookr/schedules.json`, not in this repository — see
[Data Directory](data-directory.md)). This page documents how to recreate,
verify, enable, and disable it.

## Purpose

Run the **shipped** janitor over `NB_DIR` on a weekly interval and deliver its
human report to the operator, strictly read-only and fail-open. The playbook
(`.kookr/playbooks/nb-janitor.md`) owns the behavior; this schedule simply fires
it weekly.

This is the lightweight, unattended counterpart to the human-invoked
`Agent-Notebook Reflection & Improvement` playbook
(`.kookr/playbooks/agent-notebook-reflection.md`, issue #3473): that one runs the
janitor as one input among many — KB grounding, doc comparison, an HTML report,
and issue filing — whereas this one does nothing but run the janitor and surface
its report. Acting on the janitor's suggestions (`nb merge` / shelf
consolidation) is a reviewed edit and stays with the reflection playbook; the
scheduled job never mutates a notebook.

## Why the janitor is resolved from a clone, not node_modules

`bin/nb.js` dogfoods the **published** `agent-notebook` package by resolving its
compiled `dist/cli.js` from `node_modules`. The janitor cannot be resolved the
same way: the published npm tarball ships only `dist/`, and `examples/` (where
`nb-janitor.mjs` lives) is source-tree only. The playbook therefore extracts the
janitor from a clone of the tool repo at `origin/main` — mirroring the
resolution the reflection playbook uses, with a shallow-clone fallback added so
an unattended run stays self-sufficient when no local checkout exists. A local clone at `~/git/agent-notebook` is the expected
prerequisite; without one and without network, the job fails open (a no-op the
next weekly run retries).

## Schedule definition

| Field | Value |
| --- | --- |
| `name` | `Agent-Notebook Janitor Sweep` |
| `enabled` | `true` |
| `cron` | `17 6 * * 1` |
| `cwd` | `/home/<user>/git/kookr` |
| `agentType` | `default` |
| `playbook.path` | `nb-janitor.md` |
| `playbook.scope` | `project` (default) |

`playbook.scope` is `project` (the default, so it may be omitted) because
`nb-janitor.md` ships in the project tier (`<cwd>/.kookr/playbooks/`), resolved
from `cwd` — not the plugin tier.

`playbook.parameters` (all optional; the defaults below match the playbook
frontmatter, so an empty `parameters` object also works):

| Parameter | Value | Why |
| --- | --- | --- |
| `toolRepo` | `jeanibarz/agent-notebook` | Source repo the shipped janitor is extracted from. |
| `nbDir` | `` (blank) | Blank resolves to `$NB_DIR`, then `~/.kookr/notebooks` (the kookr default pinned by `bin/nb.js`). |
| `days` | `30` | History window for the volume & silence section. |
| `sim` | `0.6` | Lesson-similarity threshold for the duplicate-lessons section. |

### Reproduce it

Preferred (server running) — POST through the API so the in-memory store and the
on-disk file stay consistent:

```bash
curl -sS -X POST http://127.0.0.1:4800/api/schedules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Agent-Notebook Janitor Sweep",
    "enabled": true,
    "cron": "17 6 * * 1",
    "cwd": "/home/<user>/git/kookr",
    "agentType": "default",
    "playbook": {
      "path": "nb-janitor.md",
      "scope": "project",
      "parameters": {
        "toolRepo": "jeanibarz/agent-notebook",
        "nbDir": "",
        "days": "30",
        "sim": "0.6"
      }
    }
  }'
```

Headless equivalent: `kookr schedule list` / `kookr schedule run <id>` /
`kookr schedule disable <id>` (see `bin/kookr-schedule.js`).

Only edit `~/.kookr/schedules.json` directly while the server is **stopped** — a
running server holds schedules in memory and rewrites the file on every mutation
(`ScheduleStore.persist()`), so a live direct edit is clobbered.

### Verify (acceptance checks)

```bash
# enabled == true for the janitor schedule
jq '.[] | select(.playbook.path == "nb-janitor.md") | .enabled' \
  ~/.kookr/schedules.json                         # -> true

# weekly cron and project-tier playbook
jq '.[] | select(.playbook.path == "nb-janitor.md") | {cron, scope: .playbook.scope}' \
  ~/.kookr/schedules.json                         # -> {"cron":"17 6 * * 1","scope":"project"}
```

### Enable / disable

```bash
# Look up the id, then flip enabled via PATCH (server running):
SID=$(jq -r '.[] | select(.playbook.path=="nb-janitor.md") | .id' ~/.kookr/schedules.json)
curl -sS -X PATCH "http://127.0.0.1:4800/api/schedules/$SID" \
  -H 'content-type: application/json' -d '{"enabled": false}'   # hold the sweep
```

## Cron rationale

`17 6 * * 1` fires once a week, Mondays at 06:17 (server-local time). The minute
(`:17`) and hour (`6`) are chosen to stagger off the other scheduled windows
listed below (operator state, so audit `~/.kookr/schedules.json` for the live
set) so the weekly sweep never contends for spawn slots:

| Schedule | Cron | Conflict avoided |
| --- | --- | --- |
| Kookr parallel issue batch | `23 2,14 * * *` | Different minute (`:17` vs `:23`) and hour (`6` vs 2/14). |
| Daily maintenance (rebase / KB reindex / watchdog / grok sync) | `0 0,4,5,9 * * *` | Minute `:17`, never `:00`; hour `6`, never 0/4/5/9. |
| Lucy Twice-Daily Idea Scout | `0 8,16 * * *` | Hour `6`, never 8/16. |
| Lucy parallel issue batch | `7 */5 * * *` | Minute `:17`, never `:07`. |
| Lucy Backtest Progress Watchdog | `0 * * * *` (hourly at `:00`) | Minute `:17`, never `:00`. |
| Lucy evening cluster (progress / reflection / supervisor) | `0,20,40 19 * * *` | Hour `6`, never 19. |

Weekly is deliberately conservative. The evidence (issue #3471: 28 shelves, 259
lessons, a mostly-clean bill with only a few shelf co-access suggestions) is that
this store is healthy, so the value is quiet, accruing hygiene — not firefighting.
A heavier cadence would only add noise. The cadence can be raised if the store
grows noisier.

## Read-only / fail-open invariant

The playbook runs the janitor (which only reads notebooks, the usage log, and
git history) and surfaces the output; it never runs a mutating `nb` verb, never
edits a notebook, and never touches the hot `nb` path (`bin/nb.js`). Any janitor
error — missing clone, no network, crash, non-zero exit, upstream file move — is
swallowed and reported as "unavailable" in the completion summary, so a scheduled
fire can never break anything. This mirrors agent-notebook's DP-6 (the notebook
core stays offline; all the janitor's intelligence runs out-of-band).
