# Issue #700 multi-session attach audit (RFC R18 blocking prerequisite)

**Date:** 2026-07-02
**Scope:** Forensic reconstruction of the 2026-07-01/02 incident in which one Kookr task
acquired multiple live agent sessions for lucy issue #700, followed by a call-chain audit
of every `addSession` path, per `docs/rfc/rfc-issue-ownership-lock.md` R18 and §7.
**Method:** Read-only mining of `~/.kookr` (tasks.json + daily backups, activity/, hooks/,
sessions/, audit.jsonl, server.log) and static analysis of the repo `src/` tree.
All timestamps UTC. No code was modified.

---

## 1. What the data shows

### 1.1 Primary task record: deleted, but fully reconstructable

The #700 task — **`676c62e7-97ff-4ffb-881b-b694234df3fa`** — is absent from
`~/.kookr/tasks.json` and from every daily backup (`tasks.json.daily.20260701/02`) because it
was **deleted from the dashboard at `2026-07-02T01:07:34.750Z`**, ~25 minutes after the
incident:

> `{"type":"task.deleteTask","timestamp":"2026-07-02T01:07:34.750Z","actor":{"source":"websocket","actorId":"cbdy9eh5tz8"},...,"deletedTaskIds":["676c62e7-97ff-4ffb-881b-b694234df3fa"]}` — `~/.kookr/audit.jsonl`

No `~/.kookr/task-snapshots/*/bundle.json` covers this task. So the `sessions[]` array itself
is gone. However, the per-session activity ledgers (`~/.kookr/activity/kookr-*.jsonl`), hook
logs (`~/.kookr/hooks/kookr-*.jsonl`), the supervisor session's `interactions.jsonl`, and
`~/.kookr/server.log` preserve the complete session-level record. The reconstruction below is
from those secondary sources and is complete enough to identify the attach path.

### 1.2 Reconstructed timeline

**Task creation — one spawn, queued.** At `2026-07-02T00:21:22.6Z` the chain-parent codex
session `kookr-d10062c1` (task `8a6c7a95…`, the "ship next eligible github issue"
self-continuation chain) ran `bin/kookr-spawn.js` exactly once ("`spawning #700`") and got:

> `{"ok":true,"code":"OK","message":"Task queued","details":{"taskId":"676c62e7-…","parentTaskId":"8a6c7a95-…","queued":true,…}}` — `~/.kookr/activity/kookr-d10062c1.jsonl`, PostToolUse `2026-07-02T00:21:22.648Z`

`"Task queued"` means `launchTask` hit the concurrency cap and took the
`taskStore.pendTask()` branch (`src/server/launch-service.ts:375-380`): the task was created
with status `pending`, **no session launched**. The parent spawned it once; there is no
second spawn attempt in the ledger.

**Slots free.** Sessions died just before the burst:
- `kookr-557d3398` (task `cb041799…`): Stop `00:32:14.185Z`, SessionEnd `00:32:55.814Z`
- `kookr-f4496ddf` (task `0790d362…`): Stop `00:33:02.408Z`; server.log shows
  `[terminal-backend] session kookr-f4496ddf is gone` interleaved with the first duplicate
  SessionStarts (server.log ~line 167590).

**The burst — five sessions on one pending task in 6.8 seconds.** All five are
`claude-code`, all in `cwd=~/git/lucy`, all with the **byte-identical initial
prompt** (the implement-github-issue worktree-guardrails prompt; first tool call in the owner
session is `gh issue view 700`). Envelope `taskId` is `676c62e7…` for all five:

| # | kookr session | SessionStart (observedAt) | first UserPromptSubmit | SessionEnd |
|---|---------------|---------------------------|------------------------|------------|
| 1 | `kookr-47a3e4b3` | `00:33:04.677Z` | `00:33:11.036Z` | `00:42:13.481Z` |
| 2 | `kookr-e7957251` | `00:33:05.205Z` | `00:33:11.018Z` | `00:42:13.459Z` |
| 3 | `kookr-116708f3` | `00:33:08.844Z` | `00:33:09.500Z` | `00:42:13.413Z` |
| 4 | `kookr-e8efe1f2` | `00:33:09.383Z` | `00:33:15.738Z` | `00:42:13.587Z` |
| 5 | `kookr-59c894cc` | `00:33:11.450Z` | `00:33:18.248Z` | `00:42:13.629Z` |

