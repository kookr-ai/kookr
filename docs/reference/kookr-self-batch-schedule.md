# Kookr Self-Batch Schedule Reference

Kookr's own backlog is drainable by the same `parallel-issue-batch` pipeline
that merges batches for other tracked repositories. This page documents the
**Kookr parallel issue batch** schedule so its configuration is reproducible
from source: the exact parameters, the cron choice and its rationale, the
prod-safety invariant, and the selection simulation that verifies which issues
the batch will surface.

The schedule itself is operator state (it lives in `~/.kookr/schedules.json`,
not in this repository — see [Data Directory](data-directory.md)). This page is
the source-of-truth spec for recreating or auditing it.

## Purpose

`github.com/kookr-ai/kookr` is already a registered project
(`~/.kookr/project-configs.json`, `localPath` `/home/<user>/git/kookr`), and
`plugin/playbooks/parallel-issue-batch.md` is fully repo-parameterized. What was
missing was a schedule that points that pipeline at Kookr's own backlog, so the
same automation that drains other repos also drains this one.

## Schedule definition

| Field | Value |
| --- | --- |
| `name` | `Kookr parallel issue batch` |
| `enabled` | `true` |
| `cron` | `23 2,14 * * *` |
| `cwd` | `/home/<user>/git/kookr` |
| `agentType` | `default` |
| `playbook.path` | `parallel-issue-batch.md` |
| `playbook.scope` | `plugin` |

`playbook.scope` is `plugin` because `parallel-issue-batch.md` ships in the
plugin tree (`<checkout>/plugin/playbooks/`), resolved via `pluginPlaybooksDir()`
— not the project tier (`<cwd>/.kookr/playbooks/`). Omitting the scope defaults
to `project`, where the file does not exist, so the create call is rejected with
`Playbook not found`.

`playbook.parameters`:

| Parameter | Value | Why |
| --- | --- | --- |
| `repoFullName` | `kookr-ai/kookr` | Target repository. |
| `localPath` | `/home/<user>/git/kookr` | Registered checkout. Blank would also resolve to `~/git/kookr`; set explicitly for reproducibility. |
| `issueSelector` | `` (blank) | Blank scans open issues through the playbook's eligibility filters. |
| `targetIssueCount` | `4` | Issues to cover per run (bundles are temporarily ineligible until atomic multi-issue claim transfer is available). |
| `maxConcurrentTasks` | `2` | Cap on concurrent child tasks. Kept low so the batch never contends with the Lucy batch or the host's own server for spawn slots. |
| `mergeAfterImplementation` | `true` | Child tasks merge PRs once checks pass. Merges land on `main` only (see prod safety). |
| `allowOtherAuthors` | `false` | Issue bodies are untrusted prompt input; only issues opened by the operator are eligible. |
| `childAgent` | `default` | Server-default agent for child tasks. |
| `extraInstruction` | `Never run pnpm prod:update or restart the prod server; merged PRs land on main only.` | Reinforces the prod-safety invariant. |

### Reproduce it

Preferred (server running) — POST through the API so the in-memory store and
the on-disk file stay consistent:

```bash
curl -sS -X POST http://127.0.0.1:4800/api/schedules \
  -H 'content-type: application/json' \
  -d '{
    "name": "Kookr parallel issue batch",
    "enabled": true,
    "cron": "23 2,14 * * *",
    "cwd": "/home/<user>/git/kookr",
    "agentType": "default",
    "playbook": {
      "path": "parallel-issue-batch.md",
      "scope": "plugin",
      "parameters": {
        "repoFullName": "kookr-ai/kookr",
        "localPath": "/home/<user>/git/kookr",
        "issueSelector": "",
        "targetIssueCount": "4",
        "maxConcurrentTasks": "2",
        "mergeAfterImplementation": "true",
        "allowOtherAuthors": "false",
        "childAgent": "default",
        "extraInstruction": "Never run pnpm prod:update or restart the prod server; merged PRs land on main only."
      }
    }
  }'
```

Only edit `~/.kookr/schedules.json` directly while the server is **stopped** —
a running server holds schedules in memory and rewrites the file on every
mutation (`ScheduleStore.persist()`), so a live direct edit is clobbered.

### Verify (acceptance checks)

