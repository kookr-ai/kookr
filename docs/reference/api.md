# API Reference

Kookr exposes local HTTP and WebSocket endpoints from the Hono server. In development the backend defaults to port `4801`; production-style runs default to `4800`.

## Health And Build

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | Server status, agent count, build info, and launch dependency degradation summary |
| `GET /api/health/stt` | Bundled speech-to-text container health |
| `GET /api/startup-summary` | Crash-recovery startup summary fetched once on UI mount |
| `GET /metrics` | Prometheus text exposition for request durations, circuit breakers, attention-queue suppressions, audit-sink health, aggregate auth-throttle counters, and outbound finding-webhook delivery outcomes |

### `GET /metrics`

Returns Prometheus text format (`text/plain; version=0.0.4`). On loopback
servers it is unauthenticated; when non-loopback API auth is required it accepts
owner credentials only and rejects viewer credentials.

Circuit breakers are exported as:

- `kookr_circuit_breaker_state{name,state}`: gauge, `1` for the active state
  and `0` for inactive states.
- `kookr_circuit_breaker_failures{name}`: gauge of the current recent failure
  count.
- `kookr_circuit_breaker_rejected_total{name}`: counter of calls rejected while
  the breaker was open.
- `kookr_circuit_breaker_trips_total{name}`: counter of transitions into the
  open state.

The collaboration audit sink is exported as:

- `kookr_audit_sink_writable{sink="private_network_collaboration"}`: gauge, `1`
  when the last append succeeded or no append has failed, `0` after the most
  recent append failed.
- `kookr_audit_append_failures_total{sink="private_network_collaboration"}`:
  monotonic counter of failed audit append attempts.

Prometheus metrics intentionally do not include raw audit failure reasons. Use
`GET /api/collaboration/diagnostics` for the current bounded failure detail.

The auth throttle is exported as aggregate process-local metrics:

- `kookr_auth_failed_attempts_total`: counter of failed owner-authentication
  attempts.
- `kookr_auth_throttled_attempts_total`: counter of owner-authentication
  attempts rejected while a source was throttled.
- `kookr_auth_locked_out_sources`: gauge of sources currently locked out by
  the auth throttle.

Outbound finding-webhook delivery is exported (zeros when no deliveries have
occurred yet):

- `kookr_webhook_deliveries_total{outcome="success"}`: successful POSTs.
- `kookr_webhook_deliveries_total{outcome="failed"}`: per-attempt failures
  (non-2xx, network error, or timeout).
- `kookr_webhook_deliveries_total{outcome="dropped"}`: deliveries that
  exhausted retries or hit a permanent 4xx and were not accepted by the
  receiver.

Prometheus auth-throttle metrics intentionally omit raw source labels such as
IP addresses.

## Tasks And Agents

| Endpoint | Description |
| --- | --- |
| `GET /api/tasks` | All tasks with sessions. `?view=compact` returns a lighter list projection (see below) |
| `GET /api/tasks/:id` | A single task by id — always full detail including `prompt` (404 with `{"error": "Task not found"}` for unknown ids) |
| `GET /api/tasks/completion-ready/stale` | List stale `completion_ready` signals and whether each can be auto-closed |
| `POST /api/tasks` | Create and launch a new task |
| `POST /api/tasks/:id/complete` | Mark a finished task `completed` (non-destructive), tear down its idle session, and apply the saved worktree-cleanup policy |
| `POST /api/tasks/:id/signal` | Raise an agent → user signal (e.g. `completion_ready`); schedules delayed auto-completion when the task opted into `autoCloseOnSignal` |
| `POST /api/tasks/abort` | Idempotent batch abort: cancel the given `taskIds` (with an optional operator `reason`), interrupting each live session. Returns a per-task result (`aborted`/`already_terminal`/`not_found`/`failed`) and a summary; retries are safe |
| `POST /api/tasks/:taskId/sessions/:sessionId/reconnect-transport` | Safely rebuild only Kookr's internal dtach attach child for a session — verifies the dtach master pid + socket identity, preserves the agent + master pids and the ring/subscribers, and never writes terminal input or relaunches the agent. `200` on success/inconclusive, `429` on cooldown/retry-cap, `409` on identity/socket/unknown-session, `501` if the backend has no reconnect support, `502` if the fresh attach cannot be opened |
| `DELETE /api/tasks/:id` | Stop and remove a task |
| `POST /api/agents/:id/message` | Send a message or hint to a running agent |
| `GET /api/agents/:agentId/edit-events/:toolUseId` | Fetch a recorded Edit/Write tool event for diff display |
| `GET /api/sessions/:sessionId/effective-hook-settings` | Resolved per-session hook settings |

### Task id field naming

