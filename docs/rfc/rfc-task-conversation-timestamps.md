# RFC: Make Task and Conversation Times Understandable

**Status:** Accepted — implementation complete (2026-11-04)
**Date:** 2026-11-04
**Author:** Jean Ibarz (with Codex)

## Problem

Kookr shows a single completion time in places where operators need to know when a task was created, when an agent session began, when the task entered a terminal status, and how long it ran. These are different events: `createdAt` records task creation, a session's `createdAt` records session creation, and `finishedAt` records the first terminal status transition. That transition is not necessarily the instant the agent process or conversation stopped. None should be silently presented as the time the operator archived the task. Conversation entries also need a visible time anchor so a reader can place messages in sequence and identify the final exchange.

The current detail panel already shows a compact duration (`DetailPanel.tsx`), while task history and the completion digest do not consistently explain the underlying timestamps. The task read model contains `createdAt`, optional `finishedAt`, and session records with `createdAt`; records can lack a reliable execution end. `AgentState.startedAt` currently projects task creation time even for pending tasks, while terminal `finishedAt` may fall back to termination time, last session activity, or task update time. The UI must expose this provenance and must not manufacture a conversation end or archive time from a status transition. The normalized conversation transcript currently has no per-message timestamp field. Its active vendor parser supports Claude Code transcript files; preserving their source timestamps requires checking their real field shape and wiring timestamps through parser, storage, and API. The activity ledger and unsupported-provider transcript paths do not currently provide per-message times.

## Requirements

1. Show **Task created** using `createdAt` and **Kookr session recorded** using the session with the greatest valid `createdAt`, when available. Session `createdAt` records Kookr's session registration, not necessarily the provider process's first execution. Do not call task creation the agent start.
2. Show task age from task creation separately from session runtime; show session runtime only when both session start and a source timestamp for the session's actual end are available. `finishedAt` alone is a status-transition time and cannot establish exact process runtime.
3. For terminal tasks, prefer `terminalReceipt.at` as the current terminal transition time; fall back to `finishedAt`/`terminatedAt` for legacy rows. Label it **Task became terminal**. `finishedAt` is the first terminal time and may be stale if terminal status has since changed without a reopen. Label `lastSession.lastEventAt` **Last observed hook activity** and `updatedAt` **Task record updated**. Do not collapse fallback evidence into a precise conversation or execution end.
4. Explain in context that conversation activity, task terminal status, and archival are distinct events. Show **Archived** using the existing `archivedAt` value for archived records. Kookr has no separate operator acknowledgement/close event today; say **No separate close time recorded**.
5. Keep a live task-age indicator for active tasks; for terminal tasks freeze age at terminal transition time only when that is the available basis and label it **Task age at status change**. Do not label task age or a fallback-based interval as execution duration.
6. Preserve and display per-message timestamps from provider transcript records where supplied. Summarize the first and last timestamped messages currently shown and the span between them; label this as the visible-message span so transcript truncation cannot imply full conversation coverage. For sources without timestamps, show no invented time; retain the task/session timeline above the conversation.
7. Preserve compact list density. Full timestamp details belong in task details and the conversation view; compact rows may show a relative end-time hint.
8. Invalid and missing timestamps must render safely and accessibly. Use semantic `<time datetime>` elements and visible text; do not rely on hover-only tooltips.

## Design

Preserve valid source message timestamps in the normalized transcript contract (`TranscriptMessage.timestamp?`), stored transcript format, and API response. For Claude Code JSONL, verify the root timestamp field against actual transcript records before implementation; if one source entry expands into multiple normalized blocks, each derived block carries that entry timestamp. Parsers accept only valid source timestamps; the renderer uses the timestamp as an absolute local `<time>` value with a visible relative age. Existing stored transcript records remain valid without timestamps. No time is synthesized from row order, fetch time, or task creation. Other transcript sources remain without per-message timestamps until they expose source times.

Use one shared frontend formatter for absolute local date/time and relative age. The task detail panel presents a small **Timeline** group:

