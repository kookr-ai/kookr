# `POST /api/tasks` Spawn Contract

The authoritative client contract for launching tasks against a Kookr server.
Clients (the `bin/kookr-spawn.js` CLI, the lucy client, and any other spawner)
**must** converge on the retry and reconciliation rules below instead of
inventing their own — that divergence is exactly what this spec exists to end
(see the [background](#background)).

This document is the spec consumed by the **client-reconcile sub-issue under the
batch delivery-idempotency umbrella #1547**: that work implements the
lucy-side reconciliation described here. Keep the two in sync — changes to the
contract land here first.

Related references:

- [API reference](./api.md) — the full route table and `POST /api/tasks` body
  fields (`idempotencyKey`, `autoCloseOnSignal`, `unattended`, …).
- [Backpressure](./backpressure.md) — the depth (429) and saturation (503)
  admission controls this contract's responses come from.

## Background

Historically each client improvised around ambiguous outcomes. `kookr-spawn`
carried a hand-rolled ambiguous path (exit non-zero, "check the dashboard before
re-running"); the lucy client's #1677 band-aid only raised its POST timeout
30s→60s and classified errors. Both predate any documented server contract. With
idempotency keys (#1529 / #1526 Phase B) and backpressure (#1536) shipped, a
single authoritative spec lets clients reconcile deterministically rather than
each re-deriving retry policy.

## Response taxonomy

A `POST /api/tasks` attempt resolves to exactly one of these classes. The class
— not the raw status alone — determines what the client does next.

| Class | Wire signal | Task created? | Client action |
| --- | --- | --- | --- |
| **Created** | `201` (or `200` with `idempotentReplay: true`) | Yes | Success. Use `task.id`. |
| **Prompt-dedup** | `200`, `{ "task", "duplicate": true }` (plus `idempotentReplay: true` on a keyed replay) | No (an active twin exists) | Reconcile to the existing task, or explicitly confirm an intentional duplicate under a new logical key. |
| **Client error** | `4xx` (e.g. `400 invalid_cwd`, `400 invalid_effort`) | No | Fix the request. **Never** retry unchanged. |
| **Backpressure** | `429` (`pending_queue_full` / `spawn_burst_limit`) | **No** | Definitive rejection — honor `Retry-After`, back off, retry (below). |
| **Saturation** | `503` (`event_loop_saturated`) | **No** ([backpressure.md INV1](./backpressure.md)) | Transient — honor `Retry-After`, back off, retry. |
| **Ambiguous** | client timeout, network drop, or `5xx` other than the 503 above | **Unknown** | Reconcile by re-POSTing with the **same idempotency key** (below). |

## Idempotency keys (#1529 / #1526 Phase B)

Send an `idempotencyKey` (≤200 chars) on **every** request you might retry. It is
the load-bearing primitive for safe reconciliation:

- The first POST carrying a key runs normal launch handling: it may create the
  task or find an active prompt duplicate.
- Any later POST with the **same** key returns the same task and preserves that
  outcome. Created-task replays use the flat task shape; prompt-duplicate
  replays retain `{ "task", "duplicate": true }`. Both include
  `"idempotentReplay": true`. This holds even for a request racing concurrently
  with the first.
- The key is a *different* mechanism from prompt+cwd+agentType dedup, which is
  defeated whenever the prompt text varies between attempts (e.g. a fresh random
  branch suffix). The key identifies the logical *request*, independent of
  prompt content.
- Durability is best-effort, not absolute — see the
  [`idempotencyKey` field notes in api.md](./api.md#post-apitasks-body-fields)
  for the ledger TTL (24h) and the narrow crash/disk-failure windows where a
  duplicate is still possible.

**A key makes re-POST safe.** Because the server replays-or-creates under the
key, a client that holds one never has to choose between "risk a duplicate" and
"give up" after an ambiguous failure — it re-POSTs and reads the result.

## Ambiguous-outcome reconciliation

An **ambiguous** outcome is any failure where the task **may or may not** have
been created: the client-side POST timeout fired, the connection dropped, or the
server returned a `5xx` after it might already have persisted the task record.

**Procedure (with an idempotency key):**

1. Re-POST the identical body — crucially, the **same `idempotencyKey`** — after
   a backoff delay.
2. Interpret the result:
   - `Created` with `idempotentReplay: true` → the first attempt *did* create the
     task; you now hold its id. Done.
   - `Created` without the replay flag → the first attempt did *not* create it;
     this POST did. Done.
   - `Prompt-dedup` → no task was created for this request. Reconcile to the
     active task, or require explicit confirmation before launching an
     intentional duplicate under a distinct, stable key.
   - Ambiguous again → repeat, up to the retry budget below.
   - `4xx` → a definitive client error; stop and surface it.
3. On exhausting the budget, stop and surface the ambiguity to the operator
   (the task's existence is still unknown; do **not** blind-retry without a key).

**Without an idempotency key** a re-POST is unsafe — it could create a sibling
task — so the client must **not** blind-retry the create. It can still reconcile
*read-only*: a bounded `GET /api/tasks` probe (issue #1573) creates nothing, so
it can never duplicate. The probe resolves the ambiguity to one of three
outcomes:

- **matched** — an active task matches this spawn's prompt + cwd (+ agent, when
  pinned). The prompt is compared after applying the server's file-reference
  normalization (existing relative paths → absolute), so a prompt naming a real
  file still matches the task the server stored. This is reported as an
  already-existing task recovered via the probe,
  **not** a fresh "created": a prompt+cwd match is *not* proof this spawn created
  it — a concurrent spawn with the same prompt+cwd matches identically. Honor
  `--dedupe=block` here; otherwise exit success with the recovered id.
- **absent** — the probe succeeded and found no match: the task was **not**
  created. Exit non-zero with an unambiguous "no task was created" message.
- **unknown** — every probe attempt errored (server unreachable): existence is
  still unverifiable. Only here does the client fall back to advising a dashboard
  check.

`--dedupe=skip` is the exception: it intends a *new* task, so a prompt+cwd match
is almost certainly a pre-existing sibling. Under skip the probe is not run and
the client reports that it could not confirm a create, pointing at
`--idempotency-key`. Always send a key when you intend to retry.

## Recommended retry policy

| Outcome | Retry? | Delay |
| --- | --- | --- |
| `Created` / `Prompt-dedup` | No | — |
| `4xx` client error | No | — |
| `429` backpressure | Yes, bounded | Honor `Retry-After` (header + `retryAfterMs` body); else exponential backoff |
| `503` saturation | Yes, bounded | Honor `Retry-After` (header + `retryAfterSeconds` body); else exponential backoff |
| Ambiguous (timeout / drop / other `5xx`) | Yes **iff a key is set**, bounded | Exponential backoff (or `Retry-After` when the 5xx carried one) |

Guidance:

- **Bound the retries.** Use a small budget (Kookr's CLI reconciles up to
  **2** re-POSTs after the first attempt) with exponential backoff, capped
  (CLI cap: 8s). Unbounded retry against a saturated server deepens the outage.
- **Honor `Retry-After` first.** When the server names a delay (429 `retryAfterMs`,
  503 `retryAfterSeconds`, or the `Retry-After` header), wait at least that long
  before the next attempt; fall back to backoff only when no hint is present.
- **Backpressure vs. saturation.** A `429` means "the queue is full / your burst
  is spent — shrink your burst"; a `503 event_loop_saturated` means "the server
  itself is overloaded — back off." Branch on the body `code`, not the status
  alone. Neither creates a task, so neither is *ambiguous*; both are
  safe to retry under the same key.

## `kookr-spawn` conformance

`bin/kookr-spawn.js` implements this contract:

- **Idempotency key.** `--idempotency-key <key>` sets it explicitly;
  `--auto-idempotency` (or `KOOKR_SPAWN_AUTO_IDEMPOTENCY`) derives a stable key
  from the spawn's identity (prompt, cwd, criteria, agent, playbook path, and
  playbook scope) so a retry replays. The CLI POST aborts at 10s while the
  server may take longer, so a key turns that timeout from a duplicate risk
  into a safe replay.
- **Confirmed duplicates.** When an operator confirms a prompt duplicate, the
  CLI derives a distinct stable key from the original key and existing task id.
  It reconciles the intentional launch under that replacement key. Because the
  server durably replays the original prompt-duplicate outcome, restarting the
  CLI repeats confirmation and reconstructs the same replacement key.
- **Ambiguous-outcome reconciliation.** On a client timeout, a network error, or
  a `5xx` response, when a key is available the CLI re-POSTs with the **same
  key** (`postTaskWithReconcile`), honoring any `Retry-After` hint, up to 2
  extra attempts, instead of exiting ambiguous. Without a key it runs the
  bounded read-only `GET /api/tasks` probe (`reconcileViaTaskProbe`, issue
  #1573) and renders `matched` / `absent` / `unknown` per the keyless section
  above — the "check the dashboard" bail is now only the last-resort `unknown`
  branch, not the default ambiguous outcome.
- **Backpressure.** A `429` is surfaced to the operator with the full capacity
  breakdown (working / awaiting-ack / hung-suspect / launching, queue depth,
  burst budget) rather than silently retried, because burst/queue limits are an
  operator signal to reduce load. Clients that *do* auto-retry `429` must honor
  `Retry-After` per the policy above.

## What the lucy client (post-#1677) must change to conform

lucy's #1677 band-aid raised its POST timeout and classified errors but does not
yet reconcile. To conform (implemented under **#1547**, not here), lucy must:

1. **Always send an idempotency key** on any POST it may retry — derived from the
   logical request identity, stable across attempts (do not embed
   attempt-varying text such as a fresh branch suffix, which would defeat both
   the key and prompt-dedup).
2. **Reconcile ambiguous outcomes** (timeout / drop / non-503 `5xx`) by
   re-POSTing with the same key and interpreting `idempotentReplay`, per
   [Ambiguous-outcome reconciliation](#ambiguous-outcome-reconciliation), rather
   than treating a timeout as a hard failure or, worse, re-POSTing without a key.
3. **Branch on `429` vs `503`** and **honor `Retry-After`** instead of applying a
   single flat timeout bump.
4. Keep retries **bounded** with backoff.

The lucy-side implementation itself is out of scope for this doc; this is its
spec.
