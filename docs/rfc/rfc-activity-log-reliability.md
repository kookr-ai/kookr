# RFC: Activity Log Reliability

**Status:** Draft (v2 — self-reviewed)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr's activity log is currently too easy to confuse when hook delivery is imperfect or when a managed agent starts nested agent work.

A real incident exposed the weakness:

- Task `cda8811a-e5c5-4466-b4cc-708b49ca2245` appeared to have duplicated or wrong activity.
- The task's Kookr session was `kookr-020f33cb`.
- The raw hook file for that session, `~/.kookr/hooks/kookr-020f33cb.jsonl`, contained five distinct Codex `session_id` values:
  - one parent session;
  - four reviewer sessions launched while iterating on an RFC.
- Kookr projected every record from the shared hook file into one parent `AgentState.events` window.
- The live WebSocket snapshot exposed only the last 50 monitor events, so the visible activity panel started midstream inside child-reviewer activity.
- Two raw hook records were malformed because large concurrent hook writes interleaved in the JSONL file.
- The task session metadata ended up pointing at one of the child Codex session ids because each `SessionStart` for the shared hook file updated the same Kookr `tmuxSession`.

The result was not one bug. It was a reliability gap across ownership, ingestion, storage, and presentation:

1. Kookr does not have a durable notion of which runtime session owns a hook record.
2. Child or nested agents can inherit the parent hook append target.
3. The file tailer tolerates concatenated records but not arbitrary interleaving inside large records.
4. The monitor stores a capped display window, not a queryable activity history.
5. The UI does not show when activity came from a child session, was repaired, was dropped, or was only a partial window.

## Empirical Checkpoint

This RFC is grounded in one production incident plus current `main` code inspection.

Observed in `~/.kookr/hooks/kookr-020f33cb.jsonl`:

- 377 physical lines.
- 375 parseable hook records.
- 2 malformed records caused by interleaved large payloads.
- 5 distinct Codex `session_id` values in one Kookr hook file.
- Parent session line range started at the initial task prompt.
- Four later sessions started when the parent task launched RFC review workers.

Confirmed in current code:

- `HookFileWatcher` is the active delivery path. The HTTP hook endpoint records arrival timing only.
- `splitHookRecords()` handles adjacent JSON objects and incomplete trailing records, but a damaged JSON string remains malformed.
- `CodexCliAdapter` and `ClaudeCodeAdapter` generate hook commands that append to one file keyed by Kookr terminal session.
- `injectHookEvent()` updates task session metadata on every `session_start` for the same Kookr session.
- `Monitor` stores a capped per-agent event window, defaulting to 50 events.
- `getSnapshotAgentsForClient()` projects only that current event window into browser snapshots.

## Current Behavior

Hook settings are generated per Kookr terminal session. Both Claude Code and Codex settings write raw hook payloads to:

```text
~/.kookr/hooks/<kookr-session>.jsonl
```

When `serverPort` is configured, the hook command dual-writes:

```sh
awk -v file='<hook-file>' '{ print >> file; print }' | curl -s -X POST ...
```

The HTTP endpoint currently records arrival timing through `HttpPushTracker`; it does not inject events into the monitoring pipeline. The file watcher remains the authoritative delivery path.

`HookFileWatcher` reads newly appended content, splits JSON objects by brace depth, and calls `adapter.injectHookEvent(tmuxName, rawJson)`. The adapter parses the raw event, updates task session metadata on `SessionStart`, and emits `(tmuxName, AgentEvent)` to the event pipeline.

`Monitor.processEvents(tmuxName, [event])` appends the normalized event to a capped per-agent window. The default window is 50 events. `getSnapshotAgentsForClient()` projects that window into WebSocket snapshots for the activity panel.

This architecture works for a single runtime session with well-formed append-only records. It becomes misleading when multiple runtime sessions write through one Kookr session key or when the append stream is damaged.

## Requirements

