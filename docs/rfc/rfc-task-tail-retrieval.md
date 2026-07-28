# RFC: Task Tail Retrieval for Completed Tasks

**Status:** Accepted (implementation follows)
**Date:** 2026-07-23
**Author:** Kookr agent (kookr/add-task-tail-retrieval-for-completed-ta-jchc)

---

## Problem

Once a Kookr task reaches a terminal status (`completed`, `terminated`, `cancelled`), session cleanup stops the dtach-backed terminal and **deletes the ring buffer**. After that:

- `GET /api/capture/:sessionId` returns 404 (no live ring).
- Lucy's `peek_kookr_task_output` tool (which calls `/api/capture/:sessionId` after resolving the task's latest session) cannot show what the agent printed.
- Operators who open a finished task hours or days later have no durable terminal excerpt — only the structured `completionDigest`, activity ledger, and hook JSONL (which is not a readable terminal tail).

Running tasks work fine: `captureDisplay` reads the in-memory / on-disk ring. The gap is **post-completion durability**.

## Goals

1. Retrieve a bounded terminal tail for **completed** tasks for a configurable retention window (default **7 days**).
2. Single HTTP surface that works for **both** in-progress and completed tasks: `GET /api/tasks/:id/tail?lines=N`.
3. Preserve Lucy compatibility: existing `peek_kookr_task_output` → `/api/capture/:sessionId` continues to work for completed sessions when a persisted tail exists.
4. Session cleanup must **not** erase retained tails before TTL expiry.
5. Configuration documented and tunable via env vars.

## Non-goals

- Full session replay / VHS recording of the entire scrollback beyond the ring size.
- Changing task JSON schema or embedding megabyte tails in `tasks.json`.
- Cross-host sync of tails (local-first only).
- Replacing the activity ledger or hook JSONL as diagnostic sources.

## Current Behavior (code checkpoint)

| Path | Behavior |
| --- | --- |
| Live session | `AgentAdapter.captureDisplay` → `TerminalBackend.captureBytes` (ring ≤ 1 MiB) |
| `GET /api/capture/:sessionId` | Live capture only; 404 when session/ring gone |
| `completeTask` / `cancelTask` / `terminateTask` | `adapter.stop` → `killSession` → **ring removed** |
| Lucy `getKookrTaskOutputText` | Resolves task → latest `tmuxSession` → `GET /api/capture/:sessionId` |

## Design

### Storage strategy

**File-based store under the Kookr data directory**, not the ephemeral dtach ring tree.

```text
{kookrDir}/task-tails/
  <taskId>.json          # primary record (text + metadata)
  by-session/
    <sessionId>.json     # thin index pointing at taskId (same content or symlink-equivalent)
```

Record shape (`task-tail.v1`):

```json
{
  "schemaVersion": "task-tail.v1",
  "taskId": "…",
  "sessionId": "kookr-…",
  "capturedAt": "2026-07-23T12:00:00.000Z",
  "text": "…last N bytes of terminal output…",
  "byteLength": 12345,
  "truncated": false
}
```

**Why files (not DB / not tasks.json):**

- Matches existing local-first stores (activity ledger, hooks, settings).
- Avoids bloating `tasks.json` (already multi-MB on busy instances).
- Easy to prune by mtime / `capturedAt` without rewriting the whole task list.
- Survives process restarts without depending on dtach ring recovery.

**Capture timing:** Immediately **before** `adapter.stop` / ring teardown on each live session that is being stopped for a terminal transition. Best-effort: capture failure logs a warning and does not block completion.

**What is stored:** Decoded UTF-8 text from `captureDisplay`, then truncated to the last `KOOKR_TASK_TAIL_MAX_BYTES` (default **256 KiB**) so disk growth stays bounded even when the ring is 1 MiB.

### Retention policy

| Knob | Default | Effect |
| --- | --- | --- |
| `KOOKR_TASK_TAIL_RETENTION_DAYS` | `7` | Delete tails older than this (by `capturedAt`) |
| `KOOKR_TASK_TAIL_DIR` | `{kookrDir}/task-tails` | Override storage root |
| `KOOKR_TASK_TAIL_MAX_BYTES` | `262144` (256 KiB) | Max stored text per task |
| `KOOKR_TASK_TAIL_PURGE_INTERVAL_MS` | `3600000` (1 h) | Background purge tick; `0` disables timer |

Purge runs:

