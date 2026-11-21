# Evidence pack: Supervisor sentinel

Companion to [`rfc-supervisor-sentinel.md`](./rfc-supervisor-sentinel.md). Gathered on 2026-11-21
from the live host (Kookr build `e6cb8f6d8`) and `origin/main`. **Every item is a claim to check,
not settled fact.**

## 1. Pipeline map (what already exists)

| Piece | Where | What it does | Relevance |
|---|---|---|---|
| hungSuspect TTL reclaim | `src/core/hung-suspect-ttl.ts:51,60`, `src/server/hung-suspect-ttl-sweep.ts` | Closes a task whose hook, pane and token channels are all silent for the TTL. Default is 25 min, the ceiling is 60. This host: `hungSuspectTtlMinutes: 60` (`~/.kookr/settings.json:43`). Open-PR and provider-pause are hard bars. | This is the killer the sentinel guards against. |
| Hard hung-task reaper | `src/core/hung-task-reaper.ts:6` | `DEFAULT_HUNG_TASK_REAP_MS = 180 min`. | Second, slower killer. |
| Process-tree kill | `src/adapters/local-dtach-backend.ts:520-527`, `src/adapters/process-tree.ts` | Kills a closed task's descendants, found by parent-pid edge from `/proc`. | A reaped lead takes un-reparented children with it. |
| SupervisionService | `src/server/supervision-service.ts` (60 s tick), `src/core/supervision/supervision-policy.ts` | For a `kookr supervise` mandate (targets plus deadline): a server-side heartbeat wake (default 45 min), a watchdog (`healthy`/`degraded`/`dead`), a fresh-episode restart (max 3 per mandate, max 1 per 30 min), and operator alerts through the operational-alert, then Telegram, path. | Prior art. It covers only supervisors Kookr launched for a mandate. |
| Reap exemption for awaited wakes | `supervision-service.ts:110` `isAwaitingScheduledWake`, wired at `lifecycle-timers.ts:2168` | A supervisor owed a wake is not reclaimed (issue #4162). | The model for "a guarded task is not reaped silently". |
| No Kookr-driven `/compact` | `rfc-attachable-task-supervisor.md` §2 "Context hygiene" | That RFC chose to rely on auto-compact. | This RFC deliberately departs from it, for long-lived leads only. |
| `/compact` from outside | `src/cli/kookr-supervise.ts:247` | The supervisor playbook sends `kookr reply <taskId> "/compact"` only at an idle turn boundary. | The mechanism the sentinel would use. |
| Schedules | `~/.kookr/schedules.json`, `src/server/schedule-runner.ts`, `kookr schedule` | Cron-fired playbook runs. `modelTier: 'small'` is supported. | The sentinel's host. |
| Schedule dead-man | `src/server/schedule-dead-man.ts` | Alerts on schedule starvation. It **ignores** `skipped_project_automation`, `skipped_safe_mode`, `skipped_draining` and `skipped_provider_paused` by design (lines ~140-158). | A paused project silences the sentinel without any alert. |
| `kookr ask` | `kookr ask --help`, `src/server/asks/ask-service.ts`, `docs/rfc/rfc-kookr-ask.md` | Telegram multiple choice (2-4 options, optional free text, timeout 30 s to 7 d). Without `--wait` the answer is typed into the asking task (`--task-id`, default `$KOOKR_TASK_ID`). An answer arriving after that task ended is recorded but **not typed**. `GET /api/asks/<id>` reads it. Exit 7 when Telegram is not configured. | The unlock channel. Answer routing is a design choice. |
| `kookr reopen` | `kookr reopen --help` | Reopens a terminal task and reports whether the conversation resumed (it needs a `claudeSessionId`). | Lead recovery. |
| Per-task tokens | `src/core/token-tracker.ts` | Cumulative usage. No "current context size" API was found. | The context size has to be read from the transcript's last assistant `usage`. The transcript path comes from the hook stream, not the task API (§4). |

## 2. Telemetry (LFM3 lead `1eb7e203`, session `3d91bbec`)

- **Survival:** the lead's only keep-alive is a session `CronCreate` tick at minutes 4, 24 and 44. Ticks fired every 20 min through 20–21 Nov. After both manual compactions (20 Nov 18:08 and 20:43 UTC) the lead re-created its crons within about 2 min (`CronCreate` at 18:10 and 20:43:30).
- **Compactions in the log** (`compact_boundary`):

  | When (UTC) | Trigger | Size before |
  |---|---|---|
  | 19 Nov 05:10 | auto | 493k |
  | 19 Nov 19:52 | auto | 233k |
  | 20 Nov 05:51 | auto | 248k |
  | 20 Nov 18:08 | manual | 352k |
  | 20 Nov 20:43 | manual | 273k |

  Each brought the summary down to about 20–30k; the next turn's real context was 65–78k on the lead (round 2) or about 43k on the probe task (§4), because the system prompt and tools come on top. None has fired since 20:43, and the context was about 695k at 16:49 on 21 Nov (about 19–21k/h). The user setting is `autoCompactWindow: 400000`, but whether it applies to Kookr tasks is unverified.
- **Cost:** a cached re-read at 680k costs about $0.14 per call, against about $0.015 at 75k (Opus 5.5 at $0.20/M cached).
- **Cause of the 21 Nov loss** (from the consensus attack, checked in the lead transcript at 12:34 UTC): the lead noted "Test 3 session killed at ~13:26 when task 007332b1 was terminated (non-detached child)". The idle reclaim of a silent worker killed its GPU job.
- **The progress blind spot:** on 21 Nov at 12:26 and 12:29 UTC, Kookr reclaimed workers `007332b1` and `dfca26a7` (hungSuspect TTL; `~/.kookr/disposition.jsonl` lines 1722-1723). A GPU job died in the same minutes. The lead kept reporting "in progress" until the operator asked at 13:33 local time. Only the operator detected the lack of progress.
- **Records mislead:** `/mnt/d/swe-compose-runs/sft-v2-opencode-2h/events.jsonl` and `sft-v3-reasoning-2h/events.jsonl` are 0 bytes after full runs.
- **Schedules get skipped silently:** `kookr schedule list` on 21 Nov shows most enabled "watchdog" and "orchestration supervisor" schedules with `lastRunStatus: skipped`, outcome `skipped_project_automation`. Two projects have `automationEnabled: false` (paused since September). Others are auto-paused after consecutive failures.

## 3. Source pointers

- Reaper: `src/core/hung-suspect-ttl.ts`, `src/core/hung-task-reaper.ts`, `src/server/hung-suspect-ttl-sweep.ts:283,447`.
- Supervision: `src/server/supervision-service.ts:1-135, 380-620`; RFC `docs/rfc/rfc-attachable-task-supervisor.md` §2-3.
- Schedules: `src/server/schedule-runner.ts:1127-1149`, `src/server/schedule-dead-man.ts:1-160`, `src/shared/contracts/schedule.ts:371` (`modelTier`).
- Ask: `src/server/asks/ask-service.ts`, `docs/rfc/rfc-kookr-ask.md`.
- Workflow review that motivated this: artifact "LFM3 Fleet Workflow Review" (revision 2, 21 Nov 2026).

## 4. Empirical checkpoint after round 1 (2026-11-21, throwaway Haiku task `d55c64cd`, $0.20)

- **External `/compact` at idle works.** `kookr reply <task> "/compact …"` was followed by a
  `compact_boundary` 15 s later (`trigger: manual`, 64,433 → 11,102 tokens). The next turn's context
  was about 42.7k, because the system prompt and tools come on top of `postTokens`.
- **Queued `/compact` works.** Sent during an 80 s Bash call, it was delivered at once, ran as a real
  slash command 0.09 s after the turn ended, and was followed by `compact_boundary` 16 s later.
- **A session `CronCreate` survives `/compact`.** A `*/2` job kept firing after both compactions.
- **The transcript is not chronological.** The `compact_boundary` line is written before the
  `/compact` command entry. Readers must filter on `timestamp`, not file order.
- **The transcript path is not in `GET /api/tasks/<id>`.** It is in `transcript_path` of the hook
  stream, `~/.kookr/hooks/<tmuxSession>.jsonl`.
- **`lastTurnState` is unreliable after the Stop hook.** It stayed `running`, and `kookr peek` said
  "POSSIBLY HUNG", for minutes while the transcript showed the turn had ended.
- **The Kookr stop-hook nudge** ("record the lesson, then raise completion_ready") fired after
  cron-fired turns too.
