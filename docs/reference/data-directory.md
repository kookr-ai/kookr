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
| `task-archive/YYYYMM.jsonl` | terminal-task archive (`src/server/use-cases/task-archive.ts`, issue #2765) | Local-first, append-only archive of terminal (completed/cancelled/terminated) task records, one JSON record per line (`{ archivedAt, lastActivityMs, task }`), segmented by calendar month. Every record is archived here *before* `pruneAgedTaskRecords` deletes it from the hot store, so cost/token and completion history outlives the bounded daily/predelete snapshots. Read/paged via `GET /api/tasks/archive` (`before`, `cursor`, `limit`) without hydrating the live store. | Automatic retention/compaction on the maintenance sweep: whole month segments past `DEFAULT_TASK_ARCHIVE_RETENTION_DAYS` (90d, current month never age-deleted) are removed, and duplicate task ids (crash re-archive) are collapsed. Malformed lines are skipped on read. Safe to delete if you do not need terminal-task history beyond the snapshot window. |
| `.tmp-<uuid>`, `.tmp-<pid>`, and known writer suffixes such as `effort-split.jsonl.tmp-*` (root-level only) | atomic-write paths | In-progress write-to-temp files created beside a durable JSON or state file. A successful write renames the temp into place; a failed common atomic write removes its temp when possible. | `kookr maintenance prune` recognizes only its explicit allowlist at the data-directory root after a separate seven-day default age threshold. Fresh or open files, and files whose open state cannot be verified, are preserved. Bare `.tmp-write` and `.tmp-prune` are nested marker names, not recognized root-level names. Use `--atomic-temp-max-age-days` to override the threshold. |
| `hooks/*.jsonl` and `hooks/*.jsonl.N` | hook ingestion | Raw Claude Code hook events per terminal session. The active file is size-rotated into numbered generations once it exceeds `KOOKR_HOOK_MAX_BYTES` (`KOOKR_HOOK_ROTATE_KEEP` generations retained — see [environment-variables.md](environment-variables.md); issue #1433). | `kookr maintenance prune` can remove aged completed-task or orphan logs, including rotated generations. |
| `hook-replay-checkpoints.json` | hook file watcher (issue #1045, prune #2385) | Restart-safe per-session read offsets for `hooks/*.jsonl`: `filePath`, `dev`/`ino`, `sizeBytes`, `offsetChars`, and an `offsetTail` content fragment used to verify the checkpoint still matches the file before resuming. Written atomically after each successful drain. | Keep while sessions are live. Keys are removed on intentional `stop(tmuxName)`, by a missing-file sweep on watcher construct, and by a post-startup-recovery drop of non-watched sessions (issue #2385). Not touched by `kookr maintenance prune`. Safe to delete only while Kookr is stopped (next restart falls back to offset zero / full replay). |
| `activity/*.jsonl` and `activity/*.jsonl.1` | activity ledger | Durable parsed hook ledger used for diagnostics and activity views. | Size-rotated per session; `kookr maintenance prune` can remove aged completed-task or orphan ledgers (same terminal/orphan-and-aged rules as hook logs). |
| `playbook-state/<playbook>/<runKey>/` | playbook runner | Durable per-run state for playbook executions (scout runs, batch runs, …). | `kookr maintenance prune` can remove aged run directories; keeps the newest K per playbook (`--playbook-keep-last`) and never removes a run whose key matches an active task. |
| `playbook-state/post-recovery-queue-fill/<repoSlug>.json` | post-recovery queue-fill (`src/server/post-recovery-service.ts`, issue #2196) | Per-product-repo UTC-day latch for the post-recovery queue-fill kick: after capacity returns, at most one idea scout per product repo per UTC calendar day. The file is overwritten in place with `lastKickUtcDay` (`YYYY-MM-DD`) when a kick successfully launches a scout. Distinct from idea-scout *run* directories at `playbook-state/repository-idea-scout/<repoSlug>/<runKey>/`. Written atomically, owner-only (`0o600`). | Keep; overwrite in place. Not a playbook run directory, so `kookr maintenance prune` does not remove these files. Deleting a file (or restoring a backup without today's stamp) allows another kick for that repo the same UTC day. |
| `sessions/*/interactions.jsonl` | interaction log | User inputs, finding actions, task lifecycle actions, and other operator interaction events. | Preserved by maintenance prune. |
| `sessions/*/telemetry.jsonl` | session telemetry (`src/core/telemetry.ts`) | Append-only local UI/session telemetry events (clicks, launches, attach latency, websocket reconnects, …) written once a session is materialized. Same directory as the interaction log. Aggregated by `GET /api/telemetry/report` — see [api.md](api.md). | Preserved by maintenance prune. Not size-rotated today; grows with dashboard use. Safe to delete for a dead session if you do not need the session diagnostics report. |
| `achievements.json` | achievement watcher (`src/server/achievement-watcher.ts`) | Durable unlocks, counters, and streak state for the achievements catalog. Written atomically as compact JSON; corrupt files are quarantined (`achievements.json.quarantined-<ISO>.json`) rather than overwritten. See [F13: Achievements](../features.md#f13-achievements). | Keep if you care about unlock history. Not touched by `kookr maintenance prune`. Safe to delete (or reset via the dashboard) to clear progress; the watcher recreates defaults. |
| `settings.json` | settings API | Dashboard settings saved through the Settings dialog/API. | Keep; copy with backups. |
| `settings/` | server bootstrap | Settings-related runtime directory threaded to the HTTP/WebSocket bootstrap layer. | Internal; keep. |
| `schedules.json` | scheduler | Persisted scheduled tasks and trigger counters. | Keep if schedules matter. |
| `project-configs.json` | project config | Per-project tracking and dashboard config (`dailyPrLimit`, `weeklyPrLimit`, `budgetWarnUsd`, notes, webhook, …). Manual PR limits take precedence over `rate-limits.json`. See [Per-project configuration](../configuration.md#per-project-configuration). | Keep if project sidebar state matters. |
| `rate-limits.json` | project config / hooks | Optional per-repo PR limit defaults/overrides and blocked-repo list read by local hooks and as fallback when a project has no manual `dailyPrLimit`. | Keep if configured. |
| `project-sidebar.json` | project sidebar | Local sidebar preferences and project ordering. | Keep if UI state matters. |
| `oss-attempts.json` | OSS contribution gate | Contribution attempt history for the OSS dashboard and scout dedup (states: scouted / pr_open / merged / closed). | Keep for recent dashboard/dedup history. Terminal (`merged` / `closed`) records older than `KOOKR_OSS_ATTEMPT_RETENTION_MS` (default 90 days) are compacted by the store on load and before each save; active `scouted` / `pr_open` rows are never removed by retention. Not GC'd by `kookr maintenance prune`. Rate-limit continuity lives in `contribution-ledger.jsonl`, not this file. |
| `workspace-attempts.json` | contribution workspace services | Durable history of contribution-workspace preflight and cleanup attempts (`WorkspaceAttemptRepository`): attempt type, project, worktree/branch, disposition, evidence, correlated task/session, optional sweep run id. Survives UI disconnects so sweep/cleanup can reconstruct outcomes. | Keep for workspace cleanup audit and sweep reconnect. Every write rewrites the full `{ version: 1, attempts: [...] }` array atomically (no rotation or prune). Grows with attempt count; not touched by `kookr maintenance prune`. |
| `contribution-ledger.jsonl` and `contribution-ledger.jsonl.N` | OSS contribution gate | Append-only contribution history (rate-limit authority). The active file is size-rotated via `appendJsonlWithRotation` when an append would exceed `KOOKR_CONTRIBUTION_LEDGER_MAX_BYTES` (`KOOKR_CONTRIBUTION_LEDGER_ROTATE_KEEP` generations retained — see [environment-variables.md](environment-variables.md); issue #2331). Load paths read the active file plus retained generations so rate-limit counts stay correct within the size-based window. | Keep for rate-limiting, deduplication, and audit history. Never rewritten by oss-attempt retention prune. |
| `effort-split.jsonl` | `kookr effort-split` / daily report | One row per UTC day of lucy vs kookr output share (non-merge commits, PRs merged, lines changed) vs the 80/20 target. Sourced from `gh`, not the contribution ledger. Same-day re-run overwrites. | Keep for week-over-week trends. |
| `detection-stats.json` | detector telemetry | Aggregate anomaly detector counters. | Keep for detector quality telemetry. |
| `audit.jsonl` | server routes | Operator and task lifecycle audit events. | Keep for diagnostics. |
| `audit.snapshot.json` | CommandJournal (`src/remote/command-journal.ts`) | Projection of the remote-command journal (idempotency map, open intents, results, grant tombstones). Written when the journal compacts: the snapshot is fsynced, the covered active `audit.jsonl` is rotated to `audit.<stamp>.<pid>.N.jsonl`, and a new empty active audit starts. On open the journal applies this snapshot then only the active audit tail; rotated archives are not replayed. | Keep with `audit.jsonl`. Do not delete casually — after any compact the snapshot is load-bearing (not rebuildable from the emptied active audit alone; archives are forensics, not restart input). Losing it drops remote-command recovery/idempotency/tombstones until new traffic rebuilds state. Not touched by `kookr maintenance prune`. |
| `issue-claims-audit.jsonl` | issue-claim registry (`src/server/issue-claims-audit-log.ts`) | Append-only claim/release decision audit (`granted`, `reentrant`, `denied`, `released`, `dead_reclaim`, `orphan_reclaim`, `force`, `release_failed`, `exhausted`) written only when `KOOKR_ISSUE_CLAIMS` is on. Single-author sink from `IssueClaimRegistry` — operational metadata only (repo, issue number, task/session ids, decision reason); not credentials. See [Issue-ownership claims](../architecture.md#issue-ownership-claims-kookr_issue_claims), [API Issue Claims](api.md#issue-claims), [CLI `kookr issue`](cli.md), and [environment-variables.md](environment-variables.md) (`KOOKR_ISSUE_CLAIMS`). | Keep for claim/release diagnostics. Not touched by `kookr maintenance prune`. No automatic rotation/compaction today — optional manual prune or delete of aged history if operators do not need it (live claim authority is in-memory + `tasks.json` projection, not this file). |
| `umbrella-chain-claims.json` | umbrella-chain advancer | Durable per-phase spawn claims used for cross-process deduplication and stale-claim recovery. | Keep while umbrella chains are enabled; do not edit while Kookr is running. The accompanying `.lock` is transient. |
| `operational-alerts.jsonl` | schedule runtime / operational-alert sink | Append-only durable trace of operational-alert fire/recovery transitions (schedule dead-man plus every resource-tick operational alert: cpu/memory/disk/RSS/circuit-breaker/persistence/provider-health), so a fire→clear that occurs while no dashboard client is connected still leaves an on-disk record (issues #1709, #1897). | Keep for incident reconstruction. |
| `disposition.jsonl` | recovery work-conservation ledger (`src/core/disposition-ledger.ts`, issue #1540) | Append-only JSONL recording, for each task a recovery path (crash recovery, hung-task reaper, boot-time stale-launch sweep) cancelled or degraded, whether the underlying work was `respawned`, `obsolete`, or `needs-human`. Each row also carries the specific detail (the new task/session for `respawned`, the reason for `obsolete`, what to check for `needs-human`) and an `incidentId`, so a whole recovery run can be pulled back with one query. fsynced after each append (issue #2465). | Keep for incident reconstruction — this is the primary evidence for "did we lose work?" after a crash or restart. Append-only with no size rotation or compaction today, and not touched by `kookr maintenance prune`. Safe to delete only if you do not need post-recovery work-conservation history. |
| `ops-status.json` | ops-status writer (issues #1995, #2032) | Edge-triggered last-known-good ops card (ready degrade, dead-man fire, pipeline starvation fire, SAFE MODE engage, prod smoke tick fire/clear): sha, hungSuspect count, data-dir free space, safeMode, recent critical edges. Smoke fire detail is the failingChecks list only (no secrets). Written atomically; best-effort on disk-full. | Keep for post-hoc diagnosis when Discord/pages are down. |
| `feedback/` | feedback bundle writer | Feedback artifacts generated from task feedback flows. | Keep unless intentionally discarding feedback history. |
| `task-snapshots/` | task snapshot bundles | Snapshot artifacts captured for diagnostics and feedback. | Keep unless intentionally discarding diagnostics. |
| `finding-evidence-reviews.jsonl` | finding review diagnostics | Manual/background finding-evidence review outcomes. | Keep if using finding review diagnostics. |
| `finding-evidence-review-queue.json` | finding review sampler | Background sampler queue and retry ledger. | Keep if using finding review diagnostics. |
| `finding-evidence-review-hmac-key` | finding review diagnostics | Durable HMAC key for review input hashes. | Keep if using finding-evidence review; treat as secret (`0o600`). |
| `supervisor-feedback-cases.jsonl` | feedback diagnostics | Captured false-positive and missed-finding cases. | Keep for detector improvement. |
| `private-network-node-id` | private-network sharing | Stable local node id for read-only sharing. | Keep if using shared views. |
| `share-grants.json` | viewer grant store | Hashed viewer share grants for read-only shared views. | Keep; copy with backups. Compacted by `KOOKR_SHARE_GRANT_RETENTION_MS` (see [environment-variables.md](environment-variables.md)). |
| `collaboration-identities.json` | private-network collaboration | Contact/pairing identity and accepted-auth nonces. | Keep if using private-network collaboration. |
| `collaboration-audit.jsonl` | collaboration/sharing | Collaboration and viewer-share audit events. | Keep for share audit history. |
| `relay-connection.json` and `node-id` | hosted/self-hosted relay pairing | Relay credentials and node id. | Keep; losing these requires re-pairing. |
| `node-epoch` | relay node client (`src/remote/node-client.ts`) | Monotonic node generation counter. On each process start `loadNodeIdentity` increments the previous value and atomically fsyncs the new epoch *before* any outbound relay message is tagged with it. A crash between increment and persist replays the previous epoch on next start (never collides with an epoch the relay already observed). Persist failure puts the node in `degraded` mode (local UI only until the path recovers). | Keep with `node-id`. Prefer not to delete casually: wiping it restarts the counter near zero and forces the relay to treat the next connect as a new generation. Not touched by `kookr maintenance prune`. |
| `relay.sqlite*`, `relay.state.json`, `relay.pid`, `relay.log` | local relay lifecycle | Local relay durable state, process metadata, and logs. | See `session-sharing.md` for relay-specific reset/restore. |
| `relay-state-backups/` | relay recovery | Backups made by relay reset flows. | Keep until the corresponding relay state is no longer needed. |
| `server.log` | production restart script + mid-process size-cap rotation (issue #1991) | Current server log for prod-style launches. | Keep current log while diagnosing. |
| `server.log.N` | production restart script + mid-process size-cap rotation (issue #1991) | Rotated server logs. | `kookr maintenance prune` can remove aged numbered generations. |
| `last-restart-metrics.json` | production restart script | Last successful `prod:restart` phase timings (`apiBlackoutSeconds`, M1/M2, dominant phase). Read by `GET /api/deploy/status` as optional `lastRestart`. | Overwritten each successful restart; safe to delete (field omitted until next restart). |
| `restart-intent.json` | production restart script (issue #2410) | Planned-restart marker `scripts/prod-restart.sh` writes before killing the old server and clears (ownership-checked) once the new one is healthy, so the local `kookr` CLI (`status`, `signal`) can tell a planned redeploy from an unexpected crash while the API is down. Records `reason` (`prod:update`/`prod:restart`), `startedAt`, `pid`, and the deploy's `staleAfterMs` budget. | Transient. A leftover marker only ever reads as an in-progress or "failed deploy" restart (never healthy) and is ignored past 12h. Safe to delete when the server is up; inspect/force-clear with `node bin/kookr-restart-intent.js show`/`clear --dir ~/.kookr`. |
| `server.pid`, `server.lock.sqlite` | server bootstrap (`src/server/single-writer-lock.ts`, RFC R27) | Single-writer ownership. New `server.pid` records keep a decimal PID on line one, followed by line-two JSON `{ "version": 2, "pid": number, "processStartTimeMs": number, "acquisitionId": string }`; legacy files containing only the decimal PID remain readable and live legacy owners fail closed. Keeping the first line numeric makes older Kookr binaries fail closed on a live new-format owner. The process-start identity lets boot reclaim a recycled live PID, while `acquisitionId` prevents an old release callback from deleting a successor's record. `server.lock.sqlite` holds the OS-backed cross-process mutex, so only one stale-lock contender can replace the record; the OS releases its transaction after a crash. A planned `prod:restart` understands both metadata shapes, waits for a matching live owner, and never signals the recorded PID. | `server.pid` is transient and is unlinked on graceful shutdown. `server.lock.sqlite` is reusable coordination state and normally remains. Delete either only when no Kookr process is running; removing `server.pid` while the server is up does not release the OS mutex, and removing the SQLite file while it is open can defeat mutual exclusion. Unreadable metadata fails closed and requires confirming that no server is running before manual removal. |
| `skill-digests/` | context-pack skill cache (`src/core/context-pack.ts`) | Content-hash-keyed cache of skill excerpt digests used when assembling warm-start context packs (`SkillDigestCache`). One JSON file per skill name. Default path is always `~/.kookr/skill-digests` (not port-scoped `~/.kookr-<port>/`); override only via the context-pack CLI `--cache-dir`. | Safe to delete — regenerated on the next context-pack build when skills are digested. Not touched by `kookr maintenance prune`. |

### Unbounded growth (operator note)

Files currently grow without automatic compaction or prune coverage:

- **`workspace-attempts.json`** — full-array rewrite of every attempt record. Size tracks lifetime cleanup/preflight volume (often hundreds of KB after ~1k attempts). No CLI/env retention knob today; keep for audit unless you intentionally discard workspace cleanup history.
- **`sessions/*/telemetry.jsonl`** — append-only per-session UI/session telemetry (no size rotation). Grows with dashboard use; not removed by `kookr maintenance prune`. Safe to delete for dead sessions if you do not need `GET /api/telemetry/report` history for them.
- **`issue-claims-audit.jsonl`** — append-only claim/release decisions when `KOOKR_ISSUE_CLAIMS` is enabled (no size rotation). Growth tracks claim volume; not removed by `kookr maintenance prune`. Safe to truncate or delete if you do not need claim history — does not hold credentials or the live owner map.
- **`disposition.jsonl`** — append-only recovery work-conservation ledger (`respawned` / `obsolete` / `needs-human` rows). No size rotation or compaction today; not removed by `kookr maintenance prune`. Growth tracks how often recovery paths cancel or degrade work. Safe to delete if you do not need post-recovery work-conservation history — holds task/session ids and recovery reasons, not credentials.

These paths are not controlled by an environment variable (the claims audit is gated by `KOOKR_ISSUE_CLAIMS`, which only controls whether rows are written). Related surfaces: hook log rotation uses `KOOKR_HOOK_MAX_BYTES` / `KOOKR_HOOK_ROTATE_KEEP` ([environment-variables.md](environment-variables.md)); aged hook logs can be removed with `kookr maintenance prune` ([cli.md](cli.md)); hook-replay checkpoint keys are lifecycle-pruned by the hook watcher (issue #2385), not by maintenance prune.

Dtach sockets, manifests, and terminal scrollback rings do not live in the data
directory. They are under `/tmp/kookr-dtach/<uid>/port-<port>/`, with
`manifest.json` and `rings/<session>.ring` (a combined single-file snapshot
committed with one atomic rename since #2829; pre-#2829 `rings/<session>.bin` /
`rings/<session>.meta.json` pairs are still read for recovery but no longer
written). They are runtime crash-recovery state for surviving dtach masters, not
long-term backup state. If Kookr is stopped cleanly and the dtach masters are gone, restoring the
data directory alone restores task records but not live terminal processes.

Ralph iteration audit logs also live outside the data directory: each Ralph loop
writes append-only `ralph-iterations.jsonl` under the **task workspace**
(`<task-cwd>/ralph-iterations.jsonl`, via `src/core/ralph-iteration-log.ts` —
issue #440). Maintenance prune deliberately preserves this store because it is
not under the data dir; back it up with the workspace (or accept losing loop
history) if you archive a worktree.
See [Ralph Loop Stopped Or Shows "Replace With New"](../troubleshooting.md#ralph-loop-stopped-or-shows-replace-with-new)
and `docs/rfc/rfc-ralph-loop-crash-restart-recovery.md`.

The `.kookr-protected` file is also outside the data directory: it belongs at a
git worktree root and prevents managed task cleanup from removing that worktree.
See [Protecting A Worktree From Automatic Cleanup](../user-guide.md#protecting-a-worktree-from-automatic-cleanup).

## Snapshot Semantics

`tasks.json` is written atomically: Kookr writes a temporary file, fsyncs it,
renames it into place, and then fsyncs the parent directory so the renamed
entry itself survives a crash (platforms that don't support directory fsync
are tolerated). Snapshot files are copied only after a successful task save.

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
- stale allowlisted root-level atomic-write temporary files, using a separate conservative age threshold and a live-open safety check. The allowlist covers `.tmp-<uuid|pid>`, `effort-split.jsonl.tmp-*`, `detection-stats.json.tmp-*`, `last-good-health.json.tmp-*`, `timer-health.state.json.tmp-*`, `finding-evidence-review-queue.json.<pid>.<timestamp>.tmp`, `.achievements-<uuid>.tmp`, `.schedules-<uuid>.tmp`, `.schedule-rollups-<uuid>.tmp`, `.resource-watchdog-state.<hex>.tmp`, `hook-replay-checkpoints.json.tmp`, `audit.snapshot.json.<pid>.tmp`, `relay-connection.json.<pid>.<timestamp>.tmp`, and `.node-id.<pid>.<timestamp>.tmp` / `.node-epoch.<pid>.<timestamp>.tmp`. Bare `.tmp-write` and `.tmp-prune` names are deliberately excluded because those suffixes are used by nested marker files, not root-level data files.

A live/in-progress session's activity ledger and an active task's playbook run
are never eligible regardless of age. It deliberately preserves `tasks.json`,
snapshot files, dtach runtime state, interaction logs, contribution history
(`contribution-ledger.jsonl`, `oss-attempts.json`, `workspace-attempts.json`),
hook replay checkpoints (`hook-replay-checkpoints.json`), issue-claims audit
(`issue-claims-audit.jsonl`), and ambiguous audit stores. When `tasks.json` is
unreadable, session-keyed and playbook pruning is skipped entirely; root-level
allowlisted atomic-write temps and independent diagnostic stores follow their
separate safety rules.

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

- [CLI Reference](cli.md) for `kookr maintenance prune` and `kookr issue` claim/release
- [Environment Variables](environment-variables.md) for `KOOKR_PORT` and `KOOKR_ISSUE_CLAIMS`
- [Architecture: Issue-ownership claims](../architecture.md#issue-ownership-claims-kookr_issue_claims)
- [Session Sharing](session-sharing.md) for relay-specific SQLite reset/restore
