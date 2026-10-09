# RFC: Readable Task Conversations (and Evidence-Gated Durable Capture)

**Status:** Draft (v4 — post round-1 + round-2 critics + empirical checkpoint.
Re-centered on a read-only viewer with a hook-ledger fallback as the shippable
deliverable; durable owned-copy capture demoted to an evidence-gated later phase
after the empirical checkpoint and both round-2 passes showed its premise is
currently unsupported and its incremental form is unsound.)
**Date:** 2026-10-09
**Author:** Jean Ibarz (with Claude)

---

## Problem

A completed/terminal Kookr task's conversation is unreadable once its terminal
session dies. An operator who launches a task, steps away, and returns after it
auto-completes cannot read what the agent said. "Reopen" is only a status flip
(`completed → open`); it neither resumes the agent nor surfaces the past
conversation. This was reported directly: an operator didn't read a task's answer
before it auto-completed, tried Reopen, and found it "doesn't reopen it
correctly."

The dashboard's transcript pane is a live `dtach`/tmux attach; a dead session
shows "Session ended." The only durable artifact shown for a terminal task is the
completion digest, which is frequently `null` — for the same structural reason
the answer was lost (below).

## What the evidence established (and corrected)

Round-1 review plus an empirical checkpoint (design-experimenter, 2026-10-09)
changed the design materially. The load-bearing facts, verified against the live
`~/.kookr`/`~/.claude` data and the source:

1. **The conversation pointer is durably in the hook ledger**, not on the task
   record. `SessionInfo.transcriptPath`/`claudeSessionId` are `null` for all 56
   live sessions (the adapter write is gated on a session that does not yet
   exist when `SessionStart` fires). But **2333/2338** hook ledgers
   (`~/.kookr/hooks/<session>.jsonl`) carry `SessionStart` with `transcript_path`
   + `session_id`. The pointer is recoverable; read it from the ledger.

2. **The digest/transcript loss shares one root cause:** natural auto-completion
   runs the reconcile tick's **raw** `taskStore.completeTask`/`terminateTask`
   (`src/server/reconciliation.ts:299,311`, incl. at startup recovery), bypassing
   the metadata/cleanup wrappers — which is why the reported task had
   `completionDigest: null` and why any capture hooked only on the wrappers would
   miss the dominant path.

3. **The reported transcript was never persisted, not deleted late.** A live
   session's own `ls` showed its transcript missing 1m43s into the run; every
   transcript of that project was absent-from-start across a bounded Claude Code
   **2.1.295** window (2026-10-08 22:21 → 2026-10-09 06:36), fixed by 2.1.296.
   **Not** 30-day retention, **not** worktree cleanup. The honest consequence:
   **no mechanism that copies the vendor file could have recovered the reported
   conversation** — there was nothing on disk. The only artifact that survived is
   Kookr's **hook/activity ledger** (it still holds the prompt and tool events;
   the reported question was recovered from it).

4. **Outside that vendor-bug window, transcripts persist reliably**: 49/49 and
   231/231 present across earlier buckets; none observed vanishing after being
   written. So the premise for an owned *copy* — "the vendor file vanishes early"
   — has **no measured instance** today except the version-bug window, which a
   copy cannot help with anyway.

5. **`redactSecrets` is unfit for durable full-transcript storage** (verified):
   `DATABASE_URL=…@host`, `*_KEY=`/`*_SECRET_*=`, `redis://:pw@`, `curl -u
   user:pw`, and bare base64/PEM bodies pass through; its PEM pattern is
   **quadratic** (1.44 MB → 56 s event-loop stall). Tool results (file
   contents/diffs, possibly third-party-repo code) are the highest-leak surface.