(Source: `~/.kookr/activity/kookr-{47a3e4b3,e7957251,116708f3,e8efe1f2,59c894cc}.jsonl`.
Events appear twice per file — file-replay + HTTP ingestion duplication, cosmetic.)

Note the ordering: for the claude-code adapter, `addSession` — the call that flips the task
`pending → inProgress` — runs only **after** initial-prompt delivery is hook-confirmed
(§2.1). The earliest UserPromptSubmit is `00:33:09.5Z`, so the task's status stayed
`pending` from creation at `00:21:22Z` until ≈`00:33:09–11Z` — i.e. **every one of the five
launch decisions was taken while the task still looked pending and inactive**.

**Detection and stand-down.** The supervisor session `2026-07-01T23-07-34-400Z` sent, at
`00:34:19.729Z`–`00:34:22.901Z`, the identical correction to exactly four agents —
`kookr-116708f3`, `kookr-47a3e4b3`, `kookr-e8efe1f2`, `kookr-59c894cc`:

> "Supervisor correction: this #700 task accidentally has multiple live sessions. You are NOT the designated owner session (kookr-e7957251). Stop immediately. …" — `~/.kookr/sessions/2026-07-01T23-07-34-400Z/interactions.jsonl`

So the record shows **five sessions attached; four non-owner duplicates stood down** (the
incident phrasing "4 live sessions" counts the duplicates). All five ended at
`00:42:13Z` (simultaneous SessionEnd ⇒ a task-level stop). The chain parent then confirmed
"duplicate sessions stood down. You are the only active owner for issue #700 now", a
replacement session `kookr-d288f200` (fresh task `05ea93ea…`) launched at `00:47:04Z`, and
the corrupted task was deleted at `01:07:34Z` (§1.1).

**No server restart.** `server.log` has a single boot marker (line 13914,
`Kookr server listening…`) far before the incident and none near it — all startup-time
recovery paths are excluded by construction. **No `[launch] source=…` line** exists for any
of the five sessions — `launchTask`'s direct-launch path logs that line on success
(`src/server/launch-service.ts:436`), so the five launches did **not** go through
`launchTask`. The only launch path that logs nothing on success is pending-task promotion.

---

## 2. Call-chain analysis: every path to `addSession`

`TaskStore.addSession` (`src/core/tasks.ts:414-428`) appends unconditionally — no
duplicate/liveness check of any kind — and auto-transitions `open|pending → inProgress`
(`src/core/tasks.ts:422-425`). Its only callers are the two adapters:

### 2.1 Adapters (`claude-code-adapter.ts:379`, `codex-cli-adapter.ts:370`)

`ClaudeCodeAdapter.launch` calls `backend.createSession` (`:318`), then awaits
`deliverInitialPromptToSession` with UserPromptSubmit-hook confirmation, retries, and
timeouts (`:326-376`), and **only then** calls `addSession` (`:379`). That makes the
launch-start → status-flip window **many seconds long** (here ≈7–10s+ per launch; agent
startup + prompt confirmation). `CodexCliAdapter.launch` calls `addSession` (`:370`)
immediately after `createSession` (`:361`) — a shorter but still non-zero async window.
Neither adapter checks whether the task already has a session. Everything below reaches
`addSession` through `adapter.launch`.

### 2.2 `launchTask` (`src/server/launch-service.ts:407`) — **cannot produce the pattern**

Each call **creates a fresh task** (`:357`) before launching (`:407`), so one call can only
ever attach one session to its own new task. The prompt-hash dedupe (`:333-355`) returns the
existing task *without launching*. A failed launch deletes the task (`:430`). It could not
have attached four extra sessions to an existing task — and the missing `[launch]` log lines
(§1.2) confirm it didn't run for these sessions.

