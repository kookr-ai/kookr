# Kookr Data Directory Reference

Kookr is local-first: the dashboard server keeps operator-owned state on disk
instead of sending it to a hosted control plane. This page documents the data
directory layout, snapshot files, cleanup boundaries, and a backup/restore
procedure for local operators.

In command examples below, `KOOKR_DATA_DIR` is a shell variable you set for the
procedure. It is not a Kookr runtime environment variable.

## Directory Resolution

The server chooses one data directory per local port:

| Server port | Data directory |
| --- | --- |
| `4800` | `~/.kookr/` |
| any other explicit port | `~/.kookr-<port>/` |

The production instance normally uses port `4800`, so its state is under
`~/.kookr/`. Development instances usually use port `4801`, so their state is
under `~/.kookr-4801/`.

`kookr maintenance prune` mirrors this rule for explicit numeric `KOOKR_PORT`
values. If the server was launched with `KOOKR_PORT=auto`, pass `--dir` because
the CLI cannot know which port the running server selected.

## Directory Map

The exact set of files grows as features are enabled. Treat unrecognized files
as internal unless this table says they are safe to remove.

| Path | Owner | Purpose | Retention / cleanup |
| --- | --- | --- | --- |
| `tasks.json` | task persistence | Source of truth for tasks, sessions, task relations, snoozes, suppression state, and lifetime spend. | Keep. Written atomically. |
| `tasks.json.daily.YYYYMMDD` | task persistence | First successful task save of each local day. Used for boot-time recovery when `tasks.json` is corrupt. | Automatic 7-day retention. |
| `tasks.json.predelete.YYYYMMDDTHHMMSS` | task lifecycle | Snapshot taken before `clearCompleted` deletes finished tasks. | Automatic last-5 retention. |
| `tasks.json.corrupt-<ISO>` | boot recovery | Quarantined corrupt live task file. | Keep until you confirm recovery; then archive or delete manually. |
| `hooks/*.jsonl` and `hooks/*.jsonl.N` | hook ingestion | Raw Claude Code hook events per terminal session. The active file is size-rotated into numbered generations once it exceeds `KOOKR_HOOK_MAX_BYTES` (`KOOKR_HOOK_ROTATE_KEEP` generations retained — see [environment-variables.md](environment-variables.md); issue #1433). | `kookr maintenance prune` can remove aged completed-task or orphan logs, including rotated generations. |
| `activity/*.jsonl` and `activity/*.jsonl.1` | activity ledger | Durable parsed hook ledger used for diagnostics and activity views. | Size-rotated per session; `kookr maintenance prune` can remove aged completed-task or orphan ledgers (same terminal/orphan-and-aged rules as hook logs). |
| `playbook-state/<playbook>/<runKey>/` | playbook runner | Durable per-run state for playbook executions (scout runs, batch runs, …). | `kookr maintenance prune` can remove aged run directories; keeps the newest K per playbook (`--playbook-keep-last`) and never removes a run whose key matches an active task. |
| `sessions/*/interactions.jsonl` | interaction log | User inputs, finding actions, task lifecycle actions, and other operator interaction events. | Preserved by maintenance prune. |
| `settings.json` | settings API | Dashboard settings saved through the Settings dialog/API. | Keep; copy with backups. |
| `settings/` | server bootstrap | Settings-related runtime directory threaded to the HTTP/WebSocket bootstrap layer. | Internal; keep. |
| `schedules.json` | scheduler | Persisted scheduled tasks and trigger counters. | Keep if schedules matter. |
| `project-configs.json` | project config | Per-project tracking and dashboard config (`dailyPrLimit`, `weeklyPrLimit`, `budgetWarnUsd`, notes, webhook, …). Manual PR limits take precedence over `rate-limits.json`. See [Per-project configuration](../configuration.md#per-project-configuration). | Keep if project sidebar state matters. |
| `rate-limits.json` | project config / hooks | Optional per-repo PR limit defaults/overrides and blocked-repo list read by local hooks and as fallback when a project has no manual `dailyPrLimit`. | Keep if configured. |
| `project-sidebar.json` | project sidebar | Local sidebar preferences and project ordering. | Keep if UI state matters. |
| `oss-attempts.json` | OSS contribution gate | Contribution attempt counters. | Keep for rate-limit continuity. |
| `contribution-ledger.jsonl` | OSS contribution gate | Append-only contribution history. | Keep for deduplication and audit history. |
| `effort-split.jsonl` | `kookr effort-split` / daily report | One row per UTC day of lucy vs kookr output share (non-merge commits, PRs merged, lines changed) vs the 80/20 target. Sourced from `gh`, not the contribution ledger. Same-day re-run overwrites. | Keep for week-over-week trends. |
| `detection-stats.json` | detector telemetry | Aggregate anomaly detector counters. | Keep for detector quality telemetry. |
| `audit.jsonl` | server routes | Operator and task lifecycle audit events. | Keep for diagnostics. |
| `operational-alerts.jsonl` | schedule runtime / operational-alert sink | Append-only durable trace of operational-alert fire/recovery transitions (schedule dead-man plus every resource-tick operational alert: cpu/memory/disk/RSS/circuit-breaker/persistence/provider-health), so a fire→clear that occurs while no dashboard client is connected still leaves an on-disk record (issues #1709, #1897). | Keep for incident reconstruction. |
| `ops-status.json` | ops-status writer (issues #1995, #2032) | Edge-triggered last-known-good ops card (ready degrade, dead-man fire, pipeline starvation fire, SAFE MODE engage, prod smoke tick fire/clear): sha, hungSuspect count, data-dir free space, safeMode, recent critical edges. Smoke fire detail is the failingChecks list only (no secrets). Written atomically; best-effort on disk-full. | Keep for post-hoc diagnosis when Discord/pages are down. |
| `feedback/` | feedback bundle writer | Feedback artifacts generated from task feedback flows. | Keep unless intentionally discarding feedback history. |
| `task-snapshots/` | task snapshot bundles | Snapshot artifacts captured for diagnostics and feedback. | Keep unless intentionally discarding diagnostics. |
| `finding-evidence-reviews.jsonl` | finding review diagnostics | Manual/background finding-evidence review outcomes. | Keep if using finding review diagnostics. |
| `finding-evidence-review-queue.json` | finding review sampler | Background sampler queue and retry ledger. | Keep if using finding review diagnostics. |
| `supervisor-feedback-cases.jsonl` | feedback diagnostics | Captured false-positive and missed-finding cases. | Keep for detector improvement. |
| `private-network-node-id` | private-network sharing | Stable local node id for read-only sharing. | Keep if using shared views. |
| `collaboration-audit.jsonl` | collaboration/sharing | Collaboration and viewer-share audit events. | Keep for share audit history. |
| `relay-connection.json` and `node-id` | hosted/self-hosted relay pairing | Relay credentials and node id. | Keep; losing these requires re-pairing. |
| `relay.sqlite*`, `relay.state.json`, `relay.pid`, `relay.log` | local relay lifecycle | Local relay durable state, process metadata, and logs. | See `session-sharing.md` for relay-specific reset/restore. |
| `relay-state-backups/` | relay recovery | Backups made by relay reset flows. | Keep until the corresponding relay state is no longer needed. |
| `server.log` | production restart script + mid-process size-cap rotation (issue #1991) | Current server log for prod-style launches. | Keep current log while diagnosing. |
| `server.log.N` | production restart script + mid-process size-cap rotation (issue #1991) | Rotated server logs. | `kookr maintenance prune` can remove aged numbered generations. |
| `last-restart-metrics.json` | production restart script | Last successful `prod:restart` phase timings (`apiBlackoutSeconds`, M1/M2, dominant phase). Read by `GET /api/deploy/status` as optional `lastRestart`. | Overwritten each successful restart; safe to delete (field omitted until next restart). |

Dtach sockets, manifests, and terminal scrollback rings do not live in the data
directory. They are under `/tmp/kookr-dtach/<uid>/port-<port>/`, with
`manifest.json` and `rings/<session>.bin` / `rings/<session>.meta.json`. They are
runtime crash-recovery state for surviving dtach masters, not long-term backup
state. If Kookr is stopped cleanly and the dtach masters are gone, restoring the
data directory alone restores task records but not live terminal processes.

The `.kookr-protected` file is also outside the data directory: it belongs at a
git worktree root and prevents managed task cleanup from removing that worktree.
See [Protecting A Worktree From Automatic Cleanup](../user-guide.md#protecting-a-worktree-from-automatic-cleanup).

## Snapshot Semantics

`tasks.json` is written atomically: Kookr writes a temporary file, fsyncs it,
and renames it into place. Snapshot files are copied only after a successful
task save.

Daily snapshots:

- Pattern: `tasks.json.daily.YYYYMMDD`
- Created: first successful task save of each local day
- Retention: files older than 7 days are pruned automatically
- Boot recovery: if live `tasks.json` is corrupt, Kookr renames it to
  `tasks.json.corrupt-<ISO>` and restores the newest valid daily snapshot

Pre-delete snapshots:

- Pattern: `tasks.json.predelete.YYYYMMDDTHHMMSS`
- Created: before `clearCompleted` removes completed/cancelled tasks, and before
  terminated tasks when that destructive action includes them
- Retention: newest 5 files are retained automatically
- Failure behavior: if the pre-delete snapshot cannot be taken, the destructive
  clear operation aborts

Daily snapshots are for crash/corruption recovery. Pre-delete snapshots are for
recovering from an accidental finished-task sweep.

## Maintenance Prune

The maintenance prune is intentionally conservative:

```bash
kookr maintenance prune --dry-run --dir "$KOOKR_DATA_DIR"
kookr maintenance prune --max-age-days 30 --dir "$KOOKR_DATA_DIR"
kookr maintenance prune --playbook-keep-last 5 --dir "$KOOKR_DATA_DIR"
```

It can delete only:

- aged hook logs — including rotated `hooks/*.jsonl.N` generations (issue #1433) — under `hooks/*.jsonl` for terminal tasks
- aged orphan hook logs
- aged activity ledgers (`activity/*.jsonl` and the rotated `.jsonl.1` companion) for terminal tasks and aged orphans, under the same active-session safety model as hook logs
- aged `playbook-state/<playbook>/<runKey>` run directories (keeps the newest `--playbook-keep-last` runs per playbook and never removes a run whose key matches an active task)
- aged numbered `server.log.N` generations

A live/in-progress session's activity ledger and an active task's playbook run
are never eligible regardless of age. It deliberately preserves `tasks.json`,
snapshot files, dtach runtime state, interaction logs, contribution history, and
ambiguous audit stores. When `tasks.json` is unreadable, session-keyed and
playbook pruning is skipped entirely and only `server.log.N` generations prune.

The prune can also run automatically on a server-side timer — set
`KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` (off by default); see
[environment-variables.md](environment-variables.md).

## Backup

Back up while Kookr is stopped or drained. Stopping is best because it avoids
copying a moving set of JSONL logs and relay SQLite files.

```bash
KOOKR_DATA_DIR="${HOME}/.kookr"
BACKUP_DIR="${HOME}/kookr-backups/kookr-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -a "$KOOKR_DATA_DIR"/. "$BACKUP_DIR"/
```

For a dev instance, set `KOOKR_DATA_DIR="${HOME}/.kookr-4801"` or the directory
matching the instance port. For an auto-port instance, inspect the server
startup log for `Task file:` or pass the exact `--dir` you used with
maintenance commands.

After copying, verify that the backup contains at least:

```bash
test -f "$BACKUP_DIR/tasks.json"
find "$BACKUP_DIR" -maxdepth 1 -name 'tasks.json.daily.*' -o -name 'tasks.json.predelete.*'
```

The `find` command may return no snapshots on a brand-new installation.

## Restore The Whole Data Directory

Use a whole-directory restore when replacing a damaged data directory with a
known-good backup. Stop Kookr first.

```bash
KOOKR_DATA_DIR="${HOME}/.kookr"
BACKUP_DIR="${HOME}/kookr-backups/kookr-20260612-120000"
mkdir -p "$KOOKR_DATA_DIR"
cp -a "$BACKUP_DIR"/. "$KOOKR_DATA_DIR"/
```

Then restart Kookr and verify the dashboard task list, settings, schedules, and
sharing state you care about. In this repo's production worktree, the local
restart command is:

```bash
pnpm prod:restart
```

## Restore Only Tasks From A Snapshot

Use this when the data directory is otherwise healthy but `tasks.json` was
damaged or a clear operation removed tasks you still need. Stop Kookr before
replacing the file.

Pick the newest valid daily snapshot for corruption recovery, or the newest
pre-delete snapshot from before the unwanted clear operation:

```bash
KOOKR_DATA_DIR="${HOME}/.kookr"
cp -a "$KOOKR_DATA_DIR/tasks.json" "$KOOKR_DATA_DIR/tasks.json.manual-backup"
cp -a "$KOOKR_DATA_DIR/tasks.json.predelete.20260612T120000" "$KOOKR_DATA_DIR/tasks.json"
```

Restart Kookr after the copy. If you restore an older `tasks.json`, newer
settings, relay credentials, hook logs, and activity logs remain on disk, but
task records return to the snapshot's point in time.

## Safe Manual Deletion

Prefer `kookr maintenance prune` over hand deletion. If you must clean by hand:

- Usually safe after inspection: old `server.log.N`, stale `tasks.json.corrupt-*`
  files after recovery is confirmed, and backups you created manually.
- Do not delete casually: `tasks.json`, `tasks.json.daily.*`,
  `tasks.json.predelete.*`, `activity/`, `sessions/`, relay credentials, or
  contribution history.
- Do not edit JSON files while Kookr is running. Stop Kookr, copy the file to a
  manual backup, edit, then restart and verify.

## Related References

- [CLI Reference](cli.md) for `kookr maintenance prune`
- [Environment Variables](environment-variables.md) for `KOOKR_PORT`
- [Session Sharing](session-sharing.md) for relay-specific SQLite reset/restore