- Kookr SHALL preserve the distinction between Kookr terminal session id, provider runtime session id, and child/nested runtime session id.
- Kookr SHALL NOT overwrite parent session metadata with child session metadata.
- Kookr SHALL classify hook records as `parent`, `child`, `foreign`, or `unknown` before they affect parent activity, task metadata, anomaly detection, or completion summaries.
- Parent activity SHALL remain readable even when child sessions run in parallel.
- Child activity SHOULD be visible, but it MUST be visually attributed as child activity instead of silently merging into the parent timeline.
- Hook ingestion SHALL tolerate missing newlines, adjacent JSON objects, large payloads, and partial writes.
- Hook ingestion SHALL detect and surface corrupted or unrecoverable records without crashing the server.
- The activity panel SHALL disclose when it is showing a capped or partial event window.
- Operators SHALL have a debug path to inspect raw/repaired/dropped activity for a task.
- Raw activity storage SHALL remain local, permission-restricted, and excluded from normal browser snapshots.
- V1 SHALL remain local-only and file/HTTP based. Do not introduce a database or cloud service.
- V1 SHALL keep existing anomaly detection behavior unless a record is confidently classified as non-parent.

## Non-Goals

- Do not redesign the whole task store.
- Do not make Kookr supervise child agents as independent first-class dashboard tasks in V1.
- Do not require upstream Claude Code or Codex protocol changes before Kookr can improve reliability.
- Do not persist full unbounded `tool_response` payloads in browser snapshots.
- Do not make the activity panel a full log explorer. It should remain the task's working summary, with diagnostics available separately.

## Design

### 1. Introduce a Hook Envelope at the Kookr Boundary

Today Kookr treats raw provider hook payloads as the durable ingestion record. Add a Kookr-owned envelope before parsing into `AgentEvent`.

```ts
interface HookEnvelopeV1 {
  schemaVersion: 'hook-envelope.v1';
  kookrSessionId: string;        // e.g. kookr-020f33cb
  taskId?: string;
  provider: 'claude-code' | 'codex-cli';
  rawSessionId?: string;         // provider session_id from payload
  rawTurnId?: string;            // turn_id when available
  rawHookEventName?: string;
  source: 'file' | 'http';
  observedAt: string;
  sequence: number;              // monotonic per kookrSessionId ingestion sequence
  contentHash: string;
  parentage: 'parent' | 'child' | 'foreign' | 'unknown';
  parseStatus: 'ok' | 'repaired' | 'malformed' | 'dropped';
  raw: string;
}
```

The envelope is the ingestion ledger. `AgentEvent` becomes the normalized projection, not the only record Kookr keeps.

The sequence is assigned by Kookr, not by the provider. It makes UI ordering stable even when provider sessions interleave.

### 2. Freeze Parent Runtime Session Ownership

Each Kookr terminal session should have one parent runtime session id:

```ts
interface SessionRuntimeIdentity {
  parentSessionId?: string;
  parentTranscriptPath?: string;
  parentSeenAt?: string;
  childSessionIds: Record<string, {
    firstSeenAt: string;
    transcriptPath?: string;
    reason: 'subagent_hook' | 'inherited_settings' | 'unknown';
  }>;
}
```

Rules:

- The first valid `SessionStart` for a Kookr session becomes the parent runtime session unless the task already has a parent.
- Later `SessionStart` records with a different `rawSessionId` do not update `claudeSessionId` or `transcriptPath`.
- Later distinct `rawSessionId`s are classified as child or foreign.
- Task session metadata stores parent identity only; child identities live in a separate child map.
- If Kookr sees events before the parent `SessionStart`, those events are `unknown` until the parent is known. They can be reclassified in memory when the parent arrives.

This directly prevents child reviewer sessions from replacing the task's parent transcript path.

### 3. Classify Parentage Before Monitor Processing

Add a small classifier in the ingestion path:

