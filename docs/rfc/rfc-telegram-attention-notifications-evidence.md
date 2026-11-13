# Shared evidence pack — rfc-telegram-attention-notifications

Evidence to CHECK, not settled fact. Re-verify any load-bearing claim against source.
Gathered from the current working tree before the critic panel.

> **Snapshot of 2026-11-07.** The R3 detection gap described below (item 2 and the
> jump list) has since been closed: #3512 added the shared `isBackgroundParked`
> predicate, which `detectNeedsInput` now calls (so a grep for
> `activeBackgroundTaskCount` in `anomaly-detector.ts` still finds nothing, but the
> detector is no longer blind). #3573 extended it to the watchdog and reaper. See the
> "Update 2026-11-13" section of the RFC. Line numbers are as of 2026-11-07.

## Pipeline map — two independent Telegram paths + one attention surface

**Detection → attention queue (the "needs user" decision):**
- Two classifiers mint `Anomaly` objects into one `AttentionQueue`:
  - Event-driven: `src/core/anomaly-detector.ts` (`evaluateAnomalies`), runs per hook event via `Monitor.processEvents`.
  - Heartbeat watchdog: `src/core/watchdog.ts` (`Watchdog.tick`, 5s), silence timers + tmux pane hash, via `Monitor.applyWatchdogVerdict`.
- Anomaly taxonomy (`src/shared/contracts/anomalies.ts:9-20`): `needs_input` (subType `stop`=info / `ask_user_question`=warning), `permission_blocked`, `merge_conflict`, `repeated_error`, `api_error`, `budget_exceeded`, `stale_agent` (watchdog-only), `hook_disconnected` (watchdog-only), plus infra health types.
- `TurnState` (`src/shared/contracts/task-status.ts:105-110`): `running | waiting_for_input | completed_turn | blocked | unknown`.
- `TaskStatus` (persisted): `open | pending | inProgress | completed | terminated | cancelled`.
- `TaskStuckReason` (`src/core/stuck-reason.ts:86-103`): priority `awaiting_completion_ack > provider_paused > hung_suspect > waiting_on_input > permission_blocked`; `waiting_on_input` is suppressed if any channel moved in last 60s — but only for the stuckReason projection, not the queue/notification.

**Delivery → Telegram (two paths):**
- Path A, signal-delivery (`src/observability/signal-delivery/`): file spool `~/.kookr/playbook-state/operator-signals/` → `SignalDeliveryService` 15s poll → batched (≤1 msg/min, `service.ts:149-150`) plain-text POST (`channels.ts:58-71`, no parse_mode, no links, `disable_web_page_preview:true`). Dedup via `.delivered.json`. Enabled only if a channel configured (`config.ts:74`). Telegram needs `KOOKR_TELEGRAM_BOT_TOKEN` + `KOOKR_SIGNAL_TELEGRAM_CHAT_ID`. Carries infra alerts only (deploy-lag, prod-smoke, pipeline-starvation, schedule dead-man, liveness, hung-suspect residual). No task-done / needs-you signal.
- Path B, remote-chat bot (`src/integrations/telegram/index.ts`): long-poll `getUpdates` + lifecycle callbacks. `onPermissionBlocked` (`index.ts:707-722`) and `onTaskOutcome` (`index.ts:724-757`, handles `completion_ready`/`completed`/`failed`/`cancelled`). BOTH no-op unless `state.get().origin[taskId]` exists → only bot-spawned tasks notify. Messages embed dashboard deep link `dashboardTaskUrl` = `${base}/?task=<id>` (`src/shared/dashboard-task-url.ts`). Enable: `KOOKR_TELEGRAM_BOT_TOKEN` + `KOOKR_TELEGRAM_ALLOWED_USERS` + `KOOKR_REMOTE_CHAT_PROJECTS` (`start-remote-chat-trigger.ts:107-131`).

## Telemetry / ground-truth facts (verified)

1. `turn-state.ts:46-68` reads `activeBackgroundTaskCount`/`activeSessionCronCount` from the Stop event and returns `running` when either > 0, else `completed_turn`. (Read confirmed.)
2. `src/core/anomaly-detector.ts:367-381` `detectNeedsInput` returns a `needs_input`/`stop` anomaly on ANY `stop` event. `grep activeBackgroundTaskCount src/core/anomaly-detector.ts` → NO MATCH. (Confirmed blind on 2026-11-07; fixed since by #3512.)
3. The Stop hook payload carries `background_tasks`/`session_crons`, parsed in `src/core/hook-parser.ts:191-200` into the counts (`src/core/agent-events.ts:65-68`).
4. `OutstandingSubagentTracker` (`src/core/outstanding-subagents.ts:24-84`) suppresses `needs_input`/`stale_agent`/`hook_disconnected` only while Task-tool subagents are outstanding; a `stop` with background/cron counts > 0 neither adds nor clears it — background bashes/crons are never tracked there.
5. `OperatorNeeded` (`src/shared/contracts/operator-needed.ts`): durable, first-write-wins, set when an unattended agent's `AskUserQuestion` is denied (`interactive-deny-processor.ts`). ~zero false-positive surface.
6. `permission-block-alert-processor.ts:60-84`: edge-triggered (`anomaly==='permission_blocked' && !wasPermissionBlocked`), circuit-breaker guarded, fires `onPermissionBlocked`.
7. Watchdog thresholds (`watchdog.ts`): `staleThresholdMs`=30s, `unconditionalStaleThresholdMs`=60s, `tokenActivityThresholdMs`=60s, `maxToolExecutionTimeMs`=10min, grace 10s, MCP-startup grace 120s. A 20-min FOREGROUND `sleep` → `stale_agent` at 10min.
8. Quiet-hours (`src/shared/contracts/quiet-hours.ts`, `isWithinQuietHours`): consumed only in frontend (`useDnd.ts`, SettingsDialog); zero server/Telegram callers.
9. Relay share: `DEFAULT_HOSTED_RELAY_URL='https://share.kookr.dev'` (`src/shared/contracts/hosted-relay.ts:1`); `relay-share-client.ts` mints TTL-bounded (default 10min) view-only `joinUrl` to a LIVE session, never attached to a notification. No HTML-report builder exists (grep `buildHtmlReport|renderHtml|text/html|artifact` → only false positives).
10. `config-preflight.ts:79-85` validates only `KOOKR_TELEGRAM_API_URL`, not token/chat/allowlist.

## Source pointers (jump list)
- Detection gap (closed by #3512): `src/core/anomaly-detector.ts:367-381`, `src/core/turn-state.ts:46-68`.
- Reliable signals: `src/shared/contracts/operator-needed.ts`, `src/core/stuck-reason.ts:86-103`, `src/core/turn-state.ts:72-94`.
- Delivery reuse: `src/observability/signal-delivery/{service,channels,emit-transition,config}.ts`.
- Origin-map gate: `src/integrations/telegram/index.ts:707-757`.
- Links: `src/shared/dashboard-task-url.ts`, `src/shared/contracts/hosted-relay.ts`, `relay-share-client.ts`.
- Neighbor RFCs: `rfc-remote-chat-trigger.md` (outbound completion notify for remote tasks), `rfc-supervisor-stale-agent-false-positives.md` (watchdog FP class), `rfc-supervision-next-actions.md` (next-action classifier the report consumes).
