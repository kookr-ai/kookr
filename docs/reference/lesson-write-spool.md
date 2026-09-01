# Lesson-write spool (issue #1519)

When the knowledge-base (`kb`) dependency is degraded, agent lesson writes used
to evaporate: `kb remember` failed, the playbook moved on, and the
`agent-task-lessons` flywheel went dark. Kookr now write-behinds those lessons
to a durable local spool and replays them when KB recovers.

> **Companion:** the spool only covers write durability. The **authoring
> trigger** — requiring a lesson or explicit skip before `completion-ready` —
> is issue #1538: see [lesson-decision-gate.md](./lesson-decision-gate.md).

## Paths

| Path | Role |
|------|------|
| `~/.kookr/playbook-state/lesson-write-spool/pending.jsonl` | Pending lesson bodies (JSONL, one entry per line) |
| `~/.kookr/playbook-state/lesson-write-spool/dead-letter.jsonl` | Entries quarantined after five reserved replay attempts (append-only; not automatically retried) |
| `~/.kookr/playbook-state/lesson-write-spool/state.json` | Degradation streak + alert edge-trigger state |

The spool is **user-scoped** (not per-port `~/.kookr-<port>`), so prod and dev
instances on the same host share one queue.

## Write path

1. Kookr prepends its `bin/` to every spawned agent `PATH` (same injection as
   the `kookr` launcher shim).
2. That directory contains a `kb` shim. Non-`remember` commands exec the real
   `kb` found later on `PATH` with no behaviour change.
3. For lesson targets (`--lesson` or `--kb=agent-task-lessons`):
   - success → pass-through (no spool I/O)
   - runtime failure (exit 1 / timeout / missing binary) → append to
     `pending.jsonl` (deduped by content hash) and exit **0** so agents treat
     the lesson as durably captured
   - argv/template errors (exit 2) and similarity-guard refuses (exit 3) are
     **not** spooled

Operators can also write via `kookr lesson remember --title=… --stdin --yes`,
which tries `kb remember` first and spools on failure.

## Replay

- Server-side: `LessonSpoolService` probes `kb` every 5 minutes (and once ~15s
  after boot). On healthy, it drains the spool via
  `kb remember … --stdin --yes --no-check-similar`.
- Operator: `kookr lesson drain` (idempotent; re-running an empty spool is a
  no-op). `kookr lesson status` shows pending entries and the degradation
  streak.

Before each replay call, the drain persists the entry's next attempt count.
This reservation prevents a process stop around the provider call from
repeating an uncounted attempt. Fewer than five reserved attempts leave a
failed entry in `pending.jsonl`. A failed fifth call is quarantined immediately;
if that call's outcome is unknown after a process stop, the next drain
quarantines the entry without issuing a sixth call. The drain syncs it to
`dead-letter.jsonl` before removing it from automatic replay. Atomic,
per-process lock claims prevent the production and development servers (or an
operator drain) from spending the same attempt concurrently; later callers
remove only a stopped holder's unique claim. Each claim binds the PID to its
operating-system process generation, so PID reuse cannot make an abandoned
claim look like the original live holder.

## Escalation

If the `kb` dependency stays degraded for **2 hours** (configurable only by
code constant today), the service emits a single operational `warning` alert
(`operationalAlert.key = launch_dependency:kb`) through the normal dashboard /
webhook channel. Recovery clears the streak so a later outage can alert again.

## Safety

- Additive on the healthy path: success never touches the spool.
- Drain is content-hash idempotent; duplicates are not re-queued.
- Newly created dead-letter files and their parent-directory entry are synced
  before the active spool is rewritten. If a process stops between those
  operations, the next drain reconciles the durable dead-letter hash without
  calling `kb remember` again.
- Before trusting an existing dead-letter hash during reconciliation, the
  drain syncs that file and its directory so a merely cached record cannot be
  used to remove the active copy.
- Recovery inserts a record boundary before appending to an incomplete
  dead-letter tail, so a torn write cannot absorb the replacement JSON record.
- Spooled lessons are plaintext under `~/.kookr` — same trust boundary as hook
  logs and task state.