```ts
type EventParentage = 'parent' | 'child' | 'foreign' | 'unknown';

function classifyHookParentage(
  envelope: HookEnvelopeV1,
  identity: SessionRuntimeIdentity,
): EventParentage;
```

Classification rules:

- `parent`: `rawSessionId === parentSessionId`.
- `child`: `rawSessionId` is a known child id, or a new distinct session id appears after the parent has started and shares the same Kookr hook target.
- `foreign`: `rawSessionId` maps to another active Kookr session or task.
- `unknown`: missing session id or parent identity not established yet.

Only `parent` events feed parent anomaly detection and parent completion summaries by default. `child` events feed token tracking and child activity summaries. `unknown` events are retained and displayed with a warning until reclassified or aged out.

This is intentionally conservative. A child `Stop` should not produce a parent `needs_input` finding, and a child `SessionStart` should not mutate parent session metadata.

### 4. Add Explicit Child Activity to the UI

The activity panel should remain conversation-first, but it should stop pretending all events have one speaker.

Add lightweight attribution:

- parent events render as today;
- child tool groups render under a collapsed "Child agent activity" row;
- child `Stop` messages render as reviewer/subagent summaries, not parent replies;
- malformed/dropped record notices render as compact system notices;
- a header shows `Showing last 50 of N events` when the monitor window is capped.

Example:

```text
Child agent activity (4 sessions)
  design-minimalist: read 2 files, ran 3 commands, finished
  failure-mode-analyst: read 4 files, ran 1 command, finished

Activity warning: 2 hook records were malformed and skipped. Open diagnostics.
```

V1 does not need a rich per-child transcript viewer. It only needs to make the parent timeline honest.

### 5. Make HTTP Push an Active Delivery Path With Dedup

The current HTTP endpoint records timing but does not deliver events. That leaves the file tailer as the only active path, so JSONL corruption can lose events.

Promote HTTP push to an active ingestion source:

1. Hook command sends each raw payload to `/api/hook-event/:kookrSessionId`.
2. The route wraps the payload in a `HookEnvelopeV1` with `source: 'http'`.
3. The ingestion service deduplicates by `(kookrSessionId, contentHash)` for a short TTL.
4. File watcher remains the durable replay path.
5. If HTTP delivered a record first, the later file record is marked duplicate and used only for durability/latency checks.
6. If HTTP fails, file delivery still works.

This turns the already-present dual-write design into an actual fast path and gives Kookr a way to receive clean records even if the file append stream later becomes damaged.

### 6. Replace Shell Append With a Small Hook Writer

The shell `awk '{ print >> file; print }'` writer improved missing-newline behavior, but it is still not a strong record boundary when multiple hook processes append large payloads concurrently.

Add a tiny Node hook writer shipped by Kookr:

```sh
node <kookr>/dist/hooks/kookr-hook-writer.js \
  --session kookr-020f33cb \
  --file ~/.kookr/hooks/kookr-020f33cb.jsonl \
  --url http://localhost:4800/api/hook-event/kookr-020f33cb
```

Writer responsibilities:

- read the complete stdin payload;
- append exactly one newline-terminated record;
- use `fs.open` + `appendFile` or a per-session lock to avoid interleaving records;
- POST the same payload to the HTTP endpoint;
- exit quickly and fail open if HTTP is unavailable;
- include bounded stderr on local write failure.

The generated hook settings call the writer instead of embedding complex shell pipelines. This also makes behavior easier to test than stringly shell commands.