### 2.3 `promotePendingTasks` (`src/server/agent-lifecycle.ts:438-495`) — **the culprit**

The loop: `getNextPending()` (`:445`) → `await adapter.launch(pending.id, …)` (`:459`) →
count via `getActiveCount()` (`:444`).

- `getNextPending` (`src/core/tasks.ts:354-364`) returns the oldest task whose **status is
  still `pending`** — which, per §2.1, stays true for the whole multi-second launch window.
- `getActiveCount` (`src/core/tasks.ts:344-351`) counts only `inProgress` — an in-flight
  launch occupies no slot.
- The `seen` set (`:442,449-454`) only guards **within one invocation**. There is **no
  cross-invocation in-flight marker, mutex, or status transition before the first `await`**
  (verified: no lock/in-flight state anywhere in `agent-lifecycle.ts`).

Therefore any N invocations that overlap the pending→inProgress window of the same task each
pick it and each launch it: N sessions on one task ID. And overlapping invocations are
routine, because `promotePendingTasks` has **four concurrent trigger sources**:

1. **Liveness/reconcile tick, every 5s** — `setInterval` at
   `src/server/lifecycle-timers.ts:377`, promoting at `:401-412` whenever the reconcile pass
   reports any of `markedCompleted / tasksCompleted / tasksTerminated / worktreesMissing /
   worktreesStale / worktreesChanged` (`:393-400`). `livenessIntervalMs: 5000`
   (`src/server/start.ts:205`). The `setInterval` callback is `async` and **not awaited by
   the timer**, so consecutive ticks overlap freely while a promotion is mid-launch.
2. **WS task completion/cancellation** —
   `src/server/use-cases/task-lifecycle-commands.ts:151` (complete) and `:169` (cancel) call
   `tryPromotePending` → `promotePendingTasks` (`src/server/ws.ts:468-478`). Chain agents
   completing their tasks via `kookr task complete` land here.
3. **HTTP task routes** — `src/server/routes/task-routes.ts:56-67`.
4. **Startup** — `promotePendingStartupTasks` (`src/server/startup-recovery.ts:162-180`,
   called from `src/server/index.ts:855`). Not active here (no restart).

**Fit to the data:** task `676c62e7` queued at `00:21:22Z`; sessions `kookr-557d3398` and
`kookr-f4496ddf` died `00:32:55–00:33:02Z`, freeing slots and making every 5s reconcile tick
promotion-eligible, while their tasks' completions fired WS/HTTP promotions. Five overlapping
`promotePendingTasks` invocations between ≈`00:33:00Z` and ≈`00:33:09Z` — 5s ticks plus
completion-triggered calls — each saw the task still `pending` (first status flip
≈`00:33:09–11Z`) and each launched it. Five SessionStarts, `00:33:04.677Z`–`00:33:11.450Z`,
identical prompts. Once the first `addSession` landed, `getNextPending` stopped returning
the task and the multiplication stopped — exactly five. (Which specific mix of tick vs.
WS/HTTP triggers fired is unprovable: successful promotion logs nothing.)

### 2.4 `crash-recovery.ts` — excluded

Startup-only (`startup-recovery.ts:70`, after `reconcile()`), and the best-guarded path in
the codebase: skips tasks with a live (reconcile-`resumed`) session (`crash-recovery.ts:79-85,
99-107`), intra-pass task dedupe (`:126-133`), prompt-hash dedupe (`:135-144`), 60s
crash-loop window (`:146-165`). Relaunches via `adapter.launch` (`:206`) — legitimately
attaching a *second* (dead-superseding) session to an existing task. No restart occurred
(§1.2), so this path never ran.

### 2.5 `startup-recovery.ts` `replayExisting` — excluded; does not attach sessions

`hookWatcher.watch(tmuxName, { replayExisting: true, … })` (`startup-recovery.ts:145`)
replays **hook JSONL files** for already-live sessions into ingestion; it never calls
`addSession`. Listed in R18 as a suspect, but it has no session-attach capability at all.

### 2.6 `ralph-loop-service.ts` — excluded for this incident; guarded

