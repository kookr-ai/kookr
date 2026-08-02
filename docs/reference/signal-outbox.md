# Signal outbox (issue #1541)

When the Kookr daemon is restarting or unreachable, agent→daemon signals used
to evaporate: `kookr signal completion-ready` timed out, the agent burned its
final turn reporting the failure, and the task sat in `finishedAwaitingAck`
forever. Kookr now write-behinds every signal to a durable local outbox and
replays it when the daemon is reachable again.

## Paths

| Path | Role |
|------|------|
| `~/.kookr/playbook-state/signal-outbox/pending.jsonl` | Pending signals (JSONL, one entry per line) |

The outbox is **user-scoped** (not per-port `~/.kookr-<port>`), so prod and
dev instances on the same host share one queue. Override with
`KOOKR_SIGNAL_OUTBOX_DIR`.

## Write path

1. `kookr signal <kind>` generates a client `signalId` (UUID) and **appends
   the signal to the outbox before any network attempt**.
2. Delivery is attempted immediately via
   `POST /api/tasks/:id/signal` with `{ kind, note?, signalId }`.
3. Outcomes:
   - **200** → remove this entry from the outbox; opportunistically drain any
     siblings still pending.
   - **connection / timeout / 5xx** → leave the entry; exit **0** with a
     "spooled" message so the agent does not treat it as a task failure.
   - **4xx permanent** (unknown task, terminal status, bad body) → drop the
     entry and exit 4 (the signal can never succeed).

## Replay

- **Server-side:** `SignalOutboxService` drains the outbox ~5s after boot and
  every 30s. Entries are applied in-process against the local `TaskStore`
  (no HTTP hop). Pure `signalId` replays are no-ops. `completion_ready`
  entries still run the lesson-decision gate against hook logs (issue #1608)
  before `setPendingSignal`; a rejection is `permanent_fail` (entry dropped),
  matching the CLI's treatment of HTTP 409 `lesson_decision_required` /
  `lesson_decision_hooks_missing`.
  `completion_ready` entries also run the merge-required gate (issue #1836);
  a rejection is likewise `permanent_fail`, matching HTTP 409 `merge_required`.
  Applied signals are stamped `source: "outbox"` so yield v2 can attribute
  auto-close to the `outbox_drained` completion path.
- **CLI-side:** a successful live POST also drains any remaining siblings
  against the same base URL.
- **HTTP idempotency:** the server records each processed `signalId` (24h TTL,
  capped). A re-POST of the same id returns
  `{ ok: true, idempotentReplay: true }` without re-firing outcome hooks or
  churning `raisedAt`. Same-kind re-raises without a matching id still follow
  the pre-existing #1324 merge rules.

## Bounds

| Cap | Default |
|-----|---------|
| Max pending entries | 200 |
| Max entry age | 48 hours |

Append and drain both enforce the bounds (oldest dropped first) so a long
daemon outage cannot grow the outbox unbounded.

## Safety

- Offline agents always exit 0 once the signal is spooled — never burn a turn
  on a transient connection error.
- Drain is `signalId`-idempotent; duplicates are not re-applied.
- Spooled signals are plaintext under `~/.kookr` — same trust boundary as hook
  logs and task state.
- Disable only the background service with `KOOKR_SIGNAL_OUTBOX=0`; the CLI
  outbox write path stays active.