- **Task created** — task `createdAt`.
- **Kookr session recorded** — the session with the greatest valid `createdAt`, when a session exists.
- **Task age** — task created to now/status-change evidence.
- **Session runtime** — only when a true session end timestamp is available; otherwise show **Runtime unavailable**.
- **Task became terminal / Last observed hook activity / Record updated** — selected according to timestamp provenance, with an accessible explanation.
- **Archived** — `archivedAt` for archived records, clearly distinguished from task status transition and conversation activity.
- **No separate close time recorded** — because there is currently no operator-close timestamp in the model.

Conversation message timestamps use the same date/time formatting so the message history and task timeline agree. The current transcript route provides Claude Code vendor transcripts; its activity-ledger fallback and unsupported providers do not include message times. Older stored snapshots continue to render without per-message time.

When timestamps exist, the transcript header shows the first and last timestamped messages in the displayed result plus the time between them. It says **Visible message span** rather than conversation duration because the server may have capped or filtered older transcript entries.

The task/transcript API contract needs additive fields for provenance and per-message time. The implementation must verify Claude's source timestamp field using real transcript data and preserve it only when real. `toStoredMessages()` must retain optional message timestamps. Task-level terminal-time provenance is required because the current projection falls back through multiple sources; prefer `terminalReceipt.at`, and use the greatest valid session `createdAt`, not array position. Archived detail must carry through the archive record's existing `archivedAt`.

## Files to change

- `src/shared/contracts/agent-state.ts`, archive records, and snapshot projection: provide task creation, Kookr session registration, current terminal-receipt time, fallback evidence, and archive time separately.
- `src/shared/contracts/transcript.ts`, transcript parsers/store/routes, and tests: retain optional source message timestamps without breaking legacy transcripts.
- `src/frontend/components/DetailPanel.tsx`, `TranscriptView.tsx`, and tests: present timeline and message times accessibly.
- `src/frontend/presentation.ts` and tests: shared date/time and relative-time formatting if no existing formatter fits.
- `docs/features.md`: document task lifecycle time semantics.

## Edge cases

- Legacy tasks without session start or `finishedAt` show the available evidence label rather than a fabricated exact time.
- Clock skew where end precedes start must not yield a negative duration; show duration as unavailable or less than a minute according to the existing duration formatter's established behavior.
- Invalid ISO strings must not display `Invalid Date`.
- Active tasks without a valid start time must omit duration rather than use the browser's first render time.
- The task is archived after completion: archive time is not execution end time.
- A stopped agent can leave task status non-terminal; preserve status independently from timestamp evidence.
- A terminal status transition may happen after the last conversation message; do not imply these times are identical.
- A single Claude JSONL entry may expand into several normalized text/tool messages sharing its source timestamp.
- A capped transcript may omit the actual first conversation message; report only the span of messages currently shown.
- Providers may omit timestamps or emit invalid values; omit the per-message time while keeping the task timeline visible.

## Alternatives considered

- **Rename the existing completion timestamp:** rejected because it would not make start, duration, conversation chronology, and missing close-time semantics clear.
- **Add a dedicated `closedAt` field:** deferred because the product has no single operator-close action shared by completion, archive, cancellation, and termination.
- **Infer timestamps from message order or last update:** rejected because these are not reliable lifecycle events.

## Acceptance criteria

- A task detail view distinguishes task creation, Kookr session registration, current terminal status transition, archive time, task age, and execution runtime.
- A reader can tell whether a timestamp is a status transition, last observed hook activity, or record update, and that no separate operator close time is recorded.
- Provider message timestamps are preserved and readable when the source contains them; absent source times remain absent.
- The transcript time summary reports only the first/last timestamped messages currently shown, not a potentially omitted full-conversation span.
- Tests cover active, completed, missing, invalid, and skewed timestamp cases.

## Critic feedback incorporated

- **Round 1 (2026-11-04):** corrected the creation-versus-session-start distinction, removed the assumption that current normalized transcript messages already have timestamps, specified accessible `<time>` rendering, and exposed terminal timestamp fallback provenance.
- **Round 2 (2026-11-04):** restricted per-message timestamp preservation to verified Claude transcript source values, defined max-valid-`createdAt` session selection, and clarified that terminal status time is not process or conversation end.
- **Round 3 (2026-11-04):** added archived time from the existing archive record, made `terminalReceipt.at` the preferred current terminal transition time with legacy fallbacks, and labeled `lastEventAt` as observed hook activity.