`launchFreshRuntime` (`:788`) → `launchFreshTaskSession` (`:810`, wired to the adapter)
legitimately attaches per-iteration sessions to the loop's existing task. It runs only from
the Stop-driven cycler after `findLiveSession` (`:538-544`, `isAlive` probe `:662`) and the
startup probe (`:108-131`, `:600-612`), with owner claim/transfer (`:551-552`, `:602`). The
#700 task was not a Ralph loop (plain playbook spawn; five *identical* initial prompts, not
iteration-rendered ones), and per-iteration relaunch can't produce 5 starts in 7 seconds.

### 2.7 `schedule-runner.ts` — excluded

Delegates to the injected `launcher` = `launchTask` (`schedule-runner.ts:200-207`,
`launcher:` at `:49`) — a **new task per run** (§2.2). Cannot attach to an existing task.

### Guard summary

| Caller | Can attach to an existing task with a live session? | Duplicate guard today |
|---|---|---|
| `launchTask` (launch-service.ts:407) | No (new task per call) | prompt-hash dedupe `:333-355` |
| **`promotePendingTasks` (agent-lifecycle.ts:459)** | **Yes — races itself across invocations** | **per-invocation `seen` only; nothing cross-invocation** |
| `crash-recovery.ts:206` | Yes (by design, dead → new) | live-session + prompt-hash + crash-loop guards `:79-165` |
| `startup-recovery.ts` replayExisting `:145` | Never calls addSession | n/a |
| `ralph-loop-service.ts:810` | Yes (by design, per iteration) | `findLiveSession`/`isAlive` probes `:538,:600,:662` + owner claim |
| `schedule-runner.ts:201` | No (→ launchTask) | via launchTask |
| `TaskStore.addSession` (tasks.ts:414) itself | — | **none: appends unconditionally** |

---

## 3. Most-likely attach path — ranked