```bash
# enabled == true for the kookr schedule
jq '.[] | select(.playbook.parameters.repoFullName == "kookr-ai/kookr"
      and .playbook.path == "parallel-issue-batch.md") | .enabled' \
  ~/.kookr/schedules.json                         # -> true

# maxConcurrentTasks <= 2 and mergeAfterImplementation == true
jq '.[] | select(.playbook.parameters.repoFullName == "kookr-ai/kookr"
      and .playbook.path == "parallel-issue-batch.md")
      | .playbook.parameters | {maxConcurrentTasks, mergeAfterImplementation}' \
  ~/.kookr/schedules.json                         # -> {"maxConcurrentTasks":"2","mergeAfterImplementation":"true"}
```

### Enable / disable

```bash
# Look up the id, then flip enabled via PATCH (server running):
SID=$(jq -r '.[] | select(.playbook.parameters.repoFullName=="kookr-ai/kookr"
        and .playbook.path=="parallel-issue-batch.md") | .id' ~/.kookr/schedules.json)
curl -sS -X PATCH "http://127.0.0.1:4800/api/schedules/$SID" \
  -H 'content-type: application/json' -d '{"enabled": false}'   # hold the batch
```

## Cron rationale

`23 2,14 * * *` fires twice a day at 02:23 and 14:23 (server-local time). The
minute and hours are chosen to stagger away from every other scheduled window so
the two issue batches never contend for the same spawn slots:

| Schedule | Cron | Conflict avoided |
| --- | --- | --- |
| Lucy parallel issue batch | `7 */5 * * *` (00:07, 05:07, 10:07, 15:07, 20:07) | Different minute (`:23` vs `:07`) **and** different hours (2/14 fall between Lucy's 0/5 and 10/15 slots). |
| Lucy Backtest Progress Watchdog | `0 * * * *` (hourly at `:00`) | Minute `:23`, never `:00`. |
| Lucy evening cluster (progress / reflection / supervisor) | `0,20,40 19 * * *` | Hours 2/14, never 19. |
| Lucy Twice-Daily Idea Scout | `0 8,16 * * *` | Hours 2/14, never 8/16. |
| Daily maintenance (rebase / KB reindex / watchdog / grok sync) | `0 0,4,5,9 * * *` | Hours 2/14, never 0/4/5/9. |

Twice a day is a deliberately conservative launch cadence for a
self-targeting, self-merging schedule; with `targetIssueCount=4` and
`maxConcurrentTasks=2` it drains the eligible backlog over several days without
saturating the host. The cadence can be raised once the lane is proven healthy.

## Prod safety

Merged batch PRs land on `main` only. Production runs from an isolated
`../kookr-prod` worktree that updates exclusively via an explicit
`pnpm prod:update`, guarded by a PreToolUse edit-block. Nothing in this schedule
or the `parallel-issue-batch` playbook triggers `pnpm prod:update` or restarts
the prod server, so a merged batch PR cannot hot-break the running orchestrator.
The `extraInstruction` parameter restates this invariant to every child task.

## Selection simulation

Before enabling, confirm that the batch will only surface eligible issues. This
reproduces the two eligibility filters the playbook applies to the blank
selector shape (`plugin/playbooks/implement-github-issue.md`, Phase 0d):

1. **Author trust** — `allowOtherAuthors=false` keeps only issues opened by the
   operator, because issue bodies are untrusted prompt input.
2. **Blocked-label skip** — skip issues labelled `automation-blocked`,
   `architecture`, `blocked`, `duplicate`, `invalid`, `wontfix`, `not planned`,
   or `question`. (`architecture` marks design-document issues that are not
   one-PR implementation units.)

`scripts/simulate-batch-selection.sh` runs the check read-only (it never claims
or modifies an issue):

```bash
scripts/simulate-batch-selection.sh kookr-ai/kookr
```

Snapshot from `2026-07-28` against `kookr-ai/kookr` (60 author-trusted open
issues → 34 eligible, 26 skipped by label — every skipped issue carries a
skip-label, and no eligible issue does):

```
ELIGIBLE (34) — surface to batch:
  #1642  [bug]  Root-cause and fix the grok-build POST >90s launch hang ...
  #1630  [bug]  Prod HTTP starves under host CPU contention ...
  ... (32 more)

SKIPPED by blocked-label (26):
  #1552  [enhancement, automation-blocked]
  ...
  #1464  [architecture]
  #1463  [architecture]
  #1461  [architecture]
  #1460  [architecture]
  ... (automation-blocked issues)
```

The parent umbrella `#1546` is itself `automation-blocked` and is correctly
excluded.

## References

- Playbook: `plugin/playbooks/parallel-issue-batch.md`
- Eligibility filters: `plugin/playbooks/implement-github-issue.md` (Phase 0d)
- Data directory / schedules file: [Data Directory](data-directory.md)
- Parent umbrella: kookr-ai/kookr#1546
