# Lesson-write spool (issue #1519)

When the knowledge-base (`kb`) dependency is degraded, agent lesson writes used
to evaporate: `kb remember` failed, the playbook moved on, and the
`agent-task-lessons` flywheel went dark. Kookr now write-behinds those lessons
to a durable local spool and replays them when KB recovers.

## Paths

| Path | Role |
|------|------|
| `~/.kookr/playbook-state/lesson-write-spool/pending.jsonl` | Pending lesson bodies (JSONL, one entry per line) |
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
  `kb remember … --force --no-check-similar`.
- Operator: `kookr lesson drain` (idempotent; re-running an empty spool is a
  no-op). `kookr lesson status` shows pending entries and the degradation
  streak.

## Escalation

If the `kb` dependency stays degraded for **2 hours** (configurable only by
code constant today), the service emits a single operational `warning` alert
(`operationalAlert.key = launch_dependency:kb`) through the normal dashboard /
webhook channel. Recovery clears the streak so a later outage can alert again.

## Safety

- Additive on the healthy path: success never touches the spool.
- Drain is content-hash idempotent; duplicates are not re-queued.
- Spooled lessons are plaintext under `~/.kookr` — same trust boundary as hook
  logs and task state.