Task objects returned by `GET /api/tasks` and `GET /api/tasks/:id` carry both
`id` and `taskId` with the same value. `taskId` is an alias added so scripts
can use one field name across the whole API — `/api/projects`
`recentTasks[]` and `/api/snapshot` agents key tasks by `taskId`. `id`
remains for backwards compatibility.

### `GET /api/tasks?view=compact`

`GET /api/tasks` defaults to the **full** list — every task carries its complete
`prompt`/`userPrompt` bodies, `criteria`, `completionDigest`, and launch
diagnostics. For a busy instance that is multiple megabytes (prod dogfood
measured ~8.7 MB for ~213 tasks), which is wasteful for a dashboard list that
only renders row-level metadata.

`?view=compact` returns a lighter projection of the same list. Each row keeps the
fields a list needs — `id`/`taskId`, `name`, `status`, `cwd`, `agentType`,
`playbookId`, `projectId`, `priority`, `parentTaskId`/`childTaskIds`,
`blocks`/`blocked_by`, `deliveryAuthorization`, `autoCloseOnSignal`,
`tokenUsage` (plus `aggregateTokenUsage` on parents),
`pendingSignal`, `issueClaim`, `ralphLoop`, the `createdAt`/`updatedAt`/
`finishedAt`/`terminatedAt` timeline, a `suppressed` flag when applicable, and a
trimmed `sessions[]` stub (`tmuxSession`, `agentType`, `lastStatus`,
`lastTurnState`, `worktreeHealth`, `lastEventAt`, `crashRecovered`,
`relaunchCount`) — and **omits** the heavy bodies: `prompt`, `userPrompt`,
`criteria`, `launchNote`, `completionDigest`, `launchHealthSummary`, and the
per-session transcript/child-session/git-identity fields.

The default (no `view` param, or any value other than `compact`) is unchanged, so
existing clients keep receiving the full list. When a client needs the full
detail for one task — e.g. to relaunch it with its original prompt — fetch
`GET /api/tasks/:id`, which always returns the complete task.

### `POST /api/tasks` body fields

`prompt` (required) and `cwd` (required) plus optional `criteria`, `parentTaskId`,
`agentType`, `effort`, `disableDedup`, `metadata`, `dependencies`, and
`autoCloseOnSignal`.

`autoCloseOnSignal` (optional, boolean) opts the task into auto-completion after
its agent's `completion_ready` signal has been pending for one hour (see
[`POST /api/tasks/:id/signal`](#post-apitasksidsignal) and the
[Auto-Close on Completion Signal](./auto-close-on-signal.md) reference). A
non-boolean value returns `400`. When omitted, the task **inherits the policy of
its `parentTaskId`**, so the behavior propagates down self-continuation chains;
set it explicitly to `false` to opt a successor out.

`cwd` must name an existing directory on the server's machine — it is
validated before any task record or session is created, and a missing or
non-directory path returns `400 {"error", "code": "invalid_cwd"}` with the
offending path in the message.