1. On a background interval after startup.
2. Lazily on read of an expired record (delete + 404).
3. Optionally during `kookr maintenance prune` (same age gate; documented as complementary — store owns the 7-day default independent of prune's 30-day default).

**Explicit task delete** removes that task's tail immediately (operator is clearing history). TTL covers completed tasks still present in `tasks.json`.

Session cleanup (`killSession`, ring removal) **must not** delete `task-tails/*`.

### API

#### `GET /api/tasks/:id/tail?lines=N`

| Query | Default | Clamp |
| --- | --- | --- |
| `lines` | `80` | 1–2000 |

**Responses:**

- `200` — body:

```json
{
  "schemaVersion": "task-tail.v1",
  "taskId": "…",
  "sessionId": "kookr-…",
  "taskStatus": "completed",
  "source": "live" | "persisted",
  "capturedAt": "…",
  "retentionExpiresAt": "…",
  "linesRequested": 80,
  "totalLines": 120,
  "shownLines": 80,
  "text": "…last N lines…",
  "truncated": false
}
```

- `404` — unknown task, or no live/persisted tail available (never captured / expired).
- `400` — invalid `lines`.

**Resolution order:**

1. If any session is non-terminal → live `captureDisplay` for the latest live session (`source: "live"`).
2. Else read `TaskTailStore` by task id (`source: "persisted"`).
3. Else 404.

#### `GET /api/capture/:sessionId` (compat)

Unchanged for live sessions. **New fallback:** if live capture fails, look up a persisted tail by session id and return `{ sessionId, output, source: "persisted" }` when found. This keeps Lucy's `peek_kookr_task_output` working for completed task IDs **without a Lucy code change**.

### Lifecycle integration

```text
stopAllLiveSessions / completeLiveSessionsInBackground
  → for each live session:
       persistTailBestEffort(taskId, sessionId, adapter.captureDisplay)
       adapter.stop(sessionId)   # still removes ring
```

`LifecycleDeps` gains optional:

- `taskTailStore?: TaskTailStore`
- `adapter.captureDisplay?: (sessionId) => Promise<string>` (already on `AgentAdapter`; typed on the narrow lifecycle adapter when present)

### Lucy integration

| Layer | Change |
| --- | --- |
| Kookr `GET /api/capture/:sessionId` | Persisted fallback (zero Lucy deploy required) |
| Kookr `GET /api/tasks/:id/tail` | Preferred contract for new clients |
| Lucy `peek_kookr_task_output` | Already resolves completed tasks from `tasks.json`; only the capture call failed. After this RFC lands, peeks of completed IDs succeed while the tail is retained. Optional Lucy follow-up: call `/api/tasks/:id/tail` directly for clearer `source` metadata. |

### Configuration documentation

Document env vars in `docs/reference/environment-variables.md` and the API in `docs/reference/api.md`.

## Requirements

- **R1.** Kookr SHALL persist a bounded terminal tail for each session stopped during a terminal task transition, when capture succeeds.
- **R2.** Kookr SHALL serve `GET /api/tasks/:id/tail?lines=N` for in-progress (live) and terminal (persisted) tasks.
- **R3.** Default retention SHALL be 7 days; configurable via `KOOKR_TASK_TAIL_RETENTION_DAYS`.
- **R4.** Session ring teardown SHALL NOT delete non-expired task tails.
- **R5.** `GET /api/capture/:sessionId` SHALL fall back to the persisted tail when the live ring is gone.
- **R6.** Capture/persist failures SHALL NOT fail task completion.
- **R7.** Expired tails SHALL be removed by background purge and/or lazy read.

## Implementation plan

1. `src/core/task-tail-store.ts` + unit tests.
2. Lifecycle persist-before-stop.
3. Task route + diagnostics capture fallback.
4. Wire store in `src/server/index.ts` + purge interval.
5. Docs: API + env vars.
6. Focused tests + `npm run check` / repo quality gate subset.

## Review history

### Round 1 (architecture / operability)

| Feedback | Resolution |
| --- | --- |
| Do not put tails in `tasks.json` (size blow-up) | File store under `task-tails/`. |
| Ring removal must stay (disk / crash recovery) | Still kill session/ring; copy first. |
| Lucy must work without a coordinated Lucy deploy | Capture-endpoint fallback by session id. |
| Bound disk growth | Default 256 KiB text + 7-day TTL + purge timer. |
| Completion path must stay non-blocking | Best-effort capture; fire-and-forget write errors. |

### Round 2 (API / delivery)

| Feedback | Resolution |
| --- | --- |
| Prefer task-keyed URL for new clients | `GET /api/tasks/:id/tail`. |
| Keep `/api/capture` semantics stable | Additive `source` field; same `output` key. |
| `lines` clamp needed | 1–2000, default 80 (matches Lucy's typical peek). |
| Explicit delete vs TTL | Delete removes tail; TTL covers remaining completed tasks. |
| Maintenance prune interaction | Store owns 7-day default; prune does not need to treat tails as sacred — optional future kind. Document preserved-until-TTL. |

## Open questions (resolved for v1)

| Q | Decision |
| --- | --- |
| Multi-session tasks | Persist the **last live** session stopped per transition; overwrite task file with newest capture. |
| ANSI vs stripped text | Store raw capture (same as live `/api/capture`); clients may strip. |
| Secrets in tails | Same posture as live capture (local-only data dir, auth gate on non-loopback). No extra redaction in v1. |

## Acceptance mapping

| Criterion | How verified |
| --- | --- |
| RFC + ≥2 review cycles | This document's review history |
| Completed tails ≥7 days default | Unit tests on retention math + env default |
| Lucy peek on completed IDs | Capture fallback tests with session id index |
| No regression on running tails | Live path still prefers `captureDisplay` |
| Config documented | env-vars + api reference updates |