**Post-RFC addition (issue #1433):** the writer also size-rotates the active hook file. At the time of that addition the live `HookFileWatcher` still re-read the whole active file on every append, so an unbounded `hooks/<session>.jsonl` made each hook event cost O(file size) and starved ingestion under load (observed files at 40–58 MB). When appending a record would push the file past `KOOKR_HOOK_MAX_BYTES` (default 32 MiB), the writer renames it to `<session>.jsonl.1` (shifting older generations up to `KOOKR_HOOK_ROTATE_KEEP`) under the same per-session lock and starts a fresh file — each generation stays append-only. Issue #1612 later replaced the whole-file re-read with stat-first + incremental byte-range reads; rotation remains as a hard cap on active-file size and startup/replay cost. This is distinct from §7's ledger rotation, which caps the separate `activity/<session>.jsonl` durable ledger. See [environment-variables.md](../reference/environment-variables.md).

**Watcher cooperation (issue #1566, residual of #1433):** the writer's rename gives the fresh active file a new inode, so `HookFileWatcher` treats an inode change as the definitive rotation signal (more robust than a size-shrink compare, which misses a fresh generation that already regrew past the reader's old offset). On rotation it recovers the un-read `[offset..end]` tail from `<session>.jsonl.1` — whose inode still matches the pre-rotation active file — before resetting to the fresh file, so a reader that lagged more than a cap behind never silently skips those events. A *same-inode* shrink is still treated as an in-place truncation (reset-to-0, issue #703). Recovery is bounded to the single most-recent generation; content-hash dedup in `HookIngestion` absorbs any boundary overlap, and the health snapshot's `rotatedTailRecoveredCount` surfaces how many records the recovery re-injected.

### 7. Keep a Durable Activity Ledger Separate From Monitor Window

`Monitor.agentEvents` is a bounded live-state window. It should not be the only activity history.

Add an append-only activity ledger per Kookr session:

```text
~/.kookr/activity/<kookr-session>.jsonl
```

Each row is an envelope plus normalized projection metadata:

```ts
interface ActivityLedgerRow {
  envelope: Omit<HookEnvelopeV1, 'raw'> & { rawBytes: number };
  event?: AgentEvent;
  projection?: 'parent_activity' | 'child_activity' | 'diagnostic_only';
  error?: string;
}
```

The ledger is the source for diagnostics and "load more activity" later. The monitor remains responsible for current anomaly state.

Retention can be simple in V1:

- keep active task ledgers;
- prune ledgers for deleted tasks;
- cap individual ledger files by size with a `.1` rotation if needed.

### 8. Add Diagnostics for Activity Integrity

Expose a debug endpoint:

```http
GET /api/tasks/:taskId/activity-diagnostics
```

Response:

```ts
interface ActivityDiagnostics {
  taskId: string;
  kookrSessions: Array<{
    kookrSessionId: string;
    parentSessionId?: string;
    childSessionIds: string[];
    rawRecordCount: number;
    parsedRecordCount: number;
    malformedRecordCount: number;
    duplicateRecordCount: number;
    unknownParentageCount: number;
    droppedRecordCount: number;
    monitorWindowSize: number;
    totalActivityEvents: number;
  }>;
}
```

The activity panel warning links to this endpoint. The endpoint should read from the activity ledger, not from the current monitor window.

### 9. Preserve Raw Fidelity While Keeping Snapshots Small

Browser snapshots should stay capped and projected. Debug endpoints should stay full fidelity.

V1 contract:

- WebSocket snapshot includes projected events plus small activity metadata:

```ts
interface AgentActivityMeta {
  totalEventsSeen: number;
  windowStartSeq?: number;
  windowEndSeq?: number;
  parentEventCount: number;
  childEventCount: number;
  malformedRecordCount: number;
  unknownParentageCount: number;
}
```

- `/api/snapshot` remains raw current state.
- `/api/tasks/:taskId/activity-diagnostics` exposes ingestion health.
- Future `/api/tasks/:taskId/activity?cursor=...` can page ledger rows if needed.

### 10. Add a Repair Scanner for Existing Hook Files

The file watcher already handles adjacent JSON objects without newlines. The incident showed a harder case: one record was split/interleaved with another record's large string payload.

Do not try to perfectly repair arbitrary interleaving in the live path. Instead:

- live ingestion marks malformed records and continues;
- diagnostics stores a short preview and byte offset;
- a repair scanner can attempt best-effort recovery offline for support bundles;
- repair output is never silently fed back into anomaly detection.

This keeps live supervision deterministic while still making incidents diagnosable.

### 11. Add Privacy and Retention Guardrails

Raw hook payloads can contain prompts, command output, file paths, and possibly secrets printed by tools. The activity ledger improves debuggability, but it must not casually widen data exposure.

Guardrails:

- activity ledger files are created under the Kookr data directory with owner-only permissions;
- browser snapshots never include raw ledger payloads;
- diagnostics responses include counts, hashes, byte offsets, and short bounded previews by default;
- full raw export requires an explicit debug endpoint or support-bundle command;
- raw export redacts obvious credential patterns using the same redaction helpers used elsewhere in Kookr where available;
- retention defaults to local active/recent tasks, with pruning tied to task deletion and an operator-visible size cap.

V1 should not promise perfect secret detection. It should avoid making raw payload exposure the default path.

## Implementation Plan

### Phase 1: Ownership Safety

Files likely touched:

- `src/core/types.ts`
- `src/core/tasks.ts`
- `src/core/hook-parser.ts`
- `src/server/event-pipeline.ts`
- `src/adapters/claude-code-adapter.ts`
- `src/adapters/codex-cli-adapter.ts`
- tests around hook parsing, adapter metadata, and monitor snapshots

Changes:

- freeze parent session metadata after the first parent `SessionStart`;
- record later distinct session ids as child identities;
- add parentage to normalized events or to pipeline-side metadata;
- prevent child `SessionStart` from overwriting `claudeSessionId` / `transcriptPath`;
- prevent child events from driving parent anomaly detection.

Acceptance:

- a fixture with one parent and four child `SessionStart`s leaves parent metadata unchanged;
- child `Stop` events do not create parent `needs_input`;
- child tool events are not counted as parent tool activity.

### Phase 2: Hook Writer and Active HTTP Delivery

Files likely touched:

- `src/adapters/claude-code-adapter.ts`
- `src/adapters/codex-cli-adapter.ts`
- `src/server/routes/diagnostics-routes.ts`
- `src/core/http-push-tracker.ts`
- new hook writer under `src/server` or `src/hooks`
- tests for dual delivery and dedup

Changes:

- replace shell append pipeline with Kookr hook writer;
- make `/api/hook-event/:sessionId` call the same ingestion service as the file watcher;
- dedup HTTP and file delivery by content hash;
- keep file watcher as replay/durability path.

Acceptance:

- HTTP-only delivery reaches monitor;
- file-only delivery reaches monitor;
- HTTP + file delivery produces exactly one monitor event;
- concurrent large hook writes produce valid newline-delimited records.

### Phase 3: Activity Ledger and Diagnostics

Files likely touched:

- new `src/core/activity-ledger.ts`
- `src/server/hook-watcher.ts`
- `src/server/routes/task-routes.ts` or diagnostics routes
- `src/server/use-cases/get-snapshot.ts`
- tests for ledger rows and diagnostics response

Changes:

- append envelope/projection rows to a per-session activity ledger;
- expose activity diagnostics per task;
- include activity meta in snapshots.
- enforce local file permissions and bounded diagnostic previews.

Acceptance:

- diagnostics reports parent/child/malformed/duplicate counts for fixture logs;
- monitor window can be capped while diagnostics still reports full counts;
- malformed rows are visible in diagnostics and do not crash ingestion.
- browser snapshots do not include raw hook payloads.

### Phase 4: Activity Panel Attribution

Files likely touched:

- `src/core/activity-summary.ts`
- `src/frontend/components/ActivityPanel.tsx`
- `src/frontend/styles.css`
- frontend tests for summaries and rendering

Changes:

- display parent and child activity distinctly;
- show partial-window metadata;
- show compact warnings for malformed/dropped records;
- link to diagnostics.

Acceptance:

- mixed parent/child fixture renders child activity as child activity;
- capped window disclosure appears when `totalEventsSeen > events.length`;
- malformed-record notice appears when count is non-zero.

## Edge Cases

- **Parent `SessionStart` is missed.** Classify early events as `unknown`, retain them, and do not let them mutate task metadata until a parent can be established.
- **Child starts before parent metadata is recorded.** If task metadata has no parent yet, use first valid `SessionStart` as parent only when it comes from the managed terminal launch path. Otherwise keep as unknown and surface diagnostics.
- **Codex lacks reliable child hook events.** Parentage classification by distinct `session_id` still catches inherited settings even without `SubagentStart`.
- **Provider reuses session ids across resumes.** Parent identity is scoped by Kookr session id and task id, not globally.
- **HTTP delivers a record but file append fails.** Monitor can stay live; diagnostics marks the record as non-durable.
- **File replay after restart sees records already delivered by HTTP before crash.** Dedup should be scoped to persisted ledger hashes, not only in-memory TTL, during replay.
- **Raw payload contains braces inside strings.** Existing brace-depth splitting already accounts for strings and escapes; keep regression coverage.
- **Malformed record overlaps two valid records.** Live ingestion drops the malformed span and records byte offsets. Offline repair may recover data, but monitor does not guess.
- **Raw payload contains sensitive output.** Keep raw records local and out of snapshots. Diagnostics uses bounded previews unless the operator explicitly asks for raw export.
- **Task is deleted while child events arrive late.** Ingestion records diagnostic rows but does not resurrect the task or monitor entry.
- **Window starts mid-turn.** UI shows partial-window disclosure so a tool result without the corresponding tool use is not presented as the full story.

## Alternatives Considered

### A. Only Increase the Monitor Window

Increasing from 50 to a larger number would hide some symptoms but not solve ownership corruption, child metadata overwrite, malformed records, or raw diagnostics. Reject.

### B. Filter by `session_id` in the Frontend Only

Frontend filtering would make the panel less confusing but would still let child events mutate task metadata and anomaly state server-side. Reject.

### C. Make Child Agents First-Class Dashboard Tasks Immediately

This may be useful later, but it is larger than the incident requires. V1 only needs honest attribution and safe parent state. Defer.

### D. Use SQLite for All Activity

A structured local store would simplify queries, but it adds migration and operational surface. JSONL ledgers match Kookr's current local-first model. Defer.

### E. Rely Only on HTTP Push

HTTP avoids some file corruption, but it is not durable across server downtime and network failures. Keep HTTP as active fast path and file as replay path.

## Open Questions

- Should child activity be collapsed by runtime session id, subagent role, or inferred prompt title?
- Should parentage be attached directly to `AgentEvent`, or should it stay in an outer activity row so anomaly detection remains provider-agnostic?
- Should the hook writer be TypeScript compiled into `dist/`, or a small checked-in JavaScript file to avoid startup path ambiguity?
- What retention limit is appropriate for `~/.kookr/activity/*.jsonl`?
- Should activity diagnostics be exposed only through `/api/snapshot` debug routes or linked from the main UI?
- Should raw support-bundle export be a CLI command, an HTTP endpoint, or both?

## Critic Feedback Incorporated

- Initial draft 2026-05-13: based on the incident investigation for task `cda8811a-e5c5-4466-b4cc-708b49ca2245`.
- Manual boundary review 2026-05-13: separated ingestion ledger, monitor window, and frontend summary responsibilities so the activity panel is not the source of truth.
- Manual failure-mode review 2026-05-13: added malformed-record handling, parent `SessionStart` loss, HTTP/file dedup, and restart replay edge cases.
- Manual design-minimalist review 2026-05-13: kept child agents out of first-class dashboard task scope for V1 and phased implementation around ownership safety first.
- Manual privacy review 2026-05-13: added local-only raw ledger guardrails, bounded diagnostics previews, and explicit raw export handling.