6. **Pruned tasks are unreachable:** terminal records prune after ~1 day; a
   pruned task vanishes from the UI and `reopenTask` returns `not_found` (it never
   consults the #2765 archive). Any viewer must reach a task after prune or it is
   useful for only a day.

## Recommendation (the scope decision)

Ship a **read-only conversation viewer** (Phase 1) and treat a **durable
Kookr-owned copy** (Phase 2) as a separate, **evidence-gated** follow-up.

- **Phase 1 meets the operator's stated need** ("let me read the answer"): render
  the vendor transcript when it exists (it usually does, ~30 days), and **fall
  back to the durable hook/activity ledger** when it does not — which is the only
  thing that would have helped the reported case. No new conversation store, no
  redaction pipeline, no privacy posture change, small blast radius.
- **Phase 2 (durable copy) is not justified by current evidence** (§what-the-
  evidence-established, points 3–4) and, in its v3 incremental form, was found
  logically unsound (below). It is kept as a designed option to build **only if**
  Phase-1 telemetry shows vendor files actually disappearing before they are
  read, outside vendor-bug windows.

> **Intent-preservation note (explicit decision for the operator).** The operator
> chose "durable transcript capture" over a bounded fix. The review's
> evidence-backed finding is that the *read-only viewer + ledger fallback*
> delivers that stated need now, while the durable copy's premise is currently
> unsupported and carries real privacy/complexity cost. This RFC therefore
> **recommends** Phase 1 now and Phase 2 gated — but Phase 2 remains fully
> designed below so the operator can choose to build it now anyway. This is
> surfaced as a decision, not a silent downgrade.

## Goals

1. Make a terminal task's conversation **readable** in the dashboard after the
   session dies and after prune — on the path the operator already uses (the
   detail panel they open from the completed task / Reopen affordance), not a
   hidden panel.
2. Resolve the conversation pointer from the **durable hook ledger**.
3. When the vendor transcript is gone, **render the hook/activity ledger** Kookr
   already holds, rather than only showing "not retained."
4. Reach a task after hot-store prune via a **read-only** lookup.
5. (Phase 2, gated) Own a redacted, bounded copy only when evidence shows the
   vendor file is lost before it is read — with a sound capture mechanism, an
   explicit opt-in privacy posture, and the full operability/retention contract.

## Non-Goals

- Not resuming/forking a session to continue work (the unbuilt
  `rfc-restore-lost-agent-sessions.md`; this RFC gives it the pointer substrate).
- Not reopen-from-archive as a **mutation** in this RFC: re-hydrating a pruned
  task re-archives it and duplicates append-only rows. `reopenTask` of a pruned
  task stays `not_found` here; the viewer reaches it read-only instead. A
  mutating reopen-from-archive is a separate RFC with its own dedup rule.
- Not storing conversation content at all in Phase 1.
- Not a persisted normalized schema — normalize at read.
- Not implementing in the RFC PR.

## Phase 1 Design — read-only viewer (recommended, shippable)

### 1a. Pointer resolver + read-only reach
Resolve `(providerConversationId, transcriptPath)` from the session's
`SessionStart` in `~/.kookr/hooks/<session>.jsonl`. Add a **read-only**
`findTaskAnywhere(taskId)` (hot store → #2765 archive) used by the transcript
route and the archive listing, so a pruned task's conversation is reachable. This
also independently benefits a future reopen fix but performs no mutation here.
(Optional, if trivial: also fix the task-record cache via a deferred flush keyed
on `addSession` using `header.rawTranscriptPath`, with a regression test that
processes `SessionStart` *before* `addSession` — but the ledger is the authority.)

### 1b. Content resolution with a ledger fallback
`GET /api/tasks/:id/transcript` resolves content in order:
1. the vendor transcript file, if present → normalized at read (§1c);
2. else the durable **hook/activity ledger** for the session → rendered as the
   available conversation: user prompts, tool calls/results, and the assistant
   **answer** prose carried in `last_assistant_message` on `Stop`/`SubagentStop`
   (verified present and populated across sessions — this is the "read the
   answer" payload). Nuance: the ledger holds the *final* assistant message per
   turn, not mid-turn narration between tool calls; the latter is only in the
   vendor transcript (source 1), so the fallback reconstructs
   `prompt → tool activity → final answer` per turn;
3. else a true-absence state.
This makes `file_absent` *recoverable* where Kookr has the trace (the C3 case),
instead of a dead end.

### 1c. Read-time normalization + a shared contract
A new pure `transcript-normalizer` maps vendor lines (and ledger events) to a
provider-neutral, contract-typed discriminated union in `src/shared/contracts/`
(`text | tool_call | tool_result | truncation_marker | unavailable{reason}`); the
frontend never switches on `provider`. `transcript-parser.ts` (an `AgentEvent`
mapper) is left as-is. Reads are **streaming and bounded** (stop at N total bytes,
M per line, bound single-line length) so a pathological transcript cannot stall
the route.

### 1d. Viewer on the operator's path
For a terminal task the detail panel renders the resolved conversation read-only,
**final assistant answer surfaced first**, keeping the live attach only for a live
session. The states are distinct and honest:
`available (vendor)`, `available (ledger)`, `unsupported_provider`,
`absent (vendor never persisted / aged out)`. The completed-task row and the
Reopen affordance lead here, so the fix is reached by the action that frustrated
the operator.

### 1e. Standalone bug fix (ship regardless)
Replace the quadratic PEM regex in `redactSecrets` with an `indexOf`-based
BEGIN→END scan and bound per-line cost. This is a latent event-loop stall for
existing callers independent of this RFC and should land as its own small PR.

Phase 1 writes no conversation content, changes no privacy posture, and has a
small blast radius (one route, one read path, one view).

## Phase 2 Design — durable owned copy (evidence-gated; build only if telemetry warrants)

Build only if Phase-1 telemetry shows vendor files lost before being read,
outside vendor-bug windows. If built, the following are **requirements**, each
tracing to a round-2 finding:

- **Backstop capture, not incremental.** A bounded reconcile sweep captures
  finished tasks; **no per-hook (`Stop`/`PostToolUse`) append.** The incremental
  form was found self-refuting (cannot help the C3 never-written case), unsafe
  across `/compact`/resume/fork and concurrent hook events, and a hot-path stall
  — for near-zero marginal value over the backstop.
- **Done-signal off raw length.** The "snapshot shorter than vendor file" trigger
  is incompatible with redaction-at-rest (redacted bytes ≠ raw bytes → infinite
  re-capture). Define completion by a persisted **consumed-vendor-offset + vendor
  fingerprint (size/mtime/inode)** sidecar; re-capture (not append) when the
  fingerprint changes (handles compact/resume/shrink). This admits the sidecar §
  earlier drafts wrongly dropped.
- **Atomic, idempotent writes.** tmp→rename, a `complete` flag, line/offset dedup
  so a crash-then-redrive does not duplicate.
- **Don't store tool results in V1 of Phase 2.** Store user/assistant text + tool
  names + truncated inputs; this removes the largest leak surface and makes hard
  redaction optional rather than load-bearing. Redaction is **best-effort,
  stated as such**; add connection-string / `*_KEY=` / `*_SECRET_*=` detectors
  only as needed, each benchmarked for ReDoS. No entropy heuristic without a
  measured threshold (it mangles base64/diffs/hashes).
- **Privacy posture is opt-in.** Default **off** (or own-repos-only); the reversal
  of the project's standing "don't persist conversation content" posture is an
  explicit operator sign-off, not a discovered setting. This is distinct from a
  rollout kill switch.
- **Store = separate `transcripts/` tree, option (b).** Not inlined into the
  291 MB #2765 archive (whole-file prune + bloat). The archive carries only a
  small optional, **additive** `transcriptRef`; a reader-tolerance test guards the
  append-only schema. Retention reuses one shared policy function with
  `task-archive` (don't copy the constant); gzip; a global byte quota with
  `warn`/`critical` edges (sizing: ~2 MB median, ~10 MB max/session,
  ~0.4 GB/month → single-digit-GB quota covers months).
- **Prune gate (hard prerequisite, not an edge case).** Copy the existing
  `archive_failed` pattern: prune skips a task whose capture is `pending` and
  records `abandoned` after a bounded wait, so prune never deletes a task before
  its capture is durable.
- **Operability contract.** A `transcriptCapture` health block **separate** from
  `maintenancePrune`; per-tick work budget + cursor; per-state counters with
  sub-reasons; alert on the `capture_error` *rate* (excluding expected
  `file_absent`/`unsupported`) and on a `file_absent` **spike** (would have
  flagged the 2.1.295 window within hours); retry cap + backoff + `exhausted`;
  a `kookr transcript status <task>` / `?meta=1` inspection surface; atomic-write
  recovery summary at boot.
- **One artifact-cleanup owner.** A `TaskArtifactCleaner` registry lists
  task-keyed roots; register `transcripts/`; register the pre-existing
  `task-snapshots/` (which has **no** cleanup owner today) in a separate
  follow-up; never auto-delete existing bundles here. `delete-task` and prune go
  through the registry.
- **Feature flags + rollback matrix.** Independent `transcript.viewer`,
  `transcript.capture.backstop` flags (+ the privacy scope), and a per-slice
  statement of what a rollback leaves on disk and whether the viewer still reads
  it. Redaction is non-reversible (no re-redact after the vendor file ages out) —
  state that.

## Provider coverage

Claude first (reader + ledger exist). Codex-cli/grok render via added read-time
normalizers; until then they show `unsupported_provider`. Confirm codex/grok
transcript locations (C2) before any Phase-2 in-cwd capture (worktree cleanup
would delete an in-cwd transcript).

## Implementation Plan

- **Phase 1 (recommended, ship now), read-only, re-sliced for safety:**
  - **1a** pointer resolver + read-only `findTaskAnywhere` (no writes).
  - **1b** `GET /api/tasks/:id/transcript` with the vendor→ledger→absent
    resolution + read-time normalizer + shared contract.
  - **1c** detail-panel viewer on the operator's path, distinct states.
  - **1e** standalone PEM ReDoS fix (independent PR).
- **Phase 2 (gated on Phase-1 telemetry):** 2a redactor (`redactTranscriptLine`,
  new fn, tests) → 2b store + retention + prune gate + cleanup registry + backstop
  sweep + one-shot ledger→vendor backfill → (only if still warranted) revisit any
  per-hook capture. Each behind its flag; none ships half-built (a store without
  the redactor, or a redactor without the store, is unsafe/dead).

## Files To Change

- **Phase 1:** `src/core/transcript-normalizer.ts` (new, pure);
  `src/shared/contracts/transcript.ts`; a ledger-reader for the fallback;
  `src/server/use-cases/` pointer resolver + `findTaskAnywhere`;
  `src/server/routes/task-routes.ts` (`GET /api/tasks/:id/transcript`);
  `src/frontend/components/DetailPanel.tsx` (+ transcript view);
  `src/core/redact-secrets.ts` (PEM `indexOf` fix, standalone);
  `docs/reference/api.md`.
- **Phase 2 (if built):** `redactTranscriptLine`; `transcript-store.ts`;
  capture sweep in `reconciliation.ts`/`maintenance-prune-schedule.ts`;
  prune gate in `prune-aged-task-records.ts`; `TaskArtifactCleaner` +
  `delete-task.ts`; `transcriptRef` in `task-archive.ts`; health/ops wiring;
  `docs/reference/data-directory.md`.

## Edge Cases

- Vendor file absent + ledger present (C3 class) → render the ledger (1b), not a
  dead "not retained."
- Pruned task → read-only `findTaskAnywhere`; no reopen mutation.
- Forced complete / killed session with an answer-only final turn → the final
  answer may be only in the live vendor file; Phase 1 shows whatever persisted +
  the ledger; Phase 2 backstop captures it only if the file survived (documented
  limitation, not hidden).
- Resume/subagents → multiple `SessionStart`/`transcript_path`; the resolver must
  handle more than one (not "the SessionStart").
- Oversized single JSONL line → bounded line read + truncation marker.
- Phase 2 only: `/compact`/resume/shrink → fingerprint-change re-capture;
  concurrent writes → single writer; crash → atomic write + dedup.

## Alternatives Considered

The operator chose durable capture over the smaller options; these are recorded
as explicit tradeoffs (see the intent-preservation note).

- **A. Durable owned copy as the primary deliverable (the original ask).** Demoted
  to evidence-gated Phase 2: its early-vanish premise has no measured instance
  outside a vendor bug it cannot help with, and its incremental form was unsound.
- **B. Just make the digest reliable.** Cheapest; fixes the null-digest root cause
  (reconcile bypass). A summary, not the conversation; adopted as a complementary
  win, not the deliverable.
- **C. Render the hook/activity ledger.** Promoted from "fallback" to a
  first-class Phase-1 content source — it is the only thing that survived the
  reported case.
- **D. Persisted normalized schema.** Rejected: migration burden; normalize at
  read.
- **E. Inline transcript in the #2765 archive (option 5a).** Rejected: 291 MB
  store, breaks whole-file prune; a `transcriptRef` only (Phase 2).
- **F. Incremental per-hook capture.** Rejected: self-refuting vs C3, unsafe
  across compact/resume/races, hot-path stall, near-zero value over the backstop.

## Test Plan

- **Phase 1 unit:** ledger pointer resolver (incl. multi-SessionStart); read-time
  normalizer over real Claude transcripts *and* ledger events; streaming cap +
  bounded line; discriminated-union contract; PEM `indexOf` scan vs the 1.44 MB
  ReDoS input.
- **Phase 1 integration:** `GET /api/tasks/:id/transcript` resolves vendor →
  ledger → absent; `findTaskAnywhere` reaches a pruned task read-only; reopen of a
  pruned task still `not_found` (no mutation).
- **Phase 1 frontend:** terminal task renders the resolved conversation with the
  answer surfaced; each state renders distinctly; live session keeps attach.
- **Phase 2 (if built):** done-signal via offset+fingerprint (no infinite
  re-capture on a redacted snapshot); `/compact` mid-session still parses;
  concurrent-write and crash-redrive dedup; redaction leak table + ReDoS; prune
  gate blocks prune of a `pending` capture; quota edges; capture on the reconcile
  raw-flip path.

## Open Questions

- Phase-2 gate threshold: what `file_absent`/post-write-vanish rate (outside
  vendor-bug windows) justifies building the owned copy?
- Does the operator want to *continue* a completed task (→ restore RFC, which
  excludes completed tasks) in addition to re-reading? If so, that is a distinct
  build.
- Per-provider transcript locations (C2).
- Why were transcripts not persisted during the 2.1.295 window? A vendor
  reliability question; out of scope, worth a one-line follow-up probe.

## Relationship To Other RFCs

- `rfc-restore-lost-agent-sessions.md` — continuation vs. this RFC's read-only
  recovery; shared dependency is the ledger pointer (1a); if Phase 2 is built, its
  owned copy would also remove restore's `missing_transcript` block.
- #2765 terminal-task archive — the reach/retention/prune model; transcripts (if
  owned) sit in a separate tree with only a `transcriptRef` in the archive.

## Critic Feedback Incorporated

### Round 1 — 2026-10-09 (boundary, failure-mode, design-minimalist, socratic, ambition)
Capture re-grounded off the lifecycle wrappers (reconcile bypass); pointer moved
to the hook ledger (2333/2338); raw-at-rest + normalize-at-read behind a shared
contract; store option (b) with shared retention; privacy posture made explicit;
streaming bounded read; distinct unavailable states; reach-after-prune in scope;
backfill via the ledger; stale line anchors removed; digest-null root cause
identified.

### Post-round-1 empirical checkpoint — design-experimenter, 2026-10-09
C3: 30-day-retention and worktree-removal **refuted**; transcript **never
persisted** in a 2.1.295 window; capture-at-terminal would not have recovered the
reported case → `file_absent` first-class and (round 2) a **ledger fallback**.
Backfill viable via the ledger; sizing ~2 MB median/10 MB max; `redactSecrets`
leak table + quadratic PEM confirmed. The probe **falsified** the capture-timing
premise; the RFC restructured around reality rather than iterating on it.

### Round 2 — 2026-10-09 (failure-mode, design-minimalist, operability, delivery-pragmatist, socratic)
- **design-minimalist / socratic / delivery:** read-only viewer is the complete,
  valuable first PR; durable copy is premature (no measured early-vanish outside
  the vendor bug) → **Phase 1 recommended, Phase 2 evidence-gated**; incremental
  capture cut; tool results not stored; privacy default off/opt-in; backfill
  forward-only; `task-snapshots/` has no cleanup owner (verified) → cleanup
  registry, don't touch it here.
- **failure-mode:** the v3 backstop length-compare is incompatible with
  redaction-at-rest, "reused" offsets track the ledger not the vendor file, append
  is unsafe across compact/resume/races and not idempotent, and incremental can't
  help C3 → Phase 2 redefined (backstop-only, offset+fingerprint done-signal +
  sidecar, atomic/dedup writes); §2 C3 over-claim struck; **ledger fallback wired
  into the viewer** for `file_absent`.
- **operability:** separate `transcriptCapture` health block, per-tick budget +
  cursor, state sub-reasons, rate/spike alerts, retry cap + backoff, inspection
  surface, atomic-write recovery → folded into the Phase-2 operability contract.
- **delivery-pragmatist:** re-sliced read-only-first; reopen-from-archive is a
  **mutation** → kept out (reopen stays `not_found`); prune gate promoted to a
  hard prerequisite (reuse `archive_failed`); redactor as a new function; archive
  `transcriptRef` additive/optional with a reader-tolerance test; feature flags +
  rollback matrix; PEM fix as a standalone PR.

**Adversarial pair (ambition-amplifier vs design-minimalist):** round 1 sided with
ambition on the *asset* and minimalist on the *form*; round 2's empirical evidence
(no measured early-vanish; incremental unsound) **moved the balance to the
minimalist** on *scope* — the durable asset is real but not yet warranted, so it
is gated, not built now. Recorded as an explicit, evidence-driven reversal rather
than a silent one.

**Intent preservation check:** the operator's load-bearing motivation — durably
re-read a closed task's conversation — is preserved by Phase 1 (viewer + ledger
fallback) for the stated need, and the durable-copy choice they made is **not
silently dropped**: it is fully designed as Phase 2 and surfaced as an explicit
build-now-or-gate decision (Recommendation + intent-preservation note).

**Invocation log:** ambition-amplifier 2026-10-09: novel finding (shared substrate
with restore; time-sensitive backfill) — partially superseded by the empirical
evidence that backfill is forward-only-valuable and the owned copy is gated.

### Consensus attack — general-purpose, 2026-10-09
**consensus survives.** The attack targeted the panel's shared, untested
assumption that the hook/activity ledger is a good Phase-1 fallback. It is —
empirically: `hook-parser.ts` maps `Stop`/`StopFailure`/`SubagentStop` payloads'
`last_assistant_message` to `lastMessage`, and the real ledgers carry **populated
assistant answer prose** (the reported session `kookr-18d77bf3`: all 3 Stop + 4
SubagentStop non-empty, full Markdown answer with the diagnosis/PR link/verify
results; 6 recent sessions: 100% of Stop-like events had answer text, avg
749–4674 chars). So the Phase-1 ledger fallback delivers exactly the "read the
answer" need for the C3 class. **One honest nuance folded into §1b:** the ledger
holds the *final* assistant message per turn, not mid-turn narration between tool
calls — a reader wanting that needs the vendor transcript, which is already
content source (1). No shared blind spot; the read-only-first recommendation and
the deferral of durable capture both hold.