`effort` (optional, string) sets the reasoning-effort level for *this one task*,
overriding the per-agent-type default (see [Reasoning effort](#reasoning-effort)).
It is validated against the **resolved** agent's allowed set — `round-robin`
resolves to a concrete agent first — and an invalid level returns
`400 {"error", "code": "invalid_effort"}`. Allowed levels:

- `claude-code`: `low`, `medium`, `high`, `xhigh`, `max`
- `codex-cli`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`

Omitting `effort` falls back to the per-agent-type setting. For `codex-cli`,
missing or empty `agentEffort` maps pass no effort override (model-native
default). Codex model selection defaults to `gpt-5.6-sol` and can be overridden
with `KOOKR_CODEX_MODEL`. The `kookr-spawn --effort <level>` flag maps to this
field.

### `POST /api/tasks/:id/complete`

Non-destructive way to mark a finished task terminal, distinct from
`DELETE` (which removes the task) and from cancel/kill (which carries
abort semantics). Transitions an `inProgress` task to `completed` and
tears down its idle agent session through the same lifecycle handler the
dashboard's complete action uses, so projections, the schedule service,
and the coordinator all observe the terminal state. History is preserved.
The route uses the saved **Clean worktrees on completion** setting; when it is
enabled, eligible task worktrees and branches are cleaned up asynchronously
after the task is completed. The route does not provide a per-request override;
use the dashboard's completion dialog when an individual task needs a
different cleanup choice.

This is the safe path for an operator — or an orchestrating agent cleaning
up its own finished helper tasks — to clear a task that has delivered its
work but whose session is still alive (issue #691). A task completed this
way carries no completion digest, so it never surfaces as an actionable
`done_not_cleared` finding, yet it is terminal and leaves the default
actionable list like any other completed task.

Success returns `200 {"ok": true, "task": {...}}` with the task now
`completed`.

- `inProgress` → `completed`, and a `terminated` task (dead sessions
  awaiting acknowledgement) is also acked to `completed`.
- Idempotent: an already-`completed` or deliberately `cancelled` task
  returns `200 {"ok": true, "alreadyTerminal": true}`; a concurrent
  double-complete resolves to the same no-op rather than an error.
- Unknown id returns `404`.
- A task that never started (`open`/`pending`) returns
  `409 {"code": "not_in_progress"}` — delete or cancel it instead.
- A task with an active Ralph loop returns
  `409 {"code": "ralph_loop_active"}` — cancel it to stop the loop.
- Remote-owned `shared:` ids return `403`.

Worktree-lease release and pending-task promotion run on the periodic
reconcile/liveness pass rather than inline (the lease service and adapter
registry are not wired into the route layer — same as `DELETE`); the
dashboard's WebSocket complete action does both inline.

### `POST /api/tasks/:id/signal`

Raise a non-blocking agent → user signal for a task. The motivating case is
`completion_ready` — the agent declaring it believes the task is done (raised via
[`kookr signal`](./cli.md)).

Body: `kind` (required; currently `completion_ready`) and optional `note` (string;
secrets are best-effort redacted and over-limit notes are visibly truncated).

- Success returns `200 {"ok": true, "signal": {...}, "truncated": <bool>}`.
- The signal is stored on the task (`pendingSignal`) and surfaced in the
  dashboard (banner + emphasized **Complete** button). Dismiss via the
  `dismissAgentSignal` WebSocket message; it is also cleared on terminal
  transitions.
- Unknown id returns `404`; a terminal task returns `409`
  (`{"code": "task_terminal"}`); a malformed body or bad `kind`/`note` returns
  `400`; remote-owned `shared:` ids return `403`.

**Auto-close.** When the task opted into the policy (`autoCloseOnSignal` — set at
launch or inherited from its parent; see
[Auto-Close on Completion Signal](./auto-close-on-signal.md)), a `completion_ready`
signal starts a one-hour auto-close grace period. The response includes
`"autoClosed": false`, `"autoCloseScheduled": true`, and `"autoCloseAfterMs"` for
active non-Ralph tasks whose policy allows delayed close. When the signal becomes
stale, the lifecycle timer completes the task through the same lifecycle as
`POST /api/tasks/:id/complete`, freeing an active slot and promoting the next
pending task. Active Ralph loops are not swept by delayed auto-close; their
signals remain recorded for the Ralph-aware lifecycle path. Completion failures
do not fail the signal call — the signal remains recorded for manual review.

### `GET /api/tasks/completion-ready/stale`

Lists active tasks whose `completion_ready` signal is older than the configured
threshold. The endpoint is used by operators and cleanup tooling to distinguish
signals that can be auto-closed from signals that still require manual action.

Query parameters:

- `thresholdMs` (optional): minimum signal age in milliseconds. Defaults to one
  hour.

Success returns `200` with schema
`{"schema":"stale-completion-ready-tasks.v1","count":<number>,"tasks":[...]}`.
Each entry includes the task, the stored signal, `ageMs`, `canAutoClose`, and,
when `canAutoClose` is false, `manualActionRequiredReason`.

## Issue Claims

Present only when the server was started with `KOOKR_ISSUE_CLAIMS` enabled; with the flag off all three routes return `404` and clients proceed as pre-lock (RFC `rfc-issue-ownership-lock`).

| Endpoint | Description |
| --- | --- |
| `POST /api/issue-claims` | Atomically claim an issue for a task (`{repo, number, taskId, sessionId?, force?}`); `409` with a decorated owner block when held |
| `GET /api/issue-claims?repo=&number=` | List claims (one when `number` given) with `doing`/`lastActivityAt`/`ageMs` |
| `DELETE /api/issue-claims` | Holder-checked release (`{repo, number, taskId}` in the JSON body); `403` if not owner |

## Supervisor Surface

| Endpoint | Description |
| --- | --- |
| `GET /api/snapshot` | Current agent states and anomalies |
| `GET /api/queue` | Attention queue contents |
| `GET /api/anomaly-stats` | Anomaly counters and detector stats |
| `GET /api/capture/:sessionId` | Snapshot of the dtach session ring buffer |
| `GET /api/diagnostics/session-health` | Versioned cross-signal health snapshot for tracked sessions, including signal timestamps, attach state, browser bridge state, and coordinated-stall diagnostics |
| `POST /api/hook-event/:sessionId` | HTTP push surface for hook events, used by Codex CLI hooks |

### `POST /api/hook-event/:sessionId`

Push raw agent hook records into Kookr's ingestion pipeline for the Kookr
session named by `sessionId`. A request may carry one record or a framed batch
of records. This is the HTTP delivery path used by hook
writers and by `scripts/replay-hooks.ts`; the file watcher and this endpoint
feed the same ingestion service, which deduplicates dual delivery by content
hash.

`sessionId` is the Kookr terminal/session id, not necessarily the provider's
raw hook `session_id`. It must match `/^[A-Za-z0-9_-]{1,128}$/`; invalid values
return `400 {"error": "Invalid session id"}` before ingestion runs. Session ids
starting with `kookr-replay-` are treated as replay sessions and the resulting
events are tagged `origin: "replay"` internally.

Request body:

- Send one or more hook records per request. The body may be a single JSON
  object, newline-delimited hook JSON, or concatenated hook JSON objects.
- `Content-Type: application/json` is recommended, but the route reads the raw
  text body and does not currently content-negotiate.
- Common hook fields are `session_id`, `transcript_path`, `cwd`, and
  `hook_event_name`; event-specific fields such as `tool_name`, `tool_input`,
  `tool_response`, `last_assistant_message`, or `prompt` depend on the hook
  type. The supported hook names are `SessionStart`, `PreToolUse`,
  `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`,
  `PermissionRequest`, `Notification`, `UserPromptSubmit`, `SubagentStart`,
  `SubagentStop`, and `SessionEnd`.
- There is no endpoint-specific body-size limit in the route. Normal Node/Hono
  runtime limits still apply. Multi-record responses include `recordCount` and
  `dispatchedCount` in addition to the boolean `dispatched` compatibility
  field.

Example:

```bash
curl -sS -X POST "http://127.0.0.1:4801/api/hook-event/kookr-demo" \
  -H "content-type: application/json" \
  --data '{"session_id":"provider-session-1","transcript_path":"/tmp/transcript.jsonl","cwd":"/repo","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"pnpm test"}}'
```

Responses:

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{"status":"received","dispatched":true}` | The active ingestion service accepted the record and dispatched a parsed event to the adapter/monitor. |
| `200` | `{"status":"received","dispatched":false}` | The body was non-empty but did not dispatch a parsed event. This includes duplicate deliveries, unknown/dropped hook names, and malformed JSON recorded by ingestion. |
| `200` | `{"status":"received","dispatched":true,"recordCount":6,"dispatchedCount":6}` | A multi-record body was framed at the HTTP boundary and at least one record dispatched. |
| `200` | `{"status":"received"}` | Timing-only fallback used only when the route is registered without the active ingestion service. Normal server startup wires active ingestion. |
| `400` | `{"status":"empty"}` | The body was blank or whitespace-only. |
| `400` | `{"error":"Invalid session id"}` | The path parameter failed the session-id guard. |

`dispatched` is a delivery outcome, not a durable-write acknowledgement. For
activity diagnostics and malformed/deduplicated counts, use
`GET /api/tasks/:taskId/activity-diagnostics`.

## Collaboration

| Endpoint | Description |
| --- | --- |
| `GET /api/collaboration/diagnostics` | Private-network collaboration diagnostics, including listener state, trust/share counts, and audit-sink health |

### `GET /api/collaboration/diagnostics`

The `audit` object contains:

- `configured`: whether a collaboration audit sink path is configured.
- `writable`: whether the sink is currently writable, derived from the most
  recent append outcome.
- `appendFailureCount`: cumulative failed append attempts since server start.
- `lastFailure`: optional `{at, reason}` for the latest failed append.

## Projects

| Endpoint | Description |
| --- | --- |
| `GET /api/projects` | Tracked project directories |
| `POST /api/projects/track` | Register a project directory |
| `POST /api/projects/untrack` | Remove a tracked project |
| `GET /api/projects/contributions` | Contributions summary across projects |
| `GET /api/projects/configs` | Per-project configuration |
| `POST /api/projects/configs` | Update a project's configuration |
| `GET /api/projects/discovery-status` | Background project-discovery progress, warnings, cache status, and per-project scan reasons |
| `POST /api/projects/rescan-skills` | Re-scan skill-tracked repos, skipping unchanged recon manifests and returning per-project scan reasons |

## Playbooks And Schedules

| Endpoint | Description |
| --- | --- |
| `GET /api/playbooks?cwd=` | Discover playbooks at a CWD |
| `GET /api/schedules` | List scheduled tasks |
| `POST /api/schedules` | Create a scheduled task |
| `POST /api/schedules/preview` | Preview next-run timestamps for a candidate schedule |
| `PATCH /api/schedules/:id` | Update a schedule |
| `DELETE /api/schedules/:id` | Delete a schedule |
| `POST /api/schedules/:id/run` | Trigger a scheduled task immediately |

## Reflection And Telemetry

| Endpoint | Description |
| --- | --- |
| `GET /api/reflect` | Analyze session friction patterns |
| `GET /api/reflect/recommendation` | Top-priority reflection recommendation for the UI banner |
| `GET /api/telemetry/report` | Aggregated telemetry over the session log |
| `GET /api/shadow-report` | Shadow-detection comparison report, with `?format=text` for plain text |

## GitHub

| Endpoint | Description |
| --- | --- |
| `GET /api/github` | All tracked tasks' PR and issue state |
| `GET /api/github/status` | GitHub scanner status |
| `GET /api/github/:taskId` | PR or issue state for one task |

## Settings And Infrastructure

| Endpoint | Description |
| --- | --- |
| `GET /api/settings` | Get user and project settings |
| `PUT /api/settings` | Update settings |
| `GET /api/circuit-breakers` | Snapshots of wrapped-dependency breakers |
| `GET /api/admin/log-level` | Current runtime log level and TTL override state |
| `POST /api/admin/log-level` | Change the running server's log level, optionally with an auto-revert TTL |
| `GET /api/admin/operational-alert-config` | Current runtime operational alert thresholds and boot defaults |
| `POST /api/admin/operational-alert-config` | Update operational alert thresholds for the running process |
| `GET /api/admin/operational-alerts` | Recent operational alert fire/recovery history for admin introspection |
| `GET /api/admin/drain` | Current drain/resume state and running-task count |
| `POST /api/admin/drain` | Enter drain mode, refusing new task launches while running agents continue |
| `POST /api/admin/resume` | Leave drain mode and accept new task launches |
| `GET /api/diagnostics/launch-dependencies` | Aggregates degraded launch dependencies by dependency and category, including affected task IDs and last occurrence times |
| `GET /api/diagnostic` | Latest self-diagnostic report and last error |
| `POST /api/diagnostic/run` | Trigger a self-diagnostic run |
| `GET /api/oss-attempts` | OSS contribution-attempt store snapshot |
| `POST /api/oss-attempts/refresh` | Refresh PR and issue state for tracked OSS attempts |
| `POST /api/oss-attempts/events` | Record an OSS attempt event, used by hooks |
| `GET /api/deploy/status` | Production-update job status plus user-global toolkit symlink freshness |
| `POST /api/deploy/trigger` | Trigger a `pnpm prod:update` job |
| `POST /api/deploy/toolkit-refresh` | Reinstall user-global Kookr hooks/toolkit symlinks from the production worktree |

### Reasoning effort

`agentEffort` is a per-agent-type map in settings (`~/.kookr/settings.json`,
editable in the dashboard's Settings → Task Management) that sets the default
reasoning-effort level spawned agents launch at:

```json
{ "agentEffort": { "claude-code": "high", "codex-cli": "medium" } }
```

When set, the adapter launches `claude-code` with `--effort <level>` and
`codex-cli` with `-c model_reasoning_effort="<level>"`. Allowed levels are
agent-specific (`claude-code`: `low|medium|high|xhigh|max`; `codex-cli`:
`none|minimal|low|medium|high|xhigh|max|ultra`); invalid `(agent, level)` pairs
are dropped on save with a warning. Kookr defaults Codex tasks to `gpt-5.6-sol`
with no effort override (model-native default). Override the model with
`KOOKR_CODEX_MODEL` (for example `gpt-5.6-luna`). If `agentEffort` is missing,
empty, or lacks a `codex-cli` entry, no effort flag is passed. An explicit
`ultra` request always selects the Sol model because Luna does not advertise
`ultra`. A per-task `effort` on `POST /api/tasks` (or `kookr-spawn --effort`)
overrides the settings default for one launch. Resolution order: per-task
override → per-agent-type setting → unset (CLI/model default). Stock binaries
skip fork-only model and effort overrides.

### Admin / runtime control

`/api/admin/*` routes tune and inspect a running Kookr server without a restart.
Loopback requests are trusted. Non-loopback callers must pass the normal owner
API authentication for the server and also send `x-kookr-admin-token: <token>`
matching `KOOKR_ADMIN_TOKEN`. Requests that reach an admin route without the
admin token return `403 {"error":"admin-forbidden"}`.

#### `GET /api/admin/log-level` and `POST /api/admin/log-level`

`GET /api/admin/log-level` returns:

```json
{
  "level": "info",
  "default": "info",
  "ttlExpiresAt": null
}
```

`level` is the active runtime level. `default` is the level seeded at boot from
`KOOKR_DEBUG`. `ttlExpiresAt` is an ISO timestamp when a TTL override is active,
or `null` when the current level is sticky.

`POST /api/admin/log-level` accepts:

```json
{ "level": "debug", "ttlSeconds": 300 }
```

Valid levels are `error`, `warn`, `info`, and `debug`. `ttlSeconds` is optional:
omit it for a sticky runtime change, or pass a positive number of seconds to
auto-revert to `default`. Sub-second and non-positive TTLs are rejected, and TTLs
longer than 24 hours are capped at 24 hours. Success returns the same shape as
`GET`; invalid JSON returns `400 {"error":"invalid-json"}`, and validation
failures return `400` with `error` (`invalid-level` or `invalid-ttl`) and
`validLevels`.

Example:

```bash
curl -fsS -X POST http://127.0.0.1:4800/api/admin/log-level \
  -H 'content-type: application/json' \
  --data '{"level":"debug","ttlSeconds":300}'
```

#### `GET /api/admin/operational-alert-config` and `POST /api/admin/operational-alert-config`

`GET /api/admin/operational-alert-config` returns the live thresholds and the
boot defaults seeded from `KOOKR_ALERT_*` environment variables:

```json
{
  "config": {
    "cpuPercent": 0,
    "memoryPercent": 0,
    "eventLoopDelayMs": 0,
    "processRssBytes": 0,
    "dataDirectoryFreePercent": 5,
    "dataDirectoryFreeBytes": 2147483648,
    "circuitBreakerOpenMs": 30000,
    "sustainSamples": 3
  },
  "default": {
    "cpuPercent": 0,
    "memoryPercent": 0,
    "eventLoopDelayMs": 0,
    "processRssBytes": 0,
    "dataDirectoryFreePercent": 5,
    "dataDirectoryFreeBytes": 2147483648,
    "circuitBreakerOpenMs": 30000,
    "sustainSamples": 3
  }
}
```

`POST /api/admin/operational-alert-config` accepts a partial object with one or
more known fields: `cpuPercent`, `memoryPercent`, `eventLoopDelayMs`,
`processRssBytes`, `dataDirectoryFreePercent`, `dataDirectoryFreeBytes`,
`circuitBreakerOpenMs`, and `sustainSamples`. Threshold fields must be finite numbers greater than or
equal to zero. `sustainSamples` must be an integer greater than or equal to one.
Unknown fields are ignored, but at least one known field must be present.
Success returns the same shape as `GET`; validation failures return `400` with
`error`, `field` when applicable, and `validFields`.

Example:

```bash
curl -fsS -X POST http://127.0.0.1:4800/api/admin/operational-alert-config \
  -H 'content-type: application/json' \
  --data '{"cpuPercent":90,"sustainSamples":2}'
```

#### `GET /api/admin/operational-alerts`

The response is an in-memory ring buffer of recent operational alert fire and
recovery events:

```json
{
  "generatedAt": "2026-05-13T00:02:00.000Z",
  "limit": 100,
  "alerts": [
    {
      "id": 1,
      "key": "resource:cpu",
      "metric": "cpu",
      "firstFiredAt": "2026-05-13T00:00:00.000Z",
      "lastFiredAt": "2026-05-13T00:00:00.000Z",
      "recoveredAt": "2026-05-13T00:01:00.000Z",
      "active": false,
      "fireCount": 1,
      "alert": { "type": "alert", "severity": "warning" },
      "recoveryAlert": { "type": "alert", "severity": "info" }
    }
  ]
}
```

#### `GET /api/admin/drain`, `POST /api/admin/drain`, and `POST /api/admin/resume`

`GET /api/admin/drain` returns whether the server accepts new launches and how
many tasks are currently running:

```json
{
  "accepting": true,
  "draining": false,
  "runningTasks": 0
}
```

`POST /api/admin/drain` enters drain mode. New task launches are refused, but
running agents continue. `POST /api/admin/resume` leaves drain mode and accepts
launches again. Both POST routes return the drain state plus `changed`, which is
`false` for idempotent no-op calls:

```json
{
  "accepting": false,
  "draining": true,
  "since": "2026-05-13T00:00:00.000Z",
  "runningTasks": 2,
  "changed": true
}
```

## WebSocket

| Endpoint | Description |
| --- | --- |
| `ws://host:port/ws` | Real-time updates, snapshots, alerts, and suggestions |
| `ws://host:port/ws/terminal/:sessionId` | Interactive terminal bridge using binary frames over the dtach session |

### WebSocket message protocol

The `/ws` channel carries UTF-8 JSON objects. Every application message has a
string `type` discriminator. Unknown or malformed client messages are rejected
with an `alert` frame instead of being routed to a handler. The
`/ws/terminal/:sessionId` channel is separate and uses binary terminal frames;
the message tables below apply only to `/ws`.

Inbound messages are limited to 1,000,000 bytes on `/ws` and 8,000,000 bytes on
`/ws/terminal/:sessionId`. The server closes connections that exceed the
applicable limit with WebSocket close code `1009`.

On connect, the server sends a full `snapshot` first. Owner sessions may then
receive startup alerts and the latest optional side-channel state
(`resourceStatus`, `githubUpdate`, `projectSummaries`, `quotaStatus`,
`circuitBreakerStatus`, `diagnosticReport`) when those stores have data.
Read-only viewer sessions receive only a scope-filtered `snapshot` plus
scope-filtered `projectSummaries`.

There is no client-supplied resume cursor. Reconnect by opening a new `/ws`
connection and treating the first `snapshot` as the baseline. Later
`snapshot` frames replace the dashboard baseline, while `update` frames refresh
one agent state and other frames update their named subsystem. `serverRevision`
is an optional remote-control-plane revision on `snapshot`, not a general
delta sequence number.

### Server-to-client messages

| `type` | Purpose | Key fields |
| --- | --- | --- |
| `snapshot` | Full dashboard baseline on connect and after broad state changes. | `agents`, `serverCwd`, optional build/speech/achievement/task relation/workspace fields including `sweepRunning` and `sweepProgress` |
| `update` | Refresh one agent's current state. | `agentId`, `state` |
| `alert` | Surface an anomaly, validation error, or handler error. | `agentId`, `summary`, `details`, `severity`, optional `operationalAlert` `{ key, metric, state }` for operational alert fire/recovery events |
| `githubUpdate` | Push GitHub PR/issue state for one task. | `taskId`, `prs`, `issues`, `changes` |
| `playbooks` | Return playbook discovery results for a cwd. | `cwd`, `playbooks`, optional `capabilities` |
| `suggestion` | Suggest operator replies or quick actions for an agent. | `agentId`, `suggestionId`, `suggestions`, `quickActions` |
| `projectSummaries` | Update the project sidebar summary list. | `projects` |
| `coordinator.snapshot` | Update coordinator findings, chips, outputs, and chains. | `coordinator` |
| `dashboardSelection` | Acknowledge or broadcast the active dashboard selection for this connection. | `selectedTaskId`, `selectedSessionId`, `selectionVersion` |
| `emptyEnterDecision` | Return the server decision for an empty terminal Enter intent. | `decision` |
| `contributionWarning` | Warn that a project's contribution attempt budget is near or past a limit. | `project`, `message`, `severity` |
| `achievement:unlocked` | Notify the UI that an achievement was unlocked. | `id`, `name`, `emoji`, `description`, `unlockedAt` |
| `achievement:reset:ack` | Acknowledge an achievement reset request. | `success`, optional `error` |
| `quotaStatus` | Push current Claude API quota window utilization. | `quota` |
| `resourceStatus` | Push sampled server-host CPU, memory, and event-loop status. | `status` |
| `circuitBreakerStatus` | Push wrapped-dependency circuit breaker snapshots. | `breakers` |
| `schedules` | Push scheduled-task list state. | `schedules`, `revision`, `status` |
| `scheduleFired` | Notify that a schedule launched a task. | `scheduleId`, `taskId` |
| `workspaceView` | Return contribution-workspace candidates and cleanup results. | `view`, optional `error`, `cleanupResult`, `cleanupResults`, `diagnosticLaunch` |
| `workspaceCleanupDetail` | Return detail for a cleanup candidate worktree. | `worktreePath`, optional `detail`, `error` |
| `worktreeCleanupVerdicts` | Whether each worktree a task owns can be removed on completion, and why not. Same inspection the completion cleanup runs. | `taskId`, `verdicts`, optional `error` |
| `workspaceSweepProgress` | Broadcast live cross-project cleanup sweep progress. | `runId`, `startedAt`, `index`, `total`, `projectId`, `status`, `counts`, optional `result` |
| `workspaceBulkRemoveProgress` | Broadcast per-row progress of a Probably-safe bulk reclaim (remove path, keep branch). | `runId`, `index`, `total`, `projectId`, `worktreePath`, `status`, optional `result` |
| `workspaceSweepComplete` | Report completion of a cross-project cleanup sweep. | `runId`, `startedAt`, `finishedAt`, `projects`, optional disk-aware `report` |
| `workspaceSweepBusy` | Report that another cleanup sweep already holds the lock. | `holderPid`, `heldSince` |
| `workspaceSweepReport` | Reconstructed Removed/removal-failed sweep manifest from the durable ledger (reconnect-after-completion). | `runId`, optional `report` |
| `diagnosticReport` | Push the latest self-diagnostic report when findings exist. | `report` |
| `ossAttempts` | Push OSS contribution-attempt store state and refresh status. | `store`, optional `refreshStatus` |

### Client-to-server messages

| `type` | Purpose | Key fields |
| --- | --- | --- |
| `respond` | Send input to an agent that needs a response. | `agentId`, `input` |
| `respondAll` | Send the same input to multiple agents. | `agentIds`, `input` |
| `directReply` | Inject a direct reply into a running agent. | `agentId`, `input` |
| `navigate` | Record navigation to an agent. | `agentId` |
| `getNext` | Request the next task from the attention queue. | none |
| `selectionChanged` | Tell the server which task/session this connection selected. | `selectedTaskId`, `selectedSessionId` |
| `emptyEnterIntent` | Ask the server whether an empty terminal Enter should advance or send Enter. | `intentId`, `taskId`, `sessionId`, `selectionVersion`, `inputStateEpoch`, `observedReadinessVersion` |
| `skip` | Skip the current finding for one agent. | `agentId` |
| `skipAll` | Skip findings for multiple agents. | `agentIds` |
| `snooze` | Snooze monitoring or attention for an agent. | `agentId`, `durationMs`, optional `taskId`, `reason`, `resumeMonitoring` |
| `cancelSnooze` | Wake a snoozed agent. | `agentId`, optional `taskId` |
| `launch` | Launch a new task. | `prompt`, `cwd`, optional `criteria`, `agentType`, `dependencies` |
| `completeTask` | Mark a task complete, optionally with feedback, reflection request, or worktree cleanup override. | `taskId`, optional `feedback`, `requestReflect`, `cleanupWorktree` |
| `setTaskFeedback` | Save feedback for an existing task. | `taskId`, `feedback` |
| `requestTaskReflect` | Start task reflection from thumbs-up/down feedback. | `taskId`, `direction` |
| `requestTaskSnapshotReflect` | Start an anytime task snapshot reflection, with an optional free-text hint to steer the analysis. | `taskId`, optional `hint` |
| `relaunch` | Relaunch an existing task with a new prompt. | `taskId`, `prompt`, optional `agentType`, `dependencies` |
| `cancelTask` | Cancel a task and terminate its session. | `taskId` |
| `batchAbortTasks` | Idempotently abort multiple tasks at once, interrupting each live session; broadcasts a concise result summary. | `taskIds`, optional `reason` |
| `reopenTask` | Reopen a terminal task. | `taskId` |
| `dismissAgentSignal` | Dismiss a surfaced agent signal. | `taskId` |
| `deleteTask` | Delete a task. | `taskId` |
| `renameTask` | Rename a task. | `taskId`, `name` |
| `setTaskPriority` | Change a task's priority. | `taskId`, `priority` |
| `stop` | Stop an agent session. | `agentId` |
| `reflect` | Launch session-friction reflection. | none |
| `listPlaybooks` | Discover playbooks for a cwd. | `cwd` |
| `launchPlaybook` | Launch a playbook. | `playbookPath`, `parameterValues`, legacy `cwd` or `playbookSourceCwd` plus `taskTargetCwd`, optional `agentType`, `scope`, `projectId` |
| `telemetry` | Send frontend telemetry events. | `events` |
| `setProjectConfig` | Update a tracked project's configuration. | `project`, `config` |
| `clearCompleted` | Clear completed tasks, optionally including terminated tasks or scoping to a project. | optional `includeTerminated`, `projectId` |
| `ackTerminatedTask` | Acknowledge a terminated task as complete. | `taskId` |
| `achievement:reset` | Reset achievement state. | none |
| `achievement:setEnabled` | Enable or disable achievement tracking. | `enabled` |
| `permissionChoice` | Send a keystroke decision for a pending permission request. | `agentId`, `keystroke`, `permissionRequest` |
| `rearmCircuitBreaker` | Rearm a named circuit breaker. | `name` |
| `findingFeedback` | Mark a surfaced finding as a false positive. | `agentId`, `anomalyType`, `explanation`, `verdict`, optional `userReason` |
| `missedFinding` | Report a finding the supervisor missed. | `agentId`, `userReason`, optional `suspectedType` |
| `workspace:getView` | Request contribution-workspace state for a project. | `projectId` |
| `workspace:getCleanupDetail` | Request cleanup detail for one worktree. | `projectId`, `worktreePath` |
| `workspace:cleanupCandidate` | Clean up one workspace candidate. | `projectId`, `worktreePath`, optional `branch`, `repoPath`, `deleteBranch`, `riskAccepted`, `discardDirtyState`, `reviewFingerprint` |
| `workspace:bulkSafeCleanup` | Clean up all safe workspace candidates for a project. | `projectId` |
| `workspace:runCleanupDiagnostic` | Launch a cleanup diagnostic for one worktree. | `projectId`, `worktreePath`, `reviewFingerprint` |
| `workspace:sweep` | Run a cross-project workspace cleanup sweep. | none |
| `workspace:requestSweepReport` | Request reconstruction of a completed sweep's Removed manifest from the ledger. | `runId` |
| `workspace:bulkRemoveProbablySafe` | Bulk-remove selected Probably-safe worktree paths, keeping their branches. | `rows` (each `projectId`, `worktreePath`, `branch`, optional `fingerprint`) |
| `worktree:inspectCleanup` | Ask whether this task's worktrees can be removed. Read-only; replies with `worktreeCleanupVerdicts`. | `taskId` |

## Data Directory

Kookr stores local state by port:

- Port `4800`: `~/.kookr/`
- Other ports: `~/.kookr-<port>/`