1. **Concurrent `promotePendingTasks` invocations racing on one pending task**
   (agent-lifecycle.ts:438-495 + tasks.ts:344-364 + the adapters' late `addSession`).
   **Evidence: very strong / conclusive.** One spawn → `"Task queued"`; five identical
   claude-code launches inside the single task's pending window immediately after slots
   freed; count self-limited by the first status flip; no `[launch]` log lines (rules out
   launchTask); no restart (rules out all startup paths); mechanism reproducible from code
   with no further assumptions.
2. Ralph relaunch — **excluded** (not a loop task; probe-guarded; wrong temporal shape).
3. Crash recovery / startup promotion / replayExisting — **excluded** (no restart;
   replayExisting can't attach).
4. `launchTask` / schedule-runner — **excluded** (new-task-per-call; no launch logs).

---

## 4. Recommendation per RFC R18

> **Status (2026-07-02): implemented** (RFC PR 1c). Item 1 landed as the in-flight-flag
> variant (`TaskStore.beginLaunch`/`endLaunch`, in-memory map + 10-minute TTL, not a
> persisted `launching` status) at both launch sites; `getNextPending` skips reserved
> tasks and `getActiveCount` counts fresh reservations. Item 2 landed as detect-and-log
> in `addSession` (attach-flagged, not refuse), with re-attach allowed when prior
> sessions have lastStatus completed/aborted (no async `isAlive` probe — an await would
> widen the race). The secondary 5s-tick overlap guard ("also worth fixing") was not
> included — the reservation makes overlapping promoters harmless.

**Where the guard sits.** The duplication happens in the **pick-to-launch window**, before
any session exists. The chokepoint is the transition "this pending task is now being
launched", and it must be **synchronous** (no `await` between reading the task's status and
reserving it — Node's single thread then makes it a free CAS):

1. **Primary guard — synchronous launch reservation in `TaskStore`,** consumed at both
   launch sites: `taskStore.beginLaunch(taskId)` flips `pending → launching` (or sets an
   in-flight flag) and returns false if already launching/inProgress. Call it in
   `promotePendingTasks` immediately after `getNextPending()` and **before**
   `await adapter.launch(...)` (`src/server/agent-lifecycle.ts:459`), skipping the task on
   false; and in `launchTask` before `adapterRegistry.get(...).launch(...)`
   (`src/server/launch-service.ts:407`). `getNextPending` (tasks.ts:354) must not return
   `launching` tasks; `getActiveCount` (tasks.ts:344) must count them (its current
   `inProgress`-only count is a second latent over-launch bug at the cap). Launch failure
   reverts the reservation (the existing catch paths at agent-lifecycle.ts:482-486 and
   launch-service.ts:426-432).
2. **Defense-in-depth + R-series "violation detected" — in `TaskStore.addSession`
   (tasks.ts:414):** when the task already has a session not known dead, refuse (or attach
   flagged) and emit a loud audit/log event. This is the single funnel every attach path
   crosses; it cannot *prevent* (the duplicate process already exists by then — the caller
   must kill it on refusal), but it turns any future recurrence into a detected event
   instead of a supervisor discovery.

**Is R18's proposed guard shape sufficient?** The RFC's "async `isAlive` probe" guard, alone,
**would not have prevented #700**: all five launches were decided before *any* session was
alive to probe, and an async probe adds an `await` that widens the very race being closed.
This lands in R18's stated-fallback territory — but the needed change is small and local, not
a session-attach rewrite: the synchronous reservation (item 1) plus the addSession funnel
check (item 2). The `isAlive` probe belongs in the funnel/whitelist check (item 2), where
"already has a live session" must distinguish dead sessions (recovery) from live ones.

**Legitimate re-attach flows the guard must allow (and how):**
- **Crash recovery** (`crash-recovery.ts:206`): fires only for sessions reconcile just marked
  dead, already skips tasks with live sessions (`:99-107`). Passes `ResumeContext` — allow
  attach when every prior session is dead or when a resume/recovery context is present.
- **Ralph iteration relaunch** (`ralph-loop-service.ts:810`): fires only after
  `findLiveSession` returns none / on turn end; allow attach for tasks with an active
  `ralphLoop` where the prior iteration's session is dead or completed its turn.
- **`replayExisting`** (`startup-recovery.ts:145`): touches hook files only, never
  `addSession` — nothing to whitelist.
- The reservation guard (item 1) constrains only the `pending → first session` path, so
  neither flow crosses it; the addSession funnel check (item 2) needs exactly the two
  allowances above.

**Also worth fixing (secondary):** the 5s liveness `setInterval`
(`lifecycle-timers.ts:377`) runs an async body it never awaits, guaranteeing overlapping
reconcile/promotion passes; a simple in-progress tick guard would cut the trigger
concurrency, though the reservation makes overlap harmless.

---

## 5. Evidence inventory

- `~/.kookr/activity/kookr-{47a3e4b3,e7957251,116708f3,e8efe1f2,59c894cc}.jsonl` — the five
  sessions, envelope `taskId: 676c62e7-…`, SessionStart `00:33:04.677Z`→`00:33:11.450Z`,
  SessionEnd `00:42:13Z`.
- `~/.kookr/activity/kookr-d10062c1.jsonl` — single `kookr-spawn.js` spawn `00:21:22.6Z`,
  `"Task queued"`, and the post-incident "duplicate sessions stood down" confirmations.
- `~/.kookr/hooks/kookr-e7957251.jsonl` — owner session; first tool call `gh issue view 700`.
- `~/.kookr/sessions/2026-07-01T23-07-34-400Z/interactions.jsonl` — supervisor stand-down
  messages `00:34:19.729Z`–`00:34:22.901Z` to exactly the four non-owner sessions.
- `~/.kookr/audit.jsonl` — `task.deleteTask` of `676c62e7-…` at `01:07:34.750Z` (why the
  primary `sessions[]` record no longer exists).
- `~/.kookr/server.log` — SessionStart ingestion interleaving (~line 167591+), task-naming
  lines for `676c62e7` (167805/167817), single boot marker (13914), and the absence of any
  `[launch] source=` line for these sessions.
- `~/.kookr/tasks.json` + `tasks.json.daily.20260701/20260702` — no #700 task, no
  multi-session task in the window (pruned by the deletion above).
