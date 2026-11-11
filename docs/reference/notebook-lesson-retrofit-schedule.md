# Notebook Lesson Retrofit Schedule Reference

Agents record a lesson in an agent-notebook shelf when something trips them up.
The `.kookr/playbooks/notebook-lesson-retrofit.md` playbook reads those lessons
and asks a different question from the other two notebook playbooks: *which
lessons could the tooling make unnecessary?* It proposes a hook, command, skill
or agent-definition rule for each such group, checks that nothing already covers
it, and keeps a map from every proposal to the notebook entries it retires. On
later runs it also reports which earlier proposals have shipped, so their
entries can be removed.

This page is the source-of-truth spec for running that playbook on a monthly
schedule. The schedule itself is **operator state** (it lives in
`~/.kookr/schedules.json`, not in this repository — see
[Data Directory](data-directory.md)). Nothing creates it automatically.

## How it differs from the other notebook playbooks

| Playbook | Looks at | Cadence |
| --- | --- | --- |
| `nb-janitor.md` ([schedule](nb-janitor-schedule.md)) | Store hygiene: duplicates, eviction loss, silent shelves | Weekly |
| `agent-notebook-reflection.md` | How the harness uses `nb`: error rates, surfacing metrics, wiring against the tool's docs | On demand, or on whatever schedule the operator has given it |
| `notebook-lesson-retrofit.md` | What the lessons say about the harness and the repositories, and what would make each lesson unnecessary | Monthly |

## Status: proven by one manual analysis, not yet by a playbook run

The playbook encodes the method and the mistakes of a manual analysis done on
2026-11-11 (umbrella issue #3639: 760 entries read, 202 mapped to 31 findings).
The playbook itself has not completed a run. Before enabling the schedule, launch
it once by hand with `fileIssues=no` and compare its report with the baseline in
`~/.kookr/reports/notebook-retrofit-2026-11-11.md`. A good first run carries the
baseline map forward, proposes nothing the baseline already holds, and lists
"ready to retire" entries only for leaves that are closed, verified and live.

A run never overwrites an earlier run's files, because the newest earlier map
and snapshot are its baseline. A second run on the same date writes
`notebook-retrofit-<date>-run2.*` and diffs against the first.

## Install the playbook where the schedule can find it

A `project`-scope playbook is read from `<cwd>/.kookr/playbooks/` on disk. The
primary checkout is often on an old branch, so it may not contain this file.
Install a copy in the user tier instead (`~/.kookr/playbooks/`, where a
`user`-scope schedule looks), and refresh the copy when the playbook changes:

```bash
cp .kookr/playbooks/notebook-lesson-retrofit.md ~/.kookr/playbooks/
```

Run that from a checkout that is current with `origin/main`.

## Schedule definition

| Field | Value |
| --- | --- |
| `name` | `Notebook Lesson Retrofit Review` |
| `enabled` | `true` |
| `cron` | `52 5 1 * *` |
| `cwd` | `/home/<user>/git/kookr` |
| `playbook.path` | `notebook-lesson-retrofit.md` |
| `playbook.scope` | `user` |

Leave `agentType` out so the schedule follows the server's default agent, and
do not set `modelTier: "small"`. The work is cross-shelf synthesis followed by
verification against several repositories; a small model produces confident
proposals for things that already exist.

`playbook.parameters` (all optional; the defaults match the playbook frontmatter):

| Parameter | Value | Why |
| --- | --- | --- |
| `umbrellaRepo` | `kookr-ai/kookr` | Repository that holds the umbrella issue. |
| `fileIssues` | `no` | `no` writes the report only. `umbrella` also updates the umbrella issue. `leaves` also files one issue per verified single-PR change. Start with `no`. |
| `minVotes` | `5` | Score at which a single entry becomes a candidate. |
| `reportsDir` | `` (blank) | Blank resolves to `~/.kookr/reports`. |

### Create it

With the server running, POST through the API so the in-memory store and the
on-disk file stay consistent:

```bash
curl -sS -X POST http://127.0.0.1:4800/api/schedules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Notebook Lesson Retrofit Review",
    "enabled": true,
    "cron": "52 5 1 * *",
    "cwd": "/home/<user>/git/kookr",
    "playbook": {
      "path": "notebook-lesson-retrofit.md",
      "scope": "user",
      "parameters": {
        "umbrellaRepo": "kookr-ai/kookr",
        "fileIssues": "no",
        "minVotes": "5",
        "reportsDir": ""
      }
    }
  }'
```

Only edit `~/.kookr/schedules.json` directly while the server is **stopped**: a
running server holds schedules in memory and rewrites the file on every mutation.

### Verify

```bash
jq '.[] | select(.playbook.path == "notebook-lesson-retrofit.md") | {enabled, cron, scope: .playbook.scope}' \
  ~/.kookr/schedules.json     # -> {"enabled":true,"cron":"52 5 1 * *","scope":"user"}
```

### Run once, hold, or release

```bash
SID=$(jq -r 'first(.[] | select(.playbook.path=="notebook-lesson-retrofit.md")) | .id' ~/.kookr/schedules.json)
kookr schedule run "$SID"        # fire now
kookr schedule disable "$SID"    # hold
kookr schedule enable "$SID"     # release
```

## Cron rationale

`52 5 1 * *` fires on the first day of each month at 05:52 (server-local time).

- **Monthly**, because lessons accrue slowly and a proposal needs time to be
  implemented before the next run can close its loop. The janitor and the
  reflection playbook cover the faster-moving signals.
- **Minute `:52`** is not used by any schedule in the live set on 2026-11-11.
- **Hour `5`** comes after the 02:23 issue batch and the 03:00 and 04:00 nightly
  jobs, and before the 07:00 and later daytime jobs.

The live set is operator state; audit `~/.kookr/schedules.json` before relying
on this.

## What a run may and may not do

- **Reads** every shelf with `nb show`, earlier reports in `~/.kookr/reports`,
  and the default branch of each repository it checks, through a freshly fetched
  remote ref.
- **Writes** three dated files to the reports directory (report, entry map,
  shelf snapshot), its own retrospective votes, and at most one new lesson.
- **Never** removes, moves, merges or edits an existing notebook entry, and never changes
  host configuration, hooks, settings or schedules. Retiring entries is the
  operator's step; the report prints the exact commands.
- **Issues** are touched only when `fileIssues` is not `no`. Public issues carry
  shelf names, entry ids, scores and actions only: no lesson text, and nothing
  from or about a private repository. A leaf that changes what every agent
  session does is filed with the `automation-blocked` label, so the issue batch
  ([Kookr self-batch schedule](kookr-self-batch-schedule.md)) leaves it alone
  until the operator removes the label. In a repository without that label the
  leaf is not filed; it stays on the umbrella, marked held.
