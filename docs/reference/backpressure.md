# Server-side backpressure (issue #1526 Phase C / C3)

During the 2026-07-24 deadlock, `POST /api/tasks` accepted unbounded creation:
every over-cap launch silently pended, so a runaway burst looked successful to
the caller while its tasks starved forever (FM3) — and every freed slot was
instantly refilled by FIFO promotion of same-posture pendings, re-wedging the
cap (FM11). This page documents the mechanisms that make the server say
"no" honestly instead.

Sections 1–4 are **depth-based**: they measure the pending queue / creation
rate and reject with **429**. Section 5 is **load-based** (issue #1590): it
measures the server's event-loop lag and sheds with **503** when the process
is saturated — an orthogonal axis, because a wedged event loop hangs a spawn
POST regardless of how empty the queue is.

The settings for sections 1–4 live in the normal settings store
(`GET/PUT /api/settings`) and are read through live getters — a change applies
without a restart. The section 5 thresholds are environment variables
(`KOOKR_ADMISSION_*`, read at startup).

| Setting | Default | Range | Purpose |
| --- | --- | --- | --- |
| `maxPendingTasks` | 24 | 4–200 | Pending-queue depth limit |
| `pendingTaskTtlMinutes` | 240 | 15–2880 | Max time a task may starve in `pending` |
| `spawnBurstLimit` | 30 | 5–500 | Per-source creations per window |
| `spawnBurstWindowMinutes` | 10 | 1–120 | Sliding window for `spawnBurstLimit` |
| `reservedActiveSlots` | 2 | 0–12 | Active slots reserved for privileged sources |
| `reservedSlotSources` | `['kookr']` | list | Sources/actors that may consume reserved slots |

## 1. Pending-queue depth limit (`maxPendingTasks`)

When a launch would pend at capacity (active count ≥ `maxActiveTasks`) AND the
pending count is already ≥ `maxPendingTasks`, the launch is **rejected before
any task record is created**:

- **REST** (`POST /api/tasks`): HTTP **429**, body
  `{ error, code: "pending_queue_full", capacity, maxPendingTasks }`. The
  `capacity` field is the same capacity-ledger snapshot `GET /api/health`
  exposes (`maxActiveTasks`, `active`, `free`, `byClass` breakdown of
  working / finishedAwaitingAck / hungSuspect / launching,
  `pendingQueueDepth`, oldest ages) so the caller can render *why*.
- **WebSocket** (dashboard launch/relaunch/playbook): an `alert` with the same
  breakdown in `details`, severity `warning`.
- **CLI** (`kookr spawn`): renders the breakdown on stderr and exits non-zero
  (exit 4, `SERVER_ERROR`); `--json` mode carries the full body under
  `details.backpressure`.
- **Schedule fires**: recorded in the schedule's execution ledger as
  `dispatch_failed` with the distinct reasonCode **`pending_queue_full`** —
  never silently dropped. (The Phase A coalescing rule still applies first: a
  schedule with a fire already queued records `skipped_coalesced` and never
  reaches the depth limit.)

Below capacity, or below the depth limit, behavior is unchanged (launch or
quietly pend, respectively).

## 2. Pending-task TTL (`pendingTaskTtlMinutes`)

The depth limit bounds how much starving work can accumulate; the TTL bounds
how *long* any one entry can starve. On the liveness tick, a task that has
been `pending` for ≥ the TTL without ever launching (zero sessions, no fresh
launch reservation) is expired:

- transition `pending → cancelled` (existing terminal status — the same one
  the promotion loop's failure path uses);
- interaction-log `task_cancelled` row with structured reason
  `pending_ttl_expired` (not `user_cancelled`);
- one `audit.jsonl` row, actor **`system:pending-ttl`** (the Phase A
  `system:completion-ready-ttl` / `system:hung-task-reaper` convention), with
  `pendingForMs`, the effective TTL, and `parentTaskId` when set;
- issue-claim release, attention-queue purge, `onTaskOutcome('cancelled')`;
- one summary `alert` per sweep (severity `warning`), not one per task.

**Parented/chain tasks are NOT exempt.** A queued child (`parentTaskId` set)
of a live parent expires exactly like a detached task — a starving successor
holds queue depth just the same. A self-continuation chain that relies on a
queued successor must treat the `cancelled` outcome as "respawn me": the
audit row and the `onTaskOutcome` notification both carry the task id, and an
idempotency-key relaunch is safe (a terminal task that never ran **and carries
no disposition** is deliberately not replayed — see Phase B's
`isReplayableTask`; issue #1588 makes disposed pre-session tasks replayable, but
a pending-TTL `cancelled` task carries no disposition, so this case is
unchanged).

## 3. Per-source spawn budget (`spawnBurstLimit` / `spawnBurstWindowMinutes`)

Sliding-window rate limit on task **creation**, bucketed per launch source
(`cli`, `api`, `ui`, `websocket`, `remote-chat-telegram`, `remote-relay`).
When the Phase B `X-Kookr-Actor` header is present on `POST /api/tasks`, the
bucket is actor-qualified (`api:actor:lucy-supervisor`), so an attributed
supervisor burns its own budget instead of sharing — or exhausting — the
anonymous `api` bucket.

Exceeding the budget rejects with the same 429-with-ledger shape under the
distinct code **`spawn_burst_limit`**, plus `source`, `limit`, `windowMs`,
`retryAfterMs`, and a `Retry-After` header. A rejected attempt does not burn
budget, so a backed-off caller recovers as soon as the window slides.

**Schedule-fired launches are exempt** (`launchSource: 'schedule'`), on
purpose: schedules are operator-configured cadence already bounded by
per-schedule coalescing (at most one outstanding queued fire, Phase A) and
watched by the dead-man starvation switch (Phase C). A "burst" of schedule
fires means schedule configuration, not a runaway caller — rate-limiting them
would convert planned periodic work into `dispatch_failed` noise while the
real fix is editing the schedules. Dedup / idempotent replays also consume no
budget (they create nothing).

The limiter is in-memory; a restart resets every window (errs toward
accepting work, same trade as launch reservations).

## 3a. Reserved self-maintenance slots (`reservedActiveSlots`, issue #1564)

Capacity — not architecture — is the binding constraint on kookr self-drain:
`maxActiveTasks` was saturated by ~30 ad-hoc parent-spawned lucy tasks on
2026-07-26, and the last "Lucy parallel issue batch" run ended
`skipped_capacity`. Sections 1–3 bound how *fast* and how *much* any one source
can create; they do not guarantee that kookr self-maintenance can ever get a
slot when another source is at capacity. This reservation does.

`reservedActiveSlots` (default **2**, range 0–12) is the number of
`maxActiveTasks` slots held back for **privileged** launch sources. A launch is
privileged when its `launchSource` **or** its attributed `launchActorId`
(the `X-Kookr-Actor` header) matches an entry in `reservedSlotSources` (default
`['kookr']`, so kookr self-maintenance batches attribute as actor `kookr`).

- A **privileged** launch (e.g. actor `kookr`) is admitted while
  `active < maxActiveTasks` — it can consume the reserved slots.
- A **non-privileged** launch (e.g. a lucy burst) is admitted only while
  `active < maxActiveTasks - reservedActiveSlots`; at or above that it **pends**
  through the normal at-capacity path instead of taking a reserved slot.

So even when a lucy burst has saturated its share, `reservedActiveSlots` slots
remain available and a kookr batch spawn still launches immediately.

The reservation is **observable** in the `GET /api/health` capacity ledger,
which gains four fields whenever a reservation is configured:
`reservedActiveSlots`, `reservedSlotSources`, `freeForReservedSources`
(= `free`, the whole pool), and `freeForGeneralSources`
(`maxActiveTasks - reservedActiveSlots - active`, floored at 0). When
`freeForGeneralSources` hits 0 while `freeForReservedSources` is still positive,
the reservation is actively protecting kookr headroom. The same block rides
along on the `capacity` snapshot in `pending_queue_full` / `spawn_burst_limit`
429 bodies. Setting `reservedActiveSlots: 0` disables the reservation (all
sources share the full pool, prior behavior). The effective reservation is
additionally clamped to `maxActiveTasks` at read time, so it can never exceed
the pool.

## 4. Promotion posture guard (anti-re-wedge, FM11)

`promotePendingTasks` picks FIFO by `createdAt` — unchanged whenever more
than one slot is free. When a promotion would fill the **last** free slot,
the pick prefers (stable-sort first — never skips) pendings that can
**self-release** the slot:

- `autoCloseOnSignal: true` tasks (auto-complete after the completion-ready
  grace period), or
- schedule-fired tasks (`metadata.launchSource === 'schedule'` — supervised
  by schedule coalescing/staleness/dead-man recovery).

Ask-first / no-autoclose tasks park in `finishedAwaitingAck` until a human
clicks — promoting one into the last slot is exactly how the incident's cap
re-wedged. This is a pure ordering preference with **no starvation**: if only
ask-first tasks are pending, the oldest still promotes into the last slot.

## 5. Event-loop saturation admission (`KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS`)

Sections 1–4 all measure the **queue**. But during CPU saturation
(2026-07-25/26: batch dd1fbcec's wave-2 spawns, lucy #1654's eight
"Kookr task POST failed … timeout" lines in 24h) a spawn POST hung into a
client timeout even though the queue was fine — a wedged event loop cannot
service the request at all. Depth limits do not help: the request never gets
far enough to be counted.

Load-based admission closes that gap. On every `POST /api/tasks`, **before the
body is parsed or any task record is created**, the handler reads the
already-sampled server event-loop delay p95 — the same
`SystemResourceStatus.server.eventLoopDelayP95Ms` the health snapshot and the
`KOOKR_ALERT_EVENT_LOOP_DELAY_MS` alert consume (one `monitorEventLoopDelay`,
refreshed ~every 2s; no second monitor). When that p95 is **at or above**
`KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS`, the request is shed:

- **REST** (`POST /api/tasks`): HTTP **503**, `Retry-After` header, body
  `{ error, code: "event_loop_saturated", observedEventLoopDelayP95Ms,
  thresholdMs, retryAfterSeconds }`. The distinct **503 / `event_loop_saturated`**
  pair is how a client tells this apart from the section 1–3 depth **429s**
  (`pending_queue_full` / `spawn_burst_limit`): a 429 means "the queue is full,
  shrink your burst"; a 503 means "the server itself is overloaded, back off and
  retry after `Retry-After`". Because the check short-circuits ahead of body
  parsing and the launch path, the rejection returns in well under the ≤2s
  fast-fail budget instead of hanging.

| Setting | Default | Range | Purpose |
| --- | --- | --- | --- |
| `KOOKR_ADMISSION_EVENT_LOOP_DELAY_MS` | 1000 | ≥0 ms, `0` disables | Event-loop p95 lag at/above which spawn POSTs are shed with 503 |
| `KOOKR_ADMISSION_RETRY_AFTER_SECONDS` | 2 | integer ≥1 | `Retry-After` hint on the 503 |

The default threshold sits far above steady-state p95 (single-digit ms) so the
gate does not fire in normal operation; `0` disables it entirely. The gate
**fails open** — if the p95 sample is unavailable (before the first sample, or
when the sampler reports `event_loop_unavailable`), the POST proceeds. A missing
metric must never become a spurious rejection.

### Invariants (issue #1590 invariant gate)

This gate touches admission/concurrency semantics; its load-bearing invariants,
each covered by a test in `src/server/task-admission.test.ts` (unit + property)
and `src/server/routes/task-routes.test.ts` (route):

- **INV1** — p95 ≥ threshold ⇒ 503 + `Retry-After`, and **no** task record is
  created (`launchTask` is never called).
- **INV2** — p95 < threshold ⇒ behavior is unchanged (the existing #1529/#1536
  paths still run; below-threshold POSTs launch normally).
- **INV3** — the 503 body's `code` is `event_loop_saturated`, distinct from the
  depth 429 codes, so clients can branch on it.
- **INV4** — the gate fails open when disabled (`threshold ≤ 0`) or when the
  saturation signal is missing/non-finite.

## Error shape summary

```jsonc
// 429, code "pending_queue_full"
{
  "error": "Pending queue is full (24/24 queued, 10/10 active) — …",
  "code": "pending_queue_full",
  "capacity": { "maxActiveTasks": 10, "active": 10, "free": 0,
                "byClass": { "working": 2, "finishedAwaitingAck": 7,
                              "hungSuspect": 1, "launching": 0 },
                "pendingQueueDepth": 24, "oldestPendingAgeMs": 123456,
                "oldestFinishedAwaitingAckAgeMs": 654321 },
  "maxPendingTasks": 24
}

// 429, code "spawn_burst_limit" (+ Retry-After header)
{
  "error": "Spawn burst limit reached for source \"api:actor:lucy\" — …",
  "code": "spawn_burst_limit",
  "capacity": { /* same ledger shape */ },
  "source": "api:actor:lucy",
  "limit": 30,
  "windowMs": 600000,
  "retryAfterMs": 421337
}

// 503, code "event_loop_saturated" (+ Retry-After header) — load-based (§5)
{
  "error": "Server saturated: event-loop delay p95 1450.0ms >= threshold 1000ms. Retry after 2s. …",
  "code": "event_loop_saturated",
  "observedEventLoopDelayP95Ms": 1450,
  "thresholdMs": 1000,
  "retryAfterSeconds": 2
}
```
